'use strict';

// Parallel subagents across Ollama nodes (an idea from Hermes Agent's delegate_task). The agent
// hands up to 4 independent subtasks to delegate_tasks; each runs as a fresh child conversation
// pinned to its own node, all at once, and only each child's final summary (plus the files it
// changed) comes back — the parent's context never sees the children's tool chatter. This file
// is the pure logic: argument checks, node assignment, the child's instructions, the result.

const MAX_SUBTASKS = 4;
const SUMMARY_CAP = 3000;

// The tool arguments → { tasks } or { error }. Accepts strings or { task, context } objects.
function parseTasks(args) {
  const raw = Array.isArray(args?.tasks) ? args.tasks : null;
  if (!raw || !raw.length) return { error: 'Give "tasks": a list of 2 to 4 independent subtasks, each { "task": "...", "context": "..." }.' };
  const tasks = [];
  for (const t of raw) {
    const task = String(typeof t === 'string' ? t : t?.task || '').trim();
    const context = typeof t === 'object' && t ? String(t.context || '').trim() : '';
    if (task) tasks.push({ task: task.slice(0, 2000), context: context.slice(0, 6000) });
  }
  if (!tasks.length) return { error: 'Every subtask was empty.' };
  if (tasks.length > MAX_SUBTASKS) return { error: `At most ${MAX_SUBTASKS} subtasks at once; you gave ${tasks.length}. Group them, or delegate the rest after these finish.` };
  return { tasks };
}

const hasModel = (h, model, sameModel) => !!h && h.up === true && (h.models || []).some((m) => sameModel(m, model));

// One node per subtask: healthy enabled nodes that have the model first (each used once before
// any is reused), then other healthy nodes (Ollama pulls nothing — it just reports the missing
// model), wrapping around when there are more subtasks than nodes. Null when nothing is healthy.
function assignNodes(nodes, health, model, count, sameModel) {
  const same = sameModel || ((a, b) => a === b);
  const up = (nodes || []).filter((n) => n.enabled && health?.[n.id]?.up === true);
  if (!up.length) return null;
  const pool = [...up.filter((n) => hasModel(health[n.id], model, same)), ...up.filter((n) => !hasModel(health[n.id], model, same))];
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]);
}

const SUBAGENT_INSTRUCTIONS = [
  '<subagent>',
  'You are a subagent: another agent handed you ONE subtask and runs other subtasks in parallel. Do only your subtask.',
  '- Work only on the files your subtask names; other subagents may be editing other files right now.',
  '- You cannot ask the user anything. Make reasonable assumptions and state them in your summary.',
  '- When done, reply with a short summary for the agent that delegated to you: what you did or found, the files you changed, anything left undone. That summary is all it will see.',
  '</subagent>'
].join('\n');

function childPrompt(t) {
  return t.context ? `${t.task}\n\nContext from the agent that delegated this:\n${t.context}` : t.task;
}

// The tool result: one section per subtask, in the order given.
function formatResults(results) {
  const parts = results.map((r, i) => {
    const head = `### Subtask ${i + 1}${r.node ? ` (on ${r.node})` : ''}: ${r.task.slice(0, 160)}`;
    const status = r.status === 'done' ? 'finished' : r.status === 'stopped' ? 'stopped before finishing' : 'failed';
    const files = r.files?.length ? `\nFiles changed: ${r.files.join(', ')}` : '\nNo files changed.';
    let summary = String(r.summary || '').trim() || '(no summary)';
    if (summary.length > SUMMARY_CAP) summary = summary.slice(0, SUMMARY_CAP) + '…';
    return `${head}\nStatus: ${status}${files}\n${summary}`;
  });
  const ok = results.filter((r) => r.status === 'done').length;
  return `${ok} of ${results.length} subtasks finished.\n\n${parts.join('\n\n')}`;
}

const SubagentsExports = { MAX_SUBTASKS, SUBAGENT_INSTRUCTIONS, parseTasks, assignNodes, childPrompt, formatResults };
if (typeof module !== 'undefined' && module.exports) module.exports = SubagentsExports;
if (typeof window !== 'undefined') window.Subagents = SubagentsExports;
