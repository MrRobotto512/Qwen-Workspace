'use strict';

// Cloud cost meter: pure helpers for recording token spend per model, pricing it with the
// user's own price table (per million tokens, empty by default — no prices are hard-coded),
// and checking the optional monthly cap. Recording and rendering live in app.js.

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Add one response's tokens to the running monthly spend. A new month starts a fresh
// record (the old month's numbers are kept under `prev` so "last month" survives).
function addSpend(spend, model, inTok, outTok, month = monthKey()) {
  let s;
  if (spend && spend.month === month) {
    s = { month, models: { ...spend.models }, prev: spend.prev };
  } else {
    s = { month, models: {}, prev: spend && spend.month ? { month: spend.month, models: spend.models } : undefined };
  }
  const cur = s.models[model] || { in: 0, out: 0 };
  s.models[model] = { in: (cur.in || 0) + (Number(inTok) || 0), out: (cur.out || 0) + (Number(outTok) || 0) };
  return s;
}

// Price a {model: {in, out}} token map with a {model: {in, out}} $/1M-token table.
// `priced` says whether any model had a price at all — unpriced models cost nothing
// rather than guessing, and the UI says so.
function costUSD(models, prices) {
  let total = 0;
  let priced = false;
  let unpriced = 0;
  for (const [model, t] of Object.entries(models || {})) {
    const p = prices?.[model];
    if (!p || (!Number(p.in) && !Number(p.out))) {
      if ((t.in || 0) + (t.out || 0) > 0) unpriced++;
      continue;
    }
    priced = true;
    total += ((t.in || 0) / 1e6) * (Number(p.in) || 0) + ((t.out || 0) / 1e6) * (Number(p.out) || 0);
  }
  return { total, priced, unpriced };
}

function formatUSD(x) {
  if (!x || x <= 0) return '$0.00';
  if (x < 0.01) return '<$0.01';
  return `$${x >= 100 ? Math.round(x).toLocaleString() : x.toFixed(2)}`;
}

function capReached(spend, prices, capUSD) {
  const cap = Number(capUSD) || 0;
  if (cap <= 0) return false;
  return costUSD(spend?.models, prices).total >= cap;
}

const CostsExports = { monthKey, addSpend, costUSD, formatUSD, capReached };
if (typeof module !== 'undefined' && module.exports) module.exports = CostsExports;
if (typeof window !== 'undefined') window.Costs = CostsExports;
