'use strict';

// One-click GIMP MCP setup. gimp-mcp (github.com/gimp-mcp/gimp-mcp, GPL-3.0, not bundled — it is
// downloaded on request) is two parts: a plugin that runs inside GIMP and opens a local socket
// (Tools → MCP → Start MCP Server), and an MCP server QWS starts with `uv run`. Setup downloads
// the pinned files into the app's data folder, copies the plugin into the newest GIMP 3.x
// plug-ins folder, and returns the MCP server entry for Settings.

const path = require('path');
const fsp = require('fs/promises');

// Pinned to the revision reviewed for QWS; bump deliberately after reading the diff.
const GIMP_MCP_REPO = 'gimp-mcp/gimp-mcp';
const GIMP_MCP_REF = '7325865385541a01aaf336ebc93b00332297f77f';
const GIMP_MCP_FILES = ['pyproject.toml', 'uv.lock', 'gimp_mcp_server.py', 'gimp-mcp-plugin.py', 'README.md', 'LICENSE'];
const PLUGIN = 'gimp-mcp-plugin.py';

// Where each platform keeps GIMP's per-user settings (one subfolder per major.minor version).
function gimpConfigBases(platform, env, home) {
  if (platform === 'win32') return [path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'GIMP')];
  if (platform === 'darwin') return [path.posix.join(home, 'Library', 'Application Support', 'GIMP')];
  return [
    path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'GIMP'),
    path.posix.join(home, 'snap', 'gimp', 'current', '.config', 'GIMP'),
    path.posix.join(home, '.var', 'app', 'org.gimp.GIMP', 'config', 'GIMP')
  ];
}

// The newest GIMP 3.x version folder among `names` ("3.0", "3.2", "2.10" …), or null.
function newestGimp3(names) {
  const v = (n) => n.split('.').map(Number);
  const ok = (names || []).filter((n) => /^3\.\d+$/.test(n));
  ok.sort((a, b) => v(b)[1] - v(a)[1]);
  return ok[0] || null;
}

function serverEntry(installDir) {
  return { name: 'GIMP', command: 'uv', args: ['run', '--directory', installDir, 'gimp_mcp_server.py'], enabled: true };
}

function uvInstallHint(platform) {
  if (platform === 'win32') return 'winget install --id=astral-sh.uv -e';
  if (platform === 'darwin') return 'brew install uv';
  return 'curl -LsSf https://astral.sh/uv/install.sh | sh';
}

async function findGimpDir({ platform, env, home }) {
  for (const base of gimpConfigBases(platform, env, home)) {
    let names = [];
    try {
      names = (await fsp.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    const ver = newestGimp3(names);
    if (ver) return { dir: path.join(base, ver), version: ver };
  }
  return null;
}

// `deps`: { platform, env, home, dataDir, fetch, hasUv }. Returns { ok, server, steps, message }.
async function setupGimp(deps) {
  const steps = [];
  const gimp = await findGimpDir(deps);
  if (!gimp) {
    return { ok: false, message: 'GIMP 3 was not found. Install GIMP 3.2 or newer from gimp.org, launch it once (so its settings folder exists), then try again.' };
  }
  steps.push(`Found GIMP ${gimp.version} settings at ${gimp.dir}`);
  const installDir = path.join(deps.dataDir, 'mcp', 'gimp-mcp');
  await fsp.mkdir(installDir, { recursive: true });
  for (const f of GIMP_MCP_FILES) {
    const url = `https://raw.githubusercontent.com/${GIMP_MCP_REPO}/${GIMP_MCP_REF}/${f}`;
    const res = await deps.fetch(url);
    if (!res.ok) return { ok: false, steps, message: `Could not download ${f} (HTTP ${res.status}). Check your internet connection and try again.` };
    await fsp.writeFile(path.join(installDir, f), Buffer.from(await res.arrayBuffer()));
  }
  steps.push(`Downloaded gimp-mcp (${GIMP_MCP_REF.slice(0, 7)}) to ${installDir}`);
  const pluginDir = path.join(gimp.dir, 'plug-ins', 'gimp-mcp-plugin');
  await fsp.mkdir(pluginDir, { recursive: true });
  const pluginPath = path.join(pluginDir, PLUGIN);
  await fsp.copyFile(path.join(installDir, PLUGIN), pluginPath);
  if (deps.platform !== 'win32') await fsp.chmod(pluginPath, 0o755);
  steps.push(`Installed the GIMP plugin at ${pluginPath}`);
  const uv = await deps.hasUv();
  return {
    ok: true,
    steps,
    server: serverEntry(installDir),
    uvMissing: !uv,
    message: uv
      ? 'Restart GIMP, open an image, then choose Tools → MCP → Start MCP Server. QWS can then use GIMP\'s tools (and see each edit).'
      : `Almost done: the GIMP server runs with uv, which is not installed. Install it (${uvInstallHint(deps.platform)}), restart QWS, then restart GIMP and choose Tools → MCP → Start MCP Server.`
  };
}

module.exports = { GIMP_MCP_REF, GIMP_MCP_FILES, gimpConfigBases, newestGimp3, serverEntry, uvInstallHint, findGimpDir, setupGimp };
