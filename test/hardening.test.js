// Small-model hardening ported from Strata (github.com/Niko1221/Strata, MIT). The specimen
// corpus in fixtures/strata_rcall_specimens.json is Strata's, copied unchanged: 37 recorded and
// constructed thinking outputs with the calls that must (and must not) be delivered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/renderer/toolparse.js');

test('rescueReasoningCalls agrees with every Strata specimen', () => {
  const { specimens } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'strata_rcall_specimens.json'), 'utf8'));
  assert.ok(specimens.length >= 37);
  for (const s of specimens) {
    // QWS gets thinking and answer separately; a specimen with </think> has both.
    const cut = s.input.indexOf('</think>');
    const reasoning = cut >= 0 ? s.input.slice(0, cut) : s.input;
    const content = cut >= 0 ? s.input.slice(cut + '</think>'.length) : '';
    const declared = new Set(s.tools);
    const calls = content.trim()
      ? T.extractTextToolCalls(content, s.tools).calls.filter((c) => declared.has(c.function.name))
      : T.rescueReasoningCalls(reasoning, s.tools, s.finish);
    assert.deepStrictEqual(calls.map((c) => c.function.name), s.calls, `specimen ${s.name}`);
  }
});

test('rescueReasoningCalls handles the JSON call style Qwen2.5/Qwen3 use through Ollama', () => {
  const r = 'I need to create the file first.\n\n<tool_call>\n{"name": "write_file", "arguments": {"path": "calc.py", "content": "print(4)"}}\n</tool_call>';
  const calls = T.rescueReasoningCalls(r, ['write_file', 'read_file'], 'stop');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'write_file');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: 'calc.py', content: 'print(4)' });
  assert.ok(calls[0].id.startsWith('call_think_'));
  assert.deepStrictEqual(T.rescueReasoningCalls(r, ['read_file'], 'stop'), []); // undeclared
  assert.deepStrictEqual(T.rescueReasoningCalls(r, ['write_file'], 'length'), []); // cut off
  assert.deepStrictEqual(T.rescueReasoningCalls('', ['write_file'], 'stop'), []);
});

test('resolveToolName repairs garbled names and never guesses', () => {
  const known = ['write_file', 'read_file', 'run_command', 'mcp__fs__write_file', 'mcp__rea__list_strings', 'mcp__gh__list_issues'];
  assert.strictEqual(T.resolveToolName('read_file', known), 'read_file');
  assert.strictEqual(T.resolveToolName(' run_command ', known), 'run_command');
  assert.strictEqual(T.resolveToolName('mcp__fs=write_file', known), 'mcp__fs__write_file');
  assert.strictEqual(T.resolveToolName('mcp__fs.write_file', known), 'mcp__fs__write_file');
  assert.strictEqual(T.resolveToolName('mcp__fs_write_file', known), 'mcp__fs__write_file');
  assert.strictEqual(T.resolveToolName('Run-Command', known), 'run_command');
  assert.strictEqual(T.resolveToolName('list_strings', known), 'mcp__rea__list_strings'); // bare, unique
  // A built-in with the same short name wins over the MCP one (exact match first).
  assert.strictEqual(T.resolveToolName('write_file', known), 'write_file');
  // Ambiguous bare name: two servers have it — no guess.
  assert.strictEqual(T.resolveToolName('list', [...known, 'mcp__a__list', 'mcp__b__list']), null);
  assert.strictEqual(T.resolveToolName('fly_to_mars', known), null);
  assert.strictEqual(T.resolveToolName('', known), null);
});

test('reasoningRepeatCoverage flags circular thinking, not ordinary thinking', () => {
  const loop = Array.from({ length: 300 }, (_, i) => `Wait, let me double check the parser again because the output looked wrong on pass ${i % 2}.`).join(' ');
  assert.ok(T.reasoningRepeatCoverage(loop) >= T.LOOP_COVERAGE, 'a repeated verification pass is a loop');
  const varied = Array.from({ length: 2600 }, (_, i) => `w${i}`).join(' ');
  assert.strictEqual(T.reasoningRepeatCoverage(varied), 0);
  assert.strictEqual(T.reasoningRepeatCoverage('short thought'), 0); // under the 2,000-word window
  assert.strictEqual(T.reasoningRepeatCoverage('0123456789a'.repeat(400)), 1); // one long cycling "word"
});
