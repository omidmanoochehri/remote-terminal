/**
 * The 0.12 features: agent requests, links in terminal output, transcripts,
 * the file browser's model and transfers, the process manager's rules, and
 * output watches — the Android app's `LinksTest`, `TranscriptTest`,
 * `AgentRequestsTest`, `RemoteFilesTest`, `ProcessesTest` and `WatchesTest`
 * carried over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findLinks, linkAt, isOpenable } from '../ui/js/terminal/links.js';
import { TerminalEmulator } from '../ui/js/terminal/emulator.js';
import { transcriptText, cleanTranscript, transcriptFileName } from '../ui/js/core/transcript.js';
import { AgentRequests, RequestError, featureGate } from '../ui/js/core/requests.js';
import { parseIncoming } from '../ui/js/protocol/incoming.js';
import { Outgoing } from '../ui/js/protocol/messages.js';
import {
  arrangeEntries, joinPath, baseName, breadcrumbs, viewKind, downloadSlices, uploadSlices, byteLength,
  encodeUtf8Base64, Cancelled, SLICE_BYTES,
} from '../ui/js/core/remoteFiles.js';
import { sameUser, endPermission, arrangeProcesses, cpuLabel } from '../ui/js/core/processes.js';
import { TextWatch, QuietWatch, stripEscapes } from '../ui/js/core/watches.js';

/* --------------------------------- links --------------------------------- */

const urls = (text) => findLinks(text).map((l) => l.url);

test('links: plain URLs are found with their offsets', () => {
  const found = findLinks('open https://example.com/a?b=1 now');
  assert.deepEqual(found, [{ start: 5, end: 30, url: 'https://example.com/a?b=1' }]);
  assert.deepEqual(urls('ftp://files.example.com/x and file:///etc/hosts'), ['ftp://files.example.com/x', 'file:///etc/hosts']);
});

test('links: trailing punctuation belongs to the sentence', () => {
  assert.deepEqual(urls('See https://example.com/docs.'), ['https://example.com/docs']);
  assert.deepEqual(urls('"https://example.com/x", then'), ['https://example.com/x']);
  assert.deepEqual(urls('is it https://a.io/?!'), ['https://a.io/']);
});

test('links: a closing bracket stays only when the link opened it', () => {
  assert.deepEqual(urls('(see https://example.com/page)'), ['https://example.com/page']);
  assert.deepEqual(urls('https://en.wikipedia.org/wiki/Rust_(language)'), ['https://en.wikipedia.org/wiki/Rust_(language)']);
  assert.deepEqual(urls('[https://example.com/a]'), ['https://example.com/a']);
  assert.deepEqual(urls('(https://en.wikipedia.org/wiki/Rust_(language))'), ['https://en.wikipedia.org/wiki/Rust_(language)']);
});

test('links: quotes, angle brackets and backticks end a link; a bare scheme is not one', () => {
  assert.deepEqual(urls('<https://example.com/a>'), ['https://example.com/a']);
  assert.deepEqual(urls('`https://example.com/b`'), ['https://example.com/b']);
  assert.deepEqual(urls('https:// nothing'), []);
  assert.deepEqual(urls('no links here'), []);
});

test('links: only web links are openable', () => {
  assert.ok(isOpenable('https://a.b'));
  assert.ok(isOpenable('HTTP://a.b'));
  assert.ok(isOpenable('ftp://a.b'));
  assert.ok(!isOpenable('file:///etc/passwd'));
});

test('links: a URL soft-wrapped across rows is found from either row, with a span per row', () => {
  const em = new TerminalEmulator(20, 5, 100);
  const url = 'https://example.com/a/very/long/path';
  em.feed(`go ${url} ok\r\n`);
  const first = linkAt(em, 0, 5);
  assert.equal(first.url, url);
  const second = linkAt(em, 1, 3);
  assert.equal(second.url, url);
  // "go " + 36 characters on 20 columns: 17 on the first row, 19 on the second.
  assert.deepEqual(first.spans, [{ row: 0, startCol: 3, endCol: 19 }, { row: 1, startCol: 0, endCol: 18 }]);
  assert.equal(linkAt(em, 0, 1), null, 'not over the link');
  assert.equal(linkAt(em, 1, 19), null, 'the space after it');
  assert.equal(linkAt(em, 2, 0), null, '"ok" on the third row is not part of it');
});

/* ------------------------------- transcript ------------------------------ */

test('transcript: scrollback and screen, wraps joined, trailing space and blank rows dropped', () => {
  const em = new TerminalEmulator(10, 4, 100);
  em.feed('one   \r\n0123456789abc\r\n\r\nlast');
  assert.equal(transcriptText(em), 'one\n0123456789abc\n\nlast\n');
});

test('transcript: an empty terminal has no transcript', () => {
  assert.equal(transcriptText(new TerminalEmulator(10, 4, 100)), '');
  assert.equal(cleanTranscript('\n  \n\t\n'), '');
});

test('transcript: file names are safe and stamped', () => {
  const at = new Date(2026, 8, 3, 1, 15, 0);
  assert.equal(transcriptFileName('API logs', at), 'API logs-20260903-011500.txt');
  assert.equal(transcriptFileName('a/b:c*?', at), 'a-b-c-20260903-011500.txt');
  assert.equal(transcriptFileName('', at), 'terminal-20260903-011500.txt');
});

/* -------------------------------- requests ------------------------------- */

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn) => { timers.set(++id, fn); return id; },
    clearTimer: (t) => timers.delete(t),
    fireAll: () => { for (const [k, fn] of [...timers]) { timers.delete(k); fn(); } },
    count: () => timers.size,
  };
}

test('requests: an answer resolves the request it names, and only that one', async () => {
  const sent = [];
  const timers = fakeTimers();
  const r = new AgentRequests((json) => { sent.push(JSON.parse(json)); return true; }, timers);
  const a = r.request('a_x', 'fs.list', { path: '/tmp' });
  const b = r.request('a_x', 'proc.list');
  assert.deepEqual(sent[0], { type: 'agent.request', reqId: 'q1', agent: 'a_x', method: 'fs.list', params: { path: '/tmp' } });
  assert.deepEqual(sent[1].params, {});
  assert.equal(r.handle({ kind: 'agentResponse', reqId: 'nope', result: {} }), false);
  assert.equal(r.handle(parseIncoming(JSON.stringify({ type: 'agent.response', reqId: 'q2', agent: 'a_x', result: { total: 3 } }))), true);
  assert.deepEqual(await b, { total: 3 });
  r.handle(parseIncoming(JSON.stringify({ type: 'error', reqId: 'q1', code: 'forbidden', message: 'outside' })));
  await assert.rejects(a, (e) => e instanceof RequestError && e.code === 'forbidden' && e.message === 'outside');
  assert.equal(timers.count(), 0, 'timers cleared');
});

test('requests: silence times out; a closed socket fails at once and on disconnect', async () => {
  const timers = fakeTimers();
  let open = true;
  const r = new AgentRequests(() => open, timers);
  const slow = r.request('a_x', 'fs.list');
  timers.fireAll();
  await assert.rejects(slow, (e) => e.code === 'timeout');

  open = false;
  await assert.rejects(r.request('a_x', 'fs.list'), (e) => e.code === 'disconnected');

  open = true;
  const pending = r.request('a_x', 'fs.list');
  r.failAll();
  await assert.rejects(pending, (e) => e.code === 'disconnected');
  assert.equal(r.pending.size, 0);
});

test('requests: the message builder and the parser agree on the wire format', () => {
  assert.deepEqual(JSON.parse(Outgoing.agentRequest('q9', 'a_x', 'proc.kill', { pid: 4 })),
    { type: 'agent.request', reqId: 'q9', agent: 'a_x', method: 'proc.kill', params: { pid: 4 } });
  const e = parseIncoming('{"type":"agent.response","reqId":"q9","agent":"a_x","result":[1]}');
  assert.deepEqual(e, { kind: 'agentResponse', agentId: 'a_x', reqId: 'q9', result: {} });
});

test('requests: features are gated on the relay, the agent and presence', () => {
  const agent = { name: 'Prod', online: true, caps: ['sessions', 'fs'] };
  assert.equal(featureGate(['requests'], agent, 'fs').ok, true);
  assert.equal(featureGate(['requests'], agent, 'procs').reason, 'unsupported');
  assert.equal(featureGate(['sessions'], agent, 'fs').reason, 'unsupported', 'an old relay cannot route requests');
  assert.deepEqual(featureGate(['requests'], { ...agent, online: false }, 'fs'), { ok: false, reason: 'offline', name: 'Prod' });
});

/* ------------------------------ remote files ----------------------------- */

const entries = [
  { name: 'b.txt', type: 'file', size: 10, mtime: 3 },
  { name: 'A.txt', type: 'file', size: 300, mtime: 1 },
  { name: 'src', type: 'dir', size: 0, mtime: 2 },
  { name: '.git', type: 'dir', size: 0, mtime: 9, hidden: true },
  { name: 'file10', type: 'file', size: 5, mtime: 5 },
  { name: 'file9', type: 'file', size: 5, mtime: 4 },
];
const names = (list) => list.map((e) => e.name);

test('files: folders first, then files by name in natural order; hidden only on request', () => {
  assert.deepEqual(names(arrangeEntries(entries)), ['src', 'A.txt', 'b.txt', 'file9', 'file10']);
  assert.deepEqual(names(arrangeEntries(entries, { showHidden: true })), ['.git', 'src', 'A.txt', 'b.txt', 'file9', 'file10']);
});

test('files: size and modified sorts are largest and newest first, folders still first', () => {
  assert.deepEqual(names(arrangeEntries(entries, { sort: 'size' })), ['src', 'A.txt', 'b.txt', 'file9', 'file10']);
  assert.deepEqual(names(arrangeEntries(entries, { sort: 'modified' })), ['src', 'file10', 'file9', 'b.txt', 'A.txt']);
});

test('files: the filter matches names in any case', () => {
  assert.deepEqual(names(arrangeEntries(entries, { filter: 'FILE' })), ['file9', 'file10']);
  assert.deepEqual(names(arrangeEntries(entries, { filter: 'zzz' })), []);
});

test('files: paths use the machine separator', () => {
  assert.equal(joinPath('/home/ann', 'x'), '/home/ann/x');
  assert.equal(joinPath('/', 'etc'), '/etc');
  assert.equal(joinPath('C:\\Users\\Ann', 'Documents', '\\'), 'C:\\Users\\Ann\\Documents');
  assert.equal(joinPath('C:\\', 'x', '\\'), 'C:\\x');
  assert.equal(baseName('/home/ann/'), 'ann');
  assert.equal(baseName('C:\\Users\\Ann', '\\'), 'Ann');
});

test('files: breadcrumbs start at the root and never go above it', () => {
  assert.deepEqual(breadcrumbs('/home/ann/src/app', '/home/ann'), [
    { label: 'ann', path: '/home/ann' },
    { label: 'src', path: '/home/ann/src' },
    { label: 'app', path: '/home/ann/src/app' },
  ]);
  assert.deepEqual(breadcrumbs('/home/ann', '/home/ann'), [{ label: 'ann', path: '/home/ann' }]);
  assert.deepEqual(breadcrumbs('c:\\users\\ann\\Docs', 'C:\\Users\\Ann', '\\').map((c) => c.label), ['Ann', 'Docs']);
});

test('files: what the viewer can show', () => {
  assert.equal(viewKind('notes.md'), 'text');
  assert.equal(viewKind('Makefile'), 'text');
  assert.equal(viewKind('shot.PNG'), 'image');
  assert.equal(viewKind('archive.zip'), null);
});

function fakeRemoteFile(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const reads = [];
  const read = async (offset) => {
    reads.push(offset);
    const slice = bytes.subarray(offset, Math.min(size, offset + SLICE_BYTES));
    return { data: slice.toString('base64'), size, eof: offset + slice.length >= size };
  };
  return { bytes, read, reads };
}

test('files: a download is written in order, whole, with progress', async () => {
  const remote = fakeRemoteFile(SLICE_BYTES * 3 + 1234);
  const chunks = [];
  const progress = [];
  const result = await downloadSlices({
    read: remote.read,
    write: async (offset, data) => { chunks.push([offset, Buffer.from(data, 'base64')]); },
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(result.size, remote.bytes.length);
  assert.deepEqual(chunks.map(([o]) => o), [0, SLICE_BYTES, SLICE_BYTES * 2, SLICE_BYTES * 3]);
  assert.ok(Buffer.concat(chunks.map(([, b]) => b)).equals(remote.bytes));
  assert.deepEqual(progress[progress.length - 1], [remote.bytes.length, remote.bytes.length]);
});

test('files: an empty file downloads as an empty file; a cancelled one stops', async () => {
  const empty = fakeRemoteFile(0);
  const writes = [];
  await downloadSlices({ read: empty.read, write: async (o, d) => writes.push([o, d]) });
  assert.deepEqual(writes, [[0, '']]);

  const big = fakeRemoteFile(SLICE_BYTES * 5);
  let n = 0;
  await assert.rejects(downloadSlices({ read: big.read, write: async () => { n++; }, isCancelled: () => n >= 2 }), Cancelled);
});

test('files: an upload sends ordered slices and marks only the last final', async () => {
  const local = fakeRemoteFile(SLICE_BYTES * 2 + 7);
  const calls = [];
  const out = await uploadSlices({
    read: local.read,
    write: async (offset, data, final) => { calls.push([offset, byteLength(data), final]); return { done: final }; },
  });
  assert.deepEqual(calls, [[0, SLICE_BYTES, false], [SLICE_BYTES, SLICE_BYTES, false], [SLICE_BYTES * 2, 7, true]]);
  assert.deepEqual(out, { done: true });
});

test('files: base64 lengths and UTF-8 encoding', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd']) assert.equal(byteLength(Buffer.from(s).toString('base64')), s.length);
  assert.equal(Buffer.from(encodeUtf8Base64('héllo ✓'), 'base64').toString('utf8'), 'héllo ✓');
});

/* ------------------------------- processes ------------------------------- */

test('processes: owners match with or without the domain, in any case', () => {
  assert.ok(sameUser('OFFICE\\ann', 'office\\ANN'));
  assert.ok(sameUser('OFFICE\\ann', 'ann'));
  assert.ok(!sameUser('OFFICE\\ann', 'OFFICE\\annabel'));
  assert.ok(!sameUser('', 'ann'));
  assert.ok(!sameUser('ann', null));
});

test('processes: whether one may be ended follows killable and owner', () => {
  const p = { pid: 5, name: 'x', user: 'OFFICE\\Ann' };
  assert.deepEqual(endPermission({ killable: 'all' }, p), { ok: true, reason: null });
  assert.deepEqual(endPermission({ killable: 'none' }, p), { ok: false, reason: 'off' });
  assert.deepEqual(endPermission({ killable: 'own', owner: 'OFFICE\\ann' }, p), { ok: true, reason: null });
  assert.deepEqual(endPermission({ killable: 'own', owner: 'OFFICE\\bob' }, p), { ok: false, reason: 'notOwn' });
  assert.deepEqual(endPermission({ killable: 'own', owner: null }, p), { ok: false, reason: 'notOwn' });
});

test('processes: sorted busiest, largest or by name, and filtered by name, pid, user or command', () => {
  const list = [
    { pid: 10, name: 'node', user: 'ann', cpu: 0.1, mem: 100, cmd: 'node server.js' },
    { pid: 20, name: 'bash', user: 'ann', cpu: null, mem: 50 },
    { pid: 30, name: 'Code', user: 'bob', cpu: 0.5, mem: 900 },
  ];
  assert.deepEqual(arrangeProcesses(list).map((p) => p.pid), [30, 10, 20]);
  assert.deepEqual(arrangeProcesses(list, { sort: 'memory' }).map((p) => p.pid), [30, 10, 20]);
  assert.deepEqual(arrangeProcesses(list, { sort: 'name' }).map((p) => p.pid), [20, 30, 10]);
  assert.deepEqual(arrangeProcesses(list, { filter: 'SERVER' }).map((p) => p.pid), [10]);
  assert.deepEqual(arrangeProcesses(list, { filter: 'bob' }).map((p) => p.pid), [30]);
  assert.deepEqual(arrangeProcesses(list, { filter: '2' }).map((p) => p.pid), [20]);
  assert.equal(cpuLabel(null), '—');
  assert.equal(cpuLabel(0.125), '12.5%');
});

/* --------------------------------- watches ------------------------------- */

test('watches: text is found in any case, across chunks and through colour codes', () => {
  const w = new TextWatch('Build Succeeded');
  assert.equal(w.feed('compiling…\r\nbuild suc'), false);
  assert.equal(w.feed('ceeded in 3s'), true);
  const coloured = new TextWatch('error');
  assert.equal(coloured.feed('\x1b[31mERR'), false);
  assert.equal(coloured.feed('OR\x1b[0m: boom'), true);
  assert.equal(stripEscapes('\x1b]0;title\x07a\x1b[1mb\x1b(Bc'), 'abc');
});

test('watches: a quiet alert fires once after output stops, and never before any output', () => {
  const timers = fakeTimers();
  let fired = 0;
  const q = new QuietWatch(() => fired++, timers);
  assert.equal(timers.count(), 0, 'armed but waiting for output');
  q.feed(); q.feed(); q.feed();
  assert.equal(timers.count(), 1, 'each output restarts the count');
  timers.fireAll();
  assert.equal(fired, 1);
  q.feed();
  assert.equal(timers.count(), 0, 'one-shot');
  const cancelled = new QuietWatch(() => fired++, timers);
  cancelled.feed();
  cancelled.cancel();
  timers.fireAll();
  assert.equal(fired, 1);
});
