/**
 * The terminal screen for one machine: the tab strip, the grid in its well, the
 * search bar, the command bar, the extra-keys rows, and a status footer that
 * says in words what the connection is doing.
 *
 * A port of `TerminalFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction } from '../dom.js';
import { S } from '../strings.js';
import { shellQuote } from '../../core/shell.js';
import {
  menu, toast, confirmDialog, promptDialog, chooseDialog, actionsDialog, customDialog,
} from '../overlays.js';
import { terminalMenu, duplicateTerminal, launchPreset, copyToClipboard } from '../actions.js';
import { TerminalView } from '../../terminal/view.js';
import { ExtraKeysBar, Action } from '../../terminal/extrakeys.js';
import { ModifierState } from '../../terminal/modifiers.js';
import { themeById, ALL_THEMES } from '../../terminal/theme.js';
import * as Keys from '../../terminal/keyencoder.js';
import { CURSOR_BLOCK, CURSOR_UNDERLINE, CURSOR_BAR } from '../../terminal/attrs.js';
import { State as StreamState } from '../../protocol/stream.js';
import { ConnectionState } from '../../core/relay.js';
import { presence, connectionLabel, connectionTone, duration } from '../../core/format.js';
import { FONT_SYSTEM } from '../../core/settings.js';
import { system, pickFile, pickSavePath, localFiles } from '../../core/platform.js';
import { isOpenable } from '../../terminal/links.js';
import { transcriptText, transcriptFileName } from '../../core/transcript.js';
import { encodeUtf8Base64 } from '../../core/remoteFiles.js';
import { featureGate } from '../../core/requests.js';

/** The control shortcuts the sheet offers, as on the phone. */
const SHORTCUT_KEYS = [
  'Ctrl+C', 'Ctrl+D', 'Ctrl+Z', 'Ctrl+L', 'Ctrl+A', 'Ctrl+E', 'Ctrl+R',
  'Ctrl+W', 'Ctrl+U', 'Ctrl+K', 'Alt+B', 'Alt+F', 'Shift+Tab',
];

export function terminalScreen(app, { agentId, sessionId }) {
  const screen = new Screen(app);
  const modifiers = new ModifierState();

  let current = null;
  let tabs = [];
  let creating = false;
  let uploadLabel = null;
  let tabUnsubscribe = null;
  /** Set while typing something only this terminal should get (an uploaded file's path). */
  let noBroadcast = false;

  /* ------------------------------- markup ------------------------------- */

  const machineName = el('div', { class: 'name', text: '' });
  const machineDot = el('span.dot');
  const machineStatus = el('div.status', null, machineDot, el('span', { text: '' }));

  const searchInput = el('input', { type: 'search', placeholder: S.searchHint, 'aria-label': S.searchHint });
  const searchCount = el('span', { class: 'count', text: '' });
  const searchBar = el('div.terminal-search.hidden', null,
    svgIcon('search'),
    searchInput,
    searchCount,
    el('button.icon-button.small', { title: S.searchPrev, onClick: () => view.searchNext(false) }, svgIcon('chevron_up')),
    el('button.icon-button.small', { title: S.searchNext, onClick: () => view.searchNext(true) }, svgIcon('chevron_down')),
    el('button.icon-button.small', { title: S.closeSearch, onClick: () => toggleSearch(false) }, svgIcon('close')));

  const tabStrip = el('div.tab-strip', { role: 'tablist' });
  const banner = el('div.terminal-banner.hidden');
  const broadcastText = el('span', { text: '' });
  const broadcastBar = el('div.broadcast-bar.hidden', null,
    svgIcon('radio'),
    broadcastText,
    el('span.spacer'),
    el('button.link-button', { text: S.broadcastStop, onClick: () => stopBroadcast(true) }));
  const canvas = el('canvas', { tabindex: '-1' });
  const newLinesChip = el('button.new-lines-chip.hidden', { text: '', onClick: () => view.scrollToBottom() });
  const frame = el('div.terminal-frame', null, canvas, newLinesChip);

  const commandInput = el('input', { type: 'text', placeholder: S.commandPlaceholder, 'aria-label': S.commandPlaceholder });
  const commandBar = el('div.command-bar', null,
    el('span', { class: 'prompt', text: '›' }),
    commandInput,
    el('button', { class: 'send', title: S.send, onClick: () => sendCommandLine() }, svgIcon('send')));

  const keyRows = el('div.key-rows');

  const footerDot = el('span.dot');
  const footerState = el('span', { text: '' });
  const footerShell = el('span', { text: S.terminal });
  const footerUptime = el('span', { text: S.valueUnknown });
  const statusFooter = el('div.status-footer', null,
    el('span', { class: 'footer-state' }, footerDot, footerState),
    el('span', { class: 'footer-sep', text: '·' }),
    footerShell,
    el('span', { class: 'footer-sep', text: '·' }),
    footerUptime,
    el('span', { class: 'spacer' }),
    el('button.link-button', { text: S.terminalSettings, onClick: () => app.openTerminalFont() }));

  const root = el('div.screen.terminal-screen', null,
    el('div.terminal-top', null,
      el('button.icon-button', { title: S.back, onClick: () => app.back() }, svgIcon('arrow_left')),
      el('div.terminal-machine', null, machineName, machineStatus),
      headerAction('search', S.search, () => toggleSearch(searchBar.classList.contains('hidden'))),
      headerAction('command', S.shortcuts, () => showShortcuts()),
      headerAction('more', S.more, (e) => moreMenu(e.currentTarget))),
    tabStrip,
    searchBar,
    broadcastBar,
    banner,
    frame,
    commandBar,
    keyRows,
    statusFooter);

  const view = new TerminalView(canvas);
  view.modifiers = modifiers;
  const keys = new ExtraKeysBar(keyRows, modifiers);

  /* ------------------------------- wiring ------------------------------- */

  view.onInput = (data) => sendInput(data);
  view.onGeometryChanged = (cols, rows) => {
    if (!current) return;
    app.sessions.resize(current, cols, rows);
    ensureAttached(current);
  };
  view.onFollowChanged = (following, newRows) => {
    newLinesChip.classList.toggle('hidden', following || newRows <= 0);
    newLinesChip.textContent = S.newLines(newRows);
  };
  view.onFontSizeChanged = (size) => { app.settings.fontSize = size; };
  view.onCopy = (text) => copyToClipboard(text);
  view.onPasteRequest = (text) => paste(text);
  view.onSwitchTab = (forward) => switchTab(forward);
  view.onSearchResult = (cur, total) => {
    searchCount.textContent = total === 0 ? S.searchNone : S.searchCount(cur, total);
  };
  view.onContextMenu = (e) => selectionMenu(e);
  view.onOpenLink = (url) => openLink(url);

  keys.onKey = (spec) => {
    if (spec.action === Action.SPECIAL) view.sendKey(spec.key);
    else if (spec.action === Action.TEXT) view.typeText(spec.text);
  };

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { view.search(searchInput.value); e.preventDefault(); }
    if (e.key === 'Escape') { toggleSearch(false); e.preventDefault(); }
  });
  commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { sendCommandLine(); e.preventDefault(); }
    if (e.key === 'Escape') { view.focus(); e.preventDefault(); }
  });

  // Ctrl+Tab and Ctrl+PageUp/Down move between tabs, as every tabbed app does.
  const onKeyDown = (e) => {
    if (!e.ctrlKey) return;
    if (e.key === 'Tab') { switchTab(!e.shiftKey); e.preventDefault(); }
    else if (e.key === 'PageDown') { switchTab(true); e.preventDefault(); }
    else if (e.key === 'PageUp') { switchTab(false); e.preventDefault(); }
    else if (e.key.toLowerCase() === 'f' && e.shiftKey) { toggleSearch(true); e.preventDefault(); }
  };
  root.addEventListener('keydown', onKeyDown);
  screen.track(() => root.removeEventListener('keydown', onKeyDown));
  // Ctrl+Shift+S has to be caught before the grid turns it into a control code.
  const onKeyCapture = (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      saveTranscript();
      e.preventDefault();
      e.stopPropagation();
    }
  };
  root.addEventListener('keydown', onKeyCapture, true);
  screen.track(() => root.removeEventListener('keydown', onKeyCapture, true));
  screen.track(() => view.destroy());
  screen.track(() => tabUnsubscribe?.());
  screen.track(() => system.setKeepAwake(false).catch(() => {}));

  /* ------------------------------ settings ------------------------------ */

  function applySettings() {
    const s = app.settings;
    view.setFontSize(s.fontSize, false);
    view.setLineSpacing(s.lineSpacing);
    view.setFontFamily(s.terminalFontFamily === FONT_SYSTEM);
    view.wheelSwitchTabs = s.wheelSwitchTabs;
    view.linksEnabled = s.clickableLinks;
    view.cursorStyleSetting =
      s.cursorStyle === 'underline' ? CURSOR_UNDERLINE : s.cursorStyle === 'bar' ? CURSOR_BAR : CURSOR_BLOCK;
    view.blinkEnabled = s.cursorBlink;
    keys.setRows([s.extraKeysRow1, s.extraKeysRow2, s.extraKeysRow3]);
    keyRows.classList.toggle('hidden', !s.showExtraKeys);
    commandBar.classList.toggle('hidden', !s.commandBar);
    system.setKeepAwake(s.keepAwake).catch(() => {});
    applyTheme();
  }

  /**
   * The visible tab's own colour scheme when it has one, otherwise the app-wide
   * setting. The well keeps the design outline; its fill follows the scheme so
   * a light terminal does not sit in a black frame.
   */
  function applyTheme() {
    const override = current ? app.settings.terminalThemeFor(current.key) : null;
    const theme = themeById(override ?? app.settings.terminalTheme);
    view.setTheme(theme);
    frame.style.background = theme.background;
  }

  async function chooseTheme() {
    if (!current) return;
    const appDefault = themeById(app.settings.terminalTheme);
    const options = [
      [null, S.terminalThemeDefault(appDefault.name)],
      ...ALL_THEMES.map((t) => [t.id, t.name]),
    ];
    const chosen = await chooseDialog({
      title: S.terminalThemeTitle,
      options,
      selected: app.settings.terminalThemeFor(current.key) ?? null,
    });
    if (chosen === undefined) return;
    app.settings.setTerminalTheme(current.key, chosen);
    applyTheme();
  }

  /* -------------------------------- tabs -------------------------------- */

  function renderTabs() {
    clear(tabStrip);
    for (const s of tabs) {
      const active = s === current;
      const tab = el('button.tab', {
        role: 'tab',
        'aria-selected': String(active),
        class: s.isRunning ? '' : 'exited',
        onClick: () => selectTab(s),
        onAuxclick: (e) => { if (e.button === 1) confirmClose(s); },
        oncontextmenu: (e) => { e.preventDefault(); tabMenu(e.currentTarget, s); },
        title: s.displayTitle,
      },
      svgIcon('terminal_square'),
      el('span', { text: s.displayTitle }),
      !active && s.unreadRows > 0
        ? el('span', { class: 'tab-badge', text: s.unreadRows > 99 ? '99+' : String(s.unreadRows) })
        : null,
      el('span', {
        class: 'tab-close',
        role: 'button',
        title: S.tabClose,
        onClick: (e) => { e.stopPropagation(); confirmClose(s); },
      }, svgIcon('close')));
      tabStrip.append(tab);
    }
    tabStrip.append(el('button.tab', {
      onClick: () => newTerminal(),
      title: S.newTerminal,
    }, svgIcon('plus'), el('span', { text: S.terminalNewTab })));
  }

  function tabMenu(anchor, s) {
    const info = app.agents.session(agentId, s.sessionId);
    const agent = app.agents.agent(agentId);
    if (info && agent) { terminalMenu(app, anchor, agent, info); return; }
    menu(anchor, [
      { label: S.renameTerminal, icon: 'tag', onClick: () => renameTab(s) },
      { label: S.tabClose, icon: 'close', onClick: () => confirmClose(s) },
    ]);
  }

  function chooseInitialTab() {
    const requested = sessionId;
    const byArg = requested
      ? tabs.find((t) => t.sessionId === requested) ?? app.sessions.get(agentId, requested)
      : null;
    const pick = byArg
      ?? tabs.find((t) => t.sessionId === app.settings.activeTab(agentId))
      ?? tabs[0];
    if (pick) { selectTab(pick); return; }
    if (creating) return;
    const agent = app.agents.agent(agentId);
    if (agent?.online) newTerminal();
    else updateStatus();
  }

  function selectTab(s) {
    current = s;
    s.unreadRows = 0;
    app.settings.setActiveTab(agentId, s.sessionId);
    view.setEmulator(s.emulator);
    view.pushGeometry();
    applyTheme();
    ensureAttached(s);
    renderTabs();
    updateStatus();
    renderBroadcast();
    view.focus();

    // One subscription at a time: switching tabs is cheap and frequent.
    tabUnsubscribe?.();
    const offChanged = s.on('changed', () => { if (s === current) { updateStatus(); renderTabs(); } });
    const offOutput = s.on('output', () => { if (s === current) view.notifyUpdated(); });
    tabUnsubscribe = () => { offChanged(); offOutput(); };
  }

  /** The neighbouring tab; nothing at the ends. */
  function switchTab(forward) {
    if (tabs.length < 2 || !current) return;
    const index = tabs.indexOf(current);
    if (index < 0) return;
    const next = index + (forward ? 1 : -1);
    if (next < 0 || next >= tabs.length) return;
    selectTab(tabs[next]);
  }

  function ensureAttached(s) {
    if (s.stream.state === StreamState.DETACHED && s.isRunning && app.client.isConnected) {
      app.sessions.attach(s, view.cols, view.rows);
    }
  }

  function newTerminal() {
    const agent = app.agents.agent(agentId);
    if (!agent) return;
    if (!agent.online) { toast(S.agentOfflineHint, { error: true }); return; }
    // The full form is a screen of its own; go there rather than stacking dialogs.
    app.openNewTerminal(agentId);
  }

  async function confirmClose(s) {
    if (!s.isRunning) { app.sessions.closeTab(s, false); return; }
    const choice = await actionsDialog({
      title: S.tabCloseTitle(s.displayTitle),
      items: [
        { label: S.tabKeepRunning, description: S.tabKeepRunningDesc },
        { label: S.tabTerminate, description: S.tabTerminateDesc },
      ],
    });
    if (choice == null) return;
    if (choice === 1) app.settings.forgetSessionPrefs(s.key);
    app.sessions.closeTab(s, choice === 1);
  }

  async function renameTab(s) {
    const title = await promptDialog({ title: S.renameTerminal, label: S.fieldTerminalName, value: s.title });
    if (title) app.sessions.rename(s, title);
  }

  /* -------------------------------- status ------------------------------ */

  function updateStatus() {
    const state = app.client.state;
    const s = current;
    const agent = app.agents.agent(agentId);

    // The banner only speaks up when something is wrong or in progress.
    let text = null;
    if (uploadLabel) text = uploadLabel;
    else if (creating) text = S.creatingTerminal;
    else if (state.name !== ConnectionState.CONNECTED) text = connectionLabel(state);
    else if (agent && !agent.online) text = S.terminalOffline;
    else if (!s) text = null;
    else if (s.state === 'exited') text = S.terminalExited;
    else if (s.state === 'closed') {
      text = s.closedReason === 'gone' || s.closedReason === 'removed' ? S.terminalGone : S.terminalClosed;
    } else if (s.attachError) text = s.attachError;
    else if (s.stream.state === StreamState.ATTACHING) text = S.terminalAttaching;

    banner.textContent = text ?? '';
    banner.classList.toggle('hidden', text == null);
    frame.classList.toggle('detached', !(s && s.stream.state === StreamState.ATTACHED));

    // Footer: state in words, the shell, and how long the session has run.
    const attached = !!s && s.stream.state === StreamState.ATTACHED;
    let label;
    let tone;
    if (state.name !== ConnectionState.CONNECTED) {
      label = connectionLabel(state);
      tone = connectionTone(state);
    } else if (agent && !agent.online) {
      label = S.machineOffline;
      tone = 'offline';
    } else if (s && !s.isRunning) {
      label = S.terminalExited;
      tone = 'warn';
    } else if (attached) {
      label = S.stateConnected;
      tone = 'online';
    } else {
      label = S.terminalAttaching;
      tone = 'warn';
    }
    footerState.textContent = label;
    footerState.className = `tone-${tone}`;
    footerDot.className = `dot tone-${tone}`;

    const info = s ? app.agents.session(agentId, s.sessionId) : null;
    footerShell.textContent = s?.shell || S.terminal;
    // Prefer the machine's own start time; fall back to when this device opened the tab.
    const startedAt = (info?.createdAt && info.createdAt > 0) ? info.createdAt : s?.openedAt ?? 0;
    footerUptime.textContent = startedAt > 0 ? duration(Math.floor((Date.now() - startedAt) / 1000)) : S.valueUnknown;

    if (agent) {
      const p = presence(agent, state);
      machineName.textContent = agent.name || agent.hostname;
      machineDot.className = `dot tone-${p.tone}`;
      machineStatus.lastChild.textContent = [agent.hostname, agent.os].filter(Boolean).join('  •  ') || p.label;
      screen.title = `${s?.displayTitle ?? S.terminal} — ${agent.name || agent.hostname}`;
      app.updateWindowTitle(screen.title);
    }
  }

  /* -------------------------------- input ------------------------------- */

  function sendInput(data) {
    const s = current;
    if (!s) return;
    if (!app.sessions.input(s, data)) {
      if (s.state !== 'running') toast(S.terminalExited);
      else ensureAttached(s);
    }
    if (!noBroadcast) broadcast(s, data);
  }

  /* ------------------------------ broadcast ----------------------------- */

  /**
   * While broadcasting from this tab, everything typed into it goes to the
   * chosen tabs as well — keys, pastes, the command bar, shortcuts. Mouse
   * reports do not (a click means something only where it was made), and
   * neither do resizes. It lives on the app, not the screen, so switching
   * away and back does not end it; it ends when its targets are gone.
   */
  function broadcast(s, data) {
    const b = app.broadcast;
    if (!b || b.sourceKey !== s.key) return;
    if (/^\x1b\[(<|M)/.test(data)) return;
    for (const key of [...b.targets]) {
      const t = app.sessions.sessions.get(key);
      if (!t || !t.isRunning) { b.targets.delete(key); continue; }
      if (!app.sessions.input(t, data)) app.sessions.attach(t, t.emulator.cols, t.emulator.rows);
    }
    if (b.targets.size === 0) stopBroadcast(true);
    else renderBroadcast();
  }

  async function chooseBroadcast() {
    const s = current;
    if (!s) return;
    const others = [...app.sessions.sessions.values()].filter((t) => t !== s && t.isRunning);
    if (others.length === 0) { toast(S.broadcastNone); return; }
    // Across machines, each target says which machine it is on.
    const spans = others.some((t) => t.agentId !== s.agentId);
    const boxes = others.map((t) => {
      const agent = app.agents.agent(t.agentId);
      const machine = agent?.name || agent?.hostname || '';
      const box = el('input', { type: 'checkbox', checked: true });
      return {
        t,
        box,
        row: el('label.check-row', null, box,
          el('span', { text: spans && machine ? `${t.displayTitle} — ${machine}` : t.displayTitle })),
      };
    });
    const ok = await customDialog({
      title: S.broadcastTitle,
      build: () => el('div', null,
        el('p', { text: S.broadcastBody }),
        boxes.map((b) => b.row)),
      actions: [{ label: S.cancel, value: false }, { label: S.broadcastStart, value: true }],
    });
    if (!ok) return;
    const targets = new Set(boxes.filter((b) => b.box.checked).map((b) => b.t.key));
    if (targets.size === 0) return;
    app.broadcast = { sourceKey: s.key, targets };
    for (const key of targets) {
      const t = app.sessions.sessions.get(key);
      if (t) ensureAttached(t);
    }
    renderBroadcast();
    view.focus();
  }

  function stopBroadcast(announce = false) {
    if (!app.broadcast) return;
    app.broadcast = null;
    renderBroadcast();
    if (announce) toast(S.broadcastStopped);
  }

  function renderBroadcast() {
    const b = app.broadcast;
    const on = !!b && !!current && b.sourceKey === current.key;
    broadcastBar.classList.toggle('hidden', !on);
    if (on) broadcastText.textContent = S.broadcastBanner(b.targets.size);
  }

  /* ------------------------------- links -------------------------------- */

  function openLink(url) {
    if (isOpenable(url)) {
      system.openUrl(url).catch((err) => toast(String(err?.message || err), { error: true }));
    } else {
      copyToClipboard(url);
      toast(S.linkNotOpenable);
    }
  }

  /* ----------------------------- transcript ----------------------------- */

  async function saveTranscript() {
    const s = current;
    if (!s) return;
    const text = transcriptText(s.emulator);
    if (!text) { toast(S.transcriptEmpty); return; }
    try {
      const path = await pickSavePath(transcriptFileName(s.displayTitle), [{ name: 'Text', extensions: ['txt'] }]);
      if (!path) return;
      await localFiles.write(path, 0, encodeUtf8Base64(text));
      toast(S.transcriptSaved(path));
    } catch (err) {
      toast(String(err?.message || err), { error: true });
    }
  }

  function copyTranscript() {
    const s = current;
    if (!s) return;
    const text = transcriptText(s.emulator);
    if (!text) { toast(S.transcriptEmpty); return; }
    copyToClipboard(text);
  }

  /* ------------------------------- watches ------------------------------ */

  async function watchForText() {
    const s = current;
    if (!s) return;
    const input = el('input', { type: 'text', placeholder: S.watchLabel });
    const keep = el('input', { type: 'checkbox' });
    const ok = await customDialog({
      title: S.watchTitle,
      build: (done) => {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
        requestAnimationFrame(() => input.focus());
        return el('div', null,
          el('p', { text: S.watchBody }),
          el('label.field-label', { text: S.watchLabel }),
          el('div.field-well', null, input),
          el('label.check-row', { style: { marginTop: '10px' } }, keep, el('span', { text: S.watchKeep })));
      },
      actions: [{ label: S.cancel, value: false }, { label: S.watchStart, value: true }],
    });
    const text = String(input.value).trim();
    if (!ok || !text) return;
    app.notifier.watchText(s, text, keep.checked);
    toast(S.watchStarted(text));
  }

  function toggleQuietWatch() {
    const s = current;
    if (!s) return;
    if (s.quietWatch) { app.notifier.stopQuiet(s); return; }
    app.notifier.watchQuiet(s);
    toast(S.notifyQuietArmed);
  }

  function browseFilesHere() {
    const s = current;
    if (!s) return;
    app.openFiles(agentId, { path: s.cwd || null, sessionKey: s.key });
  }

  function sendCommandLine() {
    const line = commandInput.value;
    if (!line.trim()) return;
    commandInput.value = '';
    app.settings.noteCommand(line);
    view.sendRaw(`${line}\r`);
    view.focus();
  }

  function toggleSearch(show) {
    searchBar.classList.toggle('hidden', !show);
    if (show) { searchInput.focus(); searchInput.select(); }
    else { view.clearSearch(); searchInput.value = ''; view.focus(); }
  }

  /**
   * Paste. A multi-line paste asks first unless the program enabled bracketed
   * paste, because each line ends with Enter and would run as a command.
   */
  async function paste(preloaded) {
    let text = preloaded;
    if (text == null) {
      try {
        const clip = await system.clipboardRead();
        // A file on the clipboard is uploaded to the machine instead of typed —
        // unless the agent cannot take files and there is text to fall back to.
        const filesSupported = app.agents.agent(agentId)?.caps.includes('files');
        if (clip.files.length > 0 && (filesSupported || !clip.text)) { uploadPath(clip.files[0]); return; }
        text = clip.text;
      } catch (err) {
        toast(String(err?.message || err), { error: true });
        return;
      }
    }
    if (!text) return;
    const lines = text.replace(/[\r\n]+$/, '').split('\n').length;
    if (lines >= app.settings.pasteConfirmLines && !view.emulator.bracketedPaste) {
      const ok = await confirmDialog({
        title: S.pasteConfirmTitle(lines),
        body: S.pasteConfirmText,
        confirmLabel: S.pasteConfirmOk,
      });
      if (!ok) return;
    }
    view.paste(text);
  }

  /* ------------------------------ uploads ------------------------------- */

  /** Both upload paths need an attached session on a machine that takes files. */
  function canUpload() {
    if (!app.agents.agent(agentId)?.caps.includes('files')) {
      toast(S.pasteFileUnsupported, { error: true });
      return false;
    }
    if (!current || current.stream.state !== StreamState.ATTACHED) {
      toast(S.terminalNotConnected, { error: true });
      return false;
    }
    return true;
  }

  async function uploadPath(path) {
    if (!canUpload()) return;
    try {
      const file = await system.readFileForUpload(path);
      await upload(file);
    } catch (err) {
      toast(S.pasteFileFailed(String(err?.message || err)), { error: true });
    }
  }

  async function pasteImage() {
    if (!canUpload()) return;
    try {
      const image = await system.clipboardReadImage();
      if (!image) { toast(S.pasteImageNone); return; }
      await upload(image);
    } catch (err) {
      toast(S.pasteFileFailed(String(err?.message || err)), { error: true });
    }
  }

  async function pasteFile() {
    try {
      const clip = await system.clipboardRead();
      if (clip.files.length === 0) { toast(S.pasteFileNone); return; }
      await uploadPath(clip.files[0]);
    } catch (err) {
      toast(String(err?.message || err), { error: true });
    }
  }

  async function attachFile() {
    if (!canUpload()) return;
    try {
      const path = await pickFile();
      if (path) await uploadPath(path);
    } catch {
      toast(S.attachFileUnavailable, { error: true });
    }
  }

  /**
   * Send the file to the machine and type its path at the cursor, so the user
   * can do whatever they like with it. Nothing is executed.
   */
  async function upload(file) {
    const s = current;
    if (!s) return;
    uploadLabel = S.pasteFileUploading;
    updateStatus();
    const result = await app.sessions.sendFile(s, file.name, file.mime, file.data, file.size);
    uploadLabel = null;
    updateStatus();
    if (result.ok) {
      noBroadcast = true;
      view.sendRaw(shellQuote(result.path));
      noBroadcast = false;
      toast(S.pasteFileDone(result.path));
    } else {
      toast(S.pasteFileFailed(result.error), { error: true });
    }
  }

  /* -------------------------------- menus ------------------------------- */

  function selectionMenu(e) {
    const text = view.selectedText();
    const link = app.settings.clickableLinks ? view.linkAtPoint(e.clientX, e.clientY) : null;
    menu({ getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, [
      link && isOpenable(link.url) ? { label: S.openLink, icon: 'external', onClick: () => openLink(link.url) } : null,
      link ? { label: S.copyLink, icon: 'link', onClick: () => copyToClipboard(link.url) } : null,
      link ? { divider: true } : null,
      text ? { label: S.copy, icon: 'copy', onClick: () => { copyToClipboard(text); view.clearSelection(); } } : null,
      { label: S.paste, icon: 'save', onClick: () => paste() },
      { label: S.selectAll, icon: 'check', onClick: () => view.selectAll() },
      { divider: true },
      { label: S.clearTerminal, icon: 'close', onClick: () => { view.emulator.clearScreen(); view.notifyUpdated(); } },
    ]);
  }

  function moreMenu(anchor) {
    const s = current;
    const pinned = s ? app.settings.isPinnedTerminal(agentId, s.sessionId) : false;
    const presets = app.settings.presetsFor(agentId);
    const filesOk = featureGate(app.client.caps, app.agents.agent(agentId), 'fs').ok;
    const broadcasting = !!app.broadcast && !!s && app.broadcast.sourceKey === s.key;
    menu(anchor, [
      { label: S.newTerminal, icon: 'plus', onClick: () => newTerminal() },
      { label: S.actionDuplicate, icon: 'copy', onClick: () => duplicateCurrent() },
      presets.length > 0
        ? { label: S.presetStart, icon: 'bookmark', onClick: () => choosePreset(anchor) }
        : null,
      { divider: true },
      { label: S.renameTerminal, icon: 'tag', onClick: () => s && renameTab(s) },
      { label: pinned ? S.actionUnpin : S.actionPin, icon: 'bookmark', onClick: () => s && app.settings.togglePinnedTerminal(agentId, s.sessionId) },
      { label: S.terminalThemeTitle, icon: 'moon_star', onClick: () => chooseTheme() },
      { divider: true },
      filesOk ? { label: S.browseFilesHere, icon: 'folder', onClick: () => browseFilesHere() } : null,
      { label: S.saveTranscript, icon: 'save', onClick: () => saveTranscript() },
      { label: S.copyTranscript, icon: 'copy', onClick: () => copyTranscript() },
      broadcasting
        ? { label: S.broadcastStopMenu, icon: 'radio', onClick: () => stopBroadcast(true) }
        : { label: S.broadcastInput, icon: 'radio', onClick: () => chooseBroadcast() },
      s?.textWatch
        ? { label: S.watchStop, icon: 'bell', onClick: () => app.notifier.stopWatch(s) }
        : { label: S.watchForText, icon: 'bell', onClick: () => watchForText() },
      s?.quietWatch
        ? { label: S.notifyQuietStop, icon: 'bell_ring', onClick: () => toggleQuietWatch() }
        : { label: S.notifyQuiet, icon: 'bell_ring', onClick: () => toggleQuietWatch() },
      { divider: true },
      { label: S.shortcuts, icon: 'command', onClick: () => showShortcuts() },
      { label: S.paste, icon: 'save', onClick: () => paste() },
      { label: S.pasteImage, icon: 'camera', onClick: () => pasteImage() },
      { label: S.pasteFile, icon: 'folder_open', onClick: () => pasteFile() },
      { label: S.attachFile, icon: 'package', onClick: () => attachFile() },
      { divider: true },
      { label: S.selectAll, icon: 'check', onClick: () => view.selectAll() },
      { label: S.clearTerminal, icon: 'close', onClick: () => { view.emulator.clearScreen(); view.notifyUpdated(); } },
      {
        label: S.commandBar,
        icon: 'command',
        checked: !commandBar.classList.contains('hidden'),
        onClick: () => { app.settings.commandBar = commandBar.classList.contains('hidden'); },
      },
      {
        label: S.keyRowsToggle,
        icon: 'keyboard',
        checked: !keyRows.classList.contains('hidden'),
        onClick: () => { app.settings.showExtraKeys = keyRows.classList.contains('hidden'); },
      },
      { divider: true },
      { label: S.tabClose, icon: 'close', danger: true, onClick: () => s && confirmClose(s) },
    ]);
  }

  /**
   * Another terminal beside this one, in the same directory. The open tab is
   * the freshest source for where the shell is; the relay's copy is the
   * fallback for a tab this device only just restored.
   */
  function duplicateCurrent() {
    const s = current;
    const agent = app.agents.agent(agentId);
    if (!s || !agent) return;
    const info = app.agents.session(agentId, s.sessionId) ?? {
      sessionId: s.sessionId, title: s.title, shell: s.shell, state: s.state,
      createdAt: 0, lastActiveAt: 0, cols: 0, rows: 0, seq: 0, attached: 0,
      exitCode: s.exitCode, cwd: s.cwd,
    };
    duplicateTerminal(app, agent, info);
  }

  /** Start one of the saved presets on this machine, without leaving the terminal. */
  function choosePreset(anchor) {
    const presets = app.settings.presetsFor(agentId);
    if (presets.length === 0) { app.openPresets(); return; }
    menu(anchor, [
      ...presets.map((preset) => ({
        label: preset.name,
        icon: 'bookmark',
        onClick: () => launchPreset(app, preset, agentId),
      })),
      { divider: true },
      { label: S.presetsManage, icon: 'settings', onClick: () => app.openPresets() },
    ]);
  }

  /**
   * The shortcuts sheet: common control keys and the user's own commands.
   * Every entry needs a deliberate click; nothing is sent on open.
   */
  function showShortcuts() {
    customDialog({
      title: S.shortcuts,
      build: (done) => el('div', null,
        el('div.section-label', { text: S.shortcutsKeys }),
        el('div.chip-row', null, SHORTCUT_KEYS.map((spec) => {
          const bytes = Keys.shortcut(spec);
          if (!bytes) return null;
          return el('button.chip', {
            onClick: () => { done(true); view.sendRaw(bytes); view.focus(); },
          }, el('span', { text: spec }));
        })),
        el('div.section-label', { text: S.shortcutsCommands }),
        el('div.chip-row', null, app.settings.commandShortcuts.map(([label, command]) =>
          el('button.chip', {
            onClick: () => {
              done(true);
              app.settings.noteCommand(command);
              view.sendRaw(`${command}\r`);
              view.focus();
            },
          }, el('span', { text: label })))),
        el('p', { text: S.shortcutsCommandsHint, style: { marginTop: '10px' } })),
      actions: [{ label: S.cancel, value: null }],
    });
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function onTabs(changedAgentId) {
    // A broadcast whose source or targets closed shrinks or ends with them.
    const b = app.broadcast;
    if (b) {
      for (const key of [...b.targets]) if (!app.sessions.sessions.has(key)) b.targets.delete(key);
      if (!app.sessions.sessions.has(b.sourceKey) || b.targets.size === 0) stopBroadcast(true);
      else renderBroadcast();
    }
    if (changedAgentId !== agentId) return;
    tabs = app.sessions.tabs(agentId);
    for (const s of tabs) bindUnread(s);
    if (!current || !tabs.includes(current)) chooseInitialTab();
    else renderTabs();
  }

  /** Tabs that are not visible count their rows for the badge. */
  function bindUnread(s) {
    if (s.unreadBound) return;
    s.unreadBound = true;
    screen.track(s.on('output', () => {
      if (s === current) return;
      s.unreadRows++;
      renderTabs();
    }));
  }

  async function createSession(shell) {
    if (creating) return;
    creating = true;
    updateStatus();
    const result = await app.sessions.create(agentId, shell ?? null, view.cols, view.rows, null);
    creating = false;
    if (result.ok) selectTab(result.session);
    else {
      updateStatus();
      toast(result.error, { error: true });
      if (tabs.length === 0) app.back();
    }
  }

  screen.listen(app.sessions, 'tabs', onTabs);
  screen.listen(app.settings, 'changed', () => { applySettings(); renderTabs(); });
  screen.listen(app.client, 'state', () => updateStatus());
  screen.listen(app.agents, 'agents', () => {
    if (!app.agents.agent(agentId)) { app.back(); return; }
    updateStatus();
  });
  // The footer clock has to move on its own; nothing else ticks.
  screen.every(30_000, () => updateStatus());

  applySettings();
  tabs = app.sessions.tabs(agentId);
  for (const s of tabs) bindUnread(s);
  chooseInitialTab();
  updateStatus();
  requestAnimationFrame(() => { view.recomputeGeometry(); view.focus(); });

  screen.root = root;
  screen.onSettingsChanged = () => applySettings();
  screen.createSession = createSession;
  return screen;
}
