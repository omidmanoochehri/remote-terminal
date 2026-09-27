/**
 * The file browser's model: ordering and filtering a folder listing, the path
 * arithmetic for a machine whose separator is not ours, and the two transfer
 * loops. The transfers take their I/O as functions, so the tests run them
 * against fakes and the screen hands them the relay and the Rust side.
 */

export const SORT_NAME = 'name';
export const SORT_SIZE = 'size';
export const SORT_MODIFIED = 'modified';

/** 192 KiB raw per slice, as the agent reads and writes them. */
export const SLICE_BYTES = 192 * 1024;
/** How much a viewer loads before saying the file is too large to view. */
export const VIEW_MAX_BYTES = 1024 * 1024;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Folders first, then files; within each, by the chosen key (name breaks
 * ties). Hidden entries only when asked; [filter] matches names, any case.
 */
export function arrangeEntries(entries, { sort = SORT_NAME, showHidden = false, filter = '' } = {}) {
  const q = String(filter || '').trim().toLowerCase();
  const kept = entries.filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
  const rank = (e) => (e.type === 'dir' ? 0 : 1);
  return kept.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (sort === SORT_SIZE && a.size !== b.size) return b.size - a.size;
    if (sort === SORT_MODIFIED && a.mtime !== b.mtime) return b.mtime - a.mtime;
    return collator.compare(a.name, b.name);
  });
}

/** [dir] + [name] with the machine's separator, never doubling it. */
export function joinPath(dir, name, sep = '/') {
  if (!dir) return name;
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function baseName(path, sep = '/') {
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf(sep);
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/**
 * The breadcrumb trail from the root down to [path]: `[{ label, path }]`. The
 * first crumb is the root itself, labelled with its own name; nothing above
 * the root is offered, because nothing above it can be opened.
 */
export function breadcrumbs(path, root, sep = '/') {
  const norm = (p) => (sep === '\\' ? p.toLowerCase() : p);
  const crumbs = [{ label: baseName(root, sep) || root, path: root }];
  if (!path || norm(path) === norm(root) || !norm(path).startsWith(norm(root))) return crumbs;
  const rest = path.slice(root.length).split(sep).filter(Boolean);
  let at = root;
  for (const part of rest) {
    at = joinPath(at, part, sep);
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

const TEXT_EXT = new Set([
  'txt', 'log', 'md', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'csv', 'tsv',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'bat', 'cmd',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'gradle', 'properties',
  'service', 'lock', 'gitignore', 'dockerfile', 'makefile',
]);
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

function extension(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot <= 0 ? lower : lower.slice(dot + 1);
}

/** How the viewer would show [name]: 'image', 'text', or null for "download it instead". */
export function viewKind(name) {
  const ext = extension(name);
  if (IMAGE_MIME[ext]) return 'image';
  if (TEXT_EXT.has(ext) || !name.includes('.')) return 'text';
  return null;
}

export function imageMime(name) {
  return IMAGE_MIME[extension(name)] ?? 'application/octet-stream';
}

/** The icon a row shows. */
export function entryIcon(entry) {
  if (entry.type === 'dir') return 'folder';
  if (viewKind(entry.name) === 'image') return 'image';
  if (viewKind(entry.name) === 'text') return 'file_text';
  return 'file';
}

/* ------------------------------- transfers ------------------------------ */

export class Cancelled extends Error {
  constructor() { super('Cancelled'); this.code = 'cancelled'; }
}

/**
 * Pull a remote file slice by slice. [read] is `(offset) → {data, size, eof}`,
 * [write] is `(offset, base64) → void`. Up to [parallel] reads are in flight,
 * but slices are written strictly in order. [onProgress] gets (done, total).
 */
export async function downloadSlices({ read, write, onProgress = () => {}, isCancelled = () => false, parallel = 3 }) {
  const first = await read(0);
  if (isCancelled()) throw new Cancelled();
  const size = first.size;
  let written = 0;
  await write(0, first.data);
  written += byteLength(first.data);
  onProgress(written, size);
  if (first.eof || written >= size) return { size: written };

  let nextOffset = written;
  const inFlight = [];
  const launch = () => {
    while (inFlight.length < parallel && nextOffset < size) {
      const offset = nextOffset;
      inFlight.push({ offset, promise: read(offset) });
      nextOffset += SLICE_BYTES;
    }
  };
  launch();
  while (inFlight.length > 0) {
    const { offset, promise } = inFlight.shift();
    const slice = await promise;
    if (isCancelled()) throw new Cancelled();
    if (offset !== written) throw new Error('slices arrived out of order');
    const n = byteLength(slice.data);
    await write(offset, slice.data);
    written += n;
    onProgress(written, size);
    if (slice.eof || n === 0) break;
    launch();
  }
  return { size: written };
}

/**
 * Push a local file slice by slice. [read] is `(offset) → {data, size, eof}`
 * from the local file, [write] is `(offset, base64, final) → result`.
 */
export async function uploadSlices({ read, write, onProgress = () => {}, isCancelled = () => false }) {
  let offset = 0;
  for (;;) {
    if (isCancelled()) throw new Cancelled();
    const slice = await read(offset);
    const n = byteLength(slice.data);
    const final = slice.eof || offset + n >= slice.size;
    const result = await write(offset, slice.data, final);
    offset += n;
    onProgress(offset, slice.size);
    if (final) return result;
    if (n === 0) throw new Error('the file stopped growing before its end');
  }
}

/** Bytes a base64 string decodes to, without decoding it. */
export function byteLength(b64) {
  if (!b64) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Decode base64 to bytes (the viewer's small files only). */
export function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** UTF-8 text as base64, in pieces so a long transcript does not overflow the call stack. */
export function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
