'use strict';

// Keep the model server's prompt cache (v0.64, ideas from Strata's engine, github.com/Niko1221/
// Strata, MIT). Ollama (0.30+ runs llama.cpp's llama-server), LM Studio and Strata keep the
// prompt they last read and only read again from the first byte that changed. An agent task
// sends the whole conversation every step, so anything QWS changes near the start of the
// request — the tool list, which Qwen's template puts in the system turn, or an old message —
// makes the server re-read 10–40K tokens, tens of seconds on a 12 GB card. These helpers keep
// that start stable, keep the model loaded through long pauses, and read how much was reused.
// Pure: no DOM.

(() => {
// ---------- tool_search: load few tools, so the tool list settles ----------
// Loading a tool changes the tool list at the top of the prompt (one full re-read). Loading
// only what the query names, not every loose match, means fewer, rarer changes.
const MAX_LOAD = 4;
function pickTools(catalog, query, max = MAX_LOAD) {
  const q = String(query || '').toLowerCase().trim();
  const words = q.split(/[^a-z0-9_]+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const scored = (catalog || []).map((t) => {
    const name = String(t.function?.name || '').toLowerCase();
    const desc = String(t.function?.description || '').toLowerCase();
    let score = 0;
    if (name === q || words.includes(name)) score += 100;
    for (const w of words) {
      if (name.includes(w)) score += 10;
      else if (desc.includes(w)) score += 1;
    }
    return { t, score };
  }).filter((x) => x.score > 0);
  const byName = scored.filter((x) => x.score >= 10);
  const pool = byName.length ? byName : scored;
  return pool.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.t);
}

// MCP servers and their tools in a fixed order (by server id, then tool name): servers finish
// starting in any order, and a different order is a different prompt.
function sortedServers(servers) {
  return [...(servers || [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((s) => ({ ...s, tools: [...(s.tools || [])].sort((a, b) => String(a.name).localeCompare(String(b.name))) }));
}

// ---------- keep the model loaded while a task runs ----------
// A remote node unloads its model after 5 idle minutes by default; a long build or a wait for
// an approval inside a task then costs a reload of 18–23 GB plus a full re-read. While a task
// runs, a node keeps its model at least this long.
const TASK_KEEP = '30m';
function durationSec(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (/^-\d/.test(s)) return Infinity; // -1: stay loaded
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[(m[2] || 's').toLowerCase()]);
}
function taskKeepAlive(keepAlive) {
  const have = durationSec(keepAlive);
  if (have === null) return TASK_KEEP;
  return have >= durationSec(TASK_KEEP) ? keepAlive : TASK_KEEP;
}

// ---------- Ollama version ----------
// 0.30 runs llama.cpp's llama-server, whose --fit puts a mixture-of-experts model's experts in
// RAM and the rest on the cards when it does not fit (what Strata does); 0.34 also reports how
// much of each prompt came from its cache.
const MOE_FIT_VERSION = '0.30.0';
const CACHE_STATS_VERSION = '0.34.0';
function parseVersion(v) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function versionAtLeast(v, min) {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
// The advice for a node's Ollama version, or '' when it is new enough or unknown.
function versionAdvice(version, where = 'This PC') {
  const ok = versionAtLeast(version, MOE_FIT_VERSION);
  if (ok !== false) return '';
  return `Ollama ${version} on ${where} is older than ${MOE_FIT_VERSION}. Ollama ${MOE_FIT_VERSION} and newer run llama.cpp's server, which keeps a large mixture-of-experts model's experts in RAM and the rest on the graphics cards when it does not fit (the trick Strata uses), and lets QWS show how much of each prompt was reused. Update Ollama on ${where} (ollama.com/download).`;
}

// ---------- the KV cache type a node uses ----------
// Ollama does not say which KV cache type it runs with (OLLAMA_KV_CACHE_TYPE is server-wide),
// but a loaded model's size shows it: (size − file size − overhead) / context ≈ the KV bytes per
// token, and an f16 cache is about twice a q8_0 one. `kvPerToken` is the f16 figure for the
// model (nodes.js kvBytesPerToken). Null when the figures do not allow a reading.
const OVERHEAD = 0.5 * 1024 ** 3; // compute buffers, roughly; the reading errs toward f16
function kvFactor({ size, fileSize, ctx, kvPerToken, overhead = OVERHEAD } = {}) {
  if (!(size > 0 && fileSize > 0 && ctx > 0 && kvPerToken > 0)) return null;
  const kv = size - fileSize - overhead;
  if (kv <= 0) return null;
  const f = kv / (ctx * kvPerToken);
  return f > 0.1 && f < 4 ? Math.round(f * 100) / 100 : null;
}
// f16 ≈ 1, q8_0 ≈ 0.53, q4_0 ≈ 0.28 (llama.cpp's block sizes: 34/64 and 18/64 of f16).
function kvType(factor) {
  if (!(factor > 0)) return null;
  if (factor >= 0.75) return 'f16';
  if (factor >= 0.4) return 'q8_0';
  return 'q4_0';
}
// The command that halves the KV cache on a Windows PC running Ollama.
const KV_COMMAND = 'setx OLLAMA_KV_CACHE_TYPE q8_0';
function kvAdvice(type, where = 'This PC') {
  if (type !== 'f16') return '';
  return `Ollama on ${where} keeps the conversation memory (KV cache) at full size. Half size frees GPU memory for the model, so more of it stays on the graphics card, at a small cost in precision. On ${where}, run: ${KV_COMMAND} — then quit Ollama from the tray and start it again.`;
}

// ---------- how much of the prompt was reused ----------
// "prompt 21,904 tokens · 21,310 reused (97%)" from Ollama's prompt_eval_count and
// prompt_eval_cached_count (Ollama 0.34+); '' when the server did not say.
function cacheLine(promptTokens, cachedTokens) {
  const p = Number(promptTokens) || 0;
  if (!p || cachedTokens == null || !Number.isFinite(Number(cachedTokens))) return '';
  const c = Math.min(Number(cachedTokens), p);
  return `prompt ${p.toLocaleString('en-US')} tokens · ${c.toLocaleString('en-US')} reused (${Math.round((c / p) * 100)}%)`;
}
// The number of tokens the server read again this step.
const reread = (promptTokens, cachedTokens) => Math.max(0, (Number(promptTokens) || 0) - (Number(cachedTokens) || 0));

// A short fingerprint of a request's fixed start (system prompt and tools), to tell in the
// debug report when it changed between steps: a changed start means a full re-read.
function fingerprint(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const CacheKeepExports = { MAX_LOAD, pickTools, sortedServers, TASK_KEEP, durationSec, taskKeepAlive, MOE_FIT_VERSION, CACHE_STATS_VERSION, parseVersion, versionAtLeast, versionAdvice, kvFactor, kvType, KV_COMMAND, kvAdvice, cacheLine, reread, fingerprint };
if (typeof module !== 'undefined' && module.exports) module.exports = CacheKeepExports;
if (typeof window !== 'undefined') window.CacheKeep = CacheKeepExports;
})();
