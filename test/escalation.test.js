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
