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

export function invoke(command, args) {
  if (!tauri) return Promise.reject(new Error(`Remote Terminal must run in its own window (${command} is unavailable).`));
  return tauri.core.invoke(command, args);
}

export function listen(event, handler) {
  if (!tauri) return Promise.resolve(() => {});
  return tauri.event.listen(event, handler);
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
  appLockAvailable: () => invoke('app_lock_available'),
  appLockPrompt: (message) => invoke('app_lock_prompt', { message }),
};

/** Native "open file" dialog; resolves to a path or null when cancelled. */
export async function pickFile() {
  if (!tauri?.dialog) throw new Error('No file picker is available.');
  const chosen = await tauri.dialog.open({ multiple: false, directory: false });
  if (chosen == null) return null;
  return Array.isArray(chosen) ? chosen[0] ?? null : chosen;
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
