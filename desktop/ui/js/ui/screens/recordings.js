/**
 * Settings → Recordings: the terminal sessions recorded on this device, with
 * play, export (.cast), rename and delete. A recording still in progress is
 * listed too, and cannot be played or deleted until it stops.
 *
 * A port of `RecordingsFragment.kt`.
 */

import { Screen } from './base.js';
import { el, clear, svgIcon, header, stateBlock, rowsCard, badge, headerAction } from '../dom.js';
import { S } from '../strings.js';
import { menu, confirmDialog, promptDialog, toast } from '../overlays.js';
import { bytes } from '../../core/format.js';
import { formatClock, castFileName } from '../../core/asciicast.js';
import { pickSavePath } from '../../core/platform.js';

export function recordingsScreen(app) {
  const screen = new Screen(app, S.recordings);
  const list = el('div');
  const root = el('div.screen', null,
    header({ title: S.recordings, subtitle: S.recordingsSubtitle, onBack: () => app.back() }),
    el('div.screen-body.wide', null, list));

  function render() {
    const rec = app.recordings;
    clear(list);
    if (rec.list.length === 0) {
      list.append(stateBlock({ icon: 'play', title: S.recordingsEmptyTitle, body: S.recordingsEmptyBody }));
      return;
    }
    list.append(rowsCard(rec.list.map((r) => {
      const live = rec.isActiveId(r.id);
      return el('div', { style: { display: 'flex', alignItems: 'center' } },
        el('button.row-item', {
          onClick: () => { if (!live) app.openPlayer(r.id); },
          title: live ? S.recordingInProgress : S.recordingPlay,
        },
        el('div.row-text', null,
          el('div.row-title', { text: r.title || S.terminal }),
          el('div.row-meta', {
            text: S.recordingMeta(r.machine, new Date(r.startedAt).toLocaleString(),
              live ? S.recordingInProgress : formatClock(r.duration || 0), bytes(r.size || 0)),
          })),
        live ? badge(S.recordBadge) : svgIcon('play')),
        el('div', { style: { paddingRight: '8px' } },
          headerAction('more', S.more, (e) => rowMenu(e.currentTarget, r, live))));
    })));
  }

  function rowMenu(anchor, r, live) {
    menu(anchor, [
      live ? null : { label: S.recordingPlay, icon: 'play', onClick: () => app.openPlayer(r.id) },
      { label: S.recordingExport, icon: 'download', onClick: () => exportRecording(app, r) },
      { label: S.recordingRename, icon: 'tag', onClick: () => rename(r) },
      live ? null : { divider: true },
      live ? null : { label: S.delete, icon: 'trash', danger: true, onClick: () => remove(r) },
    ]);
  }

  async function rename(r) {
    const title = await promptDialog({ title: S.recordingRename, label: S.fieldTerminalName, value: r.title });
    if (title) app.recordings.rename(r.id, title);
  }

  async function remove(r) {
    const ok = await confirmDialog({
      title: S.recordingDeleteTitle(r.title),
      body: S.recordingDeleteBody,
      confirmLabel: S.delete,
      danger: true,
    });
    if (ok) await app.recordings.remove(r.id);
  }

  screen.listen(app.recordings, 'changed', render);
  // Sizes of a recording in progress move while it records.
  screen.every(2000, () => { if (app.recordings.active.size > 0) render(); });
  render();

  screen.root = root;
  return screen;
}

/** Save a recording as a .cast file where the user chooses. */
export async function exportRecording(app, r) {
  try {
    const path = await pickSavePath(castFileName(r.title, r.startedAt), [{ name: 'asciicast', extensions: ['cast'] }]);
    if (!path) return;
    await app.recordings.exportTo(r.id, path);
    toast(S.recordingExported(path));
  } catch (err) {
    toast(String(err?.message || err), { error: true });
  }
}
