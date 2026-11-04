'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/anthropiccache.js');

test('cache breakpoints go on the system prompt, the last tool and the newest message', () => {
  const body = {
    model: 'claude-opus-5-5',
    system: 'You are Qwen…',
    tools: [{ name: 'read_file', input_schema: {} }, { name: 'write_file', input_schema: {} }],
    messages: [
      { role: 'user', content: 'make subwaysurfer.html' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'write_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Created' }] }
    ]
  };
  const b = C.addCacheBreakpoints(body);
  assert.deepEqual(b.system, [{ type: 'text', text: 'You are Qwen…', cache_control: { type: 'ephemeral' } }]);
  assert.equal(b.tools[0].cache_control, undefined);
  assert.deepEqual(b.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(b.messages[0].content, 'make subwaysurfer.html', 'earlier messages are untouched');
  assert.equal(body.tools[1].cache_control, undefined, 'the input body is not changed');
  const s = C.addCacheBreakpoints({ messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(s.messages[0].content, [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]);
  const count = JSON.stringify(b).split('cache_control').length - 1;
  assert.ok(count <= 4, 'at most four breakpoints');
});

test('billed input: cache reads at a tenth, writes at 1.25x', () => {
  assert.equal(C.billedInput({ input_tokens: 100, cache_creation_input_tokens: 4000, cache_read_input_tokens: 0 }), 5100);
  assert.equal(C.billedInput({ input_tokens: 100, cache_read_input_tokens: 4000 }), 500);
  assert.equal(C.billedInput({}), 0);
});
