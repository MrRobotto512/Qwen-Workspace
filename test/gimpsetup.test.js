'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../src/gimpsetup.js');

test('gimpConfigBases per platform', () => {
  assert.deepEqual(G.gimpConfigBases('win32', { APPDATA: 'C:\\Users\\R\\AppData\\Roaming' }, 'C:\\Users\\R'), ['C:\\Users\\R\\AppData\\Roaming\\GIMP']);
  assert.deepEqual(G.gimpConfigBases('darwin', {}, '/Users/r'), ['/Users/r/Library/Application Support/GIMP']);
  assert.deepEqual(G.gimpConfigBases('linux', {}, '/home/r'), ['/home/r/.config/GIMP', '/home/r/snap/gimp/current/.config/GIMP', '/home/r/.var/app/org.gimp.GIMP/config/GIMP']);
});

test('newestGimp3 picks the newest 3.x folder', () => {
  assert.equal(G.newestGimp3(['2.10', '3.0', '3.2', 'tmp']), '3.2');
  assert.equal(G.newestGimp3(['3.10', '3.2']), '3.10');
  assert.equal(G.newestGimp3(['2.10']), null);
});

test('setupGimp downloads the pinned files, installs the plugin, and returns the server', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gimp-home-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gimp-data-'));
  fs.mkdirSync(path.join(home, '.config', 'GIMP', '3.2'), { recursive: true });
  const urls = [];
  const fakeFetch = async (url) => { urls.push(url); return { ok: true, arrayBuffer: async () => new TextEncoder().encode(`# ${path.basename(url)}\n`).buffer }; };
  const r = await G.setupGimp({ platform: 'linux', env: {}, home, dataDir, fetch: fakeFetch, hasUv: async () => true });
  assert.equal(r.ok, true, r.message);
  assert.equal(urls.length, G.GIMP_MCP_FILES.length);
  assert.ok(urls.every((u) => u.includes(G.GIMP_MCP_REF)), 'downloads are pinned to the reviewed revision');
  const plugin = path.join(home, '.config', 'GIMP', '3.2', 'plug-ins', 'gimp-mcp-plugin', 'gimp-mcp-plugin.py');
  assert.ok(fs.existsSync(plugin));
  // The simulated platform is Linux, but a Windows host has no execute bit to set or read.
  if (process.platform !== 'win32') assert.ok(fs.statSync(plugin).mode & 0o100, 'the plugin is executable');
  assert.deepEqual(r.server, { name: 'GIMP', command: 'uv', args: ['run', '--directory', path.join(dataDir, 'mcp', 'gimp-mcp'), 'gimp_mcp_server.py'], enabled: true });
  const noUv = await G.setupGimp({ platform: 'win32', env: { APPDATA: path.join(home, 'none') }, home, dataDir, fetch: fakeFetch, hasUv: async () => false });
  assert.equal(noUv.ok, false);
  assert.match(noUv.message, /GIMP 3 was not found/);
  const missingUv = await G.setupGimp({ platform: 'linux', env: {}, home, dataDir, fetch: fakeFetch, hasUv: async () => false });
  assert.equal(missingUv.uvMissing, true);
  assert.match(missingUv.message, /install\.sh/);
  const bad = await G.setupGimp({ platform: 'linux', env: {}, home, dataDir, fetch: async () => ({ ok: false, status: 404 }), hasUv: async () => true });
  assert.match(bad.message, /Could not download pyproject\.toml \(HTTP 404\)/);
});
