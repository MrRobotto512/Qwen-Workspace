'use strict';

// Guards against an agent claiming more than it did (a field report: qwen3-coder finished a game,
// then spent 25 minutes re-posting the same 1,700-character "project completed" summary, each
// time with an `echo "PROJECT COMPLETION CONFIRMED"` or an unchanged todo_write attached, while
// the bug the user had reported was never fixed):
//  - a command that only prints text is not work: it is not run and is not progress;
//  - the same long reply sent again with only such calls is the final answer — the turn ends;
//  - compaction keeps the user's own words, so their bug report outlives the model's claims;
//  - a model that cannot see images is told plainly that "no console errors" is not "looks right".
// Pure logic: no DOM.

(() => {
// ---------- report-only commands ----------
// Split a shell command on && || ; & and newlines, outside quotes. A pipe or a redirection makes
// the command do real work, so those return null (never "report-only").
function segments(cmd) {
  const s = String(cmd || '');
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === '|' && s[i + 1] === '|') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === '|' || ch === '>' || ch === '<') return null;
    if (ch === '&' || ch === ';' || ch === '\n' || ch === '\r') {
      out.push(cur);
      cur = '';
      if (s[i + 1] === '&') i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const PRINT = /^@?(echo(\.|\s|$)|write-host\b|write-output\b|printf\b|rem(\s|$)|::|cls$|clear$|title\b|true$|:$|pause$)/i;
const LISTING = /^@?(dir|ls)(\s|$)/i;
// `echo %PATH%`, `echo $HOME`, `Write-Host $env:JAVA_HOME`, `echo $(node -v)`: printing a
// variable or a command's output is a real lookup, not a report.
const EXPANDS = /%[\w()~:-]+%|\$|`|!\w+!/;

// A command that only prints text (and, at most, lists a folder next to that text): it reports
// or "confirms" something instead of doing it.
function isReportOnlyCommand(cmd) {
  const segs = segments(cmd);
  if (!segs || !segs.length) return false;
  if (segs.some((x) => EXPANDS.test(x))) return false;
  const prints = segs.filter((x) => PRINT.test(x)).length;
  if (!prints) return false;
  return segs.every((x) => PRINT.test(x) || LISTING.test(x));
}

const NOOP_RESULT = 'Not run: this command only prints text, so it does nothing — commands are not a way to report, confirm or "verify" that work is done. If the task is done, reply to the user in plain text with no tool call. If it is not, make the next real change.';

// ---------- the same reply again ----------
const normText = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function trigrams(t) {
  const w = normText(t).split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 2 < w.length; i++) set.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return set;
}

const MIN_REPEAT_CHARS = 150;

// Two replies that say the same thing: long enough to be a summary, and nearly the same words
// in the same order (a changed number or a reworded line still counts).
function sameText(a, b) {
  if (normText(a).length < MIN_REPEAT_CHARS || normText(b).length < MIN_REPEAT_CHARS) return false;
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both) >= 0.8;
}

// A todo_write that would leave the plan exactly as it is.
function todosEqual(before, after) {
  const norm = (list) => JSON.stringify((Array.isArray(list) ? list : []).map((t) => [String(t?.content || '').trim(), String(t?.status || 'pending')]));
  return norm(before) === norm(after);
}

// ---------- the user's own words survive compaction ----------
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const MAX_WORDS = 6;

// The user's messages in `messages`, oldest first, each clipped: what they asked and what they
// reported, in their words. A summary block from an earlier compaction gives back the words it
// kept, so they carry forward from one summary to the next.
function userWords(messages, { max = MAX_WORDS, clip = 500 } = {}) {
  const out = [];
  for (const m of messages || []) {
    if (m?.role !== 'user') continue;
    let text = String(m.content || '');
    const kept = /<user_messages>([\s\S]*?)<\/user_messages>/.exec(text);
    if (kept) {
      for (const line of kept[1].split('\n')) {
        const q = /^- “([\s\S]*)”$/.exec(line.trim());
        if (q) out.push(q[1]);
      }
    }
    text = text.replace(/<conversation-summary>[\s\S]*?<\/conversation-summary>/g, '').replace(REMINDER, '').trim();
    if (!text) continue;
    out.push(text.replace(/\s+/g, ' ').slice(0, clip) + (text.length > clip ? '…' : ''));
  }
  // Repeats ("continue", "ok") say nothing new; keep the latest of each.
  const seen = new Set();
  const uniq = [];
  for (let i = out.length - 1; i >= 0; i--) {
    const k = normText(out[i]);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.unshift(out[i]);
  }
  return uniq.slice(-max);
}

function userWordsBlock(words) {
  if (!words?.length) return '';
  return `<user_messages>\nThe user's own words, most recent last. A problem they reported here is still open unless a tool result showed it fixed:\n${words.map((w) => `- “${w.replace(/”/g, '"')}”`).join('\n')}\n</user_messages>`;
}

const COMPACT_RULES = 'Separate what tool results proved from what the assistant only said. Write an unproven claim as "Claimed, not verified: …" — for example "the game works" when no test showed it. A problem the user reported stays open until a tool result showed it fixed; never write that it was resolved because the assistant said so, and never write that something both works and is still broken.';

// ---------- a model that cannot see the screenshot ----------
const BLIND_NOTE = 'You cannot see this screenshot, so "No console errors" only means nothing crashed — not that the page looks right. Objects can be missing, off-screen or invisible without any error. Do not tell the user it works or that a visual problem is fixed unless a description below, or the user, confirms it.';

// The prompt for a vision model describing a screenshot for a model that cannot see it.
function lookPrompt(task) {
  const t = String(task || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  return `A coding agent that cannot see images just tested what it built and took this screenshot.${t ? `\nThe user's latest request: "${t}"` : ''}\n\nDescribe literally what is on the screen in 3–5 short sentences: the main objects and their colours and places, any text, and whether anything looks empty, missing, cut off or broken. Do not guess at what is not visible. Then one last line: "Matches the request: yes", "partly" or "no", with the reason in a few words.`;
}

const HonestyExports = { segments, isReportOnlyCommand, NOOP_RESULT, normText, sameText, MIN_REPEAT_CHARS, todosEqual, userWords, userWordsBlock, COMPACT_RULES, BLIND_NOTE, lookPrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = HonestyExports;
if (typeof window !== 'undefined') window.Honesty = HonestyExports;
})();
