'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/likeness.js');

const pic = (w, h, f) => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x, y);
    const o = (y * w + x) * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return { rgba, width: w, height: h };
};
const scene = (x, y) => (x > 40 && x < 120 && y > 30 && y < 90 ? [220, 40, 40] : y > 100 ? [30, 140, 60] : [20, 30, 60]);

test('a flat picture is blank, a scene is not', () => {
  const flat = pic(320, 180, () => [10, 10, 10]);
  assert.equal(L.isBlank(flat.rgba, flat.width, flat.height), true);
  const s = pic(320, 180, scene);
  assert.equal(L.isBlank(s.rgba, s.width, s.height), false);
  assert.equal(L.isBlank(new Uint8ClampedArray(0), 0, 0), true);
});

test('likeness: the same picture is ~100, a different one is low, size does not matter', () => {
  const a = pic(320, 180, scene);
  assert.ok(L.likeness(a, a) >= 99);
  assert.ok(L.likeness(a, pic(640, 360, (x, y) => scene(x / 2, y / 2))) >= 85, 'the same layout at twice the size');
  const other = pic(320, 180, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [255, 255, 255] : [0, 0, 0]);
  assert.ok(L.likeness(a, other) < 50, `${L.likeness(a, other)}`);
});

test('widths default to desktop, tablet, phone', () => {
  assert.deepEqual(L.normWidths(), [1440, 768, 390]);
  assert.deepEqual(L.normWidths([1280, 1280, 10, 'x']), [1280]);
  assert.match(L.likenessLine(390, 91), /390px wide .*91% .*close/);
  assert.match(L.likenessLine(768, 40), /clearly different/);
});
