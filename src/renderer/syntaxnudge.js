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

function rewriteLine(p, text) {
  const n = typeof text === 'string' ? text.split(/\r?\n/).length : 0;
  return ` ${p} is small${n ? ` (${n} line${n === 1 ? '' : 's'})` : ''}: rewrite it whole with write_file, correct from top to bottom, instead of another edit.`;
}

return { SMALL_LINES, SMALL_CHARS, isSmallFile, lineText, rewriteLine };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SyntaxExports;
if (typeof window !== 'undefined') window.Syntax = SyntaxExports;
