'use strict';

// Search across saved conversations — every project, newest first — so the agent can find how
// something was solved before ("the PyInstaller spec fix last week"). A port of the idea behind
// Hermes Agent's session search; the scoring here is plain term matching, which a small local
// model can act on without another model summarizing the hits. Pure: main.js feeds it the
// saved conversation objects; tests feed it fixtures.

const SNIPPET = 220;

// The searchable text of one conversation: what the user asked, what the agent said, and the
// notices (escalations, goal verdicts) — in display order.
function convText(conv) {
  const parts = [];
  for (const d of conv.display || []) {
    if (d.t === 'user' && d.text) parts.push(`User: ${d.text}`);
    else if (d.t === 'assistant' && d.content) parts.push(`Assistant: ${d.content}`);
    else if (d.t === 'notice' && d.text) parts.push(`Note: ${d.text}`);
  }
  return parts.join('\n');
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[\p{L}\p{N}_.\-/]{2,}/gu) || [])].slice(0, 12);
}

// Score and snippet one conversation for a query; null when nothing matches.
function scoreConv(conv, terms) {
  if (!terms.length) return null;
  const text = convText(conv);
  const lower = text.toLowerCase();
  const title = String(conv.title || '').toLowerCase();
  let score = 0;
  let matched = 0;
  const hits = [];
  for (const term of terms) {
    let count = 0;
    let at = lower.indexOf(term);
    if (at >= 0) hits.push(at);
    while (at >= 0 && count < 20) {
      count++;
      at = lower.indexOf(term, at + term.length);
    }
    if (title.includes(term)) count += 5;
    if (count) matched++;
    score += Math.min(count, 10);
  }
  if (!matched) return null;
  // Every query term present beats many hits of one term.
  score += matched * 10;
  const snippets = [];
  for (const at of hits.sort((a, b) => a - b)) {
    if (snippets.some((s) => Math.abs(s.at - at) < SNIPPET)) continue;
    const from = Math.max(0, at - SNIPPET / 2);
    snippets.push({ at, text: `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET).replace(/\s+/g, ' ').trim()}…` });
    if (snippets.length >= 3) break;
  }
  return { score, matched, snippets: snippets.map((s) => s.text) };
}

// The top matches across conversations. `convs` are full saved conversation objects.
function searchConversations(convs, query, { limit = 5, excludeId = null } = {}) {
  const terms = queryTerms(query);
  const out = [];
  for (const conv of convs || []) {
    if (!conv || conv.id === excludeId) continue;
    const s = scoreConv(conv, terms);
    if (s) out.push({ id: conv.id, title: conv.title, workspace: conv.workspace, updatedAt: conv.updatedAt, ...s });
  }
  out.sort((a, b) => b.matched - a.matched || b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, limit);
}

// One conversation, condensed for reading: requests, answers and notices, capped.
function condensedConv(conv, maxChars = 6000) {
  const text = convText(conv);
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n[… middle omitted …]\n${text.slice(-maxChars / 2)}` : text;
}

module.exports = { convText, queryTerms, scoreConv, searchConversations, condensedConv };
