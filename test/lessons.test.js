const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/lessons.js');

test('parseLessons keeps at most 3 clean bullets and drops junk', () => {
  const text = 'Here are the lessons:\n\n- Build with `cmake --build build` after configuring\n2) The MSVC workload must be installed first\n* short\n- Third lesson about the toolchain quirk\n- Fourth lesson that should be cut\nNONE';
  const out = L.parseLessons(text);
  assert.strictEqual(out.length, 3);
  assert.ok(out[0].startsWith('- Build with'));
  assert.ok(out[1].startsWith('- The MSVC workload'));
  assert.ok(out[2].startsWith('- Third lesson'));
});

test('parseLessons returns [] for NONE and prose-only replies', () => {
  assert.deepStrictEqual(L.parseLessons('NONE'), []);
  assert.deepStrictEqual(L.parseLessons('Nothing durable happened in this task.'), []);
  assert.deepStrictEqual(L.parseLessons(''), []);
});

test('withLessons creates the section at the end when missing', () => {
  const { content, sectionLines } = L.withLessons('# My Project\n\nSome docs.\n', ['- First lesson here']);
  assert.match(content, /# My Project\n\nSome docs\.\n\n## Lessons\n\n- First lesson here\n/);
  assert.ok(sectionLines >= 3);
  const empty = L.withLessons('', ['- A lesson']);
  assert.match(empty.content, /^## Lessons\n\n- A lesson\n$/);
});

test('withLessons appends inside an existing section, before the next heading', () => {
  const md = '# P\n\n## Lessons\n\n- Old lesson one\n\n## Build\n\nstuff\n';
  const { content } = L.withLessons(md, ['- New lesson two']);
  const body = content.split('## Lessons')[1].split('## Build')[0];
  assert.ok(body.includes('- Old lesson one'));
  assert.ok(body.includes('- New lesson two'));
  assert.ok(content.indexOf('- New lesson two') < content.indexOf('## Build'));
});

test('replaceSection rebuilds the section body and keeps the rest', () => {
  const md = '# P\n\n## Lessons\n\n- a\n- b\n- c\n\n## Build\n\nkeep me\n';
  const out = L.replaceSection(md, ['- merged lesson']);
  assert.ok(out.includes('- merged lesson'));
  assert.ok(!out.includes('- a\n'));
  assert.ok(out.includes('keep me'));
  assert.strictEqual(L.sectionBullets(out).length, 1);
});

test('dedupeLessons drops near-duplicates of what the file already says', () => {
  const md = '## Lessons\n\n- Build with cmake --build build from the repo root\n- Use winget to install the MSVC workload\n';
  const kept = L.dedupeLessons([
    '- Build with `cmake --build build` from the repo root', // same words, new backticks
    '- The tests need pytest-qt installed first' // genuinely new
  ], md);
  assert.strictEqual(kept.length, 1);
  assert.match(kept[0], /pytest-qt/);
});

test('commandSummary pairs commands with outcomes and flags failures', () => {
  const call = (id, command) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] });
  const h = [
    call('a', 'cmake --build build'),
    { role: 'tool', tool_call_id: 'a', content: 'Exit code: 1\nerror LNK2019: unresolved external symbol' },
    call('b', 'cmake --build build --target app'),
    { role: 'tool', tool_call_id: 'b', content: 'Exit code: 0\ndone' }
  ];
  const s = L.commandSummary(h);
  assert.strictEqual(s.ran, 2);
  assert.match(s.text, /failed \(exit 1\): error LNK2019/);
  assert.match(s.text, /--target app\n {2}-> ok/);
  assert.strictEqual(L.commandSummary([]).ran, 0);
});
