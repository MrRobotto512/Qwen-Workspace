'use strict';

// OpenAI-compatible nodes (v0.63), Strata first (github.com/Niko1221/Strata, MIT): a node can
// run a model server that speaks the OpenAI API instead of Ollama's or LM Studio's — Strata, a
// llama.cpp server, vLLM. Strata runs very large mixture-of-experts models on gaming PCs (the
// busiest experts on the graphics cards, the rest in RAM, a lookup table on the SSD), so a
// 12 GB card with 48 GB of RAM can run Qwen3.8-Flash-Next, a far bigger model than Ollama fits.
// Such a server manages its own memory: QWS reads the context it reports and skips its own GPU
// fit prediction. A key the server asks for is read from an environment variable on this PC —
// never stored in settings.
// Pure: no DOM.

(() => {
// The provider name a request to such a node carries (free and local, like Ollama).
const PROVIDER = 'openai-local';
const LOCAL_PROVIDERS = ['ollama', 'lmstudio', PROVIDER];
const isLocalProvider = (p) => LOCAL_PROVIDERS.includes(p);

// The models Strata documents (docs/MODELS.md, docs/QWEN36.md), with what they need. `ramGB`
// is the RAM the model needs beside the system (Strata: "RAM is at least the experts plus about
// 10 GB"; for Qwen3.6 the RAM its setup plans for). `downloadGB` where Strata states it.
const MODELS = [
  { family: 'qwen', model: 'Q2_0', name: 'Qwen3.8-Flash-Next Q2_0', ramGB: 44, vramGB: 12, downloadGB: 66, note: 'the fastest size of the big model' },
  { family: 'qwen', model: 'IQ2_XS', name: 'Qwen3.8-Flash-Next IQ2_XS', ramGB: 45.5, vramGB: 12, downloadGB: 70, note: 'better answers than Q2_0, a little slower' },
  { family: 'qwen', model: 'IQ3_XXS', name: 'Qwen3.8-Flash-Next IQ3_XXS', ramGB: 53, vramGB: 12, downloadGB: 76, note: 'great quality, slower' },
  { family: 'qwen', model: 'IQ3_S', name: 'Qwen3.8-Flash-Next IQ3_S', ramGB: 60, vramGB: 12, note: 'matches the full model on the published tests; the slowest' },
  { family: 'coder', model: 'IQ1_M', name: 'Qwen3.8-Flash-Next Coder', ramGB: 33, vramGB: 12, coding: true, note: 'coding only: half the experts, kept for code' },
  { family: 'qwen36', model: 'UD-Q4_K_XL', name: 'Qwen3.6-35B-A3B Q4', ramGB: 32, vramGB: 8, downloadGB: 23, note: 'the smaller model, quick even mostly on the CPU' },
  { family: 'qwen36', model: 'UD-Q6_K_XL', name: 'Qwen3.6-35B-A3B Q6', ramGB: 44, vramGB: 8, downloadGB: 33, note: 'closer to the full model' }
];

// Catalog entries for the agent's model ranking (the ⚡ node pick). Strata names the model by
// family ("qwen3.8-flash-next"), maybe with a size after it, so these match by prefix.
// Qwen3.6-35B-A3B is already in the Ollama catalog and matches it by its loose name.
const CATALOG = [
  { id: 'qwen3.8-flash-next', name: 'Qwen3.8-Flash-Next (Strata)', rank: 10.5, prefix: true, agent: 'Excellent', note: 'A far larger mixture-of-experts model than any that fits in Ollama on a gaming PC, run by Strata with its experts in RAM. Ranked above the Ollama models; check it with a benchmark on your own setup.' }
];

// What fits a PC: the documented models whose RAM need fits `ramGB` and whose card need fits
// `vramGB`, best first (the big model before the small one, more bits before fewer, the Coder
// only when nothing general fits).
function fits(specs) {
  const ram = Number(specs?.ramGB) || 0;
  const vram = Number(specs?.vramGB) || 0;
  if (!ram) return [];
  const ok = MODELS.filter((m) => ram >= m.ramGB && (!vram || vram >= m.vramGB));
  const score = (m) => (m.family === 'qwen' ? 100 + m.ramGB : m.coding ? 50 : m.ramGB);
  return ok.sort((a, b) => score(b) - score(a));
}

// The command that starts a model, for another PC on the network when `lan` (Strata then makes
// an API key; `keyEnv` names the variable QWS reads it from).
function launchCommand(m, { lan = false } = {}) {
  return `strata launch --family ${m.family} --model ${m.model}${lan ? ' --access lan --port 8080' : ''}`;
}

// The environment variable a node's key is read from: a plain upper-case name, or null.
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const keyEnvName = (v) => (ENV_NAME.test(String(v || '').trim()) ? String(v).trim() : null);
const DEFAULT_KEY_ENV = 'STRATA_API_KEY';

// One server's answers -> a node health entry. `health` is GET /health (Strata: service,
// model, max_context, images), `models` GET /v1/models, `props` GET /props (llama.cpp:
// default_generation_settings.n_ctx). Null when /v1/models is not an OpenAI model list.
function parseServer({ health, models, props } = {}) {
  const data = Array.isArray(models?.data) ? models.data : null;
  if (!data) return null;
  const llms = data.filter((m) => m && m.id && !(m.architecture?.output_modalities || ['text']).every((x) => x !== 'text'));
  const ids = llms.map((m) => String(m.id));
  const strata = health?.service === 'strata';
  const ctxOf = (m) => Number(m?.meta?.n_ctx || m?.max_model_len || m?.context_length) || 0;
  const maxContext = Number(health?.max_context) || ctxOf(llms[0]) || Number(props?.default_generation_settings?.n_ctx || props?.n_ctx) || 0;
  const server = strata ? 'Strata' : props && (props.default_generation_settings || props.build_info) ? 'llama.cpp' : llms.some((m) => m.max_model_len) ? 'vLLM' : 'OpenAI-compatible';
  if (strata && !ids.length && health?.model) ids.push(String(health.model)); // Strata lists nothing while loading
  return {
    kind: 'openai',
    server,
    models: ids,
    maxContext: maxContext || null,
    vision: !!health?.images || llms.some((m) => (m.architecture?.input_modalities || []).includes('image')),
    loaded: strata ? health?.loaded !== false : true
  };
}

// The message for a server that asks for a key QWS does not have.
function keyNeeded(keyEnv) {
  const name = keyEnvName(keyEnv) || DEFAULT_KEY_ENV;
  return `This server asks for an API key. Set the environment variable ${name} on this PC to the key (Strata shows it with \`strata launch --show-key\`) and restart QWS — QWS reads it from there and never stores it. Or start the server with --no-api-key on a network you trust.`;
}

// The status line for a node's Test button.
function describe(h) {
  if (!h?.up) return '';
  const ctx = h.maxContext ? ` · context ${Math.round(h.maxContext / 1024)}K` : '';
  return `${h.server || 'OpenAI-compatible'}${ctx}${h.vision ? ' · reads images' : ''}${h.loaded === false ? ' · loading' : ''}`;
}

// Strata answers one request at a time unless started with --parallel; parallel subagents on
// it wait their turn. A short note for the node's line.
const parallelNote = (h) => (h?.server === 'Strata' ? 'one request at a time unless started with --parallel 2' : '');

const StrataExports = { PROVIDER, LOCAL_PROVIDERS, isLocalProvider, MODELS, CATALOG, fits, launchCommand, keyEnvName, DEFAULT_KEY_ENV, parseServer, keyNeeded, describe, parallelNote };
if (typeof module !== 'undefined' && module.exports) module.exports = StrataExports;
if (typeof window !== 'undefined') window.Strata = StrataExports;
})();
