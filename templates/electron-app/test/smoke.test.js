const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('package.json is sane', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(fs.existsSync(path.join(root, pkg.main)));
});

test('main and preload parse', () => {
  for (const f of ['src/main.js', 'src/preload.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, f)]);
  }
});
