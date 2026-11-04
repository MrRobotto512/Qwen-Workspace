'use strict';

// Tool-call arguments that small models write almost-right (from Hermes Agent's
// agent/message_sanitization.py and tools/arg_coercion.py): a raw line break inside a string
// (JSON.parse rejects it — the most common slip when a model writes a file's content), a
// Windows path with single backslashes ("C:\Users"), a trailing comma, a missing closing brace
// at the end of a long reply, Python's None/True/False, a Python dict with single quotes, or a
// ```json fence around it all. These are repaired instead of refused, and then each value is
// coerced to the type the tool's schema asks for ("42" → 42, "true" → true, a JSON string
// where an array goes → the array, a lone value where an array goes → [value]).
// Pure: no DOM.

(() => {
const VALID_ESCAPE = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
const CONTROL = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

// Does the string starting at `from` hold a Windows path written with lone backslashes
// ("C:\Users\x", ".\src\a.js", "\\server\share")? Then none of its backslashes is an escape.
function isLonePath(s, from, quote) {
  let body = '';
  for (let i = from; i < s.length && i < from + 600; i++) {
    if (s[i] === '\\') {
      body += s[i] + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (s[i] === quote || s[i] === '\n') break;
    body += s[i];
  }
  if (!/^(?:[A-Za-z]:\\|\.{1,2}\\|\\\\)/.test(body)) return false;
  return /\\(?![\\"/bfnrtu])|\\u(?![0-9a-fA-F]{4})/.test(body);
}

// One pass over the text, outside and inside strings, fixing what can be fixed safely.
// Returns { text, fixes }.
function scrub(input) {
  let s = String(input ?? '').trim();
  const fixes = [];
  const fence = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) {
    s = fence[1].trim();
    fixes.push('code fence removed');
  }
  // A Python dict ({'path': 'a.py'}) has no double quotes at all: read single quotes as quotes.
  const singles = !s.includes('"') && /'/.test(s) && /^[{[]/.test(s);
  if (singles) fixes.push('single quotes read as double quotes');
  let out = '';
  let inStr = false;
  let quote = '"';
  let pathMode = false;
  const stack = [];
  let rawCtl = 0;
  let badEsc = 0;
  let py = 0;
  let trailing = 0;
  let extra = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\' && pathMode && s[i + 1] !== quote) {
        // A Windows path in a string with lone backslashes: every backslash is literal
        // ("C:\Users\ryan" must not turn \r into a line break).
        if (s[i + 1] === '\\') i++;
        out += '\\\\';
        badEsc++;
        continue;
      }
      if (ch === '\\') {
        const next = s[i + 1];
        if (next !== undefined && (VALID_ESCAPE.has(next) || (singles && next === "'"))) {
          if (singles && next === "'") {
            out += "'";
          } else if (next === 'u' && !/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
            out += '\\\\u';
            badEsc++;
          } else {
            out += ch + next;
          }
          i++;
        } else {
          out += '\\\\'; // C:\Users → C:\\Users
          badEsc++;
        }
        continue;
      }
      if (ch === quote) {
        inStr = false;
        pathMode = false;
        out += '"';
        continue;
      }
      if (singles && ch === '"') {
        out += '\\"';
        continue;
      }
      if (CONTROL[ch] !== undefined) {
        out += CONTROL[ch];
        rawCtl++;
        continue;
      }
      if (ch < ' ') {
        out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        rawCtl++;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || (singles && ch === "'")) {
      inStr = true;
      quote = ch;
      pathMode = isLonePath(s, i + 1, ch);
      out += '"';
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      // A trailing comma before the closer.
      const t = out.replace(/\s+$/, '');
      if (t.endsWith(',')) {
        out = t.slice(0, -1);
        trailing++;
      }
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      else if (!stack.length) {
        extra++; // an extra closer at the end
        continue;
      }
      out += ch;
      continue;
    }
    // Python literals, outside strings, as whole words.
    const word = /^(None|True|False)\b/.exec(s.slice(i));
    if (word && !/[\w$]/.test(s[i - 1] || '')) {
      out += { None: 'null', True: 'true', False: 'false' }[word[1]];
      i += word[1].length - 1;
      py++;
      continue;
    }
    out += ch;
  }
  if (inStr) {
    out += '"';
    fixes.push('unclosed string closed');
  }
  if (stack.length) {
    out = out.replace(/[\s,]+$/, '');
    if (/:\s*$/.test(out)) out += 'null';
    out += stack.reverse().join('');
    fixes.push(`${stack.length} missing closing bracket${stack.length === 1 ? '' : 's'} added`);
  }
  if (rawCtl) fixes.push(`${rawCtl} raw line break${rawCtl === 1 ? '' : 's'} or control character${rawCtl === 1 ? '' : 's'} escaped`);
  if (badEsc) fixes.push(`${badEsc} lone backslash${badEsc === 1 ? '' : 'es'} doubled`);
  if (py) fixes.push('Python None/True/False converted');
  if (extra) fixes.push(`${extra} extra closing bracket${extra === 1 ? '' : 's'} dropped`);
  if (trailing) fixes.push(`${trailing} trailing comma${trailing === 1 ? '' : 's'} removed`);
  return { text: out, fixes };
}

// Parse tool-call arguments, repairing them when needed. { ok, value, fixes } — `fixes` lists
// what was repaired (empty when the text was valid JSON already).
function parseArgs(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: {}, fixes: [] };
  try {
    return { ok: true, value: JSON.parse(raw), fixes: [] };
  } catch {
    /* repair below */
  }
  const r = scrub(raw);
  try {
    return { ok: true, value: JSON.parse(r.text), fixes: r.fixes };
  } catch (e) {
    return { ok: false, value: null, fixes: r.fixes, error: e.message };
  }
}

// ---------- coercion to the schema ----------
const typesOf = (prop) => (Array.isArray(prop?.type) ? prop.type : prop?.type ? [prop.type] : []);

function coerceValue(v, prop, fixes, key) {
  const types = typesOf(prop);
  if (!types.length || v === null || v === undefined) return v;
  const want = (t) => types.includes(t);
  if (typeof v === 'string') {
    const t = v.trim();
    if ((want('integer') || want('number')) && !want('string') && /^-?\d+(\.\d+)?$/.test(t)) {
      fixes.push(`${key}: "${t}" read as a number`);
      return Number(t);
    }
    if (want('boolean') && !want('string') && /^(true|false)$/i.test(t)) {
      fixes.push(`${key}: "${t}" read as ${t.toLowerCase()}`);
      return t.toLowerCase() === 'true';
    }
    if ((want('array') || want('object')) && !want('string') && /^[[{]/.test(t)) {
      const p = parseArgs(t);
      if (p.ok && ((want('array') && Array.isArray(p.value)) || (want('object') && p.value && typeof p.value === 'object' && !Array.isArray(p.value)))) {
        fixes.push(`${key}: JSON text read as ${Array.isArray(p.value) ? 'a list' : 'an object'}`);
        return coerceValue(p.value, prop, fixes, key);
      }
    }
  }
  if (want('array') && !Array.isArray(v) && !want(typeof v === 'object' ? 'object' : typeof v)) {
    fixes.push(`${key}: a single value wrapped in a list`);
    return [v];
  }
  if (Array.isArray(v) && prop.items) return v.map((x, i) => coerceValue(x, prop.items, fixes, `${key}[${i}]`));
  if (v && typeof v === 'object' && !Array.isArray(v) && prop.properties) return coerceObject(v, prop, fixes, `${key}.`);
  if (want('string') && !want('number') && !want('integer') && (typeof v === 'number' || typeof v === 'boolean')) {
    fixes.push(`${key}: ${v} read as text`);
    return String(v);
  }
  return v;
}

function coerceObject(obj, schema, fixes, prefix = '') {
  const props = schema?.properties || {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = props[k] ? coerceValue(v, props[k], fixes, `${prefix}${k}`) : v;
  return out;
}

// Arguments as the tool's JSON schema (`parameters`) wants them. { value, fixes }.
function coerceArgs(args, schema) {
  const fixes = [];
  if (!args || typeof args !== 'object' || Array.isArray(args) || !schema) return { value: args, fixes };
  return { value: coerceObject(args, schema, fixes), fixes };
}

// The whole step for one call: text in, { text, fixes } out — `text` is valid JSON for the
// history and the tool, or the original text when nothing could make it valid.
function repairCall(argText, schema) {
  const p = parseArgs(argText);
  if (!p.ok) return { text: String(argText ?? ''), fixes: [], failed: true, error: p.error };
  const c = coerceArgs(p.value, schema);
  const fixes = [...p.fixes, ...c.fixes];
  return { text: fixes.length ? JSON.stringify(c.value) : String(argText ?? '').trim() || '{}', fixes, value: c.value };
}

const ArgRepairExports = { scrub, parseArgs, coerceArgs, repairCall };
if (typeof module !== 'undefined' && module.exports) module.exports = ArgRepairExports;
if (typeof window !== 'undefined') window.ArgRepair = ArgRepairExports;
})();
