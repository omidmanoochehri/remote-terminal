/**
 * Protocol v3 descriptive objects and message builders (PROTOCOL.md).
 * A port of `Messages.kt`.
 */

export const PROTOCOL_VERSION = 3;

const str = (o, key, fallback = '') =>
  o && o[key] != null && typeof o[key] !== 'object' ? String(o[key]) : fallback;
const num = (o, key, fallback = 0) => {
  const v = o ? o[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const optNum = (o, key) => {
  const v = o ? o[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const bool = (o, key, fallback = false) => (o && typeof o[key] === 'boolean' ? o[key] : fallback);

export function shellFromJson(o) {
  return {
    id: str(o, 'id'),
    label: str(o, 'label') || str(o, 'id'),
    isDefault: bool(o, 'default'),
  };
}

export function sessionFromJson(o) {
  return {
    sessionId: str(o, 'sessionId'),
    title: str(o, 'title'),
    shell: str(o, 'shell'),
    state: str(o, 'state', 'running'), // "running" | "exited"
    createdAt: num(o, 'createdAt'),
    lastActiveAt: num(o, 'lastActiveAt'),
    cols: num(o, 'cols'),
    rows: num(o, 'rows'),
    seq: num(o, 'seq'),
    attached: num(o, 'attached'),
    exitCode: optNum(o, 'exitCode'),
    /** Where the shell is now, when the agent can resolve it; "" otherwise. */
    cwd: str(o, 'cwd'),
  };
}

export const isRunning = (session) => session.state === 'running';

/**
 * System metrics an agent may publish alongside its identity. Protocol v3 does
 * not require them, so every field is optional and the Machine details screen
 * renders "not reported" rather than inventing numbers.
 */
export const EMPTY_METRICS = Object.freeze({
  cpuLoad: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  storageUsedBytes: null,
  storageTotalBytes: null,
  uptimeSec: null,
});

export function metricsFromJson(o) {
  if (!o) return EMPTY_METRICS;
  const clamp01 = (v) => (v == null ? null : Math.min(1, Math.max(0, v)));
  return {
    cpuLoad: clamp01(optNum(o, 'cpuLoad')),
    memoryUsedBytes: optNum(o, 'memoryUsed'),
    memoryTotalBytes: optNum(o, 'memoryTotal'),
    storageUsedBytes: optNum(o, 'storageUsed'),
    storageTotalBytes: optNum(o, 'storageTotal'),
    uptimeSec: optNum(o, 'uptimeSec'),
  };
}

export function metricsHaveAny(m) {
  return m.cpuLoad != null || m.memoryTotalBytes != null || m.storageTotalBytes != null || m.uptimeSec != null;
}

export function memoryFraction(m) {
  if (m.memoryUsedBytes == null || !m.memoryTotalBytes) return null;
  return Math.min(1, Math.max(0, m.memoryUsedBytes / m.memoryTotalBytes));
}

export function storageFraction(m) {
  if (m.storageUsedBytes == null || !m.storageTotalBytes) return null;
  return Math.min(1, Math.max(0, m.storageUsedBytes / m.storageTotalBytes));
}

export function agentFromJson(o) {
  return {
    agentId: str(o, 'agentId'),
    name: str(o, 'name'),
    hostname: str(o, 'hostname'),
    platform: str(o, 'platform'), // "win32" | "linux" | "darwin"
    os: str(o, 'os'),
    arch: str(o, 'arch'),
    agentVersion: str(o, 'agentVersion'),
    shells: Array.isArray(o?.shells) ? o.shells.map(shellFromJson) : [],
    caps: Array.isArray(o?.caps) ? o.caps.map(String) : [],
    online: bool(o, 'online'),
    lastSeen: optNum(o, 'lastSeen'),
    instanceId: o?.instanceId == null ? null : String(o.instanceId),
    sessions: Array.isArray(o?.sessions) ? o.sessions.map(sessionFromJson) : [],
    metrics: metricsFromJson(o?.metrics),
  };
}

export const isWindows = (agent) => agent.platform === 'win32';

/** Terminals still running on the machine (exited ones stay listed but do not count). */
export const runningSessions = (agent) => agent.sessions.filter(isRunning).length;

export function deviceFromJson(o) {
  return {
    deviceId: str(o, 'deviceId'),
    name: str(o, 'name'),
    platform: str(o, 'platform'),
    createdAt: num(o, 'createdAt'),
    lastSeen: optNum(o, 'lastSeen'),
    online: bool(o, 'online'),
    isSelf: bool(o, 'isSelf'),
  };
}

export const DEFAULT_LIMITS = Object.freeze({
  maxSessionsPerAgent: 16,
  maxSessionsPerAccount: 64,
  maxInputBytes: 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
});

export function limitsFromJson(o) {
  if (!o) return DEFAULT_LIMITS;
  return {
    maxSessionsPerAgent: num(o, 'maxSessionsPerAgent', DEFAULT_LIMITS.maxSessionsPerAgent),
    maxSessionsPerAccount: num(o, 'maxSessionsPerAccount', DEFAULT_LIMITS.maxSessionsPerAccount),
    maxInputBytes: num(o, 'maxInputBytes', DEFAULT_LIMITS.maxInputBytes),
    maxFrameBytes: num(o, 'maxFrameBytes', DEFAULT_LIMITS.maxFrameBytes),
  };
}

/* --------------------------- outgoing messages -------------------------- */

/** Builders for client → relay messages. Each returns the JSON text to send. */
export const Outgoing = {
  ping: () => JSON.stringify({ type: 'ping' }),
  agentList: () => JSON.stringify({ type: 'agent.list' }),
  deviceList: () => JSON.stringify({ type: 'device.list' }),
  agentRename: (agent, name) => JSON.stringify({ type: 'agent.rename', agent, name }),
  agentRemove: (agent) => JSON.stringify({ type: 'agent.remove', agent }),
  deviceRename: (name) => JSON.stringify({ type: 'device.rename', name }),
  deviceRevoke: (device) => JSON.stringify({ type: 'device.revoke', device }),

  sessionCreate(reqId, agent, shell, cols, rows, title) {
    const msg = { type: 'session.create', reqId, agent, cols, rows };
    if (shell != null) msg.shell = shell;
    if (title != null) msg.title = title;
    return JSON.stringify(msg);
  },
  sessionAttach(reqId, agent, session, since, cols, rows) {
    const msg = { type: 'session.attach', reqId, agent, session, cols, rows };
    if (since != null) msg.since = since;
    return JSON.stringify(msg);
  },
  sessionDetach: (agent, session) => JSON.stringify({ type: 'session.detach', agent, session }),
  sessionClose: (agent, session) => JSON.stringify({ type: 'session.close', agent, session }),
  sessionRename: (agent, session, title) => JSON.stringify({ type: 'session.rename', agent, session, title }),
  input: (agent, session, data) => JSON.stringify({ type: 'input', agent, session, data }),
  resize: (agent, session, cols, rows) => JSON.stringify({ type: 'resize', agent, session, cols, rows }),

  // File transfer into a session (a pasted image, mostly): begin → chunks → end.
  fileBegin: (reqId, agent, session, name, mime, size) =>
    JSON.stringify({ type: 'file.begin', reqId, agent, session, name, mime, size }),
  fileChunk: (reqId, agent, session, seq, dataBase64) =>
    JSON.stringify({ type: 'file.chunk', reqId, agent, session, seq, data: dataBase64 }),
  fileEnd: (reqId, agent, session) => JSON.stringify({ type: 'file.end', reqId, agent, session }),
  fileAbort: (reqId, agent, session) => JSON.stringify({ type: 'file.abort', reqId, agent, session }),
};
