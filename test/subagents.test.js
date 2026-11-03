'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/renderer/subagents.js');
const { sameModel } = require('../src/renderer/nodes.js');

test('parseTasks accepts strings and objects, caps the count', () => {
  assert.deepEqual(S.parseTasks({ tasks: ['write a.txt', { task: 'write b.txt', context: 'use utf-8' }, { task: '  ' }] }).tasks, [
    { task: 'write a.txt', context: '', tier: 'mid' },
    { task: 'write b.txt', context: 'use utf-8', tier: 'mid' }
  ]);
  assert.match(S.parseTasks({}).error, /list of 1 to 4/);
  assert.match(S.parseTasks({ tasks: [''] }).error, /empty/);
  assert.match(S.parseTasks({ tasks: ['a', 'b', 'c', 'd', 'e'] }).error, /At most 4/);
});

test('assignNodes spreads subtasks over healthy nodes that have the model first', () => {
  const nodes = [
    { id: 'this-pc', enabled: true },
    { id: 'big', enabled: true },
    { id: 'old', enabled: true },
    { id: 'off', enabled: false },
    { id: 'down', enabled: true }
  ];
  const health = {
    'this-pc': { up: true, models: ['qwen2.5-coder:7b'] },
    big: { up: true, models: ['qwen2.5-coder:7b', 'qwen3-coder:30b'] },
    old: { up: true, models: ['llama3'] },
    off: { up: true, models: ['qwen2.5-coder:7b'] },
    down: { up: false }
  };
  const ids = (a) => a.map((n) => n.id);
  assert.deepEqual(ids(S.assignNodes(nodes, health, 'qwen2.5-coder:7b', 2, sameModel)), ['this-pc', 'big']);
  assert.deepEqual(ids(S.assignNodes(nodes, health, 'qwen2.5-coder:7b', 4, sameModel)), ['this-pc', 'big', 'old', 'this-pc']);
  assert.equal(S.assignNodes(nodes, {}, 'x', 2, sameModel), null);
});

test('childPrompt carries the context; formatResults keeps only summaries', () => {
  assert.equal(S.childPrompt({ task: 'do it', context: '' }), 'do it');
  assert.match(S.childPrompt({ task: 'do it', context: 'files: a.py' }), /^do it\n\nContext from the agent that delegated this:\nfiles: a\.py$/);
  const out = S.formatResults([
    { task: 'write a.txt', node: 'This PC', status: 'done', summary: 'Wrote a.txt.', files: ['a.txt'] },
    { task: 'write b.txt', node: 'Big PC', status: 'error', summary: 'x'.repeat(4000), files: [] }
  ]);
  assert.match(out, /^1 of 2 subtasks finished\./);
  assert.match(out, /### Subtask 1 \(on This PC\): write a\.txt\nStatus: finished\nFiles changed: a\.txt\nWrote a\.txt\./);
  assert.match(out, /### Subtask 2 \(on Big PC\): write b\.txt\nStatus: failed\nNo files changed\.\nx+…$/);
  assert.ok(out.length < 3400);
  assert.match(S.SUBAGENT_INSTRUCTIONS, /cannot ask the user/);
});

test('tiers: aliases map onto strong, mid and light', () => {
  const t = S.parseTasks({ tasks: [{ task: 'review the spec', tier: 'Strong' }, { task: 'b', model: 'opus' }, { task: 'c', tier: 'haiku' }, { task: 'd', tier: 'sonnet' }, { task: 'e', tier: 'nonsense' }] });
  assert.match(t.error, /At most 4/);
  const ok = S.parseTasks({ tasks: [{ task: 'review the spec', tier: 'Strong' }, { task: 'b', model: 'opus' }, { task: 'c', tier: 'haiku' }, { task: 'e', tier: 'nonsense' }] }).tasks;
  assert.deepEqual(ok.map((x) => x.tier), ['strong', 'strong', 'light', 'mid']);
  assert.equal(S.normTier('medium'), 'mid');
  assert.equal(S.normTier(''), 'mid');
});

test('lighterModel picks one size down in the same family', () => {
  assert.equal(S.lighterModel('qwen3:8b', ['qwen3:1.7b', 'qwen3:4b', 'qwen3:14b', 'llama3.2:3b', 'qwen3:8b']), 'qwen3:4b');
  assert.equal(S.lighterModel('qwen2.5-coder:14b-instruct-q4_K_M', ['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b']), 'qwen2.5-coder:7b');
  assert.equal(S.lighterModel('qwen3:8b', ['qwen3:0.6b']), null, 'below 1B is too small to do real work');
  assert.equal(S.lighterModel('qwen3:8b', ['llama3.2:3b']), null);
  assert.equal(S.lighterModel('gpt-oss', ['gpt-oss:20b']), null);
});

test('groupByKey keeps same-machine subtasks together, in order', () => {
  assert.deepEqual(S.groupByKey(['node:a', 'planner:1', 'node:a', 'node:b']), [[0, 2], [1], [3]]);
  assert.deepEqual(S.groupByKey([]), []);
});

test('formatResults shows the tier and any fallback note', () => {
  const out = S.formatResults([{ task: 'review', node: 'claude-opus on planner', tier: 'strong', status: 'done', summary: 'ok', files: [] }, { task: 'x', node: 'home', tier: 'mid', status: 'done', summary: 's', files: [], note: 'no strong model is set up' }]);
  assert.match(out, /Subtask 1 \(on claude-opus on planner, strong\)/);
  assert.match(out, /Subtask 2 \(on home\): x\nStatus: finished \(no strong model is set up\)/);
});
