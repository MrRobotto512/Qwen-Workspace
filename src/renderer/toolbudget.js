'use strict';

// How much of a tool result the model gets, and how old results stop crowding a small context
// window (from Hermes Agent's tools/tool_output_truncate.py and agent/context_compressor_prune.py):
//  - a long result keeps its start AND its end — a test run's failures and a build's error are
//    at the end, which cutting to the first 24,000 characters threw away;
//  - the full text of a long command's output is saved to a file the model can page through;
//  - before the conversation is summarized, old tool results outside the recent part are cut
//    to one line each, repeats of a later identical result are dropped, and old file contents
//    inside write/edit calls shrink — no model call, nothing the recent work needs.
// Pure: no DOM.

(() => {
// The result budget in characters for a context window of `tokens`: about 15% of the window
// (a 28K window gets ~17K characters), never under 6,000 or over 24,000.
function budgetFor(tokens) {
  const t = Number(tokens) || 32768;
  return Math.max(6000, Math.min(24000, Math.round(t * 4 * 0.15)));
}

// The start (40%) and the end (60%) of a long text, cut at line breaks where possible.
function headTail(text, max, headShare = 0.4) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, cut: 0 };
  const room = Math.max(200, max - 120);
  let headEnd = Math.floor(room * headShare);
  let tailStart = s.length - (room - headEnd);
  const nl = s.lastIndexOf('\n', headEnd);
  if (nl > headEnd * 0.7) headEnd = nl;
  const nl2 = s.indexOf('\n', tailStart);
  if (nl2 >= 0 && nl2 < tailStart + (room - headEnd) * 0.3) tailStart = nl2 + 1;
  const middle = s.slice(headEnd, tailStart);
  const lines = (middle.match(/\n/g) || []).length;
  return { text: `${s.slice(0, headEnd)}\n[… ${middle.length.toLocaleString('en-US')} characters${lines ? ` (${lines} lines)` : ''} cut from the middle …]\n${s.slice(tailStart)}`, cut: middle.length };
}

// The line added when the whole output was saved to a file.
const savedNote = (file, lines) => `[The full output (${lines} lines) is saved in ${file}: read_file it with start_line to see the part that was cut.]`;

// ---------- pruning old results ----------
const PRUNE_AT = 0.6; // share of the window at which old results are pruned
const KEEP_RESULT = 600; // results this short are kept as they are

function argsOf(call) {
  try {
    return JSON.parse(call?.function?.arguments || '{}');
  } catch {
    return {};
  }
}

// "run_command `npm test`", "read_file app.js", "search_code “foo”".
function callLabel(call) {
  const a = argsOf(call);
  const name = call?.function?.name || 'tool';
  const what = a.command || a.path || a.query || a.url || a.names?.join?.(', ') || '';
  return `${name}${what ? ` ${String(what).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
}

// One line in place of an old result: what ran, how it went, how big it was.
function summarizeResult(call, content) {
  const t = String(content || '');
  const lines = t.split('\n');
  const first = lines.find((l) => l.trim()) || '';
  const exit = /^Exit code: (-?\d+)/m.exec(t);
  const errs = (t.match(/\b(error|failed|exception|traceback)\b/gi) || []).length;
  const bits = [exit ? `exit ${exit[1]}` : first.trim().slice(0, 120), `${lines.length} lines`];
  if (errs && !exit) bits.push(`${errs} error mention${errs === 1 ? '' : 's'}`);
  return `[Earlier result of ${callLabel(call)}: ${bits.filter(Boolean).join(' · ')} — shortened to save room. Run it again if you need it.]`;
}

const BIG_ARG = 400;
// An old write/edit call with its file content shortened, still valid JSON.
function shrinkCallArgs(call) {
  const name = call?.function?.name;
  if (!['write_file', 'edit_file'].includes(name)) return null;
  const a = argsOf(call);
  let changed = false;
  for (const k of ['content', 'new_text', 'old_text']) {
    if (typeof a[k] === 'string' && a[k].length > BIG_ARG) {
      a[k] = `[${a[k].split('\n').length} lines — shortened; the file has the current version]`;
      changed = true;
    }
  }
  return changed ? JSON.stringify(a) : null;
}

// Prune messages before `keepFrom` (the recent part stays whole). Returns { messages, pruned,
// saved } — `saved` in characters. The first message and every user message stay; ids, roles and
// the order of tool calls and results never change.
function pruneHistory(messages, keepFrom) {
  const out = messages.slice();
  const calls = new Map(); // tool_call_id -> call
  for (const m of out) for (const tc of m.tool_calls || []) calls.set(tc.id, tc);
  const laterSame = new Set();
  // A result repeated later, word for word, is dropped in favour of the later one.
  const seen = new Set();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'tool' || String(m.content || '').length <= KEEP_RESULT) continue;
    if (seen.has(m.content) && i < keepFrom) laterSame.add(i);
    seen.add(m.content);
  }
  let pruned = 0;
  let saved = 0;
  for (let i = 1; i < Math.min(keepFrom, out.length); i++) {
    const m = out[i];
    if (m.role === 'tool' && String(m.content || '').length > KEEP_RESULT && !/^\[Earlier result of /.test(m.content)) {
      const call = calls.get(m.tool_call_id);
      const text = laterSame.has(i) ? `[Same as a later result of ${callLabel(call)} — see below.]` : summarizeResult(call, m.content);
      saved += m.content.length - text.length;
      out[i] = { ...m, content: text };
      if (out[i].images) delete out[i].images;
      pruned++;
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      let touched = false;
      const tcs = m.tool_calls.map((tc) => {
        const args = shrinkCallArgs(tc);
        if (!args) return tc;
        touched = true;
        saved += tc.function.arguments.length - args.length;
        return { ...tc, function: { ...tc.function, arguments: args } };
      });
      if (touched) {
        out[i] = { ...m, tool_calls: tcs };
        pruned++;
      }
    }
  }
  return { messages: out, pruned, saved };
}

const ToolBudgetExports = { budgetFor, headTail, savedNote, PRUNE_AT, KEEP_RESULT, callLabel, summarizeResult, shrinkCallArgs, pruneHistory };
if (typeof module !== 'undefined' && module.exports) module.exports = ToolBudgetExports;
if (typeof window !== 'undefined') window.ToolBudget = ToolBudgetExports;
})();
