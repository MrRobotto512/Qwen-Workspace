'use strict';

// Commands that must not hang the agent (a field report from the benchmark: Opus ran
// `start /b python -m http.server 8765 >nul 2>&1 & timeout /t 2 >nul & curl … counter.html`; curl
// answered 200 and the whole command then sat for the full 2 minutes, because the server it
// started kept the output open — and `timeout /t 2` failed as "invalid time interval '/t'",
// because Git's Unix `timeout` came first on PATH).
//  - Git's Unix tools (usr\bin) go after Windows' own on PATH, so timeout, find and sort are
//    the Windows ones, and ls, cat and grep still work;
//  - `timeout /t N` (which also fails with no keyboard to read) becomes a ping wait;
//  - once a command returns, a program it left running (a server started with `start /b` or
//    `&`) keeps running in the background instead of holding the command open;
//  - a server started in the foreground (`npm run dev`, `python -m http.server`) moves to the
//    background once it has had a few seconds to start, with its output so far.
// Pure: no Electron, no processes.

// PATH entries for a Git install: what goes before the system PATH and what goes after it.
function gitPathParts(gitCmdDir, join, exists = () => true) {
  if (!gitCmdDir) return { before: [], after: [] };
  const root = gitCmdDir.replace(/[\\/][^\\/]+[\\/]?$/, ''); // parent of cmd/
  const before = [gitCmdDir, join(root, 'bin'), join(root, 'mingw64', 'bin')].filter(exists);
  const after = [join(root, 'usr', 'bin')].filter(exists);
  return { before, after };
}

// `timeout /t 2 [/nobreak]` waits for a key press as well as the time, and quits at once with
// "Input redirection is not supported" when, as here, there is no keyboard. `ping -n 3` to
// localhost waits about 2 seconds anywhere.
const WAIT = /(^|[\s&|;(])timeout(?:\.exe)?\s+\/t\s+(\d+)((?:\s+\/nobreak)?)(?=\s|$|[&|;)>])(\s*>\s*nul\b)?/gi;
function rewriteWindowsWait(command) {
  let changed = false;
  const out = String(command || '').replace(WAIT, (_m, pre, secs, _nb, redirect) => {
    changed = true;
    return `${pre}ping -n ${Math.max(1, Number(secs) + 1)} 127.0.0.1 >nul`;
  });
  return { command: out, changed };
}

// A command whose job is to keep running: a dev or file server. Used only to move it to the
// background after it starts, never to refuse it.
const SERVER = [
  /\bpython[\d.]*(?:\.exe)?\s+(?:-\w+\s+)*-m\s+http\.server\b/i,
  /\bpy(?:\s+-3)?\s+-m\s+http\.server\b/i,
  /(?:^|[&|;(])\s*(?:npx\s+(?:-y\s+)?)?(?:http-server|live-server|serve)(?=\s|$)/i,
  /\bnpm\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i,
  /\b(?:yarn|pnpm)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i,
  /(?:^|[&|;(])\s*(?:npx\s+)?vite(?:\s+(?:dev|preview|serve))?(?=\s+--?\w|\s*$|\s*[&|;)])/i,
  /\bnext\s+(?:dev|start)\b/i,
  /\bflask\s+run\b/i,
  /\buvicorn\s+\S/i,
  /\bmanage\.py\s+runserver\b/i,
  /\bphp\s+-S\s/i,
  /\bjekyll\s+serve\b/i,
  /\bhugo\s+server\b/i
];
const isServerCommand = (command) => SERVER.some((re) => re.test(String(command || '')));

// A server the command runs in the foreground, so the command itself would never return —
// not one it starts in the background (`server &` on macOS/Linux, `start /b server` on
// Windows, where a lone & just runs the next command after it).
function foregroundServer(command, platform = process.platform) {
  const parts = String(command || '').split(/(&&|\|\||;|&|\r?\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (!isServerCommand(seg)) continue;
    if (/^\s*start\s/i.test(seg)) continue;
    if (parts[i + 1] === '&' && platform !== 'win32') continue;
    return true;
  }
  return false;
}

// A foreground server moves to the background once it says it is up (a URL, "listening",
// "ready") and a second has passed, or once it has printed nothing new for 8 seconds — a build
// that runs first (`npm run build && npm run preview`) keeps printing, so it is not cut short.
const SERVER_SETTLE_MS = 8000;
const SERVER_UP_MS = 1000;
const SERVER_UP = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?|\blistening\b|Serving HTTP|\bready in\b|Running on|started server|Local:\s/i;
// How long after the command itself exits to wait for the last of its output.
const EXIT_GRACE_MS = 1500;

function describe(command) {
  const c = String(command || '').replace(/\s+/g, ' ').trim();
  return c.length > 120 ? `${c.slice(0, 117)}…` : c;
}

// The line added to a command's output when a program is left running.
function backgroundNote({ pids = [], foreground = false, platform = process.platform } = {}) {
  const ids = pids.length ? ` (process ${pids.join(', ')})` : '';
  const how = foreground ? 'This command is a server, so once it was up QWS moved it to the background' : 'The command finished, but a program it started is still running in the background';
  const stop = platform === 'win32' ? (pids.length ? `taskkill /PID ${pids[0]} /T /F` : 'taskkill') : (pids.length ? `kill ${pids[0]}` : 'kill');
  return `\n[${how}${ids}. It keeps running until the user stops it (Terminal → Stop) or the project folder changes — do not start it again. Stop it yourself with: ${stop}. To check a web page you do not need a server: test_app opens an .html file directly.]\n`;
}

// Windows: the process ids in `Get-CimInstance Win32_Process` output, one per line.
const parsePids = (text) => [...new Set(String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number))];

module.exports = { gitPathParts, rewriteWindowsWait, isServerCommand, foregroundServer, SERVER_SETTLE_MS, SERVER_UP_MS, SERVER_UP, EXIT_GRACE_MS, describe, backgroundNote, parsePids };
