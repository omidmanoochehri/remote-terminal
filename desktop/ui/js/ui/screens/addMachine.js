/**
 * Pairing, as the three steps the design shows: connection details, then the
 * redemption, then confirmation. Redeeming a code is the only network call and
 * it is the same one the phone makes, so relays do not care which client asked.
 *
 * A port of `AddMachineFragment.kt`. The phone scans a QR code; a desktop has
 * no camera, so the equivalent affordance reads a `remoteterminal://pair` link
 * off the clipboard — the same payload, parsed by the same rules.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, stateBlock } from '../dom.js';
import { S } from '../strings.js';
import { alertDialog, confirmDialog, toast } from '../overlays.js';
import { normalizeRelayUrl, isPrivateHost } from '../../core/credentials.js';
import { parsePairingPayload } from '../../core/pairingPayload.js';
import { relayHost } from '../../core/format.js';
import { relayHttp, system } from '../../core/platform.js';
import { APP_VERSION } from '../../version.js';

const STEP_CONNECTION = 0;
const STEP_VERIFY = 1;
const STEP_FINISH = 2;

export function addMachineScreen(app, { initial = false }) {
  const screen = new Screen(app, S.addMachineTitle);

  let step = STEP_CONNECTION;
  let working = false;
  let result = null; // { icon, title, body, tone }

  const nameInput = el('input', {
    type: 'text',
    value: app.settings.deviceName || defaultDeviceName(),
    placeholder: S.pairNameHint,
  });
  const relayInput = el('input', {
    type: 'text',
    value: app.credentials.relayUrl ?? '',
    placeholder: S.pairRelayHint,
  });
  const codeInput = el('input', {
    type: 'text',
    inputmode: 'numeric',
    maxlength: '7',
    placeholder: S.pairCodeHint,
    style: { letterSpacing: '0.18em', fontFamily: 'var(--mono)' },
  });
  const relayHint = el('span', { class: 'field-trailing', text: '' });
  const relayError = el('div.field-error.hidden');
  const codeError = el('div.field-error.hidden');

  const body = el('div.screen-body.wide');
  const root = el('div.screen', null,
    header({
      title: S.addMachineTitle,
      subtitle: S.addMachineSubtitle,
      mark: 'key',
      // Nothing is paired yet on first run, so there is nowhere to go back to.
      onBack: initial ? null : () => app.back(),
    }),
    body);

  relayInput.addEventListener('input', renderRelayHint);
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/[^\d]/g, '').slice(0, 6);
    codeError.classList.add('hidden');
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPrimary(); });

  /** The relay hint only appears once there is a URL to judge. */
  function renderRelayHint() {
    const raw = relayInput.value.trim();
    if (!raw) { relayHint.textContent = ''; return; }
    const secure = !raw.startsWith('ws://') && !raw.startsWith('http://');
    relayHint.textContent = secure ? S.hintSecure : S.hintInsecure;
    relayHint.className = `field-trailing${secure ? '' : ' warn'}`;
  }

  function field(label, iconName, input, trailing, error) {
    return el('div.field', null,
      el('label.field-label', { text: label }),
      el('div.field-well', null, svgIcon(iconName), input, trailing),
      error);
  }

  function stepper() {
    const pill = (index, label) => el(`span.step-pill${index <= step ? '.active' : ''}`, { text: label });
    return el('div.stepper', null,
      pill(0, S.stepConnection),
      el(`span.step-line${step >= 1 ? '.active' : ''}`),
      pill(1, S.stepVerify),
      el(`span.step-line${step >= 2 ? '.active' : ''}`),
      pill(2, S.stepFinish));
  }

  function render() {
    clear(body);
    body.append(stepper());

    if (step === STEP_CONNECTION) {
      body.append(
        field(S.pairNameHint, 'monitor', nameInput),
        field(S.fieldRelayServer, 'globe', relayInput, relayHint, relayError),
        field(S.fieldPairingCode, 'key', codeInput,
          el('button.field-trailing.action', { text: S.hintPaste, onClick: () => pasteLink() }),
          codeError),
        el('div', { style: { fontSize: '10.5px', color: 'var(--text-muted)', margin: '2px 0 14px' }, text: S.pairingCodeHelp }),
        el('button.button', { onClick: () => pasteLink(), style: { width: '100%' } },
          svgIcon('qr_code'), el('span', { text: S.pastePairingLink })),
        el('div.note', null,
          el('div.note-well', { style: { background: 'var(--primary-soft)', color: 'var(--primary)' } }, svgIcon('shield')),
          el('div', null, el('div.note-body', { text: S.pairingSecurityNote }))),
        el('button.cta', { onClick: () => onPrimary() },
          svgIcon('arrow_right'), el('span', { text: S.actionContinue })),
        el('button.link-button', {
          text: S.viewSetupGuide,
          style: { display: 'block', margin: '14px auto 0' },
          onClick: () => alertDialog(S.machinesEmptyAction, S.machinesHelp),
        }));
      renderRelayHint();
      setTimeout(() => (relayInput.value ? codeInput : relayInput).focus(), 0);
      return;
    }

    if (result) {
      body.append(stateBlock({
        icon: result.icon,
        title: result.title,
        body: result.body,
        tone: result.tone,
      }));
    }

    if (step === STEP_VERIFY && !working) {
      body.append(el('button.cta', { onClick: () => onPrimary() },
        svgIcon('refresh'), el('span', { text: S.actionRetry })));
    }
    if (step === STEP_FINISH) {
      body.append(el('button.cta', { onClick: () => onPrimary() },
        svgIcon('arrow_right'), el('span', { text: S.finishAction })));
    }
  }

  function onPrimary() {
    if (step === STEP_CONNECTION) { attempt(); return; }
    if (step === STEP_VERIFY) { step = STEP_CONNECTION; result = null; render(); return; }
    app.onPaired();
  }

  /** Read a pairing code or a `remoteterminal://pair` link off the clipboard. */
  async function pasteLink() {
    try {
      const clip = await system.clipboardRead();
      const parsed = parsePairingPayload(clip.text);
      if (!parsed) { toast(S.pairLinkNotFound, { error: true }); return; }
      if (parsed.relay) relayInput.value = parsed.relay;
      codeInput.value = parsed.code;
      codeError.classList.add('hidden');
      renderRelayHint();
    } catch (err) {
      toast(String(err?.message || err), { error: true });
    }
  }

  async function attempt() {
    relayError.classList.add('hidden');
    codeError.classList.add('hidden');

    let relay;
    try {
      relay = normalizeRelayUrl(relayInput.value);
    } catch {
      relayError.textContent = S.pairErrorUrl;
      relayError.classList.remove('hidden');
      relayInput.focus();
      return;
    }
    const code = codeInput.value.replace(/\D/g, '');
    if (!/^[0-9]{6}$/.test(code)) {
      codeError.textContent = S.pairErrorCode;
      codeError.classList.remove('hidden');
      codeInput.focus();
      return;
    }
    const name = nameInput.value.trim() || defaultDeviceName();

    if (relay.startsWith('ws://') && !isPrivateHost(relay)) {
      const ok = await confirmDialog({
        title: S.pairInsecureTitle,
        body: S.pairInsecureText(relay),
        confirmLabel: S.pairInsecureContinue,
        danger: true,
      });
      if (!ok) return;
    }
    await pair(relay, code, name);
  }

  async function pair(relay, code, name) {
    step = STEP_VERIFY;
    working = true;
    result = { icon: 'key', title: S.verifyTitle, body: S.verifyBody(relayHost(relay)) };
    render();

    try {
      const paired = await relayHttp.redeem(relay, code, name, APP_VERSION);
      await app.credentials.save({
        relayUrl: relay,
        deviceId: paired.deviceId,
        deviceToken: paired.deviceToken,
        accountId: paired.accountId,
      });
      working = false;
      app.settings.deviceName = name;
      await app.agents.clearCache();
      app.client.onPaired();
      step = STEP_FINISH;
      result = { icon: 'check', title: S.finishTitle, body: S.finishBody(relayHost(relay)), tone: 'online' };
    } catch (err) {
      working = false;
      step = STEP_VERIFY;
      result = {
        icon: 'alert',
        title: S.verifyFailedTitle,
        body: S.pairFailed(String(err?.message || err)),
        tone: 'error',
      };
    }
    render();
  }

  render();
  screen.root = root;
  return screen;
}

function defaultDeviceName() {
  // The web view knows the platform, not the machine name; a sensible default
  // the user can edit beats an empty field.
  const platform = navigator.userAgentData?.platform || navigator.platform || 'Desktop';
  return `${platform} desktop`.replace(/^Win32/i, 'Windows');
}
