/**
 * Quoting for the lines the app types into a shell it did not choose.
 *
 * The relay only takes a shell, a size and a title, so a working directory
 * arrives as a `cd` typed into the new shell — which means the path has to be
 * quoted, and reached, the way *that* shell expects.
 */

/**
 * Quote a path for a shell only when it needs it. Windows paths take double
 * quotes, which both PowerShell and Command Prompt understand; the POSIX single
 * quotes below would be taken literally by Command Prompt.
 */
export function shellQuote(path) {
  if (/^[A-Za-z0-9._/~@:+-]+$/.test(path)) return path;
  if (path.includes('\\') || /^[A-Za-z]:/.test(path)) return `"${path.replace(/"/g, '')}"`;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * The input that takes a new shell to [path], ending in a newline.
 *
 * On Windows a bare `cd E:\work` from the C: drive is not the no-op it looks
 * like and not a move either: it sets E:'s current directory and leaves you on
 * C:. The drive letter on its own is what actually switches, so a path on
 * another drive needs both, in that order. `cd /d` would do it in one line but
 * only in Command Prompt — PowerShell takes the two-line form, and so does
 * every other Windows shell.
 *
 * @param {string} path
 * @param {{platform?:string, shellId?:string}} where  the agent this is typed at
 */
export function changeDirectoryInput(path, { platform = '', shellId = '' } = {}) {
  const quoted = shellQuote(path);
  // A WSL shell on a Windows machine is a POSIX shell with POSIX paths.
  if (platform !== 'win32' || /^wsl-/.test(String(shellId))) return `cd ${quoted}\r`;

  // A UNC path has no drive to switch to, and Command Prompt's `cd` refuses
  // one outright. `pushd` maps a drive for it, and PowerShell accepts it too.
  if (/^\\\\/.test(path)) return `pushd ${quoted}\r`;

  const drive = /^([A-Za-z]):/.exec(path);
  if (drive) return `${drive[1]}:\rcd ${quoted}\r`;
  return `cd ${quoted}\r`;
}
