'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const A = require('../src/apicheck.js');
const { apiErrorHint } = require('../src/renderer/toolparse.js');

const run = (cmd, args, o) => new Promise((r) => {
  let out = '';
  const c = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...(o.env || {}) } });
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  c.on('error', (e) => r({ code: -1, out: `ENOENT ${e.message}` }));
  c.on('close', (code) => r({ code, out }));
});
const hasPython = (() => { try { require('child_process').execFileSync('python3', ['-c', 'import sys; assert sys.version_info >= (3, 11)']); return true; } catch { return false; } })();

test('parseNames accepts dotted names, imports and calls', () => {
  assert.deepEqual(A.parseNames(['from PyQt5.QtGui import Qt', 'json.dumps()', 'import os.path as p', 'bad name!', 'json.dumps']), ['PyQt5.QtGui.Qt', 'json.dumps', 'os.path']);
  assert.deepEqual(A.parseNames('a.b, c.d\ne'), ['a.b', 'c.d', 'e']);
  assert.equal(A.parseNames(Array(20).fill(0).map((_, i) => `m${i}.x`)).length, A.MAX_NAMES);
});

test('languageOf: explicit, node_modules, project kind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apic-'));
  assert.equal(A.languageOf('fs.readFile', root), 'python', 'no project markers: Python by default');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(A.languageOf('fs.readFile', root), 'node');
  assert.equal(A.languageOf('leftpad', root), 'node', 'a Node-only project reports npm packages');
  fs.writeFileSync(path.join(root, 'main.py'), '');
  assert.equal(A.languageOf('leftpad', root), 'python');
  fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true });
  assert.equal(A.languageOf('foo.bar', root), 'node');
  assert.equal(A.languageOf('foo.bar', root, 'python'), 'python');
  assert.equal(A.nodePackageOf('@scope/pkg.fn'), '@scope/pkg');
});

test('formatResults: found, missing module, relocated, typo', () => {
  const text = A.formatResults([
    { name: 'json.dumps', ok: true, kind: 'function', signature: '(obj)' },
    { name: 'cv2.imread', ok: false, missingModule: 'cv2' },
    { name: 'PyQt5.QtGui.Qt', ok: false, owner: 'PyQt5.QtGui', missing: 'Qt', similar: [], elsewhere: ['PyQt5.QtCore.Qt'] },
    { name: 'os.path.joinn', ok: false, owner: 'os.path', missing: 'joinn', similar: ['join'] },
    { name: 'x.y', ok: false, owner: 'x', missing: 'y', similar: [] }
  ], 'python');
  assert.match(text, /^✓ json\.dumps — function \(obj\)$/m);
  assert.match(text, /✗ cv2\.imread — "cv2" is not installed for this Python \(pip install opencv-python\)/);
  assert.match(text, /PyQt5\.QtGui has no "Qt"\. It exists as: PyQt5\.QtCore\.Qt — import it from there\./);
  assert.match(text, /Did you mean: join\?/);
  assert.match(text, /Do not use it; look up the real API/);
});

test('apiErrorHint fires on wrong-API errors only', () => {
  assert.match(apiErrorHint("ImportError: cannot import name 'Qt' from 'PyQt5.QtGui'"), /check_api/);
  assert.match(apiErrorHint('TypeError: foo.baz is not a function'), /check_api/);
  assert.equal(apiErrorHint('SyntaxError: invalid syntax'), '');
});

test('checkApi end to end: real Python and Node', { skip: !hasPython && 'needs python3 >= 3.11' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apic-e2e-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app.py'), 'raise SystemExit("project code must never run")\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'foo', 'index.js'), 'module.exports = { bar(a, b) {} };');
  const r = await A.checkApi({ names: ['email.message.Header', 'os.path.joinn', 'json.dumps', 'app.main', 'foo.bar', 'foo.baz', 'path.join'], language: undefined, root, platform: process.platform, electronPath: process.execPath, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'apic-tmp-')), run });
  // email/os/json/app → Python (the project has .py); foo/path → Node
  assert.match(r.text, /✗ email\.message\.Header — email\.message has no "Header"\. It exists as: email\.header\.Header/);
  assert.match(r.text, /Did you mean: join\?/);
  assert.match(r.text, /✓ json\.dumps — function/);
  assert.match(r.text, /✗ app\.main — "app" is not installed/, 'the project folder is not on sys.path, so its code never runs');
  assert.match(r.text, /✓ foo\.bar — function \(a, b\)/);
  assert.match(r.text, /✗ foo\.baz — foo has no "baz"\. Did you mean: bar\?/);
  assert.match(r.text, /✓ path\.join — function/);
});
