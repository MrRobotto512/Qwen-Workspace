'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sem = require('../src/renderer/semindex.js');
const { diffSegments, applyBlocks } = require('../src/renderer/diffblocks.js');

const PY = `"""Doc."""
import os

CONST = 1


def top(a, b):
    return a + b


@decorator
def decorated():
    pass


class Thing:
    kind = "demo"

    def method(self):
        return CONST
`;

const JS = `import { x } from './util.js'

function add(a, b) { return a + b }

class Store {
  get(k) { return this[k] }
}

const mul = (a, b) => {
  return a * b
}
`;

test('python chunking: prelude, defs, decorators, class header, methods', () => {
  const chunks = sem.chunkFile('m.py', PY);
  const names = new Set(chunks.map((c) => `${c.kind}:${c.name}`));
  assert.ok(names.has('module:prelude'));
  assert.ok(names.has('function:top'));
  assert.ok(names.has('function:decorated'));
  assert.ok(names.has('class:Thing'));
  assert.ok(names.has('function:method'));
  const dec = chunks.find((c) => c.name === 'decorated');
  assert.match(dec.text, /@decorator/);
  const cls = chunks.find((c) => c.kind === 'class');
  assert.match(cls.text, /kind = "demo"/);
  assert.doesNotMatch(cls.text, /def method/);
});

test('js chunking: function, class, arrow const', () => {
  const names = new Set(sem.chunkFile('a.js', JS).map((c) => c.name));
  assert.ok(names.has('add'));
  assert.ok(names.has('Store'));
  assert.ok(names.has('mul'));
});

test('unknown language falls back to overlapping windows covering every line', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
  const chunks = sem.chunkFile('notes.txt', text);
  assert.ok(chunks.every((c) => c.kind === 'window'));
  const covered = new Set();
  for (const c of chunks) for (let l = c.start; l <= c.end; l++) covered.add(l);
  assert.equal(covered.size, 300);
});

test('hash embeddings are deterministic, normalized, and rank similar text closer', () => {
  const [a1] = sem.hashEmbed(['def multiply(x, y): return x * y']);
  const [a2] = sem.hashEmbed(['def multiply(x, y): return x * y']);
  assert.deepEqual(a1, a2);
  const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-6);
  const [q, close, far] = sem.hashEmbed([
    'multiply two numbers',
    'def multiply(a, b): return a * b  # multiply numbers',
    'html template rendering with escaping'
  ]);
  const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
  assert.ok(dot(q, close) > dot(q, far));
});

test('cosineTopK returns the best chunk first', () => {
  const texts = ['def multiply(a, b): return a * b', 'def render(rows): return html', 'class Config: pass'];
  const vecs = sem.hashEmbed(texts);
  const chunks = texts.map((t, i) => ({ path: `f${i}.py`, kind: 'function', name: `c${i}`, start: 1, end: 1, text: t, vec: vecs[i] }));
  const [qv] = sem.hashEmbed(['multiply numbers together']);
  const top = sem.cosineTopK(qv, chunks, 2);
  assert.equal(top[0].chunk.path, 'f0.py');
  assert.equal(top.length, 2);
});

test('import graph: python relative/absolute and js index resolution, one-hop neighbors', () => {
  const files = {
    'pkg/__init__.py': '',
    'pkg/util.py': 'def helper(): pass\n',
    'pkg/main.py': 'from .util import helper\nimport pkg.util\n',
    'web/app.js': "import { x } from './lib/math.js'\nconst y = require('./store')\n",
    'web/lib/math.js': 'export const x = 1\n',
    'web/store/index.js': 'module.exports = {}\n'
  };
  const all = new Set(Object.keys(files));
  assert.deepEqual([...sem.importsOf('pkg/main.py', files['pkg/main.py'], all)].sort(), ['pkg/util.py']);
  assert.deepEqual([...sem.importsOf('web/app.js', files['web/app.js'], all)].sort(), ['web/lib/math.js', 'web/store/index.js']);
  const near = sem.depNeighbors(files, new Set(['pkg/util.py']));
  assert.ok(near.has('pkg/main.py')); // the importer comes back as a neighbor
});

test('diffblocks: segments and partial application', () => {
  const a = 'a\nb\nc\nd\ne';
  const b = 'a\nB\nc\nd\nE\nf';
  const blocks = diffSegments(a, b);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[1].newLines, ['E', 'f']);
  assert.equal(applyBlocks(a, b, new Set([0])), 'a\nB\nc\nd\ne');
  assert.equal(applyBlocks(a, b, new Set([1])), 'a\nb\nc\nd\nE\nf');
  assert.equal(applyBlocks(a, b, new Set([0, 1])), b);
  assert.equal(applyBlocks(a, b, new Set()), a);
});
