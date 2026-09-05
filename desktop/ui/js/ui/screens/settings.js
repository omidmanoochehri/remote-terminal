/**
 * App settings. Every preference the app has is here, grouped as the design
 * groups them; the rows that need more room (fonts, key rows, history) open a
 * screen or a dialog rather than growing the list.
 *
 * A port of `AppSettingsFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, debounce } from '../dom.js';
import { SettingsBuilder } from '../settingsBuilder.js';
import { S, CHOICES, labelFor } from '../strings.js';
import { menu, chooseDialog, promptDialog, confirmDialog, toast } from '../overlays.js';
import { copyToClipboard } from '../actions.js';
import { relayHost } from '../../core/format.js';
import {
  FONT_SYSTEM, COMMAND_HISTORY_MAX, DEFAULT_ROW1, DEFAULT_ROW2, DEFAULT_ROW3,
} from '../../core/settings.js';
import { system, store } from '../../core/platform.js';
import { PROTOCOL_VERSION } from '../../protocol/messages.js';
import { APP_VERSION } from '../../version.js';

export function settingsScreen(app) {
  const screen = new Screen(app, S.navSettings);
  const s = app.settings;

  let query = '';
  let lockAvailable = false;

  const searchInput = el('input', { type: 'search', placeholder: S.settingsSearchHint, 'aria-label': S.settingsSearchHint });
  const searchBar = el('div.search-bar.hidden', null, svgIcon('search'), searchInput,
    el('button.icon-button.small', {
      title: S.clearSearch,
      onClick: () => { searchInput.value = ''; query = ''; build(); },
    }, svgIcon('close')));
  const sections = el('div');
  const body = el('div.screen-body.wide', null, searchBar, sections);

  const root = el('div.screen', null,
    header({
      title: S.navSettings,
      subtitle: S.settingsSubtitle,
      mark: 'settings',
      actions: [
        headerAction('search', S.search, () => toggleSearch()),
        headerAction('more', S.more, (e) => menu(e.currentTarget, [
          { label: S.settingPairedDevices, icon: 'phone', onClick: () => app.openDevices() },
          { label: S.settingUnpair, icon: 'trash', danger: true, onClick: () => confirmUnpair() },
        ])),
      ],
    }),
    body);

  function toggleSearch() {
    const hidden = searchBar.classList.toggle('hidden');
    if (!hidden) searchInput.focus();
    else { searchInput.value = ''; query = ''; build(); }
  }

  searchInput.addEventListener('input', debounce(() => { query = searchInput.value; build(); }, 90));

  async function choose(title, choices, current, apply) {
    const chosen = await chooseDialog({ title, options: choices, selected: current });
    if (chosen == null) return;
    apply(chosen);
    build();
  }

  function build() {
    clear(sections);
    const b = new SettingsBuilder(sections, query);

    b.section(S.groupAppearance)
      .row('moon_star', '--primary', S.settingTheme, S.settingThemeDesc,
        labelFor(CHOICES.appTheme, s.appTheme),
        () => choose(S.settingTheme, CHOICES.appTheme, s.appTheme, (v) => { s.appTheme = v; app.applyTheme(); }))
      .row('font', '--accent', S.settingTerminalFont,
        S.settingTerminalFontValue(labelFor(CHOICES.fontFamily, s.terminalFontFamily), trimFloat(s.fontSize)),
        null, () => app.openTerminalFont());

    b.section(S.groupTerminal)
      .row('bookmark', '--primary', S.presetsTitle, S.presetsSubtitle,
        String(s.terminalPresets.length), () => app.openPresets())
      .toggle('swipe', '--accent', S.settingWheelTabs, S.settingWheelTabsDesc,
        s.wheelSwitchTabs, (v) => { s.wheelSwitchTabs = v; })
      .toggle('keyboard', '--primary', S.settingExtraKeys, S.settingExtraKeysDesc,
        s.showExtraKeys, (v) => { s.showExtraKeys = v; })
      .toggle('bell', '--amber', S.settingCommandNotifications, S.settingCommandNotificationsDesc,
        s.notifyExit, (v) => { s.notifyExit = v; })
      .row('history', '--purple', S.settingCommandHistory, S.settingCommandHistoryDesc(COMMAND_HISTORY_MAX),
        String(s.commandHistory.length), () => app.openCommandHistory())
      .toggle('command', '--accent', S.settingCommandBar, S.settingCommandBarDesc,
        s.commandBar, (v) => { s.commandBar = v; })
      .row('panel_top', '--primary', S.settingScrollback, null,
        String(s.scrollbackLines),
        () => choose(S.settingScrollback, CHOICES.scrollback, s.scrollbackLines, (v) => { s.scrollbackLines = v; }))
      .toggle('lightbulb', '--amber', S.settingKeepAwake, null,
        s.keepAwake, (v) => { s.keepAwake = v; system.setKeepAwake(v).catch(() => {}); })
      .toggle('copy', '--accent', S.settingOsc52, S.settingOsc52Desc,
        s.osc52Clipboard, (v) => { s.osc52Clipboard = v; })
      .row('message', '--purple', S.settingPasteConfirm, null,
        labelFor(CHOICES.pasteConfirm, s.pasteConfirmLines),
        () => choose(S.settingPasteConfirm, CHOICES.pasteConfirm, s.pasteConfirmLines, (v) => { s.pasteConfirmLines = v; }))
      .row('bell_ring', '--amber', S.settingBell, null,
        labelFor(CHOICES.bell, s.bell),
        () => choose(S.settingBell, CHOICES.bell, s.bell, (v) => { s.bell = v; }));

    b.section(S.groupKeyboard)
      .row('keyboard', '--accent', S.settingKeyRows, S.settingKeyRowsDesc, null, () => editKeyRows())
      .row('command', '--primary', S.settingCommandShortcuts, S.settingCommandShortcutsDesc,
        String(s.commandShortcuts.length), () => editCommandShortcuts());

    b.section(S.groupNotifications)
      .toggle('wifi_off', '--amber', S.settingNotifyOffline, null,
        s.notifyAgentOffline, (v) => { s.notifyAgentOffline = v; })
      .toggle('terminal_square', '--primary', S.settingNotifyExit, null,
        s.notifyExit, (v) => { s.notifyExit = v; })
      .toggle('bell', '--purple', S.settingNotifyBell, null,
        s.notifyBell, (v) => { s.notifyBell = v; });

    b.section(S.groupSecurityConnection)
      .toggle('fingerprint', '--primary', S.settingAppLock,
        lockAvailable ? S.settingAppLockDesc : S.settingAppLockUnavailable,
        s.appLock && lockAvailable, (v) => { s.appLock = v; }, { enabled: lockAvailable })
      .row('globe', '--accent', S.settingDefaultRelay, relayHost(app.credentials.relayUrl), null,
        () => copyToClipboard(app.credentials.relayUrl ?? ''))
      .row('phone', '--purple', S.settingPairedDevices, null, null, () => app.openDevices())
      .row('fingerprint', '--text-muted', S.settingDeviceId, app.credentials.deviceId ?? S.valueUnknown, null,
        () => copyToClipboard(app.credentials.deviceId ?? ''))
      .row('folder_open', '--text-muted', S.settingConfigFolder, S.settingConfigFolderDesc, null,
        async () => {
          try {
            await copyToClipboard(await store.configDirectory());
          } catch (err) {
            toast(String(err?.message || err), { error: true });
          }
        })
      .row('trash', '--danger', S.settingUnpair, null, null, () => confirmUnpair());

    b.footnote(S.aboutLine(APP_VERSION, PROTOCOL_VERSION));
    b.finish();

    if (b.isEmpty) {
      sections.append(stateBlock({
        icon: 'search',
        title: S.emptySearchTitle,
        body: S.emptySearchBody(query),
        actionLabel: S.clearSearch,
        actionIcon: 'close',
        onAction: () => { searchInput.value = ''; query = ''; build(); },
      }));
    }
  }

  async function editKeyRows() {
    const text = await promptDialog({
      title: S.settingKeyRows,
      body: S.prefKeysHelp,
      value: [s.extraKeysRow1, s.extraKeysRow2, s.extraKeysRow3].join('\n'),
      multiline: true,
    });
    if (text == null) return;
    const rows = text.split('\n');
    s.setKeyRows(
      (rows[0] ?? DEFAULT_ROW1).trim(),
      (rows[1] ?? DEFAULT_ROW2).trim(),
      (rows[2] ?? DEFAULT_ROW3).trim());
  }

  async function editCommandShortcuts() {
    const text = await promptDialog({
      title: S.settingCommandShortcuts,
      body: S.prefCommandsHelp,
      value: s.commandShortcuts.map(([label, command]) => `${label} = ${command}`).join('\n'),
      multiline: true,
    });
    if (text == null) return;
    s.commandShortcuts = text.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf('=');
        return eq > 0 ? [line.slice(0, eq).trim(), line.slice(eq + 1).trim()] : [line, line];
      });
    build();
  }

  async function confirmUnpair() {
    const ok = await confirmDialog({
      title: S.unpair,
      body: S.unpairConfirm,
      confirmLabel: S.unpair,
      danger: true,
    });
    if (!ok) return;
    await app.agents.clearCache();
    await app.client.unpair();
  }

  screen.listen(app.settings, 'changed', build);
  screen.listen(app.client, 'state', build);

  build();
  system.appLockAvailable().then((available) => {
    lockAvailable = available;
    build();
  }).catch(() => {});

  screen.root = root;
  return screen;
}

function trimFloat(value) {
  return Number.isInteger(value) ? String(value) : String(value);
}
