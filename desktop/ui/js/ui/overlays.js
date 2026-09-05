/**
 * Dialogs, context menus and toasts — the desktop stand-ins for the phone's
 * Material dialogs, popup menus and snackbars. Every destructive action still
 * asks first, with the same wording, and every menu offers the same items in
 * the same order wherever it is opened from.
 */

import { el, clear, svgIcon } from './dom.js';
import { S } from './strings.js';

let scrim = null;
let openMenu = null;

/**
 * A menu or a dialog that has just appeared ignores clicks for a moment.
 *
 * Without it the second half of a double-click — on the ⋮ that opened the menu,
 * or on the menu item that opened the dialog — lands on whatever is now under
 * the cursor, which is how someone accidentally confirms "Remove machine".
 * Nothing destructive should ever be one stray click away.
 */
const SETTLE_MS = 300;

function guardActivation(node) {
  const openedAt = performance.now();
  const swallow = (e) => {
    if (performance.now() - openedAt >= SETTLE_MS) return;
    e.stopPropagation();
    e.preventDefault();
  };
  for (const type of ['mousedown', 'mouseup', 'click']) {
    node.addEventListener(type, swallow, true);
  }
}

/* ------------------------------- dialogs -------------------------------- */

function showDialog(build) {
  return new Promise((resolve) => {
    closeMenu();
    const done = (value) => {
      if (scrim) { scrim.remove(); scrim = null; }
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    };
    document.addEventListener('keydown', onKey, true);

    const dialog = build(done);
    guardActivation(dialog);
    scrim = el('div.scrim', {
      onMousedown: (e) => { if (e.target === scrim) done(null); },
    }, dialog);
    document.body.append(scrim);

    const focusable = dialog.querySelector('input, textarea, button.cta, button');
    focusable?.focus();
    if (focusable instanceof HTMLInputElement) focusable.select();
  });
}

/** A message with an OK button. Resolves when it is dismissed. */
export function alertDialog(title, body, okLabel = S.ok) {
  return showDialog((done) =>
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      body ? el('p', { text: body }) : null,
      el('div.dialog-actions', null,
        el('button.button', { onClick: () => done(true) }, el('span', { text: okLabel })))));
}

/** Resolves true when confirmed. [danger] paints the confirm button red. */
export function confirmDialog({ title, body, confirmLabel = S.ok, cancelLabel = S.cancel, danger = false }) {
  return showDialog((done) =>
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      body ? el('p', { text: body }) : null,
      el('div.dialog-actions', null,
        el('button.button', { onClick: () => done(false) }, el('span', { text: cancelLabel })),
        el(`button.button${danger ? '.danger' : ''}`, { onClick: () => done(true) },
          el('span', { text: confirmLabel })))));
}

/** A single text field. Resolves to the trimmed text, or null when cancelled. */
export function promptDialog({ title, body, label, value = '', placeholder = '', confirmLabel = S.save, multiline = false }) {
  return showDialog((done) => {
    const input = multiline
      ? el('textarea.plain', { placeholder, value })
      : el('input', { type: 'text', placeholder, value });
    const submit = () => {
      const text = String(input.value).trim();
      done(text.length > 0 ? text : null);
    };
    if (!multiline) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
    return el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      body ? el('p', { text: body }) : null,
      el('div.dialog-body', null,
        label ? el('label.field-label', { text: label }) : null,
        multiline ? input : el('div.field-well', null, input)),
      el('div.dialog-actions', null,
        el('button.button', { onClick: () => done(null) }, el('span', { text: S.cancel })),
        el('button.button', { onClick: submit }, el('span', { text: confirmLabel }))));
  });
}

/**
 * A single-choice list, as the phone's `setSingleChoiceItems` dialogs.
 * `options` is `[value, label, description?]`; resolves to the chosen value.
 */
export function chooseDialog({ title, body, options, selected }) {
  return showDialog((done) =>
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      body ? el('p', { text: body }) : null,
      el('div.dialog-body', null,
        options.map(([value, label, description]) =>
          el('button.choice', {
            role: 'radio',
            'aria-checked': String(value === selected),
            onClick: () => done(value),
          },
          el('div', { class: 'spacer' },
            el('div', { text: label }),
            description ? el('div.choice-desc', { text: description }) : null),
          value === selected ? svgIcon('check') : null))),
      el('div.dialog-actions', null,
        el('button.button', { onClick: () => done(null) }, el('span', { text: S.cancel })))));
}

/**
 * A list of actions with a description each, as the phone's `setItems`
 * dialogs (closing a tab: keep running or terminate). Resolves to the index.
 */
export function actionsDialog({ title, items }) {
  return showDialog((done) =>
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      el('div.dialog-body', null,
        items.map((item, index) =>
          el('button.choice', { onClick: () => done(index) },
            el('div', null,
              el('div', { text: item.label }),
              item.description ? el('div.choice-desc', { text: item.description }) : null)))),
      el('div.dialog-actions', null,
        el('button.button', { onClick: () => done(null) }, el('span', { text: S.cancel })))));
}

/** A dialog whose body the caller builds (the pairing code, the shortcuts sheet). */
export function customDialog({ title, build, actions }) {
  return showDialog((done) =>
    el('div.dialog', { role: 'dialog', 'aria-modal': 'true' },
      el('h2', { text: title }),
      el('div.dialog-body', null, build(done)),
      el('div.dialog-actions', null,
        (actions ?? [{ label: S.ok, value: true }]).map((a) =>
          el(`button.button${a.danger ? '.danger' : ''}`, { onClick: () => done(a.value) },
            el('span', { text: a.label }))))));
}

/* -------------------------------- menus --------------------------------- */

export function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('blur', () => closeMenu());

/**
 * A context menu anchored to [anchor]. `items` are
 * `{ label, icon?, checked?, danger?, divider?, onClick }`.
 */
export function menu(anchor, items) {
  closeMenu();
  const node = el('div.menu', { role: 'menu' },
    items.filter(Boolean).map((item) => {
      if (item.divider) return el('div.menu-divider');
      return el(`button${item.danger ? '.danger' : ''}`, {
        role: 'menuitem',
        onClick: () => { closeMenu(); item.onClick?.(); },
      },
      item.icon ? svgIcon(item.icon) : null,
      el('span', { class: 'spacer', text: item.label }),
      item.checked ? svgIcon('check', 'check') : null);
    }));
  guardActivation(node);
  document.body.append(node);

  const rect = anchor.getBoundingClientRect();
  const size = node.getBoundingClientRect();
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - size.width - 8);
  const below = rect.bottom + 6;
  const top = below + size.height > window.innerHeight - 8
    ? Math.max(8, rect.top - size.height - 6)
    : below;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  openMenu = node;
  return node;
}

/* -------------------------------- toasts -------------------------------- */

let toastHost = null;

export function toast(message, { error = false, ms = 3200 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { id: 'toasts' });
    document.body.append(toastHost);
  }
  const node = el(`div.toast${error ? '.error' : ''}`, { text: message });
  toastHost.append(node);
  setTimeout(() => node.remove(), ms);
}

export function clearOverlays() {
  closeMenu();
  if (scrim) { scrim.remove(); scrim = null; }
  if (toastHost) clear(toastHost);
}
