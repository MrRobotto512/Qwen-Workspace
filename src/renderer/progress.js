'use strict';

// Live step progress. A slow local model looked "stuck" in a field report: for minutes nothing
// moved on screen while Ollama read a 5K-token prompt (it streams nothing during that phase)
// and then thought at 3 tokens a second with half the model on the CPU. Each step now shows
// what phase it is in with a running clock — "Reading the prompt (~5.3K tokens) · 1:42", then
// "Thinking · ~840 tokens · 4.1 tok/s · 3:05" — and the debug log records where the time went.
// This file is the pure part: no DOM, no timers.

// Below this, with a GPU spill on record, the status line says why it is slow.
const SLOW_TOK_PER_SEC = 5;

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtTokens(n) {
  const v = Math.max(0, Math.round(n || 0));
  return v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v);
}

// Rough prompt size before the server reports it: ~4 characters per token, images ~800.
function estimateTokens(messages) {
  let chars = 0;
  let images = 0;
  for (const m of messages || []) {
    chars += String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    images += (m.images || []).length;
  }
  return Math.round(chars / 4) + images * 800;
}

// Tokens per second over the generating part only (from the first token on).
function rate(p, now) {
  if (!p.firstAt || p.tokens < 2) return 0;
  const secs = (now - p.firstAt) / 1000;
  return secs > 0.5 ? p.tokens / secs : 0;
}

// The status line. `p` = { startedAt, firstAt, tokens, phase: 'prompt'|'thinking'|'writing'|'tool',
// promptTokens, model, spill } and `now` the clock.
function statusLine(p, now) {
  const clock = fmtClock(now - p.startedAt);
  const who = p.model ? ` (${p.model})` : '';
  if (!p.firstAt || p.phase === 'prompt') {
    return `Reading the prompt${p.promptTokens ? ` (~${fmtTokens(p.promptTokens)} tokens)` : ''}${who} · ${clock}`;
  }
  const label = p.phase === 'thinking' ? 'Thinking' : p.phase === 'tool' ? 'Writing a tool call' : 'Writing';
  const r = rate(p, now);
  const speed = r ? ` · ${r < 10 ? r.toFixed(1) : Math.round(r)} tok/s` : '';
  const slow = r && r < SLOW_TOK_PER_SEC && p.tokens >= 20 && p.spill ? ' · slow: the model is partly on the CPU' : '';
  return `${label} · ~${fmtTokens(p.tokens)} tokens${speed}${slow} · ${clock}`;
}

// Ollama's final chunk carries exact timings (nanoseconds); turn them into the step's record.
function ollamaStats(done) {
  if (!done || typeof done !== 'object') return {};
  const ms = (ns) => (Number(ns) > 0 ? Math.round(Number(ns) / 1e6) : undefined);
  const out = {
    promptTokens: Number(done.prompt_eval_count) || 0,
    completionTokens: Number(done.eval_count) || 0,
    promptMs: ms(done.prompt_eval_duration),
    loadMs: ms(done.load_duration)
  };
  const evalMs = ms(done.eval_duration);
  if (evalMs && out.completionTokens) out.genTokPerSec = Math.round((out.completionTokens / (evalMs / 1000)) * 10) / 10;
  return out;
}

// The debug-log suffix for one response.
function timingText(ev) {
  const parts = [];
  if (ev.loadMs >= 1000) parts.push(`load ${(ev.loadMs / 1000).toFixed(1)}s`);
  if (ev.promptMs != null) parts.push(`prompt ${(ev.promptMs / 1000).toFixed(1)}s`);
  else if (ev.firstMs != null) parts.push(`first token ${(ev.firstMs / 1000).toFixed(1)}s`);
  if (ev.genTokPerSec) parts.push(`${ev.genTokPerSec} tok/s`);
  if (ev.draftModel) parts.push(`draft ${ev.draftModel}${ev.draftAccepted != null ? ` kept ${ev.draftAccepted}%` : ''}`);
  if (ev.ms != null) parts.push(`total ${(ev.ms / 1000).toFixed(1)}s`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

const ProgressExports = { SLOW_TOK_PER_SEC, fmtClock, fmtTokens, estimateTokens, statusLine, ollamaStats, timingText };
if (typeof module !== 'undefined' && module.exports) module.exports = ProgressExports;
if (typeof window !== 'undefined') window.Progress = ProgressExports;
