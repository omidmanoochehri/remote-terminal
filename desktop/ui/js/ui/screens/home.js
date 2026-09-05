/**
 * Home. The machines you actually use (favourites first, then the ones with
 * running terminals), the terminals you left behind, and four counts that lead
 * into the rest of the app. Everything here is live account state; there is no
 * separate cache to go stale.
 *
 * A port of `HomeFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, presenceLine, stateBlock, rowsCard, badge } from '../dom.js';
import { S } from '../strings.js';
import { menu, alertDialog } from '../overlays.js';
import { machineMenu, terminalMenu } from '../actions.js';
import { ConnectionState } from '../../core/relay.js';
import {
  presence, machineSubtitleFull, machineIcon, terminalTitle, terminalMeta, connectionLabel,
  connectionTone, formatCount,
} from '../../core/format.js';
import { runningSessions, isRunning } from '../../protocol/messages.js';

/** Home never becomes a wall of cards; the Machines tab is one click away. */
const MAX_MACHINES = 3;
const MAX_TERMINALS = 3;
/** "Recent" on the quick-access row means "used in the last day". */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function homeScreen(app) {
  const screen = new Screen(app, S.appName);
  const body = el('div.screen-body.wide');

  const root = el('div.screen', null,
    header({
      title: S.appName,
      subtitle: S.appTagline,
      actions: [
        headerAction('search', S.search, () => app.openMachines()),
        headerAction('refresh', S.refresh, () => refresh()),
        headerAction('more', S.more, (e) => overflow(e.currentTarget)),
      ],
    }),
    body);

  const refresh = () => {
    app.agents.refresh();
    app.client.reconnectNow('user');
  };

  const overflow = (anchor) => menu(anchor, [
    { label: S.settingPairedDevices, icon: 'phone', onClick: () => app.openDevices() },
    { label: S.navSettings, icon: 'settings', onClick: () => app.openSettings() },
    { label: S.machinesEmptyAction, icon: 'info', onClick: () => alertDialog(S.machinesEmptyAction, S.machinesHelp) },
  ]);

  function render() {
    const agents = app.agents.agents;
    const state = app.client.state;
    const favourites = app.settings.favouriteMachines;

    clear(body);

    if (state.name !== ConnectionState.CONNECTED) {
      body.append(el('div.banner', null,
        el(`span.dot.tone-${connectionTone(state)}`),
        el('span', { text: connectionLabel(state) }),
        el('button.link-button', { text: S.retryNow, onClick: refresh })));
    }

    // Machines: favourites, then the ones that are up and busy.
    const ordered = [...agents].sort((a, b) =>
      Number(favourites.has(b.agentId)) - Number(favourites.has(a.agentId)) ||
      Number(b.online) - Number(a.online) ||
      runningSessions(b) - runningSessions(a) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    body.append(el('div.section-head', null,
      el('h2', { text: S.navMachines }),
      agents.length > 0 ? el('button.link-button', { text: S.homeViewAll, onClick: () => app.openMachines() }) : null));

    if (agents.length === 0) {
      body.append(state.name === ConnectionState.CONNECTED
        ? stateBlock({
          icon: 'monitor',
          title: S.emptyMachinesTitle,
          body: S.emptyMachinesBody,
          actionLabel: S.machinesAddNew,
          onAction: () => app.openAddMachine(),
        })
        : stateBlock({
          icon: 'wifi_off',
          title: S.offlineTitle,
          body: S.offlineBody,
          actionLabel: S.retryNow,
          actionIcon: 'refresh',
          onAction: refresh,
        }));
    } else {
      for (const agent of ordered.slice(0, MAX_MACHINES)) body.append(machineCard(agent, state));
      body.append(el('button.button', {
        onClick: () => app.openAddMachine(),
        style: { marginTop: '4px' },
      }, svgIcon('plus'), el('span', { text: S.homeAddMachine })));
    }

    // Terminals you left behind.
    const pinned = app.settings.pinnedTerminals;
    const recent = app.agents.allSessions()
      .sort((a, b) =>
        Number(pinned.has(`${b.agent.agentId}|${b.session.sessionId}`)) -
          Number(pinned.has(`${a.agent.agentId}|${a.session.sessionId}`)) ||
        Math.max(b.session.lastActiveAt, b.session.createdAt) - Math.max(a.session.lastActiveAt, a.session.createdAt))
      .slice(0, MAX_TERMINALS);

    body.append(el('div.section-head', null,
      el('h2', { text: S.homeRecentTerminals }),
      el('button.link-button', { text: S.homeViewAll, onClick: () => app.openTerminalsTab() })));

    if (recent.length === 0) {
      body.append(el('div.note', null,
        el('div.note-well', { style: { background: 'var(--accent-soft)', color: 'var(--accent)' } }, svgIcon('terminal_square')),
        el('div', null,
          el('div.note-title', { text: S.emptyTerminalsTitle }),
          el('div.note-body', { text: S.emptyTerminalsBody }))));
    } else {
      body.append(rowsCard(recent.map(({ agent, session }) => terminalRow(agent, session))));
    }

    // Four counts that lead into the rest of the app.
    body.append(el('div.section-head', null, el('h2', { text: S.homeQuickAccess })));
    const terminals = agents.reduce((n, a) => n + runningSessions(a), 0);
    const recentCount = agents.reduce(
      (n, a) => n + a.sessions.filter((s) => Date.now() - Math.max(s.lastActiveAt, s.createdAt) < RECENT_WINDOW_MS).length,
      0);
    body.append(el('div.quick-tiles', null,
      quickTile('server_cog', '--purple', formatCount(agents.length), S.navMachines, () => app.openMachines()),
      quickTile('terminal_square', '--accent', formatCount(terminals), S.navTerminals, () => app.openTerminalsTab()),
      quickTile('clock', '--amber', formatCount(recentCount), S.quickRecent, () => app.openTerminalsTab()),
      quickTile('heart', '--danger', formatCount(favourites.size), S.quickFavourites, () => app.openMachines())));

    // The tips card, as on the phone: one hint, one place to read more.
    body.append(el('button.note', { onClick: () => alertDialog(S.tipsHelpTitle, S.tipsHelpBody), style: { width: '100%', textAlign: 'left' } },
      el('div.note-well', { style: { background: 'var(--amber-soft)', color: 'var(--amber)' } }, svgIcon('lightbulb')),
      el('div', null,
        el('div.note-title', { text: S.tipsTitle }),
        el('div.note-body', { text: S.tipsBody }))));
  }

  function machineCard(agent, state) {
    const { label, tone } = presence(agent, state);
    const running = runningSessions(agent);
    const favourite = app.settings.isFavouriteMachine(agent.agentId);

    return el('div.card.machine-card', null,
      el('div.machine-head', null,
        el(`div.tile${agent.online ? '.on' : ''}`, null, svgIcon(machineIcon(agent))),
        el('div.machine-identity', {
          onClick: () => app.openMachine(agent.agentId),
          role: 'button',
          tabindex: '0',
        },
        el('div.machine-name', null,
          el('span', { text: agent.name || agent.hostname }),
          favourite ? svgIcon('star') : null),
        el('div.machine-subtitle', { text: machineSubtitleFull(agent) }),
        el('div.machine-status', null,
          el(`span.dot.tone-${tone}`),
          el('span', { class: `tone-${tone}`, text: label }),
          running > 0 ? el('span', { class: 'tone-offline', text: '·' }) : null,
          running > 0 ? el('span', { class: 'tone-offline', text: S.machineSessions(running) }) : null)),
        headerAction('more', S.more, (e) => machineMenu(app, e.currentTarget, agent))),
      el('div.quick-actions', null,
        quickAction('terminal_square', S.actionConnect, agent.online, () => connect(agent)),
        quickAction('panel_top', S.actionTerminals, true, () => app.openMachine(agent.agentId, 'terminals')),
        quickAction('info', S.actionDetails, true, () => app.openMachine(agent.agentId, 'details')),
        quickAction('settings', S.actionSettings, true, () => app.openMachineSettings(agent.agentId))));
  }

  function quickAction(iconName, label, enabled, onClick) {
    return el('button.quick-action', {
      disabled: !enabled,
      onClick: () => enabled && onClick(),
      title: label,
    }, svgIcon(iconName), el('span', { text: label }));
  }

  function quickTile(iconName, colorVar, value, label, onClick) {
    return el('button.quick-tile', { onClick, title: label },
      el('span', { style: { color: `var(${colorVar})` } }, svgIcon(iconName)),
      el('span.quick-value', { text: value }),
      el('span.quick-label', { text: label }));
  }

  function terminalRow(agent, session) {
    const open = app.sessions.find(agent.agentId, session.sessionId) != null;
    const pinned = app.settings.isPinnedTerminal(agent.agentId, session.sessionId);
    return el('div', { style: { display: 'flex', alignItems: 'center' } },
      el('button.row-item', {
        onClick: () => app.openTerminal(agent.agentId, session.sessionId),
        title: `${terminalTitle(session)} · ${agent.name}`,
      },
      el('div.row-text', null,
        el('div.row-title', null,
          el('span', { text: terminalTitle(session) }),
          pinned ? svgIcon('bookmark') : null),
        el('div.row-meta', { text: `${agent.name || agent.hostname} • ${terminalMeta(session)}` })),
      session.attached > 0 ? badge(S.badgeActive) : open ? badge(S.badgeOpen, true) : null),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => terminalMenu(app, e.currentTarget, agent, session))));
  }

  /** "Connect" opens the terminal you used last, or starts one if there is none. */
  function connect(agent) {
    if (!agent.online) return;
    const session = agent.sessions.filter(isRunning).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (session) app.openTerminal(agent.agentId, session.sessionId);
    else app.openNewTerminal(agent.agentId);
  }

  screen.listen(app.agents, 'agents', render);
  screen.listen(app.settings, 'changed', render);
  screen.listen(app.client, 'state', render);
  // The reconnect count-down and the "last seen" ages have to move on their own.
  screen.every(30_000, render);

  render();
  if (app.client.isConnected) app.agents.refresh();

  screen.root = root;
  return screen;
}
