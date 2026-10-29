'use strict';
// ===================================================================
// Models for this PC
// ===================================================================
async function showModelMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  let models = [];
  try {
    models = await api.listModels();
  } catch {
    /* server not reachable */
  }
  const items = models.slice(0, 14).map((id) => ({
    label: id,
    checked: id === state.settings.model,
    onClick: async () => {
      state.settings = await api.setSettings({ model: id, modelPicked: true });
      applySettingsToUi();
      checkConnection();
      flash(`Model: ${id}`);
    }
  }));
  if (items.length) items.push('-');
  items.push({ label: 'Models for this PC…', icon: 'cpu', onClick: () => openModels('standard') });
  items.push({ label: 'Long context (YaRN)…', icon: 'book', onClick: () => openModels('long') });
  items.push({ label: 'Model settings…', icon: 'settings', onClick: openSettings });
  showMenu(r.right - 240, r.bottom + 4, items);
}

async function openModels(mode) {
  if (typeof mode === 'string') state.modelsMode = mode;
  $('#settings-modal').classList.add('hidden');
  $('#models-modal').classList.remove('hidden');
  if (!state.specs) $('#m-list').replaceChildren(el('div', { class: 'quick-empty', text: 'Checking this PC…' }));
  const [specs, tags] = await Promise.all([api.systemSpecs(), api.ollamaTags()]);
  state.specs = specs;
  state.tags = tags;
  renderModels();
  renderOtherNodes();
  refreshNodeHealth(true).then(renderOtherNodes);
}

// Read-only view of what each remote Ollama node has installed. Downloading and the
// hardware-fit estimates stay about this PC; a remote node manages its own models.
function renderOtherNodes() {
  const box = $('#m-nodes');
  if (!box) return;
  const s = state.settings;
  const remotes = s.provider === 'ollama' ? Nodes.normalizeNodes(s).filter((n) => n.id !== Nodes.THIS_PC_ID) : [];
  if (!remotes.length) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    el('div', { class: 'section-title', text: 'Other nodes' }),
    ...remotes.map((n) => {
      const h = state.nodeHealth.byId[n.id];
      const models = h?.up ? h.models || [] : [];
      return el('div', { class: 'mcp-item' },
        el('span', { class: `dot ${!n.enabled ? '' : h?.up ? 'ready' : 'error'}` }),
        el('div', { class: 'mcp-main' },
          el('div', { class: 'mcp-name', text: `${n.name}${n.enabled ? '' : ' (disabled)'}` }),
          el('div', {
            class: 'mcp-sub',
            title: models.join('\n'),
            text: !n.enabled && !h ? n.baseUrl : h?.up ? (models.length ? models.join(', ') : 'No models downloaded') : `Not reachable${h?.error ? `: ${h.error}` : ''}`
          })));
    }));
}

function installedNames() {
  return new Set((state.tags?.models || []).map((m) => m.name));
}

function renderModels() {
  const specs = state.specs;
  if (!specs) return;
  const tags = state.tags || { running: false };
  const [gpuText, ramText, cpuText] = describeSpecs(specs);
  $('#m-specs').replaceChildren(
    el('span', { class: `spec-chip${specs.gpu ? ' gpu' : ' warn'}`, title: specs.gpus.map((g) => `${g.name}: ${formatGB(g.vramGB)}`).join('\n') || 'No GPU detected' }, iconEl('cpu'), gpuText),
    el('span', { class: 'spec-chip' }, ramText),
    el('span', { class: 'spec-chip', title: specs.cpu }, cpuText),
    el('button', { class: 'icon-btn', title: 'Scan again', onclick: async () => { state.specs = await api.systemSpecs(true); state.tags = await api.ollamaTags(); renderModels(); } }, iconEl('refresh'))
  );

  const usingOllama = state.settings.provider === 'ollama';
  let notice;
  if (!tags.running) {
    notice = el('div', { class: 'notice warn' }, iconEl('alert'),
      el('span', { class: 'grow', text: "Ollama isn't running. It downloads and runs these models on this PC. Install it (or start it), then refresh." }),
      el('button', { class: 'ghost', onclick: async () => { state.tags = await api.ollamaTags(); renderModels(); } }, iconEl('refresh'), 'Refresh'),
      el('button', { class: 'primary', onclick: () => api.openExternal('https://ollama.com/download') }, 'Get Ollama'));
  } else if (!usingOllama) {
    notice = el('div', { class: 'notice' }, iconEl('info'),
      el('span', { class: 'grow', text: 'You are using a different provider. Choosing a model here switches the app to Ollama on this PC.' }));
  } else {
    const n = tags.models.length;
    notice = el('div', { class: 'notice ok' }, iconEl('check'),
      el('span', { class: 'grow', text: `Ollama is running with ${n} model${n === 1 ? '' : 's'} downloaded.` }));
  }
  const notices = [notice];
  if (!specs.gpu) {
    notices.push(el('div', { class: 'notice' }, iconEl('info'),
      el('span', { class: 'grow', text: 'Without a supported GPU, local models run on the CPU and respond slowly. For faster answers, use Qwen through a cloud provider (DashScope or OpenRouter) in Settings.' }),
      el('button', { class: 'ghost', onclick: openSettings }, 'Open Settings')));
  }
  $('#m-ollama').replaceChildren(...notices);

  $$('#m-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.modelsMode));
  const fitOrder = { gpu: 3, mixed: 2, cpu: 1, none: 0 };
  if (state.modelsMode === 'long') {
    notices.push(el('div', { class: 'notice' }, iconEl('info'),
      el('span', { class: 'grow', text: "YaRN stretches a model's position encoding so it can read past the 32K tokens it was trained on, up to 128K. Ollama can't switch YaRN on by itself, so these are separate downloads with YaRN built in (Unsloth's builds on Hugging Face). Qwen notes YaRN can slightly lower quality on short prompts: use these for big tasks and keep a standard model for everyday work. Tip: setting OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 for Ollama roughly halves the memory long contexts need." })));
    $('#m-ollama').replaceChildren(...notices);
    const { models, recommended } = recommendLongContext(specs);
    const sorted = [...models].sort((a, b) => (b.id === recommended?.id) - (a.id === recommended?.id) || fitOrder[b.fit] - fitOrder[a.fit] || b.rank - a.rank);
    $('#m-list').replaceChildren(...sorted.map((plan) => modelRow(longVariant(plan), plan.id === recommended?.id, false)));
    return;
  }
  const { models, recommended, stronger } = recommendModels(specs);
  const sorted = [...models].sort((a, b) => {
    const pri = (m) => (m.id === recommended?.id ? 2 : m.id === stronger?.id ? 1 : 0);
    return pri(b) - pri(a) || fitOrder[b.fit] - fitOrder[a.fit] || b.rank - a.rank;
  });
  $('#m-list').replaceChildren(...sorted.map((m) => modelRow(m, m.id === recommended?.id, m.id === stronger?.id)));
}

// The row to show for a long-context plan: the regular model when its native context is
// enough, otherwise its YaRN build from Hugging Face (looked up on first view).
function longVariant(plan) {
  const detail = plan.needsYarn
    ? `trained on ${formatContext(plan.nativeCtx)} · YaRN ×${Math.round(plan.yarn.maxCtx / plan.nativeCtx)}`
    : `native ${formatContext(plan.nativeCtx)}, no YaRN needed`;
  if (!plan.needsYarn) return { ...plan, ctxDetail: detail };
  const hf = state.hf.get(plan.yarn.repo);
  if (!hf) resolveHf(plan.yarn.repo);
  return {
    ...plan,
    id: hf?.status === 'ok' ? hf.ollamaId : null,
    displayId: hf?.status === 'ok' ? hf.ollamaId : `hf.co/${plan.yarn.repo}`,
    name: `${plan.name} ${formatContext(plan.yarn.maxCtx)}`,
    sizeGB: hf?.sizeGB || plan.sizeGB,
    hf: hf || { status: 'loading' },
    yarnBuild: true,
    ctxDetail: detail
  };
}

async function resolveHf(repo) {
  if (state.hf.has(repo)) return;
  state.hf.set(repo, { status: 'loading' });
  let r;
  try {
    r = await api.hfResolve(repo);
  } catch (e) {
    r = { status: 'error', error: cleanError(e) };
  }
  state.hf.set(repo, r);
  if (!$('#models-modal').classList.contains('hidden') && state.modelsMode === 'long') renderModels();
}

function modelRow(m, isRec, isStrong) {
  const installed = !!m.id && installedNames().has(m.id);
  const inUse = installed && state.settings.provider === 'ollama' && state.settings.model === m.id && (!m.ctxDetail || state.settings.contextLength === m.ctx);
  const row = el('div', { class: `m-row${isRec ? ' rec' : ''}${m.fit === 'none' ? ' none' : ''}`, dataset: { model: m.id || m.displayId } },
    el('div', { class: 'm-title' },
      el('span', { class: 'name', text: m.name }),
      el('span', { class: 'id', text: m.displayId || m.id }),
      m.yarnBuild ? el('span', { class: 'tagb yarn', text: 'YaRN' }) : null,
      isRec ? el('span', { class: 'tagb rec', text: 'Recommended' }) : null,
      isStrong ? el('span', { class: 'tagb strong', text: 'Most capable that runs' }) : null,
      inUse ? el('span', { class: 'tagb use', text: 'In use' }) : installed ? el('span', { class: 'tagb inst', text: 'Downloaded' }) : null),
    el('div', { class: 'm-facts' },
      el('span', { class: `fit ${m.fit}`, text: FIT_INFO[m.fit].label }),
      el('span', { text: `${formatGB(m.sizeGB)} download` }),
      el('span', { text: `${formatContext(m.ctx)} context`, title: `Needs about ${formatGB(m.needGB)} of memory at this context size` }, m.ctxDetail ? el('span', { class: 'ctx-detail', text: ` (${m.ctxDetail})` }) : null),
      el('span', { text: `Agent: ${m.agent}` })),
    el('div', { class: 'm-note', text: m.note }),
    el('div', { class: 'm-act' }));
  renderModelAction(row, m, installed, inUse, isRec || isStrong);
  return row;
}

function renderModelAction(row, m, installed, inUse, highlight) {
  const act = row.querySelector('.m-act');
  if (m.yarnBuild && !m.id) {
    const st = m.hf.status;
    act.replaceChildren(
      st === 'error'
        ? el('button', { class: 'ghost', title: m.hf.error, onclick: () => { state.hf.delete(m.yarn.repo); renderModels(); } }, iconEl('refresh'), 'Retry')
        : el('button', { class: 'ghost', disabled: true, title: st === 'missing' ? `No 4-bit GGUF found in ${m.yarn.repo}` : '' }, st === 'loading' ? 'Checking Hugging Face…' : 'Not available'),
      ...(st === 'error' ? [el('div', { class: 'ptext', text: "Couldn't reach Hugging Face" })] : []));
    return;
  }
  const pull = state.pulls.get(m.id);
  if (pull) {
    const pct = pull.total ? Math.round((pull.completed / pull.total) * 100) : 0;
    act.replaceChildren(
      el('div', { class: 'progress' }, el('i', { style: `width:${pct}%` })),
      el('div', { class: 'ptext', text: pullText(pull) }),
      el('button', { class: 'ghost', onclick: () => api.ollamaPullCancel(m.id) }, 'Cancel'));
  } else if (inUse) {
    act.replaceChildren(el('button', { class: 'ghost', disabled: true }, iconEl('check'), 'In use'));
  } else if (installed) {
    act.replaceChildren(el('button', { class: 'primary', onclick: () => useModel(m) }, m.ctxDetail ? `Use at ${formatContext(m.ctx)}` : 'Use'));
  } else {
    act.replaceChildren(el('button', {
      class: highlight ? 'primary' : 'ghost',
      disabled: !state.tags?.running,
      title: state.tags?.running ? `Download ${m.id} with Ollama` : 'Start Ollama first',
      onclick: () => downloadModel(m)
    }, iconEl('download'), `Download ${formatGB(m.sizeGB)}`));
  }
}

function pullText(p) {
  if (p.status === 'downloading' || (p.total && /^pulling [0-9a-f]/.test(p.status))) {
    return `${formatGB((p.completed || 0) / 1e9)} of ${formatGB((p.total || 0) / 1e9)}`;
  }
  return (p.status || 'Starting').replace(/^\w/, (c) => c.toUpperCase());
}

api.onPullProgress((p) => {
  const cur = state.pulls.get(p.model);
  if (!cur) return;
  Object.assign(cur, p);
  const row = $(`#m-list .m-row[data-model="${CSS.escape(p.model)}"]`);
  if (!row) return;
  const pct = cur.total ? Math.round((cur.completed / cur.total) * 100) : 0;
  const bar = row.querySelector('.progress i');
  if (bar) {
    bar.style.width = `${pct}%`;
    row.querySelector('.ptext').textContent = pullText(cur);
  }
});

async function downloadModel(m) {
  if (state.pulls.has(m.id)) return;
  state.pulls.set(m.id, { status: 'starting', completed: 0, total: 0 });
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
  flash(`Downloading ${m.id}…`);
  const res = await api.ollamaPull(m.id);
  state.pulls.delete(m.id);
  state.tags = await api.ollamaTags();
  if (res.ok) {
    const entry = state.specs ? recommendModels(state.specs).models.find((x) => x.id === m.id) : null;
    const target = m.ctx ? m : entry || m;
    toast({
      key: `pull-${m.id}`,
      icon: 'check',
      text: [el('b', { text: m.name || m.id }), ' is downloaded.'],
      actions: state.settings.model === m.id && state.settings.provider === 'ollama' ? [] : [{ label: 'Use it', primary: true, onClick: () => useModel(target) }],
      timeout: 20000
    });
    checkConnection();
  } else if (!res.cancelled) {
    toast({ key: `pull-${m.id}`, icon: 'alert', text: `Downloading ${m.id} failed: ${res.error}` });
  }
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
}

async function useModel(m) {
  const base = state.tags?.base || 'http://localhost:11434';
  const patch = { provider: 'ollama', baseUrl: `${base}/v1`, model: m.id, modelPicked: true };
  if (m.ctx) patch.contextLength = m.ctx;
  state.settings = await api.setSettings(patch);
  applySettingsToUi();
  checkConnection();
  if (!$('#models-modal').classList.contains('hidden')) renderModels();
  flash(`Using ${m.id}${m.ctx ? ` · ${formatContext(m.ctx)} context` : ''}`);
}
