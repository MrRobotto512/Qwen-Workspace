const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/renderer/escalation.js');

const call = (id, command) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }]
});
const result = (id, code, extra = '') => ({ role: 'tool', tool_call_id: id, content: `Exit code: ${code}\n${extra}` });

test('commandRuns pairs calls with results in order', () => {
  const h = [
    { role: 'user', content: 'build it' },
    call('a', 'cmake --build .'),
    result('a', 1),
    call('b', 'cmake --build .'),
    result('b', 0)
  ];
  assert.deepStrictEqual(E.commandRuns(h), [
    { command: 'cmake --build .', failed: true },
    { command: 'cmake --build .', failed: false }
  ]);
});

test('commandRuns skips declined commands and other tools', () => {
  const h = [
    call('a', 'rm -rf /'),
    { role: 'tool', tool_call_id: 'a', content: 'The user declined to run this command.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.js"}' } }]
    },
    { role: 'tool', tool_call_id: 'r', content: 'Exit code: 1 — not a command, just file text' }
  ];
  assert.deepStrictEqual(E.commandRuns(h), []);
});

test('commandFailStreak counts consecutive failures of the same command', () => {
  const h = [call('a', 'npm test'), result('a', 1), call('b', 'npm test'), result('b', 1)];
  assert.deepStrictEqual(E.commandFailStreak(h), { command: 'npm test', count: 2 });
});

test('commandFailStreak resets when a different command ran in between', () => {
  const h = [
    call('a', 'npm test'), result('a', 1),
    call('b', 'npm install'), result('b', 0),
    call('c', 'npm test'), result('c', 1)
  ];
  assert.deepStrictEqual(E.commandFailStreak(h), { command: 'npm test', count: 1 });
});

test('commandFailStreak is 0 after a success and on empty history', () => {
  assert.strictEqual(E.commandFailStreak([]).count, 0);
  const h = [call('a', 'npm test'), result('a', 1), call('b', 'npm test'), result('b', 0)];
  assert.strictEqual(E.commandFailStreak(h).count, 0);
});

test('commandFailStreak survives unparsable arguments', () => {
  const h = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'run_command', arguments: '{broken' } }] },
    { role: 'tool', tool_call_id: 'x', content: 'Exit code: 1' }
  ];
  assert.strictEqual(E.commandFailStreak(h).count, 0);
});

test('planFiles counts distinct file names, not versions or prose', () => {
  const todos = [
    { content: 'Update src/main.js and src/renderer/app.js', status: 'pending' },
    { content: 'Fix app.js error handling', status: 'pending' },
    { content: 'Bump to 0.9.28 and test on Node.js 22', status: 'pending' },
    { content: 'Rewrite styles.css, index.html and tools.py', status: 'pending' }
  ];
  const files = E.planFiles(todos);
  assert.ok(files.includes('src/main.js'));
  assert.ok(files.includes('styles.css'));
  assert.ok(files.includes('tools.py'));
  assert.ok(!files.some((f) => f.includes('0.9')), `versions leaked in: ${files}`);
  // src/renderer/app.js and app.js are different mentions but the same leaf; both forms
  // counting separately is acceptable — the threshold is a heuristic, not an exact count.
  assert.ok(files.length >= 5 && files.length <= 7, `got ${files.length}: ${files}`);
});

test('planFiles handles empty and junk input', () => {
  assert.deepStrictEqual(E.planFiles([]), []);
  assert.deepStrictEqual(E.planFiles(null), []);
  assert.deepStrictEqual(E.planFiles([{ content: 'no files here', status: 'pending' }, null, 42]), []);
});

test('planningTools keeps only the planning tools for the plan-first turn', () => {
  const E = require('../src/renderer/escalation.js');
  const tool = (name) => ({ type: 'function', function: { name } });
  const all = ['read_file', 'write_file', 'run_command', 'todo_write', 'ask_user', 'web_search'].map(tool);
  const kept = E.planningTools(all).map((t) => t.function.name);
  assert.deepStrictEqual(kept, ['todo_write', 'ask_user']);
  assert.deepStrictEqual(E.planningTools([]), []);
  assert.deepStrictEqual(E.planningTools(null), []);
});

test('the plan-first reminder tells the planner to plan, record todos, and not execute', () => {
  const E = require('../src/renderer/escalation.js');
  for (const must of ['planning model', 'todo_write', 'Do not execute', 'simplest stack']) {
    assert.ok(E.PLAN_FIRST_REMINDER.includes(must), `reminder is missing "${must}"`);
  }
});

test('vaguePlanSteps flags steps that name no file and no command', () => {
  const E = require('../src/renderer/escalation.js');
  // The field-report plan: toolchain step is concrete (xcode-select), the rest is mush.
  const fieldPlan = [
    { content: 'Verify macOS development toolchain (Xcode command line tools) is installed' },
    { content: 'Create project directory and initial files for macOS scientific calculator app' },
    { content: 'Implement the core calculator logic in Swift' },
    { content: 'Design the user interface using SwiftUI' },
    { content: 'Add functionality for scientific operations (trig, logs, etc.)' },
    { content: 'Build and test the application' }
  ];
  const vague = E.vaguePlanSteps(fieldPlan);
  assert.ok(vague.length * 2 > fieldPlan.length, `the field plan must count as vague, flagged: ${vague}`);
  // A concrete plan passes: file names, backticked commands, known command words.
  const D = 'Do exactly this, with these names and values: write the functions named in the step, keep every number from the request, and check it with the command that shows the step is done.';
  const good = [
    { content: 'Run `swift package init --type executable` in the project folder', details: D },
    { content: 'Write Sources/main.swift with the calculator UI and logic', details: D },
    { content: 'Build with swift build -c release', details: D },
    { content: 'Open the built binary with `open .build/release/Calculator`', details: D }
  ];
  assert.deepStrictEqual(E.vaguePlanSteps(good), []);
  assert.deepStrictEqual(E.vaguePlanSteps([]), []);
  // The reminder names the offending steps.
  assert.ok(E.planRetryReminder([2, 3]).includes('steps 2, 3'));
  assert.ok(E.planRetryReminder([4]).includes('step 4'));
});

test('a plan that builds everything in one step, or only tests and polishes, goes back', () => {
  const E = require('../src/renderer/escalation.js');
  // The field report's plan, written by a strong planner: every step names a file or not, but
  // none is one checked piece of work.
  const field = [
    { content: 'Create subwaysurfer.html with full 3D endless runner game' },
    { content: 'Test game in browser, verify playability and fix issues' },
    { content: 'Polish: ensure 60fps, touch controls, high score persistence' }
  ];
  const p = E.planProblems(field);
  assert.deepStrictEqual(p.map((x) => x.step), [1, 2, 3]);
  assert.match(p[0].why, /whole thing/);
  assert.match(p[2].why, /no check named|no file/);
  assert.match(E.planRetryReminder(p.map((x) => x.step), p), /step 1 builds the whole thing in one step/);
  assert.match(E.planRetryReminder([1], p), /done when/);
  // Split, checked steps pass.
  const DD = 'Write it with the named functions and the exact values given, connect it to the earlier steps, avoid the listed pitfalls, and finish with the check named in the step.';
  const good = [
    { content: 'subwaysurfer.html: Three.js scene, camera behind the player, 3-lane track scrolling toward it — done when test_app shows no errors and the picture is not blank', details: DD },
    { content: 'subwaysurfer.html: player box with ArrowLeft/Right lane switch (eased) and jump (velocity 8, gravity 20) — done when window.selfTest move and act pass', details: DD },
    { content: 'subwaysurfer.html: obstacles and coins spawned 60 units ahead in random lanes — done when the self-test step "spawn" passes', details: DD },
    { content: 'Verify with test_app subwaysurfer.html that every self-test step passes', details: DD }
  ];
  assert.deepStrictEqual(E.planProblems(good), []);
  for (const must of ['done when', 'Never one step that builds the whole thing', 'window.selfTest()']) assert.ok(E.PLAN_FIRST_REMINDER.includes(must), must);
});

test('every step needs details: how to do it, not a heading', () => {
  const E = require('../src/renderer/escalation.js');
  const p = E.planProblems([
    { content: 'calc.py: add() and sub() — done when `python calc.py` prints 2' },
    { content: 'calc.py: mul() — done when `python calc.py` prints 6', details: 'Add mul.' },
    { content: 'calc.py: div() — done when `python calc.py` prints 3', details: 'Add def div(a, b) returning a / b; when b == 0 raise ZeroDivisionError("cannot divide by zero"). Print div(6, 2) in the main block and run python calc.py: it must print 3.0.' }
  ]);
  assert.deepStrictEqual(p.map((x) => [x.step, x.why]), [[1, 'has no details (how to do it)'], [2, 'has only a line of details — say how to do it: names, values, the check']]);
  assert.match(E.PLAN_FIRST_REMINDER, /explain in detail how you would complete the request/);
  assert.match(E.PLAN_FIRST_REMINDER, /give EVERY todo a `details` field/);
});

test('namedFiles: the files the user named, not libraries or URLs', () => {
  const E = require('../src/renderer/escalation.js');
  const ask = 'make subwaysurfer.html\nBuild a playable 3D endless runner game in the browser using HTML, CSS, JavaScript, and Three.js. Load it from https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js and keep scores in src/Score.ts';
  assert.deepStrictEqual(E.namedFiles([ask]), ['subwaysurfer.html', 'src/Score.ts']);
  assert.deepStrictEqual(E.namedFiles(['fix it', 'continue']), []);
  assert.deepStrictEqual(E.namedFiles(['edit main.py', 'and MAIN.PY again']), ['main.py']);
});

test('architect mode: write tools only, a reminder naming the files, a handoff that says test and fix', () => {
  const E = require('../src/renderer/escalation.js');
  const all = ['write_file', 'read_file', 'list_files', 'run_command', 'test_app', 'todo_write'].map((n) => ({ function: { name: n } }));
  assert.deepStrictEqual(E.architectTools(all).map((t) => t.function.name), ['write_file', 'read_file', 'list_files']);
  assert.equal(E.isArchitectTool('run_command'), false);
  assert.match(E.architectReminder(['subwaysurfer.html']), /complete, working first version of subwaysurfer\.html/);
  assert.match(E.architectReminder(['a.html']), /Do not run or test anything/);
  assert.match(E.architectHandoff(['a.html'], 'claude-opus-5-5'), /Do not rewrite these files: test them with test_app/);
});
