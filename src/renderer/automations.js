'use strict';
// ===================================================================
// Automations: recurring agent tasks
// ===================================================================
let automationTimer = null;

function startAutomationScheduler() {
  if (automationTimer) return;
  automationTimer = setInterval(checkAutomations, 30_000);
  setTimeout(checkAutomations, 5000); // catch-up shortly after launch / folder open
}

function checkAutomations() {
  for (const a of state.settings.automations || []) {
    if (Schedule.automationDue(a, Date.now())) runAutomation(a);
  }
}

async function runAutomation(a) {
  // Runs only in the folder it was made for, in agent mode, one run at a time.
  if (!state.ws || state.ws.root !== a.workspace || !state.settings.agentMode) return;
  if ([...state.convs.values()].some((cv) => cv.busy && cv.automationId === a.id)) return;
  // Stamp the run first so a slow run isn't double-started by the next tick.
  a.lastRun = Date.now();
  state.settings = await api.setSettings({ automations: state.settings.automations });
  const c = createConv();
  c.automationId = a.id;
  c.title = `⏱ ${a.name}`;
  c.mode = 'agent';
  state.convs.set(c.id, c);
  [c.memory, c.skills] = await Promise.all([loadProjectMemory(), api.skillsList().catch(() => [])]);
  c.memoryLoaded = true;
  addUserMessage(c, a.prompt, []);
  c.history.push({ role: 'user', content: a.prompt });
  renderHistory();
  toast({ key: `auto-${a.id}`, icon: 'history', timeout: 10_000, text: [el('b', { text: `Automation "${a.name}"` }), ' started.'], actions: [{ label: 'Open', onClick: () => switchConv(c) }] });
  setBusy(c, true);
  let failed = false;
  try {
    failed = await runConversation(c);
  } catch (e) {
    failed = true;
    addError(c, `Something went wrong: ${cleanError(e)}`);
  } finally {
    c.status = c.stopRequested ? 'stopped' : failed ? 'error' : 'done';
    setBusy(c, false);
    saveConv(c, true);
  }
  a.lastStatus = c.status;
  state.settings = await api.setSettings({ automations: state.settings.automations });
  renderAutomations();
}

function renderAutomations() {
  const list = $('#auto-list');
  if (!list) return;
  const autos = state.settings.automations || [];
  if (!autos.length) {
    list.replaceChildren(el('div', { class: 'empty-note', text: 'No automations yet. Add one below — e.g. a morning test run, or an hourly TODO sweep.' }));
    return;
  }
  list.replaceChildren(...autos.map((a) => {
    const here = state.ws?.root === a.workspace;
    const next = Schedule.nextRunAt(a, Date.now());
    const when = a.enabled === false ? 'paused' : !here ? `runs when ${baseName(a.workspace || '?')} is open` : next <= Date.now() ? 'due now' : `next ${new Date(next).toLocaleString()}`;
    return el('div', { class: 'skill-row', title: a.prompt },
      el('input', { type: 'checkbox', checked: a.enabled !== false, title: 'Enabled', onchange: async (e) => { a.enabled = e.target.checked; state.settings = await api.setSettings({ automations: state.settings.automations }); renderAutomations(); } }),
      el('span', { class: 'sk-name', text: a.name }),
      el('span', { class: 'sk-scope', text: Schedule.describeSchedule(a.schedule) }),
      el('span', { class: 'sk-desc', text: `${when}${a.lastStatus ? ` · last: ${a.lastStatus}` : ''}` }),
      el('button', { class: 'icon-btn', title: 'Run now', onclick: () => { a.lastRun = 0; runAutomation(a); } }, iconEl('play')),
      el('button', { class: 'icon-btn', title: 'Delete', onclick: async () => { state.settings = await api.setSettings({ automations: autos.filter((x) => x.id !== a.id) }); renderAutomations(); } }, iconEl('trash')));
  }));
}

async function addAutomationFromForm() {
  const name = $('#auto-name').value.trim();
  const prompt = $('#auto-prompt').value.trim();
  if (!name || !prompt) return flash('Give the automation a name and a prompt.');
  if (!state.ws) return flash('Open the project folder this automation should run in first.');
  const kind = $('#auto-kind').value;
  const schedule = kind === 'interval'
    ? { kind: 'interval', hours: Math.min(168, Math.max(1, parseInt($('#auto-hours').value, 10) || 24)) }
    : { kind: 'daily', time: $('#auto-time').value || '09:00', catchUp: $('#auto-catchup').checked };
  const autos = [...(state.settings.automations || []), {
    id: `a${Date.now().toString(36)}`,
    name, prompt, schedule,
    workspace: state.ws.root,
    enabled: true,
    lastRun: 0,
    lastStatus: ''
  }];
  state.settings = await api.setSettings({ automations: autos });
  $('#auto-name').value = '';
  $('#auto-prompt').value = '';
  renderAutomations();
  flash(`Automation "${name}" added — ${Schedule.describeSchedule(schedule)}.`);
}
