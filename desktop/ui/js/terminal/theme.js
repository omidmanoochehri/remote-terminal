/**
 * Terminal colour schemes: background, foreground, cursor, selection and the
 * 16 ANSI colours. Indices 16..255 are the standard xterm cube/greys shared by
 * every scheme.
 *
 * A port of `TerminalTheme.kt`; the same six schemes, the same values, so a
 * terminal looks identical on the phone and on the desktop.
 */

/** `#RRGGBB` or `#AARRGGBB` (the Kotlin ARGB form) → a CSS colour string. */
function css(argb) {
  const a = (argb >>> 24) & 0xff;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  if (a === 0xff) return `#${hex(r)}${hex(g)}${hex(b)}`;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

const hex = (v) => v.toString(16).padStart(2, '0');

export class TerminalTheme {
  constructor(id, name, background, foreground, cursor, selection, ansi, isLight = false) {
    this.id = id;
    this.name = name;
    this.background = css(background);
    this.foreground = css(foreground);
    this.cursor = css(cursor);
    this.selection = css(selection);
    this.isLight = isLight;
    /** CSS colours for palette indices 0..255. */
    this.palette = new Array(256);
    for (let i = 0; i < 16; i++) this.palette[i] = css(ansi[i] | 0xff000000);
    const steps = [0, 95, 135, 175, 215, 255];
    let idx = 16;
    for (let r = 0; r < 6; r++) {
      for (let g = 0; g < 6; g++) {
        for (let b = 0; b < 6; b++) {
          this.palette[idx++] = `#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`;
        }
      }
    }
    for (let i = 0; i < 24; i++) {
      const v = 8 + i * 10;
      this.palette[232 + i] = `#${hex(v)}${hex(v)}${hex(v)}`;
    }
  }
}

/**
 * The scheme the product is designed around: the same near-black navy as the
 * app surfaces, with the design system's green, blue, amber and violet as the
 * bright ANSI colours so terminal output sits inside the app rather than on
 * top of it.
 */
export const REMOTE = new TerminalTheme(
  'remote', 'Remote Terminal', 0xff040e19, 0xffd9e3ef, 0xff39e56d, 0x6635a8ff,
  [0x0a131e, 0xff6374, 0x39e56d, 0xffbd36, 0x35a8ff, 0xbf77ff, 0x4fd6e8, 0xcdd6df,
    0x52627a, 0xff8a96, 0x6ff39a, 0xffd277, 0x74c4ff, 0xd6a6ff, 0x86e8f5, 0xf3f7fb],
);

export const DARK = new TerminalTheme(
  'dark', 'Default Dark', 0xff0c0c0c, 0xffe6e6e6, 0xffe6e6e6, 0x663b82f6,
  [0x000000, 0xe5484d, 0x46a758, 0xe5c24d, 0x3b82f6, 0xb56ce0, 0x22b8cf, 0xd4d4d4,
    0x6b6b6b, 0xff6369, 0x5fd068, 0xffd866, 0x6fa8ff, 0xd48cf0, 0x4fd6e8, 0xffffff],
);

export const AMOLED = new TerminalTheme(
  'amoled', 'AMOLED', 0xff000000, 0xfff2f2f2, 0xfff2f2f2, 0x664f8cff,
  [0x000000, 0xff5555, 0x50fa7b, 0xf1fa8c, 0x6c8cff, 0xff79c6, 0x8be9fd, 0xe0e0e0,
    0x555555, 0xff7b7b, 0x7dff9e, 0xffffa5, 0x8fa8ff, 0xff92d0, 0xa4f0ff, 0xffffff],
);

export const LIGHT = new TerminalTheme(
  'light', 'Light', 0xfffcfcfc, 0xff1e1e1e, 0xff1e1e1e, 0x552563eb,
  [0x000000, 0xc0392b, 0x1e8449, 0xb7770d, 0x1f5fbf, 0x8e44ad, 0x148f9a, 0x5f5f5f,
    0x8a8a8a, 0xe74c3c, 0x27ae60, 0xd68910, 0x2e86de, 0xa569bd, 0x17a2b8, 0x000000],
  true,
);

export const SOLARIZED_DARK = new TerminalTheme(
  'solarized_dark', 'Solarized Dark', 0xff002b36, 0xff839496, 0xff93a1a1, 0x66268bd2,
  [0x073642, 0xdc322f, 0x859900, 0xb58900, 0x268bd2, 0xd33682, 0x2aa198, 0xeee8d5,
    0x002b36, 0xcb4b16, 0x586e75, 0x657b83, 0x839496, 0x6c71c4, 0x93a1a1, 0xfdf6e3],
);

export const GRUVBOX = new TerminalTheme(
  'gruvbox', 'Gruvbox Dark', 0xff282828, 0xffebdbb2, 0xffebdbb2, 0x66458588,
  [0x282828, 0xcc241d, 0x98971a, 0xd79921, 0x458588, 0xb16286, 0x689d6a, 0xa89984,
    0x928374, 0xfb4934, 0xb8bb26, 0xfabd2f, 0x83a598, 0xd3869b, 0x8ec07c, 0xebdbb2],
);

export const ALL_THEMES = [REMOTE, DARK, AMOLED, LIGHT, SOLARIZED_DARK, GRUVBOX];

export function themeById(id) {
  return ALL_THEMES.find((t) => t.id === id) || REMOTE;
}
