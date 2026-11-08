'use strict';

// Ollama inference nodes: the user can run Ollama on more than one PC (e.g. home and shop)
// and the app routes each local request to the first healthy node that has the requested
// model. This file is the pure logic — normalizing the `ollamaNodes` setting (including the
// migration from the single baseUrl), picking a node from health-check results, and telling
// connection failures apart from server errors. No DOM, no fetch: loaded as a plain <script>
// in the renderer and require()d by tests. The health checks themselves run in the main
// process (nodes:check), and the agent loop does the routing.

// "This PC" is implicit: it always exists, always first, and mirrors the Base URL and
// keep-alive from the Model settings so the two can never drift apart. A saved entry for it
// only remembers the enabled flag. Remote nodes are whatever the user added by URL.
const THIS_PC_ID = 'this-pc';

// Keep-alive a remote node uses when none was set on it. Remote boxes are usually shared
// machines, so by default they free their VRAM after 5 idle minutes instead of inheriting
// the global keep-alive (often -1 = pinned forever, which only makes sense on This PC).
const REMOTE_KEEP_DEFAULT = '5m';

function cleanUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

// A stable id for a remote node, derived from its URL so saved settings stay matched to it.
function nodeId(baseUrl) {
  return 'node-' + cleanUrl(baseUrl).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9.-]+/g, '-').toLowerCase();
}

function nodeName(n) {
  if (n.name && String(n.name).trim()) return String(n.name).trim();
  try {
    return new URL(cleanUrl(n.baseUrl)).host;
  } catch {
    return cleanUrl(n.baseUrl) || 'node';
  }
}

// The normalized node list for the current settings. Always at least one node ("This PC",
// built from the plain baseUrl — that is the migration), in saved order, This PC first.
function normalizeNodes(s) {
  const saved = Array.isArray(s.ollamaNodes) ? s.ollamaNodes.filter((n) => n && typeof n === 'object') : [];
  const savedThis = saved.find((n) => n.id === THIS_PC_ID);
  const thisPc = {
    id: THIS_PC_ID,
    name: 'This PC',
    baseUrl: cleanUrl(s.baseUrl) || 'http://localhost:11434',
    enabled: savedThis ? savedThis.enabled !== false : true,
    highPerf: savedThis?.highPerf === true,
    keepAlive: s.keepAlive
  };
  const remotes = saved
    .filter((n) => n.id !== THIS_PC_ID && cleanUrl(n.baseUrl))
    .map((n) => ({
      id: n.id || nodeId(n.baseUrl),
      name: nodeName(n),
      baseUrl: cleanUrl(n.baseUrl),
      enabled: n.enabled !== false,
      highPerf: n.highPerf === true,
      keepAlive: typeof n.keepAlive === 'string' && n.keepAlive.trim() ? n.keepAlive.trim() : REMOTE_KEEP_DEFAULT,
      ...(n.kind === 'lmstudio' ? { kind: 'lmstudio' } : {}),
      ...(typeof n.model === 'string' && n.model.trim() ? { model: n.model.trim() } : {}),
      ...(typeof n.draftModel === 'string' && n.draftModel.trim() ? { draftModel: n.draftModel.trim() } : {}),
      ...(Number(n.vramGB) > 0 ? { vramGB: Number(n.vramGB) } : {})
    }));
  return [thisPc, ...remotes];
}

// Whether routing is in play at all: it is, unless the enabled set is exactly the implicit
// "This PC" — then there is nothing to route and the app behaves exactly as it always did.
// Disabling This PC with one remote enabled MUST route (the user is saying "run on the
// other machine"), which a plain count-above-one check got wrong.
function multiNode(s) {
  const enabled = normalizeNodes(s).filter((n) => n.enabled);
  if (!enabled.length) return false;
  return !(enabled.length === 1 && enabled[0].id === THIS_PC_ID);
}

// Ollama tags come back like "qwen2.5-coder:7b"; a model with no tag means ":latest".
function sameModel(a, b) {
  const norm = (x) => {
    const t = String(x || '').trim();
    return t.includes(':') ? t : t ? `${t}:latest` : '';
  };
  return norm(a) !== '' && norm(a) === norm(b);
}

function nodeHasModel(h, model) {
  if (!h || h.up !== true || !Array.isArray(h.models)) return false;
  return h.models.some((m) => sameModel(m, model) || (h.kind === 'lmstudio' && looseSame(m, model)));
}

// Pick the node a request should run on. `health` maps node id -> {up, models}, `exclude`
// holds ids that already failed this task. First enabled healthy node that has the model;
// if none has it, the first enabled healthy node (Ollama then reports the missing model,
// same as today); if nothing is healthy, the first enabled node, so the user still gets
// the normal "could not connect" message rather than silence.
function pickNode(nodes, health, model, exclude) {
  const skip = exclude || new Set();
  const enabled = nodes.filter((n) => n.enabled && !skip.has(n.id));
  if (!enabled.length) return null;
  const healthy = enabled.filter((n) => health?.[n.id]?.up === true);
  return (
    healthy.find((n) => nodeHasModel(health[n.id], model)) ||
    healthy[0] ||
    enabled[0]
  );
}

// The next node to move to after `failedId` died mid-task: same rules, with the failed
// node(s) excluded, and it must actually be healthy — moving to another dead node would
// just burn the retry budget.
function nextNode(nodes, health, model, exclude) {
  const skip = exclude || new Set();
  const enabled = nodes.filter((n) => n.enabled && !skip.has(n.id) && health?.[n.id]?.up === true);
  if (!enabled.length) return null;
  return enabled.find((n) => nodeHasModel(health[n.id], model)) || enabled[0];
}

// When the current model has no catalog entry, a high-perf pick must still be a solidly
// strong model — anything rated below "Good" (rank 6) would not be an upgrade worth a handoff.
const HIGH_PERF_FLOOR = 5.9;

// The strongest catalog model installed on an enabled, healthy high-performance node that
// outranks the model currently running the task. This is the free escalation tier: when Qwen
// gets stuck, the next step runs here before any money goes to the cloud planner. `catalog`
// is MODEL_CATALOG (passed in so this stays pure for tests).
function pickHighPerf(nodes, health, currentModel, catalog) {
  const cat = catalog || [];
  const entryFor = (id) => cat.find((m) => sameModel(m.id, id)) || cat.find((m) => looseSame(m.id, id));
  const curRank = entryFor(currentModel)?.rank;
  const floor = typeof curRank === 'number' ? curRank : HIGH_PERF_FLOOR;
  let best = null;
  for (const n of nodes) {
    if (!n.enabled || !n.highPerf) continue;
    const h = health?.[n.id];
    if (!h || h.up !== true) continue;
    for (const m of h.models || []) {
      const e = entryFor(m);
      if (!e || e.rank <= floor) continue;
      if (!best || e.rank > best.rank) best = { node: n, model: h.kind === 'lmstudio' ? m : e.id, rank: e.rank, kind: h.kind || 'ollama' };
    }
  }
  return best;
}

// ---------- LM Studio nodes (from LM Studio's API: lmstudio-ai/docs) ----------
// A node can run LM Studio's server (the app, or the headless `lms daemon up`) instead of Ollama.
// Model names differ ("qwen3:14b" in Ollama, "qwen/qwen3-14b" in LM Studio), so they are matched
// on a loose key; requests carry LM Studio's `ttl` (idle unload, from the node's keep-alive) and,
// when set, a `draft_model` for speculative decoding — a small same-family model proposes tokens
// the big one verifies, typically 1.5–2× faster generation with identical output.

// "qwen3:14b", "qwen/qwen3-14b", "Qwen3-14B-GGUF" → "qwen3-14b"; "qwen2.5-coder:7b" and
// "qwen2.5-coder-7b-instruct" → "qwen2-5-coder-7b".
function looseModelKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replace(/:latest$/, '')
    .replace(/[:_.\s]+/g, '-')
    .replace(/-(instruct|it|chat|gguf|mlx)(?=-|$)/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
const looseSame = (a, b) => !!a && !!b && looseModelKey(a) === looseModelKey(b);

// The LM Studio model key to run for `model` on a node: its own pinned model when set, else the
// key that loosely matches the global model name, else null.
function lmModelFor(model, keys, pinned) {
  const list = keys || [];
  if (pinned && list.includes(pinned)) return pinned;
  return list.find((k) => k === model) || list.find((k) => looseSame(k, model)) || null;
}

// Ollama-style keep-alive ("5m", "1h", "30s", "300") → LM Studio ttl seconds; null = no ttl.
function ttlSeconds(keepAlive) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$/i.exec(String(keepAlive ?? ''));
  if (!m) return null;
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2].toLowerCase()] || 1);
  return n > 0 ? Math.round(n) : null;
}

// Billions of parameters from "14B", "0.6B", or a name like "qwen3-1.7b".
function paramsB(m) {
  const fromString = /(\d+(?:\.\d+)?)\s*b\b/i.exec(String(m?.params || m?.params_string || ''));
  const fromKey = /(?:^|[-_/:])(\d+(?:\.\d+)?)b(?=$|[-_])/i.exec(String(m?.key || ''));
  const v = Number((fromString || fromKey || [])[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}
const familyKey = (key) => looseModelKey(key).replace(/-\d+(?:-\d+)?b(?=-|$)/, '').replace(/-a\d+b/, '');

// "Auto" draft model: same family, an LLM, at most a quarter of the main model's size (LM
// Studio's guideline: 7B → ≤1B, 14B → ≤3B) — the largest such, since bigger drafts guess better.
function suggestDraft(mainKey, lmModels) {
  const list = lmModels || [];
  const main = list.find((m) => m.key === mainKey) || { key: mainKey };
  const size = paramsB(main);
  if (!size) return null;
  const fam = familyKey(mainKey);
  const fits = list
    .filter((m) => m.key !== mainKey && (m.type || 'llm') === 'llm' && familyKey(m.key) === fam)
    .map((m) => ({ key: m.key, b: paramsB(m) }))
    .filter((m) => m.b && m.b <= size / 4);
  fits.sort((a, b) => b.b - a.b);
  return fits[0]?.key || null;
}

// The per-request override for routing a step to `node`. Ollama This PC: none (the global
// settings already point at it). Ollama remote: its URL and keep-alive. LM Studio: provider,
// /v1 URL, the resolved model key, ttl and draft model. `model` is the model the step wants.
function nodeOverride(node, health, model) {
  if ((health?.kind || node.kind) === 'lmstudio') {
    const key = lmModelFor(model, health?.models, node.model) || node.model || model;
    const draft = node.draftModel === 'auto' ? suggestDraft(key, health?.lmModels) : node.draftModel && (health?.models || []).includes(node.draftModel) ? node.draftModel : null;
    return { provider: 'lmstudio', baseUrl: `${cleanUrl(node.baseUrl).replace(/\/v1$/, '')}/v1`, apiKey: '', model: key, ttl: ttlSeconds(node.keepAlive), draftModel: draft || undefined };
  }
  if (node.id === THIS_PC_ID) return null;
  return { baseUrl: node.baseUrl, keepAlive: node.keepAlive };
}

// A request that never reached a server, as opposed to a server that answered with an
// error (HTTP 404/429/503 stay with the model-failover logic in toolparse.js).
const CONN_ERROR = /could not connect to|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT|UND_ERR_SOCKET|HeadersTimeout|BodyTimeout|socket hang up|fetch failed|terminated/i;

function isConnectionError(msg) {
  const t = String(msg || '');
  if (/HTTP \d{3}/.test(t)) return false;
  return CONN_ERROR.test(t);
}

// Status-bar summary: how many enabled nodes are up, plus a per-node detail line.
function summarize(nodes, health) {
  const enabled = nodes.filter((n) => n.enabled);
  const up = enabled.filter((n) => health?.[n.id]?.up === true).length;
  const detail = nodes
    .map((n) => {
      const h = health?.[n.id];
      const mark = !n.enabled ? 'off' : h?.up === true ? 'up' : h ? 'down' : '?';
      const count = h?.up && Array.isArray(h.models) ? `, ${h.models.length} models` : '';
      return `${n.name}: ${mark}${count}`;
    })
    .join('\n');
  return { up, total: enabled.length, detail };
}

// GPU spill: Ollama's /api/ps lists each loaded model with its total size and the part in GPU
// memory (size_vram). Under ~95% in VRAM means layers run on the CPU — the usual reason a
// model "got slow" (an idea from Strata's run preview). Null when the model isn't loaded or
// fits; otherwise how much fits.
function spillInfo(psModels, model) {
  const m = (psModels || []).find((x) => sameModel(x.name || x.model, model));
  if (!m || !(m.size > 0)) return null;
  const vram = Number(m.size_vram) || 0;
  if (vram >= m.size * 0.95) return null;
  const gb = (b) => Math.round((b / 1e9) * 10) / 10;
  return { gpuGB: gb(vram), totalGB: gb(m.size), pct: Math.round((vram / m.size) * 100) };
}

// "Fit to GPU": the largest context window (a multiple of 1024) that keeps the whole model in
// GPU memory, from one /api/ps entry (size = weights + KV cache at `ctx`, size_vram = what the
// GPU held) and the model file's size from /api/tags (≈ the weights). The KV cache grows
// linearly with the context, so its per-token cost is (size − weights) / ctx. Null when it
// already fits or the numbers can't tell; { tooSmall } when even 4K would not fit.
const FIT_MIN_CTX = 4096;
function fitContext(ps, ctx) {
  const size = Number(ps?.size) || 0;
  const vram = Number(ps?.size_vram) || 0;
  const weights = Number(ps?.file_size) || 0;
  const n = Number(ps?.context_length) || Number(ctx) || 0;
  if (!size || !weights || !n || vram >= size * 0.95) return null;
  const perToken = (size - weights) / n;
  if (!(perToken > 0)) return null;
  const fits = Math.floor(((vram * 0.97 - weights) / perToken) / 1024) * 1024;
  if (fits < FIT_MIN_CTX) return { tooSmall: true };
  return fits < n ? { ctx: fits } : null;
}

// Predicting the fit BEFORE loading (the way LM Studio's `lms load --estimate-only` does), from
// Ollama's /api/show model_info: the KV cache costs, per token, K and V for every layer and
// KV head at 2 bytes (f16). Null when the architecture fields are missing, or the model uses a
// sliding window (most layers then cache far less, and the estimate would cry wolf).
function kvBytesPerToken(info) {
  if (!info || typeof info !== 'object') return null;
  const arch = info['general.architecture'];
  const get = (k) => info[`${arch}.${k}`];
  if (!arch || get('attention.sliding_window')) return null;
  // Hybrid attention (Qwen3-Next, Qwen3.5/3.6): only every Nth layer is full attention and keeps
  // a KV cache; the others are linear-attention layers with a small fixed state. Counting every
  // layer would put a 256K-context model's cache at about four times its real size.
  const every = Number(get('full_attention_interval'));
  const blocks = Number(get('block_count'));
  const layers = every > 1 ? Math.ceil(blocks / every) : blocks;
  const heads = Number(get('attention.head_count'));
  const kvRaw = get('attention.head_count_kv') ?? heads;
  const kvHeads = Array.isArray(kvRaw) ? kvRaw.reduce((a, b) => a + Number(b), 0) / kvRaw.length : Number(kvRaw);
  const kDim = Number(get('attention.key_length')) || (Number(get('embedding_length')) / heads);
  const vDim = Number(get('attention.value_length')) || kDim;
  const per = layers * kvHeads * (kDim + vDim) * 2;
  return Number.isFinite(per) && per > 0 ? per : null;
}

// Mixture-of-experts models (qwen3-coder:30b is 30B with ~3B active per token) run tolerably
// with part of their weights on the CPU, so spill warnings must not tell users to abandon them.
function isMoE(info) {
  const arch = info?.['general.architecture'];
  return !!arch && Number(info[`${arch}.expert_count`]) > 1;
}

// Will `weights` bytes + the KV cache at `ctx` (+ ~0.5 GB of compute buffers) fit in `vram`?
// { fits, neededGB, vramGB } plus fitCtx (the largest that fits) or tooSmall when not.
const FIT_OVERHEAD = 0.5e9;
function predictFit({ weights, kvPerToken, ctx, vram }) {
  if (!(weights > 0) || !(kvPerToken > 0) || !(ctx > 0) || !(vram > 0)) return null;
  const gb = (b) => Math.round((b / 1e9) * 10) / 10;
  const needed = weights + kvPerToken * ctx + FIT_OVERHEAD;
  const room = vram * 0.95;
  const out = { fits: needed <= room, neededGB: gb(needed), vramGB: gb(vram) };
  if (out.fits) return out;
  const fitCtx = Math.floor((room - FIT_OVERHEAD - weights) / kvPerToken / 1024) * 1024;
  return fitCtx >= FIT_MIN_CTX ? { ...out, fitCtx } : { ...out, tooSmall: true };
}

// Fit to GPU on its own (agent-loop.js): the context window to apply when a dense model would
// spill onto the CPU, or null. A mixture-of-experts model stays usable spilled, and a window
// under AGENT_MIN_CTX cannot hold the agent's instructions plus a task, so neither is fitted —
// the task says to pick a smaller model instead. (A field report: a 14B model at 69% in GPU
// took 2 to 10 minutes a step for 52 minutes and died on a timeout; the app had only warned.)
const AGENT_MIN_CTX = 8192;
// `min`: the smallest window worth fitting to for this conversation — the app's own fixed
// prompt (instructions + tool definitions) must stay under 60% of it, or the overflow check
// would tell the user to raise the window right after it was lowered.
function autoFitContext(fitCtx, { moe, enabled, min } = {}) {
  if (enabled === false || moe) return null;
  const ctx = Number(fitCtx) || 0;
  return ctx >= Math.max(AGENT_MIN_CTX, Number(min) || 0) ? ctx : null;
}

// The floor for a fixed prompt of `fixedTokens`: 60% of the window, rounded up to 512.
function minAgentCtx(fixedTokens) {
  const need = Math.ceil((Number(fixedTokens) || 0) / 0.6 / 512) * 512;
  return Math.max(AGENT_MIN_CTX, need);
}

// When the chosen model cannot fit at all: the strongest installed catalog model that would,
// at this window, on this GPU — named in the advice instead of "pick a smaller model".
function fittingAlternative(installed, catalog, { ctx, vram, exclude } = {}) {
  if (!(vram > 0) || !(ctx > 0)) return null;
  const room = vram * 0.95 - FIT_OVERHEAD;
  let best = null;
  for (const m of installed || []) {
    if (exclude && (sameModel(m, exclude) || looseSame(m, exclude))) continue;
    const e = (catalog || []).find((c) => sameModel(c.id, m)) || (catalog || []).find((c) => looseSame(c.id, m));
    if (!e || !(e.sizeGB > 0)) continue;
    if (e.sizeGB * 1e9 + (e.kvKB || 0) * 1024 * ctx > room) continue;
    if (!best || e.rank > best.rank) best = e;
  }
  return best ? best.id : null;
}

// Per-model tool-call check (Strata's `connect --check`): one "reply with exactly: pong" prompt
// and one get_weather call, graded on the answer text and the call's arguments — not just on
// the server answering. Says up front which model actually does tool calls on which node.
const PROBE_PROMPT = 'Reply with exactly one word: pong';
const PROBE_TOOL_PROMPT = 'What is the weather in Paris? Use the get_weather tool.';
const PROBE_TOOL = { type: 'function', function: { name: 'get_weather', description: 'Weather of a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };

function probeVerdict(promptText, toolMessage) {
  const said = String(promptText || '').trim();
  const prompt = /\bpong\b/i.test(said)
    ? { ok: true, detail: `It answered "${said.slice(0, 40)}".` }
    : { ok: false, detail: said ? `It answered "${said.slice(0, 40)}", not the word asked for.` : 'It replied with no text.' };
  const calls = toolMessage?.tool_calls || [];
  const argsOf = (tc) => (typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}));
  const hit = calls.find((tc) => tc.function?.name === 'get_weather' && /paris/i.test(argsOf(tc)));
  let tool;
  if (hit) tool = { ok: true, detail: `It called get_weather with ${argsOf(hit).slice(0, 60)}.` };
  else if (calls.length) tool = { ok: false, detail: `It called ${calls[0].function?.name} with ${argsOf(calls[0]).slice(0, 60)}, not the city asked for.` };
  else if (/<tool_call>|"name"\s*:\s*"get_weather"/.test(String(toolMessage?.content || ''))) tool = { ok: false, textOnly: true, detail: 'It wrote the call as text, not as a real tool call — QWS can usually parse that, but agent work will be less reliable.' };
  else tool = { ok: false, detail: 'It answered in words and did not call the tool.' };
  return { ok: prompt.ok && tool.ok, prompt, tool };
}

// Ollama's model runner died mid-request (a field report: "CUDA error: an illegal memory
// access was encountered" on a 30B model filling a 10 GB card). The server itself is fine and
// reloads the model on the next request, so this is worth a retry — unlike a model error.
const RUNNER_CRASH = /CUDA error|illegal memory access|cudaMalloc|CUBLAS_STATUS|ROCm error|hipError|llama runner (process )?(has )?terminated|model runner has unexpectedly stopped|runner process (has )?(terminated|no longer running)|GGML_ASSERT|ggml_metal|exit status 0x?c0000409|signal: (killed|segmentation fault|aborted)/i;
const OUT_OF_MEMORY = /out of memory|cudaMalloc failed|failed to allocate|insufficient memory|requires more system memory/i;

// The model file on disk is damaged or incomplete (an interrupted download, a disk error):
// llama.cpp cannot read it, so every request fails at once and a reload changes nothing.
const MODEL_DAMAGED = /error loading model|unable to load model|failed to load model|model is corrupted|corrupted or incomplete|not within the file bounds|wrong number of tensors|failed to read (?:magic|header|tensor|key)|invalid (?:gguf )?magic|gguf_init_from_file\w*: (?:failed|invalid)|unexpected end of file|digest mismatch|missing tensor|tensor '[^']*' has wrong shape/i;
function isModelDamaged(msg) {
  const t = String(msg || '');
  // "error loading model: unable to allocate CUDA buffer" is memory, not a damaged file.
  return MODEL_DAMAGED.test(t) && !OUT_OF_MEMORY.test(t) && !/CUDA|cudaMalloc|allocate|VRAM|ROCm|Metal/i.test(t);
}

// What helps: download the model again (Ollama), or re-download it in LM Studio.
function damagedAdvice(model, where = 'This PC', provider = 'ollama') {
  if (provider === 'lmstudio') return `${model} could not be loaded on ${where}: its model file looks damaged or incomplete. In LM Studio, delete the model under My Models and download it again.`;
  return `${model} could not be loaded on ${where}: its model file looks damaged or incomplete, so every request fails at once. Download it again on ${where}: in a terminal run "ollama rm ${model}" and then "ollama pull ${model}".`;
}

function isRunnerCrash(msg) {
  const t = String(msg || '');
  return RUNNER_CRASH.test(t) || OUT_OF_MEMORY.test(t);
}

// What to tell the user once retries ran out: the likely cause in plain words and what helps.
function crashAdvice(msg, model, runner = "Ollama's GPU runner") {
  const t = String(msg || '');
  if (OUT_OF_MEMORY.test(t)) return `The GPU ran out of memory running ${model}. Lower "Context window" in Settings → Model, close other programs using the GPU, or pick a smaller model.`;
  return `${runner} crashed while running ${model} (${(/CUDA error[^.\n]*|illegal memory access[^.\n]*|GGML_ASSERT[^.\n]*|runner[^.\n]*/i.exec(t) || [t.slice(0, 80)])[0].trim()}). This is usually a model-server or GPU-driver bug that shows up when a model does not fit fully in VRAM: update the server (Ollama, LM Studio) and the GPU driver, lower "Context window" in Settings → Model, or run this model on another node.`;
}

const NodesExports = { isModelDamaged, damagedAdvice, isRunnerCrash, crashAdvice, THIS_PC_ID, REMOTE_KEEP_DEFAULT, nodeId, normalizeNodes, multiNode, sameModel, nodeHasModel, pickNode, nextNode, pickHighPerf, spillInfo, fitContext, kvBytesPerToken, predictFit, autoFitContext, minAgentCtx, AGENT_MIN_CTX, fittingAlternative, isMoE, looseModelKey, looseSame, lmModelFor, ttlSeconds, suggestDraft, nodeOverride, probeVerdict, PROBE_PROMPT, PROBE_TOOL_PROMPT, PROBE_TOOL, isConnectionError, summarize };
if (typeof module !== 'undefined' && module.exports) module.exports = NodesExports;
if (typeof window !== 'undefined') window.Nodes = NodesExports;
