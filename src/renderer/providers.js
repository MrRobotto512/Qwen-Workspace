'use strict';
// Model providers and per-request overrides: the preset catalog, the planner
// (heavy) model, and the per-conversation model choice resolved at send time.

const PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'qwen2.5-coder-7b-instruct' },
  dashscope: { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' },
  custom: { baseUrl: '', model: '' }
};

// The configured heavy model as a per-request override, or null if it isn't set up.
function heavyOverride() {
  const h = state.settings.heavy;
  if (!h || !h.enabled || !h.model) return null;
  const override = { provider: h.provider, baseUrl: h.baseUrl, apiKey: h.apiKey, model: h.model };
  // A cloud heavy model needs a key; a local one (Ollama/LM Studio) does not.
  if (!['ollama', 'lmstudio'].includes(h.provider) && !h.apiKey) return null;
  return override;
}

function heavyLabel() {
  return state.settings.heavy?.model || 'heavy model';
}

// The model the user picked for this conversation, resolved to a per-request override at send
// time — stored as a reference ('heavy', or an installed Ollama model), never as credentials.
function conversationOverride(c) {
  const ch = c?.modelChoice;
  if (!ch || ch === 'default') return null;
  if (ch === 'heavy') return heavyOverride();
  if (ch.provider === 'ollama' && ch.model) {
    const base = state.settings.provider === 'ollama' ? state.settings.baseUrl : PROVIDERS.ollama.baseUrl;
    return { provider: 'ollama', baseUrl: base, apiKey: '', model: ch.model };
  }
  return null;
}

function convModelLabel(c) {
  const o = conversationOverride(c);
  return o ? o.model : state.settings.model || 'no model';
}
