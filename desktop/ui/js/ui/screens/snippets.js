/**
 * Settings → Snippets: every saved snippet, grouped by folder, with search,
 * add, edit and delete. Snippets are used from a terminal (its menu, the
 * command palette, Ctrl+Shift+E); this screen is where they are kept.
 *
 * A port of `SnippetsFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, stateBlock, rowsCard, badge, debounce } from '../dom.js';
import { S } from '../strings.js';
import { menu, confirmDialog } from '../overlays.js';
import { editSnippetDialog } from '../snippetsUi.js';
import { groupSnippets } from '../../core/snippets.js';

export function snippetsScreen(app) {
  const screen = new Screen(app, S.snippets);
  let query = '';

  const searchInput = el('input', { type: 'search', placeholder: S.snippetsSearchHint, 'aria-label': S.snippetsSearchHint });
  const list = el('div');
  const body = el('div.screen-body.wide', null,
    el('div.search-bar', null, svgIcon('search'), searchInput),
    list);
  const root = el('div.screen', null,
    header({
      title: S.snippets,
      subtitle: S.snippetsSubtitle,
      onBack: () => app.back(),
      actions: [headerAction('plus', S.snippetNew, () => editSnippetDialog(app))],
    }),
    body);

  searchInput.addEventListener('input', debounce(() => { query = searchInput.value; render(); }, 90));

  function render() {
    const all = app.settings.snippets;
    clear(list);
    if (all.length === 0) {
      list.append(stateBlock({
        icon: 'command',
        title: S.snippetsEmptyTitle,
        body: S.snippetsEmptyBody,
        actionLabel: S.snippetNew,
        onAction: () => editSnippetDialog(app),
      }));
      return;
    }
    const groups = groupSnippets(all, query);
    if (groups.length === 0) {
      list.append(stateBlock({ icon: 'search', title: S.emptySearchTitle, body: S.emptySearchBody(query) }));
      return;
    }
    for (const g of groups) {
      list.append(el('div.section-label', { text: g.folder || S.snippetNoFolder }));
      list.append(rowsCard(g.snippets.map((snippet) => el('div', { style: { display: 'flex', alignItems: 'center' } },
        el('button.row-item', { onClick: () => editSnippetDialog(app, snippet), title: S.snippetEdit },
          el('div.row-text', null,
            el('div.row-title', { text: snippet.name }),
            el('div.row-meta', { text: snippet.body.split('\n')[0], style: { fontFamily: 'var(--mono)' } })),
          badge(snippet.run ? S.snippetRunsBadge : S.snippetInsertsBadge, true)),
        el('div', { style: { paddingRight: '8px' } },
          headerAction('more', S.more, (e) => rowMenu(e.currentTarget, snippet)))))));
    }
    list.append(el('button.cta', { onClick: () => editSnippetDialog(app), style: { marginTop: '12px' } },
      svgIcon('plus'), el('span', { text: S.snippetNew })));
  }

  function rowMenu(anchor, snippet) {
    menu(anchor, [
      { label: S.edit, icon: 'settings', onClick: () => editSnippetDialog(app, snippet) },
      { divider: true },
      { label: S.delete, icon: 'trash', danger: true, onClick: () => confirmDelete(snippet) },
    ]);
  }

  async function confirmDelete(snippet) {
    const ok = await confirmDialog({
      title: S.snippetDeleteTitle(snippet.name),
      body: S.snippetDeleteBody,
      confirmLabel: S.delete,
      danger: true,
    });
    if (ok) app.settings.deleteSnippet(snippet.id);
  }

  screen.listen(app.settings, 'changed', render);
  render();
  requestAnimationFrame(() => searchInput.focus());

  screen.root = root;
  return screen;
}
