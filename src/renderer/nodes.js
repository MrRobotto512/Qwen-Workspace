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
    keepAlive: s.keepAlive
  };
  const remotes = saved
    .filter((n) => n.id !== THIS_PC_ID && cleanUrl(n.baseUrl))
    .map((n) => ({
      id: n.id || nodeId(n.baseUrl),
      name: nodeName(n),
      baseUrl: cleanUrl(n.baseUrl),
      enabled: n.enabled !== false,
      keepAlive: typeof n.keepAlive === 'string' && n.keepAlive.trim() ? n.keepAlive.trim() : undefined
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

const NodesExports = { THIS_PC_ID, nodeId, normalizeNodes, multiNode, sameModel, nodeHasModel, pickNode, nextNode, isConnectionError, summarize };
if (typeof module !== 'undefined' && module.exports) module.exports = NodesExports;
if (typeof window !== 'undefined') window.Nodes = NodesExports;
