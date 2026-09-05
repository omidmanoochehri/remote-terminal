/**
 * Settings for one machine. The display name is renamed on the relay; the
 * connection switches are this device's policy for that machine and are applied
 * immediately by the session layer. The relay URL is shown read-only because it
 * is account-wide — changing it means pairing again.
 *
 * A port of `MachineSettingsFragment.kt`. As on the New terminal form, the
 * layout is built once and only the live parts are refreshed, so a metrics tick
 * cannot take the caret out of the name field.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, switchEl, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { toast, alertDialog } from '../overlays.js';
import { machineMenu, confirmRemoveMachine } from '../actions.js';
import { isSecureRelay } from '../../core/format.js';

export function machineSettingsScreen(app, { agentId }) {
  const screen = new Screen(app, S.machineSettingsTitle);

  const nameInput = el('input', { type: 'text', value: '' });
  const relayInput = el('input', { type: 'text', disabled: true, value: '' });
  const relayHint = el('span', { class: 'field-trailing', text: '' });
  const nameError = el('div.field-error.hidden', { text: S.fieldDisplayName });

  const autoReconnect = switchEl(app.settings.autoReconnect(agentId));
  const keepAlive = switchEl(app.settings.keepAlive(agentId));
  const alerts = switchEl(app.settings.connectionAlerts(agentId));

  const securityCard = el('div.card.rows-card');

  const headerNode = header({
    title: S.machineSettingsTitle,
    subtitle: '',
    onBack: () => app.back(),
    actions: [headerAction('more', S.more, (e) => {
      const agent = app.agents.agent(agentId);
      if (agent) machineMenu(app, e.currentTarget, agent);
    })],
  });
  const subtitleNode = headerNode.querySelector('.header-subtitle');

  const body = el('div.screen-body.wide', null,
    el('div.section-label', { text: S.fieldDisplayName }),
    field(S.fieldDisplayName, 'server', nameInput, null, nameError),
    field(S.fieldRelayServer, 'globe', relayInput, relayHint),

    el('div.section-label', { text: S.settingKeepAlive }),
    el('div.card', { style: { overflow: 'hidden' } },
      toggleRow(autoReconnect, 'refresh', '--primary', S.settingAutoReconnect, S.settingAutoReconnectDesc, (v) => {
        app.settings.setAutoReconnect(agentId, v);
        if (v) app.sessions.reattachAll(agentId);
      }),
      el('div.divider'),
      toggleRow(keepAlive, 'activity', '--accent', S.settingKeepAlive, S.settingKeepAliveDesc, (v) => {
        app.settings.setKeepAlive(agentId, v);
      }),
      el('div.divider'),
      toggleRow(alerts, 'bell_ring', '--amber', S.settingConnectionAlerts, S.settingConnectionAlertsDesc, (v) => {
        app.settings.setConnectionAlerts(agentId, v);
      })),

    el('div.section-label', { text: S.securityEncryption }),
    securityCard,

    el('div', { style: { display: 'flex', gap: '8px', marginTop: '18px' } },
      el('button.cta', { onClick: () => save() }, svgIcon('save'), el('span', { text: S.saveChanges })),
      el('button.button.danger', {
        onClick: () => {
          const agent = app.agents.agent(agentId);
          if (agent) confirmRemoveMachine(app, agent, () => app.openMachines());
        },
      }, svgIcon('trash'), el('span', { text: S.removeMachine }))));

  const root = el('div.screen', null, headerNode, body);

  function field(label, iconName, input, trailing, error) {
    return el('div.field', null,
      el('label.field-label', { text: label }),
      el('div.field-well', null, svgIcon(iconName), input, trailing),
      error);
  }

  function toggleRow(node, iconName, colorVar, title, description, onToggle) {
    return el('button.toggle-row', {
      onClick: () => {
        const next = node.getAttribute('aria-checked') !== 'true';
        node.setAttribute('aria-checked', String(next));
        onToggle(next);
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

  function refresh() {
    const agent = app.agents.agent(agentId);
    if (!agent) { app.back(); return; }

    subtitleNode.textContent = agent.name || agent.hostname;
    // Never overwrite what the user is in the middle of typing.
    if (document.activeElement !== nameInput) nameInput.value = agent.name;

    const relay = app.credentials.relayUrl;
    relayInput.value = relay ?? S.valueUnknown;
    const secure = isSecureRelay(relay);
    relayHint.textContent = secure ? S.hintSecure : S.hintInsecure;
    relayHint.className = `field-trailing${secure ? '' : ' warn'}`;

    clear(securityCard);
    securityCard.append(
      el('div.info-row.clickable', {
        onClick: () => alertDialog(S.securityAgentToken, S.securityAgentTokenNote),
        role: 'button',
        tabindex: '0',
      },
      svgIcon('key'),
      el('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        el('div.info-label', { text: S.securityAgentToken }),
        el('div.info-value', { text: S.securityAgentTokenValue }))),
      el('div.divider'),
      el('div.info-row', null,
        el('span', { class: secure ? 'tone-online' : 'tone-warn' }, svgIcon('shield')),
        el('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          el('div.info-label', { text: S.securityEncryption }),
          el('div.info-value', {
            class: secure ? '' : 'tone-warn',
            text: secure ? S.securityEncryptionTls : S.securityEncryptionPlain,
          }))));
  }

  function save() {
    const agent = app.agents.agent(agentId);
    const name = nameInput.value.trim();
    if (!name) { nameError.classList.remove('hidden'); return; }
    nameError.classList.add('hidden');
    if (agent && name !== agent.name) app.agents.renameAgent(agentId, name);
    toast(S.saved);
    app.back();
  }

  screen.listen(app.agents, 'agents', refresh);
  refresh();

  screen.root = root;
  return screen;
}
