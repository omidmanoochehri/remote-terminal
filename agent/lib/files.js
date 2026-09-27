'use strict';

/*
 * The machine's files, for the app's file browser (`fs.*` agent requests).
 *
 * Everything happens under one root directory: the home of whoever the
 * terminals belong to, unless `filesRoot` says otherwise. That matters most on
 * Windows, where the agent is LocalSystem under the service and could read
 * anything; the browser must not hand a phone more of the machine than a
 * terminal already does. So every path is resolved with realpath — symlinks
 * and junctions included — and refused unless it lands inside the root. A new
 * name (mkdir, upload, rename target) is checked through its parent, and must
 * be a plain name, never a path.
 *
 * The service is stateless apart from uploads in flight: a download is a
 * series of `fs.read` calls at increasing offsets, an upload a series of
 * `fs.write` calls appending to a hidden `.rtpart` file that is renamed into
 * place by the last one — so a partial upload never looks like a finished file.
 */

const fs = require('fs');
const path = require('path');

/** Largest slice one `fs.read` returns: 192 KiB raw, 256 KiB of base64. */
const MAX_READ = 192 * 1024;
const MAX_ENTRIES = 2000;
const PART_SUFFIX = '.rtpart';

class FileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fsError(err, what) {
  switch (err && err.code) {
    case 'ENOENT': case 'ENOTDIR': return new FileError('not_found', `${what}: no such file or directory`);
    case 'EACCES': case 'EPERM': return new FileError('forbidden', `${what}: permission denied`);
    case 'EEXIST': return new FileError('exists', `${what}: already exists`);
    case 'ENOTEMPTY': return new FileError('not_empty', `${what}: directory is not empty`);
    case 'EISDIR': return new FileError('bad_request', `${what}: is a directory`);
    case 'EBUSY': return new FileError('busy', `${what}: in use`);
    default: return new FileError('io_error', `${what}: ${err && err.message ? err.message : 'failed'}`);
  }
}

/** A name for something new in a directory: no separators, not . or .., no control characters. */
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !/[\/\\\x00-\x1F]/.test(name) && name !== '.' && name !== '..';
}

class FileService {
  /**
   * @param {{root: () => Promise<string>|string, maxWriteBytes?: number, platform?: string, fsImpl?: object}} opts
   *   `root` is asked on every request: under the Windows service the person
   *   signed in can change while the agent runs.
   */
  constructor({ root, maxWriteBytes = 512 * 1024 * 1024, platform = process.platform, fsImpl = fs.promises }) {
    this.rootFn = typeof root === 'function' ? root : () => root;
    this.maxWriteBytes = maxWriteBytes;
    this.platform = platform;
    this.fs = fsImpl;
    this.path = platform === 'win32' ? path.win32 : path.posix;
  }

  async root() {
    const raw = await this.rootFn();
    if (!raw) throw new FileError('unavailable', 'no file root: nobody is signed in to this machine');
    try { return await this.fs.realpath(raw); } catch (err) { throw fsError(err, raw); }
  }

  /** Is `p` the root or below it? Windows paths compare case-insensitively. */
  inside(root, p) {
    const norm = (s) => (this.platform === 'win32' ? s.toLowerCase() : s);
    const rel = this.path.relative(norm(root), norm(p));
    return rel === '' || (!rel.startsWith('..') && !this.path.isAbsolute(rel));
  }

  /** An absolute, normalised path; relative paths are taken from the root. */
  absolute(root, p) {
    if (p === undefined || p === null || p === '') return root;
    if (typeof p !== 'string' || p.length > 4096 || /\x00/.test(p)) throw new FileError('bad_request', 'invalid path');
    return this.path.resolve(root, p);
  }

  /** An existing path, symlinks resolved, that must be inside the root. */
  async existing(p) {
    const root = await this.root();
    const abs = this.absolute(root, p);
    let real;
    try { real = await this.fs.realpath(abs); } catch (err) { throw fsError(err, abs); }
    if (!this.inside(root, real)) throw new FileError('forbidden', 'outside the browsable folder');
    return { root, abs, real };
  }

  /** A path that may not exist yet: its parent must, inside the root, and its name must be plain. */
  async fresh(p) {
    const root = await this.root();
    const abs = this.absolute(root, p);
    const name = this.path.basename(abs);
    if (!validName(name)) throw new FileError('bad_request', 'invalid name');
    const parent = await this.existing(this.path.dirname(abs));
    return { root, real: this.path.join(parent.real, name), name };
  }

  /* --------------------------------- reads -------------------------------- */

  async list({ path: p } = {}) {
    const { root, real } = await this.existing(p);
    let st;
    try { st = await this.fs.stat(real); } catch (err) { throw fsError(err, real); }
    if (!st.isDirectory()) throw new FileError('bad_request', 'not a directory');
    let dirents;
    try { dirents = await this.fs.readdir(real, { withFileTypes: true }); } catch (err) { throw fsError(err, real); }
    const truncated = dirents.length > MAX_ENTRIES;
    const entries = [];
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      if (d.name.endsWith(PART_SUFFIX)) continue; // uploads in flight
      const full = this.path.join(real, d.name);
      const e = { name: d.name, type: 'other', size: 0, mtime: 0 };
      if (d.name.startsWith('.')) e.hidden = true;
      try {
        let s;
        if (d.isSymbolicLink()) {
          e.link = true;
          try { s = await this.fs.stat(full); } catch (_) { s = await this.fs.lstat(full); e.broken = true; }
        } else {
          s = await this.fs.stat(full);
        }
        e.type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'other';
        e.size = s.isFile() ? s.size : 0;
        e.mtime = Math.round(s.mtimeMs);
      } catch (_) {
        // Unreadable (a locked system file, a vanished entry): keep the name, drop the facts.
        e.type = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other';
      }
      entries.push(e);
    }
    const parentReal = this.path.dirname(real);
    return {
      path: real,
      root,
      parent: real !== root && this.inside(root, parentReal) ? parentReal : null,
      sep: this.path.sep,
      entries,
      truncated,
    };
  }

  async read({ path: p, offset = 0, length = MAX_READ } = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new FileError('bad_request', 'invalid offset');
    if (!Number.isInteger(length) || length < 1) throw new FileError('bad_request', 'invalid length');
    const { real } = await this.existing(p);
    let fh;
    try {
      fh = await this.fs.open(real, 'r');
      const st = await fh.stat();
      if (st.isDirectory()) throw new FileError('bad_request', 'is a directory');
      const want = Math.max(0, Math.min(length, MAX_READ, st.size - offset));
      const buf = Buffer.alloc(want);
      const { bytesRead } = want ? await fh.read(buf, 0, want, offset) : { bytesRead: 0 };
      return {
        path: real,
        offset,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
        data: buf.subarray(0, bytesRead).toString('base64'),
        eof: offset + bytesRead >= st.size,
      };
    } catch (err) {
      throw err instanceof FileError ? err : fsError(err, real);
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /* -------------------------------- writes -------------------------------- */

  /**
   * One slice of an upload. offset 0 starts it (and refuses to clobber an
   * existing file unless `overwrite`); every later slice must start exactly
   * where the part file ends; `final` renames the part file into place.
   */
  async write({ path: p, offset, data, final = false, overwrite = false } = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new FileError('bad_request', 'invalid offset');
    if (typeof data !== 'string') throw new FileError('bad_request', 'data must be base64');
    const bytes = Buffer.from(data, 'base64');
    if (offset + bytes.length > this.maxWriteBytes) {
      throw new FileError('limit_reached', `file too large (limit ${this.maxWriteBytes} bytes)`);
    }
    const { real } = await this.fresh(p);
    const part = real + PART_SUFFIX;
    try {
      if (offset === 0) {
        if (!overwrite && await this.exists(real)) throw new FileError('exists', 'a file with that name already exists');
        await this.fs.writeFile(part, bytes, { mode: 0o600 });
      } else {
        let have;
        try { have = (await this.fs.stat(part)).size; } catch (_) { throw new FileError('bad_request', 'no upload in progress for that file'); }
        if (have !== offset) throw new FileError('bad_request', `offset ${offset} does not continue the upload (have ${have})`);
        await this.fs.appendFile(part, bytes);
      }
      const size = offset + bytes.length;
      if (!final) return { path: real, size, done: false };
      if (!overwrite && await this.exists(real)) throw new FileError('exists', 'a file with that name already exists');
      await this.fs.rename(part, real);
      return { path: real, size, done: true };
    } catch (err) {
      if (!(err instanceof FileError) || final) await this.fs.unlink(part).catch(() => {});
      throw err instanceof FileError ? err : fsError(err, real);
    }
  }

  async mkdir({ path: p } = {}) {
    const { real } = await this.fresh(p);
    try { await this.fs.mkdir(real); } catch (err) { throw fsError(err, real); }
    return { path: real };
  }

  /** Rename within a directory or move elsewhere under the root. */
  async rename({ from, to } = {}) {
    const src = await this.existing(from);
    if (src.real === src.root) throw new FileError('forbidden', 'cannot rename the browsable folder itself');
    const dst = await this.fresh(to);
    if (await this.exists(dst.real)) throw new FileError('exists', 'a file with that name already exists');
    try { await this.fs.rename(src.real, dst.real); } catch (err) { throw fsError(err, src.real); }
    return { path: dst.real };
  }

  /** Delete a file or a directory; a directory with contents needs `recursive`. */
  async remove({ path: p, recursive = false } = {}) {
    const root = await this.root();
    const abs = this.absolute(root, p);
    // The link itself, not what it points at: deleting a symlink must never
    // reach through it. Its parent still has to be inside the root.
    const parent = await this.existing(this.path.dirname(abs));
    const target = this.path.join(parent.real, this.path.basename(abs));
    if (!this.inside(root, target) || target === root) throw new FileError('forbidden', 'cannot delete the browsable folder itself');
    let st;
    try { st = await this.fs.lstat(target); } catch (err) { throw fsError(err, target); }
    try {
      if (st.isDirectory()) {
        if (recursive) await this.fs.rm(target, { recursive: true, force: false });
        else await this.fs.rmdir(target);
      } else {
        await this.fs.unlink(target);
      }
    } catch (err) { throw fsError(err, target); }
    return { path: target };
  }

  async exists(p) {
    try { await this.fs.lstat(p); return true; } catch (_) { return false; }
  }

  /** Dispatch an `fs.*` request. */
  async handle(method, params) {
    switch (method) {
      case 'fs.list': return this.list(params);
      case 'fs.read': return this.read(params);
      case 'fs.write': return this.write(params);
      case 'fs.mkdir': return this.mkdir(params);
      case 'fs.rename': return this.rename(params);
      case 'fs.delete': return this.remove(params);
      default: throw new FileError('bad_request', `unknown method "${method}"`);
    }
  }
}

module.exports = { FileService, FileError, validName, MAX_READ, MAX_ENTRIES, PART_SUFFIX };
