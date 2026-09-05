/**
 * The application shell: process-wide singletons, the navigation rail, and the
 * back stack every pushed screen returns through.
 *
 * The four destinations behind the rail (Home, Machines, Terminals, Settings)
 * are swapped in place; every other screen is pushed over them, exactly as the
 * phone does with its fragment back stack.
 */

import { Settings } from './core/settings.js';
import { Credentials } from './core/credentials.js';
import { RelayClient, ConnectionState } from './core/relay.js';
import { AgentRepository } from './core/agents.js';
import { SessionRepository } from './core/sessions.js';
import { Notifier } from './core/notifier.js';
import { system, setWindowTitle, inShell } from './core/platform.js';
import { el, clear, svgIcon, mount } from './ui/dom.js';
import { S } from './ui/strings.js';
import { toast, clearOverlays, closeMenu } from './ui/overlays.js';
import { connectionLabel, connectionTone } from './core/format.js';
import { APP_VERSION } from './version.js';

import { homeScreen } from './ui/screens/home.js';
import { machinesScreen } from './ui/screens/machines.js';
import { machineScreen } from './ui/screens/machine.js';
import { machineSettingsScreen } from './ui/screens/machineSettings.js';
import { terminalsScreen } from './ui/screens/terminals.js';
import { terminalScreen } from './ui/screens/terminal.js';
import { newTerminalScreen } from './ui/screens/newTerminal.js';
import { settingsScreen } from './ui/screens/settings.js';
import { terminalFontScreen } from './ui/screens/terminalFont.js';
import { presetsScreen } from './ui/screens/presets.js';
import { devicesScreen } from './ui/screens/devices.js';
import { commandHistoryScreen } from './ui/screens/commandHistory.js';
import { addMachineScreen } from './ui/screens/addMachine.js';

const DESTINATIONS = [
  { id: 'home', icon: 'home', label: S.navHome, screen: homeScreen },
  { id: 'machines', icon: 'monitor', label: S.navMachines, screen: machinesScreen },
  { id: 'terminals', icon: 'terminal_square', label: S.navTerminals, screen: terminalsScreen },
  { id: 'settings', icon: 'settings', label: S.navSettings, screen: settingsScreen },
];

const PUSHED = {
  machine: machineScreen,
  machineSettings: machineSettingsScreen,
  terminal: terminalScreen,
  newTerminal: newTerminalScreen,
  terminalFont: terminalFontScreen,
  presets: presetsScreen,
  devices: devicesScreen,
  commandHistory: commandHistoryScreen,
  addMachine: addMachineScreen,
};

class App {
  constructor(settings, credentials) {
    this.settings = settings;
    this.credentials = credentials;
    this.client = new RelayClient(credentials, APP_VERSION);
    this.agents = null;   // filled in by start()
    this.sessions = null;
    this.notifier = null;

    this.stack = [];      // pushed screens over the current destination
    this.destination = 'home';
    this.current = null;  // { root, destroy }
    this.unlocked = false;
  }

  /* ------------------------------ navigation ---------------------------- */

  get host() { return document.getElementById('screen'); }

  /** Show one of the four destinations, dropping anything pushed over it. */
  openTab(id) {
    this.stack = [];
    this.destination = id;
    this.renderCurrent();
  }

  /** Push a screen over the current destination. */
  push(name, params = {}) {
    this.stack.push({ name, params });
    this.renderCurrent();
  }

  /** Replace the top of the stack (used when a screen redirects to itself). */
  replace(name, params = {}) {
    if (this.stack.length > 0) this.stack.pop();
    this.push(name, params);
  }

  back() {
    if (this.stack.length === 0) return false;
    this.stack.pop();
    this.renderCurrent();
    return true;
  }

  /** Drop every pushed screen without changing destination. */
  popToRoot() {
    if (this.stack.length === 0) return;
    this.stack = [];
    this.renderCurrent();
  }

  renderCurrent() {
    closeMenu();
    this.current?.destroy?.();
    this.current = null;

    const top = this.stack[this.stack.length - 1];
    const build = top ? PUSHED[top.name] : DESTINATIONS.find((d) => d.id === this.destination)?.screen;
    if (!build) return;

    const screen = build(this, top?.params ?? {});
    this.current = screen;
    mount(this.host, screen.root);
    this.renderNav();
    this.updateWindowTitle(screen.title);
  }

  updateWindowTitle(title) {
    setWindowTitle(title ? `${title} — ${S.appName}` : S.appName);
  }

  /* -------------------------- shortcuts to screens ---------------------- */

  openMachines() { this.openTab('machines'); }
  openTerminalsTab() { this.openTab('terminals'); }
  openHome() { this.openTab('home'); }
  openSettings() { this.openTab('settings'); }

  openMachine(agentId, tab = 'terminals') {
    this.notifier?.noteAgentUsed(agentId);
    this.push('machine', { agentId, tab });
  }

  openMachineSettings(agentId) { this.push('machineSettings', { agentId }); }

  openTerminal(agentId, sessionId = null) {
    this.notifier?.noteAgentUsed(agentId);
    this.push('terminal', { agentId, sessionId });
  }

  openNewTerminal(agentId = null) { this.push('newTerminal', { agentId }); }
  openPresets() { this.push('presets', {}); }
  openPresetEditor(presetId, agentId) { this.push('newTerminal', { presetId, agentId, presetMode: true }); }
  openDevices() { this.push('devices', {}); }
  openCommandHistory() { this.push('commandHistory', {}); }
  openTerminalFont() { this.push('terminalFont', {}); }

  openAddMachine(initial = false) {
    this.stack = [];
    this.push('addMachine', { initial });
  }

  /** After a successful pairing: rebuild the normal screens. */
  onPaired() {
    this.stack = [];
    this.openTab('home');
  }

  /* --------------------------------- nav -------------------------------- */

  renderNav() {
    const nav = document.getElementById('nav');
    const pushed = this.stack.length > 0;
    clear(nav);
    nav.append(el('div.nav-mark', null, svgIcon('terminal_square')));
    for (const d of DESTINATIONS) {
      const active = !pushed && d.id === this.destination;
      nav.append(el('button.nav-item', {
        onClick: () => this.openTab(d.id),
        'aria-current': active ? 'page' : null,
        title: d.label,
      }, svgIcon(d.icon), el('span', { text: d.label })));
    }
    nav.append(this.navFoot());
  }

  navFoot() {
    const tone = connectionTone(this.client.state);
    return el('div.nav-foot', null,
      el('div.nav-status', { title: connectionLabel(this.client.state) },
        el(`span.dot.tone-${tone}`),
        el('span', { text: shortState(this.client.state) })));
  }

  /* -------------------------------- theme ------------------------------- */

  applyTheme() {
    const mode = this.settings.appTheme;
    const root = document.documentElement;
    if (mode === 'light') root.setAttribute('data-theme', 'light');
    else if (mode === 'dark') root.setAttribute('data-theme', 'dark');
    else {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    }
  }
}

function shortState(state) {
  switch (state.name) {
    case ConnectionState.CONNECTED: return 'Live';
    case ConnectionState.CONNECTING: return '…';
    case ConnectionState.RECONNECTING: return 'Retry';
    case ConnectionState.UNPAIRED: return 'Pair';
    case ConnectionState.FAILED: return 'Error';
    default: return 'Off';
  }
}

/* --------------------------------- start -------------------------------- */

export async function start() {
  const settings = await Settings.load();
  const credentials = await Credentials.load();

  const app = new App(settings, credentials);
  window.rtApp = app; // one global, for the console and for debugging a build

  app.applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.appTheme === 'system') app.applyTheme();
  });

  app.agents = await AgentRepository.load(app.client);
  app.sessions = new SessionRepository(app.client, app.agents, settings);
  app.notifier = new Notifier(settings, app.client, app.agents, app.sessions);

  app.client.keepAliveInBackground = () => app.sessions.wantsBackgroundKeepAlive();
  app.sessions.onClipboard = (_session, text) => {
    if (settings.osc52Clipboard) system.clipboardWriteText(text).catch(() => {});
  };

  // The nav rail and any screen showing connection state follow the socket.
  app.client.on('state', () => {
    app.renderNav();
    app.current?.onConnectionState?.(app.client.state);
  });
  app.client.on('relayError', (event) => {
    if (event.code === 'rate_limited' || event.code === 'internal') return; // not worth interrupting for
    toast(event.message || event.code, { error: true });
  });
  app.client.on('state', (state) => {
    if (state.name === ConnectionState.UNPAIRED) {
      const top = app.stack[app.stack.length - 1];
      if (top?.name !== 'addMachine') app.openAddMachine(true);
    }
  });

  settings.on('changed', () => {
    app.applyTheme();
    system.setKeepAwake(settings.keepAwake && app.sessions.sessions.size > 0).catch(() => {});
    app.current?.onSettingsChanged?.();
  });

  // The phone's foreground/background maps to the window being *visible*, not
  // focused: on a desktop another window takes focus constantly, and dropping
  // the relay every time the user alt-tabs would be absurd. Notifications, on
  // the other hand, are about attention, so they follow focus.
  const onVisibility = () => app.client.setForeground(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', () => { app.notifier.foreground = true; });
  window.addEventListener('blur', () => { app.notifier.foreground = false; });
  onVisibility();
  window.addEventListener('beforeunload', () => { settings.flush(); });

  wireGlobalKeys(app);
  await guardWithAppLock(app);

  if (!credentials.isPaired) app.openAddMachine(true);
  else {
    app.openTab('home');
    app.client.start();
  }

  showSplash();
  if (!inShell) {
    toast('Running outside the app window: the relay and clipboard are unavailable.', { error: true, ms: 8000 });
  }
}

/**
 * Application-wide keys.
 *
 * A focused terminal is greedy on purpose — every plain key belongs to the
 * shell — so the window's own shortcuts are taken in the capture phase, before
 * the grid sees them, and they are deliberately chords a shell has no use for.
 * `Alt+←` and `Ctrl+Shift+1..4` therefore work everywhere, including inside a
 * terminal; the unshifted `Ctrl+1..4` stays with the shell there, because
 * `Ctrl+4` is a real control code (`^\`).
 */
const SHIFTED_DIGITS = { '!': '1', '@': '2', '#': '3', '$': '4' };

function wireGlobalKeys(app) {
  const destination = (index) => {
    app.openTab(DESTINATIONS[index].id);
  };

  window.addEventListener('keydown', (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const isTerminal = e.target instanceof HTMLTextAreaElement && e.target.classList.contains('terminal-input');

    // Reserved for the window, wherever focus is.
    if (e.altKey && !e.ctrlKey && e.key === 'ArrowLeft') {
      if (app.back()) e.preventDefault();
      return;
    }
    // Which of 1..4 was pressed, whatever the modifiers did to it. `code` is
    // the physical key and is right on every layout; input injected without a
    // scan code carries none, so `key` and then the US shifted symbols stand in.
    const digit = /^Digit([1-4])$/.exec(e.code)?.[1]
      ?? (/^[1-4]$/.test(e.key) ? e.key : null)
      ?? SHIFTED_DIGITS[e.key]
      ?? null;
    if (digit && e.ctrlKey && e.shiftKey && !e.altKey) {
      destination(Number(digit) - 1);
      e.preventDefault();
      return;
    }

    // The rest defer to whatever has focus.
    if (e.defaultPrevented) return;
    if (e.key === 'Escape' && app.stack.length > 0 && !inField) {
      if (app.back()) e.preventDefault();
      return;
    }
    if (digit && e.ctrlKey && !e.shiftKey && !e.altKey && !isTerminal) {
      destination(Number(digit) - 1);
      e.preventDefault();
    }
  }, true);
}

/**
 * Optional app lock. Uses the Windows Hello consent prompt; when the machine
 * has none configured the setting turns itself off rather than pretending to
 * protect anything.
 */
async function guardWithAppLock(app) {
  if (!app.settings.appLock) return;
  const cover = document.getElementById('lock');
  cover.classList.remove('hidden');
  try {
    const available = await system.appLockAvailable();
    if (!available) {
      app.settings.appLock = false;
      cover.classList.add('hidden');
      return;
    }
    const ok = await system.appLockPrompt(S.settingAppLockDesc);
    if (!ok) {
      // Refusing the prompt must not leave the terminal readable.
      window.close();
      return;
    }
  } catch {
    app.settings.appLock = false;
  }
  cover.classList.add('hidden');
}

/**
 * The brand card over the first screen while it settles. Nothing waits on it:
 * the app is live underneath, and a click takes it away at once.
 */
function showSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  const year = new Date().getFullYear();
  const copy = splash.querySelector('.splash-copy');
  if (copy) copy.textContent = `© ${year} Cactus Software Group`;
  const hide = () => {
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 500);
  };
  splash.addEventListener('click', hide, { once: true });
  setTimeout(hide, 2200);
}

export { clearOverlays };
