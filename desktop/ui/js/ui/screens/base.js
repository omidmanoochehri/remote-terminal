/**
 * The shape every screen returns, and the bookkeeping they all share:
 * subscriptions that must be dropped when the screen goes, and a render that
 * can be called again cheaply whenever the model moves.
 */

export class Screen {
  constructor(app, title = '') {
    this.app = app;
    this.title = title;
    this.disposers = [];
  }

  /** Keep an unsubscribe function; every one is called on destroy. */
  track(dispose) {
    if (typeof dispose === 'function') this.disposers.push(dispose);
    return dispose;
  }

  /** Subscribe to an emitter for as long as the screen is on screen. */
  listen(emitter, event, handler) {
    this.track(emitter.on(event, handler));
  }

  /** A timer that stops with the screen (the footer clock, the reconnect count-down). */
  every(ms, fn) {
    const id = setInterval(fn, ms);
    this.track(() => clearInterval(id));
    return id;
  }

  destroy() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        console.error('screen cleanup failed', err);
      }
    }
  }
}
