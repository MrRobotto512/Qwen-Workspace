'use strict';

// Secrets stay on this PC (from Hermes Agent's agent/redact.py): before a request goes to a
// cloud model — the planner, an escalated step, the review pass, a free OpenRouter model — API
// keys, tokens, private keys and passwords in file contents, command output and messages are
// replaced by a numbered placeholder. Requests to the user's own machines (Ollama, LM Studio,
// a LAN server) are not touched. The same secret always gets the same number, so prompt caching
// still sees an unchanged prefix; and when a cloud model writes a file with a placeholder in it,
// QWS puts the real value back, so a masked key is never written into a config (Hermes issue
// #35519). Pure: no Electron.

const PLACEHOLDER = /«redacted secret #(\d+)(?: \([^)»\n]{0,24}\))?»/g;

// Prefix-shaped secrets: the token is the whole match.
const TOKENS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{32,}/g,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bgsk_[A-Za-z0-9]{40,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
];

// Secrets inside a context: group 2 is the secret.
// `sure`: the context alone says it is a secret (a URL's password, an Authorization header), so
// only placeholders are spared; otherwise the value must also not look like code.
const CONTEXTUAL = [
  // scheme://user:password@host
  { sure: true, re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:)([^\s@/'"]{3,})(?=@)/gi },
  // Authorization: Bearer xxx / Basic xxx
  { sure: true, re: /(\bAuthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi },
  // API_KEY=xxx, "apiKey": "xxx", password: 'xxx', client_secret = "xxx"
  { sure: false, re: /((?:^|[\s{,;(])["']?[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'`,;)}{]{8,})/gim }
];

// Values that are clearly not secrets: placeholders, variables, booleans, examples.
const NOT_SECRET = /^(?:your|xxx|<|\$|\{\{|%|process\.env|os\.environ|env\.|import\.meta|changeme|example|placeholder|dummy|test|sample|none|null|undefined|true|false|\*+|\.\.\.|«redacted)/i;

function looksSecret(v) {
  const t = String(v || '');
  if (t.length < 8 || NOT_SECRET.test(t)) return false;
  if (/^[a-z]+$/i.test(t) && t.length < 20) return false; // a plain word ("password", "localStorage")
  if (/^[\w.]+\(/.test(t) || /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(t)) return false; // code: getToken(…), config.api.key
  return true;
}

// A vault keeps the numbers stable for the life of the app: secret -> n, n -> secret.
function createVault() {
  return { byValue: new Map(), byId: new Map(), next: 1 };
}

function placeholderFor(vault, secret) {
  let n = vault.byValue.get(secret);
  if (!n) {
    n = vault.next++;
    vault.byValue.set(secret, n);
    vault.byId.set(n, secret);
  }
  const hint = /^[A-Za-z]{2,4}[-_]/.exec(secret)?.[0] || (secret.startsWith('-----BEGIN') ? 'private key' : '');
  return `«redacted secret #${n}${hint ? ` (${hint}…)` : ''}»`;
}

// Redact one string. `known` are exact values to hide wherever they appear (the user's own
// API keys from settings). Returns { text, count }.
function redactText(text, vault, known = []) {
  let s = String(text ?? '');
  let count = 0;
  for (const k of known) {
    if (!k || k.length < 8 || !s.includes(k)) continue;
    s = s.split(k).join(placeholderFor(vault, k));
    count++;
  }
  for (const re of TOKENS) {
    s = s.replace(re, (m) => {
      count++;
      return placeholderFor(vault, m);
    });
  }
  for (const { re, sure } of CONTEXTUAL) {
    s = s.replace(re, (m, pre, secret) => {
      if (sure ? /^«redacted|^\$|^\{\{|^%/.test(secret) : !looksSecret(secret)) return m;
      count++;
      return pre + placeholderFor(vault, secret);
    });
  }
  return { text: s, count };
}

// Redact a chat payload's messages: text content, text parts and tool-call arguments.
function redactMessages(messages, vault, known = []) {
  let count = 0;
  const red = (t) => {
    const r = redactText(t, vault, known);
    count += r.count;
    return r.text;
  };
  const out = (messages || []).map((m) => {
    const n = { ...m };
    if (typeof n.content === 'string') n.content = red(n.content);
    else if (Array.isArray(n.content)) n.content = n.content.map((p) => (p && typeof p.text === 'string' ? { ...p, text: red(p.text) } : p));
    if (Array.isArray(n.tool_calls)) n.tool_calls = n.tool_calls.map((tc) => (typeof tc?.function?.arguments === 'string' ? { ...tc, function: { ...tc.function, arguments: red(tc.function.arguments) } } : tc));
    return n;
  });
  return { messages: out, count };
}

// Put real values back where a cloud model wrote placeholders. { text, count, unknown }.
function restoreText(text, vault) {
  let count = 0;
  let unknown = 0;
  const s = String(text ?? '').replace(PLACEHOLDER, (m, n) => {
    const v = vault.byId.get(Number(n));
    if (v === undefined) {
      unknown++;
      return m;
    }
    count++;
    return v;
  });
  return { text: s, count, unknown };
}

// The user's own secrets from settings: every string under a key that names one.
function knownSecrets(settings) {
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (/key|token|secret|password/i.test(key || '') && v.length >= 8 && !/^https?:/.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(settings, '');
  return [...out].sort((a, b) => b.length - a.length);
}

module.exports = { PLACEHOLDER, looksSecret, createVault, placeholderFor, redactText, redactMessages, restoreText, knownSecrets };
