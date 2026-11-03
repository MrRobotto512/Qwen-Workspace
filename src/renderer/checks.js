'use strict';

// Checks gate (an idea from Strata's test-gated attempts: keep a change only if the checks do not
// get worse). A project declares its checks — fast commands such as `npm test` — in
// .qwen/checks.json (the /checks command detects and writes it). They run before an agent task
// and again after it; a test that passed before and fails after is a regression, while a test
// the task itself added that does not pass yet is "pending" (the task is unfinished, nothing
// broke — so no rollback). The agent gets
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

// Failing test names in a runner's output (pytest, unittest, node:test, jest/vitest, mocha, go,
// cargo). An empty set means the runner's format was not recognized — or nothing failed.
const FAIL_PATTERNS = [
  /^(?:FAILED|ERROR) (\S+?)(?: - .*)?$/, // pytest short summary
  /^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)/, // unittest
  /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/, // TAP (node --test, tape)
  /^\s*[✖✕×] (.+?)(?:\s+\(\d[\d.]*\s?m?s\))?$/, // node:test spec, jest, vitest
  /^\s*--- FAIL: (\S+)/, // go test
  /^test (\S+) \.\.\. FAILED$/ // cargo test
];
function failingTests(output) {
  const out = new Set();
  const lines = String(output || '').split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
  let prevMarkIndent = -1; // indentation of the previous ✖ line (node:test spec prints a suite after its tests)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [k, re] of FAIL_PATTERNS.entries()) {
      const m = re.exec(line);
      if (!m) continue;
      // A suite that failed only because a test inside it did is not a test of its own.
      if (k === 2) {
        const block = lines.slice(i + 1, i + 12);
        const end = block.findIndex((l) => /^\s*(?:not )?ok \d+/.test(l));
        if ((end < 0 ? block : block.slice(0, end)).some((l) => /failureType: '?subtestsFailed/.test(l))) break;
      }
      if (k === 3) {
        const indent = line.length - line.trimStart().length;
        const container = prevMarkIndent > indent;
        prevMarkIndent = indent;
        if (container) break;
      }
      const name = (m[2] ? `${m[2]}.${m[1]}` : m[1]).trim();
      if (name && !/^(failing tests:?|tests? failed)$/i.test(name)) out.add(name);
      break;
    }
  }
  return out;
}

// The part of a test name a test file spells out: pytest a.py::Class::test_x[1] → test_x,
// unittest mod.Class.test_x → test_x, go TestX/sub → TestX, cargo mod::tests::x → x; free-text
// titles (node:test, jest) as written.
function testKey(name) {
  const n = String(name || '');
  if (n.includes('::')) return n.split('::').pop().replace(/\[.*\]$/, '');
  if (/^[\w.]+\.\w+$/.test(n) && n.includes('.')) return n.split('.').pop();
  if (/^Test\w*\//.test(n)) return n.split('/')[0];
  return n;
}

// Whether a failing test is one this task wrote: its name appears in a file the task changed
// and did not appear there before. `before`: path → content when the task first touched it
// (null = new file). `wrote`: path → what the task left.
function newTestMatcher(before, wrote) {
  return (name) => {
    const key = testKey(name);
    if (key.length < 3) return false;
    for (const [p, now] of wrote || new Map()) {
      if (now == null || !String(now).includes(key)) continue;
      const was = before?.get(p);
      if (was == null || !String(was).includes(key)) return true;
    }
    return false;
  };
}

// Before vs after, by check name: regressed (passed → fails), fixed (failed → passes), pending
// (fails now only because of tests this task added that do not pass yet), and the verdict.
// With `isNew`, a check that passed before and fails only in new tests is pending, not a
// regression; a check that already failed but now fails in more existing tests regressed.
// "worse" wins over "better": a task that fixes one check and breaks another regressed.
function compareRuns(before, after, isNew) {
  const b = new Map((before || []).map((r) => [r.name, r]));
  const regressed = [];
  const fixed = [];
  const pending = [];
  for (const r of after || []) {
    const was = b.get(r.name);
    if (!was) continue;
    if (was.ok && r.ok) continue;
    if (!was.ok && r.ok) {
      fixed.push(r);
      continue;
    }
    if (!isNew) {
      if (was.ok) regressed.push(r);
      continue;
    }
    const nowFail = failingTests(r.output);
    const wasFail = was.ok ? new Set() : failingTests(was.output);
    const added = [...nowFail].filter((n) => !wasFail.has(n));
    const broke = added.filter((n) => !isNew(n));
    const fresh = added.filter((n) => isNew(n));
    if (was.ok) {
      // Unrecognized output, or an existing test broke: a regression, as before.
      if (!nowFail.size || broke.length) regressed.push({ ...r, broke, newTests: fresh });
      else pending.push({ ...r, newTests: fresh });
    } else if (wasFail.size && broke.length) {
      regressed.push({ ...r, broke, newTests: fresh });
    } else if (fresh.length) {
      pending.push({ ...r, newTests: fresh });
    }
  }
  return { regressed, fixed, pending, verdict: regressed.length ? 'worse' : fixed.length ? 'better' : pending.length ? 'pending' : 'same' };
}

function tail(text, n = 1500) {
  const t = String(text || '').trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}

function fixPrompt(regressed) {
  const parts = regressed.map((r) => `"${r.name}" (\`${r.command}\`) ${r.broke?.length ? `has tests that passed before this task and fail now: ${r.broke.slice(0, 8).join(', ')}` : 'passed before this task and fails now'}:\n${tail(r.output)}`);
  return `<system-reminder>\nYour changes broke checks that passed before this task.\n\n${parts.join('\n\n')}\n\nFix the cause in your changes. Do not weaken, skip or delete the checks or tests. When you finish, the checks run again; if they still fail, your changes from this task may be rolled back.\n</system-reminder>`;
}

// The task's own new tests do not pass yet: not a regression, but the task is not done either.
function pendingPrompt(pending) {
  const parts = pending.map((r) => `"${r.name}" (\`${r.command}\`): ${r.newTests.slice(0, 8).join(', ')}\n${tail(r.output, 1200)}`);
  return `<system-reminder>\nThe tests you added in this task do not pass yet (nothing that passed before broke):\n\n${parts.join('\n\n')}\n\nMake them pass by fixing the code. Change a test only if the test itself is wrong, and say so. When you finish, the checks run again.\n</system-reminder>`;
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

const ChecksExports = { CHECKS_FILE, MAX_CHECKS, DEFAULT_TIMEOUT_SEC, parseChecksFile, serializeChecks, detectChecks, statusLine, failingTests, testKey, newTestMatcher, compareRuns, fixPrompt, pendingPrompt, rollbackPlan };
if (typeof module !== 'undefined' && module.exports) module.exports = ChecksExports;
if (typeof window !== 'undefined') window.Checks = ChecksExports;
