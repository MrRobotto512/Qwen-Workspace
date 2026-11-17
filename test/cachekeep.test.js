'use strict';
const test = require('node:test');
const assert = require('node:assert');
const K = require('../src/renderer/cachekeep.js');
const TB = require('../src/renderer/toolbudget.js');

const tool = (name, description = '') => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });

test('shouldPrune: first prune at 60%, then only after 15% more growth', () => {
  const W = 32768;
  assert.equal(TB.shouldPrune(0.59 * W, W, 0), false);
  assert.equal(TB.shouldPrune(0.6 * W, W, 0), true);
  // after a prune left 0.5W, the next waits for 0.65W, though 60% is passed earlier
  const mark = 0.5 * W;
  assert.equal(TB.shouldPrune(0.61 * W, W, mark), false);
  assert.equal(TB.shouldPrune(0.64 * W, W, mark), false);
  assert.equal(TB.shouldPrune(0.65 * W, W, mark), true);
  // a prune that left 0.4W: the 60% line comes first
  assert.equal(TB.shouldPrune(0.59 * W, W, 0.4 * W), false);
  assert.equal(TB.shouldPrune(0.6 * W, W, 0.4 * W), true);
  // a prune that could not get below 60% (mark 0.65W) waits for 0.8W
  assert.equal(TB.shouldPrune(0.7 * W, W, 0.65 * W), false);
  assert.equal(TB.shouldPrune(0.8 * W, W, 0.65 * W), true);
  assert.equal(TB.shouldPrune(1000, 0, 0), false);
  // a mark from another window, or above the current size (history rewound), no longer applies
  assert.equal(TB.shouldPrune(0.62 * W, W, { tokens: 0.6 * W, window: W }), false);
  assert.equal(TB.shouldPrune(0.62 * W, W, { tokens: 0.6 * W, window: 2 * W }), true);
  assert.equal(TB.shouldPrune(0.62 * W, W, { tokens: 0.7 * W, window: W }), true);
  // before compaction a prune is always tried
  assert.equal(TB.shouldPrune(0.86 * W, W, { tokens: 0.75 * W, window: W }, 0.85), true);
});

test('pruneHistory with a deep cut shortens everything before it at once', () => {
  const big = 'x'.repeat(2000);
  const h = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < 6; i++) {
    h.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) } }] });
    h.push({ role: 'tool', tool_call_id: `c${i}`, content: `${big}${i}` });
  }
  const p = TB.pruneHistory(h, h.length - 2);
  assert.equal(p.pruned, 5);
  // a second pass with the same cut changes nothing (stable prompt)
  const again = TB.pruneHistory(p.messages, h.length - 2);
  assert.equal(again.pruned, 0);
});

test('pickTools: a named tool loads alone; ties over 4 load nothing and list names; loaded tools are skipped', () => {
  const cat = [tool('git_status', 'Show git status'), tool('git_log', 'Show git history'), tool('git_diff', 'Show changes'), tool('git_commit', 'Commit'), tool('git_branch', 'Branches'), tool('mcp__gimp__open', 'Open an image in GIMP'), tool('screenshot', 'Take a screenshot of an image window')];
  const names = (r) => r.tools.map((t) => t.function.name);
  assert.deepEqual(names(K.pickTools(cat, 'git_status')), ['git_status']);
  const git = K.pickTools(cat, 'git');
  assert.deepEqual(git.tools, []);
  assert.deepEqual(git.tied.sort(), ['git_branch', 'git_commit', 'git_diff', 'git_log', 'git_status']);
  assert.deepEqual(names(K.pickTools(cat, 'git', { exclude: new Set(['git_branch']) })).sort(), ['git_commit', 'git_diff', 'git_log', 'git_status']);
  assert.deepEqual(names(K.pickTools(cat, 'gimp')), ['mcp__gimp__open']);
  // description-only matches when no name matches
  assert.deepEqual(names(K.pickTools(cat, 'history')), ['git_log']);
  assert.deepEqual(K.pickTools(cat, ''), { tools: [], tied: [] });
  assert.deepEqual(K.pickTools(cat, 'zz'), { tools: [], tied: [] });
  assert.deepEqual(names(K.pickTools(cat, 'git_status', { exclude: ['git_status'] })), []);
});

test('sortedServers: fixed order by server id and tool name', () => {
  const s = K.sortedServers([{ id: 'zeta', tools: [{ name: 'b' }, { name: 'a' }] }, { id: 'alpha', tools: [{ name: 'y' }, { name: 'x' }] }]);
  assert.deepEqual(s.map((x) => x.id), ['alpha', 'zeta']);
  assert.deepEqual(s[1].tools.map((t) => t.name), ['a', 'b']);
});

test('taskKeepAlive: at least 30m while a task runs; -1 and longer values stay', () => {
  assert.equal(K.taskKeepAlive('5m'), '30m');
  assert.equal(K.taskKeepAlive('300'), '30m');
  assert.equal(K.taskKeepAlive('-1'), '-1');
  assert.equal(K.taskKeepAlive('2h'), '2h');
  assert.equal(K.taskKeepAlive('45m'), '45m');
  assert.equal(K.taskKeepAlive(''), '30m');
  assert.equal(K.taskKeepAlive('0'), '30m');
  assert.equal(K.taskKeepAlive('1h30m'), '1h30m');
  assert.equal(K.taskKeepAlive('10m30s'), '30m');
  assert.equal(K.taskKeepAlive('forever?'), 'forever?'); // unreadable: left as written
  assert.equal(K.durationSec('1h30m'), 5400);
  assert.equal(K.durationSec('90'), 90);
});

test('versionAtLeast and versionAdvice', () => {
  assert.equal(K.versionAtLeast('0.30.0', '0.30.0'), true);
  assert.equal(K.versionAtLeast('0.24.1', '0.30.0'), false);
  assert.equal(K.versionAtLeast('0.40.16', '0.30.0'), true);
  assert.equal(K.versionAtLeast('1.0', '0.30.0'), true);
  assert.equal(K.versionAtLeast(undefined, '0.30.0'), null);
  assert.match(K.versionAdvice('0.24.0', 'Alien'), /older than 0\.30\.0.*Alien/);
  assert.equal(K.versionAdvice('0.35.1'), '');
  assert.equal(K.versionAdvice(undefined), '');
});

test('kvFactor and kvType: f16 vs q8_0 vs q4_0 from a loaded model', () => {
  const GiB = 1024 ** 3;
  const per = 147456; // qwen3:8b f16: 36 layers × 8 KV heads × 256 × 2 bytes
  const ctx = 32768;
  const file = 5.2 * GiB;
  const f16 = file + ctx * per + 0.5 * GiB;
  const q8 = file + ctx * per * (34 / 64) + 0.5 * GiB;
  const q4 = file + ctx * per * (18 / 64) + 0.5 * GiB;
  assert.equal(K.kvType(K.kvFactor({ size: f16, fileSize: file, ctx, kvPerToken: per })), 'f16');
  assert.equal(K.kvType(K.kvFactor({ size: q8, fileSize: file, ctx, kvPerToken: per })), 'q8_0');
  assert.equal(K.kvType(K.kvFactor({ size: q4, fileSize: file, ctx, kvPerToken: per })), 'q4_0');
  assert.equal(K.kvFactor({ size: file, fileSize: file, ctx, kvPerToken: per }), null);
  assert.equal(K.kvFactor({}), null);
  assert.match(K.kvAdvice('f16', 'Alien'), /setx OLLAMA_KV_CACHE_TYPE q8_0/);
  assert.match(K.kvAdvice('f16', 'Alien'), /\(Windows\)/);
  assert.match(K.kvAdvice('f16', 'This PC', 'darwin'), /launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0/);
  assert.match(K.kvCommand('win32'), /OLLAMA_FLASH_ATTENTION 1\nsetx OLLAMA_KV_CACHE_TYPE q8_0/);
  assert.equal(K.kvAdvice('q8_0'), '');
  // parallel slots multiply the reading: above 1.3 is unknown, not f16; between bands unknown
  assert.equal(K.kvType(2.0), null);
  assert.equal(K.kvType(0.78), null);
  assert.equal(K.kvType(0.4), null);
  assert.equal(K.serverKey('http://a:11434/v1/'), 'http://a:11434');
  assert.equal(K.serverKey('http://a:11434/'), 'http://a:11434');
});

test('cacheLine and reread', () => {
  assert.equal(K.cacheLine(20000, 19000), 'prompt 20,000 tokens · 19,000 reused (95%)');
  assert.equal(K.cacheLine(20000, undefined), '');
  assert.equal(K.cacheLine(0, 5), '');
  assert.equal(K.reread(20000, 19000), 1000);
});

test('fingerprint: same text same print, any change a different one', () => {
  assert.equal(K.fingerprint('abc'), K.fingerprint('abc'));
  assert.notEqual(K.fingerprint('abc'), K.fingerprint('abd'));
  assert.match(K.fingerprint(''), /^[0-9a-f]{8}$/);
});
