/**
 * Small presentation helpers shared by the screens — a port of `Format.kt`.
 * Presence is always carried in words as well as colour, so state never relies
 * on colour alone.
 */

import { S } from '../ui/strings.js';
import { ConnectionState } from './relay.js';
import { isWindows, isRunning } from '../protocol/messages.js';

export function relativeTime(at, now = Date.now()) {
  if (at == null || at <= 0) return S.machineNeverSeen;
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return S.timeJustNow;
  if (minutes < 60) return S.timeMinutes(minutes);
  if (minutes < 60 * 24) return S.timeHours(Math.floor(minutes / 60));
  return S.timeDays(Math.floor(minutes / (60 * 24)));
}

/** Presence for the compact places (home cards, terminal header). */
export function presence(agent, connection) {
  const connected = connection.name === ConnectionState.CONNECTED;
  if (!connected) return { label: connectionLabel(connection), tone: 'warn' };
  if (agent.online) return { label: S.machineOnline, tone: 'online' };
  if (agent.lastSeen == null || agent.lastSeen <= 0) return { label: S.machineNeverSeen, tone: 'offline' };
  return { label: S.machineLastSeen(relativeTime(agent.lastSeen)), tone: 'offline' };
}

/**
 * The longer presence line used on the machine cards: "Online · Last seen now"
 * / "Offline · 2h ago". Falls back to the relay state when this device is not
 * connected, because then nothing is known to be online.
 */
export function presenceDetail(agent, connection) {
  const connected = connection.name === ConnectionState.CONNECTED;
  if (!connected) return { label: connectionLabel(connection), tone: 'warn' };
  if (agent.online) return { label: S.presenceOnlineLastSeen, tone: 'online' };
  return { label: S.presenceOfflineSince(relativeTime(agent.lastSeen)), tone: 'offline' };
}

export function connectionLabel(state) {
  switch (state.name) {
    case ConnectionState.CONNECTED: return S.stateConnected;
    case ConnectionState.CONNECTING: return S.stateConnecting;
    case ConnectionState.RECONNECTING: {
      const secs = Math.max(0, Math.round(((state.nextAtMs ?? 0) - Date.now()) / 1000));
      return secs > 1 ? S.stateReconnectingIn(secs) : S.stateReconnecting;
    }
    case ConnectionState.DISCONNECTED: return S.stateDisconnected;
    case ConnectionState.UNPAIRED: return S.stateUnpaired;
    case ConnectionState.FAILED: return S.stateFailed(state.reason ?? '');
    default: return S.stateDisconnected;
  }
}

export function connectionTone(state) {
  switch (state.name) {
    case ConnectionState.CONNECTED: return 'online';
    case ConnectionState.FAILED: return 'error';
    case ConnectionState.UNPAIRED:
    case ConnectionState.DISCONNECTED: return 'offline';
    default: return 'warn';
  }
}

export function machineSubtitle(agent) {
  const parts = [];
  if (agent.hostname && agent.hostname !== agent.name) parts.push(agent.hostname);
  if (agent.os) parts.push(agent.os);
  else if (agent.platform) parts.push(agent.platform);
  return parts.join(' · ');
}

/** Hostname · OS · architecture, as the machine cards show it. */
export function machineSubtitleFull(agent) {
  const parts = [];
  if (agent.hostname) parts.push(agent.hostname);
  if (agent.os) parts.push(agent.os);
  else if (agent.platform) parts.push(agent.platform);
  if (agent.arch) parts.push(agent.arch);
  return parts.join(' · ');
}

/** "bash • detached • just now" under a terminal row. */
export function terminalMeta(session) {
  const state = !isRunning(session)
    ? S.sessionStateExited(session.exitCode ?? 0)
    : session.attached > 0
      ? S.sessionStateRunning
      : S.sessionStateDetached;
  const age = relativeTime(session.lastActiveAt > 0 ? session.lastActiveAt : session.createdAt);
  return [session.shell, state, age].filter(Boolean).join(' • ');
}

export function terminalTitle(session) {
  return session.title || session.shell || S.terminal;
}

/** Human byte size with one decimal above a gigabyte, as the metric tiles show it. */
export function bytes(value) {
  if (value == null || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = value;
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) { v /= 1024; unit++; }
  return unit >= 3 ? `${v.toFixed(1)} ${units[unit]}` : `${Math.round(v)} ${units[unit]}`;
}

export function percent(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * "12d 4h" / "4h 20m" / "13m" — the uptime tile and the terminal footer. A
 * session that started seconds ago reads "0m", not "unknown"; only a negative
 * value (no start time at all) is unknown.
 */
export function duration(seconds) {
  if (seconds == null || seconds < 0) return S.valueUnknown;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Relay host without the scheme, for the settings and details rows. */
export function relayHost(relayUrl) {
  if (!relayUrl) return '—';
  try {
    const parsed = new URL(String(relayUrl).replace(/^ws/, 'http'));
    if (!parsed.hostname) return relayUrl;
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return relayUrl;
  }
}

export function isSecureRelay(relayUrl) {
  return typeof relayUrl === 'string' && relayUrl.startsWith('wss://');
}

export function machineIcon(agent) {
  return isWindows(agent) ? 'monitor' : 'server';
}

export function formatCount(n) {
  return new Intl.NumberFormat().format(n);
}
