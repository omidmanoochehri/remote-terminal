'use strict';

/*
 * Persisted relay state: accounts, agents and devices (identity records with
 * token hashes and metadata). Sessions are NOT persisted here — agents are the
 * source of truth for sessions and re-announce them on every connect.
 *
 * Writes are debounced and atomic (tmp file + rename) and the file is created
 * with mode 0600 because it holds credential hashes.
 */

const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, accounts: {}, agents: {}, devices: {} };
}

class State {
  constructor(file, log, { debounceMs = 500 } = {}) {
    this.file = file;
    this.log = log;
    this.debounceMs = debounceMs;
    this.data = emptyState();
    this.timer = null;
    this.dirty = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      this.data = Object.assign(emptyState(), parsed);
      if (this.data.version !== STATE_VERSION) {
        this.log.warn('state file version differs; loading best-effort', { found: this.data.version, expected: STATE_VERSION });
        this.data.version = STATE_VERSION;
      }
      this.log.info('state loaded', {
        file: this.file,
        accounts: Object.keys(this.data.accounts).length,
        agents: Object.keys(this.data.agents).length,
        devices: Object.keys(this.data.devices).length,
      });
    } catch (err) {
      if (err.code === 'ENOENT') this.log.info('no state file yet; starting empty', { file: this.file });
      else this.log.error('failed to load state file; starting empty', { file: this.file, err: err.message });
      this.data = emptyState();
    }
    return this;
  }

  /** Schedule a debounced write. */
  save() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** Write synchronously (used on shutdown and after security-relevant changes). */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log.error('failed to write state file', { file: this.file, err: err.message });
    }
  }
}

module.exports = { State, STATE_VERSION, emptyState };
