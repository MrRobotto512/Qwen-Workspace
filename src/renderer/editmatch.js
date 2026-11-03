'use strict';

// Forgiving edits and glitch checks for the agent's file writes, from a field report where a
// 14B model lost a dozen five-minute steps to "old_text not found": its old_text carried four
// spaces of indentation the file did not have. When the exact text is missing, the lines are
// matched again ignoring leading/trailing whitespace; a single unambiguous match is applied,
// with new_text re-indented the way the file is. The same report shows the model writing
// "MeshStandard材料" and "high身" — characters from another script inside code identifiers —
// which glitchIdentifiers() catches so the tool result can tell the model at once.

const leading = (line) => /^[ \t]*/.exec(line)[0];

// { modified, note } when old_text matches exactly one place ignoring indentation; { count }
// (0 or 2+) otherwise.
function looseEdit(original, oldText, newText) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const want = String(oldText).replace(/\r\n/g, '\n').split('\n');
  while (want.length && !want[0].trim()) want.shift();
  while (want.length && !want[want.length - 1].trim()) want.pop();
  if (!want.length) return { count: 0 };
  const wantTrim = want.map((l) => l.trim());
  const hits = [];
  for (let i = 0; i + want.length <= lines.length && hits.length < 2; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = lines[i + j].trim() === wantTrim[j];
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { count: hits.length };
  const at = hits[0];
  const first = want.findIndex((l) => l.trim());
  const modelIndent = leading(want[first]);
  const fileIndent = leading(lines[at + first]);
  const add = String(newText).replace(/\r\n/g, '\n').split('\n').map((l) => {
    if (!l.trim()) return '';
    return l.startsWith(modelIndent) ? fileIndent + l.slice(modelIndent.length) : l;
  });
  const out = [...lines.slice(0, at), ...add, ...lines.slice(at + want.length)];
  return { modified: out.join(eol), note: 'old_text matched once after ignoring indentation; new_text was re-indented to match the file' };
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

const EditMatchExports = { looseEdit, glitchIdentifiers, glitchWarning };
if (typeof module !== 'undefined' && module.exports) module.exports = EditMatchExports;
if (typeof window !== 'undefined') window.EditMatch = EditMatchExports;
