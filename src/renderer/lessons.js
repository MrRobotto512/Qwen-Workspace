'use strict';

// QWEN.md Lessons: after an agent task that ran commands, the model proposes up to three
// durable lessons (a build command that worked, an error and its fix, a toolchain quirk)
// as an edit to QWEN.md's "## Lessons" section. This file is the pure half — parsing the
// model's reply, section arithmetic, dedupe, and summarizing the task's commands. The
// model call and the approval card live in agent-loop.js; nothing is ever written without
// the user approving the diff.

const SECTION_HEAD = '## Lessons';
const SECTION_CAP = 40; // lines; past this, a merge of old entries is proposed instead

// Up to `max` clean "- " bullets from a model reply. Headers, numbering and junk drop out.
function parseLessons(text, max = 3) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^NONE\.?$/i.test(line) || /^#/.test(line) || /^```/.test(line)) continue;
    const m = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (!m) continue;
    const body = m[1].trim().slice(0, 300);
    if (body.length < 8) continue;
    out.push(`- ${body}`);
    if (out.length >= max) break;
  }
  return out;
}

// The "## Lessons" section's line range in the file: [start, end) where start is the
// heading line, end the next "## " heading or EOF. null when there is no section yet.
function sectionBounds(md) {
  const lines = String(md || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === SECTION_HEAD.toLowerCase());
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, lines };
}

function sectionBullets(md) {
  const b = sectionBounds(md);
  if (!b) return [];
  return b.lines.slice(b.start + 1, b.end).map((l) => l.trim()).filter((l) => l.startsWith('- '));
}

// Append bullets to the section (creating it at the end of the file when missing).
// Returns the new content and how many lines the section now spans.
function withLessons(md, bullets) {
  const base = String(md || '');
  const b = sectionBounds(base);
  if (!b) {
    const sep = base.trim() ? `${base.replace(/\n*$/, '')}\n\n` : '';
    const content = `${sep}${SECTION_HEAD}\n\n${bullets.join('\n')}\n`;
    return { content, sectionLines: bullets.length + 2 };
  }
  const lines = b.lines.slice();
  // Insert before trailing blank lines of the section, so bullets stay together.
  let at = b.end;
  while (at > b.start + 1 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, ...bullets);
  return { content: lines.join('\n'), sectionLines: b.end - b.start + bullets.length };
}

// Replace the whole section's body with these bullets (used when a merge was proposed).
function replaceSection(md, bullets) {
  const base = String(md || '');
  const b = sectionBounds(base);
  if (!b) return withLessons(base, bullets).content;
  const lines = b.lines.slice();
  lines.splice(b.start + 1, b.end - b.start - 1, '', ...bullets, '');
  return lines.join('\n');
}

// Drop lessons the file already states, so repeated tasks don't pile up repeats. A lesson
// counts as known when some line of QWEN.md contains it (normalized) or shares most of its
// words (Jaccard >= 0.6 over words longer than 2 chars).
function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[`"'()]/g, '').split(/[^a-z0-9._/-]+/).filter((w) => w.length > 2));
}

function dedupeLessons(bullets, md) {
  const existing = String(md || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 8);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return (bullets || []).filter((b) => {
    const nb = norm(b);
    const tb = tokens(b);
    return !existing.some((line) => {
      const nl = norm(line);
      if (nl.includes(nb) || nb.includes(nl)) return true;
      const tl = tokens(line);
      let inter = 0;
      for (const w of tb) if (tl.has(w)) inter++;
      const union = tb.size + tl.size - inter;
      return union > 0 && inter / union >= 0.6;
    });
  });
}

// What the task actually ran, compactly, for the lessons prompt. Failed commands carry a
// snippet of their output so the model can pair the error with the fix that followed.
function commandSummary(history, maxChars = 4000) {
  const pending = new Map();
  const parts = [];
  let ran = 0;
  for (const m of history || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.name !== 'run_command') continue;
        try {
          const cmd = String(JSON.parse(tc.function.arguments || '{}').command || '').trim();
          if (cmd) pending.set(tc.id, cmd);
        } catch {
          /* skip */
        }
      }
    } else if (m.role === 'tool' && pending.has(m.tool_call_id)) {
      const text = String(m.content || '');
      const exit = /^Exit code: (-?\d+)/.exec(text);
      if (exit) {
        ran++;
        const code = Number(exit[1]);
        const cmd = pending.get(m.tool_call_id);
        parts.push(code === 0 ? `$ ${cmd}\n  -> ok` : `$ ${cmd}\n  -> failed (exit ${code}): ${text.split('\n').slice(1).join(' ').trim().slice(0, 300)}`);
      }
      pending.delete(m.tool_call_id);
    }
  }
  let text = parts.join('\n');
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { ran, text };
}

const LessonsExports = { SECTION_HEAD, SECTION_CAP, parseLessons, sectionBounds, sectionBullets, withLessons, replaceSection, dedupeLessons, commandSummary };
if (typeof module !== 'undefined' && module.exports) module.exports = LessonsExports;
if (typeof window !== 'undefined') window.Lessons = LessonsExports;
