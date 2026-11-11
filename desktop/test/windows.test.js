/**
 * The 0.15 features: the prompt composer's text (the Android app's
 * `PromptTest` carried over), settings kept in step between the main window
 * and a terminal window, and a terminal moved into a window of its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { promptText, fileName, newPromptDraft } from '../ui/js/core/prompt.js';
import { Settings } from '../ui/js/core/settings.js';
import { TerminalSession } from '../ui/js/core/sessions.js';
import { State } from '../ui/js/protocol/stream.js';

/* -------------------------------- prompt -------------------------------- */

test('prompt: text alone is sent without trailing blank space', () => {
  assert.equal(promptText('explain this\n\n  ', []), 'explain this');
  assert.equal(promptText('a\r\nb', []), 'a\nb');
});

test('prompt: uploaded paths follow the text after a space', () => {
  assert.equal(promptText('look at', ['/tmp/rt/shot.png']), 'look at /tmp/rt/shot.png');
  assert.equal(promptText('two', ['/tmp/a.txt', '/tmp/b.txt']), 'two /tmp/a.txt /tmp/b.txt');
});

test('prompt: files alone are just their paths', () => {
  assert.equal(promptText('   ', ['/tmp/a.txt']), '/tmp/a.txt');
});

test('prompt: paths are quoted the way the machine needs', () => {
  assert.equal(promptText('see', ['/tmp/my file.txt']), "see '/tmp/my file.txt'");
  assert.equal(promptText('see', ['C:\\Users\\me\\a b.png']), 'see "C:\\Users\\me\\a b.png"');
});

test('prompt: missing paths are skipped', () => {
  assert.equal(promptText('hi', [undefined, '', '/x']), 'hi /x');
});

test('prompt: a chip shows the last part of a local path', () => {
  assert.equal(fileName('C:\\Users\\me\\shot.png'), 'shot.png');
  assert.equal(fileName('/home/me/notes.md'), 'notes.md');
});

test('prompt: a new draft is empty and remembers the Enter choice', () => {
  assert.deepEqual(newPromptDraft(false), { text: '', files: [], enter: false });
});

/* ------------------------------- settings ------------------------------- */

function settingsWith(values) {
  const s = new Settings();
  s.values = { ...values };
  s.diffSinceSync();
  s.writesDisk = false; // no file in a test
  return s;
}

test('settings: a flush tells the other windows only what changed', async () => {
  const main = settingsWith({ font_size: 13, command_bar: true });
  const sent = [];
  main.onSync = (changes) => sent.push(changes);
  main.fontSize = 15;
  await main.flush();
  assert.deepEqual(sent, [{ font_size: 15 }]);
  await main.flush();
  assert.equal(sent.length, 1, 'nothing new, nothing sent');
});

test('settings: a removed key travels as null', async () => {
  const main = settingsWith({ 'theme.a|1': 'nord' });
  const sent = [];
  main.onSync = (changes) => sent.push(changes);
  main.setTerminalTheme('a|1', null);
  await main.flush();
  assert.deepEqual(sent, [{ 'theme.a|1': null }]);
});

test('settings: changes from another window apply and are not sent back', async () => {
  const main = settingsWith({ font_size: 13 });
  const win = settingsWith({ font_size: 13 });
  const back = [];
  main.onSync = (changes) => back.push(changes);
  win.onSync = (changes) => main.applyRemote(changes);
  let heard = 0;
  main.on('changed', () => heard++);

  win.fontSize = 18;
  await win.flush();
  assert.equal(main.fontSize, 18);
  assert.equal(heard, 1);
  await main.flush();
  assert.deepEqual(back, [], 'the main window does not echo it');

  win.onSync({ font_size: null });
  assert.equal(main.get('font_size'), undefined);
});

/* --------------------------- terminal windows --------------------------- */

test('sessions: a tab moved into a window is never attached from here', async () => {
  const { SessionRepository } = await import('../ui/js/core/sessions.js');
  const sent = [];
  const client = {
    isConnected: true,
    on() {},
    send: (msg) => { sent.push(msg); return true; },
  };
  const agents = { agents: [], session: () => null, agent: () => ({ online: true }) };
  const settings = settingsWith({});
  const repo = new SessionRepository(client, agents, settings);
  const s = repo.get('a', '1');

  repo.moveToWindow(s, 'term-1');
  assert.equal(s.windowLabel, 'term-1');
  assert.equal(repo.inWindow('term-1'), s);
  sent.length = 0;
  repo.attach(s, 80, 24);
  assert.equal(sent.length, 0);
  assert.equal(s.stream.state, State.DETACHED);
  assert.deepEqual(settings.openTabs('a'), ['1'], 'still remembered as a tab');

  assert.equal(repo.returnFromWindow('term-1'), s);
  assert.equal(s.windowLabel, null);
  repo.attach(s, 80, 24);
  assert.equal(sent.length, 1, 'attached again once it is back');
});

test('sessions: a terminal window neither restores nor saves tabs', async () => {
  const { SessionRepository } = await import('../ui/js/core/sessions.js');
  const client = { isConnected: false, on() {}, send: () => true };
  const agents = { agents: [{ agentId: 'a' }], session: () => null, agent: () => null };
  const settings = settingsWith({ 'tabs.a': ['1', '2'] });
  const repo = new SessionRepository(client, agents, settings, { persistTabs: false });
  assert.equal(repo.sessions.size, 0);
  repo.get('a', '9');
  assert.deepEqual(settings.openTabs('a'), ['1', '2']);
  assert.ok(new TerminalSession('a', '9', 100));
});
