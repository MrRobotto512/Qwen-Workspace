'use strict';
// ===================================================================
// Conversations
// ===================================================================
// Each conversation keeps its own transcript, model history, file changes and run state, and
// renders into its own container, so a task can keep running while another one is on screen.
// `display` is the saved transcript the UI is rebuilt from; `history` is what Qwen sees.
function createConv() {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    title: 'New chat',
    workspace: state.ws?.root || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle', // idle | running | waiting | done | error | stopped
    model: state.settings.model,
    mode: state.settings.agentMode ? 'agent' : 'chat',
    history: [],
    display: [],
    changes: new Map(), // path -> { original: string|null, added, removed }
    notes: [], // things to tell Qwen with the next message (e.g. reverts)
    usage: null,
    usageAt: 0, // history length when `usage` was measured
    spend: {}, // cloud tokens this conversation used: model -> { in, out }
    todos: [],
    compactions: 0,
    activeTools: [], // deferred tools loaded with tool_search
    busy: false,
    stopRequested: false,
    chatId: null,
    pendingApproval: null,
    activity: '',
    container: el('div', { class: 'conv-log' })
  };
}

function needsUser(c) {
  return !!(c.pendingApproval || c.pendingQuestion);
}

function convStatus(c) {
  if (c.busy) return needsUser(c) ? 'waiting' : 'running';
  return c.status;
}

function serializeConv(c) {
  return {
    id: c.id,
    title: c.title,
    workspace: c.workspace,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: convStatus(c),
    model: c.model,
    mode: c.mode,
    history: c.history,
    display: c.display,
    changes: [...c.changes],
    notes: c.notes,
    usage: c.usage,
    usageAt: c.usageAt,
    spend: c.spend || {},
    todos: c.todos,
    compactions: c.compactions,
    activeTools: c.activeTools,
    modelChoice: c.modelChoice || null
  };
}

function convSummary(c) {
  return {
    id: c.id,
    title: c.title,
    workspace: c.workspace,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: convStatus(c),
    model: c.model,
    mode: c.mode,
    changes: c.changes.size,
    messages: c.display.filter((d) => d.t === 'user').length
  };
}

// Saves shortly after the last change, so a burst of tool calls is one write.
function saveConv(c, now) {
  if (!c.display.length || !c.workspace) return;
  clearTimeout(c.saveTimer);
  const write = async () => {
    try {
      const summary = await api.convSave(serializeConv(c));
      const i = state.convList.findIndex((x) => x.id === c.id);
      if (i >= 0) state.convList[i] = summary;
      else state.convList.unshift(summary);
      renderHistory();
    } catch (e) {
      flash(`Couldn't save the conversation: ${cleanError(e)}`);
    }
  };
  if (now) write();
  else c.saveTimer = setTimeout(write, 400);
}

async function loadConversations() {
  state.convs.clear();
  state.convList = state.ws ? await api.convList(state.ws.root) : [];
  const lastId = state.ws && state.settings.lastConversations?.[state.ws.root];
  if (lastId && state.convList.some((c) => c.id === lastId)) await openConv(lastId);
  else newChat();
  renderHistory();
}

async function openConv(id) {
  let c = state.convs.get(id);
  if (!c) {
    let data;
    try {
      data = await api.convLoad(id);
    } catch (e) {
      flash(`Couldn't open that conversation: ${cleanError(e)}`);
      return;
    }
    c = Object.assign(createConv(), data, {
      changes: new Map(data.changes || []),
      // A task that was running when the app closed can't still be running.
      status: ['running', 'waiting'].includes(data.status) ? 'stopped' : data.status
    });
    renderTranscript(c);
    state.convs.set(id, c);
  }
  switchConv(c);
}

function newChat() {
  if (state.conv && !state.conv.display.length && !state.conv.busy) {
    renderChatEmpty(state.conv);
    switchConv(state.conv);
  } else {
    const c = createConv();
    state.convs.set(c.id, c);
    renderChatEmpty(c);
    switchConv(c);
  }
  $('#prompt').focus();
}

function switchConv(c) {
  state.conv = c;
  $('#messages').replaceChildren(c.container);
  $('#chat-title').textContent = c.title;
  $('#chat-title').title = c.title;
  renderRunControls();
  renderConvModel();
  updateCtxMeter();
  renderTodoBar();
  renderChanges();
  renderTree();
  renderCenter();
  renderHistory();
  scrollChat(c, true);
  if (state.ws && c.display.length) {
    state.settings.lastConversations = { ...(state.settings.lastConversations || {}), [state.ws.root]: c.id };
    api.setSettings({ lastConversations: state.settings.lastConversations });
  }
}

function renderChatEmpty(c) {
  const suggestions = [
    ['book', 'Explain this project', "Give me an overview of this project: what it does, how it's structured, and how to build and run it."],
    ['eye', 'Review the open file', 'Review the open file for bugs and suggest improvements.'],
    ['bug', 'Fix a bug…', 'Find and fix this bug: ', true],
    ['wand', 'Add a feature…', 'Add this feature: ', true],
    ['sparkles', 'Start a new project from scratch…', 'Help me build this from scratch: ', true]
  ];
  c.container.replaceChildren(
    el('div', { class: 'chat-empty' },
      el('span', { class: 'logo', text: 'Q' }),
      el('h2', { text: state.ws ? `What should we do in ${state.ws.name}?` : 'What are we building?' }),
      el('p', { text: state.ws ? 'Start a task or ask a question. Past conversations are under History.' : 'Open a folder so Qwen can work with your files.' }),
      el('div', { class: 'suggestions' }, ...suggestions.map(([ic, label, prompt, fill]) =>
        el('button', { onclick: () => setPrompt(prompt, !fill) }, iconEl(ic), label))),
      state.convList.length
        ? el('button', { class: 'ghost recent-link', onclick: () => showView('history') }, iconEl('history'), `${state.convList.length} past conversation${state.convList.length === 1 ? '' : 's'}`)
        : null)
  );
}

// Rebuilds a saved conversation's transcript from its display log.
function renderTranscript(c) {
  c.container.replaceChildren();
  for (const item of c.display) {
    if (item.t === 'user') renderUserMessage(c, item.text, item.attached || []);
    else if (item.t === 'error') renderError(c, item.text);
    else if (item.t === 'notice') renderNotice(c, item);
    else if (item.t === 'assistant') {
      const view = addAssistantMessage(c, item);
      view.setFinal(item.content || '', item.reasoning || '');
      view.finish(item.hasCalls);
      for (const step of item.steps || []) view.addStep(step.call, step).restore();
    }
  }
  if (!c.display.length) renderChatEmpty(c);
}

async function renameConv(id) {
  const meta = state.convs.get(id) || state.convList.find((x) => x.id === id);
  const title = await askInput('Rename conversation', '', meta?.title || '');
  if (!title) return;
  const c = state.convs.get(id) || (await openConvQuiet(id));
  if (!c) return;
  c.title = title;
  if (c === state.conv) $('#chat-title').textContent = title;
  saveConv(c, true);
}

// Loads a conversation without showing it (used for renaming from the list).
async function openConvQuiet(id) {
  try {
    const data = await api.convLoad(id);
    const c = Object.assign(createConv(), data, {
      changes: new Map(data.changes || []),
      // A task that was running when the app closed can't still be running.
      status: ['running', 'waiting'].includes(data.status) ? 'stopped' : data.status
    });
    renderTranscript(c);
    state.convs.set(id, c);
    return c;
  } catch {
    return null;
  }
}

async function deleteConv(id) {
  const c = state.convs.get(id);
  if (c?.busy) return alert('Stop this task before deleting it.');
  const meta = c || state.convList.find((x) => x.id === id);
  if (!confirm(`Delete "${meta?.title || 'this conversation'}"? Files it changed stay as they are.`)) return;
  await api.convDelete(id);
  state.convs.delete(id);
  state.convList = state.convList.filter((x) => x.id !== id);
  if (state.conv?.id === id) {
    state.conv = null;
    newChat();
  }
  renderHistory();
}

const STATUS_INFO = {
  running: { icon: null, label: 'Running' },
  waiting: { icon: 'alert', label: 'Needs your approval' },
  done: { icon: 'check', label: 'Done' },
  error: { icon: 'x', label: 'Failed' },
  stopped: { icon: 'stop', label: 'Stopped' },
  idle: { icon: 'chat', label: '' }
};

function relativeTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d < 7 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}

function dayGroup(ts) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (ts >= start.getTime()) return 'Today';
  if (ts >= start.getTime() - day) return 'Yesterday';
  if (ts >= start.getTime() - 7 * day) return 'Previous 7 days';
  return 'Older';
}

function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  // Live conversations override their saved summaries (status, title, time).
  const byId = new Map(state.convList.map((m) => [m.id, m]));
  for (const c of state.convs.values()) {
    if (c.display.length) byId.set(c.id, { ...byId.get(c.id), ...convSummary(c) });
  }
  const q = $('#history-search').value.trim().toLowerCase();
  const items = [...byId.values()].filter((m) => !q || m.title.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);

  const active = [...state.convs.values()].filter((c) => c.busy);
  const badge = $('#history-badge');
  badge.textContent = String(active.length);
  badge.classList.toggle('hidden', !active.length);
  badge.classList.toggle('warn', active.some(needsUser));
  const others = active.filter((c) => c !== state.conv);
  const pill = $('#chat-running');
  pill.classList.toggle('hidden', !others.length);
  pill.classList.toggle('warn', others.some(needsUser));
  pill.lastChild.textContent = others.some(needsUser) ? `${others.length} need${others.length === 1 ? 's' : ''} you` : `${others.length} running`;

  if (!state.ws) {
    list.replaceChildren(el('div', { class: 'empty-note', text: 'Open a folder to see its conversations.' }));
    return;
  }
  if (!items.length) {
    list.replaceChildren(el('div', { class: 'empty-note', text: q ? 'No matching conversations.' : 'Conversations and agent tasks you start in this project are saved here.' }));
    return;
  }
  const frag = document.createDocumentFragment();
  let group = null;
  for (const m of items) {
    const g = dayGroup(m.updatedAt);
    if (g !== group) {
      group = g;
      frag.append(el('div', { class: 'h-group', text: g }));
    }
    const st = STATUS_INFO[m.status] || STATUS_INFO.idle;
    const sub = [relativeTime(m.updatedAt), m.mode === 'chat' ? 'Chat' : 'Agent', m.changes ? `${m.changes} file${m.changes === 1 ? '' : 's'} changed` : null].filter(Boolean).join(' · ');
    frag.append(
      el('div', { class: `h-item${m.id === state.conv?.id ? ' active' : ''} st-${m.status}`, title: `${m.title}${st.label ? `\n${st.label}` : ''}`, onclick: () => openConv(m.id) },
        el('span', { class: 'h-status' }, st.icon ? iconEl(st.icon) : el('span', { class: 'spinner' })),
        el('div', { class: 'h-main' }, el('div', { class: 'h-title', text: m.title }), el('div', { class: 'h-sub', text: sub })),
        el('span', { class: 'h-acts' },
          el('button', { class: 'icon-btn', title: 'Rename', onclick: (e) => { e.stopPropagation(); renameConv(m.id); } }, iconEl('pencil')),
          el('button', { class: 'icon-btn', title: 'Delete', onclick: (e) => { e.stopPropagation(); deleteConv(m.id); } }, iconEl('trash'))))
    );
  }
  list.replaceChildren(frag);
}
