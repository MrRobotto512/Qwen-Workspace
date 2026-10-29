'use strict';
// The Settings panel: connection, planner, approvals, skills, semantic index,
// MCP servers, and the first-run model pick / connection checks.

const SKILL_SCOPE_TEXT = { project: 'project', claude: 'project · .claude', user: 'personal', claudeuser: 'personal · ~/.claude' };

async function renderSemSettings() {
  const out = $('#sem-status');
  if (!out) return;
  if (!state.ws) {
    out.textContent = 'Open a project folder first.';
    return;
  }
  const st = await api.semStatus().catch(() => ({ exists: false }));
  state.semReady = !!st.exists;
  out.textContent = st.exists
    ? `${st.chunks} chunks from ${st.files} files · ${st.embedder} · built ${new Date(st.builtAt).toLocaleString()}`
    : 'No index yet for this project.';
}

async function buildSemIndex() {
  const out = $('#sem-status');
  if (!state.ws) return flash('Open a project folder first.');
  const btn = $('#sem-build-btn');
  btn.disabled = true;
  out.textContent = 'Indexing…';
  const off = api.onSemProgress((p) => {
    if (p.phase === 'embed' && p.total) out.textContent = `Embedding ${p.done}/${p.total} chunks…`;
  });
  try {
    const r = await api.semIndex();
    if (r.ok) {
      state.semReady = true;
      out.textContent = `${r.chunks} chunks from ${r.files} files · ${r.embedder} · ${r.embedded} newly embedded`;
      flash('Semantic index ready — Qwen can now use semantic_search.');
    } else {
      out.textContent = r.output || 'Indexing failed.';
    }
  } finally {
    off();
    btn.disabled = false;
  }
}

async function renderSkillsSettings() {
  const list = $('#skills-list');
  if (!list) return;
  const skills = await api.skillsList().catch(() => []);
  if (!skills.length) {
    list.replaceChildren(el('div', { class: 'empty-note', text: 'No skills yet. Install one above, or create .qwen/skills/<name>/SKILL.md in your project.' }));
    return;
  }
  list.replaceChildren(...skills.map((sk) => el('div', { class: 'skill-row', title: sk.description },
    iconEl('book'),
    el('span', { class: 'sk-name', text: sk.name }),
    el('span', { class: 'sk-scope', text: SKILL_SCOPE_TEXT[sk.scope] || sk.scope }),
    el('span', { class: 'sk-desc', text: sk.description }))));
}

async function installSkillFromUrl() {
  const inp = $('#skill-url');
  const out = $('#skill-install-result');
  const url = inp.value.trim();
  if (!url) return;
  out.className = 'hint';
  out.textContent = 'Installing…';
  const r = await api.skillsInstall(url).catch((e) => ({ ok: false, output: cleanError(e) }));
  if (r.ok) {
    out.className = 'hint ok';
    out.textContent = `Installed "${r.name}" (${r.files} file${r.files === 1 ? '' : 's'}, ${r.scope === 'project' ? 'this project' : 'personal'}). New conversations can use it.`;
    inp.value = '';
    renderSkillsSettings();
  } else {
    out.className = 'hint bad';
    out.textContent = r.output || 'Install failed.';
  }
}

function parseServerCommand(text) {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return { url: t, type: 'http' };
  const parts = t.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = parts.map((x) => x.replace(/^["']|["']$/g, ''));
  return { command: clean[0], args: clean.slice(1) };
}

function serverSummary(cfg) {
  if (cfg.url) return cfg.url;
  return [cfg.command, ...(cfg.args || [])].join(' ');
}

function renderMcpSettings() {
  const list = $('#mcp-list');
  const configs = state.settings.mcpServers || [];
  if (!configs.length) {
    list.replaceChildren(el('div', { class: 'hint', text: 'No servers yet. For example, add REA with command: npx -y rea-agents mcp' }));
    return;
  }
  list.replaceChildren(...configs.map((cfg) => {
    const live = state.mcp.find((m) => m.id === sanitizeServerId(cfg.name));
    const status = cfg.enabled === false ? 'off' : live?.status || 'connecting';
    const sub = status === 'ready' ? `${live.tools.length} tools · ${serverSummary(cfg)}` : status === 'error' || status === 'disconnected' ? live?.error || 'Failed to connect' : status === 'off' ? `Disabled · ${serverSummary(cfg)}` : serverSummary(cfg);
    return el('div', { class: 'mcp-item' },
      el('span', { class: `dot ${status}` }),
      el('div', { class: 'mcp-main' },
        el('div', { class: 'mcp-name', text: cfg.name }),
        el('div', { class: `mcp-sub${status === 'error' || status === 'disconnected' ? ' bad' : ''}`, title: sub, text: sub })),
      el('label', { class: 'toggle', title: 'Enable or disable this server' },
        el('input', { type: 'checkbox', checked: cfg.enabled !== false, onchange: (e) => toggleServer(cfg.name, e.target.checked) })),
      el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeServer(cfg.name) }, iconEl('trash')));
  }));
}

// Mirror of the main process id rule, so the UI matches live server ids.
function sanitizeServerId(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

async function addServerFromForm() {
  const name = $('#mcp-new-name').value.trim();
  const cmd = $('#mcp-new-cmd').value.trim();
  if (!name || !cmd) return flash('Give the server a name and a command.');
  if (!sanitizeServerId(name)) return flash('Use letters or numbers in the name.');
  const configs = (state.settings.mcpServers || []).filter((c) => sanitizeServerId(c.name) !== sanitizeServerId(name));
  configs.push({ name, ...parseServerCommand(cmd), enabled: true });
  await saveServers(configs);
  $('#mcp-new-name').value = '';
  $('#mcp-new-cmd').value = '';
}

async function toggleServer(name, enabled) {
  const configs = (state.settings.mcpServers || []).map((c) => (c.name === name ? { ...c, enabled } : c));
  await saveServers(configs);
}

async function removeServer(name) {
  if (!confirm(`Remove the "${name}" MCP server?`)) return;
  await saveServers((state.settings.mcpServers || []).filter((c) => c.name !== name));
}

async function saveServers(configs) {
  state.settings = await api.setSettings({ mcpServers: configs });
  renderMcpSettings();
  state.mcp = await api.mcpReconnect();
  renderMcpStatus();
  renderMcpSettings();
}

function renderSearchFields() {
  const p = $('#s-searchProvider').value;
  $('#s-brave-row').classList.toggle('hidden', p !== 'brave');
  $('#s-searxng-row').classList.toggle('hidden', p !== 'searxng');
}

// The settings dialog used to be one long scrolling column, which got cramped as
// sections piled up. Show it full-window instead, with a sidebar of section tabs
// and one section visible at a time. The markup in index.html stays flat; on first
// open the children are tagged with the section they follow and regrouped into a
// nav + content pair, so every input keeps its id and the save wiring is untouched.
let settingsPageKey = null;

function buildSettingsPages() {
  const box = document.querySelector('#settings-modal .modal-box');
  if (box.classList.contains('settings-box')) return;
  box.classList.add('settings-box');
  const head = box.querySelector('.modal-head');
  const actions = box.querySelector('.modal-actions');
  const nav = el('div', { class: 'set-nav' });
  const content = el('div', { class: 'set-content' });
  const body = el('div', { class: 'set-body' }, nav, content);
  const kids = Array.from(box.children).filter((n) => n !== head && n !== actions);
  let key = null;
  for (const n of kids) {
    if (n.classList.contains('section-title')) {
      const k = n.textContent.trim();
      key = k;
      nav.appendChild(el('button', { class: 'set-nav-btn', text: k, dataset: { sec: k }, onclick: () => selectSettingsPage(k) }));
    }
    if (key) n.dataset.sec = key;
    content.appendChild(n);
  }
  box.insertBefore(body, actions);
  if (!settingsPageKey) settingsPageKey = nav.firstChild?.dataset.sec || null;
}

function selectSettingsPage(key) {
  settingsPageKey = key;
  const box = document.querySelector('#settings-modal .modal-box');
  for (const n of box.querySelectorAll('.set-content > [data-sec]')) n.classList.toggle('sec-off', n.dataset.sec !== key);
  for (const b of box.querySelectorAll('.set-nav-btn')) b.classList.toggle('active', b.dataset.sec === key);
  box.querySelector('.set-content').scrollTop = 0;
}

function openSettings() {
  const s = state.settings;
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'temperature', 'fontSize', 'contextLength', 'maxResponseTokens', 'keepAlive', 'searchProvider', 'searchApiKey', 'searxngUrl']) $(`#s-${k}`).value = s[k] ?? '';
  $('#s-webResearch').checked = s.webResearch !== false;
  $('#s-allowPrivateFetch').checked = !!s.allowPrivateFetch;
  renderSearchFields();
  for (const k of ['agentMode', 'includeCurrentFile', 'followAgent', 'autoCheckUpdates']) $(`#s-${k}`).checked = !!s[k];
  $('#about-version').textContent = state.appInfo?.version || '';
  $('#about-kind').textContent = KIND_TEXT[state.appInfo?.kind] || '';
  renderUpdateUi();
  renderMcpSettings();
  renderSkillsSettings();
  renderAutomations();
  renderSemSettings();
  $('#skill-install-result').textContent = '';
  $('#s-approvalMode').value = approvalMode();
  $('#s-allowedCommands').value = (s.allowedCommands || []).join(', ');
  $('#s-maxSteps').value = s.maxSteps || DEFAULT_MAX_STEPS;
  const h = s.heavy || {};
  $('#s-heavy-enabled').checked = !!h.enabled;
  $('#s-heavy-provider').value = h.provider || 'gemini';
  $('#s-heavy-baseUrl').value = h.baseUrl || PROVIDERS.gemini.baseUrl;
  $('#s-heavy-apiKey').value = h.apiKey || '';
  $('#s-heavy-model').value = h.model || '';
  $('#s-heavy-fields').classList.toggle('hidden', !h.enabled);
  $('#s-test-result').textContent = '';
  buildSettingsPages();
  selectSettingsPage(settingsPageKey);
  $('#settings-modal').classList.remove('hidden');
}

async function saveSettingsFromUi() {
  const patch = {};
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'approvalMode', 'searchProvider', 'searchApiKey', 'searxngUrl']) patch[k] = $(`#s-${k}`).value.trim();
  patch.modelPicked = true;
  patch.webResearch = $('#s-webResearch').checked;
  patch.allowPrivateFetch = $('#s-allowPrivateFetch').checked;
  patch.temperature = parseFloat($('#s-temperature').value) || 0;
  patch.fontSize = parseInt($('#s-fontSize').value, 10) || 14;
  patch.contextLength = Math.max(2048, parseInt($('#s-contextLength').value, 10) || 32768);
  patch.maxResponseTokens = Math.max(0, parseInt($('#s-maxResponseTokens').value, 10) || 0);
  patch.keepAlive = ($('#s-keepAlive').value.trim() || '-1');
  patch.allowedCommands = $('#s-allowedCommands').value.split(',').map((x) => x.trim()).filter(Boolean);
  patch.maxSteps = Math.min(1000, Math.max(10, parseInt($('#s-maxSteps').value, 10) || DEFAULT_MAX_STEPS));
  for (const k of ['agentMode', 'includeCurrentFile', 'followAgent', 'autoCheckUpdates']) patch[k] = $(`#s-${k}`).checked;
  patch.heavy = {
    enabled: $('#s-heavy-enabled').checked,
    provider: $('#s-heavy-provider').value,
    baseUrl: $('#s-heavy-baseUrl').value.trim(),
    apiKey: $('#s-heavy-apiKey').value.trim(),
    model: $('#s-heavy-model').value.trim()
  };
  state.settings = await api.setSettings(patch);
  $('#settings-modal').classList.add('hidden');
  applySettingsToUi();
  checkConnection();
}

async function fetchModels() {
  const out = $('#s-test-result');
  out.className = 'hint';
  out.textContent = 'Connecting…';
  // Save the connection fields first so the main process uses them (and keep state in sync).
  state.settings = await api.setSettings({ baseUrl: $('#s-baseUrl').value.trim(), apiKey: $('#s-apiKey').value.trim(), provider: $('#s-provider').value });
  try {
    const models = await api.listModels();
    $('#model-list').replaceChildren(...models.map((m) => el('option', { value: m })));
    const qwen = models.filter((m) => /qwen/i.test(m));
    out.className = 'hint ok';
    out.textContent = `Connected ✓ ${models.length} models available${qwen.length ? `, Qwen: ${qwen.slice(0, 8).join(', ')}${qwen.length > 8 ? '…' : ''}` : ''}`;
    if (qwen.length && !qwen.includes($('#s-model').value)) $('#s-model').value = qwen[0];
  } catch (e) {
    out.className = 'hint bad';
    out.textContent = `Could not connect: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
}

// On first run, set the model to the one recommended for this PC instead of a hardcoded default.
async function pickDefaultModel() {
  if (state.settings.modelPicked || state.settings.model) return;
  let model = '';
  try {
    const { recommended } = recommendModels(await api.systemSpecs());
    model = recommended?.id || '';
  } catch {
    /* hardware probe failed */
  }
  model = model || 'qwen2.5-coder:7b';
  state.settings = await api.setSettings({ model, modelPicked: true });
  applySettingsToUi();
}

async function checkConnection() {
  const dot = $('#conn-dot');
  dot.className = 'dot';
  const ollama = state.settings.provider === 'ollama';
  try {
    const models = await api.listModels();
    const found = models.includes(state.settings.model);
    dot.className = `dot ${found || !models.length ? 'ok' : 'bad'}`;
    $('#btn-model').title = found || !models.length ? `Connected to ${state.settings.baseUrl}` : `Model "${state.settings.model}" not found on the server. Click to choose another.`;
    if (found) $('#toasts .toast[data-key="model"]')?.remove();
    if (found && ollama) checkContextFits();
    else state.modelInfo = null;
    if (ollama && !found) warnOnce(`missing:${state.settings.model}`, () => {
      const known = MODEL_CATALOG.find((m) => m.id === state.settings.model);
      toast({
        key: 'model',
        icon: 'download',
        text: [el('b', { text: `${state.settings.model} isn't downloaded yet.` }), models.length ? ' Download it, or pick one of your installed models from the model menu.' : ' Download it, or let the app suggest a model that suits this PC.'],
        actions: [
          { label: 'Suggest a model', onClick: openModels },
          { label: `Download${known ? ` (${formatGB(known.sizeGB)})` : ''}`, primary: true, onClick: () => downloadModel(known || { id: state.settings.model, name: state.settings.model }) }
        ]
      });
    });
  } catch (e) {
    dot.className = 'dot bad';
    $('#btn-model').title = `Not connected: ${e.message}`;
    if (ollama) warnOnce('ollama-down', () =>
      toast({
        key: 'model',
        icon: 'alert',
        text: [el('b', { text: "Can't reach Ollama." }), ' Qwen runs on this PC through Ollama. Install it, or start it if it is already installed.'],
        actions: [
          { label: 'Retry', onClick: checkConnection },
          { label: 'Get Ollama', primary: true, onClick: () => api.openExternal('https://ollama.com/download') }
        ]
      }));
  }
}

// Past the length a model was trained for (and without YaRN in its GGUF), it loses track of
// the conversation, so warn when the context window is set beyond that.
async function checkContextFits() {
  const model = state.settings.model;
  const info = await api.ollamaShow(model);
  if (model !== state.settings.model) return;
  state.modelInfo = info;
  const trained = info?.contextLength;
  const yarn = info?.rope?.type === 'yarn';
  $('#btn-model').title = trained
    ? `${model} · handles ${formatContext(trained)}${yarn ? ` (YaRN ×${info.rope.factor} from ${formatContext(info.rope.originalContext)})` : ''} · context window set to ${formatContext(state.settings.contextLength)}`
    : $('#btn-model').title;
  const ctx = Number(state.settings.contextLength);
  if (!trained || ctx <= trained) return;
  const entry = catalogEntryFor(model);
  warnOnce(`ctx-over:${model}:${ctx}`, () =>
    toast({
      key: 'ctx',
      icon: 'alert',
      text: [el('b', { text: `${model} handles ${formatContext(trained)} tokens, but the context window is set to ${formatContext(ctx)}.` }), ' Past that it loses track of the conversation.' + (entry?.yarn ? ' A long-context (YaRN) build can go further.' : '')],
      actions: [
        { label: `Set to ${formatContext(trained)}`, onClick: async () => { state.settings = await api.setSettings({ contextLength: trained }); applySettingsToUi(); flash(`Context window: ${formatContext(trained)}`); } },
        entry?.yarn ? { label: 'Long-context builds', primary: true, onClick: () => openModels('long') } : null
      ].filter(Boolean)
    }));
}

function warnOnce(key, fn) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  fn();
}
