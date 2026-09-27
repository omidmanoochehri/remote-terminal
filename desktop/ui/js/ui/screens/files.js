/**
 * The file browser: one machine's files, under the folder its agent allows
 * (PROTOCOL.md §6b). Lives inside the machine screen as its Files segment, and
 * keeps its own state — the folder, the filter, transfers in flight — while
 * the machine screen redraws around it.
 *
 * A port of `FilesFragment.kt`.
 */

import { el, clear, svgIcon, stateBlock, headerAction, debounce } from '../dom.js';
import { S } from '../strings.js';
import {
  menu, toast, confirmDialog, promptDialog, customDialog,
} from '../overlays.js';
import { copyToClipboard, startTerminal } from '../actions.js';
import { featureGate } from '../../core/requests.js';
import { errorDisplay } from '../../protocol/incoming.js';
import {
  arrangeEntries, joinPath, breadcrumbs, viewKind, imageMime, entryIcon, downloadSlices, uploadSlices,
  decodeBase64, SORT_NAME, SORT_SIZE, SORT_MODIFIED, SLICE_BYTES, VIEW_MAX_BYTES, Cancelled,
} from '../../core/remoteFiles.js';
import { bytes, connectionLabel } from '../../core/format.js';
import { shellQuote } from '../../core/shell.js';
import { localFiles, pickFiles, pickSavePath, onFileDrop } from '../../core/platform.js';

/** The agent's error text, or the relay's, in the app's words. */
export function requestErrorText(err) {
  if (!err) return '';
  if (err.code === 'cancelled') return S.filesCancelled;
  return errorDisplay({ code: err.code, message: err.message }) || String(err.message || err);
}

function modifiedLabel(mtime) {
  if (!mtime) return '';
  const d = new Date(mtime);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * @param app
 * @param {string} agentId
 * @param {{path?:string, sessionKey?:string}} opts  a starting folder, and the
 *   terminal it was opened from (which enables "Insert path")
 */
export function filesPanel(app, agentId, { path: startPath = null, sessionKey = null } = {}) {
  let listing = null;          // the last fs.list result
  let path = startPath || null;
  let loading = false;
  let error = null;
  let filter = '';
  let selectedName = null;
  let loadToken = 0;
  let destroyed = false;
  const transfers = [];

  const crumbsNode = el('div.crumbs');
  const filterInput = el('input', { type: 'search', placeholder: S.filesFilterHint, 'aria-label': S.filesFilterHint });
  const upButton = headerAction('arrow_up', S.filesUp, () => goUp());
  const toolbar = el('div.files-toolbar', null,
    upButton,
    crumbsNode,
    el('span.spacer'),
    headerAction('refresh', S.filesRefresh, () => load(path)),
    headerAction('upload', S.filesUpload, () => chooseUploads()),
    headerAction('folder_plus', S.filesNewFolder, () => newFolder()),
    headerAction('terminal', S.filesOpenTerminalHere, () => openTerminalHere(listing?.path)),
    headerAction('more', S.more, (e) => optionsMenu(e.currentTarget)));
  const filterBar = el('div.search-bar', null, svgIcon('search'), filterInput);
  const transfersNode = el('div.transfers');
  const listNode = el('div.files-list', { tabindex: '0' });
  const footNode = el('div.files-foot');
  const dropHint = el('div.drop-hint.hidden', null, svgIcon('upload'), el('span', { text: S.filesDropHere }));
  const content = el('div.files-content', null, toolbar, filterBar, transfersNode, listNode, footNode, dropHint);
  const gateNode = el('div');
  const root = el('div.files-panel', null, gateNode, content);

  filterInput.addEventListener('input', debounce(() => { filter = filterInput.value; renderList(); }, 100));
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filterInput.value) { filterInput.value = ''; filter = ''; renderList(); e.stopPropagation(); }
    if (e.key === 'ArrowDown') { listNode.focus(); moveSelection(1); e.preventDefault(); }
  });
  listNode.addEventListener('keydown', onListKey);

  let unlistenDrop = null;
  onFileDrop(onDrop).then((off) => { if (destroyed) off(); else unlistenDrop = off; }).catch(() => {});

  /* ------------------------------ plumbing ------------------------------ */

  const agent = () => app.agents.agent(agentId);
  const sep = () => listing?.sep || (agent()?.platform === 'win32' ? '\\' : '/');
  const machineName = () => agent()?.name || agent()?.hostname || '';
  const request = (method, params) => app.client.agentRequest(agentId, method, params);
  const fullPath = (entry) => joinPath(listing.path, entry.name, sep());

  function gate() {
    if (!app.client.isConnected) return { ok: false, text: connectionLabel(app.client.state) };
    const g = featureGate(app.client.caps, agent(), 'fs');
    if (g.ok) return { ok: true };
    if (g.reason === 'offline') return { ok: false, text: S.featureOffline(g.name), icon: 'wifi_off' };
    return { ok: false, text: S.filesUnsupported, icon: 'package' };
  }

  /* ------------------------------- loading ------------------------------ */

  async function load(target, { fallbackToRoot = false } = {}) {
    const token = ++loadToken;
    loading = true;
    error = null;
    renderList();
    try {
      const result = await request('fs.list', target ? { path: target } : {});
      if (token !== loadToken || destroyed) return;
      const changed = !listing || listing.path !== result.path;
      listing = result;
      path = result.path;
      if (changed) {
        selectedName = null;
        filter = '';
        filterInput.value = '';
      }
    } catch (err) {
      if (token !== loadToken || destroyed) return;
      if (fallbackToRoot && target) {
        toast(requestErrorText(err), { error: true });
        loading = false;
        load(null);
        return;
      }
      // A folder that will not open leaves the one on screen in place.
      if (listing) toast(requestErrorText(err), { error: true });
      else error = requestErrorText(err);
    }
    loading = false;
    renderCrumbs();
    renderList();
  }

  function goUp() {
    if (listing?.parent) load(listing.parent);
  }

  function open(entry) {
    if (entry.type === 'dir') { load(fullPath(entry)); return; }
    if (viewKind(entry.name)) view(entry);
    else download(entry);
  }

  /* ------------------------------ rendering ----------------------------- */

  function renderCrumbs() {
    clear(crumbsNode);
    if (!listing) return;
    const trail = breadcrumbs(listing.path, listing.root, sep());
    trail.forEach((crumb, i) => {
      if (i > 0) crumbsNode.append(el('span.crumb-sep', { text: '›' }));
      const last = i === trail.length - 1;
      crumbsNode.append(el(`button.crumb${last ? '.current' : ''}`, {
        title: crumb.path,
        onClick: () => { if (!last) load(crumb.path); },
      }, i === 0 ? svgIcon('home') : null, el('span', { text: crumb.label })));
    });
    upButton.disabled = !listing.parent;
  }

  function visibleEntries() {
    if (!listing) return [];
    return arrangeEntries(listing.entries, { sort: app.settings.filesSort, showHidden: app.settings.filesShowHidden, filter });
  }

  function renderList() {
    clear(listNode);
    clear(footNode);
    if (loading && !listing) {
      listNode.append(el('div.files-loading', { text: '…' }));
      return;
    }
    if (error) {
      listNode.append(stateBlock({
        icon: 'alert', title: S.featureUnavailableTitle, body: error, tone: 'error',
        actionLabel: S.filesRefresh, actionIcon: 'refresh', onAction: () => load(path),
      }));
      return;
    }
    if (!listing) return;
    const entries = visibleEntries();
    if (entries.length === 0) {
      listNode.append(el('div.files-empty', { text: listing.entries.length > 0 && filter ? S.filesNoMatches : S.filesEmpty }));
    } else {
      const card = el('div.card.rows-card');
      entries.forEach((entry, i) => {
        if (i > 0) card.append(el('div.divider'));
        card.append(row(entry));
      });
      listNode.append(card);
    }
    footNode.append(el('span', { text: S.filesCount(entries.length) }));
    if (listing.truncated) footNode.append(el('span', { text: ` · ${S.filesTruncated}` }));
    listNode.classList.toggle('busy', loading);
  }

  function row(entry) {
    const selected = entry.name === selectedName;
    const meta = entry.type === 'dir'
      ? modifiedLabel(entry.mtime)
      : [bytes(entry.size), modifiedLabel(entry.mtime)].filter(Boolean).join(' · ');
    return el(`div.file-row${selected ? '.selected' : ''}${entry.hidden ? '.hidden-entry' : ''}`, {
      role: 'button',
      dataset: { name: entry.name },
      title: entry.name,
      onClick: () => select(entry.name),
      onDblclick: () => open(entry),
      oncontextmenu: (e) => {
        e.preventDefault();
        select(entry.name);
        entryMenu({ getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, entry);
      },
    },
    el(`span.file-icon${entry.type === 'dir' ? '.dir' : ''}`, null, svgIcon(entryIcon(entry))),
    el('div.row-text', null,
      el('div.file-name', { text: entry.name + (entry.link ? ' →' : '') }),
      el('div.row-meta', { text: meta })),
    el('button.icon-button.small', {
      title: S.more,
      onClick: (e) => { e.stopPropagation(); select(entry.name); entryMenu(e.currentTarget, entry); },
    }, svgIcon('more')));
  }

  function select(name) {
    selectedName = name;
    for (const node of listNode.querySelectorAll('.file-row')) {
      node.classList.toggle('selected', node.dataset.name === name);
    }
    listNode.querySelector('.file-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function selectedEntry() {
    return listing?.entries.find((e) => e.name === selectedName) ?? null;
  }

  function moveSelection(delta) {
    const entries = visibleEntries();
    if (entries.length === 0) return;
    const i = entries.findIndex((e) => e.name === selectedName);
    const next = i < 0 ? (delta > 0 ? 0 : entries.length - 1) : Math.max(0, Math.min(entries.length - 1, i + delta));
    select(entries[next].name);
  }

  function onListKey(e) {
    if (e.target !== listNode) return;
    const entry = selectedEntry();
    if (e.key === 'ArrowDown') { moveSelection(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && !e.altKey) { moveSelection(-1); e.preventDefault(); }
    else if (e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) { goUp(); e.preventDefault(); }
    else if (e.key === 'Enter' && entry) { open(entry); e.preventDefault(); }
    else if (e.key === 'Delete' && entry) { remove(entry); e.preventDefault(); }
    else if (e.key === 'F2' && entry) { rename(entry); e.preventDefault(); }
    else if (e.key === 'F5') { load(path); e.preventDefault(); }
  }

  /* -------------------------------- menus ------------------------------- */

  function entryMenu(anchor, entry) {
    const full = fullPath(entry);
    if (entry.type === 'dir') {
      menu(anchor, [
        { label: S.filesOpen, icon: 'folder_open', onClick: () => open(entry) },
        { label: S.filesOpenTerminalHere, icon: 'terminal', onClick: () => openTerminalHere(full) },
        { label: S.filesCopyPath, icon: 'copy', onClick: () => copyToClipboard(full) },
        sessionKey ? { label: S.filesInsertPath, icon: 'send', onClick: () => insertPath(full) } : null,
        { divider: true },
        { label: S.filesRename, icon: 'tag', onClick: () => rename(entry) },
        { label: S.filesDelete, icon: 'trash', danger: true, onClick: () => remove(entry) },
      ]);
      return;
    }
    menu(anchor, [
      viewKind(entry.name) ? { label: S.filesView, icon: 'eye', onClick: () => view(entry) } : null,
      { label: S.filesDownload, icon: 'download', onClick: () => download(entry) },
      { label: S.filesCopyPath, icon: 'copy', onClick: () => copyToClipboard(full) },
      sessionKey ? { label: S.filesInsertPath, icon: 'send', onClick: () => insertPath(full) } : null,
      { divider: true },
      { label: S.filesRename, icon: 'tag', onClick: () => rename(entry) },
      { label: S.filesDelete, icon: 'trash', danger: true, onClick: () => remove(entry) },
    ]);
  }

  function optionsMenu(anchor) {
    const sort = app.settings.filesSort;
    const setSort = (v) => { app.settings.filesSort = v; renderList(); };
    menu(anchor, [
      { label: S.filesSortName, icon: 'sliders', checked: sort === SORT_NAME, onClick: () => setSort(SORT_NAME) },
      { label: S.filesSortSize, icon: 'sliders', checked: sort === SORT_SIZE, onClick: () => setSort(SORT_SIZE) },
      { label: S.filesSortModified, icon: 'sliders', checked: sort === SORT_MODIFIED, onClick: () => setSort(SORT_MODIFIED) },
      { divider: true },
      {
        label: S.filesShowHidden,
        icon: 'eye',
        checked: app.settings.filesShowHidden,
        onClick: () => { app.settings.filesShowHidden = !app.settings.filesShowHidden; renderList(); },
      },
    ]);
  }

  /* ------------------------------- actions ------------------------------ */

  async function rename(entry) {
    const name = await promptDialog({ title: S.filesRename, label: S.filesNewName, value: entry.name, confirmLabel: S.filesRename });
    if (!name || name === entry.name) return;
    try {
      await request('fs.rename', { from: fullPath(entry), to: joinPath(listing.path, name, sep()) });
      selectedName = name;
      await load(listing.path);
    } catch (err) {
      toast(requestErrorText(err), { error: true });
    }
  }

  async function remove(entry) {
    const folder = entry.type === 'dir';
    const ok = await confirmDialog({
      title: S.filesDeleteTitle(entry.name),
      body: folder ? S.filesDeleteFolderBody(machineName()) : S.filesDeleteFileBody(machineName()),
      confirmLabel: S.filesDelete,
      cancelLabel: S.cancel,
      danger: true,
    });
    if (!ok) return;
    try {
      await request('fs.delete', { path: fullPath(entry), recursive: folder });
      if (selectedName === entry.name) selectedName = null;
      await load(listing.path);
    } catch (err) {
      toast(requestErrorText(err), { error: true });
    }
  }

  async function newFolder() {
    if (!listing) return;
    const name = await promptDialog({ title: S.filesNewFolder, label: S.filesNewFolderName, confirmLabel: S.filesNewFolder });
    if (!name) return;
    try {
      await request('fs.mkdir', { path: joinPath(listing.path, name, sep()) });
      selectedName = name;
      await load(listing.path);
    } catch (err) {
      toast(requestErrorText(err), { error: true });
    }
  }

  function openTerminalHere(dir) {
    const a = agent();
    if (!a || !dir) return;
    startTerminal(app, a, { shellId: null, title: null, directory: dir, command: '' });
  }

  function insertPath(full) {
    const s = sessionKey ? app.sessions.sessions.get(sessionKey) : null;
    if (!s || !app.sessions.input(s, shellQuote(full))) {
      toast(S.terminalNotConnected, { error: true });
      return;
    }
    toast(S.filesPathInserted);
    app.back();
  }

  /* ------------------------------ transfers ----------------------------- */

  function addTransfer(kind, name) {
    const t = { kind, name, done: 0, total: 0, cancelled: false, node: null, bar: null, label: null };
    t.bar = el('span');
    t.label = el('div.transfer-label', { text: kind === 'down' ? S.filesDownloading(name) : S.filesUploading(name) });
    t.node = el('div.transfer', null,
      svgIcon(kind === 'down' ? 'download' : 'upload'),
      el('div.transfer-text', null, t.label, el('div.meter', null, t.bar)),
      el('button.icon-button.small', { title: S.cancel, onClick: () => { t.cancelled = true; } }, svgIcon('close')));
    t.progress = (done, total) => {
      t.done = done;
      t.total = total;
      t.bar.style.width = total > 0 ? `${Math.min(100, (done / total) * 100)}%` : '0';
      t.label.textContent = `${kind === 'down' ? S.filesDownloading(name) : S.filesUploading(name)} · ${bytes(done)} / ${bytes(total)}`;
    };
    transfers.push(t);
    transfersNode.append(t.node);
    return t;
  }

  function endTransfer(t) {
    const i = transfers.indexOf(t);
    if (i >= 0) transfers.splice(i, 1);
    t.node.remove();
  }

  async function download(entry) {
    let dest;
    try {
      dest = await pickSavePath(entry.name);
    } catch (err) {
      toast(String(err?.message || err), { error: true });
      return;
    }
    if (!dest) return;
    const remote = fullPath(entry);
    const t = addTransfer('down', entry.name);
    try {
      await downloadSlices({
        read: (offset) => request('fs.read', { path: remote, offset, length: SLICE_BYTES }),
        write: (offset, data) => localFiles.write(dest, offset, data),
        onProgress: t.progress,
        isCancelled: () => t.cancelled || destroyed,
      });
      toast(S.filesDownloaded(dest));
    } catch (err) {
      await localFiles.remove(dest).catch(() => {});
      if (err instanceof Cancelled) toast(S.filesCancelled);
      else toast(S.filesTransferFailed(entry.name, requestErrorText(err)), { error: true });
    } finally {
      endTransfer(t);
    }
  }

  async function chooseUploads() {
    if (!listing) return;
    let paths;
    try {
      paths = await pickFiles();
    } catch (err) {
      toast(String(err?.message || err), { error: true });
      return;
    }
    await uploadPaths(paths);
  }

  async function uploadPaths(paths) {
    if (!listing || paths.length === 0) return;
    const dir = listing.path;
    for (const local of paths) {
      if (destroyed) return;
      await uploadOne(local, dir);
    }
    if (!destroyed && listing?.path === dir) load(dir);
  }

  async function uploadOne(local, dir) {
    let info;
    try {
      info = await localFiles.info(local);
    } catch (err) {
      toast(S.filesTransferFailed(local, String(err?.message || err)), { error: true });
      return;
    }
    const remote = joinPath(dir, info.name, sep());
    let overwrite = false;
    if (listing?.path === dir && listing.entries.some((e) => e.name === info.name)) {
      overwrite = await askReplace(info.name);
      if (!overwrite) return;
    }
    for (;;) {
      const t = addTransfer('up', info.name);
      try {
        await uploadSlices({
          read: (offset) => localFiles.read(local, offset, SLICE_BYTES),
          write: (offset, data, final) => request('fs.write', { path: remote, offset, data, final, overwrite }),
          onProgress: t.progress,
          isCancelled: () => t.cancelled || destroyed,
        });
        toast(S.filesUploaded(info.name));
        return;
      } catch (err) {
        if (err?.code === 'exists' && !overwrite) {
          endTransfer(t);
          overwrite = await askReplace(info.name);
          if (!overwrite) return;
          continue;
        }
        if (err instanceof Cancelled) toast(S.filesCancelled);
        else toast(S.filesTransferFailed(info.name, requestErrorText(err)), { error: true });
        return;
      } finally {
        endTransfer(t);
      }
    }
  }

  function askReplace(name) {
    return confirmDialog({
      title: S.filesExistsTitle(name),
      confirmLabel: S.filesReplace,
      cancelLabel: S.filesSkip,
      danger: true,
    }).then((ok) => ok === true);
  }

  function onDrop({ type, paths }) {
    if (!root.isConnected || !gate().ok || !listing) return;
    if (type === 'enter' || type === 'over') dropHint.classList.remove('hidden');
    else dropHint.classList.add('hidden');
    if (type === 'drop' && paths.length > 0) uploadPaths(paths);
  }

  /* -------------------------------- viewer ------------------------------ */

  async function view(entry) {
    const kind = viewKind(entry.name);
    if (!kind) { toast(S.filesCannotView); return; }
    if (entry.size > VIEW_MAX_BYTES) { toast(S.filesTooLargeToView); return; }
    const remote = fullPath(entry);
    const parts = [];
    try {
      await downloadSlices({
        read: (offset) => request('fs.read', { path: remote, offset, length: SLICE_BYTES }),
        write: (_offset, data) => { parts.push(decodeBase64(data)); },
      });
    } catch (err) {
      toast(requestErrorText(err), { error: true });
      return;
    }
    const blob = new Blob(parts, { type: kind === 'image' ? imageMime(entry.name) : 'text/plain' });
    if (kind === 'image') {
      const url = URL.createObjectURL(blob);
      await customDialog({
        title: entry.name,
        wide: true,
        build: () => el('div.file-view.image', null, el('img', { src: url, alt: entry.name })),
        actions: [{ label: S.filesDownload, value: 'download' }, { label: S.ok, value: true }],
      }).then((v) => { if (v === 'download') download(entry); });
      URL.revokeObjectURL(url);
      return;
    }
    const text = await blob.text();
    const choice = await customDialog({
      title: entry.name,
      wide: true,
      build: () => el('pre.file-view', { text }),
      actions: [
        { label: S.copy, value: 'copy' },
        { label: S.filesDownload, value: 'download' },
        { label: S.ok, value: true },
      ],
    });
    if (choice === 'copy') copyToClipboard(text);
    if (choice === 'download') download(entry);
  }

  /* ------------------------------ lifecycle ----------------------------- */

  /** Called by the machine screen on every redraw: re-check the gate. */
  function update() {
    const g = gate();
    clear(gateNode);
    content.classList.toggle('hidden', !g.ok);
    if (!g.ok) {
      gateNode.append(stateBlock({ icon: g.icon ?? 'wifi_off', title: S.featureUnavailableTitle, body: g.text }));
      return;
    }
    if (!listing && !loading && !error) load(path, { fallbackToRoot: true });
  }

  function destroy() {
    destroyed = true;
    for (const t of transfers) t.cancelled = true;
    unlistenDrop?.();
  }

  return { root, update, destroy, focus: () => listNode.focus() };
}
