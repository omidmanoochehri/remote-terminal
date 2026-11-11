/**
 * The bridge to the Rust side. Everything the web view cannot do for itself —
 * the relay socket, the pairing calls, the credential store, the clipboard,
 * file dialogs, notifications, the app lock — goes through here, so the rest of
 * the app never touches `window.__TAURI__` directly.
 *
 * When the page is opened outside the shell (a plain browser, for poking at the
 * UI), every call fails loudly rather than silently pretending to work.
 */

const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;

export const inShell = !!tauri;

/**
 * Set in a terminal window by the Rust side before the page loads
 * (src/windows.rs): `{ kind, label, agentId, sessionId, onTop }`. Null in the
 * main window.
 */
export const terminalWindow = typeof window !== 'undefined' ? window.__RT_WINDOW__ ?? null : null;

/** This window's label: `main`, or the terminal window's own. */
export const windowLabel = terminalWindow?.label ?? 'main';

export function invoke(command, args) {
  if (!tauri) return Promise.reject(new Error(`Remote Terminal must run in its own window (${command} is unavailable).`));
  return tauri.core.invoke(command, args);
}

export function listen(event, handler) {
  if (!tauri) return Promise.resolve(() => {});
  return tauri.event.listen(event, handler);
}

/** Tell every window (this one included) about [event]. */
export function broadcastEvent(event, payload) {
  if (!tauri) return Promise.resolve();
  return tauri.event.emit(event, payload).catch(() => {});
}

/* ------------------------------- storage -------------------------------- */

export const store = {
  read: (name) => invoke('store_read', { name }),
  write: (name, contents) => invoke('store_write', { name, contents }),
  remove: (name) => invoke('store_delete', { name }),
  configDirectory: () => invoke('config_directory'),
};

export const credentialStore = {
  load: () => invoke('credentials_load'),
  save: (credentials) => invoke('credentials_save', { credentials }),
  clear: () => invoke('credentials_clear'),
};

/* -------------------------------- relay --------------------------------- */

export const socket = {
  connect: (url, token) => invoke('ws_connect', { url, token }),
  send: (id, text) => invoke('ws_send', { id, text }),
  close: (id, code, reason) => invoke('ws_close', { id, code, reason }),
};

export const relayHttp = {
  redeem: (relayUrl, code, deviceName, appVersion) =>
    invoke('pair_redeem', { relayUrl, code, deviceName, appVersion }),
  pairCode: (relayUrl, deviceToken) => invoke('pair_code', { relayUrl, deviceToken }),
};

/* ------------------------------- platform ------------------------------- */

export const system = {
  readFileForUpload: (path) => invoke('read_file_for_upload', { path }),
  clipboardRead: () => invoke('clipboard_read'),
  clipboardReadImage: () => invoke('clipboard_read_image'),
  clipboardWriteText: (text) => invoke('clipboard_write_text', { text }),
  setKeepAwake: (enabled) => invoke('set_keep_awake', { enabled }),
  setCloseToTray: (enabled) => invoke('set_close_to_tray', { enabled }),
  appLockAvailable: () => invoke('app_lock_available'),
  appLockPrompt: (message) => invoke('app_lock_prompt', { message }),
  /** Only http, https and ftp; the Rust side refuses anything else too. */
  openUrl: (url) => invoke('open_url', { url }),
};

/**
 * Local files for the file browser's transfers, one base64 slice at a time so
 * nothing large sits whole in the page.
 */
export const localFiles = {
  info: (path) => invoke('local_file_info', { path }),
  read: (path, offset, length) => invoke('local_file_read', { path, offset, length }),
  write: (path, offset, data) => invoke('local_file_write', { path, offset, data }),
  remove: (path) => invoke('local_file_remove', { path }),
};

/** Session recordings, one asciicast file each in the app's configuration directory. */
export const recordingFiles = {
  append: (id, text) => invoke('recording_append', { id, text }),
  read: (id) => invoke('recording_read', { id }),
  remove: (id) => invoke('recording_delete', { id }),
  exportTo: (id, path) => invoke('recording_export', { id, path }),
};

/** Send a Wake-on-LAN magic packet (built by core/wol.js) as a UDP broadcast. */
export function wakeOnLan(packet, broadcast, port) {
  return invoke('wake_on_lan', { packet: Array.from(packet), broadcast, port });
}

/** Native "open file" dialog; resolves to a path or null when cancelled. */
export async function pickFile() {
  if (!tauri?.dialog) throw new Error('No file picker is available.');
  const chosen = await tauri.dialog.open({ multiple: false, directory: false });
  if (chosen == null) return null;
  return Array.isArray(chosen) ? chosen[0] ?? null : chosen;
}

/** Native "open files" dialog; resolves to a list of paths (empty when cancelled). */
export async function pickFiles() {
  if (!tauri?.dialog) throw new Error('No file picker is available.');
  const chosen = await tauri.dialog.open({ multiple: true, directory: false });
  if (chosen == null) return [];
  return Array.isArray(chosen) ? chosen : [chosen];
}

/** Native "save as" dialog; resolves to a path or null when cancelled. */
export async function pickSavePath(defaultName, filters = null) {
  if (!tauri?.dialog) throw new Error('No file picker is available.');
  const options = { defaultPath: defaultName };
  if (filters) options.filters = filters;
  const chosen = await tauri.dialog.save(options);
  return chosen ?? null;
}

/**
 * Files dropped on the window: [handler] gets `{ type, paths }` where type is
 * 'enter', 'over', 'leave' or 'drop'. Resolves to an unlisten function.
 */
export async function onFileDrop(handler) {
  const offs = await Promise.all([
    listen('tauri://drag-enter', (e) => handler({ type: 'enter', paths: e.payload?.paths ?? [] })),
    listen('tauri://drag-over', () => handler({ type: 'over', paths: [] })),
    listen('tauri://drag-leave', () => handler({ type: 'leave', paths: [] })),
    listen('tauri://drag-drop', (e) => handler({ type: 'drop', paths: e.payload?.paths ?? [] })),
  ]);
  return () => { for (const off of offs) off(); };
}

/**
 * A desktop notification. Quiet by design, exactly as on the phone: raised only
 * while the window is not focused and only when the setting is on.
 */
export async function notify(title, body) {
  const api = tauri?.notification;
  if (!api) return;
  try {
    let granted = await api.isPermissionGranted();
    if (!granted) granted = (await api.requestPermission()) === 'granted';
    if (granted) await api.sendNotification({ title, body });
  } catch {
    // A refused or unavailable notification is not worth interrupting anyone over.
  }
}

/* -------------------------------- window -------------------------------- */

/** Terminals in windows of their own (src/windows.rs). */
export const terminalWindows = {
  /** Resolves to the new window's label. */
  open: (agentId, sessionId, title, onTop) => invoke('terminal_window_open', { agentId, sessionId, title, onTop }),
  /** A terminal window by label, or `main`. */
  focus: (label) => invoke('terminal_window_focus', { label }),
  close: (label) => invoke('terminal_window_close', { label }),
  /** Keep this window above the others. */
  setOnTop: (on) => invoke('window_set_on_top', { on }),
};

export function currentWindow() {
  return tauri?.window?.getCurrentWindow?.() ?? null;
}

export async function setWindowTitle(title) {
  try {
    await currentWindow()?.setTitle(title);
  } catch {
    // The title is decoration; never let it break a screen.
  }
}
