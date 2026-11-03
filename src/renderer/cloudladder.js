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

// `ms` (from restFor) overrides the default rest: five minutes busy, a day dead.
function rest(cool, model, now, dead, ms) {
  cool.set(model, now + (ms || (dead ? COOL_DEAD_MS : COOL_BUSY_MS)));
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

// ---------- used-up quota ----------
// A 429 is not always "busy". Gemini says RESOURCE_EXHAUSTED with "Quota exceeded for metric:
// …free_tier_requests, limit: N" when the key has spent its allowance — per minute (a short
// wait helps) or per day (nothing helps until the reset at midnight Pacific). A free-tier key
// says "free_tier" (a Google AI Plus/Pro subscription does not raise API limits; billing on the
// key's Cloud project does); "limit: 0" means the model is not in the free tier at all.
// Returns null for anything that is not a quota answer.
function quotaInfo(text) {
  const t = String(text || '');
  if (!/quota|RESOURCE_EXHAUSTED/i.test(t)) return null;
  if (!/\b429\b|RESOURCE_EXHAUSTED|quota exceeded|exceeded your (current )?quota/i.test(t)) return null;
  const retry = /retry in ([\d.]+)\s*s/i.exec(t) || /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(t);
  return {
    freeTier: /free[_ -]?tier/i.test(t),
    daily: /per ?day|PerDay|daily/i.test(t),
    none: /limit:\s*0\b/.test(t),
    retryMs: retry ? Math.ceil(parseFloat(retry[1]) * 1000) : null
  };
}

// Milliseconds from `now` to the next midnight in Los Angeles, when Gemini's daily quotas reset.
function msToPacificMidnight(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
  const get = (k) => Number(parts.find((p) => p.type === k)?.value || 0) % 24;
  const since = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return Math.max(60_000, 24 * 3600_000 - since);
}

// How long a model rests after `error`: { ms, why } with why 'dead' | 'quota-day' | 'quota' | 'busy'.
function restFor(error, now, dead) {
  if (dead) return { ms: COOL_DEAD_MS, why: 'dead' };
  const q = quotaInfo(error);
  if (q && (q.daily || q.none)) return { ms: msToPacificMidnight(now), why: 'quota-day', quota: q };
  if (q) return { ms: Math.min(COOL_BUSY_MS, Math.max(60_000, (q.retryMs || 0) + 2000)), why: 'quota', quota: q };
  return { ms: COOL_BUSY_MS, why: 'busy' };
}

const CloudLadderExports = { COOL_BUSY_MS, COOL_DEAD_MS, isAuto, familyOf, ladder, pick, rest, soonest, quotaInfo, msToPacificMidnight, restFor };
if (typeof module !== 'undefined' && module.exports) module.exports = CloudLadderExports;
if (typeof window !== 'undefined') window.CloudLadder = CloudLadderExports;
