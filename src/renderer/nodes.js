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
      keepAlive: typeof n.keepAlive === 'string' && n.keepAlive.trim() ? n.keepAlive.trim() : REMOTE_KEEP_DEFAULT
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
  return !!h && h.up === true && Array.isArray(h.models) && h.models.some((m) => sameModel(m, model));
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
  const entryFor = (id) => cat.find((m) => sameModel(m.id, id));
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
      if (!best || e.rank > best.rank) best = { node: n, model: e.id, rank: e.rank };
    }
  }
  return best;
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

const NodesExports = { THIS_PC_ID, REMOTE_KEEP_DEFAULT, nodeId, normalizeNodes, multiNode, sameModel, nodeHasModel, pickNode, nextNode, pickHighPerf, spillInfo, fitContext, probeVerdict, PROBE_PROMPT, PROBE_TOOL_PROMPT, PROBE_TOOL, isConnectionError, summarize };
if (typeof module !== 'undefined' && module.exports) module.exports = NodesExports;
if (typeof window !== 'undefined') window.Nodes = NodesExports;
