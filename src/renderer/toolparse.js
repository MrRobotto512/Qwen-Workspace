'use strict';

// Parses tool calls that models write as text instead of structured tool_calls. Kept free of
// app state (the known tool names are passed in) so it can be unit-tested in Node.
// Formats handled:
// - JSON in tags: <tool_call>{"name": ..., "arguments": {...}}</tool_call>
// - Qwen3-Coder XML: <function=name><parameter=key>value</parameter></function> (tags may be missing)
// - bare JSON, often in a ```json fence: {"name": "list_files", "arguments": {...}}

const TOOL_TEXT_MARKER = /<tool_call>|<function=[\w.-]+>/;
const MULTILINE_PARAMS = new Set(['content', 'old_text', 'new_text']);

function jsonToolCallRe(names) {
  return new RegExp(`(?:\`\`\`[\\w-]*[ \\t]*\\r?\\n\\s*)?\\{\\s*"name"\\s*:\\s*"(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})"`);
}

function textToolCallStart(content, names) {
  const indexes = [TOOL_TEXT_MARKER.exec(content), jsonToolCallRe(names).exec(content)].filter(Boolean).map((m) => m.index);
  return indexes.length ? Math.min(...indexes) : -1;
}

// Returns the balanced {...} object starting at `from`, respecting strings.
function readJsonObject(text, from) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      return text.slice(from, i + 1);
    }
  }
  return null;
}

function extractTextToolCalls(content, names) {
  const start = textToolCallStart(content, names);
  if (start < 0) return { calls: [], cleaned: content.trim() };
  const tail = content.slice(start);
  const calls = [];
  const add = (name, args) =>
    calls.push({ id: `call_txt_${Date.now()}_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } });

  if (tail.includes('<function=')) {
    for (const block of tail.split(/(?=<function=)/)) {
      const fm = /^<function=([\w.-]+)>/.exec(block);
      if (!fm) continue;
      const args = {};
      const re = /<parameter=([\w.-]+)>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|<\/tool_call>|$)/g;
      let pm;
      while ((pm = re.exec(block))) {
        const key = pm[1];
        let v = pm[2];
        v = MULTILINE_PARAMS.has(key) ? v.replace(/^\r?\n/, '').replace(/\r?\n$/, '') : v.trim();
        if (/^(start_line|end_line|depth)$/.test(key) && /^\d+$/.test(v)) v = Number(v);
        else if (v === 'true' || v === 'false') v = v === 'true';
        args[key] = v;
      }
      add(fm[1], args);
    }
  } else if (!tail.includes('<tool_call>')) {
    const known = new Set(names);
    const re = /\{\s*"name"\s*:/g;
    let m;
    while ((m = re.exec(tail))) {
      const json = readJsonObject(tail, m.index);
      if (!json) break;
      re.lastIndex = m.index + json.length;
      try {
        const obj = JSON.parse(json);
        const args = obj.arguments ?? obj.parameters;
        if (known.has(obj.name) && args !== undefined) add(obj.name, typeof args === 'string' ? JSON.parse(args) : args);
      } catch {
        /* not a tool call */
      }
    }
  } else {
    const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
    let m;
    while ((m = re.exec(tail)) && m[0]) {
      try {
        const obj = JSON.parse(m[1]);
        if (obj.name) add(obj.name, typeof obj.arguments === 'string' ? JSON.parse(obj.arguments) : obj.arguments);
      } catch {
        /* not JSON; ignore */
      }
    }
  }
  return calls.length ? { calls, cleaned: content.slice(0, start).trim() } : { calls, cleaned: content.trim() };
}

// Does a reply end by announcing an action it never took ("Let's start by…:", "I'll now ask…")?
// This went through three rounds of verb whitelists before field reports proved the shape
// wrong ("Let's try…", "let's open `Package.swift`", "Let's execute these steps one by one."
// each slipped past). The durable rule: in agent mode, a FINAL SENTENCE that opens with an
// intent phrase (let's / I'll / we will / next, I …) is an announcement, whatever the verb —
// a genuine final answer summarizes, asks, or reports, it doesn't open with intent. Closing
// formulas ("let me know", "I'll wait") are excluded. Used to push back on announce-then-stop
// replies instead of ending the task.

// The last sentence of a reply, for the announce check: fenced code blocks are not prose and
// get stripped first (a reply that ends plan + ```sh block``` + "Let's execute…" must yield
// the announce sentence, not the block); a period only ends a sentence when whitespace
// follows (so `Package.swift` doesn't split), and a colon before a list counts as a boundary.
function lastSentence(text) {
  const prose = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').trim();
  const parts = prose.split(/(?<=[.!?:])\s+/);
  return (parts[parts.length - 1] || '').trim();
}

const ANNOUNCE_CLOSERS = /\b(let (me|us) know|i('|’)?ll (wait|be (here|around|happy)|leave (it|that|this|the rest))|let'?s (see|hope|say))\b/i;
const ANNOUNCE_OPENER = /^(?:["'*_`]|(?:sure|great|okay|ok|good|alright|perfect|now|first|next|then|finally|so)[,.!]?\s+)*(?:let'?s\b|let us\b|i(?:'|’)?ll\b|i will\b|we(?:'|’)?ll\b|we will\b|we can\b|we need to\b|next,? (?:i|we)\b)/i;

function announcesAction(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[:：]\s*$/.test(t)) return true; // ends mid-announcement ("Let's begin by…:")
  const last = lastSentence(t.slice(-600));
  if (!last || ANNOUNCE_CLOSERS.test(last)) return false;
  return ANNOUNCE_OPENER.test(last);
}

// Is a reply a step-by-step instruction list for the user ("Step 1: …", numbered how-to)?
// Used only when a task ran no tools at all: an agent asked to do something should perform the
// steps, not hand them over. A short answer or a brief list of options is left alone.
function looksLikeInstructions(text) {
  const t = String(text || '');
  if (t.length < 200) return false;
  const numbered = (t.match(/^\s{0,3}\d+\.\s/gm) || []).length;
  const stepHeads = (t.match(/^#{0,4}\s*(\*\*)?step\s*\d/gim) || []).length;
  // 'steps' ("Step 3: …" headings) is unmistakably a how-to, even mid-task; a numbered 'list'
  // could also be a legitimate final summary, so the caller treats it with more care.
  if (stepHeads >= 2) return 'steps';
  if (numbered >= 4) return 'list';
  return false;
}

// Remove <system-reminder> blocks a model wrote into its own reply. Only the app issues those;
// a forged one ("I can't interact with the file system, I'll simulate…") poisons every later
// turn, so it must never reach the history or the screen. Returns the cleaned text and whether
// anything was removed; an unclosed block at the end of the reply is removed too.
function stripFakeReminders(text) {
  const t = String(text || '');
  const cleaned = t.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, '').trim();
  return { text: cleaned, found: cleaned !== t.trim() };
}

// Did the model write a tool-output block itself ("<tool_response>Install Xcode from the App
// Store</tool_response>")? Inventing results is worse than announcing: the task looks done
// while nothing ran. A field report ended exactly that way, past every other catcher, because
// the forged block sat after the announce sentence. Only forged OUTPUT counts — a <tool_call>
// block is a real call attempt and stays with the text-call extractor.
function forgedToolResponse(text) {
  return /<\/?tool_(response|result|output|results)>/i.test(String(text || ''));
}

// Does a model error mean "busy right now, try again / try a sibling"? (As opposed to a wrong
// key, a missing model, or a network that is down.)
function isBusyModelError(text) {
  return /\b(503|429|529|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate.?limit|try again later|server had an error)\b/i.test(String(text || ''));
}

// Does a model error mean the model itself is gone for this account (retired, renamed, never
// existed)? Then retrying is pointless and a sibling should be tried at once.
function isDeadModelError(text) {
  return /\b404\b|NOT_FOUND|no longer available|not available to new users|has been (deprecated|retired|decommissioned)|unknown model|does not exist/i.test(String(text || ''));
}

// Sibling models worth trying when one is overloaded or retired. `available` is the provider's
// live /models list when we could fetch it; the static family is only the offline fallback.
// Ranking: pro before flash before flash-lite, newest version first.
// A small model denying its own capabilities ("I'm sorry, but I can't access the file
// system or run commands directly") — always false here, and never a valid final answer in
// agent mode. Deliberately narrow: an "I" + inability verb (not "couldn't", which reports a
// real failure) followed closely by a capability phrase. "The build can't run" or "I can't
// find the file" must not match.
const DENIAL_RE = /\bI\s*(?:'m|am)?\s*(?:sorry[^.!\n]{0,40})?(?:can\s*(?:'|no)t|cannot|unable to|don'?t have (?:the ability|access|a way|permission))\b[^.!\n]{0,80}\b(?:access|run|execute|interact|perform|connect|see|reach)\b[^.!\n]{0,60}\b(?:file\s*system|commands?|system|computer|network|directly|machine|terminal|shell|server|device)\b/i;
const AS_AI_RE = /\bas an AI\b[^.!\n]{0,80}\b(?:can\s*(?:'|no)t|cannot|unable)\b/i;

function deniesCapability(text) {
  const t = String(text || '');
  return DENIAL_RE.test(t) || AS_AI_RE.test(t);
}

// Tool-call arguments must be a JSON *object* on the wire: Ollama's and Anthropic's native
// APIs reject arrays and scalars, and because the history replays every earlier call, one
// bad `arguments` bricks the whole conversation with a 400 on every later request. Valid
// JSON that isn't an object gets wrapped; unparsable text stays as-is (executors handle it).
function normalizeToolArgs(argText) {
  const raw = String(argText ?? '').trim();
  if (!raw) return '{}';
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return raw;
    return JSON.stringify({ value: v });
  } catch {
    return raw;
  }
}

const GEMINI_FAMILY = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const CLAUDE_FAMILY = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// Anthropic siblings: opus > sonnet > haiku, newest version of each first. Version is read
// from the trailing "-5-5" style suffix; dated legacy ids (claude-3-5-sonnet-20241022) parse
// as 0 and sort last, which is what we want.
function claudeAlternates(failed, available) {
  const live = [...new Set(available || [])]
    .map(String)
    .filter((m) => /^claude-/i.test(m))
    .filter((m) => !/(fable|mythos)/i.test(m)); // higher-priced research tier: never auto-switch into it
  const pool = live.length ? live : CLAUDE_FAMILY;
  const cls = (m) => (/opus/i.test(m) ? 0 : /sonnet/i.test(m) ? 1 : /haiku/i.test(m) ? 2 : 3);
  const ver = (m) => {
    const x = /-(\d+)(?:-(\d+))?$/.exec(m);
    return x ? Number(x[1]) + Number(x[2] || 0) / 10 : 0;
  };
  return pool.filter((m) => m !== failed).sort((a, b) => cls(a) - cls(b) || ver(b) - ver(a));
}

function modelAlternates(model, available) {
  const failed = String(model || '').replace(/^models\//, '');
  if (/^claude/i.test(failed)) return claudeAlternates(failed, available);
  if (!/^gemini/i.test(failed)) return [];
  const live = [...new Set((available || []).map((m) => String(m).replace(/^models\//, '')))]
    .filter((m) => /^gemini-\d/i.test(m))
    .filter((m) => !/(embed|imagen|image|tts|audio|live|veo|nano|robotics|computer)/i.test(m));
  const pool = live.length ? live : GEMINI_FAMILY;
  const cls = (m) => (/pro/i.test(m) ? 0 : /flash/i.test(m) && !/lite/i.test(m) ? 1 : /flash/i.test(m) ? 2 : 3);
  const ver = (m) => {
    const x = /gemini-(\d+(?:\.\d+)?)/i.exec(m);
    return x ? parseFloat(x[1]) : 0;
  };
  return pool.filter((m) => m !== failed).sort((a, b) => cls(a) - cls(b) || ver(b) - ver(a));
}

// The <deferred_tools> listing for the system prompt. Built-in deferred tools are few and get
// a line each; MCP tools are grouped per server with a count and a handful of names, because
// tool_search finds them by purpose anyway. A field report showed one reverse-engineering
// server adding ~70 described entries (~30K characters) — more than an 8K context window
// holds, so Ollama truncated every request and the model never saw the user's task.
function deferredListing(tools, namesPerServer = 8) {
  const lines = [];
  const servers = new Map(); // server id -> tool short names
  for (const t of tools || []) {
    const name = String(t?.function?.name || '');
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    if (m) {
      if (!servers.has(m[1])) servers.set(m[1], []);
      servers.get(m[1]).push(m[2]);
    } else if (name) {
      lines.push(`- ${name}: ${String(t.function.description || '').split('. ')[0]}`);
    }
  }
  for (const [id, names] of servers) {
    const shown = names.slice(0, namesPerServer).join(', ');
    lines.push(`- mcp__${id}__* — ${names.length} tool${names.length === 1 ? '' : 's'} from the "${id}" MCP server, e.g. ${shown}${names.length > namesPerServer ? ', …' : ''}`);
  }
  return lines.join('\n');
}

// A hint appended to a run_command result when a POSIX-ism ran in cmd.exe. Small models write
// bash on Windows constantly; cmd's failures are cryptic ("The syntax of the command is
// incorrect"), and `mkdir -p` even SUCCEEDS — by creating a folder literally named "-p".
function cmdShellHint(command, output, platform) {
  if (platform !== 'win32') return null;
  const cmd = String(command || '');
  const out = String(output || '');
  const hints = [];
  if (/\b(mkdir|md)\s+(-p|--parents)\b/i.test(cmd)) {
    hints.push('cmd.exe has no "-p" flag: mkdir -p creates a folder literally named "-p" (remove it with: rmdir "-p"). cmd\'s mkdir already creates missing parent folders.');
  }
  if (/syntax of the command is incorrect|invalid switch/i.test(out) && /\b(mkdir|md|rmdir|rd|del|copy|move|type|cd|dir)\b[^&|]*\s"?[\w.-]+\/[\w./-]/i.test(cmd)) {
    hints.push('cmd.exe reads "/" as a switch: write paths with backslashes (mkdir src\\data).');
  }
  const unix = /^\s*(ls|cat|touch|rm|cp|mv|grep|which|export|pwd)\b/i.exec(cmd);
  if (unix && /is not recognized as an internal or external command/i.test(out)) {
    hints.push(`"${unix[1]}" is a Unix command; in cmd.exe use: ls→dir, cat→type, rm→del (folders: rmdir /s /q), cp→copy, mv→move, grep→findstr, which→where, touch→type nul > file, export→set, pwd→cd.`);
  }
  return hints.length ? `Hint: ${hints.join(' ')}` : null;
}

// ---- Small-model hardening, ported from Strata (github.com/Niko1221/Strata, MIT) ----

// Tool calls a model wrote INSIDE its thinking. Small Qwen models do this constantly; the turn
// then ends with no call and no answer and the task just stops. Strata's rules (serve/
// frontend.py, 37 recorded specimens) decide when such a call is an act rather than a mention:
// the thinking must END with whole <tool_call>…</tool_call> blocks (whitespace only between
// and after), each starting at the beginning of a line (not mid-sentence, indented or quoted)
// and outside a code fence, naming a declared tool — and a turn cut off by the token limit
// never counts (the model was mid-thought). Anything else stays thinking.
function rescueReasoningCalls(reasoning, names, finish) {
  if (finish === 'length') return [];
  const declared = new Set(names || []);
  let tail = String(reasoning || '').replace(/\s+$/, '');
  const blocks = [];
  for (;;) {
    if (!tail.endsWith('</tool_call>')) break;
    const open = tail.lastIndexOf('<tool_call>');
    if (open < 0) break;
    const before = tail.slice(0, open);
    if (before && !/\n$/.test(before)) break; // mid-sentence, indented or quoted: a mention
    const fences = (before.match(/^(```|~~~)/gm) || []).length;
    if (fences % 2) break; // inside a fenced example
    blocks.unshift(tail.slice(open));
    tail = before.replace(/\s+$/, '');
  }
  const calls = [];
  for (const block of blocks) {
    for (const call of extractTextToolCalls(block, [...declared]).calls) {
      if (declared.has(call.function.name)) calls.push(call); // a wrapper naming no declared tool stays text
    }
  }
  return calls.map((call, i) => ({ ...call, id: `call_think_${Date.now()}_${i}` }));
}

// A tool name a small model garbled, mapped back to a known tool — or null. Separators get
// mangled ("mcp__fs=write_file", "mcp__fs.write_file", "mcp__fs_write_file"), spaces creep in
// ("<function= capture>"), and a bare "write_file" stands for the one MCP tool ending in it.
// Never guesses: two candidates means no match. (Strata: serve/test_tool_name_alias.py,
// test_tool_name_space.py.)
function resolveToolName(raw, known) {
  const name = String(raw || '').trim();
  const list = [...new Set(known || [])];
  if (list.includes(name)) return name;
  const canon = (s) => String(s).toLowerCase().replace(/[\s=.:/\\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const c = canon(name);
  if (!c) return null;
  const exact = list.filter((k) => canon(k) === c);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const bare = list.filter((k) => /^mcp_/.test(canon(k)) && canon(k).endsWith(`_${c}`));
  return bare.length === 1 ? bare[0] : null;
}

// How much of the recent thinking is covered by 12-word passages seen at least three times —
// a model reasoning in circles. A port of Strata's reasoning_repeat_coverage (serve/server.py):
// a 2,000-word recent window over at most 30,000 words of history, plus a check that the last
// 2,048 characters aren't one short pattern (period ≤ 64) repeated, which reads as fully looped.
const LOOP_COVERAGE = 0.25;
function reasoningRepeatCoverage(text) {
  const t = String(text || '');
  const tail = t.slice(-2048).toLowerCase();
  if (tail.length === 2048) {
    for (let p = 1; p <= 64; p++) if (tail.slice(p) === tail.slice(0, -p)) return 1;
  }
  const words = (t.toLowerCase().match(/\w+|[^\w\s]/g) || []).slice(-30000);
  const width = 12;
  const window = 2000;
  if (words.length < window) return 0;
  const grams = [];
  for (let i = 0; i + width <= words.length; i++) grams.push(words.slice(i, i + width).join('\u0001'));
  const counts = new Map();
  for (const g of grams) counts.set(g, (counts.get(g) || 0) + 1);
  const start = words.length - window;
  const covered = new Set();
  for (let i = start; i < grams.length; i++) {
    if (counts.get(grams[i]) >= 3) for (let j = i; j < i + width; j++) covered.add(j);
  }
  return covered.size / (words.length - start);
}

// After a failed command: errors that mean a wrong or made-up API name, which check_api answers
// (the idea from XR Blocks: an agent should verify a symbol before calling it).
const API_ERROR = /\b(ImportError|ModuleNotFoundError|AttributeError|cannot import name|has no attribute|is not a function|is not a constructor|does not provide an export named)\b/;
function apiErrorHint(output) {
  return API_ERROR.test(String(output || '')) ? 'Tip: this looks like a wrong or made-up API name — check_api shows whether a name exists and where it really lives (e.g. check_api(["PyQt5.QtCore.Qt"])).' : '';
}

const ToolParseExports = { apiErrorHint, rescueReasoningCalls, resolveToolName, reasoningRepeatCoverage, LOOP_COVERAGE, TOOL_TEXT_MARKER, jsonToolCallRe, textToolCallStart, readJsonObject, extractTextToolCalls, announcesAction, looksLikeInstructions, stripFakeReminders, forgedToolResponse, isBusyModelError, isDeadModelError, modelAlternates, normalizeToolArgs, deniesCapability, deferredListing, cmdShellHint, GEMINI_FAMILY };
if (typeof module !== 'undefined' && module.exports) module.exports = ToolParseExports;
if (typeof window !== 'undefined') window.ToolParse = ToolParseExports;
