/**
 * The wire protocol: descriptive objects, the incoming parser, the outgoing
 * builders and the stream/attach state machine — the Android app's
 * `MessagesTest` and `SessionStreamTest` carried over.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { agentFromJson, Outgoing, isRunning, isWindows } from '../ui/js/protocol/messages.js';
import { parseIncoming, errorDisplay } from '../ui/js/protocol/incoming.js';
import { SessionStream, State, Verdict } from '../ui/js/protocol/stream.js';

const agentJson = {
  agentId: 'a_k3x7m2q9p4w8n6b5v1c0',
  name: 'Prod',
  hostname: 'prod-01',
  platform: 'linux',
  os: 'Ubuntu 24.04',
  arch: 'x64',
  agentVersion: '0.3.0',
  protocol: 3,
  shells: [{ id: 'bash', label: 'bash', default: true }, { id: 'sh' }],
  caps: ['sessions', 'replay'],
  online: true,
  lastSeen: 1725264000000,
  instanceId: 'abc',
  sessions: [{
    sessionId: 's_k3x7m2q9p4w8n6b5v1c0', title: 'Logs', shell: 'bash', state: 'running',
    createdAt: 1, lastActiveAt: 2, cols: 100, rows: 30, seq: 42, attached: 1, exitCode: null,
  }],
};

/* ------------------------------- messages -------------------------------- */

test('parses AgentInfo with shells and sessions', () => {
  const a = agentFromJson(agentJson);
  assert.equal(a.name, 'Prod');
  assert.equal(a.platform, 'linux');
  assert.equal(isWindows(a), false);
  assert.deepEqual(a.shells.map((s) => s.id), ['bash', 'sh']);
  assert.equal(a.shells[0].isDefault, true);
  assert.equal(a.shells[1].label, 'sh');
  assert.equal(a.online, true);
  assert.equal(a.lastSeen, 1725264000000);
  assert.equal(a.instanceId, 'abc');
  const s = a.sessions[0];
  assert.equal(s.title, 'Logs');
  assert.equal(isRunning(s), true);
  assert.equal(s.seq, 42);
  assert.equal(s.exitCode, null);
  assert.equal(s.attached, 1);
});

test('parses welcome and the events that follow it', () => {
  const w = parseIncoming(JSON.stringify({
    type: 'welcome', v: 3, connId: 'c_1', accountId: 'default', deviceId: 'd_1', caps: ['ping'],
    limits: { maxSessionsPerAgent: 4 },
    agents: [agentJson],
    devices: [{ deviceId: 'd_1', name: 'Desktop', isSelf: true, createdAt: 5 }],
  }));
  assert.equal(w.kind, 'welcome');
  assert.equal(w.version, 3);
  assert.equal(w.limits.maxSessionsPerAgent, 4);
  assert.equal(w.limits.maxSessionsPerAccount, 64);
  assert.equal(w.agents.length, 1);
  assert.equal(w.devices[0].isSelf, true);

  const out = parseIncoming('{"type":"output","agent":"a_1","session":"s_1","seq":17,"data":"hi\\u001b[31m"}');
  assert.equal(out.kind, 'output');
  assert.equal(out.seq, 17);
  assert.equal(out.data, 'hi\x1b[31m');

  const att = parseIncoming('{"type":"session.attached","reqId":"r1","agent":"a_1","session":"s_1","from":5,"seq":12,"cols":80,"rows":24}');
  assert.equal(att.reqId, 'r1');
  assert.equal(att.from, 5);
  assert.equal(att.seq, 12);

  const upd = parseIncoming('{"type":"session.updated","agent":"a_1","session":"s_1","cols":90,"rows":20}');
  assert.equal(upd.title, null);
  assert.equal(upd.cols, 90);

  const err = parseIncoming('{"type":"error","code":"agent_offline","message":"agent is offline","reqId":"r9"}');
  assert.equal(err.reqId, 'r9');
  assert.equal(errorDisplay(err), 'The machine is offline.');

  const exit = parseIncoming('{"type":"exit","agent":"a_1","session":"s_1","code":null}');
  assert.equal(exit.code, null);

  assert.equal(parseIncoming('{"type":"pong"}').kind, 'pong');
  const unknown = parseIncoming('{"type":"weird"}');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.type, 'weird');
});

test('outgoing builders produce the protocol shapes', () => {
  const create = JSON.parse(Outgoing.sessionCreate('r1', 'a_1', 'bash', 100, 30, 'Logs'));
  assert.equal(create.type, 'session.create');
  assert.equal(create.shell, 'bash');
  assert.equal(create.rows, 30);
  const noShell = JSON.parse(Outgoing.sessionCreate('r2', 'a_1', null, 80, 24, null));
  assert.equal('shell' in noShell, false);
  assert.equal('title' in noShell, false);

  const attach = JSON.parse(Outgoing.sessionAttach('r3', 'a_1', 's_1', 40, 80, 24));
  assert.equal(attach.since, 40);
  assert.equal('since' in JSON.parse(Outgoing.sessionAttach('r4', 'a_1', 's_1', null, 80, 24)), false);

  const input = JSON.parse(Outgoing.input('a_1', 's_1', 'ls\r'));
  assert.equal(input.data, 'ls\r');
  assert.equal(input.agent, 'a_1');
  assert.equal(JSON.parse(Outgoing.resize('a_1', 's_1', 1, 2)).type, 'resize');
  assert.equal(JSON.parse(Outgoing.deviceRevoke('d_2')).type, 'device.revoke');
  assert.equal(JSON.parse(Outgoing.ping()).type, 'ping');
});

/* ----------------------------- session stream ---------------------------- */

test('the first attach is a full replay, then live output applies', () => {
  const s = new SessionStream();
  const { reqId, since } = s.beginAttach(80, 24);
  assert.equal(since, null, 'no history: full replay');
  assert.equal(s.state, State.ATTACHING);
  assert.equal(s.onOutput(5, 5), Verdict.IGNORE);
  const r = s.onAttached(reqId, 0, 10, 80, 24);
  assert.equal(r.accepted, true);
  assert.equal(r.resetScreen, true);
  assert.equal(r.outputLost, false);
  assert.equal(s.onOutput(6, 6), Verdict.APPLY);   // replay chunk [0,6)
  assert.equal(s.onOutput(10, 4), Verdict.APPLY);  // replay chunk [6,10)
  assert.equal(s.onOutput(13, 3), Verdict.APPLY);  // live
  assert.equal(s.lastSeq, 13);
  assert.equal(s.onOutput(13, 3), Verdict.DUPLICATE);
  assert.equal(s.onOutput(8, 2), Verdict.DUPLICATE);
});

test('re-attaching with the same geometry resumes with `since`', () => {
  const s = new SessionStream();
  const first = s.beginAttach(100, 30);
  s.onAttached(first.reqId, 0, 0, 100, 30);
  s.onOutput(40, 40);
  s.onDisconnected();
  const second = s.beginAttach(100, 30);
  assert.equal(second.since, 40);
  const a = s.onAttached(second.reqId, 40, 47, 100, 30);
  assert.equal(a.accepted, true);
  assert.equal(a.resetScreen, false);
  assert.equal(a.outputLost, false);
  assert.equal(s.onOutput(47, 7), Verdict.APPLY);
});

test('a geometry change forces a full replay', () => {
  const s = new SessionStream();
  const first = s.beginAttach(100, 30);
  s.onAttached(first.reqId, 0, 0, 100, 30);
  s.onOutput(40, 40);
  s.onDisconnected();
  assert.equal(s.beginAttach(80, 24).since, null, 'different width: history is not reusable');
});

test('a lost range is reported and the stream resumes at `from`', () => {
  const s = new SessionStream();
  const first = s.beginAttach(80, 24);
  s.onAttached(first.reqId, 0, 0, 80, 24);
  s.onOutput(100, 100);
  s.onDisconnected();
  const second = s.beginAttach(80, 24);
  assert.equal(second.since, 100);
  const a = s.onAttached(second.reqId, 5000, 6000, 80, 24); // the ring buffer moved past us
  assert.equal(a.outputLost, true);
  assert.equal(a.resetScreen, true);
  assert.equal(s.lastSeq, 5000);
  assert.equal(s.onOutput(6000, 1000), Verdict.APPLY);
});

test('stale acknowledgements are ignored and gaps detach', () => {
  const s = new SessionStream();
  const old = s.beginAttach(80, 24);
  const fresh = s.beginAttach(80, 24);
  assert.equal(s.onAttached(old.reqId, 0, 0, 80, 24).accepted, false);
  assert.equal(s.state, State.ATTACHING);
  assert.equal(s.onAttached(fresh.reqId, 0, 0, 80, 24).accepted, true);
  assert.equal(s.onOutput(3, 3), Verdict.APPLY);
  assert.equal(s.onOutput(10, 3), Verdict.GAP);
  assert.equal(s.state, State.DETACHED);
  assert.equal(s.lastSeq, 3);
  assert.equal(s.beginAttach(80, 24).since, 3);
});

test('lag and reset behave', () => {
  const s = new SessionStream();
  const a = s.beginAttach(80, 24);
  s.onAttached(a.reqId, 0, 0, 80, 24);
  s.onOutput(9, 9);
  s.onLag();
  assert.equal(s.state, State.DETACHED);
  assert.equal(s.beginAttach(80, 24).since, 9);
  s.reset();
  assert.equal(s.lastSeq, 0);
  assert.equal(s.beginAttach(80, 24).since, null);
});

test('noteGeometry keeps `since` after a resize while attached', () => {
  const s = new SessionStream();
  const a = s.beginAttach(80, 24);
  s.onAttached(a.reqId, 0, 0, 80, 24);
  s.onOutput(20, 20);
  s.noteGeometry(120, 40); // the PTY was resized while attached
  s.onOutput(30, 10);
  s.onDisconnected();
  assert.equal(s.beginAttach(120, 40).since, 30);
});
