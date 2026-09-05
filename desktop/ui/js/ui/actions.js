/**
 * The menus and confirmations a machine or a terminal offers, in one place, so
 * "remove" and "terminate" always warn about the same consequences wherever
 * they are opened from. Ports of `MachineActions.kt`, `TerminalActions.kt` and
 * `TerminalStarter.kt`.
 */

import { menu, confirmDialog, promptDialog, toast, chooseDialog } from './overlays.js';
import { S } from './strings.js';
import { system } from '../core/platform.js';
import { terminalTitle } from '../core/format.js';
import { copyTitle } from '../core/naming.js';
import { isRunning } from '../protocol/messages.js';
import { Outgoing } from '../protocol/messages.js';
import { shellQuote } from '../core/shell.js';

export async function copyToClipboard(text) {
  if (!text) return;
  try {
    await system.clipboardWriteText(text);
    toast(S.copied);
  } catch (err) {
    toast(String(err?.message || err), { error: true });
  }
}

/* ------------------------------- machines -------------------------------- */

export function machineMenu(app, anchor, agent) {
  const favourite = app.settings.isFavouriteMachine(agent.agentId);
  menu(anchor, [
    {
      label: favourite ? S.actionUnfavourite : S.actionFavourite,
      icon: favourite ? 'heart' : 'star',
      onClick: () => app.settings.toggleFavouriteMachine(agent.agentId),
    },
    { label: S.actionTerminals, icon: 'panel_top', onClick: () => app.openMachine(agent.agentId, 'terminals') },
    { label: S.newTerminal, icon: 'plus', onClick: () => app.openNewTerminal(agent.agentId) },
    { label: S.actionDetails, icon: 'info', onClick: () => app.openMachine(agent.agentId, 'details') },
    { label: S.actionSettings, icon: 'settings', onClick: () => app.openMachineSettings(agent.agentId) },
    { divider: true },
    { label: S.renameMachine, icon: 'tag', onClick: () => renameMachine(app, agent) },
    { label: S.copyHostname, icon: 'copy', onClick: () => copyToClipboard(agent.hostname || agent.name) },
    { divider: true },
    { label: S.removeMachine, icon: 'trash', danger: true, onClick: () => confirmRemoveMachine(app, agent) },
  ]);
}

export async function renameMachine(app, agent) {
  const name = await promptDialog({
    title: S.renameMachine,
    label: S.fieldDisplayName,
    value: agent.name,
  });
  if (name) app.agents.renameAgent(agent.agentId, name);
}

export async function confirmRemoveMachine(app, agent, onRemoved) {
  const ok = await confirmDialog({
    title: S.removeMachine,
    body: S.removeMachineConfirm(agent.name),
    confirmLabel: S.remove,
    danger: true,
  });
  if (!ok) return;
  const favourites = app.settings.favouriteMachines;
  favourites.delete(agent.agentId);
  app.settings.favouriteMachines = favourites;
  app.agents.removeAgent(agent.agentId);
  onRemoved?.();
}

/* ------------------------------- terminals ------------------------------- */

export function terminalMenu(app, anchor, agent, session) {
  const pinned = app.settings.isPinnedTerminal(agent.agentId, session.sessionId);
  const openLocally = app.sessions.find(agent.agentId, session.sessionId) != null;
  menu(anchor, [
    { label: S.open, icon: 'terminal_square', onClick: () => app.openTerminal(agent.agentId, session.sessionId) },
    agent.online
      ? { label: S.actionDuplicate, icon: 'copy', onClick: () => duplicateTerminal(app, agent, session) }
      : null,
    { label: S.renameTerminal, icon: 'tag', onClick: () => renameTerminal(app, agent, session) },
    { label: pinned ? S.actionUnpin : S.actionPin, icon: 'bookmark', onClick: () => app.settings.togglePinnedTerminal(agent.agentId, session.sessionId) },
    openLocally || isRunning(session) ? { divider: true } : null,
    openLocally
      ? { label: S.confirmDisconnectAction, icon: 'wifi_off', onClick: () => confirmDisconnect(app, agent, session) }
      : null,
    isRunning(session)
      ? { label: S.tabTerminate, icon: 'trash', danger: true, onClick: () => confirmTerminate(app, agent, session) }
      : null,
  ]);
}

/**
 * Another terminal like this one. The open tab knows the freshest directory (a
 * shell that reports one keeps it live), so prefer it over the copy the relay
 * is holding.
 */
export function duplicateTerminal(app, agent, session) {
  const open = app.sessions.find(agent.agentId, session.sessionId);
  const cwd = open?.cwd || session.cwd;
  const taken = agent.sessions.map((s) => s.title);
  const title = copyTitle(session.title, taken);
  const shellId = agent.shells.some((s) => s.id === session.shell) ? session.shell : null;
  if (!cwd) toast(S.duplicateNoPath);
  startTerminal(app, agent, { shellId, title, directory: cwd, command: '' });
}

export async function renameTerminal(app, agent, session) {
  const title = await promptDialog({
    title: S.renameTerminal,
    label: S.fieldTerminalName,
    value: session.title,
  });
  if (!title) return;
  const open = app.sessions.find(agent.agentId, session.sessionId);
  if (open) app.sessions.rename(open, title);
  else app.client.send(Outgoing.sessionRename(agent.agentId, session.sessionId, title));
}

/** Close the local tab; the shell keeps running on the machine. */
export async function confirmDisconnect(app, agent, session) {
  const ok = await confirmDialog({
    title: S.confirmDisconnectTitle(terminalTitle(session)),
    body: S.confirmDisconnectBody,
    confirmLabel: S.confirmDisconnectAction,
  });
  if (!ok) return;
  const open = app.sessions.find(agent.agentId, session.sessionId);
  if (open) app.sessions.closeTab(open, false);
}

/** Kill the shell process and everything running in it. */
export async function confirmTerminate(app, agent, session) {
  const ok = await confirmDialog({
    title: S.tabCloseTitle(terminalTitle(session)),
    body: S.tabTerminateDesc,
    confirmLabel: S.tabTerminate,
    danger: true,
  });
  if (!ok) return;
  app.settings.forgetSessionPrefs(`${agent.agentId}|${session.sessionId}`);
  const open = app.sessions.find(agent.agentId, session.sessionId);
  if (open) app.sessions.closeTab(open, true);
  else app.client.send(Outgoing.sessionClose(agent.agentId, session.sessionId));
}

/* ------------------------------- starting -------------------------------- */

/**
 * Start a terminal that is described rather than typed: a saved preset, or a
 * copy of one that is already running.
 *
 * The relay only takes a shell, a size and a title, so the working directory
 * and the first command are sent as the first input to the new shell — exactly
 * what the New terminal screen does, visible in the scrollback rather than
 * hidden, and no protocol special case.
 */
export async function startTerminal(app, agent, { shellId, title, directory, command }) {
  if (!agent.online) { toast(S.agentOfflineHint, { error: true }); return null; }
  // 80x24 is the protocol default; the terminal view resizes the PTY to the
  // real grid the moment it attaches.
  const result = await app.sessions.create(agent.agentId, shellId ?? null, 80, 24, title || null);
  if (!result.ok) { toast(result.error, { error: true }); return null; }

  const session = result.session;
  let startup = '';
  if (directory) {
    app.settings.noteDirectory(agent.agentId, directory);
    // The shell has not run yet, so the tab already knows where it is about to
    // be even on platforms that cannot report it.
    session.noteDirectory(directory);
    startup += `cd ${shellQuote(directory)}\r`;
  }
  if (command) {
    app.settings.noteCommand(command);
    startup += `${command}\r`;
  }
  if (startup) app.sessions.queueStartupInput(session, startup);
  app.openTerminal(agent.agentId, session.sessionId);
  return session;
}

/** Start a preset, asking for a machine first when it does not name one. */
export async function launchPreset(app, preset, preferredAgentId = null) {
  let agentId = preset.agentId ?? preferredAgentId;
  if (!agentId) {
    const machines = app.agents.agents;
    if (machines.length === 0) { app.openAddMachine(); return; }
    if (machines.length === 1) agentId = machines[0].agentId;
    else {
      const chosen = await chooseDialog({
        title: S.chooseMachine,
        options: machines.map((m) => [
          m.agentId,
          m.name || m.hostname,
          m.online ? S.machineOnline : S.machineOffline,
        ]),
        selected: null,
      });
      if (!chosen) return;
      agentId = chosen;
    }
  }
  const agent = app.agents.agent(agentId);
  if (!agent) { toast(S.presetNoMachine, { error: true }); return; }
  const shellId = preset.shellId && agent.shells.some((s) => s.id === preset.shellId) ? preset.shellId : null;
  await startTerminal(app, agent, {
    shellId,
    title: preset.name,
    directory: preset.directory,
    command: preset.command,
  });
}
