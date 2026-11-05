'use strict';

// The benchmark runner (Settings → Benchmark). Each task runs as a real agent task with the
// user's current settings — models, nodes, planner, plan-first, architect — in a fresh folder,
// with a time limit; then its hidden checks run (benchtasks.js) and the result is recorded:
// passed, minutes, model requests, hand-offs to stronger models, cloud tokens. Runs are saved
// so each one is compared with the last: which tasks got fixed, which broke.

const bench = { running: false, stop: false, conv: null, results: [], last: null, label: '' };

function benchTokens(spend) {
  return Object.entries(spend || {}).map(([m, v]) => `${m} ${Math.round((v.in || 0) / 100) / 10}K in/${Math.round((v.out || 0) / 100) / 10}K out`).join(', ');
}

// One check of a finished task: { name, passed, detail }.
async function benchCheck(check, platform) {
  if (check.type === 'command') {
    const cmd = typeof check.command === 'function' ? check.command(platform) : check.command;
    const r = await api.runCommand(cmd, 60_000);
    return { name: cmd, passed: r.code === 0, detail: r.code === 0 ? 'exit 0' : `exit ${r.code}: ${BenchTasks.failureLine(r.output)}` };
  }
  if (check.type === 'page') {
    const r = await api.guiTestPage({ file: check.file, probe: check.probe, selfTest: !!check.selfTest, waitSeconds: 2 });
    const problems = [];
    if (r.error) problems.push(r.error);
    else if (!r.loaded) problems.push(`did not load: ${r.loadError || 'unknown'}`);
    if (r.crashed) problems.push(`crashed: ${r.crashed}`);
    if ((r.errors || []).length) problems.push(`console errors: ${r.errors.slice(0, 3).join(' | ')}`);
    if (check.notBlank && r.shot) {
      const px = await decodePicture(r.shot.png);
      if (px && GuiTest.isBlankPage(r, Likeness.isBlank(px.rgba, px.width, px.height))) problems.push('blank screen');
    }
    if (check.probe && r.loaded && r.probe !== true) problems.push(String(r.probe ?? 'the check did not run'));
    if (check.selfTest && r.loaded) {
      if (!r.selfTest) problems.push('no window.selfTest()');
      else {
        let parsed = null;
        try {
          parsed = JSON.parse(r.selfTest);
        } catch {
          parsed = null;
        }
        const j = SelfTest.judge(parsed);
        if (!j.passed) problems.push(j.text.split('\n')[0]);
      }
    }
    return { name: check.file, passed: !problems.length, detail: problems.join('; ') || 'ok' };
  }
  return { name: check.type, passed: false, detail: 'unknown check' };
}

async function benchRunTask(task, runId) {
  const t0 = Date.now();
  if (task.needs && !(await api.benchHas(task.needs))) return { id: task.id, title: task.title, skipped: true, detail: `${task.needs} is not installed on this PC` };
  const dir = await api.benchPrepare(runId, task.id);
  await openWorkspace(dir, true);
  for (const [p, content] of Object.entries(task.seed || {})) await api.write(p, content);
  const c = createConv();
  c.title = `⏱ Benchmark: ${task.title}`;
  c.mode = 'agent';
  c.benchTask = task.id;
  state.convs.set(c.id, c);
  [c.memory, c.skills] = await Promise.all([loadProjectMemory(), api.skillsList().catch(() => [])]);
  c.memoryLoaded = true;
  bench.conv = c;
  switchConv(c);
  addUserMessage(c, task.prompt, []);
  c.history.push({ role: 'user', content: task.prompt });
  setBusy(c, true);
  const limit = setTimeout(() => {
    c.timedOut = true;
    c.stopRequested = true;
  }, (task.minutes || 10) * 60_000);
  let failed = false;
  try {
    failed = await runConversation(c);
  } catch (e) {
    failed = true;
    addError(c, `Something went wrong: ${cleanError(e)}`);
  } finally {
    clearTimeout(limit);
    c.status = c.stopRequested ? 'stopped' : failed ? 'error' : 'done';
    setBusy(c, false);
    saveConv(c, true);
  }
  // Hidden files only now, so the agent never saw the tests.
  for (const [p, content] of Object.entries(task.hidden || {})) await api.write(p, content);
  const checks = [];
  for (const ch of task.checks || []) {
    try {
      checks.push(await benchCheck(ch, state.ws?.platform));
    } catch (e) {
      checks.push({ name: ch.file || ch.type, passed: false, detail: cleanError(e) });
    }
  }
  const log = c.log || [];
  // A task that stopped on an error (a model that would not load, a server that went away)
  // says so, so the table does not read like the model tried and failed.
  const lastError = [...log].reverse().find((e) => e.kind === 'error')?.text || '';
  const endedEarly = failed && !c.timedOut && !bench.stop && lastError ? String(lastError).split('\n')[0].slice(0, 200) : '';
  return {
    id: task.id,
    title: task.title,
    passed: !!checks.length && checks.every((x) => x.passed),
    endedEarly,
    checks,
    minutes: Math.round(((Date.now() - t0) / 60_000) * 10) / 10,
    timedOut: !!c.timedOut,
    stopped: !!bench.stop,
    requests: log.filter((e) => e.kind === 'request').length,
    handoffs: log.filter((e) => e.kind === 'escalate').length,
    cloud: benchTokens(c.spend),
    spend: c.spend || {},
    conv: c.id
  };
}

async function runBenchmark(set) {
  if (bench.running) return;
  const tasks = BenchTasks.tasksFor(set);
  const s = state.settings;
  const cloud = s.heavy?.enabled ? ` Your planner (${s.heavy.model}) is used when your settings call for it${s.planFirst ? ' — plan-first is on, so every task plans on it' : ''}${s.architect !== false && s.planFirst ? ', and the architect writes new files with it' : ''}: that is cloud spend.` : '';
  if (!confirm(`Run the benchmark (${tasks.length} task${tasks.length === 1 ? '' : 's'}) with your current settings?\n\nEach task runs as a real agent task (${s.model}, auto approvals for the benchmark's own folders) with a time limit, then hidden checks score it. It takes about ${tasks.reduce((a, t) => a + (t.minutes || 10), 0)} minutes at most, and the app is busy while it runs.${cloud}\n\nYour open folder comes back when it finishes.`)) return;
  const back = state.ws?.root || null;
  const approvalWas = s.approvalMode;
  bench.running = true;
  bench.stop = false;
  bench.results = [];
  bench.last = await api.benchLast().catch(() => null);
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  // The benchmark's folders are throwaway: approvals run in Auto there, and come back after.
  state.settings = await api.setSettings({ approvalMode: 'auto' });
  renderBenchmark();
  try {
    for (const task of tasks) {
      if (bench.stop) break;
      bench.current = task.title;
      renderBenchmark();
      const r = await benchRunTask(task, runId).catch((e) => ({ id: task.id, title: task.title, passed: false, checks: [], detail: cleanError(e) }));
      bench.results.push(r);
      renderBenchmark();
    }
  } finally {
    state.settings = await api.setSettings({ approvalMode: approvalWas });
    // Saved before the run reads as finished, so a stopped run (or one driven from the terminal,
    // which closes the app the moment `running` drops) still keeps its results.
    const run = { id: runId, at: new Date().toISOString(), label: bench.label || '', stopped: bench.stop, version: state.appVersion || '', settings: { model: s.model, provider: s.provider, planner: s.heavy?.enabled ? s.heavy.model : null, planFirst: !!s.planFirst, planWith: s.planWith, architect: s.architect !== false }, results: bench.results };
    if (bench.results.length) await api.benchSave(run).catch(() => {});
    bench.running = false;
    bench.current = null;
    bench.conv = null;
    if (back) await openWorkspace(back, true).catch(() => {});
    renderBenchmark();
    flash(`Benchmark: ${BenchTasks.summary(bench.results)}`);
  }
}

function stopBenchmark() {
  bench.stop = true;
  if (bench.conv) bench.conv.stopRequested = true;
}

function renderBenchmark() {
  const box = $('#bench-results');
  if (!box) return;
  $('#bench-run-btn').disabled = bench.running;
  $('#bench-stop-btn').classList.toggle('hidden', !bench.running);
  const rows = bench.results;
  const delta = BenchTasks.compare(rows, bench.last);
  box.replaceChildren(
    ...(bench.running ? [el('div', { class: 'hint', text: `Running: ${bench.current || '…'} (${rows.length} done)` })] : []),
    ...(rows.length ? [el('div', { class: 'hint ok', text: BenchTasks.summary(rows) + (bench.last ? ` · last run: ${BenchTasks.summary(bench.last.results || [])}` : '') })] : []),
    ...(rows.length ? [el('table', { class: 'bench-table' },
      el('tr', {}, ...['Task', 'Result', 'Min', 'Requests', 'Hand-offs', 'Cloud', ''].map((h) => el('th', { text: h }))),
      ...rows.map((r, i) => el('tr', { class: r.skipped ? 'skipped' : r.passed ? 'pass' : 'fail', title: (r.checks || []).map((x) => `${x.name}: ${x.detail}`).join('\n') || r.detail || '' },
        el('td', { text: r.title }),
        el('td', { text: r.skipped ? `skipped — ${r.detail}` : r.passed ? 'pass' : `fail${r.timedOut ? ' (time limit)' : ''}: ${r.endedEarly ? `ended early — ${r.endedEarly}` : (r.checks || []).filter((x) => !x.passed).map((x) => x.detail).join('; ').slice(0, 140) || r.detail || ''}` }),
        el('td', { text: r.skipped ? '' : String(r.minutes ?? '') }),
        el('td', { text: r.skipped ? '' : String(r.requests ?? '') }),
        el('td', { text: r.skipped ? '' : String(r.handoffs ?? '') }),
        el('td', { text: r.cloud || '' }),
        el('td', { text: delta[i] === 'fixed' ? '▲ fixed' : delta[i] === 'broke' ? '▼ broke' : '' }))))] : [])
  );
}
