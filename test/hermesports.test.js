'use strict';
// v0.54: the five ports from Hermes Agent.
const test = require('node:test');
const assert = require('node:assert');
const AR = require('../src/renderer/argrepair.js');
const TB = require('../src/renderer/toolbudget.js');
const FS = require('../src/renderer/filestate.js');
const SC = require('../src/syntaxcheck.js');
const RD = require('../src/redact.js');

test('argument repair: the slips small models make', () => {
  const nl = AR.parseArgs('{"path": "a.html", "content": "<p>\n  hi\n</p>"}');
  assert.ok(nl.ok);
  assert.strictEqual(nl.value.content, '<p>\n  hi\n</p>');
  assert.match(nl.fixes.join(), /raw line break/);
  assert.strictEqual(AR.parseArgs('{"path": "C:\\Users\\ryan\\x.txt"}').value.path, 'C:\\Users\\ryan\\x.txt');
  assert.deepStrictEqual(AR.parseArgs('{"todos": [{"content": "x", "status": "pending"},],}').value, { todos: [{ content: 'x', status: 'pending' }] });
  assert.deepStrictEqual(AR.parseArgs('{"path": "a.js", "content": "let x = 1;').value, { path: 'a.js', content: 'let x = 1;' }, 'a reply cut off mid-string');
  assert.deepStrictEqual(AR.parseArgs('{"a": None, "b": True, "c": "None stays"}').value, { a: null, b: true, c: 'None stays' });
  assert.deepStrictEqual(AR.parseArgs("{'path': 'it\\'s.md'}").value, { path: "it's.md" });
  assert.deepStrictEqual(AR.parseArgs('```json\n{"a": 2}\n```').value, { a: 2 });
  assert.deepStrictEqual(AR.parseArgs('{"a": 1}}').value, { a: 1 });
  const good = AR.parseArgs('{"a": "b"}');
  assert.deepStrictEqual(good.fixes, [], 'valid JSON is left alone');
  assert.ok(!AR.parseArgs('not json at all').ok);
});

test('argument coercion to the tool schema', () => {
  const schema = { properties: { start_line: { type: 'number' }, self_test: { type: 'boolean' }, actions: { type: 'array', items: { type: 'object' } }, names: { type: 'array', items: { type: 'string' } }, command: { type: 'string' } } };
  const r = AR.coerceArgs({ start_line: '12', self_test: 'true', actions: '[{"key": "Space"}]', names: 'fs.readFile', command: 5, other: '7' }, schema);
  assert.deepStrictEqual(r.value, { start_line: 12, self_test: true, actions: [{ key: 'Space' }], names: ['fs.readFile'], command: '5', other: '7' });
  assert.strictEqual(r.fixes.length, 5);
  const call = AR.repairCall('{"path": "x", "start_line": "3"}', { properties: { start_line: { type: 'integer' } } });
  assert.strictEqual(call.text, '{"path":"x","start_line":3}');
  assert.strictEqual(AR.repairCall('{"path": "x"}', null).text, '{"path": "x"}', 'nothing to fix: the original text');
  assert.ok(AR.repairCall('{{{', null).failed);
});

test('text tool calls with a raw line break are no longer lost', () => {
  const TP = require('../src/renderer/toolparse.js');
  const r = TP.extractTextToolCalls('Writing it now.\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "line one\nline two"}}', ['write_file']);
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(JSON.parse(r.calls[0].function.arguments).content, 'line one\nline two');
});

test('long results keep their start and their end', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n') + '\nFAILED: 2 tests';
  const r = TB.headTail(lines, 4000);
  assert.ok(r.text.length <= 4000, `${r.text.length}`);
  assert.match(r.text, /^line 1\n/);
  assert.match(r.text, /FAILED: 2 tests$/);
  assert.match(r.text, /characters \(\d+ lines\) cut from the middle/);
  assert.strictEqual(TB.headTail('short', 4000).text, 'short');
  assert.strictEqual(TB.budgetFor(28672), 17203);
  assert.strictEqual(TB.budgetFor(200000), 24000);
  assert.strictEqual(TB.budgetFor(4096), 6000);
  assert.match(TB.savedNote('.qwen/output/x.txt', 3001), /full output \(3001 lines\) is saved in \.qwen\/output\/x\.txt/);
});

test('old tool results are pruned to one line, the recent part stays whole', () => {
  const big = (t) => `Exit code: 1\n${t}\n${'x'.repeat(2000)}`;
  const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const h = [
    { role: 'user', content: 'fix the tests' },
    call('a', 'run_command', { command: 'npm test' }),
    { role: 'tool', tool_call_id: 'a', content: big('first run') },
    call('b', 'write_file', { path: 'a.js', content: 'y\n'.repeat(400) }),
    { role: 'tool', tool_call_id: 'b', content: 'Created a.js (401 lines, +401 −0).' },
    call('c', 'run_command', { command: 'npm test' }),
    { role: 'tool', tool_call_id: 'c', content: big('same') },
    { role: 'user', content: 'still failing' },
    call('d', 'run_command', { command: 'npm test' }),
    { role: 'tool', tool_call_id: 'd', content: big('same') }
  ];
  const keepFrom = 7;
  const r = TB.pruneHistory(h, keepFrom);
  assert.strictEqual(r.messages.length, h.length);
  assert.match(r.messages[2].content, /^\[Earlier result of run_command npm test: exit 1 · \d+ lines/);
  assert.match(r.messages[6].content, /^\[Same as a later result of run_command npm test/);
  assert.match(JSON.parse(r.messages[3].tool_calls[0].function.arguments).content, /^\[401 lines — shortened/);
  assert.strictEqual(r.messages[9].content, h[9].content, 'the recent part is untouched');
  assert.strictEqual(r.messages[0], h[0]);
  assert.ok(r.saved > 3000);
  assert.strictEqual(TB.pruneHistory(r.messages, keepFrom).pruned, 0, 'pruning twice changes nothing');
});

test('read before overwrite', () => {
  const files = {};
  const text = Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n');
  assert.match(FS.overwriteBlocker(files, 'game.js', text), /have not read it in this task/);
  FS.noteRead(files, 'game.js', text, 1, 120);
  assert.match(FS.overwriteBlocker(files, 'game.js', text), /read only lines 1-120 of game\.js's 300/);
  FS.noteRead(files, 'game.js', text, 121, 300);
  assert.strictEqual(FS.overwriteBlocker(files, 'game.js', text), null, 'pages to the end count as a full read');
  assert.match(FS.overwriteBlocker(files, 'game.js', `${text}\nchanged`), /has changed since you last read it/);
  FS.noteWrite(files, 'new.js', 'a\nb');
  assert.strictEqual(FS.overwriteBlocker(files, 'new.js', 'a\nb'), null, 'a file the task wrote itself');
  // A page that skips ahead does not add up.
  const f2 = {};
  FS.noteRead(f2, 'x', text, 200, 300);
  assert.match(FS.overwriteBlocker(f2, 'x', text), /read only lines 1-0/);
});

test('syntax check: pure parts', () => {
  const html = '<!DOCTYPE html>\n<html>\n<script src="three.js"></script>\n<script type="application/json">{"a":1}</script>\n<script>\nlet a = 1;\n</script>\n<script type="module">\nimport x from "./x.js";\n</script>\n</html>';
  const s = SC.inlineScripts(html);
  assert.deepStrictEqual(s.map((x) => [x.line, x.module]), [[5, false], [8, true]]);
  assert.ok(SC.isModuleCode('import fs from "fs";\nfs.x();'));
  assert.ok(SC.isModuleCode('export default 1'));
  assert.ok(!SC.isModuleCode('const imported = require("x");'));
  assert.deepStrictEqual(['a.json', 'b.mjs', 'c.htm', 'd.py', 'e.css', 'f.ts'].map(SC.kindOf), ['json', 'js', 'html', 'python', null, null]);
  const j = SC.checkJson('{\n  "a": 1,\n  "b": 2,\n}');
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].line, 4);
  assert.deepStrictEqual(SC.checkJson('{"ok": true}'), []);
  assert.deepStrictEqual(SC.parseNodeError("/tmp/x.cjs:12\n  }\n  ^\n\nSyntaxError: Unexpected token '}'\n    at wrapSafe"), { line: 12, message: "SyntaxError: Unexpected token '}'" });
  assert.deepStrictEqual(SC.parsePythonError('  File "calc.py", line 3\n    def x(\n         ^\nSyntaxError: \'(\' was never closed'), { line: 3, message: "SyntaxError: '(' was never closed" });
  const before = [{ line: 10, message: 'SyntaxError: Unexpected end of input' }];
  assert.deepStrictEqual(SC.newErrors(before, [{ line: 12, message: 'SyntaxError: Unexpected end of input' }]), [], 'an old error that moved is not new');
  assert.strictEqual(SC.newErrors(before, [{ line: 3, message: "SyntaxError: Unexpected token '}'" }]).length, 1);
  assert.match(SC.resultLine('a.js', [{ line: 3, message: 'SyntaxError: x' }]), /Syntax check: a\.js line 3: SyntaxError: x\. This change introduced it/);
});

test('secrets are hidden with stable placeholders and restored for writes', () => {
  const v = RD.createVault();
  const env = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD\nGITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\nDB=postgres://app:hunter2secret@db.local/x\nPORT=8080\nDEBUG=true';
  const r = RD.redactText(env, v);
  assert.strictEqual(r.count, 3, r.text);
  assert.doesNotMatch(r.text, /sk-proj-abc|ghp_abc|hunter2/);
  assert.match(r.text, /OPENAI_API_KEY=«redacted secret #1 \(sk-…\)»/);
  assert.match(r.text, /postgres:\/\/app:«redacted secret #3»@db\.local/);
  assert.match(r.text, /PORT=8080\nDEBUG=true$/);
  // The same secret keeps its number (prompt caching sees the same prefix).
  assert.strictEqual(RD.redactText(env, v).text, r.text);
  // Restored when a cloud model writes the file back.
  assert.strictEqual(RD.restoreText(r.text, v).text, env);
  assert.strictEqual(RD.restoreText('«redacted secret #99»', v).unknown, 1);
  // Code that only mentions secrets is left alone.
  const code = 'const token = getToken();\nconst password = form.password.value;\nconfig.apiKey = process.env.API_KEY;\nlet max_tokens = 4096;\nconst SECRET_LENGTH = 32;';
  assert.strictEqual(RD.redactText(code, RD.createVault()).count, 0, RD.redactText(code, RD.createVault()).text);
  // JSON config and a header.
  const cfg = RD.redactText('{"apiKey": "AbC123xyz987QWE", "name": "shop"}\nAuthorization: Bearer abc.def.ghi123456', RD.createVault());
  assert.strictEqual(cfg.count, 2, cfg.text);
  // The user's own keys, wherever they appear.
  const known = RD.knownSecrets({ apiKey: 'my-own-key-123456', heavy: { apiKey: 'sk-ant-zzzzzzzzzzzzzzzzzzzzzzzzz' }, baseUrl: 'https://x', keepAlive: '600', remoteAccess: { token: 'pairing-code-9876' } });
  assert.deepStrictEqual(known.sort(), ['my-own-key-123456', 'pairing-code-9876', 'sk-ant-zzzzzzzzzzzzzzzzzzzzzzzzz'].sort());
  const m = RD.redactMessages([{ role: 'tool', content: 'echo my-own-key-123456' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'write_file', arguments: '{"content":"KEY=my-own-key-123456"}' } }] }, { role: 'user', content: [{ type: 'text', text: 'key my-own-key-123456' }, { type: 'image_url' }] }], RD.createVault(), known);
  assert.strictEqual(m.count, 3);
  assert.ok(JSON.parse(m.messages[1].tool_calls[0].function.arguments).content.startsWith('KEY=«redacted secret #'), 'tool-call arguments stay valid JSON');
  assert.doesNotMatch(JSON.stringify(m.messages), /my-own-key/);
  const pem = RD.redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----', RD.createVault());
  assert.match(pem.text, /^«redacted secret #1 \(private key…\)»$/);
});
