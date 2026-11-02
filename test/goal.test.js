const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/renderer/goal.js');

test('parseGoalCommand: set, clear, show, and not-a-command', () => {
  assert.deepStrictEqual(G.parseGoalCommand('/goal build a scientific calculator that runs'), { set: 'build a scientific calculator that runs' });
  assert.deepStrictEqual(G.parseGoalCommand('  /GOAL   all tests pass  '), { set: 'all tests pass' });
  for (const off of ['/goal off', '/goal clear', '/goal stop', '/goal none', '/goal cancel']) assert.deepStrictEqual(G.parseGoalCommand(off), { clear: true });
  assert.deepStrictEqual(G.parseGoalCommand('/goal'), { show: true });
  assert.strictEqual(G.parseGoalCommand('make a goal tracker app'), null);
  assert.strictEqual(G.parseGoalCommand('/goals are nice'), null);
});

test('parseVerdict reads DONE/CONTINUE through prose and markdown', () => {
  assert.deepStrictEqual(G.parseVerdict('DONE: calc.py exists and python calc.py exited 0'), { done: true, reason: 'calc.py exists and python calc.py exited 0' });
  assert.deepStrictEqual(G.parseVerdict('**CONTINUE:** write calc.py — it was never created'), { done: false, reason: 'write calc.py — it was never created' });
  assert.deepStrictEqual(G.parseVerdict('Looking at the evidence...\nCONTINUE - run the tests'), { done: false, reason: 'run the tests' });
  // Unreadable verdicts never end the goal.
  assert.deepStrictEqual(G.parseVerdict('Seems fine to me!'), { done: false, reason: '' });
  assert.deepStrictEqual(G.parseVerdict(''), { done: false, reason: '' });
});

test('judgeMessages carries goal, reply and evidence; the judge is told to trust evidence', () => {
  const m = G.judgeMessages('ship calc.py', 'Done!', '$ python calc.py → exit 1');
  assert.strictEqual(m[0].role, 'system');
  assert.ok(/Judge by the evidence, not by the agent's claims/.test(m[0].content));
  assert.ok(m[1].content.includes('ship calc.py') && m[1].content.includes('Done!') && m[1].content.includes('exit 1'));
});

test('continuePrompt names the check count and what is missing', () => {
  const p = G.continuePrompt('ship calc.py', 'write calc.py', 2, 8);
  assert.ok(p.includes('goal check 2/8'));
  assert.ok(p.includes('What is missing: write calc.py'));
  assert.ok(!G.continuePrompt('g', '', 1, 8).includes('What is missing'));
});
