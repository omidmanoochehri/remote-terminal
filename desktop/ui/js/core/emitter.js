/**
 * The smallest event bus the app needs: repositories publish, screens
 * subscribe, and a screen that is torn down unsubscribes. Nothing here is
 * clever — it exists so no screen reaches into another screen's state.
 */
export class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  /** Returns an unsubscribe function; keep it and call it when the view goes. */
  on(event, handler) {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy first: a handler may unsubscribe itself while we iterate.
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`listener for "${event}" failed`, err);
      }
    }
  }
}
