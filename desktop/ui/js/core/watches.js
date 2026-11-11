/**
 * Watches on a terminal's output: "tell me when this text appears" and "tell
 * me when it goes quiet". Both look only at live output — never at replayed
 * history, which would fire on something that happened an hour ago — and both
 * live with the tab, not with the screen, so they keep watching while you are
 * looking at something else.
 */

/** How long a terminal has to be silent before "went quiet" fires. */
export const QUIET_MS = 10_000;

/** A trigger replies at most this often, however often its text appears. */
export const TRIGGER_INTERVAL_MS = 2000;

/**
 * A case-insensitive match across chunk boundaries: the tail of the previous
 * chunk is kept, so a match split between two chunks is still found.
 *
 * With [regex] the text is a regular expression (still case-insensitive).
 * With [reply] the watch is a trigger: when it matches, the reply is typed into
 * the terminal — at most once every two seconds, so a reply that echoes its own
 * pattern cannot run away.
 */
export class TextWatch {
  constructor(text, keepWatching = false, { regex = false, reply = null } = {}) {
    this.text = String(text);
    this.needle = this.text.toLowerCase();
    this.keepWatching = keepWatching;
    this.regex = regex ? new RegExp(this.text, 'i') : null;
    this.reply = reply ? String(reply) : null;
    this.lastFired = -Infinity;
    this.tail = '';
  }

  /** Feed live output; true when the text appeared. */
  feed(data) {
    if (!this.needle) return false;
    // Colour and cursor escapes would split a word the user can plainly see.
    const plain = stripEscapes(String(data));
    const hay = this.tail + plain;
    let hit;
    let keep;
    if (this.regex) {
      hit = this.regex.test(hay);
      keep = 256;
    } else {
      hit = hay.toLowerCase().includes(this.needle);
      keep = Math.max(0, this.needle.length - 1);
    }
    this.tail = hit ? '' : hay.slice(Math.max(0, hay.length - keep));
    return hit;
  }

  /**
   * Whether a trigger may fire now; records the firing when it may. A watch
   * without a reply is never limited.
   */
  allowFire(now = Date.now()) {
    if (!this.reply) return true;
    if (now - this.lastFired < TRIGGER_INTERVAL_MS) return false;
    this.lastFired = now;
    return true;
  }
}

/** Null when [pattern] is usable as a watch's regular expression, else the reason. */
export function regexError(pattern) {
  if (!String(pattern ?? '')) return 'Empty pattern';
  try {
    const re = new RegExp(pattern, 'i');
    // A pattern that matches the empty string would fire on every chunk.
    if (re.test('')) return 'The pattern matches empty text';
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}

/**
 * A trigger's reply as typed: `\r`, `\n`, `\t`, `\e` (ESC) and `\\` are
 * understood; any other backslash is kept as written.
 */
export function decodeReply(text) {
  const map = { r: '\r', n: '\n', t: '\t', e: '\x1b', '\\': '\\' };
  let out = '';
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && map[s[i + 1]] != null) {
      out += map[s[i + 1]];
      i++;
    } else {
      out += c;
    }
  }
  return out;
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
