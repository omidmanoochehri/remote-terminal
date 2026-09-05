/**
 * Quoting for the lines the app types into a shell it did not choose.
 *
 * The relay only takes a shell, a size and a title, so a working directory
 * arrives as a `cd` typed into the new shell — which means the path has to be
 * quoted the way *that* shell expects.
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
