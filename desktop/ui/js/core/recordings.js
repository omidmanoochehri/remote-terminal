/**
 * Session recordings: which terminals are recording, and the list of finished
 * recordings on this device.
 *
 * A recording is the terminal's output as the emulator is fed it, with its
 * timing, in asciicast v2 (core/asciicast.js). Lines are appended to the
 * recording's file in batches (about once a second) so a long, chatty session
 * does not cross the bridge per chunk. The index — title, machine, date,
 * duration, size — is a small JSON file of its own.
 */

import { Emitter } from './emitter.js';
import { CastRecorder } from './asciicast.js';
import { recordingFiles, store } from './platform.js';

const FLUSH_MS = 1000;

function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${Date.now().toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class Recordings extends Emitter {
  constructor(sessions) {
    super();
    this.sessions = sessions;
    /** Finished and in-progress recordings, newest first: { id, title, machine, startedAt, duration, size }. */
    this.list = [];
    /** Recording state per terminal key: { id, recorder, timer, entry, chain }. */
    this.active = new Map();
    /** The host shows a notice when a recording stops on its own (set by the app). */
    this.onAutoStop = null;
    this.onError = null;

    sessions.on('recordOutput', (s, data) => this.onOutput(s, data));
    sessions.on('recordResize', (s, cols, rows) => {
      const a = this.active.get(s.key);
      if (a && !a.recorder.resize(cols, rows)) this.stop(s, true);
    });
    sessions.on('tabs', () => {
      // A tab that closed while recording finishes its recording.
      for (const key of [...this.active.keys()]) {
        const s = this.active.get(key).session;
        if (!sessions.sessions.has(key)) this.stop(s);
      }
    });
  }

  async load() {
    try {
      const raw = await store.read('recordings');
      const parsed = raw ? JSON.parse(raw) : [];
      this.list = Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === 'string') : [];
    } catch {
      this.list = [];
    }
    return this;
  }

  saveIndex() {
    const finished = this.list.filter((r) => !this.isActiveId(r.id));
    store.write('recordings', JSON.stringify(finished, null, 1)).catch(() => {});
    this.emit('changed');
  }

  isActiveId(id) {
    for (const a of this.active.values()) if (a.id === id) return true;
    return false;
  }

  isRecording(s) { return !!s && this.active.has(s.key); }

  /** Start recording [s]; [machine] names the machine in the list. */
  start(s, machine = '') {
    if (this.active.has(s.key)) return;
    const startedAt = Date.now();
    const recorder = new CastRecorder({
      cols: s.emulator.cols, rows: s.emulator.rows, title: s.displayTitle, startMs: startedAt,
    });
    const entry = { id: newId(), title: s.displayTitle, machine, startedAt, duration: 0, size: 0 };
    const a = { id: entry.id, recorder, entry, session: s, chain: Promise.resolve(), timer: null };
    a.timer = setInterval(() => this.flush(a), FLUSH_MS);
    this.active.set(s.key, a);
    this.list.unshift(entry);
    this.flush(a);
    s.bump();
    this.emit('changed');
  }

  onOutput(s, data) {
    const a = this.active.get(s.key);
    if (!a) return;
    if (!a.recorder.output(data)) this.stop(s, true);
  }

  /** Write what has been recorded so far; appends are chained so they land in order. */
  flush(a) {
    const text = a.recorder.drain();
    if (!text) return a.chain;
    a.chain = a.chain
      .then(() => recordingFiles.append(a.id, text))
      .then((size) => { a.entry.size = size; })
      .catch((err) => {
        this.onError?.(String(err?.message || err));
      });
    return a.chain;
  }

  /** Stop recording [s]; [full] when it stopped itself at the size cap. */
  async stop(s, full = false) {
    const a = this.active.get(s.key);
    if (!a) return null;
    clearInterval(a.timer);
    this.active.delete(s.key);
    a.entry.duration = a.recorder.duration;
    await this.flush(a);
    this.saveIndex();
    s.bump();
    if (full) this.onAutoStop?.(a.entry);
    return a.entry;
  }

  entry(id) { return this.list.find((r) => r.id === id) ?? null; }

  rename(id, title) {
    const r = this.entry(id);
    if (!r) return;
    r.title = title;
    this.saveIndex();
  }

  async remove(id) {
    if (this.isActiveId(id)) return;
    this.list = this.list.filter((r) => r.id !== id);
    await recordingFiles.remove(id).catch(() => {});
    this.saveIndex();
  }

  read(id) { return recordingFiles.read(id); }

  exportTo(id, path) { return recordingFiles.exportTo(id, path); }
}
