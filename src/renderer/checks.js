'use strict';

// Checks gate (an idea from Strata's test-gated attempts: keep a change only if the checks do not
// get worse). A project declares its checks — fast commands such as `npm test` — in
// .qwen/checks.json (the /checks command detects and writes it). They run before an agent task
// and again after it; a check that passed before and fails after is a regression. The agent gets
// one attempt to fix it; if it is still broken, a card offers to roll back exactly the files this
// task changed (never a file someone edited since). This file is the pure logic: no DOM, no fs.

const CHECKS_FILE = '.qwen/checks.json';
const MAX_CHECKS = 5;
const DEFAULT_TIMEOUT_SEC = 300;
// npm's placeholder test script fails on purpose; it is not a real check.
const NPM_PLACEHOLDER = /no test specified/i;

function cleanCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const command = String(raw.command || '').trim();
  if (!command || command.length > 500 || /[\r\n]/.test(command)) return null;
  const name = String(raw.name || command.split(/\s+/).slice(0, 2).join(' ')).trim().slice(0, 40);
  const t = Number(raw.timeoutSec);
  const timeoutSec = Number.isFinite(t) && t > 0 ? Math.min(Math.max(Math.round(t), 10), 1800) : DEFAULT_TIMEOUT_SEC;
  return { name, command, timeoutSec };
}

// The file's text → { checks } or { error }. Accepts { "checks": [...] } or a bare array.
function parseChecksFile(text) {
  let j;
  try {
    j = JSON.parse(String(text || ''));
  } catch (e) {
    return { checks: [], error: `${CHECKS_FILE} is not valid JSON: ${e.message}` };
  }
  const list = Array.isArray(j) ? j : Array.isArray(j?.checks) ? j.checks : null;
  if (!list) return { checks: [], error: `${CHECKS_FILE} needs a "checks" list` };
  const checks = [];
  const seen = new Set();
  for (const raw of list) {
    const c = cleanCheck(raw);
    if (!c || seen.has(c.name)) continue;
    seen.add(c.name);
    checks.push(c);
    if (checks.length >= MAX_CHECKS) break;
  }
  return checks.length ? { checks } : { checks: [], error: `${CHECKS_FILE} lists no usable checks` };
}

function serializeChecks(checks) {
  return JSON.stringify({ checks: checks.map((c) => ({ name: c.name, command: c.command, ...(c.timeoutSec && c.timeoutSec !== DEFAULT_TIMEOUT_SEC ? { timeoutSec: c.timeoutSec } : {}) })) }, null, 2) + '\n';
}

// Suggested checks from what the project root holds: `entries` are root file/folder names, `pkg`
// the parsed package.json (or null), `pyproject` its text (or ''). One test runner, plus npm
// lint/typecheck scripts when declared.
function detectChecks({ entries, pkg, pyproject } = {}) {
  const has = new Set((entries || []).map((e) => String(e).toLowerCase()));
  const out = [];
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  if (scripts.test && !NPM_PLACEHOLDER.test(scripts.test)) out.push({ name: 'tests', command: 'npm test' });
  else if (has.has('pytest.ini') || has.has('conftest.py') || /\[tool\.pytest/.test(pyproject || '') || ((has.has('tests') || has.has('test')) && (has.has('pyproject.toml') || has.has('requirements.txt') || has.has('setup.py')))) out.push({ name: 'tests', command: 'python -m pytest -q' });
  else if (has.has('cargo.toml')) out.push({ name: 'tests', command: 'cargo test' });
  else if (has.has('go.mod')) out.push({ name: 'tests', command: 'go test ./...' });
  for (const k of ['typecheck', 'lint']) if (scripts[k]) out.push({ name: k, command: `npm run ${k}` });
  return out.slice(0, MAX_CHECKS);
}

function statusLine(runs) {
  return (runs || []).map((r) => `${r.name} ${r.ok ? '✓' : '✗'}`).join(', ');
}

// Before vs after, by check name: regressed (passed → fails), fixed (failed → passes), and the
// verdict. "worse" wins over "better": a task that fixes one check and breaks another regressed.
function compareRuns(before, after) {
  const b = new Map((before || []).map((r) => [r.name, r.ok]));
  const regressed = [];
  const fixed = [];
  for (const r of after || []) {
    if (!b.has(r.name)) continue;
    if (b.get(r.name) === true && !r.ok) regressed.push(r);
    else if (b.get(r.name) === false && r.ok) fixed.push(r);
  }
  return { regressed, fixed, verdict: regressed.length ? 'worse' : fixed.length ? 'better' : 'same' };
}

function tail(text, n = 1500) {
  const t = String(text || '').trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}

function fixPrompt(regressed) {
  const parts = regressed.map((r) => `"${r.name}" (\`${r.command}\`) passed before this task and fails now:\n${tail(r.output)}`);
  return `<system-reminder>\nYour changes broke checks that passed before this task.\n\n${parts.join('\n\n')}\n\nFix the cause in your changes. Do not weaken, skip or delete the checks or tests. When you finish, the checks run again; if they still fail, your changes from this task may be rolled back.\n</system-reminder>`;
}

// What a rollback would do. `before`: path → content when the task first touched it (null = it
// did not exist). `wrote`: path → what the task last left there (null = deleted). `current`:
// path → what is on disk now (null = missing). A file whose current content is not what the task
// left was edited since — it is skipped, never overwritten.
function rollbackPlan(before, wrote, current) {
  const restore = [];
  const remove = [];
  const skipped = [];
  for (const [p, orig] of before || new Map()) {
    const cur = current?.has(p) ? current.get(p) : null;
    const left = wrote?.has(p) ? wrote.get(p) : null;
    if (cur !== left) {
      skipped.push(p);
      continue;
    }
    if (orig === null) {
      if (cur !== null) remove.push(p);
    } else if (cur !== orig) {
      restore.push({ path: p, content: orig });
    }
  }
  return { restore, remove, skipped };
}

const ChecksExports = { CHECKS_FILE, MAX_CHECKS, DEFAULT_TIMEOUT_SEC, parseChecksFile, serializeChecks, detectChecks, statusLine, compareRuns, fixPrompt, rollbackPlan };
if (typeof module !== 'undefined' && module.exports) module.exports = ChecksExports;
if (typeof window !== 'undefined') window.Checks = ChecksExports;
