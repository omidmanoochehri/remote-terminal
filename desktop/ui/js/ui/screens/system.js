/**
 * The machine's System segment: what the agent reports about the machine
 * (`sys.info`), its network interfaces, and its listening ports (`net.ports`).
 * Addresses and MACs copy on click; a port offers "Copy address:port" and
 * "Show process" (the Processes segment, filtered by its PID).
 *
 * Every answer to `sys.info` also refreshes the machine's Wake-on-LAN details,
 * unless the user typed their own.
 *
 * A port of `SystemFragment.kt`.
 */

import { el, clear, svgIcon, stateBlock, headerAction, debounce, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { menu } from '../overlays.js';
import { copyToClipboard } from '../actions.js';
import { featureGate } from '../../core/requests.js';
import { bytes, duration, connectionLabel } from '../../core/format.js';
import { arrangePorts, endpoint, processLabel } from '../../core/sysinfo.js';
import { wolFromSysInfo } from '../../core/wol.js';
import { requestErrorText } from './files.js';

export function systemPanel(app, agentId, { onShowProcess } = {}) {
  let info = null;
  let infoError = null;
  let ports = null;
  let portsError = null;
  let filter = '';
  let loading = false;
  let destroyed = false;

  const machineSlot = el('div');
  const networkSlot = el('div');
  const portsCount = el('div.procs-count', { text: '' });
  const filterInput = el('input', { type: 'search', placeholder: S.systemPortsFilterHint, 'aria-label': S.systemPortsFilterHint });
  const portsTable = el('div.procs-table.ports-table', { role: 'grid' });
  const portsSection = el('div', null,
    el('div.files-toolbar', null,
      el('div.section-label', { text: S.systemPorts, style: { margin: 0 } }),
      el('span.spacer'),
      portsCount,
      headerAction('refresh', S.filesRefresh, () => refreshPorts())),
    el('div.search-bar', null, svgIcon('search'), filterInput),
    portsTable);
  const content = el('div.system-content', null,
    el('div.files-toolbar', null,
      el('span.spacer'),
      headerAction('refresh', S.filesRefresh, () => refresh())),
    machineSlot, networkSlot, portsSection);
  const gateNode = el('div');
  const root = el('div.procs-panel.system-panel', null, gateNode, content);

  filterInput.addEventListener('input', debounce(() => { filter = filterInput.value; renderPorts(); }, 100));

  const agent = () => app.agents.agent(agentId);
  const has = (cap) => featureGate(app.client.caps, agent(), cap).ok;

  function gate() {
    if (!app.client.isConnected) return { ok: false, text: connectionLabel(app.client.state) };
    const sys = featureGate(app.client.caps, agent(), 'sys');
    const net = featureGate(app.client.caps, agent(), 'ports');
    if (sys.ok || net.ok) return { ok: true };
    if (sys.reason === 'offline' || net.reason === 'offline') {
      return { ok: false, text: S.featureOffline(sys.name || net.name), icon: 'wifi_off' };
    }
    return { ok: false, text: S.systemUnsupported, icon: 'package' };
  }

  async function refreshInfo() {
    if (!has('sys')) { info = null; infoError = null; return; }
    try {
      info = await app.client.agentRequest(agentId, 'sys.info', {});
      infoError = null;
      rememberWol(info);
    } catch (err) {
      infoError = requestErrorText(err);
    }
  }

  async function refreshPorts(render = true) {
    if (!has('ports')) { ports = null; portsError = null; if (render) renderPorts(); return; }
    try {
      ports = await app.client.agentRequest(agentId, 'net.ports', {});
      portsError = null;
    } catch (err) {
      portsError = requestErrorText(err);
    }
    if (render && !destroyed) renderPorts();
  }

  async function refresh() {
    if (loading || destroyed || !gate().ok) return;
    loading = true;
    await Promise.all([refreshInfo(), refreshPorts(false)]);
    loading = false;
    if (!destroyed) render();
  }

  /** Keep the Wake-on-LAN details current, unless the user set their own. */
  function rememberWol(answer) {
    if (app.settings.wolIsManual(agentId)) return;
    const wol = wolFromSysInfo(answer);
    if (wol) app.settings.setWol(agentId, wol, { manual: false });
  }

  /* ------------------------------ rendering ----------------------------- */

  const notReported = S.systemNotReported;
  const value = (v) => (v == null || v === '' ? notReported : String(v));

  function infoRow(label, text, copy = false) {
    const known = text !== notReported;
    return el(`div.info-row${copy && known ? '.clickable' : ''}`, {
      onClick: copy && known ? () => copyToClipboard(text) : null,
      title: copy && known ? S.copy : null,
    },
    el('div', { class: 'spacer', style: { minWidth: 0 } },
      el('div.info-label', { text: label }),
      el('div.info-value', { text, class: known ? '' : 'tone-offline' })));
  }

  function renderMachine() {
    clear(machineSlot);
    machineSlot.append(el('div.section-label', { text: S.systemMachine }));
    if (!has('sys')) { machineSlot.append(el('div.note-body', { text: S.systemInfoUnsupported })); return; }
    if (infoError && !info) {
      machineSlot.append(stateBlock({ icon: 'alert', title: S.featureUnavailableTitle, body: infoError, tone: 'error' }));
      return;
    }
    if (!info) { machineSlot.append(el('div.files-loading', { text: '…' })); return; }
    const i = info;
    machineSlot.append(el('div.system-grid', null,
      rowsCard([
        infoRow(S.systemHostname, value(i.hostname), true),
        infoRow(S.systemOs, value(i.os ?? i.platform)),
        infoRow(S.systemKernel, value(i.release)),
        infoRow(S.systemArch, value(i.arch)),
        infoRow(S.systemCpu, i.cpuModel || i.cpus
          ? [i.cpuModel, i.cpus ? S.systemCpus(i.cpus) : null].filter(Boolean).join(' · ')
          : notReported),
        infoRow(S.systemMemory, i.memoryTotal ? bytes(i.memoryTotal) : notReported),
      ]),
      rowsCard([
        infoRow(S.systemUptime, i.uptimeSec != null ? duration(i.uptimeSec) : notReported),
        infoRow(S.systemAgentUptime, i.agentUptimeSec != null ? duration(i.agentUptimeSec) : notReported),
        infoRow(S.systemUser, value(i.user)),
        infoRow(S.systemTimezone, value(i.timezone)),
        infoRow(S.systemAgentVersion, value(i.agentVersion)),
        infoRow(S.systemNode, value(i.nodeVersion)),
      ])));
  }

  function renderNetwork() {
    clear(networkSlot);
    if (!info) return;
    networkSlot.append(el('div.section-label', { text: S.systemNetwork }));
    const ifaces = Array.isArray(info.interfaces) ? info.interfaces : [];
    if (ifaces.length === 0) { networkSlot.append(el('div.note-body', { text: S.systemNoInterfaces })); return; }
    networkSlot.append(rowsCard(ifaces.map((iface) => el('div.iface', null,
      el('div.iface-head', null,
        svgIcon('network'),
        el('span.iface-name', { text: iface.name || '?' }),
        iface.mac
          ? el('button.chip.small', { onClick: () => copyToClipboard(iface.mac), title: S.copy },
            el('span', { text: `${S.systemMac} ${iface.mac}` }))
          : null),
      el('div.chip-row', null, (Array.isArray(iface.addresses) ? iface.addresses : []).map((a) =>
        el('button.chip.small.mono', {
          onClick: () => copyToClipboard(a.address),
          title: `${a.family} · ${S.copy}`,
        }, el('span', { text: a.cidr || a.address }))))))));
  }

  function renderPorts() {
    clear(portsTable);
    portsSection.classList.toggle('hidden', false);
    if (!has('ports')) {
      portsCount.textContent = '';
      portsTable.append(el('div.files-empty', { text: S.systemPortsUnsupported }));
      return;
    }
    if (portsError && !ports) {
      portsTable.append(stateBlock({ icon: 'alert', title: S.featureUnavailableTitle, body: portsError, tone: 'error',
        actionLabel: S.filesRefresh, actionIcon: 'refresh', onAction: () => refreshPorts() }));
      return;
    }
    if (!ports) { portsTable.append(el('div.files-loading', { text: '…' })); return; }
    const all = Array.isArray(ports.ports) ? ports.ports : [];
    portsCount.textContent = S.systemPortsCount(all.length);
    portsTable.append(el('div.procs-row.header.ports-row', null,
      el('div.procs-cell.num', { text: S.systemPortsColumnPort }),
      el('div.procs-cell', { text: S.systemPortsColumnProto }),
      el('div.procs-cell', { text: S.systemPortsColumnAddress }),
      el('div.procs-cell', { text: S.systemPortsColumnProcess })));
    const rows = arrangePorts(all, filter);
    if (rows.length === 0) {
      portsTable.append(el('div.files-empty', { text: all.length === 0 ? S.systemPortsNone : S.emptySearchTitle }));
    }
    for (const p of rows) {
      portsTable.append(el('div.procs-row.ports-row', {
        role: 'row',
        onClick: (e) => portMenu(e, p),
        oncontextmenu: (e) => { e.preventDefault(); portMenu(e, p); },
        title: endpoint(p),
      },
      el('div.procs-cell.num', { text: String(p.port) }),
      el('div.procs-cell', { text: `${p.proto}${p.family === 'IPv6' ? '6' : ''}` }),
      el('div.procs-cell.mono', { text: p.address || '' }),
      el('div.procs-cell.user', { text: processLabel(p) ?? '' })));
    }
    if (ports.truncated) portsTable.append(el('div.files-empty', { text: S.systemPortsTruncated }));
  }

  function portMenu(e, p) {
    const anchor = { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) };
    menu(anchor, [
      { label: S.systemCopyEndpoint, icon: 'copy', onClick: () => copyToClipboard(endpoint(p)) },
      p.pid != null && has('procs') && onShowProcess
        ? { label: S.systemShowProcess, icon: 'activity', onClick: () => onShowProcess(p.pid) }
        : null,
    ]);
  }

  function render() {
    renderMachine();
    renderNetwork();
    renderPorts();
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
    if (!info && !ports && !loading) { render(); refresh(); }
  }

  function destroy() { destroyed = true; }

  return { root, update, destroy, focus: () => filterInput.focus(), refresh };
}
