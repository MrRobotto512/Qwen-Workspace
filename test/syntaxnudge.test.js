'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/renderer/syntaxnudge.js');

test('a small file is one a model can rewrite whole', () => {
  assert.equal(S.isSmallFile('{\n  "a": 1\n}\n'), true);
  assert.equal(S.isSmallFile(Array(81).fill('x').join('\n')), false);
  assert.equal(S.isSmallFile('x'.repeat(8001)), false);
  assert.equal(S.isSmallFile(''), false);
  assert.equal(S.isSmallFile(null), false);
});

test('the broken line is quoted back, trimmed and capped', () => {
  const text = '{\n  \'name\': "shop",\n  "port": 8080\n  "debug": true\n}';
  assert.equal(S.lineText(text, 2), ' Line 2 is: \'name\': "shop",');
  assert.equal(S.lineText(text, 99), '');
  assert.equal(S.lineText(text, 0), '');
  assert.equal(S.lineText(null, 2), '');
  assert.equal(S.lineText('a\n\nb', 2), ' Line 2 is empty.');
  assert.equal(S.lineText(`x${'y'.repeat(300)}`, 1).length, ' Line 1 is: '.length + 160);
});

test('the rewrite nudge names the file and its size', () => {
  assert.equal(S.rewriteLine('config.json', 'a\nb\nc'), ' config.json is small (3 lines): rewrite it whole with write_file, correct from top to bottom, instead of another edit.');
  assert.match(S.rewriteLine('x.js', null), /x\.js is small: rewrite it whole/);
});
