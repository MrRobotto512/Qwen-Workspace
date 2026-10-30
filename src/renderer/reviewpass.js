'use strict';
// Review pass: after a task edits files, the planner model reviews the conversation's diff
// and hands concrete findings (file, line, issue, exact fix) back for the local model to
// implement — judgment on the strong model, typing on the free one. This file is the pure
// half: building the review request from the changed files, parsing the findings out of the
// reply, and writing the fix-handover prompt. The model calls, the findings card and the
// two-round cap live in agent-loop.js. Nothing is ever applied without the usual approvals.

const RP_MAX_FILE_LINES = 400; // diff lines per file in the review request
const RP_MAX_TOTAL_CHARS = 28000; // whole request body cap
const RP_MAX_FINDINGS = 6;
const RP_MAX_ROUNDS = 2; // after this, surviving findings go to the planner to implement

const RPDiff = typeof module !== 'undefined' && module.exports ? require('./diffblocks.js') : null;

function rpUnified(a, b) {
  const fn = RPDiff ? RPDiff.unifiedDiff : unifiedDiff;
  return fn(a, b);
}

// The reviewer sees a per-file diff (or the whole file when it is new), capped so one huge
// generated file can't eat the request.
function reviewRequest(files) {
  const parts = [];
  for (const f of files || []) {
    let body;
    if (f.deleted) body = '(file deleted by this task)';
    else if (f.original === null || f.original === undefined) {
      body = `(new file)\n${String(f.current ?? '').split('\n').slice(0, RP_MAX_FILE_LINES).join('\n')}`;
    } else {
      const d = rpUnified(String(f.original), String(f.current ?? ''));
      body = d ? d.split('\n').slice(0, RP_MAX_FILE_LINES).join('\n') : '(change too large to diff; review skipped for this file)';
    }
    parts.push(`=== ${f.path} ===\n${body}`);
  }
  let text = parts.join('\n\n');
  if (text.length > RP_MAX_TOTAL_CHARS) text = `${text.slice(0, RP_MAX_TOTAL_CHARS)}\n… [more changes truncated]`;
  return text;
}

const REVIEW_SYSTEM = `You are a senior engineer reviewing another developer's change before it ships. You see one diff per file (new files appear whole). Find REAL defects introduced by this change: bugs, crashes on plausible input, broken edge cases, security problems, resource leaks, and promises the code makes but does not keep. Ignore style, naming and hypothetical refactors.

Reply with at most ${RP_MAX_FINDINGS} findings, strongest first, each in exactly this format:

FINDING
file: <path exactly as shown in the === header>
line: <line number in the new code, or 0 if it spans the file>
issue: <one sentence: what is wrong and when it breaks>
fix: <one or two sentences: the exact change to make, concrete enough to implement without guessing>

If the change is sound, reply with exactly: NO FINDINGS`;

// Parse the reviewer's reply into findings; malformed blocks drop out instead of breaking.
function parseFindings(text) {
  const t = String(text || '').replace(/```[\w]*\n?|```/g, '');
  if (/^\s*NO FINDINGS\s*$/im.test(t) && !/^FINDING\s*$/im.test(t)) return [];
  const out = [];
  const blocks = t.split(/^\s*(?:\d+[.)]\s*)?FINDING\s*$/im).slice(1);
  for (const b of blocks) {
    const field = (name) => new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'im').exec(b)?.[1]?.trim() || '';
    const file = field('file');
    const issue = field('issue');
    const fix = field('fix');
    if (!file || !issue || !fix) continue;
    out.push({ file, line: parseInt(field('line'), 10) || 0, issue: issue.slice(0, 400), fix: fix.slice(0, 600) });
    if (out.length >= RP_MAX_FINDINGS) break;
  }
  return out;
}

// The handover message the fixing model receives. Round 2 adds urgency; after that the
// planner implements survivors itself, so this prompt never goes past round 2.
function fixPrompt(findings, round) {
  const lines = findings.map((f, i) => `${i + 1}. ${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}\n   Fix: ${f.fix}`);
  return `Review findings on your recent changes (round ${round}):\n\n${lines.join('\n\n')}\n\nFix each finding with targeted edits (read the file first, use edit_file). Do not refactor beyond what the findings ask. If a finding is wrong, say why instead of changing code.${round >= RP_MAX_ROUNDS ? ' This is the final round — be precise.' : ''}`;
}

const ReviewPassExports = { RP_MAX_ROUNDS, RP_MAX_FINDINGS, reviewRequest, REVIEW_SYSTEM, parseFindings, fixPrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = ReviewPassExports;
if (typeof window !== 'undefined') window.ReviewPass = ReviewPassExports;
