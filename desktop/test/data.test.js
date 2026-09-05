/**
 * Terminal naming, presets, pairing payloads and the working directory the
 * shell reports — the Android app's `TerminalNamingTest`, `TerminalPresetTest`,
 * `PairingPayloadTest` and `WorkingDirectoryTest` carried over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { copyTitle } from '../ui/js/core/naming.js';
import { makePreset, newPresetId, presetsFromJson, presetsToJson } from '../ui/js/core/preset.js';
import { parsePairingPayload } from '../ui/js/core/pairingPayload.js';
import { normalizeRelayUrl, isPrivateHost, hostOf } from '../ui/js/core/credentials.js';
import { TerminalEmulator } from '../ui/js/terminal/emulator.js';
import { shellQuote } from '../ui/js/core/shell.js';

/* ------------------------------- naming ---------------------------------- */
// Copies of copies are the case that matters: a machine where every terminal is
// called "deploy (2) (2) (2)" is worse than one with no names at all.

test('the first copy is numbered two', () => {
  assert.equal(copyTitle('deploy', ['deploy']), 'deploy (2)');
});

test('copying a copy keeps counting', () => {
  const taken = ['deploy', 'deploy (2)'];
  assert.equal(copyTitle('deploy (2)', taken), 'deploy (3)');
  assert.equal(copyTitle('deploy', taken), 'deploy (3)');
});

test('gaps are filled rather than skipped', () => {
  assert.equal(copyTitle('deploy', ['deploy', 'deploy (2)', 'deploy (4)']), 'deploy (3)');
});

test('names ending in brackets are not mistaken for counters', () => {
  assert.equal(copyTitle('build (linux)', ['build (linux)']), 'build (linux) (2)');
});

test('surrounding space is ignored on both sides', () => {
  assert.equal(copyTitle('  api  ', [' api (2) ', 'api']), 'api (3)');
  assert.equal(copyTitle('api', []), 'api (2)');
});

test('an untitled terminal stays untitled', () => {
  // The agent names these itself ("bash 2"), which is better than "(2)".
  assert.equal(copyTitle('', ['bash']), '');
  assert.equal(copyTitle('   ', ['bash']), '');
});

/* ------------------------------- presets --------------------------------- */
// Presets are stored as JSON in the settings file, so what a newer build writes
// has to survive being read back, and a file that has been edited or corrupted
// must not take the settings screen down with it.

const full = makePreset({
  id: 'abc123',
  name: 'API logs',
  agentId: 'agent-1',
  shellId: 'bash',
  directory: '/srv/api',
  command: 'tail -f log/production.log',
});

test('a preset round-trips every field', () => {
  assert.deepEqual(presetsFromJson(presetsToJson([full])), [full]);
});

test('a machine-agnostic preset round-trips', () => {
  const floating = makePreset({ id: 'x1', name: 'Scratch' });
  const back = presetsFromJson(presetsToJson([floating]))[0];
  assert.deepEqual(back, floating);
  assert.equal(back.agentId, null);
  assert.equal(back.shellId, null);
  assert.equal(back.directory, '');
  assert.equal(back.command, '');
});

test('a list round-trips', () => {
  const list = [full, makePreset({ id: 'x1', name: 'Scratch', directory: '~' })];
  assert.deepEqual(presetsFromJson(presetsToJson(list)), list);
});

test('malformed storage reads as empty rather than throwing', () => {
  assert.deepEqual(presetsFromJson('not json'), []);
  assert.deepEqual(presetsFromJson({}), []);
  assert.deepEqual(presetsFromJson(null), []);
  assert.deepEqual(presetsFromJson(undefined), []);
});

test('entries without an id or a name are dropped', () => {
  const parsed = presetsFromJson([{ name: 'no id' }, { id: 'a', name: 'kept' }, { id: 'b' }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'kept');
});

test('a start-up command survives editing round trips', () => {
  const edited = { ...full, command: 'docker compose logs -f api' };
  assert.equal(presetsFromJson(presetsToJson([edited]))[0].command, 'docker compose logs -f api');
  // A preset that only runs something, with no directory, is legitimate.
  const bare = makePreset({ id: 'c', name: 'Top', command: 'htop' });
  assert.deepEqual(presetsFromJson(presetsToJson([bare]))[0], bare);
  assert.equal(presetsFromJson(presetsToJson([makePreset({ id: 'd', name: 'Plain' })]))[0].command, '');
});

test('preset ids are distinct', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newPresetId()));
  assert.equal(ids.size, 50);
});

/* --------------------------- pairing payloads ---------------------------- */
// Pairing must accept exactly what the product produces and nothing else: a
// link found in the wild should never be able to point this device at a relay
// of someone else's choosing.

test('a bare six-digit code is accepted', () => {
  const parsed = parsePairingPayload('482913');
  assert.equal(parsed.code, '482913');
  assert.equal(parsed.relay, null);
});

test('surrounding whitespace is ignored', () => {
  assert.equal(parsePairingPayload('  482913\n').code, '482913');
});

test('a pairing link carries the relay and the code', () => {
  const parsed = parsePairingPayload('remoteterminal://pair?relay=wss%3A%2F%2Frelay.example.com&code=482913');
  assert.equal(parsed.relay, 'wss://relay.example.com');
  assert.equal(parsed.code, '482913');
});

test('a pairing link without a relay still works', () => {
  const parsed = parsePairingPayload('remoteterminal://pair?code=100200');
  assert.equal(parsed.code, '100200');
  assert.equal(parsed.relay, null);
});

test('a spaced code in a link is normalised', () => {
  assert.equal(parsePairingPayload('remoteterminal://pair?code=482%20913').code, '482913');
});

test('other schemes are rejected', () => {
  assert.equal(parsePairingPayload('https://example.com/pair?code=482913&relay=wss://evil.example'), null);
  assert.equal(parsePairingPayload('otpauth://totp/x?secret=482913'), null);
});

test('a non-WebSocket relay is rejected', () => {
  assert.equal(parsePairingPayload('remoteterminal://pair?relay=file%3A%2F%2F%2Fetc&code=482913'), null);
});

test('malformed or empty payloads are rejected', () => {
  assert.equal(parsePairingPayload(null), null);
  assert.equal(parsePairingPayload(''), null);
  assert.equal(parsePairingPayload('hello world'), null);
  assert.equal(parsePairingPayload('12345'), null);
  assert.equal(parsePairingPayload('1234567'), null);
  assert.equal(parsePairingPayload('remoteterminal://pair'), null);
  assert.equal(parsePairingPayload('remoteterminal://pair?code=abcdef'), null);
});

/* ------------------------------ relay URLs ------------------------------- */

test('relay URLs are normalised to ws(s)://', () => {
  assert.equal(normalizeRelayUrl('relay.example.com'), 'wss://relay.example.com');
  assert.equal(normalizeRelayUrl('https://relay.example.com/'), 'wss://relay.example.com');
  assert.equal(normalizeRelayUrl('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
  assert.equal(normalizeRelayUrl(' wss://relay.example.com:8443/prefix/ '), 'wss://relay.example.com:8443/prefix');
  assert.throws(() => normalizeRelayUrl('wss://'));
  assert.equal(hostOf('wss://relay.example.com:8443/x'), 'relay.example.com:8443');
});

test('private addresses are the ones where plain ws:// is reasonable', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', 'nas.local']) {
    assert.equal(isPrivateHost(`ws://${host}:8080`), true, host);
  }
  for (const host of ['relay.example.com', '8.8.8.8', '172.32.0.1']) {
    assert.equal(isPrivateHost(`ws://${host}`), false, host);
  }
});

/* --------------------------- working directory --------------------------- */
// OSC 7 is how a shell says where it is. Duplicating a terminal into the wrong
// directory would be worse than duplicating it into none, so anything that is
// not a well-formed `file://` URL has to be ignored rather than guessed at.

function reported(payload) {
  const t = new TerminalEmulator(80, 24, 50);
  const seen = [];
  t.onWorkingDirectory = (d) => seen.push(d);
  t.feed(`\x1b]7;${payload}\x07`);
  return seen;
}

test('a plain POSIX path is reported', () => {
  assert.deepEqual(reported('file://prod-01/srv/api'), ['/srv/api']);
});

test('the host may be empty', () => {
  assert.deepEqual(reported('file:///home/omid'), ['/home/omid']);
});

test('percent escapes are decoded', () => {
  assert.deepEqual(reported('file://h/srv/my%20project'), ['/srv/my project']);
  assert.deepEqual(reported('file://h/srv/na%C3%AFve'), ['/srv/naïve']);
});

test('Windows paths lose the leading slash', () => {
  assert.deepEqual(reported('file:///C:/Users/Omid'), ['C:/Users/Omid']);
});

test('malformed payloads are ignored', () => {
  assert.deepEqual(reported(''), []);
  assert.deepEqual(reported('/srv/api'), []);
  assert.deepEqual(reported('http://example.com/x'), []);
  assert.deepEqual(reported('file://host-with-no-path'), []);
});

test('control characters are refused', () => {
  assert.deepEqual(reported('file://h/srv/%00etc'), []);
});

test('a string terminator ends the sequence too', () => {
  const t = new TerminalEmulator(80, 24, 50);
  const seen = [];
  t.onWorkingDirectory = (d) => seen.push(d);
  t.feed('\x1b]7;file://h/opt\x1b\\');
  assert.deepEqual(seen, ['/opt']);
});

test('the sequence leaves nothing on the screen', () => {
  const t = new TerminalEmulator(80, 24, 50);
  t.feed('a\x1b]7;file://h/opt\x07b');
  assert.equal(t.rowText(t.totalRows() - t.rows, true), 'ab');
});

/* ------------------------------ shell quoting ---------------------------- */

test('paths are quoted only when they need it', () => {
  assert.equal(shellQuote('/srv/api'), '/srv/api');
  assert.equal(shellQuote('~/projects/app-1'), '~/projects/app-1');
  assert.equal(shellQuote('/srv/my project'), "'/srv/my project'");
  assert.equal(shellQuote("/srv/it's"), "'/srv/it'\\''s'");
  // Windows paths take double quotes: Command Prompt would take the POSIX
  // single quotes literally.
  assert.equal(shellQuote('C:\\Users\\Omid\\My Docs'), '"C:\\Users\\Omid\\My Docs"');
});
