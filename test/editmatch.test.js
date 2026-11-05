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

test('blindEdit: the same text with different spacing and line breaks, matched once', () => {
  const E = require('../src/renderer/editmatch.js');
  // The field report: a one-line HTML file, edited with a pretty-printed old_text.
  const file = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Runner</title><style>body{margin:0}canvas{display:block}</style></head><body></body></html>';
  const old = '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="UTF-8">\n  <title>Runner</title>\n  <style>\n    body{margin:0}canvas{display:block}\n  </style>\n</head>\n<body>\n  \n</body>\n</html>';
  const r = E.blindEdit(file, old, '<!DOCTYPE html>\n<html><body><script src="game.js"></script></body></html>');
  assert.equal(r.modified, '<!DOCTYPE html>\n<html><body><script src="game.js"></script></body></html>');
  assert.match(r.note, /ignoring all spaces and line breaks/);
  // Only the matched span changes.
  assert.equal(E.blindEdit('a();\nfunction  goFaster ( ) { return 1 }\nb();', 'function goFaster() {\n  return 1\n}', 'function goFaster() { return 2 }').modified, 'a();\nfunction goFaster() { return 2 }\nb();');
  // Twice in the file, too short, or absent: not applied.
  assert.equal(E.blindEdit('let counter = 1;\nlet counter = 1;\nlet total = 2;', 'let counter =\n 1; let total = 2;', 'z').modified, 'let counter = 1;\nz');
  assert.equal(E.blindEdit('let alpha = 1; let alpha = 1;', 'let alpha = 1;', 'z').count, 0, 'under the minimum length');
  assert.deepEqual(E.blindEdit('one two three four five six seven', 'nine ten eleven twelve thirteen', 'z'), { count: 0 });
  assert.equal(E.blindEdit('const longName = 1; const longName = 1;', 'const longName=1;const longName=1;', 'z').modified, 'z');
  assert.equal(E.blindEdit('const longName = 1;\nconst longName = 1;\nconst longName = 1;', 'const longName=1;const longName=1;', 'z').count, 2);
});

test('regexWsEdit reads \\s+ in old_text as the whitespace in the file, and keeps it in the new text', () => {
  const file = 'function mean(xs) {\n  let sum = 0;\n  for (const x of xs) sum += x;\n  return sum / xs.length;\n}\n';
  const r = E.regexWsEdit(file, 'function mean(xs) {\\s+let sum = 0;\\s+for (const x of xs) sum += x;', 'function mean(xs) {\\s+if (xs.length === 0) return 0;\\s+let sum = 0;\\s+for (const x of xs) sum += x;');
  assert.equal(r.modified, 'function mean(xs) {\n  if (xs.length === 0) return 0;\n  let sum = 0;\n  for (const x of xs) sum += x;\n  return sum / xs.length;\n}\n');
  assert.match(r.note, /\\s\+ for whitespace/);
  assert.deepEqual(E.regexWsEdit(file, 'let sum = 0;', 'x'), { count: 0 }); // no tokens: not this tier's case
  assert.deepEqual(E.regexWsEdit(file, 'nope\\s+here', 'x'), { count: 0 });
  assert.deepEqual(E.regexWsEdit('a\n  b\na\n  b\n', 'a\\s+b', 'c'), { count: 2 }); // ambiguous: left alone
  assert.equal(E.regexWsEdit('x (1+2) y', 'x\\s*(1+2)\\s*y', 'z').modified, 'z'); // regex characters in the text are literal
});
