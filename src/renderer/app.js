/* global monaco, marked, DOMPurify, require, api, icon, iconEl, fileBadge, MODEL_CATALOG, FIT_INFO, recommendModels, recommendLongContext, catalogEntryFor, describeSpecs, formatGB, formatContext, DANGEROUS_COMMAND, commandNeedsApproval, ToolParse, Schedule, SemIndex, diffOps, diffStats, unifiedDiff, diffSegments, applyBlocks */
'use strict';

// `api` is the bridge exposed by preload.js (window.api).
// Large areas live in sibling modules loaded before this file (classic scripts
// sharing the global scope): providers.js, tools.js, git.js, history.js,
// agent-loop.js, automations.js, settings-ui.js, models-ui.js.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const APPROVAL_MODES = {
  ask: { label: 'Ask', icon: 'shield', desc: 'Approve every file edit and command.' },
  edits: { label: 'Auto-edit', icon: 'shieldCheck', desc: 'Edits apply right away (revert them from Changes). Commands ask unless always-allowed.' },
  auto: { label: 'Full auto', icon: 'zap', desc: 'Edits and commands run without asking. Destructive commands still ask.' }
};
// Commands that always need approval, whatever the mode.
const DEFAULT_MAX_STEPS = 60;
// After this many rounds that made no progress (only repeated or read-only calls, no file
// change or command), nudge the model to finish instead of looping.
const STALL_LIMIT = 6;
const MAX_TOOL_RESULT = 24_000;
const MAX_ATTACH = 60_000;

const state = {
  settings: null,
  ws: null, // { root, name, sep, platform }
  tabs: [], // { path, model, savedVersion, viewState, preview, decoIds }
  active: null,
  selectedDir: '.',
  expanded: new Set(['.']),
  view: 'explorer',
  conv: null, // the conversation on screen (see createConv)
  convs: new Map(), // id -> loaded or running conversations
  convList: [], // saved conversation summaries for this workspace
  attachCurrent: true,
  review: null, // { path, original, modified, pending, visible, title, onDecide, cancelOnClose }
  fileIndex: null,
  searchRegex: false,
  quick: { mode: 'open', items: [], sel: 0 },
  appInfo: null,
  update: { phase: 'idle', info: null, percent: 0, error: '' },
  specs: null,
  tags: null, // Ollama status and installed models
  pulls: new Map(), // model id -> { status, completed, total }
  modelsMode: 'standard', // or 'long' (YaRN builds) in the Models window
  hf: new Map(), // Hugging Face repo -> resolved YaRN build ({ status, ollamaId, sizeGB, ... })
  modelInfo: null, // { contextLength, rope } of the model in use, from Ollama
  mcp: [], // connected MCP servers and their tools
  nodeHealth: { at: 0, byId: {} }, // Ollama node health: id -> { up, models, error }
  warned: new Set() // one-time notices already shown this session
};

let editor;
let reviewEditor;
let reviewSideBySide = true;
const extraAttachments = new Set();

// ===================================================================
// Boot
// ===================================================================
require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
require(['vs/editor/editor.main'], async () => {
  hydrateIcons(document);
  state.settings = await api.getSettings();
  state.attachCurrent = state.settings.includeCurrentFile;

  monaco.editor.defineTheme('qwen-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#18181c',
      'editorGutter.background': '#18181c',
      'minimap.background': '#18181c',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#4f4f5a',
      'editorLineNumber.activeForeground': '#c8c8d0',
      'editor.selectionBackground': '#8b6cff40',
      'editor.inactiveSelectionBackground': '#8b6cff22',
      'editorIndentGuide.background': '#26262d',
      'editorCursor.foreground': '#a892ff',
      'editorWidget.background': '#1d1d22',
      'editorWidget.border': '#3a3a44',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'diffEditor.insertedLineBackground': '#3fb9501c',
      'diffEditor.removedLineBackground': '#f470671c',
      'diffEditor.insertedTextBackground': '#3fb95033',
      'diffEditor.removedTextBackground': '#f4706733'
    }
  });

  editor = monaco.editor.create($('#editor'), {
    theme: 'qwen-dark',
    automaticLayout: true,
    fontSize: state.settings.fontSize,
    fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
    fontLigatures: true,
    minimap: { enabled: true, renderCharacters: false, scale: 1 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    renderWhitespace: 'selection',
    padding: { top: 10 },
    tabSize: 2
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openQuick('open'));
  editor.onDidChangeCursorSelection(() => {
    renderChips();
    renderCursor();
  });
  editor.onDidChangeModel(renderCursor);

  bindUi();
  startAutomationScheduler();
  initSplitters();
  restoreLayout();
  applySettingsToUi();
  checkConnection();
  initUpdates();
  initMcp();
  await pickDefaultModel();

  if (state.settings.lastWorkspace) await openWorkspace(state.settings.lastWorkspace, true);
  renderAll();
});

function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((s) => {
    s.innerHTML = icon(s.dataset.icon);
    s.classList.add('ico');
  });
}

function renderAll() {
  renderTree();
  renderTabs();
  renderCenter();
  renderChanges();
  renderChips();
  renderStatusbar();
  renderHistory();
}

// ===================================================================
// Workspace
// ===================================================================
async function openWorkspace(dir, silent) {
  const running = [...state.convs.values()].filter((c) => c.busy);
  if (running.length && !confirm(`${running.length} task${running.length === 1 ? ' is' : 's are'} still running in this folder. Stop and switch folders?`)) return;
  running.forEach((c) => stopChat(c));
  const ws = await api.setWorkspace(dir);
  if (!ws) {
    if (!silent) alert(`Could not open folder:\n${dir}`);
    return;
  }
  for (const t of state.tabs) t.model.dispose();
  Object.assign(state, {
    tabs: [],
    active: null,
    ws,
    expanded: new Set(['.']),
    selectedDir: '.',
    fileIndex: null,
    conv: null
  });
  closeReview(true);
  state.settings = await api.getSettings();
  state.semReady = false;
  api.semStatus().then((st) => {
    state.semReady = !!st.exists;
  }).catch(() => {});
  $('#term-shell').textContent = ws.platform === 'win32' ? '· cmd.exe' : '· sh';
  $('#term-out').innerHTML = '';
  await loadConversations();
  renderAll();
  startGitSyncTimer();
}

async function pickWorkspace() {
  const dir = await api.pickWorkspace();
  if (dir) await openWorkspace(dir);
}

function requireWorkspace() {
  if (state.ws) return true;
  pickWorkspace();
  return false;
}

function showFolderMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const recent = (state.settings.recentWorkspaces || []).filter((p) => p !== state.ws?.root);
  const items = [
    { label: 'Open Folder…', icon: 'folderOpen', detail: 'Ctrl+O', onClick: pickWorkspace },
    { label: 'Clone from GitHub…', icon: 'gitCommit', onClick: cloneFlow }
  ];
  if (recent.length) items.push('-');
  for (const p of recent) items.push({ label: baseName(p), detail: p, icon: 'history', onClick: () => openWorkspace(p) });
  showMenu(r.left, r.bottom + 4, items);
}

// ===================================================================
// Explorer
// ===================================================================
async function renderTree() {
  const tree = $('#tree');
  $('#explorer-title').textContent = state.ws ? state.ws.name : 'Explorer';
  if (!state.ws) {
    tree.replaceChildren(
      el('div', { class: 'empty-note' }, 'No folder open.', el('br'), el('button', { class: 'primary', onclick: pickWorkspace }, iconEl('folderOpen'), 'Open Folder'))
    );
    return;
  }
  const ul = el('ul');
  await fillDir(ul, '.', 0);
  tree.replaceChildren(ul);
}

async function fillDir(ul, dirPath, depth) {
  let entries;
  try {
    entries = await api.list(dirPath);
  } catch (e) {
    ul.replaceChildren(el('li', { class: 'empty-note', text: e.message }));
    return;
  }
  for (const entry of entries) {
    const open = entry.dir && state.expanded.has(entry.path);
    const ch = state.conv?.changes.get(entry.path);
    const row = el(
      'div',
      {
        class: `node${open ? ' open' : ''}${entry.path === state.active ? ' active' : ''}${entry.dir && entry.path === state.selectedDir ? ' selected' : ''}${ch ? (ch.original === null ? ' added' : ' changed') : ''}`,
        dataset: { path: entry.path },
        style: `padding-left:${6 + depth * 12}px`,
        title: entry.path
      },
      entry.dir ? iconEl('chevronRight', 'chev') : el('span', { class: 'chev' }),
      entry.dir ? iconEl(open ? 'folderOpen' : 'folder', 'folder-ico') : fileBadge(entry.name),
      el('span', { class: 'label', text: entry.name }),
      ch ? el('span', { class: 'mark', text: ch.original === null ? 'A' : 'M' }) : null
    );
    const li = el('li', {}, row);
    if (entry.dir) {
      const child = el('ul');
      li.append(child);
      if (open) await fillDir(child, entry.path, depth + 1);
      row.onclick = async () => {
        state.selectedDir = entry.path;
        $$('.node.selected').forEach((n) => n.classList.remove('selected'));
        row.classList.add('selected');
        if (state.expanded.has(entry.path)) {
          state.expanded.delete(entry.path);
          child.replaceChildren();
          row.classList.remove('open');
        } else {
          state.expanded.add(entry.path);
          await fillDir(child, entry.path, depth + 1);
          row.classList.add('open');
        }
        row.querySelector('.folder-ico').innerHTML = icon(row.classList.contains('open') ? 'folderOpen' : 'folder');
      };
    } else {
      row.onclick = () => openFile(entry.path);
    }
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      showTreeMenu(ev, entry);
    };
    ul.append(li);
  }
}

function showTreeMenu(ev, entry) {
  const items = [];
  if (!entry.dir) {
    items.push({ label: 'Open', icon: 'file', onClick: () => openFile(entry.path) });
    items.push({ label: 'Add to chat', icon: 'paperclip', onClick: () => addFileToChat(entry.path) });
    items.push('-');
  } else {
    items.push({ label: 'Ask Qwen about this folder', icon: 'sparkles', onClick: () => setPrompt(`Explain what the ${entry.path}/ folder contains and how it fits into the project.`, true) });
    items.push('-');
  }
  const base = entry.dir ? entry.path : parentDir(entry.path);
  items.push({ label: 'New file here…', icon: 'filePlus', onClick: () => newFile(base) });
  items.push({ label: 'New folder here…', icon: 'folderPlus', onClick: () => newFolder(base) });
  items.push({ label: 'Reveal in File Explorer', icon: 'external', onClick: () => api.reveal(entry.path) });
  items.push('-');
  items.push({
    label: 'Delete',
    icon: 'trash',
    onClick: async () => {
      if (await api.remove(entry.path)) {
        if (findTab(entry.path)) closeTab(entry.path, true);
        state.fileIndex = null;
        renderTree();
      }
    }
  });
  showMenu(ev.clientX, ev.clientY, items);
}

async function newFile(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New file', 'e.g. src/utils.js');
  if (!name) return;
  const p = joinPath(dir, name.replace(/\\/g, '/'));
  if (await api.exists(p)) return alert(`${p} already exists.`);
  await api.write(p, '');
  expandTo(p);
  state.fileIndex = null;
  await renderTree();
  openFile(p);
}

async function newFolder(dir = state.selectedDir) {
  if (!requireWorkspace()) return;
  const name = await askInput('New folder', 'e.g. src/components');
  if (!name) return;
  const p = joinPath(dir, name.replace(/\\/g, '/'));
  await api.mkdir(p);
  expandTo(p + '/x');
  renderTree();
}

function expandTo(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) state.expanded.add(parts.slice(0, i).join('/'));
}

// ===================================================================
// Side views
// ===================================================================
function showView(view, toggle) {
  const side = $('#sidepanel');
  if (toggle && state.view === view && !side.classList.contains('hidden')) {
    side.classList.add('hidden');
    $$('.act[data-view]').forEach((b) => b.classList.remove('active'));
    saveLayout();
    return;
  }
  state.view = view;
  side.classList.remove('hidden');
  $$('.act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  if (view === 'search') setTimeout(() => $('#search-input').focus(), 0);
  if (view === 'changes') renderChanges();
  saveLayout();
}

let searchTimer = null;
async function runSearch() {
  const q = $('#search-input').value;
  const out = $('#search-results');
  const summary = $('#search-summary');
  if (!q.trim() || !state.ws) {
    out.replaceChildren();
    summary.textContent = state.ws ? '' : 'Open a folder to search it.';
    return;
  }
  summary.textContent = 'Searching…';
  let hits;
  try {
    hits = await api.search(q, { regex: state.searchRegex, limit: 400 });
  } catch (e) {
    summary.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return;
  }
  if (q !== $('#search-input').value) return; // a newer search is running
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }
  summary.textContent = hits.length ? `${hits.length}${hits.length >= 400 ? '+' : ''} results in ${byFile.size} files` : 'No results.';
  const re = state.searchRegex ? safeRegex(q) : new RegExp(escapeRegex(q), 'ig');
  const frag = document.createDocumentFragment();
  for (const [path, list] of byFile) {
    frag.append(
      el('div', { class: 'sr-file', onclick: () => openFile(path, { line: list[0].line }), title: path },
        fileBadge(baseName(path)), el('span', { text: baseName(path) }), el('span', { class: 'dir', text: parentDir(path) === '.' ? '' : parentDir(path) }),
        el('span', { class: 'count', text: String(list.length) }))
    );
    for (const h of list) {
      const line = el('div', { class: 'sr-line', onclick: () => openFile(path, { line: h.line }), title: h.text }, el('span', { class: 'ln', text: String(h.line) }));
      const text = el('span');
      if (re) {
        let last = 0;
        h.text.replace(re, (m, ...rest) => {
          const idx = rest[rest.length - 2];
          text.append(h.text.slice(last, idx), el('mark', { text: m }));
          last = idx + m.length;
          return m;
        });
        text.append(h.text.slice(last));
      } else {
        text.textContent = h.text;
      }
      line.append(text);
      frag.append(line);
    }
  }
  out.replaceChildren(frag);
}

function safeRegex(q) {
  try {
    return new RegExp(q, 'ig');
  } catch {
    return null;
  }
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- changes made by Qwen ----------
// Changes belong to the conversation that made them, so reverting undoes just that task.
function recordChange(c, path, before, after) {
  const prev = c.changes.get(path);
  const original = prev ? prev.original : before;
  if ((original !== null && original === after) || (original === null && after === null)) {
    c.changes.delete(path);
  } else {
    const first = !c.changes.size;
    c.changes.set(path, { original, deleted: after === null, ...diffStats(original ?? '', after ?? '') });
    // The task's first change can move the work onto its own qwen/<task> branch (opt-in).
    if (first) maybeTaskBranch(c);
  }
  if (c === state.conv) renderChanges();
  saveConv(c);
}

// Runs a git command in the project root through the shared command IPC.
function renderChanges() {
  const changes = state.conv?.changes || new Map();
  const n = changes.size;
  const badge = $('#changes-badge');
  badge.textContent = String(n);
  badge.classList.toggle('hidden', !n);
  $('#btn-revert-all').classList.toggle('hidden', !n);
  $('#btn-commit').classList.toggle('hidden', !state.ws);
  $('#btn-push').classList.toggle('hidden', !state.ws);
  const list = $('#changes-list');
  if (!n) {
    list.replaceChildren(el('div', { class: 'empty-note', text: 'Files Qwen creates or edits in this conversation show up here. Click one to see the diff, or revert it.' }));
    return;
  }
  list.replaceChildren(...[...changes].map(([path, ch]) => changeItem(path, ch)));
}

function changeItem(path, ch) {
  const st = ch.deleted ? 'D' : ch.original === null ? 'A' : 'M';
  return el(
    'div',
    { class: 'ch-item', title: path, onclick: () => openChangeReview(path) },
    el('span', { class: `st ${st}`, text: st, title: { A: 'Added', M: 'Modified', D: 'Deleted' }[st] }),
    fileBadge(baseName(path)),
    el('span', { class: 'name', text: baseName(path) }),
    el('span', { class: 'dir', text: parentDir(path) === '.' ? '' : parentDir(path) }),
    el('span', { class: 'stats', html: statsHtml(ch) }),
    el('span', { class: 'acts' },
      el('button', { class: 'icon-btn', title: 'Open file', onclick: (e) => { e.stopPropagation(); openFile(path); } }, iconEl('file')),
      el('button', { class: 'icon-btn', title: 'Revert', onclick: (e) => { e.stopPropagation(); revertChange(path); } }, iconEl('undo')))
  );
}

function statsHtml({ added, removed }) {
  return `<span class="add">+${added}</span> <span class="del">−${removed}</span>`;
}

async function openChangeReview(path) {
  const ch = state.conv?.changes.get(path);
  if (!ch) return openFile(path);
  let current = '';
  try {
    current = findTab(path)?.model.getValue() ?? (await api.read(path));
  } catch {
    /* deleted since */
  }
  openReview({ path, original: ch.original ?? '', modified: current, pending: false, title: `${ch.deleted ? 'Deleted' : ch.original === null ? 'Created' : 'Changed'} ${path}` });
}

async function revertChange(path, ask = true) {
  const c = state.conv;
  const ch = c?.changes.get(path);
  if (!ch) return;
  const what = ch.original === null ? `delete ${path} (Qwen created it)` : ch.deleted ? `restore ${path}, which Qwen deleted` : `restore ${path} to how it was before Qwen changed it`;
  if (ask && !confirm(`Revert: ${what}?`)) return;
  try {
    if (ch.original === null) {
      await api.remove(path, { quiet: true });
      if (findTab(path)) closeTab(path, true);
      state.fileIndex = null;
    } else {
      await api.write(path, ch.original);
      syncOpenTab(path, ch.original);
      clearHighlights(path);
      if (ch.deleted) {
        expandTo(path);
        state.fileIndex = null;
      }
    }
  } catch (e) {
    alert(`Could not revert ${path}: ${e.message}`);
    return;
  }
  c.changes.delete(path);
  c.notes.push(`The user reverted your changes to ${path}${ch.original === null ? ' (the file was deleted)' : ''}.`);
  saveConv(c);
  if (state.review && !state.review.pending && state.review.path === path) closeReview(true);
  renderChanges();
  renderTree();
  renderCenter();
  flash(`Reverted ${path}`);
}

async function revertAll() {
  const changes = state.conv?.changes;
  const n = changes?.size;
  if (!n || !confirm(`Revert all ${n} files Qwen changed in this conversation?`)) return;
  for (const path of [...changes.keys()]) await revertChange(path, false);
}

// ===================================================================
// Editor, tabs, review
// ===================================================================
function findTab(path) {
  return state.tabs.find((t) => t.path === path);
}

async function openFile(path, { line, preview = false, focus = true } = {}) {
  let tab = findTab(path);
  if (!tab) {
    let content;
    try {
      content = await api.read(path);
    } catch (e) {
      if (focus) alert(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return false;
    }
    if (preview) {
      const old = state.tabs.find((t) => t.preview && !isDirty(t));
      if (old) closeTab(old.path, true, { keepActive: true });
    }
    const uri = monaco.Uri.file('/' + path);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(content, undefined, uri);
    model.setValue(content);
    tab = { path, model, savedVersion: model.getAlternativeVersionId(), viewState: null, preview, decoIds: [] };
    model.onDidChangeContent(() => {
      if (!tab.syncing) {
        tab.preview = false;
        clearHighlights(path);
      }
      renderTabs();
    });
    state.tabs.push(tab);
  } else if (!preview) {
    tab.preview = false;
  }
  activateTab(path, { focus });
  if (line) {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
  return true;
}

function activateTab(path, { focus = true } = {}) {
  const current = findTab(state.active);
  if (current) current.viewState = editor.saveViewState();
  const tab = findTab(path);
  state.active = tab ? path : null;
  if (state.review) state.review.visible = false;
  if (tab) {
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    if (focus) editor.focus();
  } else {
    editor.setModel(null);
  }
  $$('.node').forEach((n) => n.classList.toggle('active', n.dataset.path === state.active));
  renderTabs();
  renderCenter();
  renderChips();
  renderCursor();
}

function isDirty(tab) {
  return tab.model.getAlternativeVersionId() !== tab.savedVersion;
}

function renderTabs() {
  const bar = $('#tabs');
  const nodes = state.tabs.map((tab) => {
    const active = tab.path === state.active && !state.review?.visible;
    return el(
      'div',
      {
        class: `tab${active ? ' active' : ''}${isDirty(tab) ? ' dirty' : ''}${tab.preview ? ' preview' : ''}`,
        title: tab.path,
        onclick: () => activateTab(tab.path),
        ondblclick: () => {
          tab.preview = false;
          renderTabs();
        },
        onmousedown: (e) => {
          if (e.button === 1) closeTab(tab.path);
        }
      },
      fileBadge(baseName(tab.path)),
      el('span', { class: 'name', text: baseName(tab.path) }),
      el('button', { class: 'close', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); closeTab(tab.path); } }, iconEl('x'))
    );
  });
  if (state.review) {
    const r = state.review;
    nodes.push(
      el('div', { class: `tab review-tab${r.visible ? ' active' : ''}${r.pending ? ' pending' : ''}`, title: r.title, onclick: () => showReview() },
        iconEl('changes'),
        el('span', { class: 'name', text: `${r.pending ? 'Review' : 'Diff'}: ${baseName(r.path)}` }),
        el('button', { class: 'close', title: 'Close', onclick: (e) => { e.stopPropagation(); closeReview(); } }, iconEl('x')))
    );
  }
  bar.replaceChildren(...nodes);
  bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(path, force, { keepActive } = {}) {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (!force && isDirty(tab) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  state.tabs.splice(i, 1);
  if (state.active === path && !keepActive) {
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    activateTab(next ? next.path : null);
  } else if (state.active === path) {
    state.active = null;
  }
  tab.model.dispose();
  renderTabs();
  renderCenter();
}

async function saveActive() {
  const tab = findTab(state.active);
  if (!tab) return;
  await api.write(tab.path, tab.model.getValue());
  tab.savedVersion = tab.model.getAlternativeVersionId();
  tab.preview = false;
  renderTabs();
  flash(`Saved ${tab.path}`);
}

// Called after Qwen writes a file, so open tabs show the new content (undoable with Ctrl+Z).
function syncOpenTab(path, content) {
  const tab = findTab(path);
  if (!tab || tab.model.getValue() === content) return;
  tab.syncing = true;
  tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: content }], () => null);
  tab.syncing = false;
  tab.savedVersion = tab.model.getAlternativeVersionId();
  renderTabs();
}

// Marks the lines Qwen just added or changed, until the user edits the file.
function highlightChanges(path, before, after) {
  const tab = findTab(path);
  if (!tab) return;
  const ops = diffOps(before ?? '', after);
  if (!ops) return;
  const lineCount = tab.model.getLineCount();
  const decos = [];
  for (const [op, , , j] of ops) {
    if (op === '+') {
      decos.push({
        range: new monaco.Range(j + 1, 1, j + 1, 1),
        options: { isWholeLine: true, className: 'qw-added', linesDecorationsClassName: 'qw-gutter-add', overviewRuler: { color: '#3fb950', position: monaco.editor.OverviewRulerLane.Left } }
      });
    } else if (op === '-') {
      const line = Math.max(1, Math.min(j + 1, lineCount));
      decos.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: 'qw-gutter-del', overviewRuler: { color: '#f47067', position: monaco.editor.OverviewRulerLane.Left } } });
    }
  }
  tab.decoIds = tab.model.deltaDecorations(tab.decoIds || [], decos);
  const first = decos[0]?.range.startLineNumber;
  if (first && state.active === path) editor.revealLineInCenterIfOutsideViewport(first);
}

function clearHighlights(path) {
  const tab = findTab(path);
  if (tab?.decoIds?.length) tab.decoIds = tab.model.deltaDecorations(tab.decoIds, []);
}

function languageForPath(path) {
  const ext = '.' + path.split('.').pop().toLowerCase();
  const name = baseName(path).toLowerCase();
  return monaco.languages.getLanguages().find((l) => l.extensions?.includes(ext) || l.filenames?.map((f) => f.toLowerCase()).includes(name))?.id || 'plaintext';
}

function openReview({ path, original, modified, pending, title, onDecide, cancelOnClose }) {
  if (!reviewEditor) {
    reviewEditor = monaco.editor.createDiffEditor($('#review-editor'), {
      theme: 'qwen-dark',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: reviewSideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      renderOverviewRuler: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: Number(state.settings.fontSize) || 14,
      fontFamily: "'Cascadia Code', Consolas, 'Courier New', monospace",
      hideUnchangedRegions: { enabled: true }
    });
  }
  const old = reviewEditor.getModel();
  const lang = languageForPath(path);
  const stamp = Date.now();
  reviewEditor.setModel({
    original: monaco.editor.createModel(original ?? '', lang, monaco.Uri.parse(`review-a:/${stamp}/${path}`)),
    modified: monaco.editor.createModel(modified, lang, monaco.Uri.parse(`review-b:/${stamp}/${path}`))
  });
  old?.original.dispose();
  old?.modified.dispose();

  state.review = { path, original, modified, pending, visible: true, title: title || path, onDecide, cancelOnClose };
  $('#review-title').textContent = state.review.title;
  $('#review-stats').innerHTML = statsHtml(diffStats(original ?? '', modified));
  $('.review-bar').classList.toggle('pending', !!pending);
  const actions = $('#review-actions');
  if (pending) {
    actions.replaceChildren(
      el('button', { class: 'ghost danger-text', onclick: () => state.review?.onDecide?.(false) }, 'Reject'),
      el('button', { class: 'primary', onclick: () => state.review?.onDecide?.(true) }, iconEl('check'), 'Approve')
    );
  } else {
    actions.replaceChildren(
      el('button', { class: 'ghost', onclick: () => openFile(path) }, iconEl('file'), 'Open file'),
      state.conv?.changes.has(path) ? el('button', { class: 'ghost', onclick: () => revertChange(path) }, iconEl('undo'), 'Revert') : null
    );
  }
  renderTabs();
  renderCenter();
}

function showReview() {
  if (!state.review) return;
  state.review.visible = true;
  renderTabs();
  renderCenter();
}

function closeReview(force) {
  if (!state.review) return;
  if (!force && state.review.pending && state.review.cancelOnClose) {
    state.review.onDecide?.(false);
    return;
  }
  state.review = null;
  renderTabs();
  renderCenter();
}

function renderCenter() {
  const showRev = !!state.review?.visible;
  $('#review').classList.toggle('hidden', !showRev);
  $('#editor').classList.toggle('hidden', showRev || !state.active);
  $('#home').classList.toggle('hidden', showRev || !!state.active);
  if (!showRev && !state.active) renderHome();
}

// ===================================================================
// Home screen (shown when no file is open)
// ===================================================================
const QUICK_ACTIONS = [
  { icon: 'sparkles', title: 'Start from scratch', desc: 'Pick an app recipe (Python GUI, Electron, CLI wrapper), or just describe what to build.', recipes: true },
  { icon: 'book', title: 'Explain this project', desc: 'What it does, how it is organised and how to build it.', prompt: 'Give me an overview of this project: what it does, how it is structured, and how to build and run it.' },
  { icon: 'bug', title: 'Find bugs', desc: 'Review the code for likely bugs and risky spots.', prompt: 'Look through the main source files for likely bugs or risky code, and list the most important ones with file and line.' },
  { icon: 'wand', title: 'Add a feature', desc: 'Describe what you want and let Qwen build it.', prompt: 'Add this feature: ', fill: true },
  { icon: 'play', title: 'Build & run', desc: 'Work out the build steps and run them.', prompt: 'Figure out how to build this project on this machine, then build it and fix any errors.' }
];

function renderHome() {
  const home = $('#home');
  const inner = el('div', { class: 'home-inner' });
  if (!state.ws) {
    const recent = state.settings?.recentWorkspaces || [];
    inner.append(
      el('div', { class: 'hero' },
        el('span', { class: 'logo', text: 'Q' }),
        el('h1', { text: 'Qwen Workspace' }),
        el('p', { text: 'Open a project folder, or clone one from GitHub, then ask Qwen to build, fix or explain your code.' }),
        el('div', { class: 'hero-actions' },
          el('button', { class: 'primary', onclick: pickWorkspace }, iconEl('folderOpen'), 'Open Folder'),
          el('button', { class: 'ghost', onclick: cloneFlow }, iconEl('gitCommit'), 'Clone from GitHub')))
    );
    if (recent.length) {
      inner.append(
        el('div', { class: 'home-section' }, el('h3', { text: 'Recent' }),
          ...recent.map((p) => el('button', { class: 'recent-item', onclick: () => openWorkspace(p), title: p },
            iconEl('folder'), el('span', { class: 'name', text: baseName(p) }), el('span', { class: 'path', text: p }))))
      );
    }
  } else {
    inner.append(
      el('div', { class: 'proj-head' },
        el('div', { class: 'big-ico' }, iconEl('folder')),
        el('div', {}, el('h1', { text: state.ws.name }), el('div', { class: 'path', text: state.ws.root }))),
      el('div', { class: 'home-section' }, el('h3', { text: 'Ask Qwen' }),
        el('div', { class: 'actions-grid' },
          ...QUICK_ACTIONS.map((a) => el('button', { class: 'action-card', onclick: (e) => (a.recipes ? showRecipeMenu(e.currentTarget) : setPrompt(a.prompt, !a.fill)) },
            iconEl(a.icon), el('span', { class: 't', text: a.title }), el('span', { class: 'd', text: a.desc })))))
    );
    const workflows = el('div', { class: 'home-section' });
    inner.append(workflows);
    renderWorkflows(workflows);
    const changes = state.conv?.changes;
    if (changes?.size) {
      inner.append(el('div', { class: 'home-section' }, el('h3', { text: `Changed in this conversation (${changes.size})` }),
        ...[...changes].map(([p, ch]) => changeItem(p, ch))));
    }
    inner.append(
      el('div', { class: 'home-tips' },
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>P</kbd> go to file' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd> search' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>`</kbd> terminal' }),
        el('span', { html: '<kbd>Ctrl</kbd> <kbd>L</kbd> chat' }))
    );
  }
  home.replaceChildren(inner);
}

// The recipe picker in front of "Start from scratch": pick an app recipe that installs a
// working skeleton into a new folder, or Blank, which keeps the describe-it prompt.
async function showRecipeMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  let templates = [];
  try {
    templates = await api.templatesList();
  } catch {
    /* no templates dir */
  }
  const recipes = templates.filter((t) => t.kind === 'recipe');
  showMenu(r.left, r.top, [
    { label: 'Blank — just describe it', desc: 'Qwen asks questions and researches the toolchain.', icon: 'sparkles', onClick: () => setPrompt('Help me build this from scratch: ', false) },
    ...recipes.map((t) => ({ label: t.name, desc: t.description, icon: t.icon, onClick: () => newProjectFlow(t) }))
  ]);
}

// Choose a folder for the recipe (ideally empty), then install into it.
async function newProjectFlow(t) {
  const dir = await api.pickWorkspace();
  if (!dir) return;
  await openWorkspace(dir);
  if (!state.ws) return;
  const entries = await api.list('.').catch(() => []);
  if (entries.length && !confirm('This folder is not empty. Install the recipe into it anyway? Existing files are never overwritten.')) return;
  await applyRecipe(t);
}

// Install a recipe into the current workspace: files, git init, first commit, fresh chat.
async function applyRecipe(t) {
  let res;
  try {
    res = await api.templatesInstall(t.id);
  } catch (e) {
    return alert(cleanError(e));
  }
  state.fileIndex = null;
  if (await ensureGit()) {
    if (!(await isGitRepo())) await api.gitInit();
    await git('git add -A');
    await api.gitCommit(`chore: start from the ${t.name} recipe`);
  }
  newChat(); // the new conversation loads the recipe's QWEN.md and skill with its first message
  for (const c of state.convs.values()) c.memoryLoaded = false;
  renderTree();
  renderHome();
  refreshGitSync(false);
  showView('explorer');
  toast({
    icon: 'check',
    timeout: 20000,
    text: [el('b', { text: `${t.name} is ready.` }), ` ${res.written.length} files installed${res.skipped.length ? `, ${res.skipped.length} already existed` : ''}. ${t.then || ''}`]
  });
}

// Workflows are bundled starter trees (e.g. the software factory) installed into the project.
async function renderWorkflows(section) {
  let templates = [];
  try {
    templates = await api.templatesList();
  } catch {
    return;
  }
  templates = templates.filter((t) => t.kind !== 'recipe'); // recipes live in Start from scratch
  if (!templates.length || !state.ws) return;
  const installed = new Set();
  for (const t of templates) if (await api.exists(`.qwen/skills/${t.id === 'software-factory' ? 'factory' : t.id}`).catch(() => false)) installed.add(t.id);
  section.replaceChildren(
    el('h3', { text: 'Workflows' }),
    el('div', { class: 'actions-grid' }, ...templates.map((t) =>
      el('button', { class: 'action-card', title: t.description, onclick: () => installWorkflow(t) },
        iconEl(t.icon),
        el('span', { class: 't' }, t.name, installed.has(t.id) ? el('span', { class: 'tagb inst', text: 'Installed' }) : null),
        el('span', { class: 'd', text: t.description }))))
  );
}

async function installWorkflow(t) {
  if (!requireWorkspace()) return;
  let res;
  try {
    res = await api.templatesInstall(t.id);
  } catch (e) {
    return alert(cleanError(e));
  }
  for (const c of state.convs.values()) c.memoryLoaded = false; // skills list changed
  state.fileIndex = null;
  renderTree();
  renderHome();
  const added = res.written.length;
  toast({
    key: 'workflow',
    icon: 'check',
    text: added
      ? [el('b', { text: `${t.name} installed.` }), ` ${t.then || 'Ask Qwen to run it.'}`]
      : [el('b', { text: `${t.name} is already installed.` }), ` ${res.skipped.length} files were already there.`],
    actions: t.then && /run the factory/i.test(t.then)
      ? [{ label: 'Later' }, { label: 'Start a job', primary: true, onClick: () => setPrompt('run the factory: ', false) }]
      : [],
    timeout: 20000
  });
}

// ===================================================================
// Chat: attachments
// ===================================================================
function renderChips() {
  const box = $('#context-chips');
  const chips = [];
  if (state.active) {
    const sel = editor.getSelection();
    const hasSel = sel && !sel.isEmpty();
    chips.push(
      el('span', {
        class: `chip${state.attachCurrent ? '' : ' off'}`,
        title: state.attachCurrent ? 'The open file is attached. Click to detach.' : 'Click to attach the open file',
        onclick: () => {
          state.attachCurrent = !state.attachCurrent;
          renderChips();
        }
      }, fileBadge(baseName(state.active)), el('span', { class: 'label', text: `${baseName(state.active)}${hasSel ? ` · lines ${sel.startLineNumber}–${sel.endLineNumber}` : ''}` }))
    );
  }
  for (const p of extraAttachments) {
    if (p === state.active) continue;
    chips.push(
      el('span', { class: 'chip', title: p }, fileBadge(baseName(p)), el('span', { class: 'label', text: p }),
        el('button', { title: 'Remove', onclick: () => { extraAttachments.delete(p); renderChips(); } }, iconEl('x')))
    );
  }
  box.replaceChildren(...chips);
}

function addFileToChat(path) {
  extraAttachments.add(path);
  renderChips();
  $('#prompt').focus();
}

async function buildAttachments() {
  const parts = [];
  const names = [];
  const files = new Set(extraAttachments);
  if (state.active && state.attachCurrent) files.add(state.active);
  for (const p of files) {
    let text;
    const tab = findTab(p);
    try {
      text = tab ? tab.model.getValue() : await api.read(p);
    } catch {
      continue;
    }
    if (text.length > MAX_ATTACH) text = text.slice(0, MAX_ATTACH) + '\n... [truncated]';
    let block = `File: ${p}\n\`\`\`${langOf(p)}\n${text}\n\`\`\``;
    if (p === state.active) {
      const sel = editor.getSelection();
      if (sel && !sel.isEmpty()) {
        block += `\n\nThe user has selected lines ${sel.startLineNumber}-${sel.endLineNumber} of ${p}:\n\`\`\`${langOf(p)}\n${tab.model.getValueInRange(sel)}\n\`\`\``;
      }
    }
    parts.push(block);
    names.push(p);
  }
  extraAttachments.clear();
  return { text: parts.join('\n\n'), names };
}

function langOf(p) {
  const ext = p.split('.').pop();
  return { js: 'javascript', ts: 'typescript', py: 'python', rs: 'rust', cs: 'csharp', md: 'markdown', sh: 'bash', ps1: 'powershell' }[ext] || ext;
}

// ===================================================================
// Chat: tools (agent mode)
// ===================================================================
// Core tools go out with every request. Deferred tools are only named in the system prompt
// until tool_search loads their schemas, which keeps the tool list small for local models.
function renderConvModel() {
  const label = $('#conv-model-label');
  if (!label) return;
  // When the conversation has priced cloud spend, show it next to the model name.
  const { total, priced } = Costs.costUSD(state.conv?.spend, state.settings?.prices);
  label.textContent = convModelLabel(state.conv) + (priced && total > 0 ? ` · ${Costs.formatUSD(total)}` : '');
}

// Record one cloud response's tokens: on the conversation (for its badge) and on the
// monthly total in settings (so it survives a restart; written with a short debounce).
let spendFlushTimer = null;
let spendDirty = false;

// Write the monthly total to settings.json now (a task just ended, so make it durable).
function flushSpend() {
  if (!spendDirty) return;
  spendDirty = false;
  clearTimeout(spendFlushTimer);
  api.setSettings({ spend: state.settings.spend });
}

function recordSpend(c, model, inTok, outTok) {
  if (!inTok && !outTok) return;
  c.spend = c.spend || {};
  const cur = c.spend[model] || { in: 0, out: 0 };
  c.spend[model] = { in: (cur.in || 0) + inTok, out: (cur.out || 0) + outTok };
  state.settings.spend = Costs.addSpend(state.settings.spend, model, inTok, outTok);
  spendDirty = true;
  clearTimeout(spendFlushTimer);
  spendFlushTimer = setTimeout(flushSpend, 1500);
  renderCostStatus();
  if (c === state.conv) renderConvModel();
}

// The status-bar pill with this month's priced cloud spend; red once the cap is reached.
function renderCostStatus() {
  const pill = $('#sb-cost');
  if (!pill) return;
  const s = state.settings;
  const { total, priced } = Costs.costUSD(s.spend?.models, s.prices);
  const show = priced && total > 0;
  pill.classList.toggle('hidden', !show);
  if (!show) return;
  pill.classList.toggle('bad', Costs.capReached(s.spend, s.prices, s.monthlyCapUSD));
  pill.lastChild.textContent = `Cloud ${Costs.formatUSD(total)}`;
  const cap = Number(s.monthlyCapUSD) || 0;
  pill.title = `Cloud model spend in ${s.spend?.month || 'this month'}, from your price table${cap ? ` (budget ${Costs.formatUSD(cap)})` : ''}. Click for settings.`;
}

function setConvModel(c, choice) {
  c.modelChoice = choice === 'default' ? null : choice;
  saveConv(c);
  renderConvModel();
  flash(`This conversation runs on ${convModelLabel(c)}`);
}

async function showConvModelMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const c = state.conv;
  if (!c) return;
  const ch = c.modelChoice || 'default';
  const items = [{
    label: state.settings.model || '(no model set)',
    desc: `Default · ${state.settings.provider}`,
    icon: 'cpu',
    checked: ch === 'default',
    onClick: () => setConvModel(c, 'default')
  }];
  const h = state.settings.heavy;
  if (h?.enabled && h.model) {
    items.push({ label: h.model, desc: `Planner · ${h.provider}`, icon: 'sparkles', checked: ch === 'heavy', onClick: () => setConvModel(c, 'heavy') });
  }
  // Installed Ollama models, when the server answers quickly; skip ones already listed.
  try {
    const tags = await Promise.race([api.ollamaTags(), new Promise((res) => setTimeout(() => res(null), 800))]);
    if (tags?.running) {
      const shown = new Set([state.settings.model, h?.model]);
      for (const m of (tags.models || []).slice(0, 8)) {
        if (shown.has(m.name)) continue;
        items.push({ label: m.name, desc: 'Ollama (local)', icon: 'server', checked: ch?.model === m.name, onClick: () => setConvModel(c, { provider: 'ollama', model: m.name }) });
      }
    }
  } catch {
    /* Ollama not reachable; menu still works */
  }
  // With more than one Ollama node, show each node's reachability at a glance.
  if (state.settings.provider === 'ollama' && Nodes.multiNode(state.settings)) {
    refreshNodeHealth();
    for (const n of Nodes.normalizeNodes(state.settings).filter((x) => x.enabled)) {
      const hh = state.nodeHealth.byId[n.id];
      items.push({
        label: n.name,
        desc: hh?.up ? `Node online · ${(hh.models || []).length} models` : `Node offline${hh?.error ? ` · ${hh.error}` : ''}`,
        icon: hh?.up ? 'server' : 'alert',
        onClick: () => { openSettings(); selectSettingsPage('Ollama nodes'); }
      });
    }
  }
  items.push({ label: 'Model settings…', icon: 'settings', onClick: openSettings });
  showMenu(r.left, r.top, items, { above: true });
}

// ===================================================================
// Chat: conversation loop
// ===================================================================
function setPrompt(text, sendNow) {
  const input = $('#prompt');
  input.value = text;
  autoGrow();
  input.focus();
  input.setSelectionRange(text.length, text.length);
  if (sendNow) send();
}

function stopChat(c = state.conv) {
  if (!c?.busy) return;
  c.stopRequested = true;
  if (c.chatId) api.chatAbort(c.chatId);
  c.pendingApproval?.finish(false);
  c.pendingQuestion?.cancel();
}

function setBusy(c, b) {
  c.busy = b;
  if (b) {
    c.stopRequested = false;
    c.status = 'running';
  } else {
    c.activity = '';
  }
  c.updatedAt = Date.now();
  if (c === state.conv) renderRunControls();
  renderHistory();
}

function setActivity(c, text) {
  c.activity = text;
  if (c === state.conv) renderRunControls();
}

function renderRunControls() {
  const c = state.conv;
  const asking = !!c?.pendingQuestion;
  $('#btn-send').classList.toggle('hidden', !!c?.busy && !asking);
  $('#btn-stop').classList.toggle('hidden', !c?.busy);
  $('#prompt').placeholder = asking ? 'Type your answer to Qwen\'s question…' : 'Ask Qwen to build, fix or explain something…';
  const text = c?.busy ? c.activity : '';
  $('#activity').classList.toggle('hidden', !text);
  $('#activity-text').textContent = text ? `${text}…` : '';
}

function updateCtxMeter() {
  const m = $('#ctx-meter');
  const c = state.conv;
  if (!c?.history.length) {
    m.classList.add('hidden');
    return;
  }
  const { tokens, window: size, measured } = contextUse(c);
  const pct = Math.min(100, Math.round((tokens / size) * 100));
  m.classList.remove('hidden');
  m.classList.toggle('warn', pct >= 70 && pct < 95);
  m.classList.toggle('full', pct >= 95);
  m.querySelector('i').style.width = `${pct}%`;
  m.querySelector('.txt').textContent = `${measured ? '' : '~'}${pct}%`;
  m.title = `Context used: ${measured ? '' : 'about '}${tokens.toLocaleString()} of ${size.toLocaleString()} tokens. Older messages are summarized automatically at ${Math.round(COMPACT_AT * 100)}%. Click to summarize now.`;
}

// ---------- compaction ----------
// When the conversation nears the context window, older turns are replaced by a summary the
// model writes, keeping the system prompt and the most recent turns verbatim.
function renderTodoBar() {
  const bar = $('#todo-bar');
  const todos = state.conv?.todos || [];
  if (!todos.length) {
    bar.classList.add('hidden');
    return;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  bar.classList.remove('hidden');
  bar.replaceChildren(
    el('div', { class: 'todo-head', onclick: () => bar.classList.toggle('open') },
      iconEl('list'), el('span', { class: 'todo-title', text: `Plan · ${done}/${todos.length}` }),
      el('span', { class: 'todo-current', text: current ? current.content : done === todos.length ? 'All done' : '' }),
      iconEl('chevronDown', 'chev')),
    el('ul', { class: 'todo-list' }, ...todos.map((t) => el('li', { class: t.status }, iconEl(t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'play' : 'stop'), el('span', { text: t.content }))))
  );
}

function stripThink(s) {
  return (s || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

// ===================================================================
// Chat: rendering
// ===================================================================
const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }) {
  const info = (lang || '').trim().split(/\s+/);
  const language = info[0] || '';
  const filePath = info.slice(1).join(' ').replace(/^(path|file)=/, '');
  return `<pre data-lang="${escapeHtml(language)}" data-path="${escapeHtml(filePath)}"><code>${escapeHtml(text)}</code></pre>`;
};
// Models often write tags like <tool_call> or <vector> in prose; show them as text instead of
// letting the sanitizer silently delete them.
renderer.html = ({ text }) => escapeHtml(text);
marked.setOptions({ renderer, gfm: true, breaks: false });

function renderMarkdown(node, text) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ['style', 'form', 'input'] });
  node.querySelectorAll('pre').forEach(decorateCodeBlock);
}

function decorateCodeBlock(pre) {
  const code = pre.querySelector('code');
  const text = code ? code.textContent : pre.textContent;
  const lang = pre.dataset.lang || '';
  const filePath = pre.dataset.path || '';
  const label = el('span', { class: 'label' });
  if (filePath) label.append(fileBadge(baseName(filePath)), el('span', { text: filePath }));
  else label.textContent = lang || 'code';
  const head = el('div', { class: 'cb-head' }, label,
    el('button', {
      title: 'Copy to clipboard',
      onclick: async (e) => {
        await navigator.clipboard.writeText(text);
        const b = e.currentTarget;
        b.lastChild.textContent = 'Copied';
        setTimeout(() => (b.lastChild.textContent = 'Copy'), 1200);
      }
    }, iconEl('copy'), el('span', { text: 'Copy' })),
    el('button', {
      title: 'Insert at the cursor (or replace the selection) in the open file',
      onclick: () => {
        if (!state.active) return alert('Open a file first.');
        editor.executeEdits('qwen', [{ range: editor.getSelection(), text, forceMoveMarkers: true }]);
        editor.focus();
      }
    }, iconEl('insert'), 'Insert'),
    filePath && state.ws ? el('button', { class: 'apply', title: `Write this code to ${filePath} (shows a diff first)`, onclick: () => applyCodeToFile(normPath(filePath), text) }, iconEl('check'), 'Apply') : null
  );
  const wrap = el('div', { class: 'codeblock' });
  pre.replaceWith(wrap);
  wrap.append(head, pre);
  const monLang = monacoLang(lang);
  if (code && monLang) {
    monaco.editor.colorize(text, monLang, { tabSize: 2 }).then((html) => {
      code.innerHTML = html;
    });
  }
}

function monacoLang(lang) {
  if (!lang) return null;
  const l = lang.toLowerCase();
  const alias = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', rs: 'rust', yml: 'yaml', md: 'markdown', vue: 'html', golang: 'go', kt: 'kotlin', rb: 'ruby', bat: 'bat', cmd: 'bat' };
  const id = alias[l] || l;
  return monaco.languages.getLanguages().some((x) => x.id === id) ? id : null;
}

async function applyCodeToFile(p, content) {
  const exists = await api.exists(p);
  const original = exists ? findTab(p)?.model.getValue() ?? (await api.read(p)) : null;
  const c = state.conv;
  const ok = await new Promise((resolve) => {
    const onDecide = (v) => {
      closeReview(true);
      resolve(v);
    };
    openReview({ path: p, original: original ?? '', modified: content, pending: true, title: `${exists ? 'Apply changes to' : 'Create'} ${p}`, onDecide, cancelOnClose: true });
  });
  if (!ok) return;
  await api.write(p, content);
  syncOpenTab(p, content);
  recordChange(c, p, original, content);
  expandTo(p);
  state.fileIndex = null;
  await renderTree();
  await openFile(p);
  highlightChanges(p, original, content);
  flash(`Wrote ${p}`);
}

function addUserMessage(c, text, attached) {
  c.display.push({ t: 'user', text, attached });
  c.updatedAt = Date.now();
  renderUserMessage(c, text, attached);
}

function renderUserMessage(c, text, attached) {
  const node = el('div', { class: 'msg user' }, text);
  if (attached.length) node.append(el('div', { class: 'attached' }, ...attached.map((a) => el('span', { text: baseName(a), title: a }))));
  c.container.append(node);
  scrollChat(c, true);
}

function addError(c, text, usedTools) {
  let hint = '';
  if (usedTools && /tool|function/i.test(text)) {
    hint = '\n\nThis model may not support tool calling. Switch to "Chat" below the message box, or pick a tool-capable model such as qwen2.5-coder, qwen3 or qwen3-coder.';
  } else if (/connect|ECONNREFUSED|fetch failed/i.test(text)) {
    hint = `\n\nCheck Settings: is the base URL right and is the server running? For Ollama run "ollama serve" and "ollama pull ${state.settings.model}".`;
  } else if (/402|more credits|requires more|insufficient|quota|billing/i.test(text)) {
    hint = '\n\nYour provider account is out of credit for a request this size. Add credits (e.g. openrouter.ai/settings/credits), or lower "Max response tokens" in Settings so each reply reserves less.';
  } else if (/401|403|api key|unauthorized/i.test(text)) {
    hint = '\n\nCheck the API key in Settings.';
  }
  c.display.push({ t: 'error', text: text + hint });
  renderError(c, text + hint);
}

function renderNotice(c, item) {
  const node = el('div', { class: 'msg notice' }, iconEl('history'), el('span', { text: item.text }));
  if (item.detail) node.append(el('details', {}, el('summary', { text: 'Show summary' }), el('div', { class: 'notice-detail', text: item.detail })));
  c.container.append(node);
  scrollChat(c, true);
}

function renderError(c, text) {
  c.container.append(el('div', { class: 'msg error' }, iconEl('alert'), el('div', { text })));
  scrollChat(c, true);
}

// `item` is the saved display entry when restoring; otherwise a new one is recorded.
function addAssistantMessage(c, item, modelLabel) {
  const restoring = !!item;
  if (!item) {
    item = { t: 'assistant', content: '', reasoning: '', hasCalls: false, steps: [] };
    if (modelLabel) item.modelLabel = modelLabel;
    c.display.push(item);
  }
  const think = el('details', { class: 'think hidden' }, el('summary', {}, iconEl('chevronRight'), el('span', { class: 'think-label', text: 'Thinking' })), el('div', { class: 'think-body' }));
  const md = el('div', { class: `md${restoring ? '' : ' cursor'}` });
  const steps = el('div', { class: 'steps' });
  const badge = (item.modelLabel || modelLabel)
    ? [el('div', { class: 'model-badge' }, iconEl('sparkles'), el('span', { text: item.modelLabel || modelLabel }))]
    : [];
  const escalateBtn = el('button', {
    class: 'icon-btn msg-escalate',
    title: 'Escalate: re-run from this point on the planner model',
    onclick: () => escalateFrom(c, item)
  }, iconEl('sparkles'));
  c.container.append(el('div', { class: 'msg assistant' }, ...badge, think, md, steps, escalateBtn));
  scrollChat(c, true);

  let content = '';
  let reasoning = '';
  let pending = false;

  const draw = () => {
    pending = false;
    // Split inline <think> blocks (Qwen3 / QwQ) out of the visible answer.
    let inlineThink = '';
    let visible = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
      inlineThink += t;
      return '';
    });
    const cut = textToolCallStart(visible);
    if (cut >= 0) visible = visible.slice(0, cut);
    const allThink = (reasoning + inlineThink).trim();
    if (allThink) {
      think.classList.remove('hidden');
      think.querySelector('.think-body').textContent = allThink;
    }
    renderMarkdown(md, visible.trim());
    scrollChat(c);
  };
  const schedule = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(draw);
    }
  };

  return {
    appendContent(t) {
      content += t;
      schedule();
    },
    appendReasoning(t) {
      reasoning += t;
      schedule();
    },
    setContent(t) {
      content = t;
      item.content = t;
      schedule();
    },
    setFinal(cText, r) {
      content = cText;
      reasoning = r;
      item.content = cText;
      item.reasoning = r;
      schedule();
    },
    finish(hasCalls) {
      draw();
      item.hasCalls = !!hasCalls;
      md.classList.remove('cursor');
      md.classList.toggle('narration', !!hasCalls);
      think.querySelector('.think-label').textContent = 'Thought process';
    },
    addStep(call, stepItem) {
      if (!stepItem) {
        stepItem = { call, status: 'running' };
        item.steps.push(stepItem);
      }
      return makeStepRow(c, steps, call, stepItem);
    }
  };
}

function makeStepRow(c, container, call, rec) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    /* shown raw below */
  }
  const name = call.function.name;
  const info = TOOL_INFO[name] || (name.startsWith('mcp__')
    ? { icon: 'plug', verb: mcpServerOf(name), doing: `Running ${mcpServerOf(name)}` }
    : { icon: 'sparkles', verb: name, doing: 'Running' });
  const d = describeCall(name, args);
  const body = el('pre');
  const meta = el('span', { class: 'step-meta' });
  const stateEl = el('span', { class: 'step-state' }, el('span', { class: 'spinner' }));
  const verb = el('span', { class: 'step-verb', text: info.verb });
  const target = el('span', { class: `step-target${d.mono ? ' mono' : ''}${d.path ? ' link' : ''}`, text: d.target, title: d.title || d.target });
  const head = el('div', { class: 'step-head' }, iconEl(info.icon), verb, target, meta, stateEl, iconEl('chevronRight', 'chev'));
  const row = el('div', { class: 'step running' }, head, el('div', { class: 'step-body' }, body));
  let onTarget = d.path ? () => openFile(d.path, { preview: true }) : null;
  target.addEventListener('click', (e) => {
    if (onTarget) {
      e.stopPropagation();
      onTarget();
    }
  });
  head.onclick = () => row.classList.toggle('open');
  container.append(row);
  scrollChat(c);

  const setBody = (text) => {
    rec.body = text.length > 4000 ? text.slice(0, 4000) + '\n…' : text;
    rec.diff = false;
    body.textContent = text.length > 8000 ? text.slice(0, 8000) + '\n…' : text;
  };
  const setDiffBody = (diffText) => {
    rec.body = diffText.length > 8000 ? diffText.slice(0, 8000) : diffText;
    rec.diff = true;
    renderDiffPreview(body, diffText);
  };
  const setVerb = (v) => {
    rec.verb = v;
    verb.textContent = v;
  };
  const linkToChange = (path) => {
    rec.changePath = path;
    onTarget = () => openChangeReview(path);
    target.classList.add('link');
  };
  const linkToUrl = (url) => {
    rec.url = url;
    onTarget = () => api.openExternal(url);
    target.classList.add('link');
    target.title = url;
  };
  const showResult = (failed, metaText, metaHtml) => {
    row.classList.remove('running', 'waiting');
    row.classList.add(failed ? 'bad' : 'ok');
    stateEl.innerHTML = icon(failed ? 'x' : 'check');
    if (metaHtml) meta.innerHTML = metaHtml;
    else meta.textContent = metaText || '';
  };

  return {
    doing: info.doing,
    target: d.target,
    setBody,
    setDiffBody,
    setVerb,
    linkToChange,
    linkToUrl,
    done(out) {
      const failed = out.failed || /^Error/.test(out.result) || out.rejected || /^Cancelled/.test(out.result);
      const metaText = out.rejected ? 'rejected' : /^Error/.test(out.result) ? 'failed' : out.meta || '';
      Object.assign(rec, { status: failed ? 'bad' : 'ok', meta: metaText, metaHtml: out.metaHtml || null });
      showResult(failed, metaText, out.metaHtml);
      if (/^Error/.test(out.result)) {
        setBody(out.result);
        stateEl.title = out.result;
      }
    },
    // Shows a saved step as it ended.
    restore() {
      if (rec.verb) verb.textContent = rec.verb;
      if (rec.body) (rec.diff ? renderDiffPreview(body, rec.body) : (body.textContent = rec.body));
      if (rec.changePath) linkToChange(rec.changePath);
      if (rec.url) linkToUrl(rec.url);
      if (rec.status === 'running') showResult(true, 'interrupted');
      else showResult(rec.status === 'bad', rec.meta, rec.metaHtml);
    },
    // Shows Qwen's questions; resolves with one answer per question, or null if skipped.
    askUser(questions) {
      row.classList.remove('running');
      row.classList.add('waiting');
      stateEl.innerHTML = icon('alert');
      return new Promise((resolve) => {
        const inputs = questions.map(() => el('input', { class: 'ask-input', placeholder: 'Your answer', spellcheck: 'true' }));
        const card = el('div', { class: 'step-approval ask-card' });
        const finish = (answers) => {
          if (c.pendingQuestion?.finish !== finish) return;
          c.pendingQuestion = null;
          card.remove();
          row.classList.remove('waiting');
          row.classList.add('running');
          stateEl.replaceChildren(el('span', { class: 'spinner' }));
          setActivity(c, answers ? 'Working' : '');
          renderRunControls();
          renderHistory();
          resolve(answers);
        };
        const submit = () => finish(inputs.map((i) => i.value.trim()));
        questions.forEach((q, i) => {
          inputs[i].addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const next = inputs.find((x) => !x.value.trim());
            if (next) next.focus();
            else submit();
          });
          card.append(
            el('div', { class: 'q', text: q.question }),
            ...(q.options.length ? [el('div', { class: 'ask-options' }, ...q.options.map((o) =>
                el('button', {
                  class: 'chip-btn',
                  onclick: (e) => {
                    inputs[i].value = o;
                    e.currentTarget.parentElement.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
                    if (questions.length === 1) submit();
                  }
                }, o)))] : []),
            inputs[i]
          );
        });
        card.append(el('div', { class: 'btns' },
          el('button', { class: 'ghost', title: 'Let Qwen continue with its own assumptions', onclick: () => finish(null) }, 'Skip'),
          el('button', { class: 'primary', onclick: submit }, iconEl('arrowUp'), 'Send answers')));
        c.pendingQuestion = {
          finish,
          cancel: () => finish(null),
          // Text typed in the message box answers the first unanswered question.
          answer: (text) => {
            const target = inputs.find((x) => !x.value.trim()) || inputs[0];
            target.value = text;
            if (inputs.every((x) => x.value.trim())) submit();
            else inputs.find((x) => !x.value.trim())?.focus();
          }
        };
        setActivity(c, 'Waiting for your answer');
        renderRunControls();
        renderHistory();
        row.append(card);
        scrollChat(c, true);
        if (c === state.conv) inputs[0].focus({ preventScroll: true });
      });
    },
    requestApproval(opts) {
      row.classList.remove('running');
      row.classList.add('waiting');
      stateEl.innerHTML = icon('alert');
      return new Promise((resolve) => {
        const bar = el('div', { class: 'step-approval' });
        const finish = (v) => {
          if (c.pendingApproval?.finish !== finish) return;
          c.pendingApproval = null;
          bar.remove();
          row.classList.remove('waiting');
          row.classList.add('running');
          stateEl.replaceChildren(el('span', { class: 'spinner' }));
          if (state.review?.onDecide === finish) closeReview(true);
          setActivity(c, v ? 'Working' : '');
          renderHistory();
          resolve(v);
        };
        c.pendingApproval = { finish };
        setActivity(c, 'Waiting for your approval');
        renderHistory();
        const review = () => openReview({ path: opts.path, original: opts.original, modified: opts.modified, pending: true, title: opts.question, onDecide: finish });
        if (opts.kind === 'edit') {
          // Per-block accept/reject (ported from qws): each contiguous change is a checkbox;
          // "Apply selected" composes exactly the ticked blocks onto disk.
          const blocks = opts.allowPartial ? diffSegments(opts.original, opts.modified) : null;
          const boxes = [];
          const strip = blocks && blocks.length > 1
            ? el('div', { class: 'block-strip' }, ...blocks.map((blk) => {
                const box = el('input', { type: 'checkbox', checked: true });
                boxes.push(box);
                return el('label', { class: 'block-chip', title: `-${blk.oldLines.length} +${blk.newLines.length} lines` }, box, `@${blk.startLine}`);
              }))
            : null;
          const applySelected = () => {
            const accepted = new Set(boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0));
            if (!accepted.size) return finish(false);
            if (accepted.size === blocks.length) return finish(true);
            finish({ content: applyBlocks(opts.original, opts.modified, accepted) });
          };
          bar.append(
            el('div', { class: 'q' }, el('span', { text: opts.question }), el('span', { class: 'stats', html: statsHtml(opts.stats) })),
            ...(strip ? [strip] : []),
            el('div', { class: 'btns' },
              el('button', { class: 'ghost', onclick: review }, iconEl('columns'), 'Review'),
              el('button', { class: 'ghost danger-text', onclick: () => finish(false) }, 'Reject'),
              ...(strip ? [el('button', { class: 'ghost', title: 'Write only the ticked blocks', onclick: applySelected }, iconEl('check'), 'Apply selected')] : []),
              el('button', { class: 'primary', onclick: () => finish(true) }, iconEl('check'), 'Approve all'))
          );
          if (state.settings.followAgent && c === state.conv) review();
        } else if (opts.kind === 'mcp') {
          let argText = opts.args || '{}';
          try {
            argText = JSON.stringify(JSON.parse(opts.args || '{}'), null, 2);
          } catch {
            /* show raw */
          }
          bar.append(
            el('div', { class: 'q' }, el('span', { text: opts.question })),
            el('div', { class: 'cmd', text: argText }),
            el('div', { class: 'btns' },
              el('button', { class: 'ghost danger-text', onclick: () => finish(false) }, 'Reject'),
              el('button', { class: 'ghost', title: `Run ${opts.tool} and future "${opts.server}" tools without asking`, onclick: async () => { await allowCommandPrefix(`mcp__${opts.server}__`); finish(true); } }, `Always allow “${opts.server}”`),
              el('button', { class: 'primary', onclick: () => finish(true) }, iconEl('play'), 'Run'))
          );
        } else {
          const prefix = commandPrefix(opts.command);
          bar.append(
            el('div', { class: 'q' }, el('span', { text: opts.dangerous ? 'This command could delete or overwrite things. Run it?' : opts.question })),
            el('div', { class: 'cmd', text: opts.command }),
            el('div', { class: 'btns' },
              el('button', { class: 'ghost danger-text', onclick: () => finish(false) }, 'Reject'),
              opts.dangerous ? null : el('button', { class: 'ghost', title: `Run this, and run future "${prefix}" commands without asking`, onclick: async () => { await allowCommandPrefix(prefix); finish(true); } }, `Always allow “${prefix}”`),
              el('button', { class: 'primary', onclick: () => finish(true) }, iconEl('play'), 'Run'))
          );
        }
        row.append(bar);
        scrollChat(c, true);
        if (c === state.conv) bar.querySelector('button.primary').focus({ preventScroll: true });
      });
    }
  };
}

function renderDiffPreview(pre, diffText) {
  pre.replaceChildren(
    ...diffText.split('\n').slice(0, 400).map((line) =>
      el('div', { class: `diff-line${line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' hunk' : ''}`, text: line || ' ' }))
  );
}

function scrollChat(c, force) {
  if (c !== state.conv) return;
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
}

// ===================================================================
// Diffs
// ===================================================================
// Line-based LCS diff with common prefix/suffix trimmed, so big files with small edits stay cheap.
// Returns [op, line, indexInA, indexInB] entries, or null when the changed region is too large.
// diffOps/diffStats/unifiedDiff/diffSegments/applyBlocks live in diffblocks.js (pure,
// unit-tested); as a classic script it already defines them as globals.

// ===================================================================
// Terminal
// ===================================================================
function showTerminal(show, focus = true) {
  $('#terminal').classList.toggle('hidden', !show);
  $('#act-terminal').classList.toggle('active', show);
  if (show && focus) $('#term-in').focus();
  saveLayout();
}
function termWrite(text, cls) {
  const out = $('#term-out');
  out.append(el('span', { class: cls, text }));
  out.scrollTop = out.scrollHeight;
}
api.onCommandOutput((t) => termWrite(t));

async function runTerminalCommand(cmd) {
  if (!requireWorkspace()) return;
  termWrite(`\n❯ ${cmd}\n`, 'term-cmd');
  $('#term-in').disabled = true;
  const r = await api.runCommand(cmd, 10 * 60_000);
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  $('#term-in').disabled = false;
  $('#term-in').focus();
  state.fileIndex = null;
  renderTree();
}

// ===================================================================
// Go to file (Ctrl+P) / attach file
// ===================================================================
async function openQuick(mode = 'open') {
  if (!requireWorkspace()) return;
  state.quick = { mode, items: [], sel: 0 };
  const input = $('#quick-input');
  input.value = '';
  input.placeholder = mode === 'attach' ? 'Attach a file to your next message…' : 'Go to file…';
  $('#quick-modal').classList.remove('hidden');
  input.focus();
  if (!state.fileIndex) {
    $('#quick-list').replaceChildren(el('div', { class: 'quick-empty', text: 'Indexing files…' }));
    const r = await api.listRecursive('.', 20000, 20);
    state.fileIndex = r.files.filter((f) => !f.endsWith('/'));
  }
  renderQuick();
}

function fuzzyScore(path, q) {
  if (!q) return 1;
  const lower = path.toLowerCase();
  const name = baseName(lower);
  if (name.includes(q)) return 1000 - name.length + (name.startsWith(q) ? 200 : 0);
  if (lower.includes(q)) return 500 - lower.length / 10;
  let pi = 0;
  let score = 0;
  for (const ch of q) {
    const found = lower.indexOf(ch, pi);
    if (found < 0) return -1;
    score += found === pi ? 3 : 1;
    pi = found + 1;
  }
  return score;
}

function renderQuick() {
  const q = $('#quick-input').value.trim().toLowerCase().replace(/\\/g, '/');
  const items = (state.fileIndex || [])
    .map((p) => [p, fuzzyScore(p, q)])
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60)
    .map(([p]) => p);
  state.quick.items = items;
  state.quick.sel = Math.min(state.quick.sel, Math.max(0, items.length - 1));
  const list = $('#quick-list');
  if (!items.length) {
    list.replaceChildren(el('div', { class: 'quick-empty', text: 'No matching files.' }));
    return;
  }
  list.replaceChildren(...items.map((p, i) =>
    el('div', { class: `qi${i === state.quick.sel ? ' sel' : ''}`, onmousedown: (e) => { e.preventDefault(); chooseQuick(i); } },
      fileBadge(baseName(p)), el('span', { class: 'name', text: baseName(p) }), el('span', { class: 'dir', text: parentDir(p) === '.' ? '' : parentDir(p) }))));
  list.querySelector('.qi.sel')?.scrollIntoView({ block: 'nearest' });
}

function chooseQuick(i) {
  const p = state.quick.items[i];
  closeQuick();
  if (!p) return;
  if (state.quick.mode === 'attach') addFileToChat(p);
  else openFile(p);
}

function closeQuick() {
  $('#quick-modal').classList.add('hidden');
}

// ===================================================================
// Settings & status bar
// ===================================================================
function applySettingsToUi() {
  const s = state.settings;
  $('#model-name').textContent = s.model || 'no model';
  renderConvModel();
  editor?.updateOptions({ fontSize: Number(s.fontSize) || 14 });
  reviewEditor?.updateOptions({ fontSize: Number(s.fontSize) || 14 });
  $$('#mode-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.mode === 'agent') === !!s.agentMode));
  const mode = approvalMode();
  const btn = $('#btn-approval');
  btn.className = `mode-btn ${mode}`;
  btn.firstElementChild.innerHTML = icon(APPROVAL_MODES[mode].icon);
  $('#approval-label').textContent = APPROVAL_MODES[mode].label;
  btn.title = `Approvals: ${APPROVAL_MODES[mode].desc}`;
  btn.classList.toggle('hidden', !s.agentMode);
  syncNodeRouting();
  renderCostStatus();
  renderStatusbar();
}

// ---------- Ollama nodes: health checks and the status pill ----------
// Routing only wakes up when more than one node is enabled; with the implicit single
// "This PC" node there are no checks, no timer and no pill — exactly the old behavior.
let nodeTimer = null;

async function refreshNodeHealth(force) {
  const s = state.settings;
  if (!s || s.provider !== 'ollama' || !Nodes.multiNode(s)) return state.nodeHealth;
  if (!force && Date.now() - state.nodeHealth.at < 25_000) return state.nodeHealth;
  const nodes = Nodes.normalizeNodes(s);
  const results = await api.nodesCheck(nodes.map((n) => ({ id: n.id, baseUrl: n.baseUrl }))).catch(() => []);
  state.nodeHealth = { at: Date.now(), byId: Object.fromEntries(results.map((r) => [r.id, r])) };
  renderNodeStatus();
  return state.nodeHealth;
}

function syncNodeRouting() {
  const on = state.settings?.provider === 'ollama' && Nodes.multiNode(state.settings);
  clearInterval(nodeTimer);
  nodeTimer = null;
  if (on) {
    nodeTimer = setInterval(() => refreshNodeHealth(true), 60_000);
    refreshNodeHealth(true);
  }
  renderNodeStatus();
}

function renderNodeStatus() {
  const pill = $('#sb-nodes');
  if (!pill) return;
  const s = state.settings;
  const on = s?.provider === 'ollama' && Nodes.multiNode(s);
  pill.classList.toggle('hidden', !on);
  if (!on) return;
  const sum = Nodes.summarize(Nodes.normalizeNodes(s), state.nodeHealth.byId);
  pill.classList.toggle('bad', sum.up < sum.total);
  pill.lastChild.textContent = `Nodes ${sum.up}/${sum.total}`;
  pill.title = `Ollama nodes (click for settings)\n${sum.detail}`;
}

function renderStatusbar() {
  $('#folder-name').textContent = state.ws ? state.ws.name : 'Open a folder';
  $('#sb-folder-name').textContent = state.ws ? state.ws.root : 'No folder';
  $('#sb-follow').classList.toggle('on', !!state.settings?.followAgent);
  $('#sb-follow').title = state.settings?.followAgent
    ? 'Follow Qwen is on: the editor opens files as Qwen reads and edits them. Click to turn off.'
    : 'Follow Qwen is off. Click to open files in the editor as Qwen reads and edits them.';
}

function renderCursor() {
  const model = editor?.getModel();
  if (!model || !state.active) {
    $('#sb-cursor').textContent = '';
    $('#sb-lang').textContent = '';
    return;
  }
  const pos = editor.getPosition();
  $('#sb-cursor').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : '';
  const lang = monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId());
  $('#sb-lang').textContent = lang?.aliases?.[0] || model.getLanguageId();
}

let flashTimer = null;
function flash(text) {
  $('#sb-status').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => ($('#sb-status').textContent = ''), 3500);
}

function showApprovalMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const current = approvalMode();
  const items = Object.entries(APPROVAL_MODES).map(([key, m]) => ({
    label: m.label,
    desc: m.desc,
    icon: m.icon,
    checked: key === current,
    onClick: async () => {
      state.settings = await api.setSettings({ approvalMode: key });
      applySettingsToUi();
      flash(`Approvals: ${m.label}`);
    }
  }));
  showMenu(r.left, r.top, items, { above: true });
}

function showAttachMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.left, r.top, [
    { label: 'Attach a file…', icon: 'search', detail: 'Ctrl+Shift+A', onClick: () => openQuick('attach') },
    state.active ? { label: `Attach open file (${baseName(state.active)})`, icon: 'paperclip', checked: state.attachCurrent, onClick: () => { state.attachCurrent = !state.attachCurrent; renderChips(); } } : null
  ].filter(Boolean), { above: true });
}

// Splits a server command line into command + args, respecting simple quotes. A value that
// looks like a URL becomes an http transport instead.
// ===================================================================
// Toasts
// ===================================================================
// text: string, node, or an array of them. Each action closes the toast unless `keep` is set.
function toast({ text, icon: ic = 'info', actions = [], timeout = 0, key }) {
  if (key) $(`#toasts .toast[data-key="${key}"]`)?.remove();
  const node = el('div', { class: 'toast', dataset: key ? { key } : {} });
  const close = () => node.remove();
  node.append(
    el('div', { class: 't-main' }, iconEl(ic), el('div', { class: 't-text' }, text), el('button', { class: 'icon-btn t-close', title: 'Dismiss', onclick: close }, iconEl('x'))),
    actions.length
      ? el('div', { class: 't-actions' }, ...actions.map((a) =>
        el('button', { class: a.primary ? 'primary' : 'ghost', onclick: () => { if (!a.keep) close(); a.onClick?.(); } }, a.label)))
      : null
  );
  $('#toasts').append(node);
  if (timeout) setTimeout(close, timeout);
  return { close };
}

// ===================================================================
// Updates
// ===================================================================
const KIND_TEXT = {
  installer: 'Installed version: updates download and install inside the app.',
  portable: 'Portable version: updates open the download page.',
  zip: 'Zip version: updates open the download page.',
  dev: 'Running from source: update with git pull.'
};

async function initMcp() {
  try {
    state.mcp = await api.mcpList();
  } catch {
    state.mcp = [];
  }
  renderMcpStatus();
  api.onMcpChanged((list) => {
    state.mcp = list;
    renderMcpStatus();
    if (!$('#settings-modal').classList.contains('hidden')) renderMcpSettings();
  });
}

// A small indicator in the status bar: how many MCP servers are connected, and any errors.
function renderMcpStatus() {
  const el2 = $('#sb-mcp');
  if (!el2) return;
  const ready = state.mcp.filter((s) => s.status === 'ready');
  const errored = state.mcp.filter((s) => s.status === 'error' || s.status === 'disconnected');
  if (!state.mcp.length) {
    el2.classList.add('hidden');
    return;
  }
  el2.classList.remove('hidden');
  el2.classList.toggle('bad', errored.length > 0);
  const tools = ready.reduce((n, s) => n + s.tools.length, 0);
  el2.lastChild.textContent = errored.length ? `MCP: ${errored.length} failed` : `MCP: ${ready.length} server${ready.length === 1 ? '' : 's'} · ${tools} tools`;
  el2.title = state.mcp.map((s) => `${s.id}: ${s.status}${s.error ? ` — ${s.error}` : ` (${s.tools.length} tools)`}`).join('\n');
}

async function initUpdates() {
  state.appInfo = await api.appInfo();
  api.onUpdateProgress((p) => {
    state.update.percent = p.percent || 0;
    renderUpdateUi();
  });
  if (state.settings.autoCheckUpdates && state.appInfo.kind !== 'dev') {
    setTimeout(() => checkUpdates(false), 6000);
    setInterval(() => checkUpdates(false), 6 * 60 * 60 * 1000);
  }
}

async function checkUpdates(manual) {
  if (['checking', 'downloading', 'ready'].includes(state.update.phase)) return;
  state.update.phase = 'checking';
  renderUpdateUi();
  try {
    const info = await api.checkForUpdate();
    state.update.info = info;
    state.update.phase = info.available ? 'available' : 'current';
    if (info.available && !manual) warnOnce(`update:${info.latest}`, showUpdateToast);
  } catch (e) {
    state.update.phase = 'error';
    state.update.error = cleanError(e);
  }
  renderUpdateUi();
}

function showUpdateToast() {
  const info = state.update.info;
  toast({
    key: 'update',
    icon: 'download',
    text: [el('b', { text: `Qwen Workspace ${info.latest} is available.` }), ` You have ${info.current}.`],
    actions: [
      { label: "What's new", keep: true, onClick: () => api.openExternal(info.url) },
      { label: 'Later' },
      { label: info.canInstall ? 'Update now' : 'Download', primary: true, onClick: startUpdate }
    ]
  });
}

async function startUpdate() {
  const info = state.update.info;
  if (!info?.available) return;
  if (!info.canInstall) {
    await api.downloadUpdate();
    flash('Opened the download page');
    return;
  }
  state.update.phase = 'downloading';
  state.update.percent = 0;
  renderUpdateUi();
  try {
    await api.downloadUpdate();
    state.update.phase = 'ready';
    renderUpdateUi();
    toast({
      key: 'update',
      icon: 'download',
      text: [el('b', { text: `Update ${info.latest} is ready.` }), ' Restart to finish, or it installs when you close the app.'],
      actions: [{ label: 'Later' }, { label: 'Restart now', primary: true, onClick: () => api.installUpdate() }]
    });
  } catch (e) {
    state.update.phase = 'available';
    renderUpdateUi();
    toast({
      key: 'update',
      icon: 'alert',
      text: `The update couldn't be downloaded: ${cleanError(e)}`,
      actions: [{ label: 'Open download page', primary: true, onClick: () => api.openExternal(info.url) }]
    });
  }
}

function onUpdateButton() {
  const u = state.update;
  if (u.phase === 'available') startUpdate();
  else if (u.phase === 'ready') api.installUpdate();
  else checkUpdates(true);
}

function renderUpdateUi() {
  const u = state.update;
  const pct = Math.round(u.percent || 0);
  $('#sb-update').classList.toggle('hidden', !['available', 'downloading', 'ready'].includes(u.phase));
  $('#sb-update-text').textContent =
    u.phase === 'available' ? `Update ${u.info.latest} available` : u.phase === 'downloading' ? `Downloading update ${pct}%` : u.phase === 'ready' ? 'Restart to update' : '';
  const st = $('#update-status');
  st.className = `hint${u.phase === 'error' ? ' bad' : u.phase === 'current' ? ' ok' : ''}`;
  st.textContent = {
    checking: 'Checking…',
    current: `You're on the latest version${u.info?.latest ? ` (${u.info.latest})` : ''}.`,
    available: `Version ${u.info?.latest} is available.`,
    downloading: `Downloading… ${pct}%`,
    ready: 'Update downloaded. Restart to install it.',
    error: `Couldn't check for updates: ${u.error}`
  }[u.phase] || '';
  const btn = $('#btn-check-updates');
  btn.lastChild.textContent =
    u.phase === 'available' ? (u.info.canInstall ? 'Update now' : 'Download update') : u.phase === 'ready' ? 'Restart now' : 'Check for updates';
  btn.disabled = u.phase === 'checking' || u.phase === 'downloading';
}

function cleanError(e) {
  return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ===================================================================
// Menus, prompts, layout
// ===================================================================
function showMenu(x, y, items, { above } = {}) {
  const menu = $('#ctx-menu');
  menu.replaceChildren(...items.map((it) => {
    if (it === '-') return el('div', { class: 'sep' });
    return el('div', {
      class: `mi${it.checked ? ' checked' : ''}${it.desc ? ' tall' : ''}`,
      title: it.detail || '',
      onclick: () => {
        menu.classList.add('hidden');
        it.onClick();
      }
    },
    it.icon ? iconEl(it.icon) : null,
    it.desc ? el('span', {}, el('span', { text: it.label }), el('span', { class: 'desc', text: it.desc })) : el('span', { text: it.label }),
    it.detail && !it.desc ? el('span', { class: 'detail', text: it.detail }) : null);
  }));
  menu.classList.remove('hidden');
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 6))}px`;
  menu.style.top = `${Math.max(4, above ? y - h - 6 : Math.min(y, innerHeight - h - 6))}px`;
}

let inputResolve = null;
function askInput(title, placeholder = '', initial = '') {
  $('#input-title').textContent = title;
  const inp = $('#input-value');
  inp.value = initial;
  inp.placeholder = placeholder;
  $('#input-modal').classList.remove('hidden');
  setTimeout(() => {
    inp.focus();
    inp.select();
  }, 0);
  return new Promise((r) => (inputResolve = r));
}
function closeInput(v) {
  $('#input-modal').classList.add('hidden');
  inputResolve?.(v);
  inputResolve = null;
}

function initSplitters() {
  $$('.splitter').forEach((sp) => {
    sp.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const target = $('#' + sp.dataset.target);
      const horizontal = sp.classList.contains('h');
      const start = horizontal ? e.clientY : e.clientX;
      const startSize = horizontal ? target.offsetHeight : target.offsetWidth;
      sp.classList.add('dragging');
      document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
      const move = (ev) => {
        const delta = (horizontal ? ev.clientY : ev.clientX) - start;
        if (horizontal) target.style.height = `${Math.max(90, startSize - delta)}px`;
        else target.style.width = `${Math.max(170, sp.dataset.side === 'right' ? startSize - delta : startSize + delta)}px`;
      };
      const up = () => {
        sp.classList.remove('dragging');
        document.body.style.cursor = '';
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        saveLayout();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  });
}

// Panel sizes are a per-machine convenience, so localStorage is fine (and optional).
function saveLayout() {
  try {
    localStorage.setItem('qw.layout', JSON.stringify({
      side: $('#sidepanel').style.width,
      chat: $('#chat').style.width,
      term: $('#terminal').style.height,
      sideHidden: $('#sidepanel').classList.contains('hidden'),
      view: state.view
    }));
  } catch {
    /* storage unavailable */
  }
}
function restoreLayout() {
  let l = null;
  try {
    l = JSON.parse(localStorage.getItem('qw.layout') || 'null');
  } catch {
    /* ignore */
  }
  if (!l) return;
  if (l.side) $('#sidepanel').style.width = l.side;
  if (l.chat) $('#chat').style.width = l.chat;
  if (l.term) $('#terminal').style.height = l.term;
  if (l.view) showView(l.view);
  if (l.sideHidden) {
    $('#sidepanel').classList.add('hidden');
    $$('.act[data-view]').forEach((b) => b.classList.remove('active'));
  }
}

function autoGrow() {
  const t = $('#prompt');
  t.style.height = 'auto';
  t.style.height = `${Math.min(260, t.scrollHeight)}px`;
}

function bindUi() {
  $('#btn-folder').onclick = (e) => showFolderMenu(e.currentTarget);
  $('#sb-folder').onclick = (e) => showFolderMenu(e.currentTarget);
  $('#btn-quick').onclick = () => openQuick('open');
  $('#btn-settings').onclick = openSettings;
  $('#act-settings').onclick = openSettings;
  $('#btn-model').onclick = (e) => showModelMenu(e.currentTarget);
  $('#s-find-models').onclick = openModels;
  $$('#m-mode button').forEach((b) => {
    b.onclick = () => {
      state.modelsMode = b.dataset.mode;
      renderModels();
    };
  });
  $('#m-close').onclick = () => $('#models-modal').classList.add('hidden');
  $('#models-modal').onmousedown = (e) => {
    if (e.target.id === 'models-modal') $('#models-modal').classList.add('hidden');
  };
  $('#btn-check-updates').onclick = onUpdateButton;
  $('#sb-update').onclick = onUpdateButton;
  $$('.act[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view, true)));
  $('#act-terminal').onclick = () => showTerminal($('#terminal').classList.contains('hidden'));
  $('#sb-terminal').onclick = () => showTerminal($('#terminal').classList.contains('hidden'));
  $('#sb-follow').onclick = async () => {
    state.settings = await api.setSettings({ followAgent: !state.settings.followAgent });
    renderStatusbar();
    flash(`Follow Qwen ${state.settings.followAgent ? 'on' : 'off'}`);
  };

  $('#btn-new-file').onclick = () => newFile();
  $('#btn-new-folder').onclick = () => newFolder();
  $('#btn-refresh').onclick = () => {
    state.fileIndex = null;
    renderTree();
  };
  $('#btn-collapse').onclick = () => {
    state.expanded = new Set(['.']);
    renderTree();
  };
  $('#btn-revert-all').onclick = revertAll;
  $('#btn-commit').onclick = commitFlow;
  $('#btn-push').onclick = pushFlow;

  $('#search-input').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  };
  $('#search-input').onkeydown = (e) => {
    if (e.key === 'Enter') runSearch();
  };
  $('#search-regex').onclick = (e) => {
    state.searchRegex = !state.searchRegex;
    e.currentTarget.classList.toggle('on', state.searchRegex);
    runSearch();
  };

  $('#review-layout').onclick = () => {
    reviewSideBySide = !reviewSideBySide;
    reviewEditor?.updateOptions({ renderSideBySide: reviewSideBySide });
    $('#review-layout').innerHTML = icon(reviewSideBySide ? 'columns' : 'rows');
  };

  $('#btn-term-close').onclick = () => showTerminal(false);
  $('#btn-term-clear').onclick = () => $('#term-out').replaceChildren();
  $('#term-in').onkeydown = (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      const cmd = e.target.value.trim();
      e.target.value = '';
      runTerminalCommand(cmd);
    }
  };

  $('#btn-new-chat').onclick = newChat;
  $('#btn-send').onclick = send;
  $('#btn-stop').onclick = () => stopChat(state.conv);
  $('#btn-history').onclick = () => showView('history');
  $('#ctx-meter').onclick = compactNow;
  $('#chat-running').onclick = () => showView('history');
  $('#btn-new-task').onclick = newChat;
  $('#history-search').oninput = renderHistory;
  $('#btn-attach').onclick = (e) => showAttachMenu(e.currentTarget);
  $('#btn-approval').onclick = (e) => showApprovalMenu(e.currentTarget);
  $('#btn-conv-model').onclick = (e) => showConvModelMenu(e.currentTarget);
  $$('#mode-seg button').forEach((b) => {
    b.onclick = async () => {
      state.settings = await api.setSettings({ agentMode: b.dataset.mode === 'agent' });
      applySettingsToUi();
    };
  });
  $('#prompt').oninput = autoGrow;
  $('#prompt').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  $('#s-provider').onchange = (e) => {
    const p = PROVIDERS[e.target.value];
    if (p.baseUrl) $('#s-baseUrl').value = p.baseUrl;
    if (p.model) $('#s-model').value = p.model;
  };
  $('#s-heavy-provider').onchange = (e) => {
    const p = PROVIDERS[e.target.value];
    if (p && p.baseUrl) $('#s-heavy-baseUrl').value = p.baseUrl;
    if (p && p.model) $('#s-heavy-model').value = p.model;
  };
  $('#s-heavy-enabled').onchange = (e) => $('#s-heavy-fields').classList.toggle('hidden', !e.target.checked);
  $('#s-heavy-fetch').onclick = async () => {
    const out = $('#s-heavy-result');
    out.className = 'hint';
    out.textContent = 'Connecting…';
    try {
      const models = await api.listModels({ provider: $('#s-heavy-provider').value, baseUrl: $('#s-heavy-baseUrl').value.trim(), apiKey: $('#s-heavy-apiKey').value.trim() });
      const clean = [...new Set(models.map((m) => String(m).replace(/^models\//, '')))];
      $('#heavy-model-list').replaceChildren(...clean.map((m) => el('option', { value: m })));
      const ranked = ToolParse.modelAlternates('gemini-none', clean);
      out.className = 'hint ok';
      out.textContent = `Connected ✓ ${clean.length} models${ranked.length ? `. Strongest for planning: ${ranked.slice(0, 3).join(', ')}` : ''}`;
      if (ranked.length && !clean.includes($('#s-heavy-model').value.trim())) $('#s-heavy-model').value = ranked[0];
    } catch (e) {
      out.className = 'hint bad';
      out.textContent = `Could not connect: ${cleanError(e)}`;
    }
  };
  $('#s-fetch-models').onclick = fetchModels;
  $('#s-searchProvider').onchange = renderSearchFields;
  $('#mcp-add-btn').onclick = addServerFromForm;
  $('#node-add-btn').onclick = addNodeFromForm;
  $('#price-add-btn').onclick = addPriceFromForm;
  $('#skill-install-btn').onclick = installSkillFromUrl;
  $('#auto-add-btn').onclick = addAutomationFromForm;
  $('#sem-build-btn').onclick = buildSemIndex;
  $('#auto-kind').onchange = (e) => {
    const daily = e.target.value === 'daily';
    $('#auto-hours-row').classList.toggle('hidden', daily);
    $('#auto-time-row').classList.toggle('hidden', !daily);
    $('#auto-catchup-row').hidden = !daily;
  };
  $('#sb-mcp').onclick = openSettings;
  $('#sb-nodes').onclick = () => {
    openSettings();
    selectSettingsPage('Ollama nodes');
  };
  $('#sb-cost').onclick = () => {
    openSettings();
    selectSettingsPage('Escalation & costs');
  };
  $('#sb-git').onclick = (e) => showGitSyncMenu(e.currentTarget);
  $('#s-save').onclick = saveSettingsFromUi;
  $('#s-cancel').onclick = () => $('#settings-modal').classList.add('hidden');
  $('#s-close').onclick = () => $('#settings-modal').classList.add('hidden');

  $('#quick-input').oninput = () => {
    state.quick.sel = 0;
    renderQuick();
  };
  $('#quick-input').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.quick.items.length;
      if (n) state.quick.sel = (state.quick.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderQuick();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseQuick(state.quick.sel);
    } else if (e.key === 'Escape') {
      closeQuick();
    }
  };
  $('#quick-modal').onmousedown = (e) => {
    if (e.target.id === 'quick-modal') closeQuick();
  };

  $('#input-form').onsubmit = (e) => {
    e.preventDefault();
    closeInput($('#input-value').value.trim());
  };
  $('#input-cancel').onclick = () => closeInput(null);

  addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) $('#ctx-menu').classList.add('hidden');
  });
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') {
      $('#ctx-menu').classList.add('hidden');
      if (!$('#settings-modal').classList.contains('hidden')) $('#settings-modal').classList.add('hidden');
      if (!$('#models-modal').classList.contains('hidden')) $('#models-modal').classList.add('hidden');
      if (!$('#input-modal').classList.contains('hidden')) closeInput(null);
      if (!$('#quick-modal').classList.contains('hidden')) closeQuick();
      return;
    }
    if (!mod) return;
    if (key === 'o') {
      e.preventDefault();
      pickWorkspace();
    } else if (key === 'p') {
      e.preventDefault();
      openQuick('open');
    } else if (key === 's' && !e.shiftKey) {
      e.preventDefault();
      saveActive();
    } else if (e.key === '`') {
      e.preventDefault();
      showTerminal($('#terminal').classList.contains('hidden'));
    } else if (key === 'l') {
      e.preventDefault();
      $('#prompt').focus();
    } else if (key === 'b') {
      e.preventDefault();
      showView(state.view, true);
    } else if (key === 'f' && e.shiftKey) {
      e.preventDefault();
      showView('search');
    } else if (key === 'e' && e.shiftKey) {
      e.preventDefault();
      showView('explorer');
    } else if (key === 'n' && !e.shiftKey) {
      e.preventDefault();
      newChat();
    } else if (key === 'h' && e.shiftKey) {
      e.preventDefault();
      showView('history');
    } else if (key === 'a' && e.shiftKey) {
      e.preventDefault();
      openQuick('attach');
    } else if (key === 'w') {
      e.preventDefault();
      if (state.review?.visible) closeReview();
      else if (state.active) closeTab(state.active);
    }
  });
  addEventListener('beforeunload', (e) => {
    if (state.tabs.some(isDirty)) e.returnValue = false;
  });
}

// ===================================================================
// Helpers
// ===================================================================
function baseName(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}
function parentDir(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}
function joinPath(dir, name) {
  return dir === '.' || !dir ? name : `${dir}/${name}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
