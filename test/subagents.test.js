'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/renderer/subagents.js');
const { sameModel } = require('../src/renderer/nodes.js');

test('parseTasks accepts strings and objects, caps the count', () => {
  assert.deepEqual(S.parseTasks({ tasks: ['write a.txt', { task: 'write b.txt', context: 'use utf-8' }, { task: '  ' }] }).tasks, [
    { task: 'write a.txt', context: '' },
    { task: 'write b.txt', context: 'use utf-8' }
  ]);
  assert.match(S.parseTasks({}).error, /list of 2 to 4/);
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
