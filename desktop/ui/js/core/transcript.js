/**
 * A terminal's transcript: its scrollback and screen as plain text, the way
 * someone would paste it into a ticket. Soft-wrapped rows are joined back into
 * the line the program printed, trailing spaces go, and so do the blank rows
 * under the prompt. The same rules as the Android app's `Transcript.kt`.
 */

/** Plain text of [emulator]'s whole buffer. */
export function transcriptText(emulator) {
  return cleanTranscript(emulator.renderText());
}

/** The clean-up on its own, for text already taken from the buffer. */
export function cleanTranscript(text) {
  const lines = String(text).split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

const pad = (n) => String(n).padStart(2, '0');

/** `{title}-{yyyyMMdd-HHmmss}.txt`, with anything a file name cannot hold replaced. */
export function transcriptFileName(title, date = new Date()) {
  const safe = String(title || 'terminal').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').replace(/^[-\s]+|[-\s]+$/g, '') || 'terminal';
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${safe}-${stamp}.txt`;
}
