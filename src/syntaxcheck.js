'use strict';

// A syntax check after every write (from Hermes Agent's tools/file_operations_lint.py): JSON is
// parsed in place, JavaScript is compiled without running it (Node's own parser, so ES modules
// too), a web page's inline <script> blocks are compiled at their real line numbers, and Python
// is parsed with the project's Python when there is one. Only errors the write introduced are
// reported — a file that was already broken does not blame the edit that touched it.
// Pure parts here; main.js runs the compilers.

// Inline scripts of an HTML file: { code, line, module } with `line` the 1-based line the code
// starts on. Scripts with a src, JSON, templates and other non-JavaScript types are skipped.
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] || '').toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript|javascript)$/.test(type)) continue;
    if (!m[2].trim()) continue;
    const startIdx = m.index + m[0].indexOf('>') + 1;
    const line = html.slice(0, startIdx).split('\n').length;
    out.push({ code: m[2], line, module: type === 'module' });
  }
  return out;
}

// Does this JavaScript use module syntax (import/export at the top level)?
const isModuleCode = (code) => /^\s*(import\s+[\w*{"'][^;]*|import\s*\(|export\s+(default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*))/m.test(code);

// The kind of check for a path, or null.
function kindOf(p) {
  const ext = (/\.([a-z0-9]+)$/i.exec(String(p || ''))?.[1] || '').toLowerCase();
  if (ext === 'json') return 'json';
  if (['js', 'cjs', 'mjs'].includes(ext)) return 'js';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (ext === 'py' || ext === 'pyw') return 'python';
  return null;
}

// A JSON parse error with its line: V8 says "… at position 123" or "(line 3 column 5)".
function jsonError(text, err) {
  const msg = String(err?.message || err);
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  if (lc) return { line: Number(lc[1]), message: msg.replace(/\s*\(line \d+ column \d+\)/i, '').replace(/^JSON\.parse: /, '') };
  const pos = /position (\d+)/i.exec(msg);
  const line = pos ? String(text).slice(0, Number(pos[1])).split('\n').length : null;
  return { line, message: msg.replace(/ at position \d+.*$/i, '').replace(/ in JSON$/, '') };
}

// JSON with comments (tsconfig.json, jsconfig.json, .vscode/settings.json, *.jsonc): their tools
// allow // and /* */ comments and trailing commas, so a strict parse would call every edit of
// them broken — and, with the v0.58 finish gate, keep the task from ending.
const JSONC_NAME = /(?:^|[\\/])(?:tsconfig[\w.-]*|jsconfig[\w.-]*|\.eslintrc|devcontainer|settings|launch|tasks|extensions|keybindings)\.json$|\.jsonc$/i;
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const chunk = text.slice(i, end < 0 ? text.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function checkJson(text, rel = '') {
  const t = String(text).replace(/^﻿/, '');
  if (!t.trim()) return [];
  try {
    JSON.parse(t);
    return [];
  } catch (e) {
    // Comments only count outside strings: stripJsonc knows; a URL's "//" in a value does not.
    const stripped = stripJsonc(t);
    if (JSONC_NAME.test(String(rel)) || stripped.replace(/,(\s*[}\]])/g, '$1') !== t.replace(/,(\s*[}\]])/g, '$1')) {
      try {
        JSON.parse(stripped);
        return [];
      } catch {
        /* broken even as JSON with comments */
      }
    }
    return [jsonError(text, e)];
  }
}

// "file.js:12\n  code\n  ^\n\nSyntaxError: Unexpected token '}'" -> { line, message }.
function parseNodeError(text, lineShift = 0) {
  const t = String(text || '');
  const msg = /^(SyntaxError|ReferenceError|TypeError): (.+)$/m.exec(t);
  if (!msg) return null;
  const at = /:(\d+)\r?\n/.exec(t);
  return { line: at ? Number(at[1]) + lineShift : null, message: `${msg[1]}: ${msg[2].trim()}` };
}

// Python's: 'File "x.py", line 3' … 'SyntaxError: invalid syntax'.
function parsePythonError(text) {
  const t = String(text || '');
  const msg = /^(\w*Error): (.+)$/m.exec(t);
  if (!msg) return null;
  const all = [...t.matchAll(/line (\d+)/g)];
  return { line: all.length ? Number(all[all.length - 1][1]) : null, message: `${msg[1]}: ${msg[2].trim()}` };
}

// Errors in `after` that `before` did not have (compared by message, not line: an edit above
// an old error moves its line).
function newErrors(before, after) {
  const old = (before || []).map((e) => e.message);
  return (after || []).filter((e) => {
    const i = old.indexOf(e.message);
    if (i < 0) return true;
    old.splice(i, 1);
    return false;
  });
}

// The line added to a write's result.
function resultLine(p, errors) {
  if (!errors?.length) return '';
  const e = errors[0];
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
  return `\nSyntax check: ${p}${e.line ? ` line ${e.line}` : ''}: ${e.message}${more}. This change introduced it — fix it with your next edit, before anything else.`;
}

module.exports = { inlineScripts, isModuleCode, kindOf, jsonError, checkJson, stripJsonc, JSONC_NAME, parseNodeError, parsePythonError, newErrors, resultLine };
