'use strict';

// Recommended skills (Settings → Skills): a short list from Anthropic's skills repository
// (github.com/anthropics/skills) that helps a coding agent, installed with one click through the
// same GitHub install and safety scan as any link. And how big a skill is for the model's
// context window: a skill's SKILL.md enters the context whole when it is loaded, and these were
// written for Claude, so a long one can take a real share of a small local model's window.
// Pure: no DOM.

(() => {
const BASE = 'https://github.com/anthropics/skills/tree/main/skills';
const PICKS = [
  { dir: 'frontend-design', title: 'Frontend design', why: 'Distinctive, intentional visual design for pages, apps and games — layout, type, colour and motion.' },
  { dir: 'webapp-testing', title: 'Web app testing', why: 'Playwright scripts to drive and check a local web app: start its server, find elements, capture console logs. Needs Python with playwright installed (pip install playwright).' },
  { dir: 'pdf', title: 'PDF', why: 'Read, extract tables from, merge, split and fill PDF forms (Python: pypdf, pdfplumber).' },
  { dir: 'docx', title: 'Word documents', why: 'Create and edit .docx files, including tracked changes and comments.' },
  { dir: 'xlsx', title: 'Spreadsheets', why: 'Create and edit .xlsx files with working formulas, formatting and charts.' },
  { dir: 'mcp-builder', title: 'MCP server builder', why: 'A guide to building MCP servers well, for when you ask QWS to make one.' }
].map((p) => ({ ...p, url: `${BASE}/${p.dir}` }));

// Characters to tokens, roughly (English and code).
const tokensOf = (chars) => Math.ceil((Number(chars) || 0) / 3.5);

// How heavy a skill is for this window: 'ok' | 'large' (over 10%) | 'huge' (over 20%).
function weight(chars, windowTokens) {
  const share = tokensOf(chars) / Math.max(1, Number(windowTokens) || 32768);
  return share > 0.2 ? 'huge' : share > 0.1 ? 'large' : 'ok';
}

// "~2.4K tokens (9% of a 28K window)".
function sizeLabel(chars, windowTokens) {
  const t = tokensOf(chars);
  const w = Number(windowTokens) || 32768;
  const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
  return `~${k(t)} tokens (${Math.round((t / w) * 100)}% of a ${k(w)} window)`;
}

// The line added to load_skill's result when the skill is heavy for the window.
function loadNote(chars, windowTokens) {
  const w = weight(chars, windowTokens);
  if (w === 'ok') return '';
  return `\n\n[This skill takes ${sizeLabel(chars, windowTokens)}. Use what applies to this task, and do not load it again — it is already in the conversation.]`;
}

// Which picks are installed already, by folder name or by skill name.
function installedPicks(skills) {
  const names = new Set((skills || []).flatMap((s) => [String(s.name || '').toLowerCase(), String(s.id || '').split(':')[1]?.toLowerCase()]).filter(Boolean));
  return new Set(PICKS.filter((p) => names.has(p.dir)).map((p) => p.dir));
}

const SkillPicksExports = { PICKS, tokensOf, weight, sizeLabel, loadNote, installedPicks };
if (typeof module !== 'undefined' && module.exports) module.exports = SkillPicksExports;
if (typeof window !== 'undefined') window.SkillPicks = SkillPicksExports;
})();
