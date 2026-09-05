/**
 * Open terminal tabs and the attach/replay/live-output protocol that drives
 * them (PROTOCOL.md §6) — a port of `SessionRepository.kt`.
 *
 * Tabs survive disconnects: on every reconnect (or when a machine comes back)
 * they are re-attached with `since`, so the shell process and its scrollback
 * continue where they left off.
 */

import { Emitter } from './emitter.js';
import { TerminalEmulator } from '../terminal/emulator.js';
import { SessionStream, State, Verdict } from '../protocol/stream.js';
import { Outgoing, isRunning } from '../protocol/messages.js';
import { errorDisplay } from '../protocol/incoming.js';
import { ConnectionState } from './relay.js';

/** 192 KiB raw → 256 KiB base64, comfortably inside the relay's 1 MiB frame limit. */
const CHUNK_BYTES = 192 * 1024;

/**
 * One open terminal tab: the emulator holding its screen, the stream state that
 * keeps replay and live output consistent, and the last known metadata.
 */
export class TerminalSession extends Emitter {
  constructor(agentId, sessionId, scrollback) {
    super();
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.emulator = new TerminalEmulator(80, 24, scrollback);
    this.stream = new SessionStream();

    this.title = '';
    this.shell = '';
    /**
     * Where the shell is, as far as this device can tell: the agent reports it
     * when the platform can resolve it, a shell that sends OSC 7 keeps it live,
     * and starting a terminal in a directory seeds it. Empty means unknown, and
     * everything that uses it treats that as "do not assume".
     */
    this.cwd = '';
    this.state = 'running'; // "running" | "exited" | "closed"
    this.exitCode = null;
    this.closedReason = null;
    this.attachError = null;

    /** Rows of output that arrived while this tab was not the visible one. */
    this.unreadRows = 0;

    /**
     * Input queued before the shell was attached (the working directory and the
     * optional start-up command chosen on the New terminal screen). Sent once,
     * on the first successful attach.
     */
    this.startupInput = null;

    /** When this tab was opened here; used until the relay reports createdAt. */
    this.openedAt = Date.now();

    this.version = 0;
  }

  get key() { return `${this.agentId}|${this.sessionId}`; }
  get isRunning() { return this.state === 'running'; }
  get displayTitle() { return this.title || this.shell || 'Terminal'; }

  /** Bumped on every metadata/stream change so views can re-render cheaply. */
  bump() {
    this.version++;
    this.emit('changed', this.version);
  }

  /** The emulator content changed (the view redraws on the next frame). */
  notifyOutput() { this.emit('output'); }

  applyInfo(info) {
    this.title = info.title;
    this.shell = info.shell;
    this.state = info.state;
    this.exitCode = info.exitCode;
    if (info.cwd) this.cwd = info.cwd;
    this.bump();
  }

  /** A new working directory from the shell itself or from the agent. */
  noteDirectory(dir) {
    if (!dir || dir === this.cwd) return;
    this.cwd = dir;
    this.bump();
  }
}

export class SessionRepository extends Emitter {
  constructor(client, agents, settings) {
    super();
    this.client = client;
    this.agents = agents;
    this.settings = settings;

    /** key → TerminalSession, in the order tabs were opened. */
    this.sessions = new Map();
    this.instanceIds = new Map();

    /** Hooks the notifier fills in. */
    this.onSessionExited = null;
    this.onBell = null;
    /** A program set the clipboard via OSC 52 (the host decides whether to honour it). */
    this.onClipboard = null;

    client.on('event', (event) => this.onEvent(event));
    client.on('state', (state) => this.onConnectionState(state));

    // Restore open tabs from the last run for every cached machine.
    for (const agent of agents.agents) {
      for (const sessionId of settings.openTabs(agent.agentId)) this.get(agent.agentId, sessionId);
    }
  }

  tabs(agentId) {
    return [...this.sessions.values()].filter((s) => s.agentId === agentId);
  }

  find(agentId, sessionId) { return this.sessions.get(`${agentId}|${sessionId}`) || null; }

  /** The tab for a session, creating (and opening) it if needed. */
  get(agentId, sessionId) {
    const existing = this.sessions.get(`${agentId}|${sessionId}`);
    if (existing) return existing;
    const s = new TerminalSession(agentId, sessionId, this.settings.scrollbackLines);
    const info = this.agents.session(agentId, sessionId);
    if (info) s.applyInfo(info);
    s.emulator.onBell = () => this.onBell?.(s);
    s.emulator.onClipboard = (text) => this.onClipboard?.(s, text);
    // Wired on the session, not the view, so a tab learns where its shell went
    // even while another tab is the visible one.
    s.emulator.onWorkingDirectory = (dir) => s.noteDirectory(dir);
    s.emulator.onResponse = (data) => this.input(s, data);
    this.sessions.set(s.key, s);
    this.publish(agentId);
    return s;
  }

  publish(agentId) {
    const list = this.tabs(agentId);
    this.settings.setOpenTabs(agentId, list.map((s) => s.sessionId));
    this.emit('tabs', agentId, list);
  }

  /* ------------------------------- commands ----------------------------- */

  /** Create a new terminal on a machine and open it as a tab. */
  async create(agentId, shell, cols, rows, title) {
    const reply = await this.client.request((reqId) =>
      Outgoing.sessionCreate(reqId, agentId, shell ?? null, cols, rows, title ?? null));
    if (reply.kind === 'sessionCreated') {
      const s = this.get(agentId, reply.session.sessionId);
      s.applyInfo(reply.session);
      if (shell != null) this.settings.setLastShell(agentId, shell);
      this.attach(s, cols, rows);
      return { ok: true, session: s };
    }
    if (reply.kind === 'error') return { ok: false, error: errorDisplay(reply) };
    return { ok: false, error: 'Unexpected reply' };
  }

  /** Attach (or re-attach) a tab at the given geometry; safe to call repeatedly. */
  attach(s, cols, rows) {
    if (!this.client.isConnected) return;
    if (s.state === 'closed') return;
    if (s.stream.state === State.ATTACHING) return;
    const { reqId, since } = s.stream.beginAttach(cols, rows);
    s.attachError = null;
    this.client.send(Outgoing.sessionAttach(reqId, s.agentId, s.sessionId, since, cols, rows));
    s.bump();
  }

  /** Keep the tab but stop receiving its output (the shell keeps running). */
  detach(s) {
    if (s.stream.state !== State.DETACHED) this.client.send(Outgoing.sessionDetach(s.agentId, s.sessionId));
    s.stream.onDisconnected();
    s.bump();
  }

  /** Close the tab; with [terminate] the shell process is killed too. */
  closeTab(s, terminate) {
    if (terminate) this.client.send(Outgoing.sessionClose(s.agentId, s.sessionId));
    else this.detach(s);
    this.sessions.delete(s.key);
    this.publish(s.agentId);
  }

  rename(s, title) {
    this.client.send(Outgoing.sessionRename(s.agentId, s.sessionId, title));
    s.title = title;
    s.bump();
  }

  /**
   * Hold [data] until the freshly created session is attached, then send it as
   * ordinary input so the user sees it echoed in the scrollback.
   */
  queueStartupInput(s, data) {
    if (!data) return;
    if (s.stream.state === State.ATTACHED) this.input(s, data);
    else s.startupInput = data;
  }

  input(s, data) {
    if (s.stream.state !== State.ATTACHED) return false;
    return this.client.send(Outgoing.input(s.agentId, s.sessionId, data));
  }

  /** The view's grid changed size: resize the emulator and tell the agent. */
  resize(s, cols, rows) {
    if (s.emulator.cols === cols && s.emulator.rows === rows) return;
    s.emulator.resize(cols, rows);
    s.stream.noteGeometry(cols, rows);
    if (s.stream.state === State.ATTACHED) this.client.send(Outgoing.resize(s.agentId, s.sessionId, cols, rows));
    s.notifyOutput();
  }

  /**
   * Send a file into a session (a pasted image, mostly). Chunks stay well under
   * the relay's frame limit; the agent answers with the path it stored.
   *
   * [base64] is the whole file already encoded by the Rust side, so nothing
   * large has to cross the bridge twice.
   */
  async sendFile(s, name, mime, base64, size) {
    if (s.stream.state !== State.ATTACHED) return { ok: false, error: 'Terminal is not attached' };
    if (!base64) return { ok: false, error: 'Empty file' };
    // base64 grows 4 bytes for every 3, so chunk on a 4-character boundary to
    // keep every chunk independently decodable.
    const chunkChars = Math.floor((CHUNK_BYTES * 4) / 3 / 4) * 4;
    const reply = await this.client.requestMulti((reqId) => {
      if (!this.client.send(Outgoing.fileBegin(reqId, s.agentId, s.sessionId, name, mime, size))) return false;
      let seq = 0;
      for (let offset = 0; offset < base64.length; offset += chunkChars) {
        const piece = base64.slice(offset, offset + chunkChars);
        if (!this.client.send(Outgoing.fileChunk(reqId, s.agentId, s.sessionId, seq++, piece))) {
          this.client.send(Outgoing.fileAbort(reqId, s.agentId, s.sessionId));
          return false;
        }
      }
      return this.client.send(Outgoing.fileEnd(reqId, s.agentId, s.sessionId));
    });
    if (reply.kind === 'fileStored') return { ok: true, path: reply.path };
    if (reply.kind === 'error') return { ok: false, error: errorDisplay(reply) };
    return { ok: false, error: 'Unexpected reply' };
  }

  /** Re-attach every open tab of [agentId] (or all agents) — after connect / agent online. */
  reattachAll(agentId = null) {
    for (const s of this.sessions.values()) {
      if (agentId != null && s.agentId !== agentId) continue;
      if (s.state !== 'running') continue;
      if (this.agents.agent(s.agentId)?.online !== true) continue;
      // Machine settings can opt a machine out of automatic re-attachment, and
      // a single terminal can opt out of being restored.
      if (!this.settings.autoReconnect(s.agentId)) continue;
      if (!this.settings.restoreOnReconnect(s.key)) continue;
      this.attach(s, s.emulator.cols, s.emulator.rows);
    }
  }

  /**
   * True when at least one machine with open terminals asked to be kept alive
   * in the background; the relay client uses this to decide whether to hold the
   * socket while the window is hidden.
   */
  wantsBackgroundKeepAlive() {
    for (const s of this.sessions.values()) {
      if (s.state === 'running' && this.settings.keepAlive(s.agentId)) return true;
    }
    return false;
  }

  /* -------------------------------- events ------------------------------ */

  onConnectionState(state) {
    if (state.name === ConnectionState.CONNECTED) return; // the welcome event re-attaches
    for (const s of this.sessions.values()) { s.stream.onDisconnected(); s.bump(); }
  }

  onEvent(event) {
    switch (event.kind) {
      case 'welcome':
        for (const a of event.agents) this.noteInstance(a.agentId, a.instanceId);
        this.refreshMetadata();
        this.pruneClosed(new Map(event.agents.map((a) => [a.agentId, new Set(a.sessions.map((s) => s.sessionId))])));
        this.reattachAll();
        break;
      // Tabs restored from the last run have no title until the relay describes
      // their sessions; take it as soon as a list arrives.
      case 'agentList':
        this.refreshMetadata();
        break;
      case 'agentOnline':
        this.noteInstance(event.agent.agentId, event.agent.instanceId);
        this.refreshMetadata(event.agent.agentId);
        this.pruneClosed(new Map([[event.agent.agentId, new Set(event.agent.sessions.map((s) => s.sessionId))]]));
        this.reattachAll(event.agent.agentId);
        break;
      case 'agentOffline':
        for (const s of this.sessions.values()) {
          if (s.agentId === event.agentId) { s.stream.onDisconnected(); s.bump(); }
        }
        break;
      case 'agentRemoved': {
        for (const s of [...this.sessions.values()]) {
          if (s.agentId !== event.agentId) continue;
          s.state = 'closed';
          s.closedReason = 'removed';
          this.sessions.delete(s.key);
        }
        this.publish(event.agentId);
        break;
      }
      case 'sessionAttached': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        const r = s.stream.onAttached(event.reqId, event.from, event.seq, event.cols, event.rows);
        if (!r.accepted) break;
        // Terminal query replies must be muted while applying replayed output;
        // they would otherwise inject stale answers into the shell.
        s.emulator.muteResponses = true;
        if (r.resetScreen) s.emulator.clearScreen();
        if (r.outputLost) s.emulator.feed('\r\n\x1b[2m[… earlier output not available …]\x1b[0m\r\n');
        if (event.cols > 0 && event.rows > 0 && (event.cols !== s.emulator.cols || event.rows !== s.emulator.rows)) {
          // The agent's PTY is a different size (another client set it); follow
          // it until our own resize lands.
          s.emulator.resize(event.cols, event.rows);
        }
        s.emulator.muteResponses = false;
        s.bump();
        s.notifyOutput();
        if (s.startupInput) { const queued = s.startupInput; s.startupInput = null; this.input(s, queued); }
        break;
      }
      case 'output': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        const verdict = s.stream.onOutput(event.seq, event.data.length);
        if (verdict === Verdict.APPLY) {
          s.emulator.feed(event.data);
          s.notifyOutput();
        } else if (verdict === Verdict.GAP) {
          console.warn(`gap in ${s.sessionId}; re-attaching`);
          this.attach(s, s.emulator.cols, s.emulator.rows);
        }
        break;
      }
      case 'sessionLag': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        s.stream.onLag();
        this.attach(s, s.emulator.cols, s.emulator.rows);
        break;
      }
      case 'sessionUpdated': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        if (event.title != null) s.title = event.title;
        if (event.state != null) s.state = event.state;
        if (event.exitCode != null) s.exitCode = event.exitCode;
        if (event.cwd != null) s.noteDirectory(event.cwd);
        if (event.cols != null && event.rows != null && event.cols > 0 && event.rows > 0 &&
          s.stream.state === State.ATTACHED &&
          (event.cols !== s.emulator.cols || event.rows !== s.emulator.rows)) {
          s.emulator.resize(event.cols, event.rows);
          s.notifyOutput();
        }
        s.bump();
        break;
      }
      case 'exit': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        s.state = 'exited';
        s.exitCode = event.code;
        s.emulator.feed(`\r\n\x1b[2m[process exited with code ${event.code ?? '?'}]\x1b[0m\r\n`);
        s.notifyOutput();
        s.bump();
        this.onSessionExited?.(s);
        break;
      }
      case 'sessionClosed': {
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        s.state = 'closed';
        s.closedReason = event.reason;
        s.stream.onDisconnected();
        if (event.reason !== 'closed' && event.reason !== 'exited') {
          s.emulator.feed(`\r\n\x1b[2m[terminal closed: ${event.reason}]\x1b[0m\r\n`);
        }
        s.notifyOutput();
        s.bump();
        break;
      }
      case 'error': {
        if (!event.sessionId || !event.agentId) break;
        const s = this.find(event.agentId, event.sessionId);
        if (!s) break;
        if (event.code === 'unknown_session') {
          s.state = 'closed';
          s.closedReason = 'gone';
          s.stream.reset();
        }
        s.attachError = errorDisplay(event);
        s.bump();
        break;
      }
      default:
        break;
    }
  }

  /** Copy the relay's view of each open tab onto it (title, shell, state). */
  refreshMetadata(agentId = null) {
    for (const s of this.sessions.values()) {
      if (agentId != null && s.agentId !== agentId) continue;
      const info = this.agents.session(s.agentId, s.sessionId);
      if (info) s.applyInfo(info);
    }
  }

  /** A restarted agent has none of its old sessions; forget what we knew about them. */
  noteInstance(agentId, instanceId) {
    const prev = this.instanceIds.get(agentId);
    this.instanceIds.set(agentId, instanceId);
    if (prev != null && instanceId != null && prev !== instanceId) {
      for (const s of this.sessions.values()) if (s.agentId === agentId) s.stream.reset();
    }
  }

  /** Tabs whose sessions no longer exist on the agent are marked closed. */
  pruneClosed(known) {
    for (const s of this.sessions.values()) {
      const ids = known.get(s.agentId);
      if (!ids) continue;
      if (!ids.has(s.sessionId) && s.state !== 'closed') {
        s.state = 'closed';
        s.closedReason = 'gone';
        s.stream.reset();
        s.emulator.feed('\r\n\x1b[2m[this terminal no longer exists on the machine]\x1b[0m\r\n');
        s.notifyOutput();
        s.bump();
      }
    }
  }
}

export { isRunning };
