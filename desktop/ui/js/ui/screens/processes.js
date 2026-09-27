/**
 * The process manager: what is running on one machine, busiest first, with
 * End and Force end for the processes the agent lets this app end
 * (PROTOCOL.md §6b). Lives inside the machine screen as its Processes segment
 * and refreshes itself every few seconds while it is actually on screen.
 *
 * A port of `ProcessesFragment.kt`.
 */

import { el, clear, svgIcon, stateBlock, headerAction, debounce, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { toast, confirmDialog } from '../overlays.js';
import { copyToClipboard } from '../actions.js';
import { featureGate } from '../../core/requests.js';
import {
  arrangeProcesses, endPermission, cpuLabel, SORT_CPU, SORT_MEMORY, SORT_NAME,
} from '../../core/processes.js';
import { bytes, connectionLabel } from '../../core/format.js';
import { requestErrorText } from './files.js';

const REFRESH_MS = 3000;

export function processesPanel(app, agentId) {
  let listing = null;
  let error = null;
  let filter = '';
  let selectedPid = null;
  let inflight = false;
  let destroyed = false;

  const countNode = el('div.procs-count', { text: '' });
  const filterInput = el('input', { type: 'search', placeholder: S.processesFilterHint, 'aria-label': S.processesFilterHint });
  const sortChips = el('div.chip-row.procs-sort');
  const toolbar = el('div.files-toolbar', null,
    countNode,
    el('span.spacer'),
    sortChips,
    headerAction('refresh', S.filesRefresh, () => refresh(true)));
  const filterBar = el('div.search-bar', null, svgIcon('search'), filterInput);
  const table = el('div.procs-table', { tabindex: '0', role: 'grid' });
  const details = el('div.procs-details');
  const layout = el('div.procs-layout', null, table, details);
  const content = el('div.procs-content', null, toolbar, filterBar, layout);
  const gateNode = el('div');
  const root = el('div.procs-panel', null, gateNode, content);

  filterInput.addEventListener('input', debounce(() => { filter = filterInput.value; render(); }, 100));
  table.addEventListener('keydown', onKey);

  const agent = () => app.agents.agent(agentId);

  function gate() {
    if (!app.client.isConnected) return { ok: false, text: connectionLabel(app.client.state) };
    const g = featureGate(app.client.caps, agent(), 'procs');
    if (g.ok) return { ok: true };
    if (g.reason === 'offline') return { ok: false, text: S.featureOffline(g.name), icon: 'wifi_off' };
    return { ok: false, text: S.processesUnsupported, icon: 'package' };
  }

  /** Refresh only when someone can see the result. */
  const visible = () => root.isConnected && document.visibilityState === 'visible';

  async function refresh(force = false) {
    if (inflight || destroyed) return;
    if (!force && !visible()) return;
    if (!gate().ok) return;
    inflight = true;
    try {
      listing = await app.client.agentRequest(agentId, 'proc.list', {});
      error = null;
    } catch (err) {
      error = requestErrorText(err);
    } finally {
      inflight = false;
    }
    if (!destroyed) render();
  }

  const timer = setInterval(() => refresh(false), REFRESH_MS);

  /* ------------------------------ rendering ----------------------------- */

  function rows() {
    return listing ? arrangeProcesses(listing.processes || [], { sort: app.settings.processSort, filter }) : [];
  }

  function render() {
    renderSortChips();
    clear(table);
    if (error && !listing) {
      table.append(stateBlock({ icon: 'alert', title: S.featureUnavailableTitle, body: error, tone: 'error',
        actionLabel: S.filesRefresh, actionIcon: 'refresh', onAction: () => refresh(true) }));
      clear(details);
      return;
    }
    if (!listing) { table.append(el('div.files-loading', { text: '…' })); return; }
    countNode.textContent = S.processesCount(listing.total ?? (listing.processes || []).length);
    const sort = app.settings.processSort;
    const head = (label, key, cls) => el(`div.procs-cell.head${cls ? `.${cls}` : ''}`, {
      role: 'columnheader',
      class: key ? `sortable${sort === key ? ' active' : ''}` : '',
      onClick: key ? () => setSort(key) : null,
    }, el('span', { text: label }), key && sort === key ? svgIcon('chevron_down') : null);
    table.append(el('div.procs-row.header', null,
      head(S.processesColumnName, SORT_NAME, 'name'),
      head(S.processesColumnPid, null, 'num'),
      head(S.processesColumnUser, null, 'user'),
      head(S.processesColumnCpu, SORT_CPU, 'num'),
      head(S.processesColumnMemory, SORT_MEMORY, 'num')));
    const list = rows();
    if (list.length === 0) table.append(el('div.files-empty', { text: S.processNoMatches }));
    for (const p of list) {
      const selected = p.pid === selectedPid;
      table.append(el(`div.procs-row${selected ? '.selected' : ''}`, {
        role: 'row',
        dataset: { pid: String(p.pid) },
        title: p.cmd || p.name,
        onClick: () => select(p.pid),
      },
      el('div.procs-cell.name', { text: p.name }),
      el('div.procs-cell.num', { text: String(p.pid) }),
      el('div.procs-cell.user', { text: p.user || '' }),
      el('div.procs-cell.num', { text: cpuLabel(p.cpu) }),
      el('div.procs-cell.num', { text: bytes(p.mem) })));
    }
    renderDetails();
  }

  function renderSortChips() {
    const sort = app.settings.processSort;
    clear(sortChips);
    for (const [key, label] of [[SORT_CPU, S.processesSortCpu], [SORT_MEMORY, S.processesSortMemory], [SORT_NAME, S.processesSortName]]) {
      sortChips.append(el('button.chip', { 'aria-pressed': String(sort === key), onClick: () => setSort(key) }, el('span', { text: label })));
    }
  }

  function setSort(key) {
    app.settings.processSort = key;
    render();
  }

  function selectedProcess() {
    return listing?.processes?.find((p) => p.pid === selectedPid) ?? null;
  }

  function select(pid) {
    selectedPid = pid;
    for (const node of table.querySelectorAll('.procs-row[data-pid]')) {
      node.classList.toggle('selected', node.dataset.pid === String(pid));
    }
    table.querySelector('.procs-row.selected')?.scrollIntoView({ block: 'nearest' });
    renderDetails();
  }

  function renderDetails() {
    clear(details);
    const p = selectedProcess();
    if (!p) {
      details.append(el('div.note-body', { text: S.processNone }));
      return;
    }
    const permission = endPermission(listing, p);
    const info = (label, value, copy = false) => el(`div.info-row${copy ? '.clickable' : ''}`, {
      onClick: copy ? () => copyToClipboard(value) : null,
      title: copy ? S.copy : null,
    }, el('div', { class: 'spacer', style: { minWidth: 0 } },
      el('div.info-label', { text: label }),
      el('div.info-value', { text: value || S.valueUnknown })));
    details.append(
      el('div.section-label', { text: S.processDetails }),
      rowsCard([
        info(S.processesColumnName, p.name),
        info(S.processesColumnPid, String(p.pid), true),
        p.ppid != null ? info(S.processParent, String(p.ppid)) : null,
        info(S.processesColumnUser, p.user),
        info(S.processesColumnCpu, cpuLabel(p.cpu)),
        info(S.processesColumnMemory, bytes(p.mem)),
        p.cmd ? info(S.processCommand, p.cmd, true) : null,
      ]),
      el('div.procs-actions', null,
        el('button.button', { disabled: !permission.ok, onClick: () => end(p, false) },
          svgIcon('close'), el('span', { text: S.processEnd })),
        el('button.button.danger', { disabled: !permission.ok, onClick: () => end(p, true) },
          svgIcon('trash'), el('span', { text: S.processForceEnd }))),
    );
    if (!permission.ok) {
      details.append(el('div.note-body.procs-why', {
        text: permission.reason === 'off' ? S.processEndOff : S.processEndNotOwn(listing.owner || ''),
      }));
    }
  }

  function moveSelection(delta) {
    const list = rows();
    if (list.length === 0) return;
    const i = list.findIndex((p) => p.pid === selectedPid);
    const next = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta));
    select(list[next].pid);
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { moveSelection(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { moveSelection(-1); e.preventDefault(); }
    else if (e.key === 'Delete') {
      const p = selectedProcess();
      if (p && endPermission(listing, p).ok) end(p, e.shiftKey);
      e.preventDefault();
    }
  }

  async function end(p, force) {
    const ok = await confirmDialog({
      title: S.processEndTitle(p.name, p.pid),
      body: force ? S.processForceEndBody : S.processEndBody,
      confirmLabel: force ? S.processForceEnd : S.processEnd,
      danger: true,
    });
    if (!ok) return;
    try {
      await app.client.agentRequest(agentId, 'proc.kill', { pid: p.pid, force });
      toast(force ? S.processKilled(p.name) : S.processEnded(p.name));
      setTimeout(() => refresh(true), 600);
    } catch (err) {
      toast(requestErrorText(err), { error: true });
    }
  }

  /* ------------------------------ lifecycle ----------------------------- */

  function update() {
    const g = gate();
    clear(gateNode);
    content.classList.toggle('hidden', !g.ok);
    if (!g.ok) {
      gateNode.append(stateBlock({ icon: g.icon ?? 'wifi_off', title: S.featureUnavailableTitle, body: g.text }));
      return;
    }
    if (!listing) { render(); refresh(true); }
  }

  function destroy() {
    destroyed = true;
    clearInterval(timer);
  }

  return { root, update, destroy, focus: () => table.focus(), refresh: () => refresh(true) };
}
