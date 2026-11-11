/**
 * Session recordings in asciicast v2 — the format asciinema plays, so a
 * recording made here opens anywhere.
 *
 * A header line `{"version":2,"width":…,"height":…,"timestamp":…,"title":…}`
 * then one JSON array per event: `[seconds, "o", data]` for output and
 * `[seconds, "r", "COLSxROWS"]` for a resize. The recorder, the parser and the
 * player's timeline are pure so the tests can drive them with a fake clock.
 */

/** A recording stops itself at this size (the file, in UTF-8 bytes). */
export const CAST_MAX_BYTES = 16 * 1024 * 1024;

/** With "skip idle" on, no gap between two events plays longer than this. */
export const IDLE_CAP_S = 1;

export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Records one terminal. [startMs] is the wall-clock start; every event's time
 * is relative to it. Lines are handed out through `drain()` so the host can
 * append them to storage in batches rather than per chunk of output.
 */
export class CastRecorder {
  constructor({ cols, rows, title = '', startMs = Date.now(), maxBytes = CAST_MAX_BYTES }) {
    this.startMs = startMs;
    this.maxBytes = maxBytes;
    this.full = false;
    this.lastT = 0;
    this.pending = [];
    const header = { version: 2, width: cols, height: rows, timestamp: Math.floor(startMs / 1000) };
    if (title) header.title = title;
    this.bytes = 0;
    this.push(JSON.stringify(header));
  }

  push(line) {
    this.pending.push(`${line}\n`);
    this.bytes += utf8Length(line) + 1;
  }

  seconds(atMs) {
    const t = Math.max(this.lastT, (atMs - this.startMs) / 1000);
    this.lastT = t;
    return Math.round(t * 1e6) / 1e6;
  }

  /** Append an event unless it would pass the cap; false once the recording is full. */
  event(type, data, atMs) {
    if (this.full) return false;
    const line = JSON.stringify([this.seconds(atMs), type, data]);
    if (this.bytes + utf8Length(line) + 1 > this.maxBytes) {
      this.full = true;
      return false;
    }
    this.push(line);
    return true;
  }

  output(data, atMs = Date.now()) {
    if (!data) return !this.full;
    return this.event('o', String(data), atMs);
  }

  resize(cols, rows, atMs = Date.now()) {
    return this.event('r', `${cols}x${rows}`, atMs);
  }

  /** Seconds from the start to the last event. */
  get duration() { return this.lastT; }

  /** The lines recorded since the last drain, as one string. */
  drain() {
    const text = this.pending.join('');
    this.pending = [];
    return text;
  }
}

/**
 * Parse a recording. Resolves `{ header, events }` where each event is
 * `{ t, type, data }`; lines that are not valid events are skipped, as
 * asciinema does. Throws on a missing or unsupported header.
 */
export function parseCast(text) {
  const lines = String(text ?? '').split('\n');
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let header;
  try {
    header = JSON.parse(lines[first] ?? '');
  } catch {
    throw new Error('This is not an asciicast recording.');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || header.version !== 2) {
    throw new Error('Only asciicast version 2 recordings can be played.');
  }
  const width = Number.isInteger(header.width) && header.width > 0 ? header.width : 80;
  const height = Number.isInteger(header.height) && header.height > 0 ? header.height : 24;
  const events = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(e) || e.length < 3) continue;
    const [t, type, data] = e;
    if (typeof t !== 'number' || !Number.isFinite(t) || typeof type !== 'string' || typeof data !== 'string') continue;
    events.push({ t: Math.max(0, t), type, data });
  }
  // Times never go backwards on the timeline, even if a file says they do.
  let last = 0;
  for (const e of events) { if (e.t < last) e.t = last; last = e.t; }
  return { header: { ...header, width, height }, events };
}

/** `[cols, rows]` from a resize event's "COLSxROWS", or null. */
export function parseSize(data) {
  const m = /^(\d+)x(\d+)$/.exec(String(data));
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  return cols > 0 && rows > 0 ? [cols, rows] : null;
}

/**
 * The player's timeline: every event with `at`, the second it plays at. With
 * [skipIdle], any gap longer than [idleCap] seconds is shortened to it.
 */
export function buildTimeline(events, { skipIdle = true, idleCap = IDLE_CAP_S } = {}) {
  const out = [];
  let prevT = 0;
  let at = 0;
  for (const e of events) {
    let gap = e.t - prevT;
    if (skipIdle && gap > idleCap) gap = idleCap;
    at += Math.max(0, gap);
    prevT = e.t;
    out.push({ ...e, at });
  }
  return out;
}

export function timelineDuration(timeline) {
  return timeline.length ? timeline[timeline.length - 1].at : 0;
}

/** How many events play at or before [seconds] — the index of the next one to play. */
export function eventsUpTo(timeline, seconds) {
  let lo = 0;
  let hi = timeline.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline[mid].at <= seconds) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** "0:07", "12:03", "1:02:09". */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A file name for an exported recording. */
export function castFileName(title, startMs) {
  const d = new Date(startMs);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  const safe = String(title || 'recording').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 60) || 'recording';
  return `${safe}-${stamp}.cast`;
}
