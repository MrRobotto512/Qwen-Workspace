// Headless benchmark: runs Settings → Benchmark in the real app, unattended, on a named setup.
//
//   npm run bench -- --label 8b-alien --model qwen3:8b --node Alien
//   npm run bench -- --label 14b-local --model qwen3:14b --node this-pc --ctx 8192 --set quick
//
// It launches the app with Playwright (the same way the e2e tests do, so it uses the app's own
// data folder and saved runs), applies the setup (model, which node serves it, context window,
// planner off unless --keep-planner), runs the quick or full set, prints the table, compares it
// with the last saved run that carries the same label, and puts the settings back as they were.
// The app is busy while it runs: do not use it meanwhile.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (!m) return [];
  const next = all[i + 1];
  return [m[1], m[2] !== undefined ? m[2] : next && !next.startsWith('--') ? next : true];
}).filter((x) => x.length));

if (args.help) {
  console.log(`Options:
  --label <name>      a name for this setup; runs with the same label are compared (default: model name)
  --model <id>        the everyday model (default: the app's current one)
  --node <name>       which node serves it: this-pc, or a node's name / URL part; others are disabled
  --ctx <tokens>      context window (default: the app's current one)
  --set quick|all     which tasks (default: all)
  --keep-planner      leave the cloud planner on (default: off, so a run costs nothing)
  --high-perf         mark the chosen node high-performance (free escalation tier)
  --timeout <min>     give up after this many minutes (default: 100)`);
  process.exit(0);
}

const label = args.label || args.model || 'current';
const set = args.set === 'quick' ? 'quick' : 'all';
const timeoutMin = Number(args.timeout) || 100;
const dataDir = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Qwen Workspace')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Qwen Workspace')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Qwen Workspace');

const say = (s) => console.log(`[bench ${new Date().toTimeString().slice(0, 8)}] ${s}`);

function loadRuns() {
  const dir = path.join(dataDir, 'bench', 'results');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function table(results, previous) {
  const before = new Map((previous?.results || []).map((r) => [r.id, r]));
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  const lines = [`${pad('Task', 26)} ${pad('Result', 8)} ${pad('Min', 5)} ${pad('Req', 4)} ${pad('Hand', 4)} ${pad('vs last', 8)} Why`];
  for (const r of results) {
    const b = before.get(r.id);
    const delta = !b || b.skipped || r.skipped ? '' : r.passed && !b.passed ? 'fixed' : !r.passed && b.passed ? 'BROKE' : r.passed ? 'same' : 'still';
    const why = r.skipped ? r.detail : r.passed ? '' : r.endedEarly ? `ended early — ${r.endedEarly}` : (r.checks || []).filter((c) => !c.passed).map((c) => c.detail).join('; ') || r.detail || '';
    lines.push(`${pad(r.title, 26)} ${pad(r.skipped ? 'skip' : r.passed ? 'pass' : r.timedOut ? 'TIME' : 'FAIL', 8)} ${pad(r.minutes, 5)} ${pad(r.requests, 4)} ${pad(r.handoffs, 4)} ${pad(delta, 8)} ${String(why).replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  const ran = results.filter((r) => !r.skipped);
  lines.push(`${ran.filter((r) => r.passed).length}/${ran.length} passed in ${Math.round(ran.reduce((a, r) => a + (r.minutes || 0), 0))} min, ${ran.reduce((a, r) => a + (r.requests || 0), 0)} model requests, ${ran.reduce((a, r) => a + (r.handoffs || 0), 0)} hand-offs`);
  return lines.join('\n');
}

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

let snapshot = null;
let exitCode = 0;
try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 30_000 });
  snapshot = await win.evaluate(() => JSON.parse(JSON.stringify(state.settings)));

  // The setup, through the Settings form (so the same validation and node handling run).
  const applied = await win.evaluate(({ model, node, ctx, keepPlanner, highPerf }) => {
    openSettings();
    if (model) document.querySelector('#s-model').value = model;
    if (ctx) document.querySelector('#s-contextLength').value = String(ctx);
    document.querySelector('#s-agentMode').checked = true;
    document.querySelector('#s-planFirst').checked = false;
    if (!keepPlanner) document.querySelector('#s-heavy-enabled').checked = false;
    let chosen = null;
    if (node) {
      const want = String(node).toLowerCase();
      chosen = settingsNodes.find((n) => n.id === Nodes.THIS_PC_ID && /^(this-pc|this pc|local|localhost)$/.test(want))
        || settingsNodes.find((n) => n.id !== Nodes.THIS_PC_ID && [n.name, n.id, n.baseUrl].some((x) => String(x || '').toLowerCase().includes(want)));
      if (!chosen) return { error: `no node matches "${node}"; nodes: ${settingsNodes.map((n) => n.name || n.id).join(', ')}` };
      settingsNodes = settingsNodes.map((n) => ({ ...n, enabled: n.id === chosen.id, highPerf: n.id === chosen.id ? !!highPerf : false }));
    }
    return saveSettingsFromUi().then(() => ({
      model: state.settings.model, ctx: state.settings.contextLength, planner: state.settings.heavy?.enabled ? state.settings.heavy.model : 'off',
      nodes: (state.settings.ollamaNodes || []).filter((n) => n.enabled !== false).map((n) => `${n.name || n.id}${n.highPerf ? ' ⚡' : ''}`).join(', ') || 'This PC'
    }));
  }, { model: args.model, node: args.node, ctx: args.ctx, keepPlanner: !!args['keep-planner'], highPerf: !!args['high-perf'] });
  if (applied.error) throw new Error(applied.error);
  say(`setup "${label}": model ${applied.model} on ${applied.nodes}, context ${applied.ctx}, planner ${applied.planner}, ${set === 'quick' ? 'quick set' : 'all tasks'}`);

  const previous = loadRuns().filter((r) => r.label === label).pop() || null;
  if (previous) say(`comparing with the last "${label}" run from ${previous.at}`);

  await win.evaluate(([l, s]) => {
    bench.label = l;
    openSettings();
    document.querySelector('#bench-set').value = s;
    // The click opens a confirm() dialog, which the dialog handler above accepts.
    setTimeout(() => document.querySelector('#bench-run-btn').click(), 0);
  }, [label, set]);
  await win.waitForFunction(() => bench.running === true, null, { timeout: 30_000 });

  const t0 = Date.now();
  let lastSeen = -1;
  while (true) {
    const st = await win.evaluate(() => ({ running: bench.running, done: bench.results.length, current: bench.current, last: bench.results[bench.results.length - 1] }));
    if (st.done !== lastSeen) {
      if (st.last && lastSeen >= 0) say(`${st.last.title}: ${st.last.skipped ? 'skipped' : st.last.passed ? 'pass' : 'FAIL'} in ${st.last.minutes} min, ${st.last.requests} requests`);
      lastSeen = st.done;
    }
    if (!st.running) break;
    if (Date.now() - t0 > timeoutMin * 60_000) {
      say(`giving up after ${timeoutMin} minutes — stopping the benchmark`);
      await win.evaluate(() => stopBenchmark());
      await win.waitForFunction(() => !bench.running, null, { timeout: 120_000 }).catch(() => {});
      exitCode = 2;
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const results = await win.evaluate(() => bench.results);
  console.log(`\nBenchmark "${label}" — ${new Date().toISOString()}\n${table(results, previous)}`);
  const saved = loadRuns().filter((r) => r.label === label).pop();
  if (saved) say(`saved as ${saved.id}`);
  if (results.some((r) => !r.skipped && !r.passed)) exitCode = exitCode || 1;
} catch (e) {
  console.error(`BENCH FAIL: ${String(e).split('\n')[0]}`);
  exitCode = 3;
} finally {
  if (errors.length) console.error(`renderer errors: ${errors.join(' || ').slice(0, 600)}`);
  if (snapshot) await win.evaluate(async (s) => { state.settings = await api.setSettings(s); applySettingsToUi(); }, snapshot).then(() => say('settings restored')).catch((e) => console.error(`could not restore settings: ${e}`));
  const watchdog = setTimeout(() => process.exit(exitCode), 20_000);
  watchdog.unref();
  await app.close().catch(() => {});
  clearTimeout(watchdog);
}
process.exit(exitCode);
