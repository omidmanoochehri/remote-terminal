/**
 * Optional, quiet notifications — a port of `Notifier.kt`: a machine you are
 * using went offline, a terminal's process exited, a terminal rang the bell.
 * Raised only while the window is not in front and only when the corresponding
 * setting is on; never for ordinary output.
 */

import { notify } from './platform.js';
import { S } from '../ui/strings.js';

export class Notifier {
  constructor(settings, client, agents, sessions) {
    this.settings = settings;
    this.client = client;
    this.agents = agents;
    this.sessions = sessions;
    this.foreground = true;
    this.usedAgents = new Set();
    this.lastBell = 0;

    client.on('event', (event) => this.onEvent(event));

    sessions.onSessionExited = (s) => {
      if (!this.foreground && settings.notifyOnFinish(s.key)) this.notifyExit(s);
    };
    sessions.onBell = (s) => {
      if (this.foreground && settings.bell === 'sound') this.beep();
      if (!this.foreground && settings.notifyBell) this.notifyBell(s);
    };
  }

  /** Remember machines the user actively opened, so offline alerts are only for those. */
  noteAgentUsed(agentId) { this.usedAgents.add(agentId); }

  onEvent(event) {
    if (event.kind !== 'agentOffline') return;
    // Two ways to opt in: the global "machine goes offline" setting for
    // machines you have opened, or per-machine connection alerts.
    const perMachine = this.settings.connectionAlerts(event.agentId);
    const global = this.settings.notifyAgentOffline && this.usedAgents.has(event.agentId);
    if (!perMachine && !(global && !this.foreground)) return;
    if (this.foreground && !perMachine) return;
    const name = this.agents.agent(event.agentId)?.name || 'A machine';
    notify(S.notifOfflineTitle(name), S.notifOfflineText);
  }

  notifyExit(s) {
    const machine = this.agents.agent(s.agentId)?.name ?? '';
    notify(S.notifExitTitle(s.displayTitle), S.notifExitText(machine, s.exitCode ?? 0));
  }

  notifyBell(s) {
    const machine = this.agents.agent(s.agentId)?.name ?? '';
    notify(S.notifBellTitle(s.displayTitle), machine);
  }

  /**
   * The desktop's answer to the phone's vibrate: a short tone through the Web
   * Audio API, so no sound file has to ship. A flood of bells should not become
   * a flood of beeps.
   */
  beep() {
    const now = Date.now();
    if (now - this.lastBell < 300) return;
    this.lastBell = now;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.audio = this.audio || new Ctx();
      const ctx = this.audio;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.13);
    } catch {
      // No audio device, or the context is blocked: a silent bell is fine.
    }
  }
}
