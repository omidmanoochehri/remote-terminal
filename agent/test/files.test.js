'use strict';

/*
 * The file browser's service: listing, chunked reads and uploads, and above
 * all that nothing — a path, a symlink, a new name — reaches outside the root.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileService, validName, MAX_READ, PART_SUFFIX } = require('../lib/files');

function setup(over = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fs-')));
  const root = path.join(base, 'home');
  const outside = path.join(base, 'secret');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(root, '.profile'), 'x');
  fs.writeFileSync(path.join(outside, 'key'), 'top secret');
  const svc = new FileService(Object.assign({ root: () => root }, over));
  return { base, root, outside, svc };
}

const code = (c) => (err) => { assert.strictEqual(err.code, c, err.message); return true; };
const b64 = (s) => Buffer.from(s).toString('base64');

test('lists a directory with types, sizes and hidden flags; the root has no parent', async () => {
  const { root, svc } = setup();
  const r = await svc.list({});
  assert.strictEqual(r.path, root);
  assert.strictEqual(r.root, root);
  assert.strictEqual(r.parent, null);
  const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  assert.strictEqual(byName.docs.type, 'dir');
  assert.strictEqual(byName['hello.txt'].type, 'file');
  assert.strictEqual(byName['hello.txt'].size, 11);
  assert.ok(byName['hello.txt'].mtime > 0);
  assert.strictEqual(byName['.profile'].hidden, true);

  const sub = await svc.list({ path: 'docs' });
  assert.strictEqual(sub.path, path.join(root, 'docs'));
  assert.strictEqual(sub.parent, root);
  await assert.rejects(svc.list({ path: 'hello.txt' }), code('bad_request'));
  await assert.rejects(svc.list({ path: 'nope' }), code('not_found'));
});

test('nothing outside the root is reachable, by path or by symlink', async () => {
  const { root, outside, svc } = setup();
  await assert.rejects(svc.list({ path: '..' }), code('forbidden'));
  await assert.rejects(svc.list({ path: outside }), code('forbidden'));
  await assert.rejects(svc.read({ path: path.join(outside, 'key') }), code('forbidden'));
  await assert.rejects(svc.read({ path: '../secret/key' }), code('forbidden'));
  await assert.rejects(svc.mkdir({ path: path.join(outside, 'new') }), code('forbidden'));
  await assert.rejects(svc.write({ path: '../secret/drop', offset: 0, data: '', final: true }), code('forbidden'));

  let linked = true;
  try { fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); } catch (_) { linked = false; }
  if (linked) {
    await assert.rejects(svc.list({ path: 'escape' }), code('forbidden'));
    await assert.rejects(svc.read({ path: 'escape/key' }), code('forbidden'));
    await assert.rejects(svc.write({ path: 'escape/drop', offset: 0, data: '', final: true }), code('forbidden'));
    // Deleting the link removes the link, never what it points at.
    await svc.remove({ path: 'escape', recursive: true });
    assert.ok(fs.existsSync(path.join(outside, 'key')), 'the target survived');
    assert.ok(!fs.existsSync(path.join(root, 'escape')));
  }
  await assert.rejects(svc.remove({ path: root, recursive: true }), code('forbidden'));
  await assert.rejects(svc.rename({ from: root, to: 'x' }), code('forbidden'));
  await assert.rejects(svc.list({ path: 'a\0b' }), code('bad_request'));
});

test('reads come back in bounded base64 slices', async () => {
  const { root, svc } = setup();
  const big = Buffer.alloc(MAX_READ + 1000, 7);
  fs.writeFileSync(path.join(root, 'big.bin'), big);
  const a = await svc.read({ path: 'big.bin', offset: 0, length: 10 * MAX_READ });
  assert.strictEqual(Buffer.from(a.data, 'base64').length, MAX_READ);
  assert.strictEqual(a.size, big.length);
  assert.strictEqual(a.eof, false);
  const b = await svc.read({ path: 'big.bin', offset: MAX_READ });
  assert.strictEqual(Buffer.from(b.data, 'base64').length, 1000);
  assert.strictEqual(b.eof, true);
  const past = await svc.read({ path: 'big.bin', offset: big.length + 5 });
  assert.strictEqual(past.data, '');
  assert.strictEqual(past.eof, true);
  await assert.rejects(svc.read({ path: 'docs' }), (e) => ['bad_request', 'forbidden'].includes(e.code));
  await assert.rejects(svc.read({ path: 'hello.txt', offset: -1 }), code('bad_request'));
});

test('uploads append in order, appear only when final, and never clobber by accident', async () => {
  const { root, svc } = setup({ maxWriteBytes: 20 });
  const r1 = await svc.write({ path: 'docs/up.txt', offset: 0, data: b64('hello ') });
  assert.deepStrictEqual([r1.size, r1.done], [6, false]);
  assert.ok(!fs.existsSync(path.join(root, 'docs', 'up.txt')), 'not visible while in flight');
  assert.ok(!(await svc.list({ path: 'docs' })).entries.some((e) => e.name.endsWith(PART_SUFFIX)), 'part files are not listed');
  await assert.rejects(svc.write({ path: 'docs/up.txt', offset: 3, data: b64('x') }), code('bad_request'));
  const r2 = await svc.write({ path: 'docs/up.txt', offset: 6, data: b64('there'), final: true });
  assert.deepStrictEqual([r2.size, r2.done], [11, true]);
  assert.strictEqual(fs.readFileSync(path.join(root, 'docs', 'up.txt'), 'utf8'), 'hello there');

  await assert.rejects(svc.write({ path: 'hello.txt', offset: 0, data: b64('x'), final: true }), code('exists'));
  await svc.write({ path: 'hello.txt', offset: 0, data: b64('new'), final: true, overwrite: true });
  assert.strictEqual(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), 'new');
  await assert.rejects(svc.write({ path: 'big.txt', offset: 0, data: b64('x'.repeat(21)) }), code('limit_reached'));
  // 'docs/..' is the root itself, whose parent is outside: never a name to write.
  await assert.rejects(svc.write({ path: 'docs/..', offset: 0, data: '' }), code('forbidden'));
});

test('mkdir, rename and delete stay inside the root and say why they refuse', async () => {
  const { root, svc } = setup();
  await svc.mkdir({ path: 'docs/new' });
  assert.ok(fs.statSync(path.join(root, 'docs', 'new')).isDirectory());
  await assert.rejects(svc.mkdir({ path: 'docs/new' }), code('exists'));
  await svc.rename({ from: 'hello.txt', to: 'docs/new/moved.txt' });
  assert.ok(fs.existsSync(path.join(root, 'docs', 'new', 'moved.txt')));
  await assert.rejects(svc.rename({ from: 'docs', to: 'docs/new' }), code('exists'));
  await assert.rejects(svc.remove({ path: 'docs' }), code('not_empty'));
  await svc.remove({ path: 'docs/new/moved.txt' });
  await svc.remove({ path: 'docs', recursive: true });
  assert.ok(!fs.existsSync(path.join(root, 'docs')));
  await assert.rejects(svc.remove({ path: 'docs' }), code('not_found'));
});

test('no root means nobody is signed in', async () => {
  const svc = new FileService({ root: async () => null });
  await assert.rejects(svc.list({}), code('unavailable'));
});

test('new names are plain names', () => {
  for (const ok of ['a.txt', 'My File', '..hidden', 'x'.repeat(255)]) assert.ok(validName(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\nb', 'x'.repeat(256), null]) assert.ok(!validName(bad), String(bad));
});

test('Windows paths compare without regard to case', () => {
  const svc = new FileService({ root: 'C:\\Users\\Ann', platform: 'win32' });
  assert.ok(svc.inside('C:\\Users\\Ann', 'c:\\users\\ann\\Documents'));
  assert.ok(!svc.inside('C:\\Users\\Ann', 'C:\\Users\\Annabel'));
  assert.ok(!svc.inside('C:\\Users\\Ann', 'D:\\Users\\Ann'));
});
