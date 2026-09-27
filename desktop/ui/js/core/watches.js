/**
 * Watches on a terminal's output: "tell me when this text appears" and "tell
 * me when it goes quiet". Both look only at live output — never at replayed
 * history, which would fire on something that happened an hour ago — and both
 * live with the tab, not with the screen, so they keep watching while you are
 * looking at something else.
 */

/** How long a terminal has to be silent before "went quiet" fires. */
export const QUIET_MS = 10_000;

/**
 * A case-insensitive substring match across chunk boundaries: the tail of the
 * previous chunk is kept, so a match split between two chunks is still found.
 */
export class TextWatch {
  constructor(text, keepWatching = false) {
    this.text = String(text);
    this.needle = this.text.toLowerCase();
    this.keepWatching = keepWatching;
    this.tail = '';
  }

  /** Feed live output; true when the text appeared. */
  feed(data) {
    if (!this.needle) return false;
    // Colour and cursor escapes would split a word the user can plainly see.
    const plain = stripEscapes(String(data)).toLowerCase();
    const hay = this.tail + plain;
    const hit = hay.includes(this.needle);
    const keep = Math.max(0, this.needle.length - 1);
    this.tail = hit ? '' : hay.slice(Math.max(0, hay.length - keep));
    return hit;
  }
}

/** Drop CSI / OSC / two-character escape sequences; what is left is what shows. */
export function stripEscapes(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/**
 * Fires once when output has been seen and then stops for [quietMs]. Arming
 * it on a silent terminal waits for the next output before counting.
 */
export class QuietWatch {
  constructor(onQuiet, { quietMs = QUIET_MS, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this.onQuiet = onQuiet;
    this.quietMs = quietMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.done = false;
  }

  feed() {
    if (this.done) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.done = true;
      this.onQuiet();
    }, this.quietMs);
  }

  cancel() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.done = true;
  }
}
