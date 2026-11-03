'use strict';

// The cloud model ladder: use the best Gemini (or Claude) model the key can reach, and never
// stall on a busy one. A model that answers 503/429 (or sends nothing for two minutes) rests
// for a few minutes while the very next request goes to the next model down — no fixed wait,
// no retrying into the same overload — and once the rest is over QWS climbs back up instead of
// finishing the task on a lower model. A model the key cannot use (404, retired) rests a day.
// "auto" as the model name means: the best one on the live /models list. Pure; the renderer
// keeps the cool-down map and the live-list cache.

const COOL_BUSY_MS = 5 * 60_000;
const COOL_DEAD_MS = 24 * 3600_000;

const AUTO = /^(auto|best|gemini-auto|claude-auto)$/i;
const isAuto = (model) => AUTO.test(String(model || '').trim());

// Which family a connection's models belong to, if it has a ladder at all.
function familyOf(provider, model) {
  const m = String(model || '').replace(/^models\//, '');
  if (/^gemini/i.test(m) || (provider === 'gemini' && isAuto(m))) return 'gemini';
  if (/^claude/i.test(m) || (provider === 'anthropic' && isAuto(m))) return 'claude';
  return null;
}

// The ordered candidates: the chosen model first, then its siblings best-first (from the
// provider's live list when we have it). "auto" is the whole family best-first.
// `alternates(model, live)` is ToolParse.modelAlternates (passed in to keep this file pure).
function ladder(provider, model, live, alternates) {
  const fam = familyOf(provider, model);
  if (!fam) return [model];
  if (isAuto(model)) return alternates(fam === 'gemini' ? 'gemini-0' : 'claude-0', live);
  const m = String(model).replace(/^models\//, '');
  return [m, ...alternates(m, live).filter((x) => x !== m)];
}

// The first candidate not resting at `now`; null when every one is.
function pick(candidates, cool, now) {
  return (candidates || []).find((m) => !(cool.get(m) > now)) || null;
}

function rest(cool, model, now, dead) {
  cool.set(model, now + (dead ? COOL_DEAD_MS : COOL_BUSY_MS));
}

// When every candidate rests: the one free soonest, and how long until then.
function soonest(candidates, cool, now) {
  let best = null;
  for (const m of candidates || []) {
    const until = cool.get(m) || 0;
    if (!best || until < best.until) best = { model: m, until };
  }
  return best ? { model: best.model, waitMs: Math.max(0, best.until - now) } : null;
}

const CloudLadderExports = { COOL_BUSY_MS, COOL_DEAD_MS, isAuto, familyOf, ladder, pick, rest, soonest };
if (typeof module !== 'undefined' && module.exports) module.exports = CloudLadderExports;
if (typeof window !== 'undefined') window.CloudLadder = CloudLadderExports;
