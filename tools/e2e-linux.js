#!/usr/bin/env node
'use strict';

/*
 * End-to-end validation on a Linux host: a real relay, a real agent hosting
 * real bash sessions, and a scripted "phone" speaking protocol v3.
 *
 *   node tools/e2e-linux.js
 *
 * Exercises the automatable part of the README's validation scenario:
 * enrolment, pairing, two simultaneous terminals, ANSI colours, Ctrl+C,
 * resize, phone disconnect → re-attach with `since` (no duplicate output),
 * full replay, closing one terminal without affecting the other, agent
 * restart (new instanceId), and revocation (agent exits, token dead).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { httpJson, open } = require('../server/test/helpers');
const RELAY = path.join(ROOT_DIR(), 'server', 'index.js');
function ROOT_DIR() { return path.join(__dirname, '..'); }

/** Start the relay with visible logs (warnings/errors and crashes are printed). */
function startRelay(env) {
  const child = spawn(process.execPath, [RELAY], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { for (const line of d.toString().split('\n')) if (line && (process.env.E2E_VERBOSE || /"level":"(warn|error)"/.test(line))) console.log('[relay] ' + line); });
  child.stderr.on('data', (d) => process.stdout.write('[relay:err] ' + d));
  child.on('exit', (code, sig) => console.log(`[relay] exited code=${code} signal=${sig}`));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = () => httpJson(`http://127.0.0.1:${env.PORT}`, 'GET', '/health').then((r) => (r.status === 200 ? resolve(child) : retry())).catch(retry);
    const retry = () => (Date.now() > deadline ? reject(new Error('relay did not start')) : setTimeout(poll, 100));
    poll();
  });
}

const ROOT = path.join(__dirname, '..');
const AGENT = path.join(ROOT, 'agent', 'index.js');
const PORT = 18450;
const ENROLL = 'e2e-enroll-token';
const results = [];
let failed = 0;
let lastCheck = '(none)';

function check(name, ok, detail) {
  lastCheck = name;
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentEnv(stateFile) {
  // A config file pins bash to --norc/--noprofile so the host's rc files (prompt hooks,
  // shell integrations) cannot make the scenario timing-dependent.
  const cfgFile = path.join(path.dirname(stateFile), 'agent-config.json');
  if (!fs.existsSync(cfgFile)) {
    fs.writeFileSync(cfgFile, JSON.stringify({ shells: [{ id: 'bash', label: 'bash', cmd: '/bin/bash', args: ['--norc', '--noprofile'] }, { id: 'sh', label: 'sh', cmd: '/bin/sh', args: [] }] }));
  }
  return Object.assign({}, process.env, {
    CONFIG: cfgFile,
    SERVER: `ws://127.0.0.1:${PORT}`, ENROLL_TOKEN: ENROLL, AGENT_STATE: stateFile, AGENT_NAME: 'E2E Ubuntu',
    LOG_LEVEL: 'warn', ALLOW_ROOT: '1', BASE_BACKOFF_MS: '200', MAX_BACKOFF_MS: '1000', EXITED_RETENTION_SEC: '2', SWEEP_INTERVAL_MS: '500',
    // Fast enough that the scenario can watch a second sample arrive (2s is the floor the agent clamps to).
    METRICS_INTERVAL_MS: '2000',
  });
}

function startAgent(stateFile) {
  const child = spawn(process.execPath, [AGENT], { env: agentEnv(stateFile), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write('[agent] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[agent:err] ' + d));
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
}

async function waitFor(pred, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(step); }
  return false;
}

function agentCli(stateFile, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [AGENT, ...args], { env: agentEnv(stateFile) }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

/** Scripted phone with per-session output accumulation and seq tracking. */
async function connectPhone(deviceToken) {
  const ws = open(`ws://127.0.0.1:${PORT}/?v=3&role=phone`, { Authorization: `Bearer ${deviceToken}` });
  await ws.ready;
  ws.welcome = await ws.next((m) => m.type === 'welcome');
  ws.streams = new Map(); // sessionId -> { text, lastSeq, dups }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== 'output') return;
    let s = ws.streams.get(m.session);
    if (!s) { s = { text: '', lastSeq: 0, dups: 0, gaps: 0 }; ws.streams.set(m.session, s); }
    if (m.seq <= s.lastSeq) { s.dups++; return; }
    if (m.seq - m.data.length !== s.lastSeq && s.lastSeq !== 0) s.gaps++;
    s.text += m.data; s.lastSeq = m.seq;
  });
  ws.textOf = (sid) => (ws.streams.get(sid) || { text: '' }).text;
  ws.waitText = (sid, needle, ms = 10000) => waitFor(() => ws.textOf(sid).includes(needle), ms, 50);
  /** Resolve once no output has arrived for `quietMs` (prompt redraws etc. have landed). */
  ws.settle = async (sid, quietMs = 500) => {
    for (;;) {
      const before = (ws.streams.get(sid) || { lastSeq: 0 }).lastSeq;
      await sleep(quietMs);
      if ((ws.streams.get(sid) || { lastSeq: 0 }).lastSeq === before) return before;
    }
  };
  ws.create = async (agent, shell, cols = 100, rows = 30, title) => {
    const reqId = 'c' + Math.random().toString(36).slice(2, 8);
    ws.sendJson({ type: 'session.create', reqId, agent, shell, cols, rows, title });
    const m = await ws.next((x) => (x.type === 'session.created' || x.type === 'error') && x.reqId === reqId, 8000);
    if (m.type === 'error') throw new Error('create failed: ' + m.message);
    return m.session.sessionId;
  };
  ws.attach = async (agent, session, since, cols = 100, rows = 30) => {
    const reqId = 'a' + Math.random().toString(36).slice(2, 8);
    const msg = { type: 'session.attach', reqId, agent, session, cols, rows };
    if (since !== undefined) msg.since = since;
    ws.sendJson(msg);
    const m = await ws.next((x) => (x.type === 'session.attached' || x.type === 'error') && x.reqId === reqId, 8000);
    if (m.type === 'error') throw new Error('attach failed: ' + m.message);
    return m;
  };
  ws.type = (agent, session, data) => ws.sendJson({ type: 'input', agent, session, data });
  /** Wait for the shell prompt: some output, then quiet. Typing before an interactive
   *  shell finishes its init scripts is discarded by readline's tty reset. */
  ws.prompt = async (sid) => { await waitFor(() => (ws.streams.get(sid) || { lastSeq: 0 }).lastSeq > 0, 15000, 50); return ws.settle(sid, 400); };
  return ws;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-e2e-'));
  const stateFile = path.join(tmp, 'agent-state.json');
  const base = `http://127.0.0.1:${PORT}`;
  console.log('Starting relay…');
  const relay = await startRelay({ PORT: String(PORT), ENROLL_TOKEN: ENROLL, LOG_LEVEL: 'warn', STATE_FILE: path.join(tmp, 'relay-state.json') });
  let agent = null;
  try {
    console.log('Starting agent (real bash)…');
    agent = startAgent(stateFile);
    const enrolled = await waitFor(() => fs.existsSync(stateFile) && /"agentId": "a_/.test(fs.readFileSync(stateFile, 'utf8')), 15000);
    check('agent enrols itself on first run', enrolled);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check('state file is private (0600)', (fs.statSync(stateFile).mode & 0o777) === 0o600);

    const pairOut = await agentCli(stateFile, ['--pair']);
    const code = (pairOut.match(/Pairing code:\s+([0-9]{6})/) || [])[1];
    check('--pair prints a 6-digit code', !!code, code ? 'code hidden' : pairOut.trim());
    const red = await httpJson(base, 'POST', '/v3/pair/redeem', { code, deviceName: 'E2E Phone', platform: 'android' });
    check('phone redeems the code for a device token', red.status === 201, JSON.stringify(red.body.error || ''));
    const deviceToken = red.body.deviceToken;

    const statusOut = await agentCli(stateFile, ['--status']);
    check('--status reports the relay connection', /Relay status:\s+connected/.test(statusOut), statusOut.split('\n').find((l) => /Relay status/.test(l)));

    let phone = await connectPhone(deviceToken);
    const a = phone.welcome.agents.find((x) => x.agentId === state.agentId);
    check('welcome lists the agent online with metadata', !!a && a.online && a.platform === 'linux' && /Ubuntu|Linux/.test(a.os), a && `${a.name} · ${a.os} · shells=${a.shells.map((s) => s.id).join(',')}`);
    check('bash is an advertised shell', !!a && a.shells.some((s) => s.id === 'bash'));
    const agentId = state.agentId;

    // System metrics: the register payload carries a first sample, and the
    // machine screen keeps getting fresh ones while the agent is connected.
    const m0 = a && a.metrics;
    check('welcome carries system metrics for this Linux box',
      !!m0 && m0.memoryTotal > 0 && m0.memoryUsed > 0 && m0.memoryUsed < m0.memoryTotal && m0.storageTotal > 0 && m0.uptimeSec > 0,
      m0 && `mem ${Math.round((m0.memoryUsed / m0.memoryTotal) * 100)}% of ${(m0.memoryTotal / 1024 ** 3).toFixed(1)}GiB · disk ${Math.round((m0.storageUsed / m0.storageTotal) * 100)}% · up ${Math.round(m0.uptimeSec / 60)}min`);
    const m1 = await phone.next((m) => m.type === 'agent.metrics', 8000);
    check('metrics refresh on their own timer, with a CPU figure once there are two samples',
      m1.agent === agentId && typeof m1.metrics.cpuLoad === 'number' && m1.metrics.cpuLoad >= 0 && m1.metrics.cpuLoad <= 1,
      `cpu ${Math.round(m1.metrics.cpuLoad * 100)}%`);

    // Two simultaneous terminals.
    const s1 = await phone.create(agentId, 'bash', 100, 30, 'Terminal 1');
    const s2 = await phone.create(agentId, 'bash', 100, 30, 'Terminal 2');
    check('two bash sessions created', /^s_/.test(s1) && /^s_/.test(s2) && s1 !== s2);
    const at1 = await phone.attach(agentId, s1);
    const at2 = await phone.attach(agentId, s2);
    check('attach acknowledged with geometry', at1.cols === 100 && at1.rows === 30 && at2.session === s2);
    await phone.prompt(s1); await phone.prompt(s2);

    phone.type(agentId, s1, 'echo hello-from-one\r');
    phone.type(agentId, s2, 'printf "\\033[32mgreen-two\\033[0m\\n"\r');
    check('session 1 output arrives', await phone.waitText(s1, 'hello-from-one\r\n'));
    check('session 2 ANSI colour output arrives', await phone.waitText(s2, '\x1b[32mgreen-two\x1b[0m'), JSON.stringify(phone.textOf(s2).slice(-160)));
    check('outputs are not cross-routed', !phone.textOf(s1).includes('green-two') && !phone.textOf(s2).includes('hello-from-one'));

    // Ctrl+C interrupts a running command.
    // The typed line is echoed back verbatim, so use markers that only exist once executed.
    phone.type(agentId, s1, 'sleep 30; echo NOT_$((1+1))_REACHED\r');
    await sleep(400);
    phone.type(agentId, s1, '\x03');
    phone.type(agentId, s1, 'echo after_$((2+2))_ctrl_c\r');
    check('Ctrl+C interrupts sleep', await phone.waitText(s1, 'after_4_ctrl_c\r\n') && !phone.textOf(s1).includes('NOT_2_REACHED'));

    // Resize is applied to the PTY.
    phone.sendJson({ type: 'resize', agent: agentId, session: s1, cols: 120, rows: 40 });
    await sleep(200);
    phone.type(agentId, s1, 'stty size\r');
    check('resize reaches the PTY (stty size)', await phone.waitText(s1, '40 120'));

    // Same shell process before/after a phone reconnect.
    phone.type(agentId, s1, 'echo pid=$$\r');
    await waitFor(() => /pid=\d+/.test(phone.textOf(s1)));
    const pid = (phone.textOf(s1).match(/pid=(\d+)/) || [])[1];
    const lastSeq = await phone.settle(s1);
    phone.close();
    await sleep(300);
    phone = await connectPhone(deviceToken);
    const again = phone.welcome.agents.find((x) => x.agentId === agentId);
    check('sessions survive the phone disconnect', again.sessions.length === 2 && again.sessions.every((s) => s.state === 'running' && s.attached === 0),
      again.sessions.map((s) => `${s.title}:${s.state}`).join(', '));
    const re = await phone.attach(agentId, s1, lastSeq, 120, 40);
    check('re-attach with since resumes exactly at the recorded position', re.from === lastSeq && re.seq === lastSeq, `from=${re.from} since=${lastSeq}`);
    await sleep(200);
    check('no output was replayed for a fully caught-up phone', !phone.streams.has(s1) || phone.streams.get(s1).text === '');
    phone.streams.set(s1, { text: '', lastSeq, dups: 0, gaps: 0 });
    phone.type(agentId, s1, 'echo pid=$$\r');
    await waitFor(() => /pid=\d+/.test(phone.textOf(s1)));
    const pid2 = (phone.textOf(s1).match(/pid=(\d+)/) || [])[1];
    check('typing continues into the same shell process', pid && pid === pid2, `pid ${pid} → ${pid2}`);
    check('no duplicate or gapped output chunks after re-attach', phone.streams.get(s1).dups === 0 && phone.streams.get(s1).gaps === 0);

    // Full replay restores earlier output for a phone without history.
    const other = await connectPhone(deviceToken);
    const full = await other.attach(agentId, s2, undefined, 100, 30);
    check('full replay covers the history from the ring buffer', full.from === 0 && (await other.waitText(s2, 'green-two')));
    other.close();

    // Close one terminal; the other keeps working.
    phone.sendJson({ type: 'session.close', agent: agentId, session: s2 });
    const closed = await phone.next((m) => m.type === 'session.closed' && m.session === s2, 8000);
    check('closing one session reports session.closed', closed.reason === 'closed');
    phone.type(agentId, s1, 'echo still-alive\r');
    check('the other session keeps working', await phone.waitText(s1, 'still-alive\r\n'));

    // Process exit is reported and the session lingers until retention expires.
    lastCheck = 'creating session 3';
    const s3 = await phone.create(agentId, 'bash');
    lastCheck = 'attaching session 3';
    await phone.attach(agentId, s3);
    await phone.prompt(s3);
    lastCheck = 'waiting for exit of session 3';
    phone.type(agentId, s3, 'exit 5\r');
    const exit = await phone.next((m) => m.type === 'exit' && m.session === s3, 8000);
    check('shell exit code is reported', exit.code === 5, `code=${exit.code}`);
    const retired = await phone.next((m) => m.type === 'session.closed' && m.session === s3, 8000);
    check('exited session is closed after retention', retired.reason === 'exited');

    // Agent restart: sessions end with reason "shutdown", identity persists, instanceId changes.
    const inst1 = again.instanceId;
    agent.kill('SIGTERM');
    const shut = await phone.next((m) => m.type === 'session.closed' && m.session === s1, 8000);
    check('agent shutdown closes sessions with reason shutdown', shut.reason === 'shutdown');
    await phone.next((m) => m.type === 'agent.offline', 8000);
    await agent.exited;
    agent = startAgent(stateFile);
    const online = await phone.next((m) => m.type === 'agent.online', 15000);
    check('restarted agent keeps its identity and gets a new instanceId', online.agent.agentId === agentId && online.agent.instanceId !== inst1 && online.agent.sessions.length === 0);

    // Revocation from the phone: the agent process exits and its token is dead.
    phone.sendJson({ type: 'agent.remove', agent: agentId });
    await phone.next((m) => m.type === 'agent.removed', 8000);
    const exitCode = await Promise.race([agent.exited, sleep(8000).then(() => 'timeout')]);
    check('revoked agent exits (code 2) and marks its identity invalid', exitCode === 2 && JSON.parse(fs.readFileSync(stateFile, 'utf8')).invalid === true, `exit=${exitCode}`);
    agent = null;
    const me = await httpJson(base, 'GET', '/v3/agents/me', undefined, { Authorization: `Bearer ${state.agentToken}` });
    check('revoked token is rejected by the relay', me.status === 401);
    const stats = await httpJson(base, 'GET', '/stats');
    check('/stats has no identifiers', stats.status === 200 && !/[ad]_[a-z2-7]{20}/.test(JSON.stringify(stats.body)));
    phone.close();
  } catch (err) {
    check('scenario completed without exceptions', false, `after "${lastCheck}": ${err.stack || err.message}`);
  } finally {
    if (agent) agent.kill('SIGKILL');
    relay.kill();
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
