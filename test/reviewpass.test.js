const test = require('node:test');
const assert = require('node:assert');
const RP = require('../src/renderer/reviewpass.js');

test('reviewRequest shows diffs, whole new files, deletions, and caps size', () => {
  const files = [
    { path: 'a.js', original: 'const x = 1;\n', current: 'const x = 2;\n' },
    { path: 'b.py', original: null, current: 'print(1)\n' },
    { path: 'c.txt', original: 'old\n', current: null, deleted: true }
  ];
  const text = RP.reviewRequest(files);
  assert.ok(text.includes('=== a.js ==='));
  assert.ok(text.includes('-const x = 1;') && text.includes('+const x = 2;'));
  assert.ok(text.includes('(new file)\nprint(1)'));
  assert.ok(text.includes('(file deleted by this task)'));
  const huge = [{ path: 'big.js', original: null, current: 'x\n'.repeat(60000) }];
  assert.ok(RP.reviewRequest(huge).length <= 28100);
});

test('parseFindings reads well-formed findings and tolerates noise', () => {
  const reply = `Here is my review:\n\nFINDING\nfile: app/main.py\nline: 42\nissue: The file handle is never closed when rename fails, leaking it on Windows.\nfix: Wrap the open in a with-statement so the handle closes before os.rename.\n\n2) FINDING\nfile: app/args.py\nline: 0\nissue: build_args drops the output flag when the path has spaces.\nfix: Quote output_path before appending, or pass it as a separate argv element (it already is - just remove the manual quoting).\n\nFINDING\nfile: broken.js\nissue: missing fix line so this block is malformed`;
  const out = RP.parseFindings(reply);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0].file, 'app/main.py');
  assert.strictEqual(out[0].line, 42);
  assert.match(out[1].fix, /separate argv element/);
});

test('parseFindings returns [] for NO FINDINGS and junk', () => {
  assert.deepStrictEqual(RP.parseFindings('NO FINDINGS'), []);
  assert.deepStrictEqual(RP.parseFindings('```\nNO FINDINGS\n```'), []);
  assert.deepStrictEqual(RP.parseFindings('Looks good to me, great work!'), []);
  assert.deepStrictEqual(RP.parseFindings(''), []);
});

test('fixPrompt numbers the findings and marks the final round', () => {
  const findings = [{ file: 'a.js', line: 7, issue: 'Off-by-one in the loop.', fix: 'Use < instead of <=.' }];
  const p1 = RP.fixPrompt(findings, 1);
  assert.ok(p1.includes('1. a.js:7 — Off-by-one in the loop.'));
  assert.ok(p1.includes('Fix: Use < instead of <=.'));
  assert.ok(!p1.includes('final round'));
  assert.ok(RP.fixPrompt(findings, RP.RP_MAX_ROUNDS).includes('final round'));
});
