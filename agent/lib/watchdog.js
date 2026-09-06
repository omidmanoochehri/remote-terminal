'use strict';

/*
 * Liveness for a long-running unattended agent.
 *
 * systemd's WatchdogSec and a Windows service supervisor both want the same
 * thing: a process that dies loudly when it has stopped doing its job, so the
 * supervisor can restart it. sd_notify itself is out of reach (Node has no
 * unix *datagram* socket and the agent takes no dependencies), so the check
 * lives here instead and the process exits on failure — which is exactly the
 * signal Restart=always and the Windows supervisor act on.
 *
 * Two things are watched:
 *
 *   event loop  a timer scheduled every `intervalMs` that keeps arriving very
 *               late means the loop is wedged (a runaway PTY read, a sync
 *               call that never returns). Transient lag is normal, so it must
 *               stay bad for `failures` consecutive checks.
 *   heartbeat   one INFO line per period with the facts an operator wants
 *               from a month-old log: connected or not, sessions, memory.
 */

const HEARTBEAT_EVERY = 6; // heartbeat once per 6 checks (5 min at the 50s default)

function createWatchdog({ log, intervalMs = 50000, lagFactor = 4, failures = 3, snapshot = () => ({}), onStall, now = Date.now } = {}) {
  let timer = null;
  let last = now();
  let bad = 0;
  let ticks = 0;
  let stalled = false;
  const maxLagMs = Math.max(5000, Math.round(intervalMs * (lagFactor - 1)));

  const tick = () => {
    const t = now();
    const lag = t - last - intervalMs;
    last = t;

    if (lag > maxLagMs) {
      bad += 1;
      log.warn('event loop stalled', { lagMs: lag, strike: bad, of: failures });
      if (bad >= failures && !stalled) {
        stalled = true;
        log.error('event loop wedged; exiting so the supervisor restarts the agent', { lagMs: lag, checks: failures });
        if (onStall) onStall(lag);
      }
      return;
    }
    bad = 0;

    if (++ticks % HEARTBEAT_EVERY === 0) {
      const mem = process.memoryUsage();
      log.info('heartbeat', Object.assign({
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
      }, snapshot()));
    }
  };

  return {
    intervalMs,
    start() {
      if (timer) return;
      last = now();
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick, // exposed for tests
  };
}

/** Started by systemd? Then journald already has stdout and owns restarts. */
function underSystemd(env = process.env) {
  return process.platform === 'linux' && (!!env.INVOCATION_ID || !!env.JOURNAL_STREAM);
}

/** Started by the Windows service supervisor? It sets this for its child. */
function underWindowsService(env = process.env) {
  return process.platform === 'win32' && env.RT_SUPERVISED === '1';
}

/** True when some supervisor will restart us, so exiting on a fatal fault is safe. */
function supervised(env = process.env) {
  return underSystemd(env) || underWindowsService(env);
}

module.exports = { createWatchdog, underSystemd, underWindowsService, supervised };
