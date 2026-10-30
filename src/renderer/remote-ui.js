'use strict';
// Remote sessions, both directions. HOST: answer remote:ask requests from main by starting,
// continuing or stopping conversations here (the agent loop lives in this process), exactly
// like automations run in the background. VIEWER: paired devices appear in History; opening
// one of their conversations shows a live transcript with a composer and Stop that act on
// the other machine, polled through main's remote:call proxy.

// ---------- host: requests arriving from paired devices ----------
async function handleRemoteAsk({ id, kind, payload }) {
  let result;
  try {
    if (kind === 'start') result = await remoteStartConversation(payload || {});
    else if (kind === 'message') result = await remoteContinueConversation(payload || {});
    else if (kind === 'stop') result = remoteStopConversation(payload || {});
    else result = { ok: false, code: 400, error: 'Unknown action' };
  } catch (e) {
    result = { ok: false, code: 500, error: cleanError(e) };
  }
  api.remoteAnswer(id, result);
}

// Runs a conversation without putting it on screen — the same shape automations use.
async function runRemoteConversation(c) {
  setBusy(c, true);
  let failed = false;
  try {
    failed = await runConversation(c);
  } catch (e) {
    failed = true;
    addError(c, `Something went wrong: ${cleanError(e)}`);
  } finally {
    c.status = c.stopRequested ? 'stopped' : failed ? 'error' : 'done';
    setBusy(c, false);
    saveConv(c, true);
    flushSpend();
    proposeLessons(c);
    maybeReviewPass(c);
  }
}

async function remoteStartConversation({ text, title }) {
  if (!state.ws) return { ok: false, code: 409, error: 'No folder is open on the host.' };
  const c = createConv();
  c.title = `📡 ${title || (text.length > 60 ? `${text.slice(0, 57)}…` : text)}`;
  c.mode = state.settings.agentMode ? 'agent' : 'chat';
  c.model = state.settings.model;
  state.convs.set(c.id, c);
  [c.memory, c.skills] = await Promise.all([loadProjectMemory(), api.skillsList().catch(() => [])]);
  c.memoryLoaded = true;
  addUserMessage(c, text, []);
  c.history.push({ role: 'user', content: text });
  saveConv(c, true); // in the index right away, so the remote viewer can start polling it
  renderHistory();
  toast({
    key: `remote-${c.id}`,
    icon: 'server',
    timeout: 10_000,
    text: [el('b', { text: 'A paired device started a task here.' }), ` ${c.title}`],
    actions: [{ label: 'Open', onClick: () => switchConv(c) }]
  });
  runRemoteConversation(c); // deliberately not awaited: the device gets its 202 now
  return { ok: true, id: c.id };
}

async function remoteContinueConversation({ id, text }) {
  const c = state.convs.get(id) || (await openConvQuiet(id));
  if (!c) return { ok: false, code: 404, error: 'No such conversation on the host.' };
  // A remote reply while the agent is asking a question answers that question.
  if (c.pendingQuestion) {
    c.pendingQuestion.answer(text);
    return { ok: true, id };
  }
  if (c.busy) return { ok: false, code: 409, error: 'That task is still running — stop it first, or wait for it to finish.' };
  if (!c.memoryLoaded && state.ws) {
    [c.memory, c.skills] = await Promise.all([loadProjectMemory(), api.skillsList().catch(() => [])]);
    c.memoryLoaded = true;
  }
  addUserMessage(c, text, []);
  c.history.push({ role: 'user', content: text });
  saveConv(c, true);
  renderHistory();
  runRemoteConversation(c);
  return { ok: true, id };
}

function remoteStopConversation({ id }) {
  const c = state.convs.get(id);
  if (!c) return { ok: false, code: 404, error: 'That conversation is not loaded on the host.' };
  if (!c.busy) return { ok: true, id, note: 'It was not running.' };
  stopChat(c);
  return { ok: true, id };
}

// ---------- viewer: paired devices in History ----------
function pairedDevices() {
  return (state.settings?.devices || []).filter((d) => d && d.url);
}

let remoteHistoryTimer = null;

// Called when the History panel becomes visible; keeps the device sections fresh while it is.
function startRemoteHistory() {
  stopRemoteHistory();
  if (!pairedDevices().length) return;
  refreshRemoteHistory();
  remoteHistoryTimer = setInterval(refreshRemoteHistory, 10_000);
}

function stopRemoteHistory() {
  clearInterval(remoteHistoryTimer);
  remoteHistoryTimer = null;
}

async function refreshRemoteHistory() {
  const box = $('#remote-history');
  if (!box) return;
  const devices = pairedDevices();
  if (!devices.length) {
    box.replaceChildren();
    return;
  }
  const sections = await Promise.all(devices.map(async (d) => {
    const r = await api.remoteCall(d, '/qw/conversations', 'GET');
    const head = el('div', { class: 'remote-dev-head' },
      el('span', { class: `dot ${r.ok ? 'ready' : 'error'}` }),
      el('span', { class: 'name', text: d.name || d.url }),
      r.ok ? null : el('span', { class: 'hint', text: r.status === 401 ? 'wrong pairing code' : (r.error || `HTTP ${r.status}`) }));
    const rows = r.ok
      ? (r.data || []).slice(0, 12).map((cv) => el('button', {
          class: 'remote-conv',
          title: `${cv.workspace || ''}\n${new Date(cv.updatedAt || 0).toLocaleString()}`,
          onclick: () => openRemoteViewer(d, cv.id, cv.title)
        },
        el('span', { class: `st-dot ${cv.status || ''}`, title: cv.status || '' }),
        el('span', { class: 'name', text: cv.title || cv.id }),
        el('span', { class: 'meta', text: cv.status || '' })))
      : [];
    return el('div', { class: 'remote-dev' }, head, ...rows);
  }));
  box.replaceChildren(el('h3', { text: 'Other devices' }), ...sections);
}

// ---------- viewer: the live remote transcript ----------
const remoteView = { device: null, convId: null, timer: null, stamp: 0 };

async function openRemoteViewer(device, convId, title) {
  remoteView.device = device;
  remoteView.convId = convId;
  remoteView.stamp = 0;
  $('#remote-title').textContent = `${device.name || device.url} — ${title || convId}`;
  $('#remote-status').textContent = 'Loading…';
  $('#remote-log').replaceChildren();
  $('#remote-modal').classList.remove('hidden');
  clearInterval(remoteView.timer);
  remoteView.timer = setInterval(refreshRemoteViewer, 2500);
  refreshRemoteViewer();
}

function closeRemoteViewer() {
  clearInterval(remoteView.timer);
  remoteView.timer = null;
  remoteView.device = null;
  $('#remote-modal').classList.add('hidden');
}

async function refreshRemoteViewer() {
  const { device, convId } = remoteView;
  if (!device) return;
  const r = await api.remoteCall(device, `/qw/conversations/${convId}`, 'GET');
  if (!r.ok) {
    $('#remote-status').textContent = r.status === 404 ? 'This conversation is gone on the host.' : `Can’t reach ${device.name || device.url}: ${r.error || `HTTP ${r.status}`}`;
    return;
  }
  const data = r.data;
  $('#remote-status').textContent = `${data.status || ''} · ${data.model || ''} · ${data.workspace || ''}`;
  if ((data.updatedAt || 0) === remoteView.stamp && $('#remote-log').childElementCount) return; // unchanged
  remoteView.stamp = data.updatedAt || 0;
  // Reuse the real transcript renderers on a lightweight stand-in conversation.
  const fake = { display: data.display || [], container: $('#remote-log'), todos: data.todos || [] };
  renderTranscript(fake);
  $('#remote-log').scrollTop = $('#remote-log').scrollHeight;
}

async function sendRemoteMessage() {
  const { device, convId } = remoteView;
  const input = $('#remote-input');
  const text = input.value.trim();
  if (!device || !text) return;
  input.value = '';
  const r = await api.remoteCall(device, `/qw/conversations/${convId}/message`, 'POST', { text });
  if (!r.ok) {
    input.value = text; // let the user retry or edit
    toast({ icon: 'alert', timeout: 9000, text: r.data?.error || r.error || `The host said no (HTTP ${r.status}).` });
    return;
  }
  $('#remote-status').textContent = 'Sent — the host is working…';
  setTimeout(refreshRemoteViewer, 800);
}

async function stopRemoteConversation() {
  const { device, convId } = remoteView;
  if (!device) return;
  const r = await api.remoteCall(device, `/qw/conversations/${convId}/stop`, 'POST', {});
  if (!r.ok) toast({ icon: 'alert', timeout: 9000, text: r.data?.error || r.error || `Could not stop (HTTP ${r.status}).` });
  else flash('Stop sent to the host');
}

// ---------- settings: the Remote sessions page ----------
let settingsDevices = null;

async function renderRemoteSettings() {
  const s = state.settings;
  const ra = s.remoteAccess || {};
  $('#s-remote-enabled').checked = !!ra.enabled;
  $('#s-remote-port').value = ra.port || 8931;
  $('#s-remote-token').value = ra.token || '(created when you enable it)';
  const st = await api.remoteState().catch(() => ({ running: false }));
  $('#s-remote-state').textContent = st.running ? `Serving on port ${st.port}. Other devices pair with this PC's Tailscale address and the code above.` : 'Off.';
  renderDeviceSettings();
}

function renderDeviceSettings() {
  const list = $('#device-list');
  if (!settingsDevices.length) {
    list.replaceChildren(el('div', { class: 'hint', text: 'No paired devices yet. On the other PC, turn on "Allow other devices", then add its URL and pairing code here.' }));
    return;
  }
  list.replaceChildren(...settingsDevices.map((d) => {
    const sub = el('div', { class: 'mcp-sub', text: d.url });
    return el('div', { class: 'mcp-item' },
      el('span', { class: 'dot' }),
      el('div', { class: 'mcp-main' }, el('div', { class: 'mcp-name', text: d.name || d.url }), sub),
      el('button', {
        class: 'ghost',
        text: 'Test',
        onclick: async () => {
          sub.textContent = 'Checking…';
          const r = await api.remoteCall(d, '/qw/ping', 'GET');
          sub.classList.toggle('bad', !r.ok);
          sub.textContent = r.ok
            ? `Online — ${r.data.device} (${r.data.app} ${r.data.version})${r.data.workspace ? ` · folder: ${r.data.workspace}` : ' · no folder open'}`
            : r.status === 401 ? 'Reached it, but the pairing code is wrong.' : `Not reachable: ${r.error || `HTTP ${r.status}`}`;
        }
      }),
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => { settingsDevices = settingsDevices.filter((x) => x !== d); renderDeviceSettings(); } }, iconEl('trash')));
  }));
}

function addDeviceFromForm() {
  const name = $('#device-new-name').value.trim();
  const url = $('#device-new-url').value.trim().replace(/\/+$/, '');
  const token = $('#device-new-code').value.trim();
  const out = $('#device-add-result');
  if (!/^https?:\/\//.test(url)) {
    out.textContent = 'The device URL must start with http:// (e.g. http://100.88.91.13:8931).';
    return;
  }
  if (!token) {
    out.textContent = 'Paste the pairing code shown on the other device.';
    return;
  }
  settingsDevices.push({ id: `dev-${Date.now().toString(36)}`, name: name || url.replace(/^https?:\/\//, ''), url, token });
  $('#device-new-name').value = '';
  $('#device-new-url').value = '';
  $('#device-new-code').value = '';
  out.textContent = 'Added. Save to keep it, then Test.';
  renderDeviceSettings();
}
