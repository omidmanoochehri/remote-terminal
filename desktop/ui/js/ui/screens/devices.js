/**
 * Paired devices of the account: add another one, rename this one, revoke
 * others. A port of `DevicesFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { toast, confirmDialog, promptDialog, customDialog } from '../overlays.js';
import { copyToClipboard } from '../actions.js';
import { relativeTime } from '../../core/format.js';
import { relayHttp } from '../../core/platform.js';

export function devicesScreen(app) {
  const screen = new Screen(app, S.devices);

  const list = el('div');
  const body = el('div.screen-body.wide', null, list);
  const root = el('div.screen', null,
    header({
      title: S.devices,
      onBack: () => app.back(),
      actions: [headerAction('plus', S.addDevice, () => addDevice())],
    }),
    body);

  function render() {
    const devices = app.agents.devices;
    clear(list);

    if (devices.length === 0) {
      list.append(stateBlock({ icon: 'phone', title: S.devices, body: S.devicesEmpty }));
    } else {
      list.append(rowsCard(devices.map((d) => el('div', { style: { display: 'flex', alignItems: 'center' } },
        el('button.row-item', {
          onClick: () => { if (d.isSelf) renameSelf(d); },
          title: d.isSelf ? S.renameDevice : d.name,
        },
        el('div.row-text', null,
          el('div.row-title', { text: d.isSelf ? `${d.name} · ${S.deviceThisOne}` : d.name }),
          el('div.row-meta', { text: d.online ? S.deviceOnline : S.deviceLastSeen(relativeTime(d.lastSeen)) })),
        el(`span.dot.tone-${d.online ? 'online' : 'offline'}`)),
        el('div', { style: { paddingRight: '8px' } },
          d.isSelf
            ? null
            : el('button.button.danger', { onClick: () => revoke(d) }, el('span', { text: S.revokeDevice })))))));
    }

    list.append(el('button.cta', {
      onClick: () => addDevice(),
      style: { marginTop: '12px' },
    }, svgIcon('plus'), el('span', { text: S.addDevice })));
  }

  /**
   * Mint a pairing code for another device and show it large enough to read
   * across a desk, with the relay it belongs to and a link that carries both.
   */
  async function addDevice() {
    const relay = app.credentials.relayUrl;
    const token = app.credentials.token;
    if (!relay || !token) return;
    try {
      const code = await relayHttp.pairCode(relay, token);
      const minutes = Math.max(1, Math.round(code.ttlSec / 60));
      const link = `remoteterminal://pair?relay=${encodeURIComponent(relay)}&code=${code.code}`;
      await customDialog({
        title: S.pairingCodeTitle,
        build: () => el('div', null,
          el('p', { text: S.pairingCodeBody(minutes) }),
          el('div', { class: 'code', text: code.code.replace(/(\d{3})(\d{3})/, '$1 $2') }),
          el('p', { text: S.addDeviceRelay(relay) })),
        actions: [
          { label: S.copy, value: 'code' },
          { label: S.copyLink, value: 'link' },
          { label: S.ok, value: null },
        ],
      }).then((choice) => {
        if (choice === 'code') copyToClipboard(code.code);
        else if (choice === 'link') copyToClipboard(link);
      });
    } catch (err) {
      toast(S.errorGeneric(String(err?.message || err)), { error: true });
    }
  }

  async function revoke(device) {
    const ok = await confirmDialog({
      title: S.revokeDevice,
      body: S.revokeDeviceConfirm(device.name),
      confirmLabel: S.revokeDevice,
      danger: true,
    });
    if (ok) app.agents.revokeDevice(device.deviceId);
  }

  async function renameSelf(device) {
    const name = await promptDialog({ title: S.renameDevice, label: S.pairNameHint, value: device.name });
    if (!name) return;
    app.settings.deviceName = name;
    app.agents.renameDevice(name);
  }

  screen.listen(app.agents, 'devices', render);
  render();
  if (app.client.isConnected) app.agents.refresh();

  screen.root = root;
  return screen;
}
