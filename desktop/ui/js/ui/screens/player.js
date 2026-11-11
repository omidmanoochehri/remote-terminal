/**
 * Plays a recording back in a read-only terminal: play/pause, speed, "skip
 * idle" (no pause longer than a second, on by default), a seek slider, and the
 * elapsed and total time. Seeking resets the emulator and replays every event
 * up to the new time, which is fast enough that it needs no keyframes.
 *
 * A port of `PlayerFragment.kt`.
 */

import { Screen } from './base.js';
import { el, svgIcon, header, headerAction, stateBlock } from '../dom.js';
import { S } from '../strings.js';
import { TerminalView } from '../../terminal/view.js';
import { TerminalEmulator } from '../../terminal/emulator.js';
import { themeById } from '../../terminal/theme.js';
import { FONT_SYSTEM } from '../../core/settings.js';
import {
  parseCast, parseSize, buildTimeline, eventsUpTo, timelineDuration, formatClock,
} from '../../core/asciicast.js';
import { exportRecording } from './recordings.js';

const SPEEDS = [0.5, 1, 2, 4];

export function playerScreen(app, { id }) {
  const entry = app.recordings.entry(id);
  const screen = new Screen(app, entry?.title || S.playerTitle);

  const canvas = el('canvas', { tabindex: '-1' });
  const frame = el('div.terminal-frame.player-frame', null, canvas);
  const playButton = el('button.icon-button', { title: S.playerPlay, onClick: () => toggle() }, svgIcon('play'));
  const slider = el('input.player-slider', { type: 'range', min: '0', max: '0', step: '0.01', value: '0', 'aria-label': S.playerTitle });
  const clock = el('span.player-clock', { text: '0:00 / 0:00' });
  const speedChips = el('div.chip-row.player-speeds');
  const skipBox = el('input', { type: 'checkbox', checked: true });
  const controls = el('div.player-controls', null,
    playButton,
    el('button.icon-button', { title: S.playerRestart, onClick: () => { seek(0); play(); } }, svgIcon('rotate_ccw')),
    slider,
    clock,
    speedChips,
    el('label.check-row.player-skip', null, skipBox, el('span', { text: S.playerSkipIdle })));
  const bodySlot = el('div.player-body', null, frame, controls);

  const root = el('div.screen.player-screen', null,
    header({
      title: entry?.title || S.playerTitle,
      subtitle: entry ? [entry.machine, new Date(entry.startedAt).toLocaleString()].filter(Boolean).join('  •  ') : '',
      onBack: () => app.back(),
      actions: [entry ? headerAction('download', S.recordingExport, () => exportRecording(app, entry)) : null],
    }),
    bodySlot);

  const view = new TerminalView(canvas);
  view.onInput = null;          // read-only: nothing typed here goes anywhere
  view.onGeometryChanged = null; // the recording decides the size, not the window
  screen.track(() => view.destroy());

  let cast = null;
  let timeline = [];
  let duration = 0;
  let position = 0;
  let next = 0;
  let playing = false;
  let speed = 1;
  let emulator = null;
  let frameId = 0;
  let lastTick = 0;

  function applyLook() {
    const s = app.settings;
    view.setFontSize(s.fontSize, false);
    view.setLineSpacing(s.lineSpacing);
    view.setFontFamily(s.terminalFontFamily === FONT_SYSTEM);
    const theme = themeById(s.terminalTheme);
    view.setTheme(theme);
    frame.style.background = theme.background;
  }

  function renderSpeeds() {
    speedChips.replaceChildren(...SPEEDS.map((v) => el('button.chip', {
      'aria-pressed': String(v === speed),
      title: S.playerSpeed,
      onClick: () => { speed = v; renderSpeeds(); },
    }, el('span', { text: `${v}×` }))));
  }

  function renderClock() {
    clock.textContent = `${formatClock(position)} / ${formatClock(duration)}`;
    if (document.activeElement !== slider) slider.value = String(position);
  }

  function renderPlayButton() {
    playButton.replaceChildren(svgIcon(playing ? 'square' : 'play'));
    playButton.title = playing ? S.playerPause : S.playerPlay;
  }

  function freshEmulator() {
    emulator = new TerminalEmulator(cast.header.width, cast.header.height, 10000);
    view.setEmulator(emulator);
  }

  /** Feed every event up to [position]. */
  function advance() {
    const upTo = eventsUpTo(timeline, position);
    let changed = false;
    for (; next < upTo; next++) {
      const e = timeline[next];
      if (e.type === 'o') { emulator.feed(e.data); changed = true; }
      else if (e.type === 'r') {
        const size = parseSize(e.data);
        if (size) { emulator.resize(size[0], size[1]); changed = true; }
      }
    }
    if (changed) view.notifyUpdated();
  }

  function seek(t) {
    const target = Math.max(0, Math.min(duration, t));
    if (target < position || !emulator) {
      freshEmulator();
      next = 0;
    }
    position = target;
    advance();
    renderClock();
  }

  function tick(now) {
    frameId = 0;
    if (!playing) return;
    const dt = Math.min(0.25, (now - lastTick) / 1000);
    lastTick = now;
    position = Math.min(duration, position + dt * speed);
    advance();
    renderClock();
    if (position >= duration) { pause(); return; }
    frameId = requestAnimationFrame(tick);
  }

  function play() {
    if (!cast) return;
    if (position >= duration) seek(0);
    playing = true;
    lastTick = performance.now();
    renderPlayButton();
    if (!frameId) frameId = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    renderPlayButton();
  }

  function toggle() { if (playing) pause(); else play(); }

  /** Rebuild the timeline (skip idle changed) keeping the same event on screen. */
  function rebuild() {
    timeline = buildTimeline(cast.events, { skipIdle: skipBox.checked });
    duration = timelineDuration(timeline);
    slider.max = String(duration);
    position = next > 0 ? timeline[next - 1].at : 0;
    renderClock();
  }

  slider.addEventListener('input', () => seek(Number(slider.value)));
  skipBox.addEventListener('change', () => { if (cast) rebuild(); });

  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
    if (e.key === ' ') { toggle(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowRight' && !e.ctrlKey) { seek(position + 5); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft' && !e.altKey && !e.ctrlKey) { seek(position - 5); e.preventDefault(); e.stopPropagation(); }
  };
  root.addEventListener('keydown', onKey, true);
  screen.track(() => root.removeEventListener('keydown', onKey, true));
  screen.track(() => pause());

  async function load() {
    if (!entry) { showError(S.valueUnknown); return; }
    try {
      cast = parseCast(await app.recordings.read(id));
    } catch (err) {
      showError(String(err?.message || err));
      return;
    }
    freshEmulator();
    rebuild();
    seek(0);
    play();
  }

  function showError(why) {
    bodySlot.replaceChildren(stateBlock({
      icon: 'alert', title: S.featureUnavailableTitle, body: S.playerLoadFailed(why), tone: 'error',
    }));
  }

  screen.listen(app.settings, 'changed', applyLook);
  applyLook();
  renderSpeeds();
  renderPlayButton();
  requestAnimationFrame(() => { view.recomputeGeometry(); view.focus(); });
  load();

  screen.root = root;
  return screen;
}
