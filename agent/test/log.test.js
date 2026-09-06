'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeLogger, createFileSink, tee } = require('../lib/log');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-log-'));
}

test('the file sink writes JSON lines and creates its directory', () => {
  const dir = path.join(tmpdir(), 'logs');
  const sink = createFileSink({ dir });
  const log = makeLogger('info', null, sink.sink);
  log.info('hello', { agentToken: 'super-secret', data: 'xxxxx' });
  sink.close();

  const lines = fs.readFileSync(sink.path, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.strictEqual(rec.msg, 'hello');
  assert.strictEqual(rec.comp, 'agent');
  assert.strictEqual(rec.agentToken, '[redacted]', 'secrets never reach the log file');
  assert.strictEqual(rec.dataLen, 5, 'terminal payloads are reduced to a length');
  assert.ok(!('data' in rec));
});

test('the file sink rotates at maxBytes and keeps maxFiles generations', () => {
  const dir = path.join(tmpdir(), 'logs');
  const sink = createFileSink({ dir, maxBytes: 400, maxFiles: 3 });
  const log = makeLogger('info', null, sink.sink);
  for (let i = 0; i < 60; i++) log.info(`line ${i}`, { pad: 'y'.repeat(60) });
  sink.close();

  const files = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(files, ['agent.log', 'agent.log.1', 'agent.log.2'], 'older generations are dropped');
  for (const f of files) {
    const size = fs.statSync(path.join(dir, f)).size;
    assert.ok(size <= 400 + 200, `${f} stays near the cap (was ${size})`);
  }
  const last = fs.readFileSync(path.join(dir, 'agent.log'), 'utf8').trim().split('\n');
  assert.strictEqual(JSON.parse(last[last.length - 1]).msg, 'line 59', 'the newest line is in agent.log');
});

test('an unwritable log directory disables file logging once, without throwing', () => {
  const file = path.join(tmpdir(), 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const errors = [];
  const sink = createFileSink({ dir: file, onError: (err) => errors.push(err) });
  const log = makeLogger('info', null, sink.sink);
  log.info('one');
  log.info('two');
  assert.strictEqual(errors.length, 1, 'complains once, then stays quiet');
});

test('tee sends every line to both sinks and appends the file copy', () => {
  const dir = path.join(tmpdir(), 'logs');
  const sink = createFileSink({ dir });
  const console_ = [];
  const log = makeLogger('info', null, tee((l) => console_.push(l), sink.sink));
  log.warn('both');
  sink.close();

  // Reopening appends rather than truncating: a restart must not lose history.
  const again = createFileSink({ dir });
  makeLogger('info', null, again.sink).warn('after restart');
  again.close();

  assert.strictEqual(console_.length, 1);
  const lines = fs.readFileSync(sink.path, 'utf8').trim().split('\n');
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l).msg), ['both', 'after restart']);
});

test('levels below the threshold are dropped and child fields are bound', () => {
  const out = [];
  const log = makeLogger('warn', { sessionId: 's1' }, (l) => out.push(JSON.parse(l)));
  log.debug('nope');
  log.info('nope');
  log.warn('yes');
  log.child({ shell: 'bash' }).error('boom');
  assert.deepStrictEqual(out.map((r) => r.msg), ['yes', 'boom']);
  assert.strictEqual(out[0].sessionId, 's1');
  assert.strictEqual(out[1].shell, 'bash');
});
