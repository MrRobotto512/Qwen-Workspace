'use strict';

// Wording around the post-write syntax check (agent-loop.js afterWrite): which files count as
// small enough to rewrite whole, the broken line quoted back, and the rewrite nudge itself.
// Pure: no DOM, no fs.

const SyntaxExports = (() => {
const SMALL_LINES = 80;
const SMALL_CHARS = 8000;

function isSmallFile(text) {
  if (typeof text !== 'string' || !text) return false;
  return text.length <= SMALL_CHARS && text.split(/\r?\n/).length <= SMALL_LINES;
}

// " Line 4 is: ..." for the error's line, or "" when the text or the line is unknown.
function lineText(text, line) {
  const n = Number(line) || 0;
  if (typeof text !== 'string' || n < 1) return '';
  const l = text.split(/\r?\n/)[n - 1];
  if (l === undefined) return '';
  const t = l.trim();
  return t ? ` Line ${n} is: ${t.slice(0, 160)}` : ` Line ${n} is empty.`;
}

// Lines as read_file counts them: a final line break does not start another line.
function lineCount(text) {
  if (typeof text !== 'string' || !text) return 0;
  const all = text.split(/\r?\n/);
  return all.length - (all[all.length - 1] === '' ? 1 : 0);
}

const SHOW_LINES = 40;
const SHOW_CHARS = 3000;

// `show`: put the file as it now is under the nudge, so the rewrite starts from what is there
// rather than from memory (a whole-file rewrite of a file seen only in pieces drops lines).
function rewriteLine(p, text, { show = false } = {}) {
  const n = lineCount(text);
  const shown = show && n && n <= SHOW_LINES && text.length <= SHOW_CHARS ? `\nIt is now:\n${text}` : '';
  return ` ${p} is small${n ? ` (${n} line${n === 1 ? '' : 's'})` : ''}: rewrite it whole with write_file, correct from top to bottom, instead of another edit.${shown}`;
}

return { SMALL_LINES, SMALL_CHARS, isSmallFile, lineText, lineCount, rewriteLine };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SyntaxExports;
if (typeof window !== 'undefined') window.Syntax = SyntaxExports;
