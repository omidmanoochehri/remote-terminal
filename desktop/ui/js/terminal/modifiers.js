/**
 * Sticky modifier keys for the on-screen key bar, shared by the terminal view
 * and the extra-keys bar so both agree on what the next key means.
 *
 *   click      OFF → ONESHOT (applies to the next key, then releases)
 *   click ×2   ONESHOT → LOCKED (stays on until clicked again)
 *   click      LOCKED → OFF
 *
 * A port of `ModifierState.kt`; the caller passes timestamps so it is testable.
 */

export const Which = Object.freeze({ CTRL: 0, ALT: 1, SHIFT: 2 });
export const Mode = Object.freeze({ OFF: 'OFF', ONESHOT: 'ONESHOT', LOCKED: 'LOCKED' });

export class ModifierState {
  constructor() {
    this.doubleTapMs = 450;
    this.onChanged = null;
    this.modes = [Mode.OFF, Mode.OFF, Mode.OFF];
    this.lastTap = [0, 0, 0];
  }

  mode(which) { return this.modes[which]; }
  isActive(which) { return this.modes[which] !== Mode.OFF; }
  get anyActive() { return this.modes.some((m) => m !== Mode.OFF); }

  /** A click on a modifier button; returns the new mode. */
  tap(which, now) {
    const i = which;
    let next;
    switch (this.modes[i]) {
      case Mode.OFF: next = Mode.ONESHOT; break;
      case Mode.ONESHOT: next = now - this.lastTap[i] <= this.doubleTapMs ? Mode.LOCKED : Mode.OFF; break;
      default: next = Mode.OFF; break;
    }
    this.lastTap[i] = now;
    this.setAt(i, next);
    return next;
  }

  set(which, mode) { this.setAt(which, mode); }

  setAt(i, mode) {
    if (this.modes[i] === mode) return;
    this.modes[i] = mode;
    if (this.onChanged) this.onChanged();
  }

  /** The modifiers to apply to the next key. */
  mods() {
    return {
      ctrl: this.modes[Which.CTRL] !== Mode.OFF,
      alt: this.modes[Which.ALT] !== Mode.OFF,
      shift: this.modes[Which.SHIFT] !== Mode.OFF,
    };
  }

  /** A key was sent: release one-shot modifiers, keep locked ones. */
  consume() {
    let changed = false;
    for (let i = 0; i < this.modes.length; i++) {
      if (this.modes[i] === Mode.ONESHOT) { this.modes[i] = Mode.OFF; changed = true; }
    }
    if (changed && this.onChanged) this.onChanged();
  }

  clear() {
    let changed = false;
    for (let i = 0; i < this.modes.length; i++) {
      if (this.modes[i] !== Mode.OFF) { this.modes[i] = Mode.OFF; changed = true; }
    }
    if (changed && this.onChanged) this.onChanged();
  }
}
