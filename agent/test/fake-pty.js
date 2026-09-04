'use strict';

/** An in-memory stand-in for pty.js handles, for deterministic tests. */
function makeFakeSpawn() {
  const spawned = [];
  function spawn(opts) {
    const h = {
      mode: 'fake', pid: 1000 + spawned.length, opts, cols: opts.cols, rows: opts.rows,
      written: [], killed: false, paused: false, exited: false,
      dataCbs: [], exitCbs: [],
      write(d) { this.written.push(d); },
      resize(c, r) { this.cols = c; this.rows = r; },
      kill() { this.killed = true; this.emitExit(137); },
      pause() { this.paused = true; },
      resume() { this.paused = false; },
      onData(cb) { this.dataCbs.push(cb); },
      onExit(cb) { this.exitCbs.push(cb); },
      emitData(d) { for (const cb of this.dataCbs) cb(d); },
      emitExit(code) { if (this.exited) return; this.exited = true; for (const cb of this.exitCbs) cb(code); },
    };
    spawned.push(h);
    return h;
  }
  return { spawn, spawned };
}

const SHELLS = [
  { id: 'bash', label: 'bash', cmd: '/bin/bash', args: [], default: true },
  { id: 'sh', label: 'sh', cmd: '/bin/sh', args: [], default: false },
];

function testConfig(over) {
  return Object.assign({
    replayBytes: 4096, coalesceMs: 5, maxChunk: 1024, maxSessions: 3, maxInputBytes: 1000,
    idleTimeoutSec: 3600, exitedRetentionSec: 60, inheritEnv: false,
    server: 'ws://127.0.0.1:1', name: '', baseBackoffMs: 10, maxBackoffMs: 50,
    backpressureHighBytes: 1 << 20, backpressureLowBytes: 1 << 16, metricsIntervalMs: 0,
  }, over);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeFakeSpawn, SHELLS, testConfig, sleep };
