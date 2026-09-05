/**
 * The commands sent from the command bar, kept on this device only. Clicking
 * one copies it so it can be pasted into any terminal; the overflow clears the
 * lot. A port of `CommandHistoryFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard } from '../dom.js';
import { S } from '../strings.js';
import { menu, confirmDialog, toast } from '../overlays.js';
import { copyToClipboard } from '../actions.js';

export function commandHistoryScreen(app) {
  const screen = new Screen(app, S.commandHistoryTitle);

  const list = el('div');
  const body = el('div.screen-body.wide', null, list);
  const root = el('div.screen', null,
    header({
      title: S.commandHistoryTitle,
      onBack: () => app.back(),
      actions: [headerAction('more', S.more, (e) => menu(e.currentTarget, [
        { label: S.commandHistoryClear, icon: 'trash', danger: true, onClick: () => confirmClear() },
      ]))],
    }),
    body);

  function render() {
    const history = app.settings.commandHistory;
    clear(list);
    if (history.length === 0) {
      list.append(stateBlock({ icon: 'history', title: S.commandHistoryTitle, body: S.commandHistoryEmpty }));
      return;
    }
    list.append(rowsCard(history.map((command) => el('div', { style: { display: 'flex', alignItems: 'center' } },
      el('button.row-item', { onClick: () => copyToClipboard(command), title: S.copy },
        el('div.row-text', null,
          el('div.row-title', { text: command, style: { fontFamily: 'var(--mono)', fontWeight: '400' } }))),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => menu(e.currentTarget, [
          { label: S.copy, icon: 'copy', onClick: () => copyToClipboard(command) },
          {
            label: S.delete,
            icon: 'trash',
            danger: true,
            onClick: () => {
              app.settings.commandHistory = app.settings.commandHistory.filter((c) => c !== command);
              render();
            },
          },
        ])))))));
  }

  async function confirmClear() {
    const ok = await confirmDialog({
      title: S.commandHistoryClear,
      body: S.commandHistoryEmpty,
      confirmLabel: S.delete,
      danger: true,
    });
    if (!ok) return;
    app.settings.clearCommandHistory();
    render();
    toast(S.commandHistoryCleared);
  }

  screen.listen(app.settings, 'changed', render);
  render();

  screen.root = root;
  return screen;
}
