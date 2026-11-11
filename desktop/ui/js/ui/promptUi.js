/**
 * The prompt composer: a text box for a prompt, with files attached beside it
 * by pasting, dropping or picking them. A port of the phone's prompt dialog.
 *
 * The dialog only gathers; the terminal screen uploads and types on Send, so
 * the upload shows in the terminal's own banner and a failure brings the
 * dialog back with everything still in it.
 */

import { el, clear, svgIcon } from './dom.js';
import { S } from './strings.js';
import { customDialog } from './overlays.js';
import { system, pickFiles, onFileDrop } from '../core/platform.js';
import { fileName } from '../core/prompt.js';

/**
 * Show the composer for [draft] (see `newPromptDraft`), which it edits in
 * place. Resolves to true for Send, false for Cancel.
 *
 * @param {{ filesOk: boolean, error?: string|null }} options  filesOk is false
 *   when the machine's agent cannot take files; attaching then says so.
 */
export async function composePrompt(draft, { filesOk, error = null }) {
  const text = el('textarea.plain.prompt-text', {
    value: draft.text,
    rows: '8',
    placeholder: S.promptPlaceholder,
    'aria-label': S.promptTitle,
  });
  const enter = el('input', { type: 'checkbox', checked: draft.enter });
  const errorBox = el('div.field-error', { text: error ?? '' });
  errorBox.classList.toggle('hidden', !error);
  const files = el('div.chip-row.prompt-files');

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.classList.toggle('hidden', !message);
  };

  function renderFiles() {
    clear(files);
    draft.files.forEach((f, index) => {
      const image = (f.file?.mime ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name);
      // Only the cross removes it, as on the phone; the name is just a name.
      files.append(el('span.chip.file-chip', { title: f.name },
        svgIcon(image ? 'image' : 'file'),
        el('span', { text: f.name }),
        el('button.chip-remove', {
          type: 'button',
          title: S.promptRemoveFile(f.name),
          'aria-label': S.promptRemoveFile(f.name),
          onClick: () => { draft.files.splice(index, 1); renderFiles(); text.focus(); },
        }, svgIcon('close'))));
    });
    files.append(el('button.chip', { type: 'button', onClick: () => pick() },
      svgIcon('plus'), el('span', { text: S.attachFile })));
  }

  function add(entry) {
    if (!filesOk) { showError(S.pasteFileUnsupported); return; }
    if (entry.path && draft.files.some((f) => f.path === entry.path)) return;
    draft.files.push(entry);
    showError(null);
    renderFiles();
  }

  async function pick() {
    if (!filesOk) { showError(S.pasteFileUnsupported); return; }
    try {
      for (const path of await pickFiles()) add({ name: fileName(path), path });
    } catch {
      showError(S.attachFileUnavailable);
    }
    text.focus();
  }

  /** Files copied in Explorer come as paths; a copied picture comes as an image. */
  async function pasteFiles() {
    try {
      const clip = await system.clipboardRead();
      if (clip.files.length > 0) {
        for (const path of clip.files) add({ name: fileName(path), path });
        return;
      }
      const image = await system.clipboardReadImage();
      if (image) add({ name: image.name, file: image });
      else if (clip.text) text.setRangeText(clip.text, text.selectionStart, text.selectionEnd, 'end');
    } catch (err) {
      showError(S.pasteFileFailed(String(err?.message || err)));
    }
  }

  text.addEventListener('input', () => { draft.text = text.value; });
  enter.addEventListener('change', () => { draft.enter = enter.checked; });
  // Text pastes as text; only a paste that carries files is taken over.
  text.addEventListener('paste', (e) => {
    const types = [...(e.clipboardData?.types ?? [])];
    if (!types.includes('Files')) return;
    e.preventDefault();
    pasteFiles();
  });

  // The window hears dropped files, not the dialog; listen while it is open.
  let unlistenDrop = null;
  let closed = false;
  onFileDrop((event) => {
    if (event.type === 'drop') for (const path of event.paths) add({ name: fileName(path), path });
  }).then((off) => { if (closed) off(); else unlistenDrop = off; }).catch(() => {});

  renderFiles();
  try {
    return await customDialog({
      title: S.promptTitle,
      wide: true,
      build: (done) => {
        text.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && e.ctrlKey && !e.altKey) { e.preventDefault(); done(true); }
        });
        requestAnimationFrame(() => {
          text.focus();
          text.setSelectionRange(text.value.length, text.value.length);
        });
        return el('div', null,
          el('p', { text: S.promptBody }),
          el('label.field-label', { text: S.promptLabel }),
          text,
          el('p.hint', { text: S.promptHint }),
          files,
          el('label.check-row', null, enter, el('span', { text: S.promptEnter })),
          errorBox);
      },
      actions: [{ label: S.cancel, value: false }, { label: S.send, value: true }],
    }) === true;
  } finally {
    closed = true;
    unlistenDrop?.();
  }
}
