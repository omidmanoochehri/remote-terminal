/**
 * Start a terminal. The relay only takes a shell, a size and a title, so the
 * working directory and the optional start-up command are sent as the first
 * input to the new shell — visible in the scrollback, nothing hidden.
 *
 * The same form doubles as the preset editor: the fields are identical, so a
 * preset is simply this screen's answers kept for later.
 *
 * A port of `NewTerminalFragment.kt`.
 *
 * The layout is built once and only the parts that depend on live state are
 * refreshed: a machine's metrics arrive every few seconds, and a form that
 * rebuilt itself on each one would take the caret out of whatever the user was
 * typing — and could swallow a click that landed mid-rebuild.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, switchEl } from '../dom.js';
import { S } from '../strings.js';
import { shellQuote } from '../../core/shell.js';
import { menu, toast, promptDialog } from '../overlays.js';
import { presence, machineIcon } from '../../core/format.js';
import { makePreset, newPresetId } from '../../core/preset.js';

export function newTerminalScreen(app, { agentId: initialAgentId = null, presetId = null, presetMode = false }) {
  const screen = new Screen(app, presetMode ? S.presetsTitle : S.newTerminalTitle);

  const editing = presetId ? app.settings.preset(presetId) : null;

  let anyMachine = presetMode && editing != null && editing.agentId == null;
  let agentId = editing?.agentId ?? (anyMachine ? null : initialAgentId) ?? defaultAgent()?.agentId ?? null;
  let shell = null;
  /** Shell id carried by the preset being edited, until the machine offers it. */
  let pendingShellId = editing?.shellId ?? null;
  let creating = false;
  let advancedOpen = presetMode;

  /* -------------------------------- fields ------------------------------ */

  const nameInput = el('input', {
    type: 'text',
    placeholder: presetMode ? S.presetNameHint : S.fieldTerminalNameHint,
    value: editing?.name ?? '',
  });
  const shellInput = el('input', { type: 'text', readonly: true, value: '' });
  const directoryInput = el('input', { type: 'text', placeholder: S.workingDirectoryHint, value: editing?.directory ?? '' });
  const commandInput = el('input', { type: 'text', placeholder: S.fieldInitialCommandHint, value: editing?.command ?? '' });
  const scrollbackInput = el('input', {
    type: 'number', min: '500', max: '50000', value: String(app.settings.scrollbackLines),
  });

  const restoreSwitch = switchEl(true);
  const notifySwitch = switchEl(app.settings.notifyExit);

  const machineCard = el('button.card.machine-card', {
    style: { width: '100%', textAlign: 'left' },
    onClick: (e) => chooseMachine(e.currentTarget),
  });
  const shellField = field(S.fieldShell, 'terminal_square', shellInput, {
    asButton: true,
    trailing: el('span', { class: 'field-trailing' }, svgIcon('chevron_down')),
    onClick: (e) => chooseShell(e.currentTarget),
  });

  let advancedChevron = svgIcon('chevron_down');
  const advancedPanel = el('div', { style: { padding: '0 13px 12px' } },
    field(S.fieldInitialCommand, 'command', commandInput),
    field(S.fieldScrollback, 'history', scrollbackInput));
  const advancedToggle = el('button.settings-row', { onClick: () => toggleAdvanced() },
    el('div.icon-well', { style: { background: 'var(--surface-flat)', color: 'var(--text-muted)' } }, svgIcon('sliders')),
    el('div.settings-text', null, el('div.settings-title', { text: S.advancedOptions })),
    advancedChevron);

  const createIcon = el('span', { style: { display: 'flex' } });
  const createLabel = el('span');
  const createButton = el('button.cta', {
    onClick: () => (presetMode ? savePreset() : create()),
  }, createIcon, createLabel);

  /* -------------------------------- layout ------------------------------ */

  const body = el('div.screen-body.wide', null,
    el('div.section-label', { text: S.labelMachine }),
    machineCard,
    field(S.fieldTerminalName, 'tag', nameInput),
    shellField,
    field(S.fieldWorkingDirectory, 'folder_open', directoryInput, {
      trailing: el('button.field-trailing.action', {
        text: S.recentDirectories,
        onClick: (e) => { e.stopPropagation(); chooseDirectory(e.currentTarget); },
      }),
      help: S.workingDirectoryHelp,
    }),
    // Preset mode keeps the fields and drops everything that only makes sense
    // for a session starting right now. The start-up command is the point of a
    // preset, so there it is a plain field rather than something to go looking
    // for under Advanced.
    presetMode
      ? field(S.fieldInitialCommand, 'command', commandInput, { help: S.presetCommandHelp })
      : el('div.card', { style: { overflow: 'hidden', marginBottom: '14px' } }, advancedToggle, advancedPanel),
    presetMode ? null : el('div.section-label', { text: S.groupTerminal }),
    presetMode ? null : el('div.card', { style: { overflow: 'hidden' } },
      toggleRow(restoreSwitch, 'rotate_ccw', '--primary', S.toggleRestore, S.toggleRestoreDesc),
      el('div.divider'),
      toggleRow(notifySwitch, 'bell', '--accent', S.toggleNotify, S.toggleNotifyDesc)),
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '16px' } },
      createButton,
      presetMode ? null : el('button.button', { onClick: () => saveFormAsPreset() },
        svgIcon('bookmark'), el('span', { text: S.presetSaveAs }))));

  const root = el('div.screen', null,
    header({
      title: presetMode ? (editing ? S.presetEditTitle : S.presetNew) : S.newTerminalTitle,
      subtitle: presetMode ? S.presetSubtitle : S.newTerminalSubtitle,
      onBack: () => app.back(),
    }),
    body);

  function defaultAgent() {
    return app.agents.agents.find((a) => a.online) ?? app.agents.agents[0] ?? null;
  }

  function agent() {
    return agentId ? app.agents.agent(agentId) : null;
  }

  /* ------------------------------ components ---------------------------- */

  function field(label, iconName, input, { trailing = null, asButton = false, onClick = null, help = null } = {}) {
    return el('div.field', null,
      el('label.field-label', { text: label }),
      el(`div.field-well${asButton ? '.as-button' : ''}`, { onClick }, svgIcon(iconName), input, trailing),
      help ? el('div.field-error', { style: { color: 'var(--text-muted)' }, text: help }) : null);
  }

  function toggleRow(node, iconName, colorVar, title, description) {
    return el('button.toggle-row', {
      onClick: () => {
        const next = node.getAttribute('aria-checked') !== 'true';
        node.setAttribute('aria-checked', String(next));
      },
    },
    el('div.icon-well', {
      style: { background: `color-mix(in srgb, var(${colorVar}) 12%, transparent)`, color: `var(${colorVar})` },
    }, svgIcon(iconName)),
    el('div.settings-text', null,
      el('div.settings-title', { text: title }),
      el('div.settings-subtitle', { text: description })),
    node);
  }

  function toggleAdvanced() {
    advancedOpen = !advancedOpen;
    advancedPanel.classList.toggle('hidden', !advancedOpen);
    const next = svgIcon(advancedOpen ? 'chevron_up' : 'chevron_down');
    advancedChevron.replaceWith(next);
    advancedChevron = next;
  }

  /* ------------------------------ live parts ---------------------------- */

  /** Only what depends on the machine list or the connection; never the fields. */
  function refresh() {
    renderMachineCard();
    renderCreateButton();
  }

  function renderMachineCard() {
    clear(machineCard);

    if (anyMachine) {
      machineCard.append(el('div.machine-head', null,
        el('div.tile', null, svgIcon('server')),
        el('div.machine-identity', null,
          el('div.machine-name', { text: S.presetAnyMachine }),
          el('div.machine-subtitle', { text: S.presetAnyMachineDesc })),
        svgIcon('chevron_down')));
      shellInput.value = S.presetDefaultShell;
      shellField.style.opacity = '0.6';
      return;
    }
    shellField.style.opacity = '1';

    const a = agent();
    if (!a) {
      machineCard.append(el('div.machine-head', null,
        el('div.tile', null, svgIcon('server')),
        el('div.machine-identity', null,
          el('div.machine-name', { text: S.chooseMachine }),
          el('div.machine-subtitle', { text: S.noOnlineMachines })),
        svgIcon('chevron_down')));
      shellInput.value = S.valueUnknown;
      return;
    }

    const { label, tone } = presence(a, app.client.state);
    const os = a.os || a.platform;
    machineCard.append(el('div.machine-head', null,
      el(`div.tile${a.online ? '.on' : ''}`, null, svgIcon(machineIcon(a))),
      el('div.machine-identity', null,
        el('div.machine-name', { text: a.name || a.hostname }),
        el('div.machine-status', null,
          el(`span.dot.tone-${tone}`),
          el('span', { class: `tone-${tone}`, text: os ? `${label} · ${os}` : label }))),
      svgIcon('chevron_down')));

    // Keep the chosen shell valid for the chosen machine; a preset being edited
    // gets its own shell back as soon as the machine reports it.
    if (!shell || !a.shells.some((s) => s.id === shell.id)) {
      shell = (pendingShellId ? a.shells.find((s) => s.id === pendingShellId) : null)
        ?? a.shells.find((s) => s.id === app.settings.lastShell(a.agentId))
        ?? a.shells.find((s) => s.isDefault)
        ?? a.shells[0]
        ?? null;
      if (shell && shell.id === pendingShellId) pendingShellId = null;
    }
    shellInput.value = shell?.label ?? S.valueUnknown;
  }

  function renderCreateButton() {
    const a = agent();
    // A preset can be written down for a machine that is not up yet.
    createButton.disabled = presetMode ? false : !(a && a.online && !creating);
    createIcon.replaceChildren(svgIcon(presetMode ? 'bookmark' : 'plus'));
    createLabel.textContent = presetMode ? S.presetSave : creating ? S.creatingTerminal : S.createTerminal;
  }

  /* ------------------------------- pickers ------------------------------ */

  function chooseMachine(anchor) {
    const machines = app.agents.agents;
    if (machines.length === 0 && !presetMode) { app.openAddMachine(); return; }
    menu(anchor, [
      ...machines.map((m) => ({
        label: m.online ? (m.name || m.hostname) : `${m.name || m.hostname}  (${S.machineOffline})`,
        icon: machineIcon(m),
        checked: !anyMachine && m.agentId === agentId,
        onClick: () => { anyMachine = false; agentId = m.agentId; shell = null; refresh(); },
      })),
      // A preset does not have to name a machine; then it asks when it runs.
      presetMode ? { divider: true } : null,
      presetMode
        ? { label: S.presetAnyMachine, icon: 'server', checked: anyMachine, onClick: () => { anyMachine = true; refresh(); } }
        : null,
    ]);
  }

  function chooseShell(anchor) {
    if (anyMachine) return;
    const a = agent();
    if (!a || a.shells.length === 0) return;
    menu(anchor, a.shells.map((s) => ({
      label: s.isDefault ? `${s.label}  (${S.shellDefault})` : s.label,
      checked: shell?.id === s.id,
      onClick: () => { shell = s; shellInput.value = s.label; },
    })));
  }

  function chooseDirectory(anchor) {
    const a = agent();
    if (!a) { toast(S.workingDirectoryHelp); return; }
    const recent = app.settings.recentDirectories(a.agentId);
    if (recent.length === 0) { toast(S.workingDirectoryHelp); return; }
    menu(anchor, recent.map((dir) => ({
      label: dir,
      icon: 'folder_open',
      onClick: () => { directoryInput.value = dir; },
    })));
  }

  /* ------------------------------- presets ------------------------------ */

  function formPreset(name) {
    return makePreset({
      id: presetId ?? newPresetId(),
      name,
      agentId: anyMachine ? null : agentId,
      shellId: anyMachine ? null : shell?.id ?? null,
      directory: directoryInput.value.trim(),
      command: commandInput.value.trim(),
    });
  }

  /** Preset mode: the main action saves and goes back. */
  function savePreset() {
    const name = nameInput.value.trim();
    if (!name) { toast(S.presetNeedsName, { error: true }); nameInput.focus(); return; }
    app.settings.savePreset(formPreset(name));
    toast(S.presetSaved(name));
    app.back();
  }

  /** Normal mode: keep this form as a preset without leaving the screen. */
  async function saveFormAsPreset() {
    let name = nameInput.value.trim();
    if (!name) {
      name = await promptDialog({ title: S.presetSaveAs, label: S.fieldTerminalName, placeholder: S.presetNameHint });
      if (!name) { toast(S.presetNeedsName, { error: true }); return; }
    }
    app.settings.savePreset(formPreset(name));
    toast(S.presetSaved(name));
  }

  /* -------------------------------- create ------------------------------ */

  async function create() {
    if (creating) return;
    const a = agent();
    if (!a) return;
    if (!a.online) { toast(S.agentOfflineHint, { error: true }); return; }

    const title = nameInput.value.trim() || null;
    const directory = directoryInput.value.trim();
    const command = commandInput.value.trim();
    const scrollback = parseInt(scrollbackInput.value, 10);

    creating = true;
    renderCreateButton();
    // 80x24 is the protocol default; the terminal view resizes the PTY to the
    // real grid the moment it attaches.
    const result = await app.sessions.create(a.agentId, shell?.id ?? null, 80, 24, title);
    creating = false;
    if (!result.ok) { renderCreateButton(); toast(result.error, { error: true }); return; }

    const session = result.session;
    app.settings.setRestoreOnReconnect(session.key, restoreSwitch.getAttribute('aria-checked') === 'true');
    app.settings.setNotifyOnFinish(session.key, notifySwitch.getAttribute('aria-checked') === 'true');
    if (Number.isFinite(scrollback) && scrollback >= 500 && scrollback <= 50_000) {
      session.emulator.maxScrollback = scrollback;
    }
    // The shell is not attached yet, so the start-up lines are queued and
    // flushed by the session layer once it is.
    let startup = '';
    if (directory) {
      app.settings.noteDirectory(a.agentId, directory);
      session.noteDirectory(directory);
      startup += `cd ${shellQuote(directory)}\r`;
    }
    if (command) {
      app.settings.noteCommand(command);
      startup += `${command}\r`;
    }
    if (startup) app.sessions.queueStartupInput(session, startup);
    app.replace('terminal', { agentId: a.agentId, sessionId: session.sessionId });
  }

  screen.listen(app.agents, 'agents', refresh);
  screen.listen(app.client, 'state', refresh);

  if (!presetMode && !advancedOpen) advancedPanel.classList.add('hidden');
  refresh();
  setTimeout(() => nameInput.focus(), 0);

  screen.root = root;
  return screen;
}
