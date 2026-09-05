/**
 * The handful of DOM helpers the screens are built from. There is no framework
 * here on purpose: the app is a fixed set of screens over a live model, and a
 * builder plus an explicit re-render is easier to follow — and to keep in step
 * with the Android layouts — than a virtual DOM.
 */

import { icon } from './icons.js';

/**
 * `el('div.card.pad', { onClick }, child, child)`. The first argument is a tag
 * with optional `.class` suffixes; props are attributes, `dataset`, `style` or
 * `onEvent` handlers; children are nodes, strings, or nested arrays.
 */
export function el(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  if (props) applyProps(node, props);
  append(node, children);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = [node.className, value].filter(Boolean).join(' ');
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) { append(node, child); continue; }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** An `<svg>` node for a named icon, ready to drop into a row. */
export function svgIcon(name, className = '') {
  const wrap = document.createElement('span');
  wrap.innerHTML = icon(name, className);
  return wrap.firstElementChild ?? document.createComment(`missing icon: ${name}`);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(container, ...children) {
  clear(container);
  append(container, children);
  return container;
}

/* --------------------------- shared components -------------------------- */

/**
 * The top-level screen header: the app mark, a title with a supporting line,
 * and up to three trailing actions. Actions with no handler are left out
 * rather than shown disabled, exactly as the phone hides them.
 */
export function header({ title, subtitle, mark = 'terminal_square', onBack, actions = [] }) {
  return el('header.header', null,
    onBack
      ? el('button.icon-button', { onClick: onBack, title: 'Back', 'aria-label': 'Back' }, svgIcon('arrow_left'))
      : el('div.header-mark', null, svgIcon(mark)),
    el('div.header-text', null,
      el('div.header-title', { text: title }),
      // Always present, even when empty: screens that fill the header in later
      // (Machine, Machine settings) hold on to this node. CSS hides it while
      // it has no text, so an empty subtitle still costs nothing.
      el('div.header-subtitle', { text: subtitle ?? '' })),
    ...actions.filter(Boolean));
}

export function headerAction(iconName, label, onClick, extraClass = '') {
  return el(`button.icon-button${extraClass ? `.${extraClass}` : ''}`, {
    onClick, title: label, 'aria-label': label,
  }, svgIcon(iconName));
}

/** A presence dot plus its label; the label always says the same thing in words. */
export function presenceLine(label, tone) {
  return el('div.machine-status', null,
    el(`span.dot.tone-${tone}`),
    el('span', { class: `tone-${tone}`, text: label }));
}

/**
 * The shared empty / no-results / offline / error block. [tone] carries the
 * mood: neutral for "nothing here", green for success, amber/red for a problem.
 */
export function stateBlock({ icon: iconName, title, body, actionLabel, actionIcon = 'plus', onAction, tone = '' }) {
  return el('div.state-block', null,
    el('div.state-icon', { class: tone ? `tone-${tone}` : '' }, svgIcon(iconName)),
    el('h3', { text: title }),
    el('p', { text: body }),
    actionLabel && onAction
      ? el('button.button', { onClick: onAction }, svgIcon(actionIcon), el('span', { text: actionLabel }))
      : null);
}

/** A card with rows separated by hairlines, as every list on the phone draws them. */
export function rowsCard(rows) {
  const kept = rows.filter(Boolean);
  const card = el('div.card.rows-card');
  kept.forEach((row, i) => {
    if (i > 0) card.append(el('div.divider'));
    card.append(row);
  });
  return card;
}

export function meter(fraction, colorVar = '--primary') {
  const bar = el('span');
  bar.style.width = fraction != null && fraction > 0 ? `${Math.min(100, fraction * 100)}%` : '0';
  bar.style.background = `var(${colorVar})`;
  return el('div.meter', null, bar);
}

export function switchEl(checked) {
  return el('span.switch', { role: 'switch', 'aria-checked': String(!!checked) });
}

export function badge(text, neutral = false) {
  return el(`span.badge${neutral ? '.neutral' : ''}`, { text });
}

/** Debounce a handler; used by every search box so typing does not re-render per keystroke. */
export function debounce(fn, ms = 120) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}
