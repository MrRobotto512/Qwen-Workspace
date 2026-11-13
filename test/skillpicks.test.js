'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/renderer/skillpicks.js');

test('recommended skills point at folders in anthropics/skills', () => {
  assert.ok(P.PICKS.length >= 4);
  for (const p of P.PICKS) assert.match(p.url, /^https:\/\/github\.com\/anthropics\/skills\/tree\/main\/skills\/[\w-]+$/);
  assert.ok(P.PICKS.some((p) => p.dir === 'frontend-design') && P.PICKS.some((p) => p.dir === 'webapp-testing'));
});

test('a skill\'s size against the context window', () => {
  assert.strictEqual(P.tokensOf(3500), 1000);
  assert.strictEqual(P.weight(9390, 28672), 'ok'); // frontend-design on a 28K window: ~2.7K tokens, 9%
  assert.strictEqual(P.weight(12000, 28672), 'large'); // ~3.4K tokens, 12%
  assert.strictEqual(P.weight(20782, 28672), 'huge'); // pptx: ~5.9K tokens, 21%
  assert.strictEqual(P.weight(33168, 28672), 'huge'); // skill-creator: ~9.5K tokens, 33%
  assert.strictEqual(P.weight(20782, 131072), 'ok');
  assert.strictEqual(P.sizeLabel(9390, 28672), '~2.7K tokens (9% of a 28.7K window)');
  assert.strictEqual(P.loadNote(9390, 28672), '');
  assert.match(P.loadNote(33168, 28672), /takes ~9\.5K tokens \(33% of a 28\.7K window\)\. Use what applies to this task, and do not load it again/);
});

test('which picks are installed, by folder or by name', () => {
  const have = P.installedPicks([{ id: 'project:frontend-design', name: 'frontend-design' }, { id: 'user:x', name: 'pdf' }]);
  assert.ok(have.has('frontend-design') && have.has('pdf') && !have.has('docx'));
});
