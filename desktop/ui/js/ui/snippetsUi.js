/**
 * Snippet dialogs shared by the Snippets screen, the terminal and the command
 * palette: the editor, the picker, and the fill-in form a snippet with
 * placeholders asks for before it is sent.
 */

import { el } from './dom.js';
import { S } from './strings.js';
import { customDialog, toast } from './overlays.js';
import { searchListDialog } from './pickers.js';
import {
  makeSnippet, newSnippetId, placeholders, fill, snippetInput, groupSnippets,
} from '../core/snippets.js';
import { fuzzyFilter } from '../core/fuzzy.js';

/** Create ([snippet] null) or edit a snippet; resolves to the saved one or null. */
export async function editSnippetDialog(app, snippet = null) {
  const name = el('input', { type: 'text', value: snippet?.name ?? '' });
  const folders = [...new Set(app.settings.snippets.map((s) => s.folder).filter(Boolean))];
  const listId = `snippet-folders-${Math.random().toString(36).slice(2)}`;
  const folder = el('input', { type: 'text', value: snippet?.folder ?? '', placeholder: S.snippetFolderHint, list: listId });
  const body = el('textarea.plain.mono', { value: snippet?.body ?? '', rows: '6', spellcheck: 'false' });
  const run = el('input', { type: 'checkbox', checked: snippet ? snippet.run : true });
  const error = el('div.field-error.hidden');

  for (;;) {
    const ok = await customDialog({
      title: snippet ? S.snippetEdit : S.snippetNew,
      wide: true,
      build: () => el('div', null,
        el('label.field-label', { text: S.snippetName }),
        el('div.field-well', null, name),
        el('label.field-label', { text: S.snippetFolder, style: { marginTop: '10px' } }),
        el('div.field-well', null, folder),
        el('datalist', { id: listId }, folders.map((f) => el('option', { value: f }))),
        el('label.field-label', { text: S.snippetBody, style: { marginTop: '10px' } }),
        body,
        el('p.hint', { text: S.snippetBodyHelp }),
        el('label.check-row', null, run, el('span', { text: S.snippetRun })),
        error),
      actions: [{ label: S.cancel, value: false }, { label: S.save, value: true }],
    });
    if (!ok) return null;
    const n = name.value.trim();
    const b = body.value.replace(/\r\n/g, '\n');
    if (!n) { showError(S.snippetNeedsName); continue; }
    if (!b.trim()) { showError(S.snippetNeedsBody); continue; }
    const saved = makeSnippet({ id: snippet?.id ?? newSnippetId(), name: n, folder: folder.value.trim(), body: b, run: run.checked });
    app.settings.saveSnippet(saved);
    return saved;
  }

  function showError(text) {
    error.textContent = text;
    error.classList.remove('hidden');
  }
}

/** The searchable snippet list; resolves to the chosen snippet or null. */
export async function pickSnippet(app) {
  const snippets = app.settings.snippets;
  const items = groupSnippets(snippets).flatMap((g) => g.snippets.map((s) => ({
    label: s.name,
    detail: s.body.split('\n')[0],
    icon: 'command',
    group: g.folder || S.snippetNoFolder,
    badge: s.run ? S.snippetRunsBadge : S.snippetInsertsBadge,
    snippet: s,
  })));
  const chosen = await searchListDialog({
    title: S.snippets,
    placeholder: S.snippetsSearchHint,
    items,
    grouped: true,
    emptyText: snippets.length === 0 ? S.snippetsEmptyBody : S.paletteEmpty,
    rank: (list, q) => (q.trim()
      ? fuzzyFilter(list, q, (x) => `${x.label} ${x.group} ${x.snippet.body}`, 50)
      : list),
  });
  return chosen?.snippet ?? null;
}

/**
 * Ask for the placeholders (if any) and resolve to the text to send, or null.
 * The last values used are remembered per snippet and placeholder.
 */
export async function fillSnippet(app, snippet) {
  const fields = placeholders(snippet.body);
  if (fields.length === 0) return snippet.body;
  const remembered = app.settings.snippetValues(snippet.id);
  const inputs = fields.map((f) => ({
    name: f.name,
    input: el('input', { type: 'text', value: remembered[f.name] ?? f.def, spellcheck: 'false' }),
  }));
  const preview = el('pre.snippet-preview');
  const update = () => {
    preview.textContent = fill(snippet.body, Object.fromEntries(inputs.map((i) => [i.name, i.input.value])));
  };
  const ok = await customDialog({
    title: S.snippetFillTitle(snippet.name),
    wide: true,
    build: (done) => {
      inputs.forEach((i, n) => {
        i.input.addEventListener('input', update);
        i.input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (n + 1 < inputs.length) inputs[n + 1].input.focus();
          else done(true);
        });
      });
      update();
      return el('div', null,
        inputs.map((i) => el('div.field', null,
          el('label.field-label', { text: i.name }),
          el('div.field-well', null, i.input))),
        el('div.section-label', { text: S.previewLabel }),
        preview);
    },
    actions: [{ label: S.cancel, value: false }, { label: snippet.run ? S.snippetSend : S.snippetInsert, value: true }],
  });
  if (!ok) return null;
  const values = Object.fromEntries(inputs.map((i) => [i.name, i.input.value]));
  app.settings.setSnippetValues(snippet.id, values);
  return fill(snippet.body, values);
}

/**
 * Fill in and send [snippet] through [send] (the terminal's raw input), using
 * bracketed paste when the program asked for it.
 */
export async function sendSnippet(app, snippet, { send, bracketed = false }) {
  if (!send) { toast(S.snippetNoTerminal); return false; }
  const text = await fillSnippet(app, snippet);
  if (text == null) return false;
  send(snippetInput(text, snippet.run, bracketed));
  return true;
}

