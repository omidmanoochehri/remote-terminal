/**
 * Cell attribute bits and colour encoding, shared by the emulator, the row
 * store and the renderer. Values match `TerminalEmulator.kt` exactly so the
 * ported emulator tests compare like for like.
 */

/** "no colour chosen": the theme's foreground or background applies. */
export const DEFAULT = -1;
/** Bit 24 marks a packed 24-bit RGB value rather than a palette index. */
export const TRUECOLOR = 1 << 24;

export const BOLD = 1;
export const DIM = 1 << 1;
export const ITALIC = 1 << 2;
export const UNDERLINE = 1 << 3;
export const BLINK = 1 << 4;
export const REVERSE = 1 << 5;
export const HIDDEN = 1 << 6;
export const STRIKE = 1 << 7;
/** Left half of a double-width glyph. */
export const WIDE = 1 << 8;
/** Right half of a double-width glyph; carries no code point of its own. */
export const CONTINUATION = 1 << 9;

export const CURSOR_BLOCK = 0;
export const CURSOR_UNDERLINE = 1;
export const CURSOR_BAR = 2;

export const MOUSE_OFF = 0;
export const MOUSE_PRESS = 1000;
export const MOUSE_BUTTON = 1002;
export const MOUSE_ANY = 1003;

export const MOUSE_EVENT_PRESS = 0;
export const MOUSE_EVENT_RELEASE = 1;
export const MOUSE_EVENT_MOTION = 2;
export const MOUSE_EVENT_WHEEL_UP = 3;
export const MOUSE_EVENT_WHEEL_DOWN = 4;
