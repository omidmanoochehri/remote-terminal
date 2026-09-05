/**
 * End-to-end validation of the desktop client: a real relay, a real agent
 * hosting a real PTY, and the app's own frontend modules driving them.
 *
 *   node desktop/tools/e2e-desktop.mjs
 *
 * The screens are the only thing this cannot exercise — everything under them
 * is the shipping code: `RelayClient`, `AgentRepository`, `SessionRepository`,
 * `SessionStream` and `TerminalEmulator`, unmodified. Only `platform.js` is
 * replaced (by `platform-node.mjs`), because in the app that module is the
 * bridge to Rust and here it has to be a bridge to Node.
 *
 * Exercises: pairing over HTTPS, the welcome/agent list, creating a terminal,
 * typing into it and reading the emulator's screen, resize, a disconnect with
 * re-attach at `since` (no duplicated output), and closing the terminal.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const PORT = Number(process.env.E2E_PORT || 18460);
const ENROLL = 'desktop-e2e-token';
const RELAY_URL = `ws://127.0.0.1:${PORT}`;

const results = [];
let failed = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until [test] returns truthy, or give up. Returns whether it did. */
async function waitFor(test, timeoutMs = 10_000, step = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/* ------------------------------ processes -------------------------------- */

const children = [];

function spawnNode(script, env, tag) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.dirname(script),
  });
  children.push(child);
  const show = (prefix) => (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      if (process.env.E2E_VERBOSE || /"level":"(warn|error)"/.test(line)) console.log(`[${tag}${prefix}] ${line}`);
    }
  };
  child.stdout.on('data', show(''));
  child.stderr.on('data', show(':err'));
  return child;
}

function stopAll() {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

async function httpJson(method, urlPath, body, bearer) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

/* --------------------------------- main ---------------------------------- */

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-desktop-e2e-'));
  const stateFile = path.join(work, 'agent-state.json');
  const relayState = path.join(work, 'relay-state.json');

  console.log(`Remote Terminal — desktop end-to-end (${work})\n`);

  // 1. The relay.
  spawnNode(path.join(ROOT, 'server', 'index.js'), {
    PORT: String(PORT), ENROLL_TOKEN: ENROLL, STATE_FILE: relayState, LOG_LEVEL: 'warn',
  }, 'relay');
  const healthy = await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  });
  check('relay starts', !!healthy);
  if (!healthy) return;

  // 2. The agent, enrolling itself against that relay.
  spawnNode(path.join(ROOT, 'agent', 'index.js'), {
    SERVER: RELAY_URL, ENROLL_TOKEN: ENROLL, AGENT_NAME: 'E2E Machine',
    AGENT_STATE: stateFile, LOG_LEVEL: 'warn', METRICS_INTERVAL_MS: '2000',
  }, 'agent');
  const online = await waitFor(async () => {
    const stats = await httpJson('GET', '/stats');
    return stats.body.agentsOnline === 1;
  }, 20_000);
  check('agent enrols and connects', !!online);
  if (!online) return;

  // 3. Pair this "device" the way the desktop's pairing screen does.
  const agentToken = JSON.parse(fs.readFileSync(stateFile, 'utf8')).agentToken;
  const code = await httpJson('POST', '/v3/pair/code', {}, agentToken);
  check('a pairing code is issued', code.status === 201 && /^\d{6}$/.test(code.body.code));

  const redeemed = await httpJson('POST', '/v3/pair/redeem', {
    code: code.body.code, deviceName: 'E2E Desktop', platform: 'windows', appVersion: '0.8.0',
  });
  check('the code redeems for a device token', redeemed.status === 201 && !!redeemed.body.deviceToken);
  if (redeemed.status !== 201) return;

  // 4. The app's own stack, over a Node-backed platform bridge.
  // The relay client listens for the browser's online/offline events; Node has
  // no window, so give it the smallest one that satisfies those listeners.
  globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {} };
  const { installTestPlatform } = await import('./platform-node.mjs');
  installTestPlatform({
    relayUrl: RELAY_URL,
    deviceId: redeemed.body.deviceId,
    deviceToken: redeemed.body.deviceToken,
    accountId: redeemed.body.accountId,
  });

  const { Settings } = await import('../ui/js/core/settings.js');
  const { Credentials } = await import('../ui/js/core/credentials.js');
  const { RelayClient, ConnectionState } = await import('../ui/js/core/relay.js');
  const { AgentRepository } = await import('../ui/js/core/agents.js');
  const { SessionRepository } = await import('../ui/js/core/sessions.js');
  const { State: StreamState } = await import('../ui/js/protocol/stream.js');

  const settings = await Settings.load();
  const credentials = await Credentials.load();
  check('credentials load as paired', credentials.isPaired);

  const client = new RelayClient(credentials, '0.8.0');
  const agents = await AgentRepository.load(client);
  const sessions = new SessionRepository(client, agents, settings);
  client.start();

  const connected = await waitFor(() => client.state.name === ConnectionState.CONNECTED, 15_000);
  check('the relay client connects and gets welcome', !!connected, client.state.name);
  if (!connected) return;

  const listed = await waitFor(() => agents.agents.find((a) => a.online));
  check('the machine appears online with its shells', !!listed && listed.shells.length > 0,
    listed ? `${listed.name}: ${listed.shells.map((s) => s.id).join(', ')}` : 'none');
  if (!listed) return;

  check('the agent advertises the capabilities the app uses',
    listed.caps.includes('sessions') && listed.caps.includes('replay'),
    listed.caps.join(','));

  // 5. A terminal, and something to run in it.
  const isWindows = process.platform === 'win32';
  const shell = listed.shells.find((s) => s.isDefault) ?? listed.shells[0];
  const created = await sessions.create(listed.agentId, shell.id, 100, 30, 'E2E Terminal');
  check('a terminal is created', created.ok, created.ok ? created.session.sessionId : created.error);
  if (!created.ok) return;

  const session = created.session;
  const attached = await waitFor(() => session.stream.state === StreamState.ATTACHED, 15_000);
  check('the terminal attaches', !!attached, session.stream.state);
  if (!attached) return;

  const marker = 'RT_DESKTOP_E2E_OK';
  const command = isWindows ? `echo ${marker}\r` : `echo ${marker}\r`;
  sessions.input(session, command);

  const echoed = await waitFor(() => {
    const text = session.emulator.renderText();
    // The command line itself echoes too, so look for the answer on its own line.
    return text.split('\n').some((line) => line.trim() === marker) ? text : null;
  }, 20_000);
  check('the shell runs a command and the emulator renders its output', !!echoed,
    echoed ? `${session.emulator.totalRows()} rows` : session.emulator.renderText().slice(-160));

  check('the stream position advanced', session.stream.lastSeq > 0, `seq=${session.stream.lastSeq}`);

  // 6. Resize: the agent should acknowledge the new geometry.
  sessions.resize(session, 120, 40);
  const resized = await waitFor(() => {
    const info = agents.session(listed.agentId, session.sessionId);
    return info && info.cols === 120 && info.rows === 40;
  }, 10_000);
  check('a resize reaches the PTY', !!resized);

  // 7. A dropped connection is resumed at `since` with no duplicated output.
  const seqBefore = session.stream.lastSeq;
  const textBefore = session.emulator.renderText();
  client.stop();
  await waitFor(() => session.stream.state === StreamState.DETACHED, 5000);
  check('a dropped socket detaches the tab', session.stream.state === StreamState.DETACHED);

  client.start();
  const reconnected = await waitFor(() => client.state.name === ConnectionState.CONNECTED, 15_000);
  check('the client reconnects', !!reconnected);
  const reattached = await waitFor(() => session.stream.state === StreamState.ATTACHED, 15_000);
  check('the tab re-attaches by itself', !!reattached);

  const textAfter = session.emulator.renderText();
  check('re-attaching did not duplicate the scrollback',
    countOccurrences(textAfter, marker) === countOccurrences(textBefore, marker),
    `${countOccurrences(textBefore, marker)} → ${countOccurrences(textAfter, marker)}`);
  check('the stream resumed where it left off', session.stream.lastSeq >= seqBefore,
    `${seqBefore} → ${session.stream.lastSeq}`);

  // 8. Metrics, if the agent publishes them.
  const withMetrics = await waitFor(() => {
    const a = agents.agent(listed.agentId);
    return a && a.metrics && (a.metrics.memoryTotalBytes != null || a.metrics.uptimeSec != null) ? a : null;
  }, 12_000);
  check('system metrics arrive for the machine details screen', !!withMetrics,
    withMetrics ? `mem=${withMetrics.metrics.memoryTotalBytes} uptime=${withMetrics.metrics.uptimeSec}` : 'none');

  // 9. Closing the terminal ends it on the machine.
  sessions.closeTab(session, true);
  const gone = await waitFor(() => agents.session(listed.agentId, session.sessionId) == null, 10_000);
  check('terminating the terminal removes it from the machine', !!gone);

  client.stop();
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

main()
  .catch((err) => {
    console.error('\nharness failed:', err);
    failed++;
  })
  .finally(async () => {
    stopAll();
    await sleep(300);
    const passed = results.length - failed;
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed}/${results.length} checks`);
    process.exit(failed === 0 ? 0 : 1);
  });

// Node keeps the process alive on a stray handle otherwise.
process.on('SIGINT', () => { stopAll(); process.exit(130); });
createRequire(import.meta.url); // keeps bundlers honest about this being a Node script
