'use strict';

// Free cloud models: OpenRouter's free models and Groq's free tier, with sign-up links and
// plain answers to their rate limits. Built from their documented API shapes:
//  - OpenRouter /api/v1/models: `pricing.prompt`/`pricing.completion` ("0" when free, and free
//    variants end in ":free"), `supported_parameters` (contains "tools"),
//    `architecture.input_modalities` (contains "image"), `context_length`; "openrouter/free" is
//    its router that picks a free model able to serve the request;
//  - Groq /openai/v1/models: `id`, `context_window`, `active` — no tool or image flags, so those
//    come from the model's name (best effort).
// Pure: no DOM.

(() => {
// Where to get a key, and what the free tier allows (shown under the API key field).
const SIGNUP = {
  openrouter: {
    url: 'https://openrouter.ai/keys',
    label: 'Get a free OpenRouter key',
    note: 'Free models (ids ending in ":free", or "openrouter/free" to let OpenRouter pick one): about 20 requests a minute and 50 a day — 1,000 a day once the account has bought $10 of credits. Some free models log prompts; if one answers "No endpoints found matching your data policy", allow free endpoints under openrouter.ai/settings/privacy.'
  },
  groq: {
    url: 'https://console.groq.com/keys',
    label: 'Get a free Groq key',
    note: 'Free tier, no card needed, and very fast. Limits are per model: a few thousand tokens a minute and about 1,000 requests a day, so a long agent step can pause for a few seconds while the minute resets.'
  },
  gemini: {
    url: 'https://aistudio.google.com/apikey',
    label: 'Get a Gemini API key',
    note: 'The free tier has per-minute and daily limits. A Google AI Plus, Pro or Ultra subscription does not raise them; turning on billing for the key\'s Google Cloud project does.'
  },
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Get an Anthropic API key',
    note: 'Paid per token; set a monthly budget under Planner to cap it.'
  }
};

const PRESETS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }
};

const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

// One model of a provider's /models answer, in QWS's terms: { id, free, tools, vision, context }.
function fromOpenRouter(m) {
  const p = m?.pricing || {};
  const priced = [p.prompt, p.completion].map(num);
  const free = /:free$/.test(m.id) || m.id === 'openrouter/free' || (priced.every((x) => x === 0));
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const inputs = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : String(m.architecture?.modality || '').split(/[+>,\s-]+/);
  return { id: m.id, name: m.name || m.id, free, tools: params.includes('tools'), vision: inputs.includes('image'), context: Number(m.context_length || m.top_provider?.context_length) || 0 };
}

// Groq lists no capabilities; these are the families it documents with tool use / images.
const GROQ_TOOLS = /gpt-oss|llama-3\.3|llama-4|kimi-k2|qwen3|qwen-qwq|deepseek-r1|compound|llama3-groq/i;
const GROQ_VISION = /llama-4|vision|scout|maverick/i;
const GROQ_NOT_CHAT = /whisper|tts|playai|orpheus|guard|distil-whisper|prompt-guard|safeguard/i;

function fromGroq(m) {
  return { id: m.id, name: m.id, free: true, tools: GROQ_TOOLS.test(m.id), vision: GROQ_VISION.test(m.id), context: Number(m.context_window) || 0, active: m.active !== false };
}

function parseCatalog(provider, json) {
  const list = Array.isArray(json) ? json : json?.data || [];
  if (provider === 'openrouter') return list.filter((m) => m?.id).map(fromOpenRouter);
  if (provider === 'groq') return list.filter((m) => m?.id && !GROQ_NOT_CHAT.test(m.id) && m.active !== false).map(fromGroq);
  return null;
}

// Best for an agent first: can call tools, then coding models, then the bigger context.
const CODER = /coder|code|devstral|qwen3|gpt-oss|deepseek|glm|kimi|llama-4|laguna|north/i;
function rank(models, { freeOnly } = {}) {
  return (models || [])
    .filter((m) => !freeOnly || m.free)
    .slice()
    .sort((a, b) => (b.tools - a.tools) || (CODER.test(b.id) - CODER.test(a.id)) || (b.context - a.context) || a.id.localeCompare(b.id));
}

const kTokens = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n || '?'));

// The label next to a model in the list: "free · tools · images · 131K".
function optionLabel(m) {
  return [m.free ? 'free' : null, m.tools ? 'tools' : 'no tools', m.vision ? 'images' : null, m.context ? kTokens(m.context) : null].filter(Boolean).join(' · ');
}

function summary(provider, models, { freeOnly } = {}) {
  const shown = rank(models, { freeOnly });
  const tools = shown.filter((m) => m.tools).length;
  const free = models.filter((m) => m.free).length;
  const who = provider === 'groq' ? 'Groq' : 'OpenRouter';
  return `Connected ✓ ${who}: ${shown.length} ${freeOnly ? 'free ' : ''}models${provider === 'openrouter' && !freeOnly ? ` (${free} free)` : ''}, ${tools} can call tools (agent mode needs one).${shown[0] ? ` Best first: ${shown.slice(0, 3).map((m) => m.id).join(', ')}.` : ''}`;
}

// "2m30.5s" / "7.66s" / "450ms" -> milliseconds.
function parseDuration(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  let ms = 0;
  let hit = false;
  for (const [, n, u] of t.matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    hit = true;
    ms += Number(n) * { h: 3600_000, m: 60_000, s: 1000, ms: 1 }[u];
  }
  return hit ? Math.ceil(ms) : null;
}

// A rate-limit answer from OpenRouter or Groq, explained: { scope: 'minute' | 'day', waitMs,
// who, message } or null when the error is something else.
function rateLimitInfo(error) {
  const t = String(error || '');
  if (!/\b429\b|rate limit|rate_limit/i.test(t)) return null;
  // OpenRouter: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 …"
  if (/free-models-per-day/i.test(t)) {
    const reset = /"X-RateLimit-Reset"\s*:\s*"?(\d{12,})/i.exec(t);
    return {
      scope: 'day',
      who: 'openrouter',
      resetAt: reset ? Number(reset[1]) : null,
      message: "OpenRouter's free models allow 50 requests a day on this account, and today's are used up. Buying $10 of OpenRouter credits raises it to 1,000 a day (the free models stay free); or switch this step to another provider in Settings."
    };
  }
  if (/free-models-per-min/i.test(t) || (/openrouter/i.test(t) && /rate limit/i.test(t))) {
    return { scope: 'minute', who: 'openrouter', waitMs: 15_000, message: "OpenRouter's free models allow about 20 requests a minute." };
  }
  // Groq: "Rate limit reached for model `x` … on tokens per minute (TPM): Limit 8000, Used …
  // Please try again in 7.66s." (or requests per day (RPD) / tokens per day (TPD)).
  if (/groq|tokens per minute|requests per minute|requests per day|tokens per day|\(TPM\)|\(RPM\)|\(RPD\)|\(TPD\)/i.test(t)) {
    const wait = parseDuration(/try again in ((?:[\d.]+(?:ms|h|m|s))+)/i.exec(t)?.[1]);
    const daily = /per day|\(RPD\)|\(TPD\)/i.test(t);
    return {
      scope: daily ? 'day' : 'minute',
      who: 'groq',
      waitMs: wait,
      message: daily
        ? `Groq's free tier has used up today's ${/tokens per day|\(TPD\)/i.test(t) ? 'tokens' : 'requests'} for this model${wait ? ` (it frees up in about ${Math.ceil(wait / 60_000)} minutes)` : ''}. Pick another Groq model in Settings, or another provider.`
        : `Groq's free tier allows only a few thousand tokens a minute for this model; QWS waits for the minute to reset and carries on.`
    };
  }
  return null;
}

// Groq refuses a tool call the model wrote badly with HTTP 400 "tool_use_failed" and the text it
// tried in failed_generation; that is the model's slip, worth one more try with a hint.
function toolUseFailed(error) {
  const t = String(error || '');
  if (!/tool_use_failed|Failed to call a function/i.test(t)) return null;
  const gen = /"failed_generation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)?.[1];
  return { generation: gen ? gen.replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 400) : '' };
}

// OpenRouter asks for its attribution headers; harmless anywhere else.
const ATTRIBUTION = { 'HTTP-Referer': 'https://github.com/MrRobotto512/Qwen-Workspace', 'X-OpenRouter-Title': 'Qwen Workspace', 'X-Title': 'Qwen Workspace' };

const FreeCloudExports = { SIGNUP, PRESETS, parseCatalog, rank, optionLabel, summary, parseDuration, rateLimitInfo, toolUseFailed, ATTRIBUTION };
if (typeof module !== 'undefined' && module.exports) module.exports = FreeCloudExports;
if (typeof window !== 'undefined') window.FreeCloud = FreeCloudExports;
})();
