'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { flattenContent, MAX_IMAGES } = require('../src/mcp.js');

test('flattenContent keeps images for the model and text for the result', () => {
  const r = flattenContent([
    { type: 'text', text: 'Snapshot of layer 1' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    { type: 'resource', resource: { uri: 'file:///a.jpg', mimeType: 'image/jpeg', blob: '/9j/4AAQ' } },
    { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'notes' } }
  ]);
  assert.equal(r.text, 'Snapshot of layer 1\n[image 1: image/png]\n[image 2: image/jpeg]\nnotes');
  assert.deepEqual(r.images, [{ mime: 'image/png', data: 'iVBORw0KGgo=' }, { mime: 'image/jpeg', data: '/9j/4AAQ' }]);
});

test('flattenContent refuses odd formats, oversize and too many images', () => {
  assert.equal(flattenContent([{ type: 'image', mimeType: 'image/tiff', data: 'xx' }]).text, '[image: unsupported format]');
  assert.match(flattenContent([{ type: 'image', mimeType: 'image/png', data: 'x'.repeat(9 * 1024 * 1024) }]).text, /too large/);
  const many = flattenContent(Array.from({ length: MAX_IMAGES + 2 }, () => ({ type: 'image', mimeType: 'image/png', data: 'AA' })));
  assert.equal(many.images.length, MAX_IMAGES);
  assert.match(many.text, /more than 4 in one result/);
  assert.deepEqual(flattenContent([]), { text: '(no output)', images: [] });
  assert.equal(flattenContent([{ type: 'image', mimeType: 'image/png', data: 'AA' }]).text, '[image 1: image/png]');
});
