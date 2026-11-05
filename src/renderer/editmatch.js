'use strict';

// Forgiving edits and glitch checks for the agent's file writes, from a field report where a
// 14B model lost a dozen five-minute steps to "old_text not found": its old_text carried four
// spaces of indentation the file did not have. When the exact text is missing, the lines are
// matched again ignoring leading/trailing whitespace; a single unambiguous match is applied,
// with new_text re-indented the way the file is. The same report shows the model writing
// "MeshStandard材料" and "high身" — characters from another script inside code identifiers —
// which glitchIdentifiers() catches so the tool result can tell the model at once.

const leading = (line) => /^[ \t]*/.exec(line)[0];

// Typographic characters a model swaps in or out ("smart" quotes, dashes, the minus sign,
// non-breaking and other wide spaces), mapped to ASCII for comparing lines (from Hermes Agent's
// tools/fuzzy_match.py).
const UNICODE_MAP = { '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2033': '"', '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u2032': "'", '\u2014': '--', '\u2013': '-', '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2026': '...', '\u00a0': ' ', '\u202f': ' ', '\u2009': ' ', '\u200a': ' ', '\u2002': ' ', '\u2003': ' ', '\u3000': ' ', '\u200b': '' };
const UNICODE_RE = new RegExp(`[${Object.keys(UNICODE_MAP).join('')}]`, 'g');
const asciiLine = (l) => String(l).replace(UNICODE_RE, (ch) => UNICODE_MAP[ch]).trim();
const trimLine = (l) => l.trim();

// The lines of old_text, without blank lines at either end.
function wantLines(oldText) {
  const want = String(oldText).replace(/\r\n/g, '\n').split('\n');
  while (want.length && !want[0].trim()) want.shift();
  while (want.length && !want[want.length - 1].trim()) want.pop();
  return want;
}

// Replace lines at..at+n of the file with new_text, re-indented the way the file is there.
function spliceLines(original, lines, at, n, want, newText) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const first = Math.max(0, want.findIndex((l) => l.trim()));
  const modelIndent = leading(want[first] ?? '');
  const fileIndent = leading(lines[at + first] ?? '');
  const add = String(newText).replace(/\r\n/g, '\n').split('\n').map((l) => {
    if (!l.trim()) return '';
    return l.startsWith(modelIndent) ? fileIndent + l.slice(modelIndent.length) : l;
  });
  return [...lines.slice(0, at), ...add, ...lines.slice(at + n)].join(eol);
}

// old_text's lines against the file's, each compared after `norm`. { modified, note } when exactly
// one place matches; { count } (0 or 2+) otherwise.
function lineEdit(original, oldText, newText, norm, note) {
  const lines = original.split(/\r?\n/);
  const want = wantLines(oldText);
  if (!want.length) return { count: 0 };
  const wantNorm = want.map(norm);
  const fileNorm = lines.map(norm);
  const hits = [];
  for (let i = 0; i + want.length <= lines.length && hits.length < 2; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = fileNorm[i + j] === wantNorm[j];
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { count: hits.length };
  return { modified: spliceLines(original, lines, hits[0], want.length, want, newText), note };
}

// { modified, note } when old_text matches exactly one place ignoring indentation; { count }
// (0 or 2+) otherwise.
function looseEdit(original, oldText, newText) {
  return lineEdit(original, oldText, newText, trimLine, 'old_text matched once after ignoring indentation; new_text was re-indented to match the file');
}

// Curly quotes, long dashes and odd spaces on one side only.
function unicodeEdit(original, oldText, newText) {
  if (!UNICODE_RE.test(original + oldText)) return { count: 0 };
  UNICODE_RE.lastIndex = 0;
  return lineEdit(original, oldText, newText, asciiLine, 'old_text matched once after treating curly quotes, long dashes and special spaces as plain ones');
}

// old_text written with literal "\n" and "\t" (escaped twice) instead of real line breaks.
function escapeEdit(original, oldText, newText) {
  const o = String(oldText);
  if (o.includes('\n') || !/\\[nt]/.test(o)) return { count: 0 };
  const un = (t) => String(t).replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  const oldU = un(o);
  const newU = /\\[nt]/.test(String(newText)) && !String(newText).includes('\n') ? un(newText) : String(newText);
  const n = original.split(oldU).length - 1;
  if (n === 1) return { modified: original.replace(oldU, () => newU), note: 'old_text had literal \\n escapes instead of line breaks; matched once after reading them as line breaks' };
  if (n > 1) return { count: n };
  const loose = looseEdit(original, oldU, newU);
  return loose.modified ? { modified: loose.modified, note: 'old_text had literal \\n escapes instead of line breaks; matched once after reading them as line breaks and ignoring indentation' } : loose;
}

// old_text written with regex whitespace tokens (a benchmark run: qwen3:8b sent
// `function mean(xs) {\s+let sum = 0;\s+...` three times over): each `\s+` or `\s*` stands for
// the file's whitespace at that spot, and the new text's tokens take the whitespace that was
// matched (the last one again for extra lines), so the result keeps the file's line breaks and
// indentation.
function regexWsEdit(original, oldText, newText) {
  const o = String(oldText);
  if (o.includes('\n') || !/\\s[+*]/.test(o)) return { count: 0 };
  const quote = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(o.split(/\\s[+*]/).map(quote).join('(\\s+)'), 'g');
  const all = [...original.matchAll(re)];
  if (all.length !== 1) return { count: all.length };
  const m = all[0];
  const ws = m.slice(1);
  let i = 0;
  const newU = String(newText).replace(/\\s[+*]/g, () => ws[Math.min(i++, ws.length - 1)] ?? '\n');
  return { modified: original.slice(0, m.index) + newU + original.slice(m.index + m[0].length), note: 'old_text used \\s+ for whitespace; matched once, reading each as the whitespace in the file' };
}

// How alike two strings are, 0..1: shared character pairs (Dice). 1 for equal strings.
function similarity(a, b) {
  const x = String(a);
  const y = String(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const k = x.slice(i, i + 2);
    pairs.set(k, (pairs.get(k) || 0) + 1);
  }
  let both = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const k = y.slice(i, i + 2);
    const n = pairs.get(k);
    if (n > 0) {
      pairs.set(k, n - 1);
      both++;
    }
  }
  return (2 * both) / (x.length - 1 + y.length - 1);
}

// The similarity matches (Hermes's block_anchor and context_aware), for a model that remembered
// a block slightly wrong: only when old_text has 3+ lines, and the result is a single place.
//  - anchor: its first and last lines match exactly (ignoring indentation and typography) and the
//    lines between are mostly alike (half alike when it is the only candidate, 70% otherwise);
//  - lines: every non-blank line is at least 80% alike, the first and last included.
// The note says it was approximate, so the model checks the diff.
function similarEdit(original, oldText, newText) {
  const lines = original.split(/\r?\n/);
  const want = wantLines(oldText);
  if (want.length < 3 || want.join('').trim().length < 40) return { count: 0 };
  const n = want.length;
  const w = want.map(asciiLine);
  const f = lines.map(asciiLine);
  const middle = w.slice(1, -1).join('\n');
  const anchors = [];
  for (let i = 0; i + n <= f.length; i++) if (f[i] === w[0] && f[i + n - 1] === w[n - 1]) anchors.push(i);
  const floor = anchors.length === 1 ? 0.5 : 0.7;
  const byAnchor = anchors.filter((i) => similarity(f.slice(i + 1, i + n - 1).join('\n'), middle) >= floor);
  if (byAnchor.length === 1) {
    const pct = Math.round(similarity(f.slice(byAnchor[0] + 1, byAnchor[0] + n - 1).join('\n'), middle) * 100);
    return { modified: spliceLines(original, lines, byAnchor[0], n, want, newText), note: `old_text matched approximately: its first and last lines match line ${byAnchor[0] + 1} and line ${byAnchor[0] + n}, and the lines between are about ${pct}% alike. Read the result back to check it replaced what you meant` };
  }
  if (byAnchor.length > 1) return { count: byAnchor.length };
  const hits = [];
  for (let i = 0; i + n <= f.length && hits.length < 2; i++) {
    if (similarity(f[i], w[0]) < 0.8 || similarity(f[i + n - 1], w[n - 1]) < 0.8) continue;
    let ok = true;
    for (let j = 0; j < n && ok; j++) ok = !w[j] || similarity(f[i + j], w[j]) >= 0.8;
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { count: hits.length };
  return { modified: spliceLines(original, lines, hits[0], n, want, newText), note: `old_text matched approximately: every line is at least 80% like lines ${hits[0] + 1}-${hits[0] + n}. Read the result back to check it replaced what you meant` };
}

// The edit is already in the file: new_text is there, old_text is not (a model re-sending an edit
// that worked). Hermes's is_already_applied: only for a new_text long enough to mean something.
function alreadyApplied(original, oldText, newText) {
  const n = String(newText ?? '');
  if (n.trim().length < 8 || !original.includes(n)) return false;
  return !original.includes(String(oldText ?? ''));
}

// The last resort, from a field report where qwen3:8b sent a nicely indented multi-line
// old_text ten times for an HTML file that was one minified line: match with ALL whitespace
// ignored (spaces, tabs, line breaks). Applied only when the stripped old_text is long enough to
// mean something and occurs exactly once; the span from its first to its last character in the
// file is replaced by new_text as written. { modified, note } or { count }.
const MIN_BLIND = 24;
function blindEdit(original, oldText, newText) {
  const want = String(oldText).replace(/\s+/g, '');
  if (want.length < MIN_BLIND) return { count: 0 };
  const chars = [];
  const at = [];
  for (let i = 0; i < original.length; i++) {
    if (/\s/.test(original[i])) continue;
    chars.push(original[i]);
    at.push(i);
  }
  const flat = chars.join('');
  const first = flat.indexOf(want);
  if (first < 0) return { count: 0 };
  if (flat.indexOf(want, first + 1) >= 0) return { count: 2 };
  const start = at[first];
  const end = at[first + want.length - 1] + 1;
  return { modified: original.slice(0, start) + String(newText) + original.slice(end), note: 'old_text matched once after ignoring all spaces and line breaks; that span was replaced with new_text' };
}

// Code files only: these are where a stray script inside an identifier breaks the program.
const CODE_FILE = /\.(m?[jt]sx?|cjs|py|pyw|css|scss|less|html?|vue|svelte|java|kt|cs|c|cc|cpp|h|hpp|go|rs|rb|php|swift|lua|sh|ps1|json|ya?ml|toml|gd)$/i;
const OTHER_SCRIPT = '\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af\\u0400-\\u04ff';
const TOKEN = new RegExp(`[A-Za-z0-9_$${OTHER_SCRIPT}]+`, 'g');
const ANY_OTHER = new RegExp(`[${OTHER_SCRIPT}]`);
const HAS_ASCII = /[A-Za-z_$]/;

// Identifiers that gained letters from another script (CJK, Hangul, Cyrillic) in this write —
// only when the file had none before, so a project with a Chinese UI is not flagged.
function glitchIdentifiers(path, before, after) {
  if (!CODE_FILE.test(String(path || '')) || ANY_OTHER.test(String(before || ''))) return [];
  const found = new Set();
  // A glitch is ONE identifier mixing scripts ("MeshStandard材料"); a word of another language
  // on its own (in a comment or a string) is left alone.
  for (const m of String(after || '').matchAll(TOKEN)) {
    if (!ANY_OTHER.test(m[0]) || !HAS_ASCII.test(m[0])) continue;
    found.add(m[0].slice(0, 40));
    if (found.size >= 6) break;
  }
  return [...found];
}

function glitchWarning(list) {
  if (!list.length) return '';
  return `\nWarning: this write put characters from another language inside code: ${list.map((x) => `\`${x}\``).join(', ')}. That is a generation glitch, not valid code — fix each one now with edit_file (e.g. \`MeshStandard材料\` → \`MeshStandardMaterial\`).`;
}

const EditMatchExports = { looseEdit, unicodeEdit, escapeEdit, regexWsEdit, similarEdit, alreadyApplied, similarity, asciiLine, blindEdit, glitchIdentifiers, glitchWarning };
if (typeof module !== 'undefined' && module.exports) module.exports = EditMatchExports;
if (typeof window !== 'undefined') window.EditMatch = EditMatchExports;
