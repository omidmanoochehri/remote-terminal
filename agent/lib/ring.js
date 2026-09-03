'use strict';

/*
 * Bounded output history for one session, addressed by a monotonic stream
 * position (`seq`, counted in UTF-16 code units — the same unit JavaScript and
 * Kotlin strings use, so both ends agree without re-encoding).
 *
 * The buffer covers [base, head). Trimming cuts on a line or escape-sequence
 * boundary and never between surrogate halves, so a replay that starts at
 * `base` is renderable.
 */

const ESC = '\x1b';

class OutputRing {
  constructor(capacity) {
    this.capacity = Math.max(1024, capacity | 0);
    this.buf = '';
    this.base = 0;
    this.head = 0;
  }

  get size() { return this.buf.length; }

  append(data) {
    if (!data) return;
    this.buf += data;
    this.head += data.length;
    if (this.buf.length > this.capacity) this.trim();
  }

  trim() {
    const excess = this.buf.length - this.capacity;
    let cut = excess;
    const nl = this.buf.indexOf('\n', cut);
    if (nl !== -1 && nl - cut <= 4096) {
      cut = nl + 1;
    } else {
      const esc = this.buf.indexOf(ESC, cut);
      if (esc !== -1 && esc - cut <= 512) cut = esc;
    }
    if (cut > 0 && cut < this.buf.length) {
      const prev = this.buf.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) cut++; // do not split a surrogate pair
    }
    this.buf = this.buf.slice(cut);
    this.base += cut;
  }

  /**
   * The range a client should receive when attaching with `since`.
   * @returns {{from:number, data:string}} `from` is the stream position of data[0]
   */
  rangeFrom(since) {
    if (Number.isInteger(since) && since >= this.base && since <= this.head) {
      return { from: since, data: this.buf.slice(since - this.base) };
    }
    return { from: this.base, data: this.buf };
  }

  clear() { this.buf = ''; this.base = this.head; }
}

module.exports = { OutputRing };
