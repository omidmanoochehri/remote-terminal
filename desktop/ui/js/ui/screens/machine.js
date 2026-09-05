/**
 * One machine, with its terminals and its details behind a segmented control.
 * The third segment (Settings) is a page of its own, so it opens that screen
 * and the segment springs back.
 *
 * A port of `MachineFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard, badge, meter } from '../dom.js';
import { S } from '../strings.js';
import { menu } from '../overlays.js';
import { machineMenu, terminalMenu, copyToClipboard, launchPreset } from '../actions.js';
import { ConnectionState } from '../../core/relay.js';
import {
  presence, machineSubtitle, machineIcon, terminalTitle, terminalMeta, duration, percent, bytes,
  relayHost,
} from '../../core/format.js';
import { runningSessions, metricsHaveAny, memoryFraction, storageFraction } from '../../protocol/messages.js';

export function machineScreen(app, { agentId, tab: initialTab = 'terminals' }) {
  const screen = new Screen(app);
  let tab = initialTab;

  const bodyContent = el('div');
  const body = el('div.screen-body.wide', null, bodyContent);
  // The title and the star are rewritten on every render (the segment decides
  // what the header says), so they are held rather than looked up again.
  const starButton = headerAction('star', S.actionFavourite, () => toggleFavourite());
  const headerNode = header({
    title: '',
    subtitle: '',
    onBack: () => app.back(),
    actions: [
      starButton,
      headerAction('more', S.more, (e) => {
        const agent = app.agents.agent(agentId);
        if (agent) machineMenu(app, e.currentTarget, agent);
      }),
    ],
  });
  const root = el('div.screen', null, headerNode, body);

  const titleNode = headerNode.querySelector('.header-title');
  const subtitleNode = headerNode.querySelector('.header-subtitle');

  function toggleFavourite() {
    app.settings.toggleFavouriteMachine(agentId);
    render();
  }

  function selectTab(next) {
    tab = next;
    render();
  }

  function render() {
    const agent = app.agents.agent(agentId);
    if (!agent) {
      // Removed elsewhere (another device, or the relay): do not linger on a dead screen.
      app.back();
      return;
    }
    const state = app.client.state;
    const name = agent.name || agent.hostname;
    screen.title = name;

    if (tab === 'details') {
      titleNode.textContent = S.machineDetailsTitle;
      subtitleNode.textContent = name;
    } else {
      titleNode.textContent = name;
      subtitleNode.textContent = machineSubtitle(agent);
    }
    const favourite = app.settings.isFavouriteMachine(agentId);
    starButton.classList.toggle('starred', favourite);
    starButton.title = favourite ? S.actionUnfavourite : S.actionFavourite;

    clear(bodyContent);
    bodyContent.append(heroCard(agent, state));
    bodyContent.append(el('div.segmented', { role: 'tablist' },
      segment(S.tabTerminals, tab === 'terminals', () => selectTab('terminals')),
      segment(S.tabDetails, tab === 'details', () => selectTab('details')),
      segment(S.tabSettings, false, () => app.openMachineSettings(agentId))));

    if (tab === 'terminals') renderTerminals(agent);
    else renderDetails(agent, state);
  }

  function segment(label, active, onClick) {
    return el('button', { role: 'tab', 'aria-selected': String(active), onClick }, el('span', { text: label }));
  }

  function heroCard(agent, state) {
    const { label, tone } = presence(agent, state);
    return el('button.card.machine-card', {
      onClick: () => selectTab('details'),
      style: { width: '100%', textAlign: 'left' },
    },
    el('div.machine-head', null,
      el(`div.tile.lg${agent.online ? '.on' : ''}`, null, svgIcon(machineIcon(agent))),
      el('div.machine-identity', null,
        el('div.machine-name', { text: agent.hostname || agent.name }),
        el('div.machine-subtitle', { text: [agent.os, agent.arch].filter(Boolean).join('  •  ') }),
        el('div.machine-status', null,
          el(`span.dot.tone-${tone}`),
          el('span', { class: `tone-${tone}`, text: label }),
          agent.agentVersion ? el('span', { class: 'tone-offline', text: '·' }) : null,
          agent.agentVersion ? el('span', { class: 'tone-offline', text: S.agentVersionShort(agent.agentVersion) }) : null))));
  }

  /* ------------------------------ terminals ----------------------------- */

  function renderTerminals(agent) {
    // The presets that can run here, as chips above the list. The last chip
    // opens the presets screen, so this row is also how they are managed.
    const presets = app.settings.presetsFor(agentId);
    if (presets.length > 0) {
      bodyContent.append(el('div.chip-row', null,
        presets.map((preset) => el('button.chip', {
          onClick: () => launchPreset(app, preset, agentId),
          title: S.presetStart,
        }, svgIcon('bookmark'), el('span', { text: preset.name }))),
        el('button.chip', { onClick: () => app.openPresets() },
          svgIcon('settings'), el('span', { text: S.presetsManage }))));
    }

    const sessions = [...agent.sessions].sort(
      (a, b) => Math.max(b.lastActiveAt, b.createdAt) - Math.max(a.lastActiveAt, a.createdAt));

    if (sessions.length === 0) {
      bodyContent.append(agent.online
        ? stateBlock({ icon: 'terminal_square', title: S.emptyTerminalsTitle, body: S.emptyTerminalsBody })
        : stateBlock({ icon: 'wifi_off', title: S.machineOffline, body: S.agentOfflineHint }));
    } else {
      bodyContent.append(rowsCard(sessions.map((session) => terminalRow(agent, session))));
      const running = runningSessions(agent);
      bodyContent.append(el('div.note', null,
        el('div.note-well', { style: { background: 'var(--accent-soft)', color: 'var(--accent)' } }, svgIcon('command')),
        el('div', null,
          el('div.note-title', { text: S.machineSessionsNoteTitle(running) }),
          el('div.note-body', { text: S.machineSessionsNoteBody }))));
    }

    bodyContent.append(el('button.cta', {
      disabled: !agent.online,
      onClick: () => app.openNewTerminal(agentId),
      style: { marginTop: '10px' },
    }, svgIcon('plus'), el('span', { text: S.newTerminal })));
  }

  function terminalRow(agent, session) {
    const open = app.sessions.find(agent.agentId, session.sessionId) != null;
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
      session.attached > 0 ? badge(S.badgeActive) : open ? badge(S.badgeOpen, true) : null),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => terminalMenu(app, e.currentTarget, agent, session))));
  }

  /* -------------------------------- details ----------------------------- */

  function renderDetails(agent, state) {
    const m = agent.metrics;
    bodyContent.append(el('div.metric-grid', null,
      metricTile(S.metricCpu, 'cpu', '--primary', m.cpuLoad != null ? percent(m.cpuLoad) : null, m.cpuLoad),
      metricTile(S.metricMemory, 'memory', '--accent', m.memoryUsedBytes != null ? bytes(m.memoryUsedBytes) : null, memoryFraction(m)),
      metricTile(S.metricStorage, 'hard_drive', '--amber', storageFraction(m) != null ? percent(storageFraction(m)) : null, storageFraction(m)),
      // A week of uptime fills the meter; longer simply stays full.
      metricTile(S.metricUptime, 'clock', '--purple', m.uptimeSec != null ? duration(m.uptimeSec) : null,
        m.uptimeSec != null ? Math.min(1, m.uptimeSec / (7 * 86_400)) : null)));

    if (!metricsHaveAny(m)) {
      bodyContent.append(el('div.note', null,
        el('div.note-well', { style: { background: 'var(--surface-flat)', color: 'var(--text-muted)' } }, svgIcon('info')),
        el('div', null, el('div.note-body', { text: S.metricsUnavailable }))));
    }

    bodyContent.append(el('div.section-label', { text: S.systemInformation }));
    const latency = app.client.latencyMs;
    const relay = relayHost(app.credentials.relayUrl);
    bodyContent.append(rowsCard([
      infoRow('monitor_cog', S.infoOperatingSystem,
        [agent.os, agent.arch].filter(Boolean).join(' · ') || S.valueUnknown),
      infoRow('package', S.infoAgentVersion,
        agent.agentVersion ? S.agentUpToDate(agent.agentVersion) : S.valueUnknown,
        agent.agentVersion ? S.badgeLatest : null),
      infoRow('network', S.infoConnection,
        latency != null && state.name === ConnectionState.CONNECTED ? S.connectionWithLatency(relay, latency) : relay),
      infoRow('fingerprint', S.infoMachineId, agent.agentId, null, () => copyToClipboard(agent.agentId)),
      agent.shells.length > 0
        ? infoRow('terminal', S.infoShells, agent.shells.map((s) => s.label).join(', '))
        : null,
    ]));
  }

  function metricTile(caption, iconName, colorVar, value, fraction) {
    return el('div.metric-tile', null,
      el('div.metric-head', null,
        el('span', { text: caption }),
        el('span', { style: { color: value != null ? `var(${colorVar})` : 'var(--text-muted)' } }, svgIcon(iconName))),
      el(`div.metric-value${value == null ? '.unknown' : ''}`, { text: value ?? S.valueUnknown }),
      meter(fraction, colorVar));
  }

  function infoRow(iconName, label, value, badgeText = null, onClick = null) {
    return el(`div.info-row${onClick ? '.clickable' : ''}`, {
      onClick: onClick ?? null,
      role: onClick ? 'button' : null,
      tabindex: onClick ? '0' : null,
      title: onClick ? S.copy : null,
    },
    svgIcon(iconName),
    el('div', { class: 'spacer', style: { flex: '1 1 auto', minWidth: 0 } },
      el('div.info-label', { text: label }),
      el('div.info-value', { text: value })),
    badgeText ? badge(badgeText) : null);
  }

  screen.listen(app.agents, 'agents', render);
  // The meters on the Details segment are the only thing a metrics tick moves.
  screen.listen(app.agents, 'metrics', render);
  screen.listen(app.settings, 'changed', render);
  screen.listen(app.client, 'state', render);
  screen.listen(app.client, 'latency', render);
  screen.every(30_000, render);

  render();

  screen.root = root;
  return screen;
}
