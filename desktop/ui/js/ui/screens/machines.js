/**
 * The machines list: search, presence filters, a sort you choose, and one card
 * per machine carrying the facts that decide whether you can work on it right
 * now (terminals, agent version, latency) plus a single primary action.
 *
 * A port of `MachinesFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, debounce } from '../dom.js';
import { S } from '../strings.js';
import { menu, alertDialog } from '../overlays.js';
import { machineMenu } from '../actions.js';
import { ConnectionState } from '../../core/relay.js';
import { SORT_NAME, SORT_RECENT, SORT_STATUS } from '../../core/settings.js';
import {
  presenceDetail, machineSubtitleFull, machineIcon, connectionLabel, connectionTone, duration,
} from '../../core/format.js';
import { runningSessions, isRunning } from '../../protocol/messages.js';

const FILTER_ALL = 'all';
const FILTER_ONLINE = 'online';
const FILTER_OFFLINE = 'offline';

export function machinesScreen(app) {
  const screen = new Screen(app, S.navMachines);

  let query = '';
  let filter = FILTER_ALL;
  let everLoaded = false;

  const searchInput = el('input', {
    type: 'search',
    placeholder: S.machinesSearchHint,
    'aria-label': S.machinesSearchHint,
  });
  const list = el('div');
  const chipRow = el('div.chip-row');
  const body = el('div.screen-body.wide', null,
    el('div.search-bar', null, svgIcon('search'), searchInput,
      el('button.icon-button.small', {
        title: S.clearSearch,
        onClick: () => { searchInput.value = ''; query = ''; render(); },
      }, svgIcon('close'))),
    chipRow,
    list);

  const root = el('div.screen', null,
    header({
      title: S.navMachines,
      subtitle: S.machinesSubtitle,
      mark: 'monitor',
      actions: [
        headerAction('search', S.search, () => searchInput.focus()),
        headerAction('refresh', S.refresh, () => refresh()),
        headerAction('more', S.more, (e) => overflow(e.currentTarget)),
      ],
    }),
    body);

  const refresh = () => {
    app.agents.refresh();
    app.client.reconnectNow('user');
  };

  searchInput.addEventListener('input', debounce(() => {
    query = searchInput.value;
    render();
  }, 90));

  function overflow(anchor) {
    menu(anchor, [
      { label: S.machinesAddNew, icon: 'plus', onClick: () => app.openAddMachine() },
      { label: S.settingPairedDevices, icon: 'phone', onClick: () => app.openDevices() },
      { label: S.machinesEmptyAction, icon: 'info', onClick: () => alertDialog(S.machinesEmptyAction, S.machinesHelp) },
    ]);
  }

  function sortMenu(anchor) {
    const current = app.settings.machineSort;
    menu(anchor, [
      { label: S.sortStatus, checked: current === SORT_STATUS, onClick: () => { app.settings.machineSort = SORT_STATUS; render(); } },
      { label: S.sortName, checked: current === SORT_NAME, onClick: () => { app.settings.machineSort = SORT_NAME; render(); } },
      { label: S.sortRecent, checked: current === SORT_RECENT, onClick: () => { app.settings.machineSort = SORT_RECENT; render(); } },
    ]);
  }

  function renderFilters(agents) {
    const online = agents.filter((a) => a.online).length;
    clear(chipRow);
    const chip = (id, label, count) => el('button.chip', {
      'aria-pressed': String(filter === id),
      onClick: () => { filter = id; render(); },
    }, el('span', { text: count == null ? label : `${label}  ${count}` }));
    chipRow.append(
      chip(FILTER_ALL, S.filterAll, agents.length),
      chip(FILTER_ONLINE, S.filterOnline, online),
      chip(FILTER_OFFLINE, S.filterOffline, agents.length - online),
      el('button.chip', { onClick: (e) => sortMenu(e.currentTarget) },
        svgIcon('sliders'), el('span', { text: S.filterFilters })));
  }

  function visibleMachines(agents) {
    const needle = query.trim().toLowerCase();
    const favourites = app.settings.favouriteMachines;
    let out = agents;
    if (needle) {
      out = out.filter((a) =>
        a.name.toLowerCase().includes(needle) ||
        a.hostname.toLowerCase().includes(needle) ||
        a.os.toLowerCase().includes(needle) ||
        a.platform.toLowerCase().includes(needle));
    }
    if (filter === FILTER_ONLINE) out = out.filter((a) => a.online);
    else if (filter === FILTER_OFFLINE) out = out.filter((a) => !a.online);

    const bySort = (a, b) => {
      switch (app.settings.machineSort) {
        case SORT_NAME: return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        case SORT_RECENT: return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
        default:
          return Number(b.online) - Number(a.online) || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }
    };
    return [...out].sort((a, b) =>
      Number(favourites.has(b.agentId)) - Number(favourites.has(a.agentId)) || bySort(a, b));
  }

  function render() {
    const agents = app.agents.agents;
    const state = app.client.state;
    if (state.name === ConnectionState.CONNECTED) everLoaded = true;

    renderFilters(agents);
    const visible = visibleMachines(agents);
    clear(list);

    if (state.name !== ConnectionState.CONNECTED) {
      list.append(el('div.banner', null,
        el(`span.dot.tone-${connectionTone(state)}`),
        el('span', { text: connectionLabel(state) }),
        el('button.link-button', { text: S.retryNow, onClick: refresh })));
    }

    const loading = agents.length === 0 && !everLoaded &&
      (state.name === ConnectionState.CONNECTING || state.name === ConnectionState.DISCONNECTED);

    if (loading) {
      list.append(stateBlock({ icon: 'refresh', title: S.stateConnecting, body: S.offlineBody }));
    } else if (visible.length > 0) {
      for (const agent of visible) list.append(machineCard(agent, state));
      list.append(el('button.button', {
        onClick: () => app.openAddMachine(),
        style: { marginTop: '6px' },
      }, svgIcon('plus'), el('span', { text: S.machinesAddNew })));
    } else if (query) {
      list.append(stateBlock({
        icon: 'search',
        title: S.emptySearchTitle,
        body: S.emptySearchBody(query),
        actionLabel: S.clearSearch,
        actionIcon: 'close',
        onAction: () => { searchInput.value = ''; query = ''; render(); },
      }));
    } else if (agents.length > 0) {
      list.append(stateBlock({
        icon: 'sliders',
        title: S.emptyFilterTitle,
        body: S.emptyFilterBody,
        actionLabel: S.filterAll,
        actionIcon: 'check',
        onAction: () => { filter = FILTER_ALL; render(); },
      }));
    } else if (state.name !== ConnectionState.CONNECTED) {
      list.append(stateBlock({
        icon: 'wifi_off',
        title: S.offlineTitle,
        body: S.offlineBody,
        actionLabel: S.retryNow,
        actionIcon: 'refresh',
        onAction: refresh,
      }));
    } else {
      list.append(stateBlock({
        icon: 'monitor',
        title: S.emptyMachinesTitle,
        body: S.emptyMachinesBody,
        actionLabel: S.machinesAddNew,
        onAction: () => app.openAddMachine(),
      }));
    }
  }

  function machineCard(agent, state) {
    const { label, tone } = presenceDetail(agent, state);
    const favourite = app.settings.isFavouriteMachine(agent.agentId);
    const latency = app.client.latencyMs;

    const third = agent.online
      ? statBox(S.statLatency, latency != null ? S.statLatencyMs(latency) : S.valueUnknown, latency != null ? 'var(--primary)' : 'var(--text-muted)')
      : statBox(S.statUptime, agent.metrics.uptimeSec != null ? duration(agent.metrics.uptimeSec) : S.valueUnknown);

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
          el('span', { class: `tone-${tone}`, text: label }))),
        headerAction('more', S.more, (e) => machineMenu(app, e.currentTarget, agent))),
      el('div.stat-row', null,
        statBox(S.statTerminals, S.statActiveCount(runningSessions(agent))),
        statBox(S.statAgent, agent.agentVersion ? S.statVersion(agent.agentVersion) : S.valueUnknown),
        third),
      agent.online
        ? el('button.cta', { onClick: () => connect(agent) },
          svgIcon('terminal_square'), el('span', { text: S.actionConnect }))
        : el('button.cta', { disabled: true },
          svgIcon('wifi_off'), el('span', { text: S.actionUnavailable })));
  }

  function statBox(caption, value, color) {
    return el('div.stat-box', null,
      el('div.stat-caption', { text: caption }),
      el('div.stat-value', { text: value, style: color ? { color } : null }));
  }

  /** The primary action: resume the newest terminal, or start the first one. */
  function connect(agent) {
    const session = agent.sessions.filter(isRunning).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (session) app.openTerminal(agent.agentId, session.sessionId);
    else app.openNewTerminal(agent.agentId);
  }

  screen.listen(app.agents, 'agents', render);
  screen.listen(app.settings, 'changed', render);
  screen.listen(app.client, 'state', render);
  screen.listen(app.client, 'latency', render);
  screen.every(30_000, render);

  render();
  if (app.client.isConnected) app.agents.refresh();

  screen.root = root;
  return screen;
}
