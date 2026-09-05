/**
 * Builds the settings screens: a group label, a card, and rows that either open
 * something or toggle something. Screens describe what they want; the spacing,
 * dividers and colours are decided here once.
 *
 * A port of `SettingsBuilder.kt`, including its search filter: a section whose
 * rows were all filtered out leaves nothing behind.
 */

import { el, svgIcon, switchEl } from './dom.js';

export class SettingsBuilder {
  constructor(container, query = '') {
    this.container = container;
    this.needle = String(query).trim().toLowerCase();
    this.card = null;
    this.label = null;
    this.rowsInCard = 0;
    this.isEmpty = true;
  }

  matches(...text) {
    if (!this.needle) return true;
    return text.some((t) => t != null && String(t).toLowerCase().includes(this.needle));
  }

  dropEmptySection() {
    if (this.rowsInCard > 0) return;
    this.label?.remove();
    this.card?.remove();
    this.label = null;
    this.card = null;
  }

  /** Start a new section with an uppercase group label above its card. */
  section(title) {
    this.dropEmptySection();
    this.label = el('div.section-label', { text: title });
    this.card = el('div.card', { style: { overflow: 'hidden' } });
    this.container.append(this.label, this.card);
    this.rowsInCard = 0;
    return this;
  }

  /** Call after the last section so a trailing empty group is not left behind. */
  finish() {
    this.dropEmptySection();
    return this;
  }

  newRow(iconName, colorVar, title, subtitle) {
    if (this.rowsInCard > 0) this.card.append(el('div.divider'));
    const row = el('button.settings-row', null,
      el('div.icon-well', {
        style: {
          background: `color-mix(in srgb, var(${colorVar}) 10%, transparent)`,
          color: `var(${colorVar})`,
        },
      }, svgIcon(iconName)),
      el('div.settings-text', null,
        el('div.settings-title', { text: title }),
        subtitle ? el('div.settings-subtitle', { text: subtitle }) : null));
    this.card.append(row);
    this.rowsInCard++;
    this.isEmpty = false;
    return row;
  }

  /** A row that opens something: trailing value plus a chevron. */
  row(iconName, colorVar, title, subtitle, value, onClick, { enabled = true } = {}) {
    if (!this.matches(title, subtitle, value)) return this;
    const row = this.newRow(iconName, colorVar, title, subtitle);
    if (value != null) row.append(el('div.settings-value', { text: String(value) }));
    row.append(svgIcon('chevron_right'));
    row.disabled = !enabled;
    row.title = [title, subtitle, value].filter(Boolean).join(' · ');
    if (enabled) row.addEventListener('click', (e) => onClick(e));
    return this;
  }

  /** A row that toggles something. The whole row is the target. */
  toggle(iconName, colorVar, title, subtitle, checked, onChange, { enabled = true } = {}) {
    if (!this.matches(title, subtitle)) return this;
    const row = this.newRow(iconName, colorVar, title, subtitle);
    const knob = switchEl(checked);
    row.append(knob);
    row.disabled = !enabled;
    row.title = [title, subtitle].filter(Boolean).join(' · ');
    if (enabled) {
      row.addEventListener('click', () => {
        const next = knob.getAttribute('aria-checked') !== 'true';
        knob.setAttribute('aria-checked', String(next));
        onChange(next);
      });
    }
    return this;
  }

  /** Centred footnote under the last card (version, protocol). */
  footnote(text) {
    this.dropEmptySection();
    if (this.needle) return this;
    this.container.append(el('div', {
      text,
      style: {
        textAlign: 'center',
        fontSize: '8.5px',
        color: 'var(--text-dim)',
        margin: '34px 0 12px',
      },
    }));
    return this;
  }
}
