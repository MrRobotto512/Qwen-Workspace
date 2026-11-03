'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/renderer/editmatch.js');

const CSS = '.game-over, .start-screen {\n    position: absolute;\n    pointer-events: none;\n}\n\n.game-over {\n    background: red;\n}\n';

test('looseEdit applies an edit whose indentation is off, re-indented to the file', () => {
  // the field report: the model indented the old CSS by 4 extra spaces
  const oldText = '    .game-over, .start-screen {\n        position: absolute;\n        pointer-events: none;\n    }';
  const newText = '    .game-over, .start-screen {\n        position: absolute;\n    }';
  const r = E.looseEdit(CSS, oldText, newText);
  assert.equal(r.modified, '.game-over, .start-screen {\n    position: absolute;\n}\n\n.game-over {\n    background: red;\n}\n');
  assert.match(r.note, /ignoring indentation/);
});

test('looseEdit refuses ambiguous or missing matches and keeps CRLF files CRLF', () => {
  assert.deepEqual(E.looseEdit('a\n  x\nb\n  x\n', 'x', 'y'), { count: 2 });
  assert.deepEqual(E.looseEdit('a\nb\n', 'c', 'd'), { count: 0 });
  assert.deepEqual(E.looseEdit('a\n', '\n\n', 'd'), { count: 0 });
  const r = E.looseEdit('if (a) {\r\n\treturn 1;\r\n}\r\n', '    return 1;', '    return 2;');
  assert.equal(r.modified, 'if (a) {\r\n\treturn 2;\r\n}\r\n');
});

test('glitchIdentifiers flags other scripts inside code, only in code files and fresh ones', () => {
  const after = "const m = new THREE.MeshStandard材料({});\nel.textContent = `High Score: ${high身}`;\n";
  assert.deepEqual(E.glitchIdentifiers('main.js', 'const a = 1;', after), ['MeshStandard材料', 'high身']);
  assert.deepEqual(E.glitchIdentifiers('notes.md', '', after), [], 'not a code file');
  assert.deepEqual(E.glitchIdentifiers('ui.js', 'const title = "你好";', after), [], 'the file already uses that script');
  assert.deepEqual(E.glitchIdentifiers('a.py', '', 'x = 1  # 好\n'), [], 'a word on its own (in a comment or string) is fine');
  assert.match(E.glitchWarning(['high身']), /`high身`.*generation glitch/);
  assert.equal(E.glitchWarning([]), '');
});
