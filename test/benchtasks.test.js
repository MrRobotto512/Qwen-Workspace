'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const B = require('../src/renderer/benchtasks.js');

test('every task has a prompt, a time limit and at least one check', () => {
  assert.ok(B.TASKS.length >= 8);
  const ids = new Set();
  for (const t of B.TASKS) {
    assert.ok(t.id && !ids.has(t.id), t.id);
    ids.add(t.id);
    assert.ok(t.prompt.length > 40 && t.minutes > 0 && t.checks.length, t.id);
    for (const c of t.checks) assert.ok(['command', 'page'].includes(c.type), t.id);
  }
  assert.deepEqual(B.tasksFor('quick').map((t) => t.id), ['web-counter', 'fix-oneline-html', 'js-bugfix']);
});

// The checks must be right: a correct solution passes, the untouched seed fails.
const REFERENCE = {
  'js-bugfix': { 'stats.js': "function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }\nfunction median(xs) { const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }\nmodule.exports = { mean, median };\n" },
  'json-fix': { 'config.json': '{"name": "shop", "port": 8080, "debug": true, "origins": ["a.example", "b.example"]}\n' },
  'wordcount-cli': { 'wc.js': "const t = require('fs').readFileSync(process.argv[2], 'utf8');\nconst lines = t.split('\\n').length - (t.endsWith('\\n') ? 1 : 0);\nconsole.log(`${lines} ${t.split(/\\s+/).filter(Boolean).length} ${t.length}`);\n" }
};

for (const [id, solution] of Object.entries(REFERENCE)) {
  test(`${id}: the hidden check passes a correct solution and fails the seed`, () => {
    const task = B.TASKS.find((t) => t.id === id);
    const run = (files) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${id}-`));
      for (const [p, c] of Object.entries({ ...(task.seed || {}), ...files, ...(task.hidden || {}) })) fs.writeFileSync(path.join(dir, p), c);
      try {
        execSync(task.checks[0].command, { cwd: dir, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    assert.equal(run(solution), true, 'a correct solution passes');
    assert.equal(run({}), false, 'the starting point fails');
  });
}

test('summary and comparison with the last run', () => {
  const now = [{ id: 'a', passed: true, minutes: 3 }, { id: 'b', passed: false, minutes: 5 }, { id: 'c', skipped: true }];
  assert.equal(B.summary(now), '1/2 passed (1 skipped) in 8 min');
  assert.deepEqual(B.compare(now, { results: [{ id: 'a', passed: false }, { id: 'b', passed: true }] }), ['fixed', 'broke', '']);
  assert.deepEqual(B.compare(now, null), ['', '', '']);
});
