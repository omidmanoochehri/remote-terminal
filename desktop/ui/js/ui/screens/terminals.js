/**
 * Every terminal on the account, grouped by machine. Sessions live on the
 * agents, so this list is what the relay reports plus the tabs this device
 * happens to have open — nothing is invented locally.
 *
 * A port of `AllTerminalsFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard, badge, debounce } from '../dom.js';
import { S } from '../strings.js';
import { menu } from '../overlays.js';
import { terminalMenu } from '../actions.js';
import { ConnectionState } from '../../core/relay.js';
import {
  presence, terminalTitle, terminalMeta, connectionLabel, connectionTone, isSecureRelay,
} from '../../core/format.js';
import { isRunning } from '../../protocol/messages.js';

const FILTER_ALL = 'all';
const FILTER_ACTIVE = 'active';
const FILTER_DETACHED = 'detached';
const FILTER_PINNED = 'pinned';

export function terminalsScreen(app) {
  const screen = new Screen(app, S.navTerminals);

  let query = '';
  let filter = FILTER_ALL;

  const searchInput = el('input', {
    type: 'search',
    placeholder: S.terminalsSearchHint,
    'aria-label': S.terminalsSearchHint,
  });
  const chipRow = el('div.chip-row');
  const list = el('div');
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
      title: S.navTerminals,
      subtitle: S.terminalsSubtitle,
      mark: 'terminal_square',
      actions: [
        headerAction('search', S.search, () => searchInput.focus()),
        headerAction('refresh', S.refresh, () => refresh()),
        headerAction('more', S.more, (e) => menu(e.currentTarget, [
          { label: S.newTerminal, icon: 'plus', onClick: () => app.openNewTerminal(null) },
          { label: S.navMachines, icon: 'monitor', onClick: () => app.openMachines() },
        ])),
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

  function renderFilters(all) {
    const active = all.filter(({ session }) => isRunning(session) && session.attached > 0).length;
    const detached = all.filter(({ session }) => isRunning(session) && session.attached === 0).length;
    clear(chipRow);
    const chip = (id, label, count) => el('button.chip', {
      'aria-pressed': String(filter === id),
      onClick: () => { filter = id; render(); },
    }, el('span', { text: count == null ? label : `${label}  ${count}` }));
    chipRow.append(
      chip(FILTER_ALL, S.filterAll, all.length),
      chip(FILTER_ACTIVE, S.filterActive, active),
      chip(FILTER_DETACHED, S.filterDetached, detached),
      chip(FILTER_PINNED, S.filterPinned));
  }

  /** Machines with at least one matching terminal, in presence-then-name order. */
  function buildGroups() {
    const needle = query.trim().toLowerCase();
    const pinned = app.settings.pinnedTerminals;
    const groups = [];
    const agents = [...app.agents.agents].sort(
      (a, b) => Number(b.online) - Number(a.online) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const agent of agents) {
      let sessions = agent.sessions;
      if (needle) {
        sessions = sessions.filter((s) =>
          s.title.toLowerCase().includes(needle) ||
          s.shell.toLowerCase().includes(needle) ||
          agent.name.toLowerCase().includes(needle));
      }
      if (filter === FILTER_ACTIVE) sessions = sessions.filter((s) => isRunning(s) && s.attached > 0);
      else if (filter === FILTER_DETACHED) sessions = sessions.filter((s) => isRunning(s) && s.attached === 0);
      else if (filter === FILTER_PINNED) sessions = sessions.filter((s) => pinned.has(`${agent.agentId}|${s.sessionId}`));
      if (sessions.length === 0) continue;
      groups.push({
        agent,
        sessions: [...sessions].sort((a, b) =>
          Number(pinned.has(`${agent.agentId}|${b.sessionId}`)) - Number(pinned.has(`${agent.agentId}|${a.sessionId}`)) ||
          Math.max(b.lastActiveAt, b.createdAt) - Math.max(a.lastActiveAt, a.createdAt)),
      });
    }
    return groups;
  }

  function render() {
    const state = app.client.state;
    const all = app.agents.allSessions();
    renderFilters(all);
    const groups = buildGroups();
    clear(list);

    if (state.name !== ConnectionState.CONNECTED) {
      list.append(el('div.banner', null,
        el(`span.dot.tone-${connectionTone(state)}`),
        el('span', { text: connectionLabel(state) }),
        el('button.link-button', { text: S.retryNow, onClick: refresh })));
    }

    if (groups.length > 0) {
      for (const { agent, sessions } of groups) {
        const { label, tone } = presence(agent, state);
        list.append(el('button.group-header', { onClick: () => app.openMachine(agent.agentId) },
          el(`span.dot.tone-${tone}`),
          el('span.group-name', { text: agent.name || agent.hostname }),
          el('span', { class: `group-status tone-${tone}`, text: label }),
          el('span', { class: 'spacer' }),
          svgIcon('chevron_right')));
        list.append(rowsCard(sessions.map((session) => terminalRow(agent, session))));
      }
      // The security footnote the phone shows under the list.
      const secure = isSecureRelay(app.credentials.relayUrl);
      list.append(el('div.note', null,
        el('div.note-well', {
          style: secure
            ? { background: 'var(--primary-soft)', color: 'var(--primary)' }
            : { background: 'var(--amber-soft)', color: 'var(--status-warn)' },
        }, svgIcon(secure ? 'shield' : 'alert')),
        el('div', null,
          el('div.note-title', { text: secure ? S.terminalsEncryptedTitle : S.terminalsInsecureTitle }),
          el('div.note-body', { text: secure ? S.terminalsEncryptedBody : S.terminalsInsecureBody }))));
      return;
    }

    if (query) {
      list.append(stateBlock({
        icon: 'search',
        title: S.emptySearchTitle,
        body: S.emptySearchBody(query),
        actionLabel: S.clearSearch,
        actionIcon: 'close',
        onAction: () => { searchInput.value = ''; query = ''; render(); },
      }));
    } else if (all.length > 0) {
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
        icon: 'terminal_square',
        title: S.emptyTerminalsTitle,
        body: S.emptyTerminalsBody,
        actionLabel: S.newTerminal,
        onAction: () => app.openNewTerminal(null),
      }));
    }
  }

  function terminalRow(agent, session) {
    const pinned = app.settings.isPinnedTerminal(agent.agentId, session.sessionId);
    return el('div', { style: { display: 'flex', alignItems: 'center' } },
      el('button.row-item', {
        onClick: () => app.openTerminal(agent.agentId, session.sessionId),
        title: `${terminalTitle(session)} · ${terminalMeta(session)}`,
      },
      el('div.row-text', null,
        el('div.row-title', null,
          el('span', { text: terminalTitle(session) }),
          pinned ? svgIcon('bookmark') : null),
        el('div.row-meta', { text: terminalMeta(session) })),
      session.attached > 0 ? badge(S.badgeActive) : null,
      agent.online && isRunning(session)
        ? el('span.badge.neutral', { text: S.open })
        : null),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => terminalMenu(app, e.currentTarget, agent, session))));
  }

  screen.listen(app.agents, 'agents', render);
  screen.listen(app.settings, 'changed', render);
  screen.listen(app.client, 'state', render);
  screen.every(30_000, render);

  render();
  if (app.client.isConnected) app.agents.refresh();

  screen.root = root;
  return screen;
}
