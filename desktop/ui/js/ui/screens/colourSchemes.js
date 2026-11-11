/**
 * Settings → Terminal → Colour schemes: the built-in schemes and the user's
 * own. A new scheme starts as a copy of any existing one; user schemes can be
 * edited, deleted, copied out as Windows Terminal JSON, and imported from it.
 *
 * A port of `ColourSchemesFragment.kt`, with the editor (`SchemeEditorFragment.kt`).
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, headerAction, rowsCard, badge } from '../dom.js';
import { S } from '../strings.js';
import { menu, confirmDialog, promptDialog, chooseDialog, toast } from '../overlays.js';
import { copyToClipboard } from '../actions.js';
import { ALL_THEMES, allThemes, themeById } from '../../terminal/theme.js';
import {
  ANSI_KEYS, normalizeHex, parseSchemeImport, schemeFromTheme, schemeToWindowsTerminal, themeFromScheme,
} from '../../core/schemes.js';

/** A strip of the scheme's colours: background, foreground, then the 16 ANSI. */
function swatches(theme) {
  return el('div.scheme-swatches', { style: { background: theme.background } },
    el('span.scheme-sample', { text: 'Aa', style: { color: theme.foreground } }),
    theme.palette.slice(0, 16).map((c) => el('span.scheme-dot', { style: { background: c } })));
}

export function colourSchemesScreen(app) {
  const screen = new Screen(app, S.colourSchemes);
  const list = el('div');
  const root = el('div.screen', null,
    header({
      title: S.colourSchemes,
      subtitle: S.colourSchemesSubtitle,
      onBack: () => app.back(),
      actions: [
        headerAction('download', S.schemeImport, () => importSchemes()),
        headerAction('plus', S.schemeNew, () => newScheme()),
      ],
    }),
    el('div.screen-body.wide', null, list));

  function schemeRow(theme, user) {
    const inUse = app.settings.terminalTheme === theme.id;
    return el('div', { style: { display: 'flex', alignItems: 'center' } },
      el('button.row-item', {
        onClick: () => (user ? app.openSchemeEditor(theme.id) : useScheme(theme)),
        title: user ? S.schemeEdit : S.schemeUse,
      },
      el('div.row-text', null,
        el('div.row-title', { text: theme.name }),
        swatches(theme)),
      inUse ? badge(S.schemeInUse) : null),
      el('div', { style: { paddingRight: '8px' } },
        headerAction('more', S.more, (e) => rowMenu(e.currentTarget, theme, user))));
  }

  function render() {
    clear(list);
    list.append(el('div.section-label', { text: S.schemesBuiltIn }));
    list.append(rowsCard(ALL_THEMES.map((t) => schemeRow(t, false))));
    const mine = app.settings.customSchemes;
    list.append(el('div.section-label', { text: S.schemesMine }));
    if (mine.length > 0) list.append(rowsCard(mine.map((s) => schemeRow(themeById(s.id), true))));
    list.append(el('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
      el('button.button', { onClick: () => newScheme() }, svgIcon('plus'), el('span', { text: S.schemeNew })),
      el('button.button', { onClick: () => importSchemes() }, svgIcon('download'), el('span', { text: S.schemeImport }))));
  }

  function rowMenu(anchor, theme, user) {
    const scheme = user ? app.settings.customSchemes.find((s) => s.id === theme.id) : schemeFromTheme(theme, theme.name);
    menu(anchor, [
      { label: S.schemeUse, icon: 'check', onClick: () => useScheme(theme) },
      user ? { label: S.schemeEdit, icon: 'settings', onClick: () => app.openSchemeEditor(theme.id) } : null,
      { label: S.schemeNew, icon: 'copy', onClick: () => newScheme(theme) },
      { label: S.schemeCopyJson, icon: 'copy', onClick: () => copyToClipboard(JSON.stringify(schemeToWindowsTerminal(scheme), null, 2)) },
      user ? { divider: true } : null,
      user ? { label: S.delete, icon: 'trash', danger: true, onClick: () => remove(scheme) } : null,
    ]);
  }

  function useScheme(theme) {
    app.settings.terminalTheme = theme.id;
    toast(S.schemeSaved(theme.name));
  }

  async function newScheme(from = null) {
    let base = from;
    if (!base) {
      const chosen = await chooseDialog({
        title: S.schemeCopyFrom,
        options: allThemes().map((t) => [t.id, t.name]),
        selected: app.settings.terminalTheme,
      });
      if (chosen == null) return;
      base = themeById(chosen);
    }
    const name = await promptDialog({ title: S.schemeNew, label: S.schemeName, value: `${base.name} copy` });
    if (!name) return;
    const scheme = schemeFromTheme(base, name);
    app.settings.saveCustomScheme(scheme);
    app.openSchemeEditor(scheme.id);
  }

  async function importSchemes() {
    const text = await promptDialog({
      title: S.schemeImportTitle,
      body: S.schemeImportBody,
      multiline: true,
      confirmLabel: S.schemeImport,
    });
    if (!text) return;
    const { schemes, errors } = parseSchemeImport(text);
    if (schemes.length === 0) { toast(S.schemeImportFailed(errors[0] || ''), { error: true, ms: 6000 }); return; }
    app.settings.customSchemes = [...app.settings.customSchemes, ...schemes];
    toast(S.schemeImported(schemes.length));
    if (errors.length) toast(errors.join(' '), { error: true, ms: 6000 });
  }

  async function remove(scheme) {
    const ok = await confirmDialog({
      title: S.schemeDeleteTitle(scheme.name),
      body: S.schemeDeleteBody,
      confirmLabel: S.delete,
      danger: true,
    });
    if (ok) app.settings.deleteCustomScheme(scheme.id);
  }

  screen.listen(app.settings, 'changed', render);
  render();

  screen.root = root;
  return screen;
}

/**
 * The editor for one user scheme: its name and every colour as a hex field
 * with a swatch (a colour picker behind it), and a live preview.
 */
export function schemeEditorScreen(app, { id }) {
  const screen = new Screen(app, S.schemeEditTitle);
  const original = app.settings.customSchemes.find((s) => s.id === id);
  if (!original) {
    queueMicrotask(() => app.back());
    screen.root = el('div.screen');
    return screen;
  }
  const draft = { ...original };

  const preview = el('pre.scheme-preview');
  const nameInput = el('input', { type: 'text', value: draft.name });
  const errorNode = el('div.field-error.hidden', { text: S.schemeInvalidColour });

  function renderPreview() {
    const t = themeFromScheme(draft);
    const p = t.palette;
    preview.style.background = t.background;
    preview.style.color = t.foreground;
    const span = (text, color, extra = {}) => el('span', { text, style: { color, ...extra } });
    preview.replaceChildren(
      span('user@host', p[10]), span(':', t.foreground), span('~/project', p[12]), span('$ ', t.foreground),
      span('ls -la', t.foreground), '\n',
      span('drwxr-xr-x ', t.foreground), span('src', p[4]), '  ', span('build.sh', p[2]), '  ', span('notes.txt', t.foreground), '\n',
      span('error:', p[1]), span(' something failed', t.foreground), '  ', span('warning', p[3]), '  ', span('info', p[6]), '\n',
      span(' selected text ', t.foreground, { background: t.selection }), ' ', span('█', t.cursor), '\n',
      ...p.slice(0, 16).map((c) => span('■', c)));
  }

  function colourField(key, label) {
    const text = el('input', { type: 'text', value: draft[key], spellcheck: 'false', 'aria-label': label });
    const picker = el('input.scheme-picker', { type: 'color', value: draft[key], 'aria-label': label });
    text.addEventListener('input', () => {
      const hex = normalizeHex(text.value);
      text.classList.toggle('invalid', !hex);
      if (!hex) return;
      draft[key] = hex;
      picker.value = hex;
      renderPreview();
    });
    picker.addEventListener('input', () => {
      draft[key] = picker.value;
      text.value = picker.value;
      text.classList.remove('invalid');
      renderPreview();
    });
    return el('label.scheme-field', null,
      el('span.scheme-field-label', { text: label }),
      el('div.field-well', null, picker, text));
  }

  const body = el('div.screen-body.wide', null,
    el('div.section-label', { text: S.previewLabel }),
    preview,
    el('div.field', null,
      el('label.field-label', { text: S.schemeName }),
      el('div.field-well', null, nameInput)),
    el('div.scheme-grid', null,
      colourField('background', S.schemeBackground),
      colourField('foreground', S.schemeForeground),
      colourField('cursorColor', S.schemeCursor),
      colourField('selectionBackground', S.schemeSelection)),
    el('div.section-label', { text: S.schemeAnsi }),
    el('div.scheme-grid', null, ANSI_KEYS.map((key, i) => colourField(key, S.schemeColourNames[i]))),
    errorNode,
    el('div', { style: { display: 'flex', gap: '8px', marginTop: '18px' } },
      el('button.cta.auto', { onClick: () => save() }, svgIcon('save'), el('span', { text: S.save })),
      el('button.button', {
        onClick: () => copyToClipboard(JSON.stringify(schemeToWindowsTerminal(draft), null, 2)),
      }, svgIcon('copy'), el('span', { text: S.schemeCopyJson }))));

  const root = el('div.screen', null,
    header({ title: S.schemeEditTitle, subtitle: original.name, onBack: () => app.back() }),
    body);

  function save() {
    if (body.querySelector('input.invalid')) { errorNode.classList.remove('hidden'); return; }
    const name = nameInput.value.trim() || original.name;
    const scheme = { ...draft, name };
    app.settings.saveCustomScheme(scheme);
    toast(S.schemeSaved(name));
    app.back();
  }

  renderPreview();
  screen.root = root;
  return screen;
}
