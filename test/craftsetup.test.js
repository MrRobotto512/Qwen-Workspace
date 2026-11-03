'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('../src/craftsetup.js');

test('the right release file for each platform', () => {
  assert.equal(C.assetFor('win32', 'x64').file, `craft-anything-${C.CRAFT_VERSION}-windows-x64-portable.zip`);
  assert.equal(C.assetFor('win32', 'x64').exe, 'craft-anything-cli.exe');
  assert.equal(C.assetFor('win32', 'arm64').file, `craft-anything-${C.CRAFT_VERSION}-windows-arm64-portable.zip`);
  assert.equal(C.assetFor('darwin', 'arm64').file, `craft-anything-cli-${C.CRAFT_VERSION}-macos-universal.zip`);
  assert.equal(C.assetFor('linux', 'x64').file, `craft-anything-${C.CRAFT_VERSION}-linux-x86_64.tar.gz`);
  assert.equal(C.assetFor('linux', 'arm64').kind, 'tar');
  assert.equal(C.assetFor('sunos', 'x64'), null);
  assert.match(C.releaseUrl('SHA256SUMS.txt'), /^https:\/\/github\.com\/storytold\/craft-anything\/releases\/download\/v\d+\.\d+\.\d+\/SHA256SUMS\.txt$/);
});

test('checksums parse, and the entry marks results untrusted', () => {
  const h = 'a'.repeat(64);
  const m = C.parseSums(`${h}  craft-anything-0.3.0-linux-x86_64.tar.gz\n${'b'.repeat(64)} *dist/x.zip\nnot a line`);
  assert.equal(m.get('craft-anything-0.3.0-linux-x86_64.tar.gz'), h);
  assert.equal(m.get('x.zip'), 'b'.repeat(64));
  assert.deepEqual(C.serverEntry('/x/cli'), { name: 'Craft Anything', command: '/x/cli', args: ['mcp', '--all-tools'], enabled: true, untrustedResults: true });
});

const fakeRelease = (bytes, sumOverride) => {
  const a = C.assetFor('linux', 'x64');
  const sum = sumOverride || crypto.createHash('sha256').update(bytes).digest('hex');
  return async (url) => {
    if (url.endsWith('SHA256SUMS.txt')) return { ok: true, status: 200, text: async () => `${sum}  ${a.file}\n` };
    if (url.endsWith(a.file)) return { ok: true, status: 200, arrayBuffer: async () => bytes };
    return { ok: false, status: 404 };
  };
};

test('setup checks the checksum, unpacks, finds the tool and runs it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-'));
  const bytes = Buffer.from('fake archive');
  const extract = async (archive, dest) => {
    assert.ok(fs.existsSync(archive));
    fs.mkdirSync(path.join(dest, 'craft-anything-0.3.0', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'craft-anything-0.3.0', 'bin', 'craft-anything-cli'), '#!/bin/sh\n');
  };
  const r = await C.setupCraft({ platform: 'linux', arch: 'x64', dataDir, fetch: fakeRelease(bytes), extract, run: async () => ({ code: 0, out: 'craft-anything-cli 0.3.0' }) });
  assert.equal(r.ok, true, r.message);
  assert.match(r.server.command, /craft-anything-cli$/);
  assert.match(r.steps.join('\n'), /checked it against SHA256SUMS\.txt/);
  assert.equal(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tar.gz')).length, 0, 'the archive is removed');
  const bad = await C.setupCraft({ platform: 'linux', arch: 'x64', dataDir, fetch: fakeRelease(bytes, 'c'.repeat(64)), extract, run: async () => ({ code: 0, out: '' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /did not match the release's checksum/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
