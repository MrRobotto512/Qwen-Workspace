'use strict';
// v0.58: fixes from the review of PR #64.
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/renderer/guitest.js');
const E = require('../src/renderer/editmatch.js');
const N = require('../src/renderer/nodes.js');
const SC = require('../src/syntaxcheck.js');

test('a page whose scripts draw on a canvas that is not on the page is judged by its pixels', () => {
  // Three.js without document.body.appendChild(renderer.domElement), plus a HUD's text.
  assert.strictEqual(G.isBlankPage({ hasCanvas: false, wantsCanvas: true, textChars: 9, interactive: 0 }, true), true);
  assert.strictEqual(G.isBlankPage({ hasCanvas: false, wantsCanvas: false, textChars: 9, interactive: 0 }, true), false, 'a text page with a number on white still is not blank');
  assert.strictEqual(G.isBlankPage({ hasCanvas: false, wantsCanvas: true, textChars: 9 }, false), false, 'a canvas page that drew is not blank');
});

test('\\s+ edits keep a real regex in the new text, allow empty \\s*, and see an edit that already landed', () => {
  const f = 'function count(t) {\n  return t.split(" ").length;\n}\n';
  const r = E.regexWsEdit(f, 'function count(t) {\\s+return t.split(" ").length;', 'function count(t) {\\s+return t.split(/\\s+/).filter(Boolean).length;');
  assert.strictEqual(r.modified, 'function count(t) {\n  return t.split(/\\s+/).filter(Boolean).length;\n}\n');
  assert.strictEqual(E.regexWsEdit('a=1;b=2;\n', 'a=1;\\s*b=2;', 'a=1;\\s*c=3;').modified, 'a=1;c=3;\n', '\\s* may match nothing');
  assert.strictEqual(E.regexWsEdit('x {\n    y();\n}\n', 'x {\\s+\\s+y();', 'x {\\s+z();').modified, 'x {\n    z();\n}\n', 'adjacent tokens are one gap');
  assert.deepStrictEqual(E.regexWsEdit(r.modified, 'function count(t) {\\s+return t.split(" ").length;', 'function count(t) {\\s+return t.split(/\\s+/).filter(Boolean).length;'), { count: 0, already: true });
});

test('the automatic fit floor keeps the app\'s own prompt under 60% of the window', () => {
  assert.strictEqual(N.minAgentCtx(0), 8192);
  assert.strictEqual(N.minAgentCtx(5200), 8704);
  assert.strictEqual(N.minAgentCtx(6000), 10240);
  assert.strictEqual(N.autoFitContext(9216, { min: N.minAgentCtx(6000) }), null, 'a 9216 window would trip the overflow warning');
  assert.strictEqual(N.autoFitContext(9216, { min: N.minAgentCtx(5200) }), 9216);
  assert.strictEqual(N.autoFitContext(16384, { moe: true }), null);
  assert.strictEqual(N.autoFitContext(16384, { enabled: false }), null);
});

test('JSON with comments is not a syntax error; strict JSON stays strict', () => {
  assert.deepStrictEqual(SC.checkJson('{\n  // the target\n  "compilerOptions": { "target": "es2022", }, /* trailing */\n}\n', 'tsconfig.json'), []);
  assert.deepStrictEqual(SC.checkJson('{\n  // note\n  "a": 1\n}\n', '.vscode/settings.json'), []);
  assert.deepStrictEqual(SC.checkJson('{\n  // a comment in any .json\n  "a": 1\n}\n', 'data.json'), []);
  assert.strictEqual(SC.checkJson('{\n  "url": "http://x.example//y",\n  "a": 1,\n}\n', 'config.json').length, 1, 'a trailing comma in plain JSON is still an error');
  assert.strictEqual(SC.checkJson('{\n  "a": 1\n  "b": 2\n}\n', 'tsconfig.json').length, 1, 'a missing comma is an error in JSONC too');
  assert.strictEqual(SC.stripJsonc('{"u": "http://a//b"} // x'), '{"u": "http://a//b"} \n');
});
