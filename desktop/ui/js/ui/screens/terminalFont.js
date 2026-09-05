/**
 * Terminal typography and cursor. Split out of the settings list because the
 * choices only make sense next to a live preview.
 *
 * A port of `TerminalFontFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, header } from '../dom.js';
import { SettingsBuilder } from '../settingsBuilder.js';
import { S, CHOICES, labelFor } from '../strings.js';
import { chooseDialog } from '../overlays.js';
import { themeById } from '../../terminal/theme.js';
import { FONT_SYSTEM } from '../../core/settings.js';

export function terminalFontScreen(app) {
  const screen = new Screen(app, S.terminalFontTitle);
  const s = app.settings;

  const preview = el('div', {
    text: S.fontPreviewText,
    style: {
      padding: '18px',
      borderRadius: 'var(--r-card)',
      border: '1px solid var(--outline)',
      marginBottom: '6px',
      whiteSpace: 'pre',
      overflow: 'hidden',
    },
  });
  const sections = el('div');
  const body = el('div.screen-body.wide', null,
    el('div.section-label', { text: S.previewLabel }),
    preview,
    sections);

  const root = el('div.screen', null,
    header({ title: S.terminalFontTitle, onBack: () => app.back() }),
    body);

  async function choose(title, choices, current, apply) {
    const chosen = await chooseDialog({ title, options: choices, selected: current });
    if (chosen == null) return;
    apply(chosen);
    build();
  }

  function renderPreview() {
    const theme = themeById(s.terminalTheme);
    preview.style.fontFamily = s.terminalFontFamily === FONT_SYSTEM
      ? "ui-monospace, 'Cascadia Mono', Consolas, monospace"
      : "'RT Mono', ui-monospace, Consolas, monospace";
    preview.style.fontSize = `${s.fontSize}px`;
    preview.style.lineHeight = String(s.lineSpacing * 1.28);
    preview.style.color = theme.foreground;
    preview.style.background = theme.background;
  }

  function build() {
    renderPreview();
    clear(sections);
    const b = new SettingsBuilder(sections);

    b.section(S.settingTerminalFont)
      .row('font', '--accent', S.fontFamilyLabel, null,
        labelFor(CHOICES.fontFamily, s.terminalFontFamily),
        () => choose(S.fontFamilyLabel, CHOICES.fontFamily, s.terminalFontFamily, (v) => { s.terminalFontFamily = v; }))
      .row('font', '--primary', S.fontSizeLabel, null, String(s.fontSize),
        () => choose(S.fontSizeLabel, CHOICES.fontSize, s.fontSize, (v) => { s.fontSize = v; }))
      .row('panel_top', '--purple', S.lineSpacingLabel, null,
        labelFor(CHOICES.lineSpacing, s.lineSpacing),
        () => choose(S.lineSpacingLabel, CHOICES.lineSpacing, s.lineSpacing, (v) => { s.lineSpacing = v; }));

    b.section(S.settingTerminalColours)
      .row('moon_star', '--primary', S.settingTerminalColours, null,
        labelFor(CHOICES.terminalTheme, s.terminalTheme),
        () => choose(S.settingTerminalColours, CHOICES.terminalTheme, s.terminalTheme, (v) => { s.terminalTheme = v; }))
      .row('command', '--accent', S.settingCursor, null,
        labelFor(CHOICES.cursorStyle, s.cursorStyle),
        () => choose(S.settingCursor, CHOICES.cursorStyle, s.cursorStyle, (v) => { s.cursorStyle = v; }))
      .toggle('activity', '--amber', S.cursorBlinkLabel, null, s.cursorBlink, (v) => { s.cursorBlink = v; build(); });

    b.finish();
  }

  screen.listen(app.settings, 'changed', build);
  build();

  screen.root = root;
  return screen;
}
