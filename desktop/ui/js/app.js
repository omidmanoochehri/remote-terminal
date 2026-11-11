/**
 * The application shell: process-wide singletons, the navigation rail, and the
 * back stack every pushed screen returns through.
 *
 * The four destinations behind the rail (Home, Machines, Terminals, Settings)
 * are swapped in place; every other screen is pushed over them, exactly as the
 * phone does with its fragment back stack.
 *
 * A terminal moved into a window of its own runs this same shell as a second,
 * smaller app (`app.boot` set, see src/windows.rs): no rail, one terminal at
 * the bottom of its stack, its own relay connection. Whatever it cannot do on
 * its own — another destination, another terminal — it asks the main window to
 * do, over the events in `wireWindows`.
 */

import { Settings } from './core/settings.js';
import { Credentials } from './core/credentials.js';
import { RelayClient, ConnectionState } from './core/relay.js';
import { AgentRepository } from './core/agents.js';
import { SessionRepository } from './core/sessions.js';
import { Notifier } from './core/notifier.js';
import { Recordings } from './core/recordings.js';
import { themeFromScheme } from './core/schemes.js';
import { setCustomThemes } from './terminal/theme.js';
import { openPalette } from './ui/palette.js';
import {
  system, setWindowTitle, inShell, terminalWindow, windowLabel, terminalWindows, listen, broadcastEvent,
} from './core/platform.js';
import { el, clear, svgIcon, mount } from './ui/dom.js';
import { APP_LOCALE, IS_RTL, S, setLanguage } from './ui/strings.js';
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
import { snippetsScreen } from './ui/screens/snippets.js';
import { recordingsScreen } from './ui/screens/recordings.js';
import { playerScreen } from './ui/screens/player.js';
import { colourSchemesScreen, schemeEditorScreen } from './ui/screens/colourSchemes.js';

const DESTINATIONS = [
  { id: 'home', icon: 'home', label: () => S.navHome, screen: homeScreen },
  { id: 'machines', icon: 'monitor', label: () => S.navMachines, screen: machinesScreen },
  { id: 'terminals', icon: 'terminal_square', label: () => S.navTerminals, screen: terminalsScreen },
  { id: 'settings', icon: 'settings', label: () => S.navSettings, screen: settingsScreen },
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
  snippets: snippetsScreen,
  recordings: recordingsScreen,
  player: playerScreen,
  colourSchemes: colourSchemesScreen,
  schemeEditor: schemeEditorScreen,
};

class App {
  constructor(settings, credentials, boot = null) {
    /** In a terminal window, which terminal it is for; null in the main window. */
    this.boot = boot;
    /** Terminal window: kept above the other windows. */
    this.onTop = !!boot?.onTop;
    this.settings = settings;
    this.credentials = credentials;
    this.client = new RelayClient(credentials, APP_VERSION);
    this.agents = null;   // filled in by start()
    this.sessions = null;
    this.notifier = null;
    this.recordings = null;
    /** Broadcast input: { sourceKey, targets:Set<key> } while typing goes to several tabs. */
    this.broadcast = null;

    this.stack = [];      // pushed screens over the current destination
    this.destination = 'home';
    this.current = null;  // { root, destroy }
    this.unlocked = false;
    this.appliedLanguage = null;
    /** Main window: what each terminal window said it was closing for, by label. */
    this.windowResults = new Map();
  }

  /* ------------------------------ navigation ---------------------------- */

  get host() { return document.getElementById('screen'); }

  /** How many screens are the root: none in the main window, the terminal in a terminal window. */
  get rootDepth() { return this.boot ? 1 : 0; }

  /** Show one of the four destinations, dropping anything pushed over it. */
  openTab(id) {
    if (this.boot) { this.askMain({ action: 'tab', tab: id }); return; }
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
    // A terminal window's terminal is its root; there is nothing under it.
    if (this.stack.length <= this.rootDepth) return false;
    this.stack.pop();
    this.renderCurrent();
    return true;
  }

  /** Drop every pushed screen without changing destination. */
  popToRoot() {
    if (this.stack.length <= this.rootDepth) return;
    this.stack = this.stack.slice(0, this.rootDepth);
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

  /**
   * The machine's file browser, optionally at [path]; from a terminal, pass
   * its key so "Insert path" can type into it.
   */
  openFiles(agentId, { path = null, sessionKey = null } = {}) {
    this.notifier?.noteAgentUsed(agentId);
    this.push('machine', { agentId, tab: 'files', path, sessionKey });
  }

  openMachineSettings(agentId) { this.push('machineSettings', { agentId }); }

  openTerminal(agentId, sessionId = null) {
    if (this.boot) {
      if (agentId === this.boot.agentId && sessionId === this.boot.sessionId) { this.popToRoot(); return; }
      this.askMain({ action: 'terminal', agentId, sessionId });
      return;
    }
    // A terminal living in a window of its own is shown there.
    const s = sessionId ? this.sessions?.find(agentId, sessionId) : null;
    if (s?.windowLabel) { this.focusWindow(s.windowLabel); return; }
    this.notifier?.noteAgentUsed(agentId);
    this.push('terminal', { agentId, sessionId });
  }

  /* --------------------------- terminal windows ------------------------- */

  /** Main window: move [s] into a window of its own, or show the one it is in. */
  async moveToWindow(s) {
    if (this.boot || !s) return;
    if (s.windowLabel) { this.focusWindow(s.windowLabel); return; }
    const agent = this.agents.agent(s.agentId);
    const machine = agent?.name || agent?.hostname || '';
    const title = machine ? `${s.displayTitle} — ${machine}` : s.displayTitle;
    try {
      const label = await terminalWindows.open(s.agentId, s.sessionId, title, this.settings.terminalWindowOnTop);
      this.sessions.moveToWindow(s, label);
    } catch (err) {
      toast(S.windowOpenFailed(String(err?.message || err)), { error: true });
    }
  }

  focusWindow(label) {
    terminalWindows.focus(label).catch(() => {});
  }

  /** Main window: close a terminal window (its terminal comes back here). */
  closeTerminalWindow(label) {
    terminalWindows.close(label).catch(() => {});
  }

  /**
   * Terminal window: close it. [action] tells the main window what to do with
   * the terminal — 'return' shows it there, 'closed' drops its tab (the user
   * closed it here), and anything else just takes it back quietly.
   */
  async closeWindow(action = 'return') {
    if (!this.boot) return;
    await this.settings.flush();
    await broadcastEvent('rt:window-result', { label: this.boot.label, action });
    terminalWindows.close(this.boot.label).catch(() => window.close());
  }

  /** Terminal window: hand something to the main window and bring it forward. */
  askMain(request) {
    broadcastEvent('rt:main', request);
    this.focusWindow('main');
  }

  /** Terminal window: keep it above other windows, and remember the choice. */
  setOnTop(on) {
    this.onTop = !!on;
    this.settings.terminalWindowOnTop = this.onTop;
    terminalWindows.setOnTop(this.onTop).catch((err) => toast(String(err?.message || err), { error: true }));
    this.current?.onWindowChanged?.();
  }

  openNewTerminal(agentId = null) { this.push('newTerminal', { agentId }); }
  openPresets() { this.push('presets', {}); }
  openPresetEditor(presetId, agentId) { this.push('newTerminal', { presetId, agentId, presetMode: true }); }

  /** The preset editor, filled in from a terminal that is already running. */
  openPresetDraft(draft) { this.push('newTerminal', { draft, agentId: draft.agentId, presetMode: true }); }
  openDevices() { this.push('devices', {}); }
  openCommandHistory() { this.push('commandHistory', {}); }
  openTerminalFont() { this.push('terminalFont', {}); }
  openSnippets() { this.push('snippets', {}); }
  openRecordings() { this.push('recordings', {}); }
  openPlayer(id) { this.push('player', { id }); }
  openColourSchemes() { this.push('colourSchemes', {}); }
  openSchemeEditor(id) { this.push('schemeEditor', { id }); }

  /** The command palette: the terminal's own when one is on screen, the general one otherwise. */
  openPalette() {
    if (this.current?.openPalette) this.current.openPalette();
    else openPalette(this);
  }

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
    if (this.boot) return; // a terminal window has no rail
    const nav = document.getElementById('nav');
    const pushed = this.stack.length > 0;
    clear(nav);
    nav.append(el('div.nav-mark', null, svgIcon('terminal_square')));
    for (const d of DESTINATIONS) {
      const active = !pushed && d.id === this.destination;
      const label = d.label();
      nav.append(el('button.nav-item', {
        onClick: () => this.openTab(d.id),
        'aria-current': active ? 'page' : null,
        title: label,
      }, svgIcon(d.icon), el('span', { text: label })));
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

  applyLanguage({ rerender = true } = {}) {
    const selected = this.settings.appLanguage;
    if (selected === this.appliedLanguage) return;
    this.appliedLanguage = selected;
    setLanguage(selected);
    applyLocaleChrome();
    if (rerender && this.current) this.renderCurrent();
    else this.renderNav();
  }
}

function shortState(state) {
  switch (state.name) {
    case ConnectionState.CONNECTED: return S.stateLiveShort ?? 'Live';
    case ConnectionState.CONNECTING: return '…';
    case ConnectionState.RECONNECTING: return S.stateRetryShort ?? 'Retry';
    case ConnectionState.UNPAIRED: return S.statePairShort ?? 'Pair';
    case ConnectionState.FAILED: return S.stateErrorShort ?? 'Error';
    default: return S.stateOffShort ?? 'Off';
  }
}

/* --------------------------------- start -------------------------------- */

export async function start() {
  const boot = terminalWindow;
  if (boot) {
    // A terminal window shows its terminal at once: no rail, no brand card.
    document.documentElement.classList.add('terminal-window');
    document.getElementById('splash')?.remove();
  }
  const settings = await Settings.load();
  settings.writesDisk = !boot;
  const credentials = await Credentials.load();

  const app = new App(settings, credentials, boot);
  window.rtApp = app; // one global, for the console and for debugging a build

  app.applyLanguage({ rerender: false });
  app.applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.appTheme === 'system') app.applyTheme();
  });

  app.agents = await AgentRepository.load(app.client);
  app.sessions = new SessionRepository(app.client, app.agents, settings, { persistTabs: !boot });
  app.notifier = new Notifier(settings, app.client, app.agents, app.sessions, { agentAlerts: !boot });
  app.recordings = await new Recordings(app.sessions).load();
  app.recordings.onAutoStop = () => toast(S.recordFull, { ms: 6000 });
  app.recordings.onError = (why) => toast(S.recordFailed(why), { error: true });

  // User colour schemes join the built-in ones wherever a scheme is chosen.
  let schemesJson = null;
  const registerSchemes = () => {
    const json = JSON.stringify(settings.get('custom_schemes') ?? null);
    if (json === schemesJson) return;
    schemesJson = json;
    setCustomThemes(settings.customSchemes.map(themeFromScheme));
  };
  registerSchemes();
  settings.on('changed', registerSchemes);

  app.client.keepAliveInBackground = () => app.sessions.wantsBackgroundKeepAlive();
  // A watch the user set fires in the window as well as in the notification area.
  app.notifier.onAlert = (title) => toast(title, { ms: 6000 });
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
    if (state.name === ConnectionState.UNPAIRED && boot) { app.closeWindow('none'); return; }
    if (state.name === ConnectionState.UNPAIRED) {
      const top = app.stack[app.stack.length - 1];
      if (top?.name !== 'addMachine') app.openAddMachine(true);
    }
  });

  settings.on('changed', () => {
    app.applyLanguage();
    app.applyTheme();
    system.setKeepAwake(settings.keepAwake && app.sessions.sessions.size > 0).catch(() => {});
    // The close button is handled in Rust, before the page hears about it, so
    // the setting has to be pushed down rather than read up.
    if (!boot) system.setCloseToTray(settings.closeToTray).catch(() => {});
    app.current?.onSettingsChanged?.();
  });
  if (!boot) system.setCloseToTray(settings.closeToTray).catch(() => {});
  await wireWindows(app);

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

  if (boot) {
    // The main window was unlocked to open this one, so no second prompt.
    if (!credentials.isPaired) { app.closeWindow('none'); return; }
    app.sessions.get(boot.agentId, boot.sessionId);
    app.stack = [{ name: 'terminal', params: { agentId: boot.agentId, sessionId: boot.sessionId } }];
    app.renderCurrent();
    app.client.start();
    return;
  }

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
 * The windows talking to each other: settings changes both ways, and between
 * the main window and its terminal windows, who has which terminal.
 */
async function wireWindows(app) {
  app.settings.onSync = (changes) => broadcastEvent('rt:settings', { from: windowLabel, changes });
  await listen('rt:settings', ({ payload }) => {
    if (payload?.from !== windowLabel) app.settings.applyRemote(payload.changes);
  });
  if (app.boot) return;

  // What a terminal window asks for, it gets here.
  await listen('rt:main', ({ payload }) => {
    if (payload?.action === 'tab' && DESTINATIONS.some((d) => d.id === payload.tab)) app.openTab(payload.tab);
    else if (payload?.action === 'terminal') app.openTerminal(payload.agentId, payload.sessionId ?? null);
    else if (payload?.action === 'newTerminal') app.openNewTerminal(payload.agentId ?? null);
  });
  // Said just before a terminal window closes itself; acted on once it has.
  await listen('rt:window-result', ({ payload }) => {
    if (payload?.label) app.windowResults.set(payload.label, payload.action);
  });
  // From Rust, whichever way the window went: its close button, or the window
  // closing itself after 'rt:window-result'.
  await listen('rt:window-closed', ({ payload }) => {
    const label = String(payload ?? '');
    const action = app.windowResults.get(label);
    app.windowResults.delete(label);
    const s = app.sessions.returnFromWindow(label);
    if (!s) return;
    if (action === 'closed') { app.sessions.closeTab(s, false); return; }
    if (action === 'return') {
      app.focusWindow('main');
      app.openTerminal(s.agentId, s.sessionId);
    }
  });
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
    // The command palette, from anywhere (a terminal offers its own actions in it).
    if (e.ctrlKey && e.shiftKey && !e.altKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p')) {
      if (!document.querySelector('.scrim')) app.openPalette();
      e.preventDefault();
      e.stopPropagation();
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

function applyLocaleChrome() {
  document.documentElement.lang = APP_LOCALE;
  document.documentElement.dir = IS_RTL ? 'rtl' : 'ltr';
  document.title = S.appName;
  const splashTitle = document.querySelector('.splash-title');
  const splashSub = document.querySelector('.splash-sub');
  if (splashTitle) splashTitle.textContent = S.appName;
  if (splashSub) splashSub.textContent = IS_RTL ? 'قدرت گرفته از Cactus Software Group' : 'Powered by Cactus Software Group';
}

export { clearOverlays };
