/**
 * The 0.13 features' pure parts: snippet placeholders, the palette's fuzzy
 * matcher, asciicast recording and playback timelines, trigger replies,
 * colour-scheme import, backups, and Wake-on-LAN — the Android app's
 * `SnippetsTest`, `FuzzyMatchTest`, `AsciicastTest`, `TriggersTest`,
 * `SchemesTest`, `BackupTest` and `WakeOnLanTest` carried over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize, placeholders, hasPlaceholders, fill, snippetInput, snippetsFromJson, snippetsToJson, groupSnippets,
} from '../ui/js/core/snippets.js';
import { fuzzyScore, fuzzyFilter } from '../ui/js/core/fuzzy.js';
import {
  CastRecorder, parseCast, parseSize, buildTimeline, eventsUpTo, timelineDuration, formatClock, utf8Length,
  castFileName,
} from '../ui/js/core/asciicast.js';
import { TextWatch, decodeReply, regexError, TRIGGER_INTERVAL_MS } from '../ui/js/core/watches.js';
import {
  normalizeHex, parseSchemeImport, schemeToWindowsTerminal, schemeFromTheme, themeFromScheme, schemesFromJson,
  schemesToJson, ANSI_KEYS,
} from '../ui/js/core/schemes.js';
import { GRUVBOX, themeById, setCustomThemes, allThemes, ALL_THEMES } from '../ui/js/terminal/theme.js';
import {
  buildBackup, parseBackup, backupSummary, applyBackup, mergeById, BACKUP_FORMAT,
} from '../ui/js/core/backup.js';
import {
  parseMac, formatMac, magicPacket, directedBroadcast, wolFromSysInfo, wolConfig, parseIPv4,
} from '../ui/js/core/wol.js';
import { arrangePorts, endpoint, processLabel } from '../ui/js/core/sysinfo.js';
import { TerminalEmulator } from '../ui/js/terminal/emulator.js';

/* -------------------------------- snippets ------------------------------- */

test('snippets: placeholders in order of first appearance, with defaults', () => {
  const body = 'ssh {{user:root}}@{{host}} -p {{ port : 22}} # {{host}}';
  assert.deepEqual(placeholders(body), [
    { name: 'user', def: 'root' },
    { name: 'host', def: '' },
    { name: 'port', def: ' 22' },
  ]);
  assert.ok(hasPlaceholders(body));
  assert.ok(!hasPlaceholders('ls -la'));
});

test('snippets: fill uses values, then defaults; every occurrence is replaced', () => {
  const body = 'ssh {{user:root}}@{{host}} && echo {{host}}';
  assert.equal(fill(body, { host: 'db1' }), 'ssh root@db1 && echo db1');
  assert.equal(fill(body, { user: 'ann', host: 'x' }), 'ssh ann@x && echo x');
  assert.equal(fill(body, {}), 'ssh root@ && echo ');
});

test('snippets: {{{{ is a literal {{ and invalid names stay as written', () => {
  assert.equal(fill('echo {{{{x}} {{1bad}} {{ok}}', { ok: 'y' }), 'echo {{x}} {{1bad}} y');
  assert.deepEqual(placeholders('{{{{x}}'), []);
  assert.deepEqual(placeholders('{{a b-c_d}}').map((p) => p.name), ['a b-c_d']);
  assert.deepEqual(placeholders(`{{${'a'.repeat(33)}}}`), []);
  assert.deepEqual(tokenize('a{{b}}c'), [{ text: 'a' }, { name: 'b', def: '' }, { text: 'c' }]);
  assert.equal(fill('unclosed {{name', {}), 'unclosed {{name');
});

test('snippets: multi-line input is joined with CR; run adds a final CR; bracketed paste wraps', () => {
  assert.equal(snippetInput('a\nb\n', true), 'a\rb\r');
  assert.equal(snippetInput('a\r\nb', false), 'a\rb');
  assert.equal(snippetInput('one', true, true), 'one\r');
  assert.equal(snippetInput('a\nb', true, true), '\x1b[200~a\rb\x1b[201~\r');
});

test('snippets: stored form round-trips and bad entries are dropped', () => {
  const list = snippetsFromJson([
    { id: 'a', name: 'Deploy', folder: ' ops ', body: 'make deploy', run: true },
    { id: 'b', name: 'Edit', body: 'vim ', run: false },
    { id: 'a', name: 'Duplicate id', body: 'x' },
    { id: '', name: 'No id', body: 'x' },
    { id: 'c', name: 'No body' },
    'nonsense',
  ]);
  assert.deepEqual(list.map((s) => s.id), ['a', 'b']);
  assert.equal(list[0].folder, 'ops');
  assert.equal(list[1].run, false);
  assert.deepEqual(snippetsFromJson(snippetsToJson(list)), list);
});

test('snippets: grouped by folder, no-folder first, filtered by search', () => {
  const list = snippetsFromJson([
    { id: '1', name: 'zeta', folder: 'b', body: 'z' },
    { id: '2', name: 'alpha', folder: '', body: 'a' },
    { id: '3', name: 'beta', folder: 'a', body: 'docker ps' },
  ]);
  assert.deepEqual(groupSnippets(list).map((g) => g.folder), ['', 'a', 'b']);
  assert.deepEqual(groupSnippets(list, 'docker').map((g) => g.snippets[0].id), ['3']);
});

/* --------------------------------- fuzzy --------------------------------- */

test('fuzzy: subsequence, case-insensitive; a non-match is null', () => {
  assert.ok(fuzzyScore('nt', 'New terminal') != null);
  assert.ok(fuzzyScore('NEWT', 'new terminal') != null);
  assert.equal(fuzzyScore('xyz', 'New terminal'), null);
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('fuzzy: contiguous and word-start matches score higher', () => {
  assert.ok(fuzzyScore('term', 'New terminal') > fuzzyScore('term', 'The rim'));
  assert.ok(fuzzyScore('nt', 'New terminal') > fuzzyScore('nt', 'Paste image into it'));
  assert.ok(fuzzyScore('paste', 'Paste') > fuzzyScore('paste', 'Paste image'));
});

test('fuzzy: a word-start jump never loses a match that exists', () => {
  assert.ok(fuzzyScore('ac', 'bac ad') != null);
});

test('fuzzy: filter ranks, keeps only matches, caps at the limit, empty query keeps order', () => {
  const items = ['Save transcript', 'Snippets…', 'Start recording', 'Search'].map((label) => ({ label }));
  assert.equal(fuzzyFilter(items, 'snip')[0].label, 'Snippets…');
  assert.deepEqual(fuzzyFilter(items, 'rec').map((i) => i.label), ['Start recording']);
  assert.equal(fuzzyFilter(items, '').length, 4);
  const many = Array.from({ length: 80 }, (_, i) => ({ label: `item ${i}` }));
  assert.equal(fuzzyFilter(many, 'item').length, 50);
});

/* ------------------------------- asciicast ------------------------------- */

test('asciicast: the recorder writes a v2 header, output and resize events', () => {
  const r = new CastRecorder({ cols: 80, rows: 24, title: 'build', startMs: 1_700_000_000_000 });
  r.output('hello\r\n', 1_700_000_000_500);
  r.resize(100, 30, 1_700_000_001_000);
  r.output('é', 1_700_000_002_250);
  const text = r.drain();
  const lines = text.trimEnd().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { version: 2, width: 80, height: 24, timestamp: 1_700_000_000, title: 'build' });
  assert.deepEqual(JSON.parse(lines[1]), [0.5, 'o', 'hello\r\n']);
  assert.deepEqual(JSON.parse(lines[2]), [1, 'r', '100x30']);
  assert.deepEqual(JSON.parse(lines[3]), [2.25, 'o', 'é']);
  assert.equal(r.bytes, utf8Length(text));
  assert.equal(r.duration, 2.25);
  assert.equal(r.drain(), '');
});

test('asciicast: the recorder stops at its size cap', () => {
  const r = new CastRecorder({ cols: 80, rows: 24, startMs: 0, maxBytes: 200 });
  let n = 0;
  while (r.output('x'.repeat(30), n * 10)) n++;
  assert.ok(r.full);
  assert.ok(r.bytes <= 200);
  assert.equal(r.output('more', 99999), false);
});

test('asciicast: time never runs backwards in a recording', () => {
  const r = new CastRecorder({ cols: 80, rows: 24, startMs: 1000 });
  r.output('a', 3000);
  r.output('b', 2000);
  const events = parseCast(r.drain()).events;
  assert.deepEqual(events.map((e) => e.t), [2, 2]);
});

test('asciicast: the parser reads what the recorder wrote and skips junk lines', () => {
  const r = new CastRecorder({ cols: 90, rows: 20, title: 't', startMs: 0 });
  r.output('a', 100);
  r.resize(120, 40, 200);
  const text = `${r.drain()}not json\n[1]\n["x","o","y"]\n\n`;
  const cast = parseCast(text);
  assert.equal(cast.header.width, 90);
  assert.equal(cast.header.title, 't');
  assert.deepEqual(cast.events, [{ t: 0.1, type: 'o', data: 'a' }, { t: 0.2, type: 'r', data: '120x40' }]);
  assert.deepEqual(parseSize('120x40'), [120, 40]);
  assert.equal(parseSize('bad'), null);
  assert.throws(() => parseCast('{"version":1}'), /version 2/);
  assert.throws(() => parseCast('garbage'), /not an asciicast/);
});

test('asciicast: the timeline caps idle gaps at one second when skipping idle', () => {
  const events = [{ t: 0.5, type: 'o', data: 'a' }, { t: 10, type: 'o', data: 'b' }, { t: 10.2, type: 'o', data: 'c' }];
  const skip = buildTimeline(events, { skipIdle: true });
  [0.5, 1.5, 1.7].forEach((want, i) => assert.ok(Math.abs(skip[i].at - want) < 1e-9, String(skip[i].at)));
  assert.ok(Math.abs(timelineDuration(skip) - 1.7) < 1e-9);
  const real = buildTimeline(events, { skipIdle: false });
  assert.equal(timelineDuration(real), 10.2);
});

test('asciicast: events up to a time, for seeking', () => {
  const tl = buildTimeline([{ t: 1, type: 'o', data: 'a' }, { t: 2, type: 'o', data: 'b' }, { t: 3, type: 'o', data: 'c' }], { skipIdle: false });
  assert.equal(eventsUpTo(tl, 0), 0);
  assert.equal(eventsUpTo(tl, 1), 1);
  assert.equal(eventsUpTo(tl, 2.5), 2);
  assert.equal(eventsUpTo(tl, 99), 3);
  assert.equal(eventsUpTo([], 5), 0);
});

test('asciicast: seeking = reset and replay reproduces the screen', () => {
  const r = new CastRecorder({ cols: 20, rows: 3, startMs: 0 });
  r.output('one\r\n', 0);
  r.output('two\r\n', 1000);
  r.output('\x1b[2Jthree', 2000);
  const tl = buildTimeline(parseCast(r.drain()).events, { skipIdle: false });
  const screenAt = (t) => {
    const em = new TerminalEmulator(20, 3, 100);
    for (let i = 0; i < eventsUpTo(tl, t); i++) em.feed(tl[i].data);
    return em;
  };
  const rowOf = (em, r) => em.rowText(em.totalRows() - em.rows + r, true);
  assert.equal(rowOf(screenAt(1.5), 1), 'two');
  assert.equal(rowOf(screenAt(1.5), 0), 'one');
  assert.equal(rowOf(screenAt(2), 0), '');
  assert.equal(rowOf(screenAt(2), 2), 'three');
});

test('asciicast: clock labels and file names', () => {
  assert.equal(formatClock(7), '0:07');
  assert.equal(formatClock(723), '12:03');
  assert.equal(formatClock(3729), '1:02:09');
  assert.match(castFileName('a/b:c', Date.UTC(2026, 8, 29, 10, 5)), /^a_b_c-2026092\d-\d{4}\.cast$/);
});

/* ------------------------------- triggers -------------------------------- */

test('triggers: reply escapes are decoded', () => {
  assert.equal(decodeReply('yes\\r'), 'yes\r');
  assert.equal(decodeReply('a\\nb\\tc\\e[A\\\\d'), 'a\nb\tc\x1b[A\\d');
  assert.equal(decodeReply('keep \\x as is\\'), 'keep \\x as is\\');
});

test('triggers: a regular expression pattern matches across chunks', () => {
  const w = new TextWatch('continue\\? \\[y/n\\]', false, { regex: true, reply: 'y\\r' });
  assert.equal(w.feed('Do you want to contin'), false);
  assert.equal(w.feed('ue? [Y/n] '), true);
  assert.ok(regexError('('));
  assert.ok(regexError('a*'));
  assert.equal(regexError('pass(word)?:'), null);
});

test('triggers: a trigger fires at most once every two seconds', () => {
  const w = new TextWatch('password:', true, { reply: 'x' });
  assert.equal(w.allowFire(1000), true);
  assert.equal(w.allowFire(1000 + TRIGGER_INTERVAL_MS - 1), false);
  assert.equal(w.allowFire(1000 + TRIGGER_INTERVAL_MS), true);
  const plain = new TextWatch('done', true);
  assert.equal(plain.allowFire(0), true);
  assert.equal(plain.allowFire(1), true);
});

/* ---------------------------- colour schemes ----------------------------- */

const WT_SCHEME = {
  name: 'Campbell',
  background: '#0C0C0C', foreground: '#CCCCCC', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF',
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798',
  cyan: '#3A96DD', white: '#CCCCCC', brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C',
  brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
};

test('schemes: hex values are normalised', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('ff0000'), '#ff0000');
  assert.equal(normalizeHex('#11223344'), '#112233');
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex(12), null);
});

test('schemes: a Windows Terminal scheme imports, alone, in a list, or from a settings file', () => {
  const one = parseSchemeImport(JSON.stringify(WT_SCHEME));
  assert.deepEqual(one.errors, []);
  assert.equal(one.schemes[0].name, 'Campbell');
  assert.equal(one.schemes[0].red, '#c50f1f');
  assert.match(one.schemes[0].id, /^user:[0-9a-f]{10}$/);
  assert.equal(parseSchemeImport(JSON.stringify([WT_SCHEME, WT_SCHEME])).schemes.length, 2);
  assert.equal(parseSchemeImport(JSON.stringify({ profiles: {}, schemes: [WT_SCHEME] })).schemes.length, 1);
});

test('schemes: missing colours and bad JSON are reported; cursor and selection have defaults', () => {
  const { cursorColor, selectionBackground, ...bare } = WT_SCHEME;
  const r = parseSchemeImport(JSON.stringify(bare));
  assert.equal(r.schemes[0].cursorColor, '#cccccc');
  assert.equal(r.schemes[0].selectionBackground, '#3b78ff');
  const { green, ...noGreen } = WT_SCHEME;
  assert.match(parseSchemeImport(JSON.stringify(noGreen)).errors[0], /green/);
  assert.match(parseSchemeImport('{nope').errors[0], /valid JSON/);
  assert.match(parseSchemeImport(JSON.stringify({ ...WT_SCHEME, name: '' })).errors[0], /no name/);
});

test('schemes: export is the Windows Terminal form and imports back unchanged', () => {
  const s = parseSchemeImport(JSON.stringify(WT_SCHEME)).schemes[0];
  const out = schemeToWindowsTerminal(s);
  assert.equal(out.id, undefined);
  assert.deepEqual(Object.keys(out), ['name', 'background', 'foreground', 'cursorColor', 'selectionBackground', ...ANSI_KEYS]);
  const back = parseSchemeImport(JSON.stringify(out)).schemes[0];
  assert.deepEqual({ ...back, id: null }, { ...s, id: null });
  assert.deepEqual(schemesFromJson(schemesToJson([s])), [s]);
});

test('schemes: a copy of a built-in paints the same, and user schemes register with the themes', () => {
  const copy = schemeFromTheme(GRUVBOX, 'Mine');
  const theme = themeFromScheme(copy);
  assert.equal(theme.background, GRUVBOX.background);
  assert.deepEqual(theme.palette.slice(0, 16), GRUVBOX.palette.slice(0, 16));
  assert.equal(theme.isLight, false);
  setCustomThemes([theme]);
  assert.equal(themeById(copy.id), theme);
  assert.equal(allThemes().length, ALL_THEMES.length + 1);
  setCustomThemes([]);
  assert.equal(themeById(copy.id).id, 'remote');
});

/* -------------------------------- backup --------------------------------- */

const SCHEME = { ...WT_SCHEME, id: 'user:0123456789' };

function sampleBackup() {
  return buildBackup({
    font_size: 15, cursor_style: 'bar', wheel_switch_tabs: false, terminal_theme: 'gruvbox',
    device_name: 'secret laptop', app_lock: true, favourite_machines: ['a'], 'wol.x': { mac: 'aa' },
  }, {
    presets: [{ id: 'p1', name: 'Logs', agentId: null, shellId: null, directory: '/var/log', command: 'tail -f syslog' }],
    snippets: [{ id: 's1', name: 'Deploy', folder: 'ops', body: 'make {{target:all}}', run: true }],
    customSchemes: [SCHEME],
    commandShortcuts: [['ls', 'ls -la']],
    appVersion: '0.13.0',
    now: 1_727_600_000_000,
  });
}

test('backup: holds only portable settings and the four lists', () => {
  const b = sampleBackup();
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.version, 1);
  assert.equal(b.app, 'desktop');
  assert.deepEqual(b.settings, {
    font_size: 15, cursor_style: 'bar', terminal_theme: 'gruvbox', wheel_switch_tabs: false, swipe_switch_tabs: false,
  });
  assert.equal(JSON.stringify(b).includes('secret laptop'), false);
  assert.equal(b.customSchemes[0].id, 'user:0123456789');
  assert.deepEqual(b.commandShortcuts, [{ label: 'ls', command: 'ls -la' }]);
});

test('backup: parse checks format and version, skips wrong types and unknown keys', () => {
  assert.match(parseBackup('nope').error, /not valid JSON/);
  assert.match(parseBackup('{"format":"other"}').error, /not a Remote Terminal backup/);
  assert.match(parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 2 })).error, /version 2/);
  const phone = {
    format: BACKUP_FORMAT, version: 1, app: 'android', appVersion: '0.13.0',
    presets: [{ id: 'p', name: 'P' }, { name: 'no id' }],
    snippets: [{ id: 's', name: 'S', body: 'x' }, 5],
    customSchemes: [SCHEME, { id: 'user:bad', name: 'Broken' }],
    commandShortcuts: [{ label: 'a', command: 'b' }, { label: 1 }],
    settings: {
      font_size: '16', scrollback_lines: '5000', cursor_blink: 'yes', bell: 'vibrate', haptics: true,
      swipe_switch_tabs: true, device_name: 'x', relay_url: 'wss://evil', unknown: 1,
    },
  };
  const r = parseBackup(JSON.stringify(phone));
  assert.ok(r.ok);
  assert.deepEqual(r.backup.settings, { font_size: 16, scrollback_lines: 5000, bell: 'sound', wheel_switch_tabs: true });
  assert.deepEqual(backupSummary(r.backup), { presets: 1, snippets: 1, schemes: 1, shortcuts: 1, settings: 4 });
});

test('backup: what the desktop writes, the desktop reads', () => {
  const r = parseBackup(JSON.stringify(sampleBackup()));
  assert.ok(r.ok);
  assert.equal(r.backup.presets[0].command, 'tail -f syslog');
  assert.equal(r.backup.snippets[0].body, 'make {{target:all}}');
  assert.deepEqual(r.backup.commandShortcuts, [['ls', 'ls -la']]);
});

test('backup: merge by id (incoming wins) or replace', () => {
  assert.deepEqual(mergeById([{ id: 'a', v: 1 }, { id: 'b', v: 1 }], [{ id: 'b', v: 2 }, { id: 'c', v: 2 }]),
    [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 2 }]);
  const current = {
    presets: [{ id: 'p0', name: 'Mine' }],
    snippets: [{ id: 's1', name: 'Old', folder: '', body: 'old', run: true }],
    customSchemes: [],
    commandShortcuts: [['ls', 'ls'], ['pwd', 'pwd']],
  };
  const incoming = parseBackup(JSON.stringify(sampleBackup())).backup;
  const merged = applyBackup(current, incoming, 'merge');
  assert.deepEqual(merged.presets.map((p) => p.id), ['p0', 'p1']);
  assert.equal(merged.snippets[0].name, 'Deploy');
  assert.deepEqual(merged.commandShortcuts, [['ls', 'ls -la'], ['pwd', 'pwd']]);
  const replaced = applyBackup(current, incoming, 'replace');
  assert.deepEqual(replaced.presets.map((p) => p.id), ['p1']);
  assert.deepEqual(replaced.commandShortcuts, [['ls', 'ls -la']]);
  assert.equal(replaced.settings.font_size, 15);
});

/* ------------------------------ Wake-on-LAN ------------------------------ */

test('wol: MAC addresses in every common notation', () => {
  const want = 'aa:bb:cc:dd:ee:ff';
  for (const s of ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'AABBCCDDEEFF', ' aa:bb:cc:dd:ee:ff ']) {
    assert.equal(formatMac(parseMac(s)), want, s);
  }
  for (const s of ['aa:bb:cc:dd:ee', 'aa:bb-cc:dd:ee:ff', 'gg:bb:cc:dd:ee:ff', '', null, 'aabbccddeeff00']) {
    assert.equal(parseMac(s), null, String(s));
  }
});

test('wol: the magic packet is 6 × FF then the MAC 16 times', () => {
  const p = magicPacket('01:23:45:67:89:ab');
  assert.equal(p.length, 102);
  assert.deepEqual([...p.slice(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.deepEqual([...p.slice(6 + i * 6, 12 + i * 6)], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
  assert.throws(() => magicPacket('nope'));
});

test('wol: directed broadcast from an interface cidr', () => {
  assert.equal(directedBroadcast('192.168.1.20/24'), '192.168.1.255');
  assert.equal(directedBroadcast('10.1.2.3/8'), '10.255.255.255');
  assert.equal(directedBroadcast('172.16.5.4/20'), '172.16.15.255');
  assert.equal(directedBroadcast('10.0.0.1/32'), '255.255.255.255');
  assert.equal(directedBroadcast('fe80::1/64'), null);
  assert.equal(directedBroadcast('1.2.3.4'), null);
  assert.equal(parseIPv4('256.1.1.1'), null);
});

test('wol: remembered from sys.info — the first interface with a MAC and an IPv4 address', () => {
  const info = {
    hostname: 'h', platform: 'linux',
    interfaces: [
      { name: 'wg0', addresses: [{ family: 'IPv4', address: '10.9.0.1', cidr: '10.9.0.1/24' }] },
      { name: 'eth1', mac: 'aa:bb:cc:dd:ee:01', addresses: [{ family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64' }] },
      { name: 'eth0', mac: 'AA:BB:CC:DD:EE:FF', addresses: [{ family: 'IPv4', address: '192.168.1.20', cidr: '192.168.1.20/24' }] },
    ],
  };
  assert.deepEqual(wolFromSysInfo(info), { mac: 'aa:bb:cc:dd:ee:ff', broadcast: '192.168.1.255', port: 9 });
  assert.equal(wolFromSysInfo({ interfaces: [] }), null);
  assert.equal(wolFromSysInfo(null), null);
  assert.deepEqual(wolConfig({ mac: 'aabbccddeeff', broadcast: 'nope', port: 0 }), { mac: 'aa:bb:cc:dd:ee:ff', broadcast: '255.255.255.255', port: 9 });
  assert.equal(wolConfig({ mac: 'x' }), null);
});

/* ------------------------------ system view ------------------------------ */

test('system: ports sorted by port then protocol, and filtered', () => {
  const ports = [
    { proto: 'udp', family: 'IPv4', address: '0.0.0.0', port: 53, pid: 10, process: 'dnsmasq' },
    { proto: 'tcp', family: 'IPv6', address: '::', port: 22, pid: 1, process: 'sshd' },
    { proto: 'tcp', family: 'IPv4', address: '0.0.0.0', port: 53, pid: 10, process: 'dnsmasq' },
    { proto: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5432, pid: null, process: null },
  ];
  assert.deepEqual(arrangePorts(ports).map((p) => `${p.port}/${p.proto}`), ['22/tcp', '53/tcp', '53/udp', '5432/tcp']);
  assert.deepEqual(arrangePorts(ports, 'dns').map((p) => p.proto), ['tcp', 'udp']);
  assert.deepEqual(arrangePorts(ports, 'udp').length, 1);
  assert.deepEqual(arrangePorts(ports, '54').map((p) => p.port), [5432]);
  assert.equal(endpoint(ports[1]), '[::]:22');
  assert.equal(endpoint(ports[0]), '0.0.0.0:53');
  assert.equal(processLabel(ports[1]), 'sshd (1)');
  assert.equal(processLabel(ports[3]), null);
});
