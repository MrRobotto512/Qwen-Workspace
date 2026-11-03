'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/renderer/honesty.js');

test('report-only commands: printing is not work', () => {
  for (const c of [
    'echo "Project completed successfully!" && echo "Files:" && dir /b subwaysurfer*.html README.md',
    'echo "✓ done" && echo "a && b; c"',
    '@echo off',
    'Write-Host "All done"',
    'rem note; echo ok',
    'echo.'
  ]) assert.equal(H.isReportOnlyCommand(c), true, c);
  for (const c of [
    'dir /b', // a plain listing is a real look
    'npm test && echo ok', // real work
    'echo %PATH%', // a variable lookup
    'echo $HOME',
    'Write-Host $env:JAVA_HOME',
    'echo $(node -v)',
    'echo hi > notes.txt', // writes a file
    'echo y | del x.txt', // feeds a command
    'echo !CD!',
    ''
  ]) assert.equal(H.isReportOnlyCommand(c), false, c);
  assert.equal(H.segments('echo "a | b" && echo c').length, 2, 'a pipe inside quotes is text');
});

test('the same long reply again is spotted, a short or different one is not', () => {
  const summary = "I've successfully completed the 3D endless runner game inspired by Subway Surfers. The implementation includes all requested features and is fully playable. Three-lane movement, jumping and sliding, procedural obstacles, coins, increasing difficulty and score tracking all work.";
  assert.equal(H.sameText(summary, summary), true);
  assert.equal(H.sameText(summary, `${summary.replace('fully playable', 'completely playable')}\n`), true, 'a reworded phrase still counts');
  assert.equal(H.sameText('Done.', 'Done.'), false, 'short replies are left alone');
  assert.equal(H.sameText(summary, 'I fixed the coins: they were spawned behind the camera at z=+50, so I moved spawning to z=-120 and added a test that counts visible meshes. Next I will check the obstacles in the same way, then run test_app again.'), false);
});

test('an unchanged plan is spotted', () => {
  const a = [{ content: 'Build game', status: 'completed' }];
  assert.equal(H.todosEqual(a, [{ content: 'Build game ', status: 'completed' }]), true);
  assert.equal(H.todosEqual(a, [{ content: 'Build game', status: 'in_progress' }]), false);
  assert.equal(H.todosEqual(a, [...a, { content: 'Fix coins', status: 'pending' }]), false);
});

test('compaction keeps the user\'s own words, carried across summaries', () => {
  const msgs = [
    { role: 'user', content: 'make subwaysurfer.html, a 3D runner' },
    { role: 'assistant', content: 'Done!' },
    { role: 'user', content: '<system-reminder>\nEditor state\n</system-reminder>' },
    { role: 'user', content: 'I still cannot see coins or obstacles <system-reminder>\nx\n</system-reminder>' },
    { role: 'user', content: 'continue' },
    { role: 'user', content: 'continue' }
  ];
  const words = H.userWords(msgs);
  assert.deepEqual(words, ['make subwaysurfer.html, a 3D runner', 'I still cannot see coins or obstacles', 'continue']);
  const block = H.userWordsBlock(words);
  assert.match(block, /^<user_messages>/);
  assert.match(block, /still open unless a tool result showed it fixed/);
  // The next compaction reads them back out of the earlier summary.
  const next = H.userWords([{ role: 'user', content: `<conversation-summary>\nGame is fully playable.\n${block}\n</conversation-summary>\n\nthe coins are still invisible` }]);
  assert.deepEqual(next, ['make subwaysurfer.html, a 3D runner', 'I still cannot see coins or obstacles', 'continue', 'the coins are still invisible']);
  assert.equal(H.userWords(msgs, { max: 1 })[0], 'continue');
  assert.match(H.COMPACT_RULES, /Claimed, not verified/);
});

test('the look prompt carries the request and asks for a verdict', () => {
  const p = H.lookPrompt('I still cannot see coins');
  assert.match(p, /cannot see images/);
  assert.match(p, /I still cannot see coins/);
  assert.match(p, /Matches the request: yes/);
  assert.match(H.BLIND_NOTE, /No console errors" only means nothing crashed/);
});
