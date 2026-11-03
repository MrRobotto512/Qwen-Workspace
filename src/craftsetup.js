'use strict';

// One-click Craft Anything tools (github.com/storytold/craft-anything, MIT OR Apache-2.0, not
// bundled — downloaded on request). Its command-line tool serves ~320 inspection tools over MCP
// (`craft-anything-cli mcp`): programs, .NET, Java, Android, Electron, websites, firmware, game
// files, a disassembler and decompiler. Setup downloads the pinned release for this OS into the
// app's data folder, checks it against the release's SHA256SUMS.txt, unpacks it and returns the
// MCP server entry. Craft Anything is in early alpha; its own docs list what is verified.

const path = require('path');
const fsp = require('fs/promises');
const crypto = require('crypto');

// Pinned: bump deliberately after reading the release notes.
const CRAFT_VERSION = '0.3.0';
const REPO = 'storytold/craft-anything';
// QWS_CRAFT_RELEASE_BASE points the download at a local stand-in release (the e2e test only).
const releaseUrl = (file, version = CRAFT_VERSION) => `${process.env.QWS_CRAFT_RELEASE_BASE || `https://github.com/${REPO}/releases/download/v${version}`}/${file}`;

// The release file holding the command-line tool for this platform, or null.
function assetFor(platform, arch, version = CRAFT_VERSION) {
  if (platform === 'win32') {
    const a = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[arch];
    return a ? { file: `craft-anything-${version}-windows-${a}-portable.zip`, kind: 'zip', exe: 'craft-anything-cli.exe' } : null;
  }
  if (platform === 'darwin') return { file: `craft-anything-cli-${version}-macos-universal.zip`, kind: 'zip', exe: 'craft-anything-cli' };
  if (platform === 'linux') {
    const a = { x64: 'x86_64', arm64: 'aarch64', riscv64: 'riscv64' }[arch];
    return a ? { file: `craft-anything-${version}-linux-${a}.tar.gz`, kind: 'tar', exe: 'craft-anything-cli' } : null;
  }
  if (platform === 'freebsd' && arch === 'x64') return { file: `craft-anything-${version}-freebsd-x86_64.tar.gz`, kind: 'tar', exe: 'craft-anything-cli' };
  return null;
}

// SHA256SUMS.txt ("<hex>  <file>" per line) as a map file -> hex.
function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m) out.set(path.basename(m[2]), m[1].toLowerCase());
  }
  return out;
}

// The first file named `name` under `dir` (breadth-first, a few levels deep), or null.
async function findFile(dir, name, depth = 4) {
  let level = [dir];
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const folder of level) {
      const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = path.join(folder, e.name);
        if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
        if (e.isDirectory()) next.push(p);
      }
    }
    level = next;
  }
  return null;
}

// The MCP server entry: every tool listed (QWS defers them behind tool_search anyway), results
// marked untrusted — they describe programs, files and sites that are not the user's own words.
function serverEntry(cli) {
  return { name: 'Craft Anything', command: cli, args: ['mcp', '--all-tools'], enabled: true, untrustedResults: true };
}

// deps: { platform, arch, dataDir, fetch(url) -> Response, extract(archive, dest, kind), run(cmd, args) -> {code, out} }
async function setupCraft(deps) {
  const asset = assetFor(deps.platform, deps.arch);
  if (!asset) return { ok: false, message: `Craft Anything has no download for ${deps.platform} ${deps.arch}.` };
  const steps = [];
  const sumsRes = await deps.fetch(releaseUrl('SHA256SUMS.txt'));
  if (!sumsRes.ok) return { ok: false, message: `Couldn't reach the Craft Anything ${CRAFT_VERSION} release on GitHub (HTTP ${sumsRes.status}).` };
  const want = parseSums(await sumsRes.text()).get(asset.file);
  if (!want) return { ok: false, message: `The ${CRAFT_VERSION} release lists no checksum for ${asset.file}, so it was not installed.` };
  const res = await deps.fetch(releaseUrl(asset.file));
  if (!res.ok) return { ok: false, message: `Downloading ${asset.file} failed (HTTP ${res.status}).` };
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== want) return { ok: false, message: `${asset.file} did not match the release's checksum (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…), so it was not installed.` };
  steps.push(`Downloaded ${asset.file} (${(bytes.length / 1048576).toFixed(1)} MB) and checked it against SHA256SUMS.txt`);
  const dir = path.join(deps.dataDir, 'craft-anything');
  const archive = path.join(deps.dataDir, asset.file);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(archive, bytes);
  try {
    await deps.extract(archive, dir, asset.kind);
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => {});
  }
  const cli = await findFile(dir, asset.exe);
  if (!cli) return { ok: false, message: `Unpacked the release, but ${asset.exe} was not in it.` };
  if (deps.platform !== 'win32') await fsp.chmod(cli, 0o755).catch(() => {});
  const v = await deps.run(cli, ['--version']);
  if (v.code !== 0) return { ok: false, message: `${asset.exe} was installed at ${cli} but did not start: ${String(v.out || '').trim().slice(0, 300)}` };
  steps.push(`${String(v.out).trim() || `craft-anything-cli ${CRAFT_VERSION}`} at ${cli}`);
  steps.push('Added the "Craft Anything" MCP server (its tools load on demand through tool_search; Clean room mode by default, so nothing inside a program or page source is read unless you turn on Deep mode)');
  return { ok: true, steps, server: serverEntry(cli), version: CRAFT_VERSION };
}

module.exports = { CRAFT_VERSION, REPO, releaseUrl, assetFor, parseSums, findFile, serverEntry, setupCraft };
