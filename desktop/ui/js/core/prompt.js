/**
 * The prompt composer's text — a port of `Prompt.kt`.
 *
 * A prompt is written in a proper text box rather than at the cursor, with
 * files beside it; when it is sent the files are uploaded to the machine first
 * and their paths go in after the text, the way a program such as a coding
 * assistant expects to be told about a file. Nothing here touches the screen.
 */

import { shellQuote } from './shell.js';

/**
 * A prompt being written for one terminal. `files` are what is attached:
 * `{ name, path }` for a local file, `{ name, file }` for something already
 * read (a pasted image); `remotePath` is filled in once one is uploaded, so a
 * retry after a failed upload does not send it twice.
 */
export function newPromptDraft(enter = true) {
  return { text: '', files: [], enter };
}

/**
 * What is typed into the terminal: the text without trailing blank space, then
 * each uploaded path, quoted where it needs it, after a space.
 */
export function promptText(text, paths = []) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const list = paths.filter(Boolean).map(shellQuote).join(' ');
  if (!list) return body;
  return body ? `${body} ${list}` : list;
}

/** The last part of a local path, for a file's chip. */
export function fileName(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? String(path ?? '');
}
