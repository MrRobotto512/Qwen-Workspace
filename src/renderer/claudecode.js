'use strict';

// Claude Code on your Ollama nodes: Ollama (0.14+) serves the Anthropic Messages API at the
// server root, so the `claude` CLI can run against any node — a local model, no Anthropic
// account, no spend. Claude Code is a full-screen interactive TUI and the app's terminal
// panel has no TTY, so the launcher opens the system terminal in the workspace folder with
// the environment already pointed at the chosen node and model (the same approach as the
// `gh auth login` sign-in). The pure parts — building the launch command, ranking a node's
// models, the Ollama version gate — live here and are require()d by tests.

// Ollama model tags are letters, digits and [._:/-]; anything else is refused outright
// rather than shell-quoted, since the tag goes into a terminal command.
const CC_MODEL_RE = /^[A-Za-z0-9._:\/-]+$/;

// The Anthropic-compatible endpoint lives at the server root, not under /v1.
function ccBaseUrl(node) {
  return String(node.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

// Ollama serves /v1/messages from 0.14 on. Unknown versions pass (the server may simply
// not be asked yet); known-older ones are called out so the user updates that machine.
function ollamaSupportsAnthropic(version) {
  const m = /(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return true;
  return Number(m[1]) > 0 || Number(m[2]) >= 14;
}

// nodes.js provides the ":latest"-aware model comparison; in the renderer it is the Nodes
// global, under node:test it is require()d (the same pattern reviewpass.js uses).
const CCNodes = typeof module !== 'undefined' && module.exports ? require('./nodes.js') : (typeof window !== 'undefined' ? window.Nodes : null);

// A node's installed models in the order worth offering: catalog models strongest first,
// then everything else as the server listed it.
function sortModelsForClaude(models, catalog) {
  const cat = catalog || [];
  const rank = (id) => cat.find((c) => CCNodes.sameModel(c.id, id))?.rank;
  const ranked = (models || []).filter((m) => rank(m) !== undefined).sort((a, b) => rank(b) - rank(a));
  const rest = (models || []).filter((m) => rank(m) === undefined);
  return [...ranked, ...rest];
}

// The one terminal command that opens Claude Code wired to the node. The directory is the
// only free-form string in it, so paths with quote characters are refused instead of escaped
// (three nested quoting layers on macOS make escaping them a liability, not a feature).
function buildClaudeLaunch(platform, dir, baseUrl, model) {
  if (!CC_MODEL_RE.test(String(model || ''))) return null;
  if (!dir || /["'\n\r]/.test(dir)) return null;
  const env = `ANTHROPIC_BASE_URL=${baseUrl} ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= claude --model ${model}`;
  if (platform === 'win32') {
    // `set X=Y&&` without a space before && — a space would end up inside the value.
    return `start "Claude Code" /D "${dir}" cmd /k "set ANTHROPIC_BASE_URL=${baseUrl}&& set ANTHROPIC_AUTH_TOKEN=ollama&& set ANTHROPIC_API_KEY=&& claude --model ${model}"`;
  }
  if (platform === 'darwin') {
    const sh = `cd \\"${dir}\\" && ${env}`;
    return `osascript -e 'tell application "Terminal" to do script "${sh}"' -e 'tell application "Terminal" to activate'`;
  }
  const sh = `cd "${dir}" && ${env}`;
  return `x-terminal-emulator -e bash -lc '${sh}' || xterm -e bash -lc '${sh}'`;
}

// ---- the flow (renderer only below this line) ----

// Seam for tests: the launch command goes through here so an e2e can capture it instead of
// actually opening a terminal.
let ccRun = (cmd) => api.runCommand(cmd);

async function ccCliReady() {
  if ((await api.runCommand('claude --version')).code === 0) return true;
  const installCmd = 'npm install -g @anthropic-ai/claude-code';
  const wants = await new Promise((resolve) => {
    toast({ key: 'cc', icon: 'download', timeout: 0,
      text: 'This needs the Claude Code CLI (claude), which isn’t installed.',
      actions: [
        { label: 'Install with npm', primary: true, onClick: () => resolve(true) },
        { label: 'Other ways', onClick: () => { api.openExternal('https://code.claude.com/docs/en/overview'); resolve(false); } },
        { label: 'Not now', onClick: () => resolve(false) }
      ] });
  });
  if (!wants) return false;
  showTerminal(true, false);
  termWrite(`\n❯ ${installCmd}\n`, 'term-cmd');
  const r = await api.runCommand(installCmd, 600_000);
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  if ((await api.runCommand('claude --version')).code === 0) return true;
  toast({ key: 'cc', icon: 'alert', timeout: 0, text: 'claude still isn’t available. Install it (needs Node.js for the npm route), then try again.', actions: [{ label: 'Open the docs', onClick: () => api.openExternal('https://code.claude.com/docs/en/overview') }] });
  return false;
}

// Folder menu → "Open in Claude Code…": node menu → model menu → confirm → terminal.
async function claudeCodeFlow(anchor) {
  if (!state.ws) return;
  if (!(await ccCliReady())) return;
  const nodes = Nodes.normalizeNodes(state.settings).filter((n) => n.enabled);
  flash('Checking your Ollama nodes…');
  const results = await api.nodesCheck(nodes.map((n) => ({ id: n.id, baseUrl: n.baseUrl }))).catch(() => []);
  const health = Object.fromEntries(results.map((r) => [r.id, r]));
  const usable = nodes.filter((n) => health[n.id]?.up && (health[n.id].models || []).length);
  if (!usable.length) {
    toast({ icon: 'alert', text: 'No Ollama node is reachable with a model installed. Start Ollama (or enable a node in Settings), then try again.' });
    return;
  }
  const r = anchor?.getBoundingClientRect?.() || { left: 80, bottom: 80 };
  const pickNodeFor = usable.map((n) => {
    const h = health[n.id];
    const old = !ollamaSupportsAnthropic(h.version);
    return {
      label: n.name,
      icon: 'cpu',
      detail: old ? `Ollama ${h.version} — needs 0.14+ for Claude Code` : `${h.models.length} model${h.models.length === 1 ? '' : 's'}${h.version ? ` · Ollama ${h.version}` : ''}`,
      onClick: () => {
        if (old) {
          toast({ icon: 'alert', text: `${n.name} runs Ollama ${h.version}, which doesn’t serve the Anthropic API Claude Code speaks. Update Ollama on that machine to 0.14 or newer.` });
          return;
        }
        pickClaudeModel(n, h, r);
      }
    };
  });
  showMenu(r.left, r.bottom + 4, pickNodeFor);
}

function pickClaudeModel(node, health, r) {
  const models = sortModelsForClaude(health.models, MODEL_CATALOG);
  showMenu(r.left, r.bottom + 4, models.slice(0, 14).map((m) => ({
    label: m,
    icon: 'zap',
    onClick: () => launchClaudeCode(node, m)
  })));
}

async function launchClaudeCode(node, model) {
  const baseUrl = ccBaseUrl(node);
  const cmd = buildClaudeLaunch(state.appInfo?.platform, state.ws.root, baseUrl, model);
  if (!cmd) {
    toast({ icon: 'alert', text: 'Couldn’t build a safe launch command (the folder path or model name contains quote characters).' });
    return;
  }
  const go = await new Promise((resolve) => {
    toast({ key: 'cc', icon: 'terminal', timeout: 0,
      text: `Open your terminal in ${baseName(state.ws.root)} with Claude Code on ${model} (${node.name})? Nothing is sent to Anthropic’s API — the model runs on your node.`,
      actions: [
        { label: 'Open terminal', primary: true, onClick: () => resolve(true) },
        { label: 'Cancel', onClick: () => resolve(false) }
      ] });
  });
  if (!go) return;
  await ccRun(cmd);
  flash(`Claude Code: ${model} on ${node.name}`);
}

const ClaudeCodeExports = { ccBaseUrl, ollamaSupportsAnthropic, sortModelsForClaude, buildClaudeLaunch };
if (typeof module !== 'undefined' && module.exports) module.exports = ClaudeCodeExports;
if (typeof window !== 'undefined') window.ClaudeCode = ClaudeCodeExports;
