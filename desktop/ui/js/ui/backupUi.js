/**
 * Settings → Backup & restore. Export writes one JSON file through the save
 * dialog; import reads one (or pasted text), shows what it holds, and asks
 * whether to merge it into this device's lists or replace them.
 */

import { S } from './strings.js';
import { actionsDialog, promptDialog, toast } from './overlays.js';
import { pickFile, pickSavePath, localFiles } from '../core/platform.js';
import { encodeUtf8Base64, decodeBase64, SLICE_BYTES } from '../core/remoteFiles.js';
import {
  buildBackup, parseBackup, backupSummary, applyBackup, backupFileName,
} from '../core/backup.js';
import { relativeTime } from '../core/format.js';
import { APP_VERSION } from '../version.js';

/** Files larger than this are not backups. */
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export async function backupMenu(app) {
  const choice = await actionsDialog({
    title: S.backup,
    items: [
      { label: S.backupExport, description: S.backupExportDesc },
      { label: S.backupImportFile, description: S.backupNeverIncluded },
      { label: S.backupImportPaste },
    ],
  });
  if (choice === 0) await exportBackup(app);
  else if (choice === 1) await importFromFile(app);
  else if (choice === 2) await importFromPaste(app);
}

export async function exportBackup(app) {
  const s = app.settings;
  const backup = buildBackup(s.values, {
    presets: s.terminalPresets,
    snippets: s.snippets,
    customSchemes: s.customSchemes,
    commandShortcuts: s.commandShortcuts,
    app: 'desktop',
    appVersion: APP_VERSION,
  });
  try {
    const path = await pickSavePath(backupFileName(), [{ name: 'JSON', extensions: ['json'] }]);
    if (!path) return;
    await localFiles.write(path, 0, encodeUtf8Base64(JSON.stringify(backup, null, 2)));
    toast(S.backupSaved(path));
  } catch (err) {
    toast(S.backupFailed(String(err?.message || err)), { error: true });
  }
}

async function readLocalText(path) {
  const info = await localFiles.info(path);
  if (info.size > MAX_BACKUP_BYTES) throw new Error('This file is too large to be a backup.');
  const parts = [];
  let offset = 0;
  for (;;) {
    const slice = await localFiles.read(path, offset, SLICE_BYTES);
    const bytes = decodeBase64(slice.data);
    parts.push(bytes);
    offset += bytes.length;
    if (slice.eof || bytes.length === 0) break;
  }
  const all = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new TextDecoder().decode(all);
}

async function importFromFile(app) {
  try {
    const path = await pickFile();
    if (!path) return;
    await importText(app, await readLocalText(path));
  } catch (err) {
    toast(S.backupFailed(String(err?.message || err)), { error: true });
  }
}

async function importFromPaste(app) {
  const text = await promptDialog({ title: S.backupPasteTitle, multiline: true, confirmLabel: S.ok });
  if (text) await importText(app, text);
}

export async function importText(app, text) {
  const parsed = parseBackup(text);
  if (!parsed.ok) { toast(S.backupFailed(parsed.error), { error: true, ms: 6000 }); return; }
  const b = parsed.backup;
  const from = S.backupFrom(b.app || '?', b.appVersion, b.exportedAt ? relativeTime(b.exportedAt) : '');
  const choice = await actionsDialog({
    title: S.backupImportTitle,
    items: [
      { label: S.backupMerge, description: `${S.backupSummary(backupSummary(b))}. ${from} ${S.backupMergeDesc}` },
      { label: S.backupReplace, description: S.backupReplaceDesc },
    ],
  });
  if (choice == null) return;
  const s = app.settings;
  const next = applyBackup({
    presets: s.terminalPresets,
    snippets: s.snippets,
    customSchemes: s.customSchemes,
    commandShortcuts: s.commandShortcuts,
  }, b, choice === 1 ? 'replace' : 'merge');
  s.restore(next);
  toast(S.backupRestored);
}
