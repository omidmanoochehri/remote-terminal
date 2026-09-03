'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UploadManager, safeName } = require('../lib/uploads');
const { makeLogger } = require('../lib/log');

const log = makeLogger('silent');

function setup(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-up-'));
  const cfg = Object.assign({ uploadsDir: path.join(dir, 'uploads'), maxUploadBytes: 1024, maxUploads: 2, uploadTimeoutSec: 60 }, over);
  const clock = { t: 1_000_000 };
  return { mgr: new UploadManager({ cfg, log, now: () => clock.t }), cfg, clock };
}

const b64 = (s) => Buffer.from(s).toString('base64');

test('a transfer is written atomically and only appears when complete', () => {
  const { mgr, cfg } = setup();
  mgr.begin('c_1', { reqId: 'f1', session: 's_1', name: 'shot.png', mime: 'image/png', size: 10 });
  const during = fs.readdirSync(cfg.uploadsDir);
  assert.strictEqual(during.length, 1);
  assert.ok(during[0].startsWith('.rt-') && during[0].endsWith('.part'), 'in-flight file is hidden and temporary');

  mgr.chunk('c_1', 'f1', 0, b64('hello'));
  mgr.chunk('c_1', 'f1', 1, b64('world'));
  const stored = mgr.end('c_1', 'f1');
  assert.strictEqual(stored.size, 10);
  assert.strictEqual(fs.readFileSync(stored.path, 'utf8'), 'helloworld');
  assert.match(path.basename(stored.path), /^shot-\d{8}-\d{6}\.png$/);
  assert.deepStrictEqual(fs.readdirSync(cfg.uploadsDir), [path.basename(stored.path)], 'no leftover .part file');
  assert.strictEqual(mgr.active.size, 0);
});

test('hostile names cannot escape the upload directory', () => {
  assert.strictEqual(safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(safeName('/etc/shadow'), 'shadow');
  assert.strictEqual(safeName('..'), 'file');
  assert.strictEqual(safeName(''), 'file');
  assert.strictEqual(safeName('.bashrc'), 'bashrc');
  assert.strictEqual(safeName('a b;rm -rf /.png'), 'png', 'only the basename survives');
  assert.strictEqual(safeName('a b;rm -rf .png'), 'a-b-rm-rf-.png', 'shell metacharacters become dashes');
  assert.strictEqual(safeName('$(reboot).png'), 'reboot-.png');
  assert.strictEqual(safeName('x'.repeat(200) + '.png').length <= 96, true);

  const { mgr, cfg } = setup();
  mgr.begin('c_1', { reqId: 'f1', session: 's_1', name: '../../evil.sh', mime: 'text/plain', size: 2 });
  mgr.chunk('c_1', 'f1', 0, b64('hi'));
  const stored = mgr.end('c_1', 'f1');
  assert.strictEqual(path.dirname(stored.path), cfg.uploadsDir);
  assert.match(path.basename(stored.path), /^evil-\d{8}-\d{6}\.sh$/);
});

test('two files with the same name never overwrite each other', () => {
  const { mgr } = setup();
  const paths = [];
  for (const req of ['f1', 'f2']) {
    mgr.begin('c_1', { reqId: req, session: 's_1', name: 'shot.png', mime: 'image/png', size: 1 });
    mgr.chunk('c_1', req, 0, b64('x'));
    paths.push(mgr.end('c_1', req).path);
  }
  assert.notStrictEqual(paths[0], paths[1]);
  assert.ok(fs.existsSync(paths[0]) && fs.existsSync(paths[1]));
});

test('limits: size, concurrency, ordering, overrun and incomplete transfers', () => {
  const { mgr, cfg } = setup();
  assert.throws(() => mgr.begin('c_1', { reqId: 'big', session: 's_1', name: 'a.bin', mime: 'application/octet-stream', size: 2048 }),
    (e) => e.code === 'limit_reached');

  mgr.begin('c_1', { reqId: 'f1', session: 's_1', name: 'a.png', mime: 'image/png', size: 100 });
  mgr.begin('c_1', { reqId: 'f2', session: 's_1', name: 'b.png', mime: 'image/png', size: 100 });
  assert.throws(() => mgr.begin('c_1', { reqId: 'f3', session: 's_1', name: 'c.png', mime: 'image/png', size: 10 }),
    (e) => e.code === 'limit_reached', 'third concurrent transfer refused');
  // another phone is unaffected by the first one's budget
  mgr.begin('c_2', { reqId: 'f1', session: 's_1', name: 'd.png', mime: 'image/png', size: 1 });

  assert.throws(() => mgr.chunk('c_1', 'f1', 5, b64('x')), (e) => e.code === 'bad_request', 'out-of-order chunk');
  assert.strictEqual(mgr.active.has('c_1|f1'), false, 'out-of-order transfer is discarded');

  mgr.chunk('c_1', 'f2', 0, b64('x'.repeat(50)));
  assert.throws(() => mgr.chunk('c_1', 'f2', 1, b64('x'.repeat(80))), (e) => e.code === 'bad_request', 'more data than declared');

  mgr.begin('c_1', { reqId: 'f4', session: 's_1', name: 'e.png', mime: 'image/png', size: 10 });
  mgr.chunk('c_1', 'f4', 0, b64('short'));
  assert.throws(() => mgr.end('c_1', 'f4'), (e) => e.code === 'bad_request', 'incomplete transfer');
  assert.throws(() => mgr.chunk('c_1', 'nope', 0, b64('x')), (e) => e.code === 'bad_request');
  assert.throws(() => mgr.end('c_1', 'nope'), (e) => e.code === 'bad_request');

  mgr.clientGone('c_1'); mgr.clientGone('c_2');
  assert.strictEqual(mgr.active.size, 0);
  assert.deepStrictEqual(fs.readdirSync(cfg.uploadsDir), [], 'aborted transfers leave nothing behind');
});

test('a stalled transfer is swept away and a disconnect cleans up', () => {
  const { mgr, cfg, clock } = setup({ uploadTimeoutSec: 30 });
  mgr.begin('c_1', { reqId: 'f1', session: 's_1', name: 'a.png', mime: 'image/png', size: 100 });
  mgr.chunk('c_1', 'f1', 0, b64('x'));
  clock.t += 29_000; mgr.sweep();
  assert.strictEqual(mgr.active.size, 1);
  clock.t += 2_000; mgr.sweep();
  assert.strictEqual(mgr.active.size, 0);
  assert.deepStrictEqual(fs.readdirSync(cfg.uploadsDir), []);

  mgr.begin('c_9', { reqId: 'f1', session: 's_1', name: 'b.png', mime: 'image/png', size: 100 });
  mgr.clientGone('c_9');
  assert.deepStrictEqual(fs.readdirSync(cfg.uploadsDir), []);
});

test('the upload directory is created private', { skip: process.platform === 'win32' && 'posix only' }, () => {
  const { mgr, cfg } = setup();
  mgr.begin('c_1', { reqId: 'f1', session: 's_1', name: 'a.png', mime: 'image/png', size: 1 });
  assert.strictEqual(fs.statSync(cfg.uploadsDir).mode & 0o777, 0o700);
  mgr.chunk('c_1', 'f1', 0, b64('x'));
  const stored = mgr.end('c_1', 'f1');
  assert.strictEqual(fs.statSync(stored.path).mode & 0o777, 0o600);
});
