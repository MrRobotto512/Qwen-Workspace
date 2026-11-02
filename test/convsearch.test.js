const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/convsearch.js');

const conv = (id, title, lines, updatedAt = 1) => ({
  id, title, workspace: `E:\\${id}`, updatedAt,
  display: lines.map(([t, text]) => (t === 'assistant' ? { t, content: text } : { t, text }))
});
const convs = [
  conv('a1', 'Package the calculator', [['user', 'make calc.exe with pyinstaller'], ['assistant', 'The spec had onefile=True, which is not an EXE kwarg — removed it and the one-file build works.']], 3),
  conv('b2', 'Fix the PS2 rip script', [['user', 'the dlltool error again'], ['assistant', 'Installed MinGW-w64 and the build passed.']], 5),
  conv('c3', 'Calculator UI tweaks', [['user', 'make the buttons bigger'], ['notice', 'Goal achieved: buttons are 48px']], 9)
];

test('searchConversations ranks by matched terms and returns snippets', () => {
  const hits = S.searchConversations(convs, 'pyinstaller onefile spec');
  assert.strictEqual(hits[0].id, 'a1');
  assert.strictEqual(hits[0].matched, 3);
  assert.ok(hits[0].snippets.some((s) => /onefile=True/.test(s)));
  assert.ok(!hits.some((h) => h.id === 'b2'), 'unrelated conversations stay out');
});

test('title matches count, newer wins ties, and the current conversation is excluded', () => {
  const hits = S.searchConversations(convs, 'calculator');
  assert.deepStrictEqual(hits.map((h) => h.id), ['c3', 'a1']); // both match once in the title; c3 is newer
  assert.deepStrictEqual(S.searchConversations(convs, 'calculator', { excludeId: 'c3' }).map((h) => h.id), ['a1']);
  assert.deepStrictEqual(S.searchConversations(convs, ''), []);
  assert.deepStrictEqual(S.searchConversations(convs, 'zebra'), []);
});

test('condensedConv keeps requests, answers and notices, and caps the length', () => {
  const t = S.condensedConv(convs[2]);
  assert.ok(t.includes('User: make the buttons bigger') && t.includes('Note: Goal achieved'));
  const long = conv('d4', 'long', Array.from({ length: 400 }, (_, i) => ['user', `message number ${i} with some padding text`]));
  const c = S.condensedConv(long, 2000);
  assert.ok(c.length <= 2100 && c.includes('middle omitted'));
});
