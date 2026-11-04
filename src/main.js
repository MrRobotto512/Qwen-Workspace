const { app, BrowserWindow, ipcMain, dialog, shell, Menu, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn, execFileSync } = require('child_process');
const { fileURLToPath } = require('node:url');
const net = require('node:net');
const updater = require('./updater');
const { detectSpecs } = require('./hardware');
// Model requests never time out on their own. Node's fetch gives up after 5 minutes without a
// byte (undici's headers/body timeouts), and a local model spilling onto the CPU can read a long
// prompt that long before streaming anything — a field report lost two steps to
// UND_ERR_BODY_TIMEOUT and moved a healthy node's task elsewhere. Stop still aborts, via signal.
const { Agent: UndiciAgent } = require('undici');
const modelDispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });
const web = require('./web');
const mcp = require('./mcp');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vs', '.vscode', 'target', 'bin', 'obj',
  '.cache', 'coverage', '.gradle', '.dart_tool', 'Pods'
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_CMD_OUTPUT = 60_000;

const DEFAULT_SETTINGS = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: '', // chosen on first run from the hardware recommendation, else the user's pick
  temperature: 0.2,
  agentMode: true,
  // 'ask': approve every edit and command; 'edits': edits apply automatically, commands ask
  // (unless allow-listed); 'auto': nothing asks except destructive commands.
  approvalMode: 'edits',
  allowedCommands: [],
  includeCurrentFile: true,
  followAgent: true,
  contextLength: 32768,
  recentWorkspaces: [],
  modelPicked: false, // true once a model has been chosen (auto or by the user)
  autoCheckUpdates: true,
  maxSteps: 60, // how many tool rounds the agent may take before stopping
  maxResponseTokens: 4096, // cap on reply length for cloud providers (max_tokens); 0 = no cap
  keepAlive: '-1', // how long Ollama keeps the model loaded: -1 = forever, '5m', '0' = unload now
  ollamaNodes: [], // extra Ollama servers [{ id, name, baseUrl, enabled, keepAlive }]; "This PC" (baseUrl above) is implicit
  escalation: { failStreak: false, failStreakN: 2, bigPlan: false, bigPlanN: 5 }, // planner-handoff triggers, all off by default
  branchPerTask: false, // agent tasks that edit files start a qwen/<task> branch
  remoteAccess: { enabled: false, port: 8931, token: '' }, // let paired devices view and drive this app's conversations
  devices: [], // paired peers: [{ id, name, url, token }]
  lessonsEnabled: true,
  subagents: true, // with 2+ Ollama nodes, the agent may run independent subtasks in parallel on them
  checksGate: true, // run the project's approved .qwen/checks.json before and after agent tasks
  checksApproved: {}, // project root -> the exact checks.json text the user allowed to run
  skillWriter: true, // after a long task that worked, propose a reusable skill (approval card)
  reviewPass: false, // planner reviews each task's diff and hands fixes back (2 rounds max) // after a task that ran commands, propose lessons for QWEN.md (always behind the diff card)
  architect: true, // after a plan for new files, the planner writes the first version; the local model tests and fixes it
  promptCache: true, // Anthropic prompt caching: repeated prompt prefixes billed at about a tenth
  describeScreens: true, // a text-only model's test_app screenshots are described by a vision model
  readBeforeWrite: true, // write_file may not overwrite a file the task has not read in full (or that changed since)
  syntaxCheck: true, // every write is syntax-checked (JSON, JavaScript, a page's inline scripts, Python); new errors are reported
  redactSecrets: true, // API keys, tokens and passwords are hidden from cloud models (not from this PC's own models)
  stopRule: true, // the same command failing the same way: name the cause; after two failed fixes, stop and report
  browserSites: [], // websites where browser tools may act without asking ("Allow on <site>")
  consultFreely: false, // the agent may call consult_planner whenever unsure (more cloud cost; the budget cap applies)
  planWith: 'node', // who writes the plan-first plan: 'node' (⚡, free), 'planner' (cloud), 'auto' (⚡, else planner)
  planFirst: false, // a conversation's first turn runs on the ⚡ node's strongest model, restricted to planning (todo_write)
  prices: {}, // $/1M tokens per model, user-entered: { 'gemini-2.5-pro': { in: 1.25, out: 10 } }
  monthlyCapUSD: 0, // when > 0 and the month's priced spend reaches it, escalations ask first
  spend: { month: '', models: {} }, // running cloud token counts, written by the renderer
  heavy: { enabled: false, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash' },
  automations: [], // recurring agent tasks: { id, name, prompt, workspace, schedule, enabled, lastRun, lastStatus }
  webResearch: true, // lets the agent use web_search and fetch_url
  searchProvider: 'duckduckgo', // duckduckgo | brave | searxng
  searchApiKey: '',
  searxngUrl: '',
  allowPrivateFetch: false,
  mcpServers: [], // [{ name, command, args, env, url, type, cwd, enabled }]
  mcpProjectOff: {}, // project folder -> MCP server ids switched off there (tools hidden in that project)
  modelChecks: {},
  nodeVram: {}, // Ollama base URL -> GPU bytes it held when a model spilled (remote nodes' VRAM) // `${nodeId}|${model}` -> { ok, textOnly, at } from the per-model tool-call check
  lastConversations: {}, // workspace root -> id of the conversation open when the app closed
  lastWorkspace: null,
  fontSize: 14
};

let mainWindow;
let workspaceRoot = null;
const chatControllers = new Map();

// ---------- settings ----------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    // Migrate the old on/off approval checkboxes.
    if (!saved.approvalMode && saved.autoApproveCommands) saved.approvalMode = 'auto';
    delete saved.autoApproveEdits;
    delete saved.autoApproveCommands;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

// ---------- path safety ----------
// Every file operation is confined to the open workspace folder.
function resolveInWorkspace(p) {
  if (!workspaceRoot) throw new Error('No workspace folder is open.');
  const abs = path.resolve(workspaceRoot, p || '.');
  const rel = path.relative(workspaceRoot, abs);
  // rel === '..' or '../x' means outside; a name merely starting with '..' (e.g. "..config") is fine.
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workspace: ${p}`);
  }
  return abs;
}
function toRel(abs) {
  return path.relative(workspaceRoot, abs).split(path.sep).join('/') || '.';
}

async function isProbablyBinary(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, 8000, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

async function walk(dir, out, limit, maxDepth = 12, depth = 0) {
  if (out.length >= limit || depth >= maxDepth) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= limit) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      out.push(toRel(abs) + '/');
      await walk(abs, out, limit, maxDepth, depth + 1);
    } else if (e.isFile()) {
      out.push(toRel(abs));
    }
  }
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121215',
    title: 'Qwen Workspace',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  // The renderer cancels unload when there are unsaved tabs; ask before discarding them.
  mainWindow.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close Qwen Workspace and discard them?'
    });
    if (choice === 0) e.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });
}

app.whenReady().then(() => {
  createWindow();
  mcp.setOnChange(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('mcp:changed', mcp.describe()));
  mcp.connectAll(loadSettings().mcpServers).catch(() => {});
  gitAvailable().then((ok) => ok && ensureGitLongPaths()).catch(() => {});
  syncRemote();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: settings ----------
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch };
  // First enable of remote sessions mints the pairing code; it never changes on its own.
  if (s.remoteAccess?.enabled && !s.remoteAccess.token) {
    s.remoteAccess = { ...s.remoteAccess, token: remoteSessions.makeToken() };
  }
  saveSettings(s);
  syncRemote();
  return s;
});

// ---------- IPC: workspace ----------
ipcMain.handle('workspace:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});
ipcMain.handle('workspace:set', async (_e, dir) => {
  if (!dir) return null;
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  // A server left running for the old folder would hold its port and serve the wrong files.
  if (path.resolve(dir) !== workspaceRoot) stopBackground();
  workspaceRoot = path.resolve(dir);
  const s = loadSettings();
  s.lastWorkspace = workspaceRoot;
  s.recentWorkspaces = [workspaceRoot, ...(s.recentWorkspaces || []).filter((p) => p !== workspaceRoot)].slice(0, 8);
  saveSettings(s);
  mainWindow.setTitle(`${path.basename(workspaceRoot)} — Qwen Workspace`);
  return { root: workspaceRoot, name: path.basename(workspaceRoot), sep: path.sep, platform: process.platform };
});

// ---------- IPC: filesystem ----------
ipcMain.handle('fs:list', async (_e, rel) => {
  const abs = resolveInWorkspace(rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isFile())
    .filter((e) => !(e.isDirectory() && (e.name === '.git' || e.name === 'node_modules')))
    .map((e) => ({ name: e.name, path: toRel(path.join(abs, e.name)), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

ipcMain.handle('fs:listRecursive', async (_e, rel, limit = 500, maxDepth = 12) => {
  const abs = resolveInWorkspace(rel);
  const out = [];
  await walk(abs, out, limit, maxDepth);
  return { files: out, truncated: out.length >= limit };
});

ipcMain.handle('fs:read', async (_e, rel) => {
  const abs = resolveInWorkspace(rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
  if (st.size > MAX_READ_BYTES) throw new Error(`File is too large to open (${Math.round(st.size / 1024)} KB): ${rel}`);
  if (await isProbablyBinary(abs)) throw new Error(`File looks binary: ${rel}`);
  return fsp.readFile(abs, 'utf8');
});

ipcMain.handle('fs:exists', async (_e, rel) => {
  try {
    await fsp.access(resolveInWorkspace(rel));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:write', async (_e, rel, content) => {
  const abs = resolveInWorkspace(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return true;
});

ipcMain.handle('fs:mkdir', async (_e, rel) => {
  await fsp.mkdir(resolveInWorkspace(rel), { recursive: true });
  return true;
});

// `quiet` skips the confirmation; the renderer uses it only when reverting a file Qwen created,
// after the user has already confirmed the revert.
ipcMain.handle('fs:delete', async (_e, rel, opts = {}) => {
  const abs = resolveInWorkspace(rel);
  if (abs === workspaceRoot) throw new Error('Refusing to delete the workspace root.');
  if (!opts.quiet) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${rel}"?`,
      detail: 'This cannot be undone.'
    });
    if (response !== 0) return false;
  }
  await fsp.rm(abs, { recursive: true, force: true });
  return true;
});

ipcMain.handle('fs:search', async (_e, query, opts = {}) => {
  if (!query) return [];
  const files = [];
  await walk(resolveInWorkspace('.'), files, 5000);
  let re;
  try {
    re = opts.regex ? new RegExp(query, 'i') : null;
  } catch (err) {
    throw new Error(`Invalid regex: ${err.message}`);
  }
  const needle = query.toLowerCase();
  const results = [];
  for (const f of files) {
    if (f.endsWith('/')) continue;
    const abs = path.join(workspaceRoot, f);
    try {
      const st = await fsp.stat(abs);
      if (st.size > 1024 * 1024 || (await isProbablyBinary(abs))) continue;
      const lines = (await fsp.readFile(abs, 'utf8')).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
        if (hit) {
          results.push({ path: f, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= (opts.limit || 100)) return results;
        }
      }
    } catch {
      /* unreadable file, skip */
    }
  }
  return results;
});

ipcMain.handle('shell:reveal', (_e, rel) => shell.showItemInFolder(resolveInWorkspace(rel)));

// ---------- IPC: commands ----------
// `python3` on Windows is usually missing or the Store stub: such commands run with the Python
// that works there (src/pyshim.js). Looked up once per project folder for 5 minutes.
const PyShim = require('./pyshim.js');
const pyChoice = new Map(); // root → { python, at }
async function windowsPython(root) {
  const hit = pyChoice.get(root);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.python;
  const venv = ['.venv', 'venv', 'env'].map((v) => path.join(root, v, 'Scripts', 'python.exe')).find((p) => fs.existsSync(p)) || null;
  const where = async (name) => {
    const r = await runQuiet('where', [name], 5000);
    return r.code === 0 ? r.out : '';
  };
  const [wherePython3, wherePy, wherePython] = await Promise.all([where('python3'), where('py'), where('python')]);
  const python = PyShim.choosePython({ venv, wherePython3, wherePy, wherePython });
  pyChoice.set(root, { python, at: Date.now() });
  return python;
}

async function shimPython3(command, cwd) {
  if (process.platform !== 'win32' || !/python3|pip3/i.test(command)) return { command, note: '' };
  const python = await windowsPython(cwd).catch(() => null);
  const r = PyShim.rewritePython3(command, python);
  return r.changed ? { command: r.command, note: `[QWS ran python3 as ${python}: python3 is not a working Python on this PC]\n` } : { command, note: '' };
}

const NON_INTERACTIVE_ENV = { GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', DEBIAN_FRONTEND: 'noninteractive', PIP_NO_INPUT: '1' };

// Programs a command left running (a server started with `start /b` or `&`, or a foreground
// server moved aside once it was up): kept until the user stops them, the project folder
// changes or QWS quits. id → { id, owner, command, pids, pgid, at }.
const CmdRun = require('./cmdrun.js');
const background = new Map();
let backgroundSeq = 0;
function backgroundList() {
  return [...background.values()].map(({ id, owner, command, pids, at }) => ({ id, owner, command: CmdRun.describe(command), pids, at }));
}
function backgroundChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cmd:background', backgroundList());
}
function stopBackground(filter = () => true) {
  let n = 0;
  for (const b of [...background.values()]) {
    if (!filter(b)) continue;
    background.delete(b.id);
    n++;
    if (process.platform === 'win32') {
      for (const pid of b.pids) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    } else {
      try {
        process.kill(-b.pgid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  if (n) backgroundChanged();
  return n;
}
app.on('will-quit', () => stopBackground());

// Windows: the processes a shell started, found by parent process id (still recorded after
// the shell itself has exited).
function windowsChildren(pid) {
  return new Promise((resolve) => {
    let out = '';
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}').ProcessId`], { windowsHide: true });
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', () => resolve([]));
    ps.on('close', () => resolve(CmdRun.parsePids(out)));
    setTimeout(() => killTree(ps), 10_000);
  });
}

function posixGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('cmd:background', () => backgroundList());
ipcMain.handle('cmd:stopBackground', (_e, id) => stopBackground((b) => id == null || b.id === id));

ipcMain.handle('cmd:run', async (_e, rawCommand, timeoutMs = 120_000, owner = null) => {
  const cwd = resolveInWorkspace('.');
  const shimmed = await shimPython3(rawCommand, cwd);
  let { command, note } = shimmed;
  if (process.platform === 'win32') {
    const w = CmdRun.rewriteWindowsWait(command);
    if (w.changed) {
      command = w.command;
      note += '[QWS waited with ping instead of "timeout /t", which quits at once when there is no keyboard]\n';
    }
  }
  const posix = process.platform !== 'win32';
  const server = CmdRun.foregroundServer(command, process.platform);
  return new Promise((resolve) => {
    // Nothing the agent runs can wait for a person: input is closed at once (a "y/n" prompt or
    // `python -` reads end-of-file and stops instead of sitting until the timeout), and git, its
    // credential helper and pagers are told not to prompt or page (from Craft Anything's
    // pitfalls: commands that waited for a terminal cost 10 minutes each). On macOS and Linux
    // the shell leads its own process group, so whatever it starts can be stopped together.
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: posix, env: { ...commandEnv(), ...NON_INTERACTIVE_ENV } });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
    let output = note;
    let done = false;
    let lastOutputAt = Date.now();
    let upAt = 0;
    const append = (d) => {
      const t = d.toString();
      mainWindow?.webContents.send('cmd:output', t);
      if (done) return; // a program left in the background still shows in the terminal
      output += t;
      lastOutputAt = Date.now();
      if (server && !upAt && CmdRun.SERVER_UP.test(output)) upAt = Date.now();
      if (output.length > MAX_CMD_OUTPUT * 2) output = output.slice(-MAX_CMD_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (code, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      clearTimeout(grace);
      output += extra;
      if (output.length > MAX_CMD_OUTPUT) output = '[...output truncated...]\n' + output.slice(-MAX_CMD_OUTPUT);
      resolve({ code, output });
    };
    // Keep what is still running, then answer with the output so far. `pids` are what to stop
    // later (macOS/Linux stop the shell's whole process group).
    let bgId = null;
    let moving = false;
    const keep = (code, pids, foreground) => {
      bgId = ++backgroundSeq;
      background.set(bgId, { id: bgId, owner, command, pids, pgid: child.pid, at: Date.now() });
      backgroundChanged();
      finish(code ?? 0, CmdRun.backgroundNote({ pids, foreground, platform: process.platform }));
    };
    const toBackground = async (code, foreground) => {
      if (done || moving) return;
      moving = true;
      const pids = posix || foreground ? [child.pid] : await windowsChildren(child.pid);
      moving = false;
      if (done) return;
      // On macOS/Linux, the group being gone means the output is about to close by itself.
      if (posix && !foreground && !posixGroupAlive(child.pid)) return finish(code);
      keep(code, pids, foreground);
    };
    const timer = setTimeout(() => {
      append(`\n[timed out after ${timeoutMs / 1000}s — process killed. If it was waiting for input (a question, a sign-in, a pager), run it with its non-interactive flags instead (-y / --yes / --no-pager / --non-interactive).]\n`);
      if (posix) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          killTree(child);
        }
      } else killTree(child);
    }, timeoutMs);
    // A server in the foreground: aside once it is up, or once it has gone quiet.
    const watch = setInterval(() => {
      if (!server || done) return;
      const now = Date.now();
      if ((upAt && now - upAt >= CmdRun.SERVER_UP_MS) || now - lastOutputAt >= CmdRun.SERVER_SETTLE_MS) toBackground(null, true);
    }, 250);
    // The shell is done but its output is still open: something it started holds it.
    let grace = null;
    child.on('exit', (code) => {
      grace = setTimeout(() => toBackground(code, false), CmdRun.EXIT_GRACE_MS);
    });
    child.on('error', (err) => append(`\n[error] ${err.message}\n`));
    child.on('close', async (code) => {
      // A program in the background that ends by itself leaves the list.
      if (bgId && background.delete(bgId)) backgroundChanged();
      if (done || moving) return;
      // An agent's command that started something with its output sent elsewhere
      // (`server >/dev/null &`, `start /b server >nul`): the output closed, the program did not.
      if (owner && posix && posixGroupAlive(child.pid)) return keep(code, [child.pid], false);
      if (owner && !posix && /(^|[\s&|;(])start\s/i.test(command)) {
        moving = true;
        const pids = await windowsChildren(child.pid);
        moving = false;
        if (pids.length && !done) return keep(code, pids, false);
      }
      finish(code);
    });
  });
});

// ---------- syntax check after a write (src/syntaxcheck.js) ----------
const SyntaxCheck = require('./syntaxcheck.js');
const looksLikeJsx = (code) => /<[A-Z][\w.]*[\s/>]|return\s*\(\s*</.test(code) || /<\/[a-z]+>\s*\)?;?\s*$/m.test(code) && /=>\s*\(?\s*</.test(code);

// Compile JavaScript without running it, with Node's own parser (Electron runs as Node).
// `line` is where the code starts in its file, so errors carry the file's line numbers.
function jsErrors(code, line = 1, asModule = false) {
  if (looksLikeJsx(code)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `qws-check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${asModule ? 'mjs' : 'cjs'}`);
    try {
      fs.writeFileSync(tmp, '\n'.repeat(Math.max(0, line - 1)) + code);
    } catch {
      return resolve([]);
    }
    let out = '';
    const child = spawn(process.execPath, ['--check', tmp], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.stderr.on('data', (d) => (out += d));
    child.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => killTree(child), 5000);
    const done = (code2) => {
      clearTimeout(timer);
      fs.rm(tmp, { force: true }, () => {});
      const e = code2 === 0 ? null : SyntaxCheck.parseNodeError(out);
      resolve(e ? [e] : []);
    };
    child.on('error', () => done(0));
    child.on('close', done);
  });
}

async function pythonErrors(file) {
  let py = 'python3';
  if (process.platform === 'win32') py = (await windowsPython(workspaceRoot).catch(() => null)) || 'python';
  const script = "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])";
  const r = await new Promise((resolve) => {
    let out = '';
    const child = spawn(`${py} -c "${script}" "${file}"`, { shell: true, windowsHide: true, env: commandEnv() });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => killTree(child), 5000);
    child.on('error', () => resolve({ code: -1, out }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
  if (r.code === 0) return [];
  const e = SyntaxCheck.parsePythonError(r.out);
  return e && /Error/.test(e.message) && !/No module named|not recognized|not found|ModuleNotFound/i.test(r.out) ? [e] : [];
}

async function syntaxErrorsOf(kind, text, rel) {
  if (kind === 'json') return SyntaxCheck.checkJson(text);
  if (kind === 'js') return jsErrors(text, 1, /\.mjs$/i.test(rel) || SyntaxCheck.isModuleCode(text));
  if (kind === 'html') {
    const errs = [];
    for (const sc of SyntaxCheck.inlineScripts(text).slice(0, 8)) errs.push(...(await jsErrors(sc.code, sc.line, sc.module || SyntaxCheck.isModuleCode(sc.code))));
    return errs;
  }
  return [];
}

// The errors a write introduced in `rel` (compared with `before`, its content before the write).
ipcMain.handle('syntax:check', async (_e, rel, before) => {
  const kind = SyntaxCheck.kindOf(rel);
  if (!kind) return { checked: false, errors: [] };
  const abs = resolveInWorkspace(rel);
  let after;
  try {
    after = await fsp.readFile(abs, 'utf8');
  } catch {
    return { checked: false, errors: [] };
  }
  if (after.length > 2_000_000) return { checked: false, errors: [] };
  let now;
  if (kind === 'python') now = await pythonErrors(abs);
  else now = await syntaxErrorsOf(kind, after, rel);
  if (!now.length) return { checked: true, errors: [] };
  let then = [];
  if (typeof before === 'string' && before.trim()) {
    if (kind === 'python') {
      const tmp = path.join(os.tmpdir(), `qws-check-${process.pid}-${Date.now()}.py`);
      await fsp.writeFile(tmp, before).catch(() => {});
      then = await pythonErrors(tmp);
      fs.rm(tmp, { force: true }, () => {});
    } else then = await syntaxErrorsOf(kind, before, rel);
  }
  return { checked: true, errors: SyntaxCheck.newErrors(then, now), all: now };
});

// ---------- long command output saved for the model (src/renderer/toolbudget.js) ----------
// <project>/.qwen/output/<time>-<label>.txt, with a .gitignore so it is never committed; the
// newest 30 are kept.
ipcMain.handle('output:save', async (_e, label, text) => {
  const dir = resolveInWorkspace('.qwen/output');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '.gitignore'), '*\n').catch(() => {});
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(label || 'output').replace(/[^\w.-]+/g, '-').slice(0, 40)}.txt`;
  await fsp.writeFile(path.join(dir, name), String(text ?? ''));
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.txt')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
  return `.qwen/output/${name}`;
});

// ---------- test built GUI apps ----------
// Launches the app the agent built, finds its window by diffing the desktop's window list,
// screenshots that window only, runs the requested clicks/typing through the platform's own
// automation, screenshots again, and closes the app. The renderer approves the launch first.
const GuiTest = require('./renderer/guitest.js');
const Progress = require('./renderer/progress.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runQuiet(cmd, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: e.message });
    }
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: e.code === 'ENOENT' ? `ENOENT ${cmd}` : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function guiActions(source, actions, shot) {
  const wid = GuiTest.windowIdFromSource(source.id);
  if (!wid) return 'This window cannot be automated (no native window id).';
  if (process.platform === 'linux') {
    const geo = await runQuiet('xdotool', ['getwindowgeometry', String(wid)]);
    if (/ENOENT/.test(geo.out)) return 'Clicking and typing on Linux needs xdotool (sudo apt install xdotool).';
    const m = /Geometry:\s*(\d+)x(\d+)/.exec(geo.out);
    const win = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
    for (const step of GuiTest.xdotoolSteps(actions, wid, shot, win)) {
      if (step.sleep) {
        await sleep(step.sleep * 1000);
        continue;
      }
      const r = await runQuiet('xdotool', step);
      if (r.code !== 0) return `xdotool ${step[0]} failed: ${r.out.trim().slice(0, 200)}`;
      await sleep(120);
    }
    return null;
  }
  if (process.platform === 'win32') {
    const r = await runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', GuiTest.windowsScript(wid, actions, shot)], 60_000);
    return r.code === 0 ? null : `PowerShell automation failed: ${r.out.trim().slice(0, 300)}`;
  }
  if (process.platform === 'darwin') {
    const r = await runQuiet('osascript', ['-l', 'JavaScript', '-e', GuiTest.macScript(wid, actions, shot)], 60_000);
    if (r.code === 0) return null;
    return /not allowed|assistive|1002|-25211/i.test(r.out)
      ? 'macOS blocked the clicks: allow Qwen Workspace under System Settings → Privacy & Security → Accessibility, then try again.'
      : `osascript automation failed: ${r.out.trim().slice(0, 300)}`;
  }
  return `Clicking and typing is not supported on ${process.platform}.`;
}

// Web pages and browser games: loaded in a hidden, sandboxed QWS window (no Node, throwaway
// storage) instead of an OS browser — `start index.html` returns at once, leaving nothing to
// watch. Console errors are the main signal (an undefined function, a typo'd variable, a missing
// file); clicks and keys go straight to the page as input events, so no OS automation is needed.
const PAGE_W = 1024;
const PAGE_H = 768;
ipcMain.handle('gui:testPage', async (_e, opts) => {
  const parsed = GuiTest.parseActions(opts?.actions);
  if (parsed.error) return { error: parsed.error };
  // This window loads a page and can click and type in it with nobody asked, so the page must
  // come from this PC: a project file, or a dev server on localhost. A LAN device's admin page
  // or a public site belongs to the browser tools, which ask per website. The likeness check's
  // reference page (pictured only, never acted on) may be public, but not on the local network
  // unless the user allows private fetches — the same rule fetch_url follows.
  const reference = !!opts?.reference;
  const navAllowed = (url) => {
    const u = String(url || '');
    if (GuiTest.isLocalUrl(u)) return true;
    if (!reference) {
      // A project file may move to another project file (or a blank page), never elsewhere on
      // disk — a screenshot of some other local file would reach the model.
      if (opts?.url || !/^(about:blank$|file:)/i.test(u)) return false;
      if (/^about:blank$/i.test(u)) return true;
      try {
        resolveInWorkspace(fileURLToPath(u));
        return true;
      } catch {
        return false;
      }
    }
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      return false;
    }
    return /^https?:/i.test(u) && (!!loadSettings().allowPrivateFetch || !web.isPrivateHost(host));
  };
  let target;
  try {
    if (opts?.url) {
      const url = String(opts.url);
      if (!/^https?:\/\//i.test(url)) return { error: `${url} is not an http(s) URL` };
      if (!navAllowed(url)) {
        return { error: reference
          ? `${url} is on this PC's local network, and fetching private addresses is turned off (Settings → Research)`
          : `test_app only loads pages from this PC (a project file or a localhost URL); ${url} is somewhere else — use the browser tools for other websites` };
      }
      if (reference && parsed.actions.length) return { error: 'a reference page is only pictured; it takes no actions' };
      target = { url };
    } else {
      const abs = resolveInWorkspace(String(opts?.file || ''));
      if (!fs.existsSync(abs)) return { error: `${opts.file} does not exist in the project` };
      target = { file: abs };
    }
  } catch (e) {
    return { error: e.message };
  }
  // A width asked for (the likeness check pictures pages at 1440, 768 and 390 px) keeps a
  // screen-like height; otherwise the default 1024×768.
  const pageW = Math.round(Number(opts?.width)) >= 240 ? Math.min(3840, Math.round(Number(opts.width))) : PAGE_W;
  const pageH = pageW === PAGE_W ? PAGE_H : Math.max(640, Math.min(1000, Math.round(pageW * 0.625)));
  const win = new BrowserWindow({
    show: false,
    width: pageW,
    height: pageH,
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `qws-pagetest-${Date.now()}`, backgroundThrottling: false }
  });
  const errors = new Map(); // message -> count
  const logs = [];
  let crashed = null;
  let loadError = null;
  const wc = win.webContents;
  const levelName = (l) => (typeof l === 'number' ? ['debug', 'info', 'warning', 'error'][l] || 'info' : String(l || 'info'));
  wc.on('console-message', (ev, lvl, msg, line, source) => {
    const d = ev && typeof ev.message === 'string' ? ev : { level: lvl, message: msg, lineNumber: line, sourceId: source };
    const where = d.sourceId ? ` (${path.basename(String(d.sourceId))}${d.lineNumber ? `:${d.lineNumber}` : ''})` : '';
    const text = `${String(d.message).slice(0, 300)}${where}`;
    if (levelName(d.level) === 'error') errors.set(text, (errors.get(text) || 0) + 1);
    else if (logs.length < 200) logs.push(text);
  });
  wc.on('render-process-gone', (_ev, details) => { crashed = details?.reason || 'renderer gone'; });
  wc.on('did-fail-load', (_ev, code, desc, url, isMain) => { if (isMain) loadError = `${desc} (${code}) for ${url}`; });
  // Top-level navigation stays within the rules above: a local page may not send the window to
  // another host (a redirect to a LAN address, say), and no page opens further windows. A
  // blocked hop is listed with the page's errors, so the model learns why the page went nowhere.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNav = (ev, url) => {
    if (navAllowed(url)) return;
    ev.preventDefault();
    const text = `Blocked navigation to ${String(url).slice(0, 200)}: test_app only loads pages from this PC`;
    errors.set(text, (errors.get(text) || 0) + 1);
  };
  wc.on('will-navigate', guardNav);
  wc.on('will-redirect', guardNav);
  const capture = async () => {
    try {
      const img = await wc.capturePage();
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      return { png: img.toPNG().toString('base64'), width, height };
    } catch {
      return null;
    }
  };
  const t0 = Date.now();
  let loaded = false;
  try {
    await (target.url ? win.loadURL(target.url) : win.loadFile(target.file));
    loaded = !loadError;
  } catch (e) {
    loadError = loadError || e.message;
  }
  const loadMs = Date.now() - t0;
  const out = { loaded, loadMs, loadError, title: '', actions: parsed.actions, actionError: null, shot: null };
  try {
    if (loaded) {
      await sleep(Math.min(10, Math.max(0.5, Number(opts?.waitSeconds) || 1.5)) * 1000); // let scripts start
      out.title = wc.getTitle();
      out.shot = await capture();
      if (parsed.actions.length && !crashed) {
        wc.focus();
        const size = { width: pageW, height: pageH };
        for (const a of parsed.actions) {
          if (a.click) {
            const [x, y] = GuiTest.scalePoint(a.click, out.shot, size);
            wc.sendInputEvent({ type: 'mouseMove', x, y });
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
            await sleep(150);
          } else if (a.type) {
            for (const ch of a.type) {
              wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
              wc.sendInputEvent({ type: 'char', keyCode: ch });
              wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
              await sleep(20);
            }
          } else if (a.key) {
            const keyCode = GuiTest.electronKey(a.key);
            wc.sendInputEvent({ type: 'keyDown', keyCode });
            if (keyCode.length === 1 || keyCode === 'Space') wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : keyCode });
            await sleep(80);
            wc.sendInputEvent({ type: 'keyUp', keyCode });
            await sleep(120);
          } else if (a.wait) {
            await sleep(a.wait * 1000);
          }
        }
        await sleep(600);
        out.shot = (await capture()) || out.shot;
      }
      // A game's own self-test (window.selfTest, see renderer/selftest.js): run after the page
      // and any actions, with a time limit, so its report — measured from the game's state —
      // reaches the agent. Whether the page draws on a <canvas> tells a game without one.
      // A benchmark check: a JS expression from the app's own task list (never from the model),
      // run in the page; true passes, anything else says what was wrong.
      if (!crashed && opts?.probe) {
        out.probe = await wc.executeJavaScript(`(async () => { try { const r = await (${String(opts.probe)}); return r === true ? true : String(r); } catch (e) { return 'error: ' + e.message; } })()`, true).catch((e) => `error: ${e.message}`);
      }
      if (!crashed && opts?.selfTest !== false) {
        const probe = await wc.executeJavaScript('({ selfTest: typeof window.selfTest === "function", canvas: !!document.querySelector("canvas") })', true).catch(() => ({}));
        out.hasCanvas = !!probe.canvas;
        out.hasSelfTest = !!probe.selfTest;
        if (probe.selfTest) {
          const limit = Math.min(60, Math.max(5, Number(opts?.selfTestSeconds) || 20)) * 1000;
          out.selfTest = await wc.executeJavaScript(`Promise.race([Promise.resolve().then(() => window.selfTest()).then((r) => JSON.stringify(r === undefined ? null : r)), new Promise((_, no) => setTimeout(() => no(new Error('window.selfTest() did not finish within ${limit / 1000}s')), ${limit}))])`, true)
            .catch((e) => JSON.stringify({ error: String(e?.message || e).slice(0, 300) }));
          out.shot = (await capture()) || out.shot;
        }
      }
    }
  } catch (e) {
    out.actionError = e.message;
  } finally {
    out.crashed = crashed;
    out.errors = [...errors].map(([m, n]) => (n > 1 ? `${m} ×${n}` : m));
    out.logs = logs.slice(-20);
    if (!win.isDestroyed()) win.destroy();
  }
  return out;
});

// A picture in the project (a reference the user added, for test_app's likeness check), as
// base64. Only common image types, inside the project, at most 15 MB.
ipcMain.handle('fs:readImage', async (_e, rel) => {
  const abs = resolveInWorkspace(String(rel || ''));
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }[path.extname(abs).toLowerCase()];
  if (!mime) return { error: 'not a picture (png, jpg, webp, gif or bmp)' };
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) return { error: `${rel} does not exist in the project` };
  if (st.size > 15 * 1024 * 1024) return { error: `${rel} is over 15 MB` };
  return { mime, data: fs.readFileSync(abs).toString('base64') };
});

// A desktop game's own self-test: `<command> --self-test <file.json>` (a Godot project gets it
// after `--`), waited for up to `seconds`, then the report file is read back. The renderer asks
// for approval first, exactly as for launching the app.
ipcMain.handle('gui:selfTest', async (_e, opts) => {
  const rawCommand = String(opts?.command || '').trim();
  if (!rawCommand) return { error: 'empty command' };
  const cwd = resolveInWorkspace('.');
  const { command } = await shimPython3(rawCommand, cwd);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qws-selftest-'));
  const file = path.join(dir, 'self-test.json');
  const flag = `--self-test "${file}"`;
  const full = /\bgodot/i.test(command) && !/\s--\s/.test(command) ? `${command} -- ${flag}` : `${command} ${flag}`;
  const seconds = Math.min(180, Math.max(5, Number(opts?.seconds) || 60));
  const run = await new Promise((resolve) => {
    let output = '';
    const child = spawn(full, { cwd, shell: true, windowsHide: true, env: { ...commandEnv(), ...NON_INTERACTIVE_ENV } });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
    const add = (d) => {
      output = (output + d.toString()).slice(-4000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, seconds * 1000);
    child.on('error', (err) => add(`\n[error] ${err.message}\n`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
  let report = null;
  try {
    report = fs.readFileSync(file, 'utf8');
  } catch {
    report = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...run, report, command: full };
});

ipcMain.handle('gui:test', async (_e, opts) => {
  const rawCommand = String(opts?.command || '').trim();
  if (!rawCommand) return { error: 'empty command' };
  const { command } = await shimPython3(rawCommand, resolveInWorkspace('.'));
  const parsed = GuiTest.parseActions(opts.actions);
  if (parsed.error) return { error: parsed.error };
  const waitSeconds = Math.min(60, Math.max(1, Number(opts.waitSeconds) || 8));
  const list = (size) => desktopCapturer.getSources({ types: ['window'], thumbnailSize: size || { width: 0, height: 0 }, fetchWindowIcons: false });
  let before;
  try {
    before = new Set((await list()).map((s) => s.id));
  } catch (e) {
    return { error: `Could not list windows: ${e.message}${process.platform === 'darwin' ? ' (QWS needs Screen Recording permission: System Settings → Privacy & Security)' : ''}` };
  }
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  // Its own process group off Windows, so closing it takes the app down, not just the shell.
  const posix = process.platform !== 'win32';
  const child = spawn(command, { cwd: resolveInWorkspace('.'), shell: true, windowsHide: false, detached: posix, env: commandEnv() });
  const stop = () => {
    if (!posix) return killTree(child);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  };
  let output = '';
  let exitCode = null;
  const append = (d) => {
    output += d.toString();
    if (output.length > 40_000) output = output.slice(-20_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', (err) => append(`\n[error] ${err.message}\n`));
  child.on('close', (code) => (exitCode = code ?? -1));

  const t0 = Date.now();
  let source = null;
  while (Date.now() - t0 < waitSeconds * 1000 && exitCode === null) {
    await sleep(400);
    source = GuiTest.pickWindow(await list().catch(() => []), before, own, opts.windowTitle);
    if (source) break;
  }
  const windowAfterMs = source ? Date.now() - t0 : null;
  // Chromium scales a small window's thumbnail up to fill the box; where the real size is
  // known (xdotool on Linux), shrink it back so a 320×240 window costs a 320×240 image.
  let natural;
  const naturalSize = async () => {
    if (natural !== undefined) return natural;
    natural = null;
    if (process.platform === 'linux') {
      const m = /Geometry:\s*(\d+)x(\d+)/.exec((await runQuiet('xdotool', ['getwindowgeometry', String(GuiTest.windowIdFromSource(source.id))])).out);
      if (m) natural = { width: Number(m[1]), height: Number(m[2]) };
    }
    return natural;
  };
  const capture = async () => {
    const s = (await list({ width: GuiTest.SHOT_BOX, height: GuiTest.SHOT_BOX }).catch(() => [])).find((x) => x.id === source.id);
    if (!s || s.thumbnail.isEmpty()) return null;
    let img = s.thumbnail;
    const nat = await naturalSize();
    if (nat && nat.width < img.getSize().width) img = img.resize({ width: nat.width, height: nat.height, quality: 'best' });
    const { width, height } = img.getSize();
    return { png: img.toPNG().toString('base64'), width, height };
  };
  let shot = null;
  let actionError = null;
  if (source) {
    await sleep(1200); // let the first frame paint
    shot = await capture();
    if (parsed.actions.length && exitCode === null) {
      actionError = await guiActions(source, parsed.actions, shot);
      await sleep(800);
      shot = (await capture()) || shot;
    }
  }
  const alive = exitCode === null;
  if (alive) stop();
  return {
    command,
    waitSeconds,
    windowFound: !!source,
    windowTitle: source?.name || opts.windowTitle || '',
    windowAfterMs,
    alive,
    exitCode,
    actions: parsed.actions,
    actionError,
    shot,
    output: output.length > MAX_CMD_OUTPUT ? output.slice(-MAX_CMD_OUTPUT) : output
  };
});

function killTree(child) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

// ---------- IPC: model ----------
function apiHeaders(s) {
  const h = { 'Content-Type': 'application/json' };
  if (s.provider === 'anthropic') {
    // Anthropic's native API authenticates with x-api-key plus a version header.
    if (s.apiKey) h['x-api-key'] = s.apiKey;
    h['anthropic-version'] = '2023-06-01';
    return h;
  }
  if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
  // OpenRouter credits the app by these headers (and lists free-model use under it).
  if (s.provider === 'openrouter' || /openrouter\.ai/i.test(String(s.baseUrl || ''))) Object.assign(h, require('./renderer/freecloud.js').ATTRIBUTION);
  return h;
}
function apiUrl(s, suffix) {
  return s.baseUrl.trim().replace(/\/+$/, '') + suffix;
}

ipcMain.handle('model:list', async (_e, override) => {
  // `override` lets the UI list models for a connection other than the saved one (e.g. the
  // planner's), and the agent loop list live siblings during model failover.
  const s = { ...loadSettings(), ...(override || {}) };
  const res = await fetch(apiUrl(s, '/models'), { headers: apiHeaders(s), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
});

// The provider's full model list (OpenRouter's pricing and capabilities, Groq's context sizes),
// parsed by renderer/freecloud.js. Only for providers whose list carries that detail.
ipcMain.handle('model:catalog', async (_e, override) => {
  const s = { ...loadSettings(), ...(override || {}) };
  if (!['openrouter', 'groq'].includes(s.provider)) return null;
  const res = await fetch(apiUrl(s, '/models'), { headers: apiHeaders(s), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return require('./renderer/freecloud.js').parseCatalog(s.provider, json);
});

ipcMain.handle('chat:abort', (_e, id) => {
  chatControllers.get(id)?.abort();
  return true;
});

// Streams one completion. Deltas are pushed to the renderer as they arrive;
// the resolved value is the full assistant turn (text + any tool calls).
// A cloud model that sends nothing for this long counts as busy (an HTTP 503), so the renderer's
// model ladder moves on instead of hanging — model requests have no network timeout of their own
// (slow local models need that). Local and private-network servers never get this cutoff.
const CLOUD_FIRST_TOKEN_MS = 120_000;
const firstTokenMs = (s) => (Number(s.cloudFirstTokenSec) > 0 ? Number(s.cloudFirstTokenSec) * 1000 : CLOUD_FIRST_TOKEN_MS);
function isCloudEndpoint(s) {
  if (['ollama', 'lmstudio'].includes(s.provider)) return false;
  if (['gemini', 'anthropic', 'openrouter', 'dashscope', 'groq'].includes(s.provider)) return true;
  let host = '';
  try {
    host = new URL(String(s.baseUrl || '')).hostname;
  } catch {
    return false;
  }
  return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$)|\.local$/i.test(host);
}

// Secrets hidden from cloud models (src/redact.js). One vault for the app's life, so the same
// secret keeps the same placeholder number from request to request.
const Redact = require('./redact.js');
const secretVault = Redact.createVault();

ipcMain.handle('secrets:restore', (_e, text) => Redact.restoreText(text, secretVault));

ipcMain.handle('chat:stream', async (event, id, payload) => {
  // payload.override (optional) runs this one request on a different provider/model (the heavy
  // model) without changing the saved settings.
  const saved = loadSettings();
  const s = { ...saved, ...(payload.override || {}) };
  let redacted = 0;
  if (saved.redactSecrets !== false && isCloudEndpoint(s) && Array.isArray(payload.messages)) {
    const r = Redact.redactMessages(payload.messages, secretVault, Redact.knownSecrets(saved));
    payload = { ...payload, messages: r.messages };
    redacted = r.count;
  }
  const controller = new AbortController();
  chatControllers.set(id, controller);
  let gotFirst = false;
  let firstTimedOut = false;
  const send = (type, data) => {
    gotFirst = true;
    if (!event.sender.isDestroyed()) event.sender.send('chat:event', { id, type, data });
  };
  const ttft = isCloudEndpoint(s)
    ? setTimeout(() => {
      if (!gotFirst) {
        firstTimedOut = true;
        controller.abort();
      }
    }, firstTokenMs(s))
    : null;
  const fail = (err) => (firstTimedOut
    ? { ok: false, error: `HTTP 503 from ${s.baseUrl}: no answer within ${Math.round(firstTokenMs(s) / 1000)}s — treated as busy` }
    : chatError(err, s));
  try {
    const res = await chatStreamInner(s, payload, controller, send, fail);
    return redacted && res && typeof res === 'object' ? { ...res, redacted } : res;
  } finally {
    clearTimeout(ttft);
    chatControllers.delete(id);
  }
});

// An API error body, shortened for the message — but a quota's ids (Gemini puts
// "GenerateRequestsPerDayPerProjectPerModel-FreeTier" deep in `details`) survive the cut, since
// they tell a daily free-tier limit from a per-minute one.
function errorBody(text) {
  const t = String(text || '');
  if (t.length <= 600) return t;
  const ids = [...new Set([...t.matchAll(/"quotaId"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))];
  return `${t.slice(0, 600)}${ids.length ? ` … [quota: ${ids.join(', ')}]` : ''}`;
}

async function chatStreamInner(s, payload, controller, send, fail) {

  if (s.provider === 'anthropic') {
    try {
      return await streamAnthropic(s, payload, controller.signal, send);
    } catch (err) {
      return fail(err);
    }
  }

  if (await isOllama(s)) {
    try {
      return await streamOllama(s, payload, controller.signal, send);
    } catch (err) {
      return fail(err);
    }
  }

  const body = {
    model: s.model,
    messages: toOpenAIMessages(payload.messages),
    stream: true,
    temperature: Number(s.temperature)
  };
  // Cap the reply length so providers that bill per reserved token (e.g. OpenRouter) don't
  // reserve the model's whole output capacity and reject the request on a small balance.
  const cap = Number(s.maxResponseTokens);
  if (cap > 0) body.max_tokens = cap;
  if (payload.tools?.length) body.tools = payload.tools;
  // Ask for token usage in the stream where the provider reliably supports it (OpenAI spec);
  // other providers (e.g. Gemini's compatibility layer) send usage on their own and we take
  // it whenever a chunk carries it.
  if (['openrouter', 'dashscope'].includes(s.provider)) body.stream_options = { include_usage: true };
  // LM Studio: unload after the node's idle time, speculative decoding with a draft model,
  // and usage in the stream so progress/debug reports get real token counts.
  if (s.provider === 'lmstudio') {
    if (Number(s.ttl) > 0) body.ttl = Number(s.ttl);
    if (s.draftModel) body.draft_model = s.draftModel;
    body.stream_options = { include_usage: true };
  }

  try {
    const res = await fetch(apiUrl(s, '/chat/completions'), {
      method: 'POST',
      headers: apiHeaders(s),
      body: JSON.stringify(body),
      signal: controller.signal,
      dispatcher: modelDispatcher
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} from ${s.baseUrl}: ${errorBody(text)}`);
    }

    let content = '';
    let reasoning = '';
    const toolCalls = [];
    let finishReason = null;
    let usage = null;
    const decoder = new TextDecoder();
    let buffer = '';

    let streamError = null;
    const handleChunk = (json) => {
      // OpenRouter reports an upstream failure after a 200 as an event of its own.
      if (json.error && !json.choices) {
        streamError = json.error;
        return;
      }
      // Groq puts the final usage under x_groq.
      if (json.x_groq?.usage && !json.usage) json.usage = json.x_groq.usage;
      if (json.usage && (json.usage.prompt_tokens || json.usage.completion_tokens)) {
        usage = { ...(usage || {}), promptTokens: json.usage.prompt_tokens || 0, completionTokens: json.usage.completion_tokens || 0 };
      }
      // LM Studio's stats: generation speed, and how many draft tokens speculative decoding kept.
      if (json.stats && typeof json.stats === 'object') {
        const st = json.stats;
        usage = { ...(usage || {}) };
        if (Number(st.tokens_per_second) > 0) usage.genTokPerSec = Math.round(Number(st.tokens_per_second) * 10) / 10;
        if (st.draft_model) usage.draftModel = st.draft_model;
        if (Number(st.total_draft_tokens_count) > 0) usage.draftAccepted = Math.round((Number(st.accepted_draft_tokens_count) / Number(st.total_draft_tokens_count)) * 100);
        if (Number(st.time_to_first_token) > 0) usage.promptMs = Math.round(Number(st.time_to_first_token) * 1000);
      }
      const choice = json.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || choice.message || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) {
        reasoning += r;
        send('reasoning', r);
      }
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        send('delta', d.content);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          let i = tc.index;
          if (i === undefined) {
            const found = tc.id ? toolCalls.findIndex((t) => t.id === tc.id) : -1;
            i = found >= 0 ? found : tc.id || toolCalls.length === 0 ? toolCalls.length : toolCalls.length - 1;
          }
          const slot = (toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name && !slot.function.name) slot.function.name = tc.function.name;
          const args = tc.function?.arguments;
          if (args !== undefined && args !== null) {
            slot.function.arguments += typeof args === 'string' ? args : JSON.stringify(args);
          }
          send('tool_progress', toolCalls.filter(Boolean).map((t) => t.function.name));
        }
      }
    };

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          handleChunk(JSON.parse(data));
        } catch {
          /* ignore malformed keep-alive lines */
        }
      }
    }

    // An error event with nothing else in the reply fails the request like an HTTP error would,
    // so busy/quota handling sees it (instead of an empty answer).
    if (streamError && !content && !toolCalls.length) {
      const code = Number(streamError.code) || 502;
      throw new Error(`HTTP ${code} from ${s.baseUrl}: ${errorBody(JSON.stringify({ error: streamError }))}`);
    }
    const calls = toolCalls.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` }));
    return { ok: true, content, reasoning, toolCalls: calls, finishReason, usage: usage || undefined };
  } catch (err) {
    return fail(err);
  }
}

// EACCES/EPERM on an outbound connection is the OS forbidding it, not a dead server: on
// macOS 15+ that is the Local Network privacy permission (silently denied for apps missing
// the usage description — fixed in our bundle, but the user may still need to allow it), on
// Windows a firewall or endpoint policy.
function permissionHint(code) {
  if (!/^(EACCES|EPERM)$/.test(String(code || ''))) return code;
  if (process.platform === 'darwin') return `${code} — macOS blocked local-network access. Allow Qwen Workspace under System Settings → Privacy & Security → Local Network (relaunch the app if it is not listed).`;
  if (process.platform === 'win32') return `${code} — Windows blocked the connection. Check the firewall (Windows Security → Allow an app) or your security software.`;
  return code;
}

function chatError(err, s) {
  if (err.name === 'AbortError') return { ok: true, aborted: true };
  let msg = err.message;
  const code = err.cause?.code;
  if (code && /^(EACCES|EPERM)$/.test(code)) {
    msg = permissionHint(code);
  } else if (code && /^(ECONN|ETIMEDOUT|EHOST|ENET|EAI_|ENOTFOUND|UND_ERR)/.test(code)) {
    msg = `Could not connect to ${s.baseUrl}. Is Ollama / LM Studio running? (${code})`;
  }
  return { ok: false, error: msg };
}

// ---------- Ollama native API ----------
// Ollama's OpenAI-compatible endpoint ignores the context size and silently drops the
// oldest messages (including the system prompt) once a chat outgrows its small default.
// The native /api/chat endpoint lets us set num_ctx, so we use it whenever we talk to Ollama.
const ollamaCache = new Map();

function ollamaRoot(s) {
  return s.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Only Ollama answers GET /api/version with {"version": ...}; check once per server URL.
async function isOllama(s) {
  const root = ollamaRoot(s);
  if (!ollamaCache.has(root)) {
    try {
      const r = await fetch(`${root}/api/version`, { signal: AbortSignal.timeout(3000) });
      // Only cache an answer the server actually gave; an unreachable server may be an
      // Ollama that just isn't running yet, so check again next time.
      ollamaCache.set(root, r.ok && typeof (await r.json()).version === 'string');
    } catch {
      return false; /* not reachable right now — don't cache */
    }
  }
  return ollamaCache.get(root);
}

// Ollama accepts a number of seconds or a duration string ("-1", "5m", "30"). Pass numbers
// through, and "-1" as the number -1 (stay loaded) so a stray string isn't misread.
function parseKeepAlive(v) {
  const str = String(v ?? '-1').trim();
  if (/^-?\d+$/.test(str)) return Number(str);
  return str || -1;
}

// Pasted screenshots ride on a user message as images: [{ mime, data(base64) }]. Each wire
// format wants them differently; these adapters are the only place that knows.
function toOpenAIMessages(messages) {
  return (messages || []).map((m) => {
    if (!m.images?.length) {
      if (!('images' in m)) return m;
      const { images, ...rest } = m;
      return rest;
    }
    const { images, ...rest } = m;
    return {
      ...rest,
      content: [
        { type: 'text', text: String(m.content ?? '') },
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } }))
      ]
    };
  });
}

function toOllamaMessages(messages) {
  const toolNames = new Map();
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? '' };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => {
        toolNames.set(tc.id, tc.function.name);
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* keep empty */
        }
        // Ollama requires an object here; a replayed array/scalar would 400 every request.
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
        return { function: { name: tc.function.name, arguments: args } };
      });
    }
    if (m.role === 'tool' && toolNames.has(m.tool_call_id)) out.tool_name = toolNames.get(m.tool_call_id);
    if (m.images?.length) out.images = m.images.map((img) => img.data);
    return out;
  });
}

async function streamOllama(s, payload, signal, send) {
  const root = ollamaRoot(s);
  const contextLength = Number(s.contextLength) || DEFAULT_SETTINGS.contextLength;
  const body = {
    model: s.model,
    messages: toOllamaMessages(payload.messages),
    stream: true,
    // Keep the model resident so the next message doesn't wait for a multi-GB reload.
    keep_alive: parseKeepAlive(s.keepAlive),
    options: { temperature: Number(s.temperature), num_ctx: contextLength }
  };
  if (payload.tools?.length) body.tools = payload.tools;

  const res = await fetch(`${root}/api/chat`, {
    method: 'POST',
    headers: apiHeaders(s),
    body: JSON.stringify(body),
    signal,
    dispatcher: modelDispatcher
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${root}: ${text.slice(0, 600)}`);
  }

  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let finishReason = null;
  let promptTokens = 0;
  let stats = {};
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (j) => {
    if (j.error) throw new Error(j.error);
    const m = j.message || {};
    if (m.thinking) {
      reasoning += m.thinking;
      send('reasoning', m.thinking);
    }
    if (m.content) {
      content += m.content;
      send('delta', m.content);
    }
    for (const tc of m.tool_calls || []) {
      const args = tc.function?.arguments;
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.function?.name || '', arguments: typeof args === 'string' ? args : JSON.stringify(args || {}) }
      });
      send('tool_progress', toolCalls.map((t) => t.function.name));
    }
    if (j.done) {
      finishReason = j.done_reason || 'stop';
      promptTokens = j.prompt_eval_count || 0;
      stats = Progress.ollamaStats(j);
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  }
  if (buffer.trim()) handle(JSON.parse(buffer));

  return { ok: true, content, reasoning, toolCalls, finishReason, usage: { ...stats, promptTokens, contextLength } };
}

// ---------- Anthropic native API ----------
// Anthropic's Messages API speaks its own shape (tool_use/tool_result content blocks, SSE
// event types), so this adapter translates both ways and returns the same result shape as
// streamOllama / the OpenAI path: { content, reasoning, toolCalls, finishReason, usage }.
// Current Claude models reject non-default temperature and manage thinking themselves, so
// neither is sent.

function toAnthropicRequest(s, payload) {
  let system = '';
  const messages = [];
  for (const m of payload.messages || []) {
    if (m.role === 'system') {
      // The system prompt leads the conversation; a later system message (reminders) is
      // folded into a user turn so the request stays valid on every Claude model.
      if (!messages.length) system += (system ? '\n\n' : '') + String(m.content ?? '');
      else messages.push({ role: 'user', content: String(m.content ?? '') });
      continue;
    }
    if (m.role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* send an empty input rather than fail the whole request */
        }
        // tool_use.input must be an object; wrap anything else so the request stays valid.
        if (!input || typeof input !== 'object' || Array.isArray(input)) input = { value: input };
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (content.length) messages.push({ role: 'assistant', content });
      continue;
    }
    if (m.images?.length) {
      messages.push({
        role: 'user',
        content: [
          ...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })),
          { type: 'text', text: String(m.content ?? '') }
        ]
      });
      continue;
    }
    messages.push({ role: 'user', content: String(m.content ?? '') });
  }
  const cap = Number(s.maxResponseTokens);
  const body = {
    model: s.model,
    // max_tokens is required by the Messages API; 16384 leaves room for long code answers.
    max_tokens: cap > 0 ? cap : 16384,
    stream: true,
    messages
  };
  if (system) body.system = system;
  if (payload.tools?.length) {
    body.tools = payload.tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object' } }));
  }
  return body;
}

const ANTHROPIC_STOP = { tool_use: 'tool_calls', end_turn: 'stop', max_tokens: 'length' };

async function streamAnthropic(s, payload, signal, send) {
  const res = await fetch(apiUrl(s, '/messages'), {
    method: 'POST',
    headers: apiHeaders(s),
    body: JSON.stringify(s.promptCache === false ? toAnthropicRequest(s, payload) : require('./anthropiccache.js').addCacheBreakpoints(toAnthropicRequest(s, payload))),
    signal,
    dispatcher: modelDispatcher
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} from ${s.baseUrl}: ${errorBody(text)}`);
  }

  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const blocks = new Map(); // SSE content-block index -> tool call being assembled
  let finishReason = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let billedPromptTokens = 0;
  const decoder = new TextDecoder();
  let buffer = '';

  const handle = (j) => {
    if (j.type === 'error') throw new Error(j.error?.message || 'Anthropic stream error');
    if (j.type === 'message_start') {
      const u = j.message?.usage || {};
      promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      cacheRead = u.cache_read_input_tokens || 0;
      cacheWrite = u.cache_creation_input_tokens || 0;
      billedPromptTokens = require('./anthropiccache.js').billedInput(u);
    } else if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
      const slot = { id: j.content_block.id, type: 'function', function: { name: j.content_block.name, arguments: '' } };
      blocks.set(j.index, slot);
      toolCalls.push(slot);
      send('tool_progress', toolCalls.map((t) => t.function.name));
    } else if (j.type === 'content_block_delta') {
      const d = j.delta || {};
      if (d.type === 'text_delta' && d.text) {
        content += d.text;
        send('delta', d.text);
      } else if (d.type === 'thinking_delta' && d.thinking) {
        reasoning += d.thinking;
        send('reasoning', d.thinking);
      } else if (d.type === 'input_json_delta' && blocks.has(j.index)) {
        blocks.get(j.index).function.arguments += d.partial_json || '';
      }
    } else if (j.type === 'message_delta') {
      if (j.delta?.stop_reason) finishReason = ANTHROPIC_STOP[j.delta.stop_reason] || 'stop';
      if (j.usage?.output_tokens) completionTokens = j.usage.output_tokens;
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data) handle(JSON.parse(data));
    }
  }

  return { ok: true, content, reasoning, toolCalls, finishReason, usage: { promptTokens, completionTokens, cacheRead, cacheWrite, billedPromptTokens } };
}

// ---------- remote sessions (other devices viewing/driving this app) ----------
const remoteSessions = require('./remote');
const os = require('os');

// Actions that must run in the renderer (the agent loop lives there) go over a small
// request/response bridge: main sends remote:ask with an id, the renderer answers via
// remote:answer. A missing or wedged renderer turns into a clean HTTP error.
const remotePending = new Map();
let remoteSeq = 0;

function askRenderer(kind, payload, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return resolve({ ok: false, code: 503, error: 'The host app window is not ready.' });
    }
    const id = ++remoteSeq;
    const timer = setTimeout(() => {
      remotePending.delete(id);
      resolve({ ok: false, code: 504, error: 'The host app did not answer in time.' });
    }, timeoutMs);
    remotePending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    mainWindow.webContents.send('remote:ask', { id, kind, payload });
  });
}

ipcMain.handle('remote:answer', (_e, id, result) => {
  remotePending.get(id)?.(result || { ok: true });
  remotePending.delete(id);
  return true;
});

const remoteDeps = {
  token: () => loadSettings().remoteAccess?.token || '',
  info: () => ({ app: 'qwen-workspace', version: app.getVersion(), device: os.hostname(), platform: process.platform, workspace: workspaceRoot || null }),
  listConvs: () => readConvIndex(),
  loadConv: (id) => {
    if (!/^[\w-]+$/.test(String(id))) return null;
    try {
      return JSON.parse(fs.readFileSync(convFile(id), 'utf8'));
    } catch {
      return null;
    }
  },
  startConversation: ({ text, title }) => askRenderer('start', { text, title }),
  sendMessage: (id, { text }) => {
    const meta = readConvIndex().find((c) => c.id === id);
    if (!meta) return Promise.resolve({ ok: false, code: 404, error: 'No such conversation' });
    if (meta.workspace && meta.workspace !== workspaceRoot) {
      return Promise.resolve({ ok: false, code: 409, error: `That conversation belongs to ${meta.workspace}. Open that folder on the host first.` });
    }
    return askRenderer('message', { id, text });
  },
  stop: (id) => askRenderer('stop', { id })
};

function syncRemote() {
  remoteSessions.syncServer(loadSettings(), remoteDeps, (m) => console.log(m));
}

ipcMain.handle('remote:state', () => remoteSessions.serverState());

// The viewer side goes through main (renderer fetch would trip CORS/CSP): call a paired
// device's API with its stored pairing code.
ipcMain.handle('remote:call', async (_e, device, pathName, method = 'GET', body) => {
  try {
    const base = String(device?.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) return { ok: false, status: 0, error: 'The device URL must start with http://' };
    if (!/^\/qw\//.test(String(pathName))) return { ok: false, status: 0, error: 'Bad path' };
    const res = await fetch(base + pathName, {
      method,
      headers: { Authorization: `Bearer ${device.token || ''}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.cause?.code || err.message };
  }
});

// ---------- app info & updates ----------
ipcMain.handle('app:info', () => ({ version: app.getVersion(), kind: updater.installKind(), releasesUrl: updater.RELEASES_URL, platform: process.platform }));
ipcMain.handle('update:check', () => updater.checkForUpdate());
ipcMain.handle('update:download', (event) =>
  updater.downloadUpdate((p) => {
    if (!event.sender.isDestroyed()) event.sender.send('update:progress', p);
  })
);
ipcMain.handle('update:install', () => updater.installUpdate());
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- hardware & local models ----------
ipcMain.handle('system:specs', (_e, force) => detectSpecs(force));

// Ollama's own address: the configured server when it is Ollama, otherwise the default local one.
async function ollamaBase() {
  const s = loadSettings();
  if (s.provider === 'ollama' || (await isOllama(s))) return ollamaRoot(s);
  return 'http://localhost:11434';
}

// Health-check a list of Ollama nodes in parallel: GET /api/tags with a short timeout,
// so a powered-off shop PC costs three seconds once, not a hang. Returns one entry per
// node: { id, up, models } or { id, up: false, error }.
// LM Studio's native model list (GET /api/v1/models): LLM keys plus what QWS uses for routing
// and the draft-model pick — size, parameters, context, vision/tool capabilities, loaded state.
async function lmStudioModels(root) {
  try {
    const r = await fetch(`${root}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { models: [], lmModels: [], error: 'LM Studio asks for an API token: turn off "Require Authentication" in its Developer → Server Settings (QWS does not store tokens)' };
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j?.models)) return null;
    const llms = j.models.filter((m) => m.type === 'llm' && m.key);
    return {
      models: llms.map((m) => m.key),
      lmModels: llms.map((m) => ({
        key: m.key,
        type: m.type,
        params: m.params_string || null,
        sizeBytes: m.size_bytes || 0,
        maxContext: m.max_context_length || null,
        vision: !!m.capabilities?.vision,
        tools: !!m.capabilities?.trained_for_tool_use,
        loaded: (m.loaded_instances || []).length > 0,
        format: m.format || null
      }))
    };
  } catch {
    return null;
  }
}

ipcMain.handle('nodes:check', async (_e, nodes) => {
  const list = (Array.isArray(nodes) ? nodes : []).slice(0, 16);
  return Promise.all(
    list.map(async (n) => {
      const root = String(n?.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
      if (!/^https?:\/\//.test(root)) return { id: n?.id, up: false, error: 'Not an http(s) URL' };
      try {
        // The version rides along for features gated on it (Claude Code needs Ollama 0.14+);
        // a server that answers tags but not version still counts as up. 8s, not 3s: an Ollama
        // that is cold-loading a model or mid-generation answers slowly, and marking it down
        // made tasks hop nodes for no reason.
        const verP = fetch(`${root}/api/version`, { signal: AbortSignal.timeout(8000) })
          .then((r) => (r.ok ? r.json() : null)).then((j) => j?.version).catch(() => undefined);
        const res = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(8000) });
        const json = res.ok ? await res.json().catch(() => null) : null;
        if (Array.isArray(json?.models)) return { id: n.id, up: true, kind: 'ollama', models: json.models.map((m) => m.name).filter(Boolean), version: await verP };
        // Not Ollama: maybe LM Studio's server (the app or headless `lms daemon up`).
        const lm = await lmStudioModels(root);
        if (lm) return { id: n.id, up: true, kind: 'lmstudio', ...lm };
        return { id: n.id, up: false, error: res.ok ? 'Answers, but is neither Ollama nor LM Studio' : `HTTP ${res.status}` };
      } catch (err) {
        return { id: n.id, up: false, error: permissionHint(err.cause?.code || err.message) };
      }
    })
  );
});

// Connection doctor probes: run from the app's own process so they fail exactly the way the
// app fails (per-app firewall rules and macOS local-network denial hit here, not in a user's
// PowerShell/Terminal). The renderer's diagnose.js turns these steps into a verdict.
ipcMain.handle('nodes:diagnose', async (_e, baseUrl) => {
  const steps = [];
  const timed = async (step, fn) => {
    const t0 = Date.now();
    try {
      steps.push({ step, ok: true, detail: await fn(), ms: Date.now() - t0 });
      return true;
    } catch (err) {
      // A DOMException's .code is a legacy NUMBER (AbortSignal.timeout → 23); prefer string
      // codes, then the exception name, so the report says "TimeoutError", not "23".
      const code = err.cause?.code || (typeof err.code === 'string' ? err.code : null) || (err.name !== 'Error' ? err.name : null) || err.message;
      steps.push({ step, ok: false, detail: code, ms: Date.now() - t0 });
      return false;
    }
  };
  const root = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  let u = null;
  try {
    u = new URL(root);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not an http(s) URL');
    steps.push({ step: 'parse', ok: true, detail: `${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}` });
  } catch (err) {
    steps.push({ step: 'parse', ok: false, detail: err.message });
    return steps;
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  // WHATWG URL keeps the brackets on an IPv6 literal ("[::1]"); net.connect would hand that
  // string to DNS and report a false ENOTFOUND, so they come off here.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Raw TCP first: a bare socket surfaces the exact errno (EACCES vs ECONNREFUSED vs
  // ETIMEDOUT), which is the whole diagnosis.
  await timed('tcp', () => new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })); }, 5000);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve('connected'); });
    s.once('error', (err) => { clearTimeout(t); reject(err); });
  }));
  // The cleaned root, not u.origin: a reverse-proxied node ("https://host/ollama") keeps its
  // path prefix this way, matching exactly what nodes:check and the chat path request.
  await timed('http', async () => {
    const r = await fetch(`${root}/api/version`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: `HTTP ${r.status}` });
    const j = await r.json().catch(() => null);
    return `Ollama ${j?.version || '?'} answered`;
  });
  // Control probe: can this app connect ANYWHERE at all? Distinguishes "this node's path is
  // blocked" from "the app itself is blocked".
  await timed('control', async () => {
    const r = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(4000) });
    return `loopback 11434 ${r.ok ? 'answers' : `HTTP ${r.status}`}`;
  });
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy'].filter((k) => process.env[k]);
  steps.push({ step: 'env', ok: true, detail: proxies.length ? `proxy variables set: ${proxies.join(', ')}` : 'no proxy environment variables' });
  return steps;
});

// Per-model tool-call check against an Ollama node (see probeVerdict in renderer/nodes.js).
const NodeRules = require('./renderer/nodes.js');
ipcMain.handle('model:probe', async (_e, baseUrl, model) => {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\//.test(root) || !model) return { ok: false, error: 'Not an http(s) node URL or no model.' };
  const chat = async (messages, tools) => {
    const r = await fetch(`${root}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, keep_alive: '5m', options: { num_ctx: 4096, temperature: 0 } }),
      signal: AbortSignal.timeout(240_000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return (await r.json()).message || {};
  };
  const t0 = Date.now();
  try {
    const a = await chat([{ role: 'user', content: NodeRules.PROBE_PROMPT }]);
    const b = await chat([{ role: 'user', content: NodeRules.PROBE_TOOL_PROMPT }], [NodeRules.PROBE_TOOL]);
    return { ...NodeRules.probeVerdict(a.content, b), seconds: Math.round((Date.now() - t0) / 1000) };
  } catch (err) {
    return { ok: false, error: err.cause?.code || err.message };
  }
});

// What a node has loaded right now, with how much of each model sits in GPU memory.
ipcMain.handle('ollama:ps', async (_e, baseUrl) => {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\//.test(root)) return [];
  try {
    const r = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const loaded = (await r.json()).models || [];
    // File sizes (≈ the weights) let the renderer work out a context window that fits the GPU.
    const files = new Map();
    try {
      const t = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (t.ok) for (const m of (await t.json()).models || []) files.set(m.name, m.size);
    } catch {
      /* sizes are optional */
    }
    return loaded.map((x) => ({ name: x.name, size: x.size, size_vram: x.size_vram, context_length: x.context_length, file_size: files.get(x.name) }));
  } catch {
    return [];
  }
});

// What the fit estimate needs before a model loads: its file size (≈ weights, from /api/tags)
// and its architecture numbers (model_info from /api/show).
ipcMain.handle('ollama:fitinfo', async (_e, baseUrl, model) => {
  const root = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\//.test(root) || !model) return null;
  try {
    const [tags, show] = await Promise.all([
      fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null)),
      fetch(`${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null))
    ]);
    const norm = (x) => (String(x).includes(':') ? String(x) : `${x}:latest`);
    const entry = (tags?.models || []).find((m) => norm(m.name) === norm(model));
    return { fileSize: entry?.size || 0, modelInfo: show?.model_info || null };
  } catch {
    return null;
  }
});

ipcMain.handle('ollama:tags', async () => {
  const base = await ollamaBase();
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { running: false, base, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { running: true, base, models: (json.models || []).map((m) => ({ name: m.name, size: m.size, params: m.details?.parameter_size, quant: m.details?.quantization_level })) };
  } catch (err) {
    return { running: false, base, error: err.cause?.code || err.message };
  }
});

const pulls = new Map();

ipcMain.handle('ollama:pull', async (event, model) => {
  const base = await ollamaBase();
  const controller = new AbortController();
  pulls.set(model, controller);
  const send = (data) => {
    if (!event.sender.isDestroyed()) event.sender.send('ollama:pull-progress', { model, ...data });
  };
  try {
    const res = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, name: model, stream: true }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const decoder = new TextDecoder();
    let buffer = '';
    let lastSent = 0;
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        // Progress lines arrive very fast; pass on a few per second.
        const now = Date.now();
        if (j.status !== 'downloading' || !j.total || now - lastSent > 250 || j.completed === j.total) {
          lastSent = now;
          send({ status: j.status, completed: j.completed, total: j.total });
        }
      }
    }
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, cancelled: true };
    return { ok: false, error: err.cause?.code === 'ECONNREFUSED' ? `Ollama isn't running at ${base}.` : err.message };
  } finally {
    pulls.delete(model);
  }
});

ipcMain.handle('ollama:pull-cancel', (_e, model) => {
  pulls.get(model)?.abort();
  return true;
});

// ---------- conversation history ----------
// Each conversation is a JSON file; index.json holds the summaries the history list shows.
const CONV_ID = /^[a-z0-9]{6,40}$/i;

function convDir() {
  return path.join(app.getPath('userData'), 'conversations');
}
function convFile(id) {
  if (!CONV_ID.test(String(id))) throw new Error('Invalid conversation id');
  return path.join(convDir(), `${id}.json`);
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function readConvIndex() {
  try {
    return JSON.parse(fs.readFileSync(path.join(convDir(), 'index.json'), 'utf8'));
  } catch {
    return [];
  }
}
function convSummary(c) {
  return {
    id: c.id,
    title: c.title,
    workspace: c.workspace,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    status: c.status,
    model: c.model,
    mode: c.mode,
    changes: (c.changes || []).length,
    messages: (c.display || []).filter((d) => d.t === 'user').length
  };
}
function updateConvIndex(fn) {
  const index = fn(readConvIndex());
  writeJsonAtomic(path.join(convDir(), 'index.json'), index);
  return index;
}

ipcMain.handle('conv:list', (_e, workspace) =>
  readConvIndex()
    .filter((c) => !workspace || c.workspace === workspace)
    .sort((a, b) => b.updatedAt - a.updatedAt)
);
ipcMain.handle('conv:load', (_e, id) => JSON.parse(fs.readFileSync(convFile(id), 'utf8')));
ipcMain.handle('conv:save', (_e, conv) => {
  writeJsonAtomic(convFile(conv.id), conv);
  const summary = convSummary(conv);
  updateConvIndex((index) => [...index.filter((c) => c.id !== conv.id), summary]);
  return summary;
});
// Search past conversations across every project (newest 400), for the search_history tool.
const convSearch = require('./convsearch');
function loadRecentConvs(limit = 400) {
  return readConvIndex()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, limit)
    .map((s) => {
      try {
        return JSON.parse(fs.readFileSync(convFile(s.id), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
ipcMain.handle('conv:search', (_e, query, opts) => convSearch.searchConversations(loadRecentConvs(), query, { limit: 5, excludeId: opts?.excludeId || null }));
ipcMain.handle('conv:condensed', (_e, id) => {
  const conv = JSON.parse(fs.readFileSync(convFile(id), 'utf8'));
  return { title: conv.title, workspace: conv.workspace, updatedAt: conv.updatedAt, text: convSearch.condensedConv(conv) };
});

// Personal memory: one Markdown file that follows the user into every project (Hermes Agent's
// USER.md idea). Lives in the app's data folder, never in a project.
function userMemoryFile() {
  return path.join(app.getPath('userData'), 'USER.md');
}
const USER_MEMORY_MAX = 4000;
ipcMain.handle('userMemory:get', () => {
  try {
    return fs.readFileSync(userMemoryFile(), 'utf8');
  } catch {
    return '';
  }
});
ipcMain.handle('userMemory:set', (_e, text) => {
  const body = String(text || '').slice(0, USER_MEMORY_MAX);
  fs.mkdirSync(path.dirname(userMemoryFile()), { recursive: true });
  fs.writeFileSync(userMemoryFile(), body);
  return body;
});
ipcMain.handle('userMemory:append', (_e, fact) => {
  const line = String(fact || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!line) throw new Error('Nothing to remember.');
  let cur = '';
  try {
    cur = fs.readFileSync(userMemoryFile(), 'utf8');
  } catch {
    /* first entry */
  }
  if (cur.toLowerCase().includes(line.toLowerCase())) return cur; // already known
  const next = `${cur.replace(/\s*$/, '')}${cur.trim() ? '\n' : ''}- ${line}\n`;
  if (next.length > USER_MEMORY_MAX) throw new Error(`Personal memory is full (${USER_MEMORY_MAX} characters). Tidy it in Settings → Agent → Personal memory.`);
  fs.mkdirSync(path.dirname(userMemoryFile()), { recursive: true });
  fs.writeFileSync(userMemoryFile(), next);
  return next;
});

ipcMain.handle('conv:delete', (_e, id) => {
  fs.rmSync(convFile(id), { force: true });
  updateConvIndex((index) => index.filter((c) => c.id !== id));
  return true;
});

// ---------- long context (YaRN) ----------
// What a downloaded model was trained for, and whether its GGUF carries YaRN rope scaling.
ipcMain.handle('ollama:show', async (_e, model) => {
  const base = await ollamaBase();
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, name: model }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const info = (await res.json()).model_info || {};
    const arch = info['general.architecture'];
    const key = (k) => info[`${arch}.${k}`] ?? null;
    return {
      arch,
      contextLength: key('context_length'),
      rope: { type: key('rope.scaling.type'), factor: key('rope.scaling.factor'), originalContext: key('rope.scaling.original_context_length') }
    };
  } catch {
    return null;
  }
});

// Finds the 4-bit GGUF in a Hugging Face repo and the name Ollama pulls it by
// (hf.co/<repo>:<quant>). Unsharded files only; Ollama can't pull split GGUFs from hf.co.
const hfCache = new Map();
const QUANT_PREFERENCE = [/^Q4_K_M$/i, /^UD-Q4_K_XL$/i, /^Q4_K_S$/i, /^Q4_0$/i, /^Q5_K_M$/i, /^Q3_K_M$/i];

ipcMain.handle('hf:resolve', async (_e, repo) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error('Invalid repository name');
  if (hfCache.has(repo)) return hfCache.get(repo);
  let result;
  try {
    // HF_ENDPOINT is the standard way to point Hugging Face tools at a mirror.
    const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
    const res = await fetch(`${endpoint}/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 404 || res.status === 401) {
      result = { status: 'missing', repo };
    } else if (!res.ok) {
      throw new Error(`Hugging Face returned HTTP ${res.status}`);
    } else {
      const files = ((await res.json()).siblings || [])
        .map((s) => ({ name: s.rfilename, size: s.size || 0, quant: /((?:UD-)?(?:I?Q\d\w*|BF16|F16|F32))\.gguf$/i.exec(s.rfilename)?.[1] }))
        .filter((f) => f.quant && !f.name.includes('/') && !/mmproj/i.test(f.name) && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.name));
      let file = null;
      for (const pref of QUANT_PREFERENCE) if ((file = files.find((f) => pref.test(f.quant)))) break;
      result = file
        ? { status: 'ok', repo, file: file.name, tag: file.quant, sizeGB: file.size / 1e9, ollamaId: `hf.co/${repo}:${file.quant}` }
        : { status: 'missing', repo };
    }
    hfCache.set(repo, result);
  } catch (err) {
    // Not cached, so it is retried next time.
    result = { status: 'error', repo, error: err.cause?.code || err.message };
  }
  return result;
});

// ---------- skills ----------
// A skill is a folder with SKILL.md (optional front matter: name, description) plus any
// supporting files. Project skills live in <project>/.qwen/skills, personal ones in the app's
// data folder. Only names and descriptions go into the prompt; the rest loads on demand.
function skillRoots() {
  const roots = [];
  if (workspaceRoot) {
    roots.push(['project', path.join(workspaceRoot, '.qwen', 'skills')]);
    // Claude-format skills use the same SKILL.md layout, so a project set up for Claude Code
    // (or your personal ~/.claude skills) works here unchanged.
    roots.push(['claude', path.join(workspaceRoot, '.claude', 'skills')]);
  }
  roots.push(['user', path.join(app.getPath('userData'), 'skills')]);
  roots.push(['claudeuser', path.join(app.getPath('home'), '.claude', 'skills')]);
  return roots;
}

function parseSkill(text, dirName) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  return { name: meta.name || dirName, description: (meta.description || firstLine).slice(0, 300), body };
}

ipcMain.handle('skills:list', async () => {
  const byName = new Map();
  // User skills first so a project skill with the same name replaces it.
  for (const [scope, root] of skillRoots().reverse()) {
    let dirs = [];
    try {
      dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      continue;
    }
    const idx = scope === 'user' ? (await readSkillIndex()).skills : {};
    for (const d of dirs) {
      try {
        const text = await fsp.readFile(path.join(root, d.name, 'SKILL.md'), 'utf8');
        const { name, description } = parseSkill(text, d.name);
        const e = idx[d.name];
        byName.set(name.toLowerCase(), { id: `${scope}:${d.name}`, name, description, scope, ...(e ? { createdBy: e.createdBy, uses: e.uses || 0, lastUsed: e.lastUsed || null, state: e.state || 'active' } : {}) });
      } catch {
        /* no SKILL.md */
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
});

ipcMain.handle('skills:read', async (_e, id, file) => {
  const [scope, dirName] = String(id).split(':');
  const root = skillRoots().find(([s]) => s === scope)?.[1];
  if (!root || !/^[\w. -]+$/.test(dirName || '')) throw new Error('Unknown skill');
  const base = path.join(root, dirName);
  const target = path.resolve(base, file || 'SKILL.md');
  const relSkill = path.relative(base, target);
  if (relSkill === '..' || relSkill.startsWith('..' + path.sep) || path.isAbsolute(relSkill)) throw new Error('That file is outside the skill folder');
  const st = await fsp.stat(target);
  if (st.size > 200 * 1024) throw new Error('Skill file is too large');
  const text = await fsp.readFile(target, 'utf8');
  // Where the skill lives, so "run <skill folder>/scripts/x.py" can work: project-relative when
  // it is inside the project, else absolute; forward slashes either way.
  const inProject = workspaceRoot && !path.relative(workspaceRoot, base).startsWith('..') && !path.isAbsolute(path.relative(workspaceRoot, base));
  const folder = (inProject ? path.relative(workspaceRoot, base) : base).split(path.sep).join('/');
  return { content: file ? text : parseSkill(text, dirName).body, files: await listSkillFiles(base), folder };
});

// Skills QWS wrote itself (self-written skills) are tracked in a sidecar index next to them:
// who wrote it, how often it was loaded, when last, and its curator state. Installed and
// hand-written skills never appear in the index, so the curator never touches them.
const SkillWriter = require('./renderer/skillwriter.js');
const userSkillsDir = () => path.join(app.getPath('userData'), 'skills');
const skillIndexPath = () => path.join(userSkillsDir(), '.qws-index.json');
async function readSkillIndex() {
  try {
    const j = JSON.parse(await fsp.readFile(skillIndexPath(), 'utf8'));
    return { skills: j.skills && typeof j.skills === 'object' ? j.skills : {}, lastCurated: Number(j.lastCurated) || 0 };
  } catch {
    return { skills: {}, lastCurated: 0 };
  }
}
async function writeSkillIndex(idx) {
  await fsp.mkdir(userSkillsDir(), { recursive: true });
  await fsp.writeFile(skillIndexPath(), JSON.stringify(idx, null, 2));
}
const safeSkillDir = (n) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(String(n || ''));

// Saves an approved self-written skill into the personal skills folder (all projects).
ipcMain.handle('skills:create', async (_e, draft) => {
  const parsed = SkillWriter.parseSkillDraft(String(draft?.content || ''));
  if (!parsed) return { ok: false, output: 'That skill draft is not valid.' };
  let taken = [];
  try {
    taken = await fsp.readdir(userSkillsDir());
  } catch {
    /* first skill */
  }
  const idx = await readSkillIndex();
  const name = SkillWriter.uniqueName(parsed.name, [...taken, ...Object.keys(idx.skills)]);
  const content = name === parsed.name ? parsed.content : parsed.content.replace(/^name: .*$/m, `name: ${name}`);
  await fsp.mkdir(path.join(userSkillsDir(), name), { recursive: true });
  await fsp.writeFile(path.join(userSkillsDir(), name, 'SKILL.md'), content);
  idx.skills[name] = { createdBy: 'qws', createdAt: Date.now(), uses: 0, lastUsed: null, state: 'active' };
  await writeSkillIndex(idx);
  return { ok: true, name, id: `user:${name}` };
});

// A personal skill was loaded: count it and revive it if the curator had marked it stale.
ipcMain.handle('skills:used', async (_e, id) => {
  const [scope, dirName] = String(id || '').split(':');
  if (scope !== 'user') return false;
  const idx = await readSkillIndex();
  if (!idx.skills[dirName]) return false;
  idx.skills[dirName] = SkillWriter.recordUse(idx.skills[dirName], Date.now());
  await writeSkillIndex(idx);
  return true;
});

async function archiveSkill(idx, name) {
  const from = path.join(userSkillsDir(), name);
  const to = path.join(userSkillsDir(), '.archive', name);
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.rename(from, to);
  idx.skills[name] = { ...idx.skills[name], state: 'archived', archivedAt: Date.now() };
}

// The curator, run at startup at most once a day: QWS-written skills unused for 30 days turn
// stale, for 60 days move to skills/.archive (out of the prompt, restorable from Settings).
ipcMain.handle('skills:curate', async (_e, opts) => {
  const idx = await readSkillIndex();
  const now = Number(opts?.now) || Date.now();
  if (!opts?.force && now - idx.lastCurated < 86400000) return { stale: [], archived: [] };
  const plan = SkillWriter.curatorPlan(idx.skills, now);
  for (const n of plan.stale) idx.skills[n] = { ...idx.skills[n], state: 'stale' };
  const archived = [];
  for (const n of plan.archive) {
    if (!safeSkillDir(n)) continue;
    try {
      await archiveSkill(idx, n);
      archived.push(n);
    } catch {
      /* folder gone or locked — try again next time */
    }
  }
  idx.lastCurated = now;
  await writeSkillIndex(idx);
  return { stale: plan.stale, archived };
});

ipcMain.handle('skills:archived', async () => {
  const idx = await readSkillIndex();
  return Object.entries(idx.skills).filter(([, e]) => e.state === 'archived').map(([name, e]) => ({ name, ...e }));
});

ipcMain.handle('skills:archive', async (_e, name) => {
  const idx = await readSkillIndex();
  if (!safeSkillDir(name) || !idx.skills[name] || idx.skills[name].state === 'archived') return false;
  await archiveSkill(idx, name);
  await writeSkillIndex(idx);
  return true;
});

ipcMain.handle('skills:restore', async (_e, name) => {
  const idx = await readSkillIndex();
  if (!safeSkillDir(name) || idx.skills[name]?.state !== 'archived') return false;
  await fsp.rename(path.join(userSkillsDir(), '.archive', name), path.join(userSkillsDir(), name));
  // Restored counts as a fresh start, so the curator does not archive it again tomorrow.
  idx.skills[name] = { ...idx.skills[name], state: 'active', lastUsed: Date.now(), archivedAt: undefined };
  await writeSkillIndex(idx);
  return true;
});

// Installs a skill folder from a GitHub link (a repo, or a folder inside one via /tree/…) into
// the project's .qwen/skills — or the personal skills folder when no project is open. Files are
// fetched one by one through the GitHub contents API, so no git or tar is needed.
ipcMain.handle('skills:install', async (_e, url) => {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(String(url || '').trim());
  if (!m) return { ok: false, output: 'Use a GitHub link: https://github.com/owner/repo or …/tree/<branch>/<folder containing SKILL.md>.' };
  const [, owner, repo, ref, subRaw] = m;
  const sub = (subRaw || '').replace(/\/+$/, '');
  const gh = (p) => fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Qwen-Workspace' },
    signal: AbortSignal.timeout(30_000)
  });

  const files = []; // { rel, url }
  async function walk(p, rel, depth) {
    if (depth > 3 || files.length >= 80) return;
    const res = await gh(p);
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${p || 'the repository root'}${res.status === 404 ? ' — check the link (and the branch name)' : ''}.`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('That link points to a file. Link to the folder that contains SKILL.md.');
    for (const e of list) {
      if (files.length >= 80) break;
      // Only plain names: no traversal, no hidden/exotic entries.
      if (e.name === '..' || !/^[\w][\w.\- ]*$/.test(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === 'dir') await walk(e.path, childRel, depth + 1);
      else if (e.type === 'file' && e.size <= 300 * 1024 && e.download_url) files.push({ rel: childRel, url: e.download_url });
    }
  }
  try {
    await walk(sub, '', 0);
    if (!files.some((f) => f.rel === 'SKILL.md')) return { ok: false, output: 'That folder has no SKILL.md, so it is not a skill. Link to the folder that contains SKILL.md (e.g. …/tree/main/skills/<name>).' };
    const dirName = (sub.split('/').pop() || repo).replace(/[^\w.-]/g, '-');
    const root = workspaceRoot ? path.join(workspaceRoot, '.qwen', 'skills') : path.join(app.getPath('userData'), 'skills');
    const dest = path.join(root, dirName);
    if (fs.existsSync(dest)) return { ok: false, output: `A skill folder named "${dirName}" already exists (${dest}). Remove it first to reinstall.` };
    for (const f of files) {
      const res = await fetch(f.url, { headers: { 'User-Agent': 'Qwen-Workspace' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Downloading ${f.rel} failed (HTTP ${res.status}).`);
      const target = path.join(dest, ...f.rel.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
    }
    const meta = parseSkill(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), dirName);
    return { ok: true, name: meta.name, description: meta.description, dest, files: files.length, scope: workspaceRoot ? 'project' : 'user' };
  } catch (err) {
    return { ok: false, output: err.message };
  }
});

// Supporting files in a skill folder (relative, forward slashes), not counting SKILL.md.
async function listSkillFiles(base, rel = '', out = [], depth = 0) {
  if (depth > 3 || out.length >= 100) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listSkillFiles(base, p, out, depth + 1);
    else if (e.isFile() && p !== 'SKILL.md') out.push(p);
  }
  return out;
}

// ---------- tool programs (codemode) ----------
// A model-written mini-program runs in a worker thread (src/program-worker.js) inside a hardened
// VM: no require/process/network in scope, no dynamic code generation, null-prototype host
// bridges only, string-only values across the boundary. The worker is what makes the time limit
// real: vm's own timeout covers synchronous code only, and a program that looped after its first
// `await` used to run on this process's event loop with nothing able to interrupt it, freezing
// the whole app — worker.terminate() stops it anywhere. Every tools.* call is relayed to the
// renderer (program:call), which runs it through the normal tool pipeline — approvals included —
// and answers via program:answer.
const { Worker } = require('node:worker_threads');
const programWorkers = new Map(); // callId -> the worker waiting for that answer
let programWorkerSource = null; // the worker's code, read once; eval mode also works from inside an asar

ipcMain.handle('program:answer', (_e, callId, result, failed) => {
  const worker = programWorkers.get(callId);
  programWorkers.delete(callId);
  if (worker) worker.postMessage({ type: 'answer', callId, result: String(result ?? ''), failed: !!failed });
  return true;
});

ipcMain.handle('program:run', (event, runId, code, toolNames, timeoutMs) => {
  const limitMs = Math.min(Math.max(Number(timeoutMs) || 180_000, 10_000), 600_000);
  const logs = [];
  let calls = 0;
  return new Promise((resolve) => {
    let worker = null;
    let timer = null;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [id, w] of programWorkers) if (w === worker) programWorkers.delete(id);
      worker?.terminate().catch(() => {});
      resolve({ logs, calls, ...r });
    };
    try {
      programWorkerSource = programWorkerSource || fs.readFileSync(path.join(__dirname, 'program-worker.js'), 'utf8');
      worker = new Worker(programWorkerSource, {
        eval: true,
        workerData: { runId: String(runId), code: String(code), toolNames: (Array.isArray(toolNames) ? toolNames : []).map(String).slice(0, 64) }
      });
    } catch (err) {
      return finish({ ok: false, error: `Could not start the program: ${err.message}` });
    }
    timer = setTimeout(() => finish({ ok: false, error: `The program ran longer than ${Math.round(limitMs / 1000)}s and was stopped.` }), limitMs);
    worker.on('message', (m) => {
      if (!m || settled) return;
      if (m.type === 'log') {
        if (logs.length < 200) logs.push(String(m.line));
      } else if (m.type === 'call') {
        calls++;
        if (event.sender.isDestroyed()) return worker.postMessage({ type: 'answer', callId: m.callId, result: 'The window is gone.', failed: true });
        programWorkers.set(m.callId, worker);
        event.sender.send('program:call', { callId: m.callId, name: m.name, args: m.args });
      } else if (m.type === 'done') {
        finish(m.ok ? { ok: true, value: String(m.value ?? '') } : { ok: false, error: String(m.error || 'The program failed.') });
      }
    });
    worker.on('error', (err) => finish({ ok: false, error: String((err && err.message) || err).slice(0, 2000) }));
    worker.on('exit', (exitCode) => finish({ ok: false, error: `The program stopped unexpectedly (exit code ${exitCode}).` }));
  });
});

// ---------- semantic code index ----------
// Ported from qws: structural chunks embedded via Ollama (nomic-embed-text) when reachable,
// else a built-in offline hash embedder; stored as one JSON file per project. The chunk-hash
// manifest makes refreshes incremental: unchanged files cost nothing.
const sem = require('./renderer/semindex.js');
const SEM_EMBED_MODEL = 'nomic-embed-text';
const SEM_SKIP = new Set(['.git', '.qwen', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target', '.idea', '.vscode']);

function semIndexPath() {
  return path.join(workspaceRoot, '.qwen', 'semindex.json');
}

async function semWalkFiles() {
  const out = {};
  const walk = async (dir, rel) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SEM_SKIP.has(e.name)) await walk(path.join(dir, e.name), r);
      } else if (sem.SEM_CODE_EXTS.includes(path.extname(e.name).toLowerCase())) {
        try {
          const st = await fsp.stat(path.join(dir, e.name));
          if (st.size <= 512 * 1024) out[r] = await fsp.readFile(path.join(dir, e.name), 'utf8');
        } catch {
          /* unreadable */
        }
      }
    }
  };
  await walk(workspaceRoot, '');
  return out;
}

async function semProbeOllama(s) {
  try {
    const res = await fetch(`${ollamaRoot(s)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SEM_EMBED_MODEL, input: ['probe'] }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.embeddings) && data.embeddings.length > 0;
  } catch {
    return false;
  }
}

async function semEmbed(meta, s, texts) {
  if (meta.embedder.startsWith('hash-')) return sem.hashEmbed(texts, meta.dim || 256);
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await fetch(`${ollamaRoot(s)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SEM_EMBED_MODEL, input: batch }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!res.ok) throw new Error(`Embedding failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.embeddings || []));
  }
  return out;
}

// Build or incrementally refresh the index; returns it plus what changed.
async function semRefresh(progress) {
  if (!workspaceRoot) throw new Error('No workspace folder is open.');
  const s = loadSettings();
  const files = await semWalkFiles();
  let idx = null;
  try {
    idx = JSON.parse(await fsp.readFile(semIndexPath(), 'utf8'));
  } catch {
    /* fresh build */
  }
  if (!idx || !idx.meta) {
    const useOllama = await semProbeOllama(s);
    idx = { meta: { embedder: useOllama ? `ollama-${SEM_EMBED_MODEL}` : 'hash-256', dim: useOllama ? 0 : 256, builtAt: 0 }, files: {}, chunks: [] };
  }
  const digests = {};
  for (const [p, t] of Object.entries(files)) digests[p] = sem.fnv1a64(t);
  const changed = Object.keys(files).filter((p) => idx.files[p] !== digests[p]);
  const removedOrChanged = new Set([...changed, ...Object.keys(idx.files).filter((p) => !(p in files))]);
  const oldVecs = new Map(idx.chunks.map((c) => [c.id, c.vec]));
  idx.chunks = idx.chunks.filter((c) => !removedOrChanged.has(c.path));
  const fresh = [];
  for (const p of changed) for (const c of sem.chunkFile(p, files[p])) fresh.push(c);
  const toEmbed = fresh.filter((c) => !oldVecs.has(c.id));
  progress?.({ phase: 'embed', done: 0, total: toEmbed.length });
  for (let i = 0; i < toEmbed.length; i += 32) {
    const batch = toEmbed.slice(i, i + 32);
    const vecs = await semEmbed(idx.meta, s, batch.map(sem.promptText));
    batch.forEach((c, j) => {
      c.vec = (vecs[j] || []).map((v) => Math.round(v * 1e5) / 1e5);
    });
    if (!idx.meta.dim && vecs[0]) idx.meta.dim = vecs[0].length;
    progress?.({ phase: 'embed', done: Math.min(i + 32, toEmbed.length), total: toEmbed.length });
  }
  for (const c of fresh) if (!c.vec) c.vec = oldVecs.get(c.id);
  idx.chunks.push(...fresh);
  idx.files = digests;
  idx.meta.builtAt = Date.now();
  await fsp.mkdir(path.dirname(semIndexPath()), { recursive: true });
  await fsp.writeFile(semIndexPath(), JSON.stringify(idx), 'utf8');
  return { idx, files, embedded: toEmbed.length, changedFiles: changed.length };
}

ipcMain.handle('sem:status', async () => {
  try {
    const idx = JSON.parse(await fsp.readFile(semIndexPath(), 'utf8'));
    return { exists: true, chunks: idx.chunks.length, files: Object.keys(idx.files).length, embedder: idx.meta.embedder, builtAt: idx.meta.builtAt };
  } catch {
    return { exists: false };
  }
});

ipcMain.handle('sem:index', async (event) => {
  try {
    const r = await semRefresh((pr) => {
      if (!event.sender.isDestroyed()) event.sender.send('sem:progress', pr);
    });
    return { ok: true, chunks: r.idx.chunks.length, files: Object.keys(r.idx.files).length, embedded: r.embedded, embedder: r.idx.meta.embedder };
  } catch (err) {
    return { ok: false, output: err.message };
  }
});

ipcMain.handle('sem:search', async (_e, query, k) => {
  try {
    const { idx, files } = await semRefresh(null); // incremental: unchanged files cost nothing
    if (!idx.chunks.length) return { text: 'The semantic index is empty — the project has no indexable code files.', hits: 0 };
    const s = loadSettings();
    const [qv] = await semEmbed(idx.meta, s, [String(query || '')]);
    const top = sem.cosineTopK(qv, idx.chunks, Math.min(12, Math.max(1, Number(k) || 6)));
    const neighbors = sem.depNeighbors(files, new Set(top.map((t) => t.chunk.path)));
    return { text: sem.formatHits(top, neighbors), hits: top.length };
  } catch (err) {
    return { text: `Semantic search failed: ${err.message}`, hits: 0, failed: true };
  }
});

// ---------- web research ----------
ipcMain.handle('web:search', (_e, query) => web.webSearch(loadSettings(), String(query || '').slice(0, 400)));
ipcMain.handle('web:fetch', (_e, url) => web.fetchPage(loadSettings(), url));

// ---------- MCP ----------
ipcMain.handle('mcp:list', () => mcp.describe());
// check_api: does this name exist in the project's installed packages? (apicheck.js)
ipcMain.handle('api:check', async (_e, names, language) => {
  try {
    return await require('./apicheck.js').checkApi({
      names,
      language,
      root: workspaceRoot,
      platform: process.platform,
      electronPath: process.execPath,
      tmpDir: (() => { const d = path.join(app.getPath('userData'), 'apicheck'); fs.mkdirSync(d, { recursive: true }); return d; })(),
      run: (cmd, args, opts) => new Promise((resolve) => {
        let out = '';
        let child;
        try {
          child = spawn(cmd, args, { cwd: opts?.cwd, windowsHide: true, env: { ...commandEnv(), ...(opts?.env || {}) } });
        } catch (e) {
          return resolve({ code: -1, out: `ENOENT ${e.message}` });
        }
        const timer = setTimeout(() => killTree(child), 30_000);
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${e.code === 'ENOENT' ? 'ENOENT ' : ''}${e.message}` }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
      })
    });
  } catch (e) {
    return { text: `Error: ${e.message}`, results: [] };
  }
});
// One-click GIMP setup (gimp-mcp): downloads the pinned server + plugin, installs the plugin into
// GIMP's newest 3.x plug-ins folder, and returns the server entry. Started from a Settings button
// behind a confirmation, since it writes outside the project.
ipcMain.handle('gimp:setup', async () => {
  try {
    return await require('./gimpsetup.js').setupGimp({
      platform: process.platform,
      env: process.env,
      home: app.getPath('home'),
      dataDir: app.getPath('userData'),
      fetch: (url) => fetch(url, { signal: AbortSignal.timeout(60_000) }),
      hasUv: async () => (await runQuiet('uv', ['--version'])).code === 0
    });
  } catch (e) {
    return { ok: false, message: `GIMP setup failed: ${e.message}` };
  }
});
// One-click browser control (Playwright MCP): checks Node and the chosen browser, makes QWS's
// own profile and output folders in its data folder, and returns the server entry. Nothing is
// downloaded here — npx fetches the pinned @playwright/mcp the first time the server starts.
function browserInstalled(browser) {
  const env = process.env;
  const win = (...rel) => [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).map((b) => path.join(b, ...rel));
  const paths = process.platform === 'win32'
    ? (browser === 'msedge' ? win('Microsoft', 'Edge', 'Application', 'msedge.exe') : win('Google', 'Chrome', 'Application', 'chrome.exe'))
    : process.platform === 'darwin'
      ? [browser === 'msedge' ? '/Applications/Microsoft Edge.app' : '/Applications/Google Chrome.app']
      : (browser === 'msedge' ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome']);
  return paths.some((p) => fs.existsSync(p));
}
ipcMain.handle('browser:setup', async (_e, opts) => {
  const BrowserCtl = require('./renderer/browserctl.js');
  const mode = BrowserCtl.MODES.includes(opts?.mode) ? opts.mode : 'profile';
  const browser = BrowserCtl.BROWSERS.includes(opts?.browser) ? opts.browser : 'chrome';
  const nameOf = { chrome: 'Chrome', msedge: 'Edge' }[browser];
  const node = await runQuiet('node', ['--version']);
  if (node.code !== 0) return { ok: false, message: 'Browser control runs on Node.js, which is not installed (or not on PATH). Install Node.js LTS from https://nodejs.org (or ask Qwen to install it with install_app), then click Set up again.' };
  const steps = [`Node.js ${node.out.trim()} found`];
  const warn = [];
  if (browserInstalled(browser)) steps.push(`${nameOf} found`);
  else warn.push(`${nameOf} was not found in its usual place. ${mode === 'extension' ? `Install ${nameOf} and the extension first.` : `Install ${nameOf}, or pick ${browser === 'chrome' ? 'Edge' : 'Chrome'} instead — otherwise the first page will fail to open.`}`);
  const profileDir = path.join(app.getPath('userData'), 'browser-profile');
  const outputDir = path.join(app.getPath('userData'), 'browser-output');
  await fsp.mkdir(outputDir, { recursive: true });
  if (mode === 'profile') {
    await fsp.mkdir(profileDir, { recursive: true });
    steps.push(`QWS's own ${nameOf} profile: ${profileDir} (sign in there once; your normal ${nameOf} profile is not touched)`);
  }
  if (mode === 'headless') steps.push('Headless: an invisible browser with no saved logins, fresh each time');
  if (mode === 'extension') steps.push(`Uses your running ${nameOf}: install the "Playwright MCP Bridge" extension in it (link below). ${nameOf} asks you to allow the connection when QWS first connects.`);
  steps.push(`Added the "Browser" MCP server (@playwright/mcp ${BrowserCtl.PLAYWRIGHT_MCP_VERSION}, fetched by npx on first start)`);
  return { ok: true, steps, warn, server: BrowserCtl.serverConfig({ mode, browser, profileDir, outputDir }), extensionUrl: mode === 'extension' ? 'https://github.com/microsoft/playwright/tree/main/packages/extension#readme' : null };
});
// One-click Craft Anything tools: the pinned CLI release for this OS, checksum-verified, as an
// MCP server (see craftsetup.js).
function extractArchive(archive, dest, kind) {
  if (kind === 'zip' && process.platform === 'win32') return extractZip(archive, dest);
  const [cmd, args] = kind === 'zip' ? ['ditto', ['-x', '-k', archive, dest]] : ['tar', ['-xzf', archive, '-C', dest]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Could not unpack the download: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the download.${err ? ` ${err.trim().slice(0, 300)}` : ''}`))));
  });
}
ipcMain.handle('craft:setup', async () => {
  try {
    return await require('./craftsetup.js').setupCraft({
      platform: process.platform,
      arch: process.arch,
      dataDir: app.getPath('userData'),
      fetch: (url) => fetch(url, { headers: { 'User-Agent': 'Qwen-Workspace' }, signal: AbortSignal.timeout(10 * 60_000) }),
      extract: extractArchive,
      run: async (cmd, args) => {
        const r = await runQuiet(cmd, args, 30_000);
        return { code: r.code, out: r.out };
      }
    });
  } catch (e) {
    return { ok: false, message: `Craft Anything setup failed: ${e.message}` };
  }
});
// The benchmark (renderer/bench.js): a fresh folder per task under the app's data, the results
// of each run as JSON beside them, and the latest run read back for comparison.
const benchRoot = () => path.join(app.getPath('userData'), 'bench');
ipcMain.handle('bench:prepare', async (_e, runId, taskId) => {
  const safe = (x) => String(x || '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const dir = path.join(benchRoot(), 'runs', safe(runId), safe(taskId));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  return dir;
});
ipcMain.handle('bench:save', async (_e, run) => {
  const dir = path.join(benchRoot(), 'results');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${String(run?.id || Date.now()).replace(/[^\w.-]+/g, '_')}.json`);
  await fsp.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
  return file;
});
ipcMain.handle('bench:last', async () => {
  const dir = path.join(benchRoot(), 'results');
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('bench:has', async (_e, tool) => {
  const r = await runQuiet(tool === 'python' ? (process.platform === 'win32' ? 'python' : 'python3') : 'node', ['--version'], 10_000);
  return r.code === 0 && !/Microsoft Store|was not found/i.test(r.out || '');
});
ipcMain.handle('mcp:reconnect', () => mcp.connectAll(loadSettings().mcpServers));
ipcMain.handle('mcp:connectOne', (_e, cfg) => mcp.connectOne(cfg));
ipcMain.handle('mcp:disconnect', (_e, id) => mcp.disconnectOne(id));
ipcMain.handle('mcp:call', async (_e, name, args, timeout) => {
  try {
    return await mcp.callTool(name, args, { timeout });
  } catch (err) {
    return { text: `Error: ${err.message}`, isError: true };
  }
});

// ---------- project templates ----------
// Bundled starter trees under templates/. Install copies a template's files into the open
// project, skipping files that already exist so nothing is overwritten.
function templatesDir() {
  return path.join(__dirname, '..', 'templates');
}

ipcMain.handle('templates:list', async () => {
  let dirs = [];
  try {
    dirs = (await fsp.readdir(templatesDir(), { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(templatesDir(), d.name, 'template.json'), 'utf8'));
    } catch {
      /* no manifest */
    }
    out.push({ id: d.name, name: meta.name || d.name, kind: meta.kind || 'workflow', description: meta.description || '', icon: meta.icon || 'sparkles', adds: meta.adds || '', then: meta.then || '' });
  }
  return out;
});

async function collectFiles(root, rel = '', out = []) {
  const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await collectFiles(root, p, out);
    else if (e.isFile() && p !== 'template.json') out.push(p);
  }
  return out;
}

ipcMain.handle('templates:install', async (_e, id) => {
  if (!workspaceRoot) throw new Error('Open a project folder first.');
  if (!/^[\w.-]+$/.test(String(id))) throw new Error('Unknown template');
  const src = path.join(templatesDir(), id);
  try {
    await fsp.access(src);
  } catch {
    throw new Error('Unknown template');
  }
  const files = await collectFiles(src);
  const written = [];
  const skipped = [];
  for (const rel of files) {
    const dest = resolveInWorkspace(rel);
    try {
      await fsp.access(dest);
      skipped.push(rel);
      continue;
    } catch {
      /* does not exist, write it */
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(src, rel), dest);
    written.push(rel);
  }
  return { written, skipped };
});

// ---------- git helpers ----------
// Where a portable Git (MinGit) is unpacked if the app downloads one itself.
function portableGitExe() {
  return path.join(app.getPath('userData'), 'portable-git', 'cmd', 'git.exe');
}

// Resolve the git executable. Prefer a portable copy the app installed, then the standard
// Windows install locations, then PATH — since Electron launched from Explorer may not have git
// on PATH (e.g. Git was installed without the "add to PATH" option).
let gitPathCache;
function gitExe() {
  if (gitPathCache && (gitPathCache === 'git' || safeExists(gitPathCache))) return gitPathCache;
  gitPathCache = null;
  if (process.platform === 'win32') {
    const portable = portableGitExe();
    if (safeExists(portable)) return (gitPathCache = portable);
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')
    ].filter(Boolean);
    for (const root of roots) {
      for (const sub of [['Git', 'cmd', 'git.exe'], ['Git', 'bin', 'git.exe']]) {
        const p = path.join(root, ...sub);
        if (safeExists(p)) return (gitPathCache = p);
      }
    }
  }
  // Don't cache the fallback: if git is installed later, a real path is found next call.
  return 'git';
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Directory of the resolved git executable, or null when we're relying on PATH.
function gitDir() {
  const exe = gitExe();
  return exe === 'git' ? null : path.dirname(exe);
}

// On Windows a fresh install writes its folder to the registry Path, but a running app keeps
// the environment it started with — so "install cmake" followed by "cmake" fails with "not
// recognized" until a restart. Read the machine and user Path from the registry (cached
// briefly) so newly installed tools work in the very next command.
let regPathCache = { at: 0, value: '' };
function registryPath() {
  if (process.platform !== 'win32') return '';
  if (Date.now() - regPathCache.at < 20_000) return regPathCache.value;
  const read = (hive) => {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = /REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/.exec(out);
      return m ? m[1].trim() : '';
    } catch {
      return '';
    }
  };
  let combined = [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')].filter(Boolean).join(';');
  // Expand %SystemRoot%-style references against the live environment.
  combined = combined.replace(/%([^%;]+)%/g, (_m, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? `%${name}%`);
  regPathCache = { at: Date.now(), value: combined };
  return combined;
}

// macOS apps launched from Finder inherit a bare PATH (no /opt/homebrew/bin, no nvm), so brew,
// node or cmake look "not installed". Ask the login shell for its PATH once per session.
let loginPathCache;
function loginShellPath() {
  if (process.platform !== 'darwin') return '';
  if (loginPathCache !== undefined) return loginPathCache;
  try {
    loginPathCache = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo -n "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    loginPathCache = '';
  }
  const brewDirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'].filter((d) => safeExists(d) && !loginPathCache.split(':').includes(d));
  if (brewDirs.length) loginPathCache = [loginPathCache, ...brewDirs].filter(Boolean).join(':');
  return loginPathCache;
}

// process.env with the resolved git's folders prepended and the registry Path (Windows) or the
// login shell's PATH (macOS) appended, so shell commands find a portable/non-PATH git and
// freshly installed tools alike. The variable is usually stored as "Path" on Windows; reuse
// the existing key to avoid a duplicate.
function commandEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const parts = [env[key] || ''];
  // Git's own folders first; its Unix tools (usr\bin) last, so Windows' timeout, find and sort
  // are not replaced by Unix ones of the same name (src/cmdrun.js).
  const g = CmdRun.gitPathParts(gitDir(), path.join, safeExists);
  if (g.before.length) parts.unshift(g.before.join(path.delimiter));
  const reg = registryPath();
  if (reg) parts.push(reg);
  const login = loginShellPath();
  if (login) parts.push(login);
  if (g.after.length) parts.push(g.after.join(path.delimiter));
  env[key] = parts.filter(Boolean).join(path.delimiter);
  return env;
}

// Windows caps paths at 260 characters unless git opts out, and deep repos (submodules,
// generated code) blow past that with errors that read like permission problems. Turn long
// paths on once per session when git is available; harmless where already set.
let longPathsSet = false;
async function ensureGitLongPaths() {
  if (longPathsSet || process.platform !== 'win32') return;
  longPathsSet = true;
  await runGit(['config', '--global', 'core.longpaths', 'true'], undefined, 10_000).catch(() => {});
}

// Is a working git reachable right now (portable, installed, or on PATH)?
function gitAvailable() {
  return new Promise((resolve) => {
    const child = spawn(gitExe(), ['--version'], { windowsHide: true, env: process.env });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Downloads MinGit (the minimal portable Git for Windows) and unpacks it into userData, so the
// user doesn't have to install Git by hand. No admin rights, no PATH changes.
async function installPortableGit(onProgress) {
  if (process.platform !== 'win32') throw new Error(process.platform === 'darwin' ? 'Automatic Git install is only available on Windows. On macOS run `xcode-select --install` in Terminal.' : 'Automatic Git install is only available on Windows. Install Git from your package manager.');
  onProgress?.({ phase: 'find' });
  const rel = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Qwen-Workspace' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!rel.ok) throw new Error(`Couldn't reach GitHub to find Git (HTTP ${rel.status}).`);
  const data = await rel.json();
  const is64 = process.arch === 'x64' || process.arch === 'arm64';
  // Prefer the standard MinGit zip (not the BusyBox variant) for the right architecture.
  const assets = (data.assets || []).filter((a) => /^MinGit-.*\.zip$/i.test(a.name) && !/busybox/i.test(a.name));
  const asset = assets.find((a) => (is64 ? /64-bit/i.test(a.name) : /32-bit/i.test(a.name))) || assets[0];
  if (!asset) throw new Error('Could not find a MinGit download in the latest Git for Windows release.');

  const dir = path.join(app.getPath('userData'), 'portable-git');
  const zip = path.join(app.getPath('userData'), 'portable-git.zip');
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(zip, { force: true }).catch(() => {});

  onProgress?.({ phase: 'download', percent: 0 });
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Qwen-Workspace' }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  let got = 0;
  const handle = await fsp.open(zip, 'w');
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(Buffer.from(value));
      got += value.length;
      if (total) onProgress?.({ phase: 'download', percent: Math.round((got / total) * 100), got, total });
    }
  } finally {
    await handle.close();
  }

  onProgress?.({ phase: 'extract' });
  await extractZip(zip, dir);
  await fsp.rm(zip, { force: true }).catch(() => {});
  gitPathCache = null;
  const exe = portableGitExe();
  if (!safeExists(exe)) throw new Error('Git was downloaded but could not be unpacked.');
  gitPathCache = exe;
  ensureGitLongPaths();
  onProgress?.({ phase: 'done' });
  return exe;
}

// Unzips with PowerShell's built-in Expand-Archive, so no extra dependency is needed.
function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', (e) => reject(new Error(`Could not unpack the download: ${e.message}`)));
    ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the download.${err ? ` ${err.trim()}` : ''}`))));
  });
}

const GIT_MISSING = process.platform === 'darwin'
  ? "Git isn't installed, or Qwen Workspace can't find it. Run `xcode-select --install` in Terminal (or `brew install git`), then try again."
  : "Git isn't installed, or Qwen Workspace can't find it. Install Git from https://git-scm.com/download/win (keep the default options), then restart the app.";

function runGit(args, cwd, timeout = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(gitExe(), args, { cwd, windowsHide: true, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => killTree(child), timeout);
    child.on('error', (e) => resolve({ code: -1, output: e.code === 'ENOENT' ? GIT_MISSING : `${out}\n${e.message}`.trim() }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out.trim() });
    });
  });
}

// Stages everything and commits with the given message via a temp file, so multi-line and
// quoted messages are passed safely (no shell escaping).
ipcMain.handle('git:commit', async (_e, message) => {
  const cwd = resolveInWorkspace('.');
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, output: 'Empty commit message.' };
  const add = await runGit(['add', '-A'], cwd);
  if (add.code !== 0) return { ok: false, output: add.output };
  const tmp = path.join(app.getPath('userData'), `commit-msg-${Date.now()}.txt`);
  await fsp.writeFile(tmp, msg + '\n', 'utf8');
  try {
    let r = await runGit(['commit', '-F', tmp], cwd);
    // A fresh PC (e.g. with the portable Git the app installed) has no git identity yet,
    // and git refuses to commit without one. Fall back to a local app identity so the
    // first commit just works; the user's own git config wins whenever it exists.
    if (r.code !== 0 && /Author identity unknown|Please tell me who you are|empty ident name|unable to auto-detect email/i.test(r.output)) {
      r = await runGit(['-c', 'user.name=Qwen Workspace', '-c', 'user.email=qwen-workspace@localhost', 'commit', '-F', tmp], cwd);
    }
    return { ok: r.code === 0, output: r.output };
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

ipcMain.handle('git:init', async () => {
  const r = await runGit(['init'], resolveInWorkspace('.'));
  return { ok: r.code === 0, output: r.output };
});

// Reports whether a working git is reachable, so the UI can offer to install one if not.
ipcMain.handle('git:ensure', async () => {
  const ok = await gitAvailable();
  if (ok) ensureGitLongPaths();
  return { ok, canInstall: process.platform === 'win32' };
});

// Downloads and unpacks a portable Git, streaming progress to the renderer.
ipcMain.handle('git:install', async (event) => {
  try {
    await installPortableGit((p) => {
      if (!event.sender.isDestroyed()) event.sender.send('git:install-progress', p);
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, output: e.message };
  }
});

// Clones a repo into a folder the user picks, and returns the new project path to open.
ipcMain.handle('git:clone', async (_e, url) => {
  const u = String(url || '').trim();
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(u)) throw new Error('That does not look like a git URL.');
  const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose where to put the cloned repo', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { cancelled: true };
  const parent = r.filePaths[0];
  const name = (u.replace(/\.git$/, '').split(/[/\\]/).pop() || 'repo').replace(/[^\w.-]/g, '');
  const dest = path.join(parent, name);
  try {
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) return { ok: false, output: `${dest} already exists and is not empty.` };
  } catch {
    /* ignore */
  }
  const res = await runGit(['clone', u, dest], parent, 10 * 60_000);
  return { ok: res.code === 0, dir: res.code === 0 ? dest : null, output: res.output };
});
