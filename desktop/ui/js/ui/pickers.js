/**
 * The searchable pickers: the command palette and the snippet picker share one
 * dialog — a search field over a list, arrow keys to move, Enter to run the
 * highlighted entry (the first one unless you moved), a click to run that one.
 */

import { el, clear, svgIcon } from './dom.js';
import { S } from './strings.js';
import { customDialog } from './overlays.js';
import { fuzzyFilter } from '../core/fuzzy.js';

/**
 * Resolves to the chosen item, or null. Items are
 * `{ label, detail?, icon?, badge?, group? }`; [rank] orders them for a query
 * (fuzzy by label by default). [groupBy] adds group headings when not searching.
 */
export function searchListDialog({ title, placeholder, items, emptyText = S.paletteEmpty, rank = null, grouped = false, footer = null }) {
  const input = el('input', { type: 'search', placeholder, 'aria-label': placeholder });
  const list = el('div.picker-list', { role: 'listbox' });
  let shown = [];
  let index = 0;
  let finish = null;

  function render() {
    const q = input.value;
    shown = rank ? rank(items, q) : fuzzyFilter(items, q, (x) => x.label, 50);
    index = Math.min(index, Math.max(0, shown.length - 1));
    clear(list);
    if (shown.length === 0) {
      list.append(el('div.picker-empty', { text: emptyText }));
      return;
    }
    let lastGroup;
    shown.forEach((item, i) => {
      if (grouped && !q.trim() && item.group !== lastGroup) {
        lastGroup = item.group;
        if (item.group) list.append(el('div.picker-group', { text: item.group }));
      }
      list.append(el(`button.picker-item${i === index ? '.active' : ''}`, {
        role: 'option',
        'aria-selected': String(i === index),
        onClick: () => finish?.(item),
        onMousemove: () => { if (index !== i) { index = i; highlight(); } },
        title: item.detail || item.label,
      },
      item.icon ? svgIcon(item.icon) : null,
      el('div.picker-text', null,
        el('div.picker-label', { text: item.label }),
        item.detail ? el('div.picker-detail', { text: item.detail }) : null),
      item.badge ? el('span.badge.neutral', { text: item.badge }) : null));
    });
  }

  function highlight() {
    [...list.querySelectorAll('.picker-item')].forEach((node, i) => {
      node.classList.toggle('active', i === index);
      node.setAttribute('aria-selected', String(i === index));
      if (i === index) node.scrollIntoView({ block: 'nearest' });
    });
  }

  input.addEventListener('input', () => { index = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { index = Math.min(shown.length - 1, index + 1); highlight(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { index = Math.max(0, index - 1); highlight(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (shown[index]) finish?.(shown[index]); e.preventDefault(); }
  });

  return customDialog({
    title,
    wide: true,
    build: (done) => {
      finish = done;
      render();
      requestAnimationFrame(() => input.focus());
      return el('div.picker', null,
        el('div.search-bar', null, svgIcon('search'), input),
        list,
        footer);
    },
    actions: [{ label: S.cancel, value: null }],
  });
}
