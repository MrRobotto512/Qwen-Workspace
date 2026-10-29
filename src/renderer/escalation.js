'use strict';

// Escalation triggers: pure functions over the conversation history that decide when the
// local model should hand work to the planner. The wiring (settings checks, notices, the
// actual handoff) lives in agent-loop.js; everything here is testable with plain objects.
// All triggers are off by default — with them off, behavior is exactly as before.

// The run_command executions in order: [{ command, failed }]. A declined command (the user
// said no) produces no entry — refusing is not failing. Results that aren't "Exit code: N"
// (empty command, declines) are skipped the same way.
function commandRuns(history) {
  const pending = new Map(); // tool_call id -> command, until its result arrives
  const runs = [];
  for (const m of history || []) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.function?.name !== 'run_command') continue;
        let cmd = '';
        try {
          cmd = String(JSON.parse(tc.function.arguments || '{}').command || '').trim();
        } catch {
          /* unparsable arguments — not a run */
        }
        if (cmd) pending.set(tc.id, cmd);
      }
    } else if (m.role === 'tool' && pending.has(m.tool_call_id)) {
      const exit = /^Exit code: (-?\d+)/.exec(String(m.content || ''));
      if (exit) runs.push({ command: pending.get(m.tool_call_id), failed: Number(exit[1]) !== 0 });
      pending.delete(m.tool_call_id);
    }
  }
  return runs;
}

// How many times the most recent command has failed in a row (0 if it succeeded). Only
// consecutive runs of that same command count — a different command in between resets it,
// because "tried something else" is progress, not a loop.
function commandFailStreak(history) {
  const runs = commandRuns(history);
  const last = runs[runs.length - 1];
  if (!last || !last.failed) return { command: last?.command || '', count: 0 };
  let count = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i].command === last.command && runs[i].failed; i--) count++;
  return { command: last.command, count };
}

// Distinct file names mentioned in a todo list (todo_write's todos array). Only names with
// a known code/config extension count, so versions ("0.9.28") and prose ("Node.js setup"
// counts node.js once, fine) don't inflate the number.
const FILE_EXT = /(?:^|[\s"'`(,:])((?:[\w./\\-]*[/\\])?[\w.-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|json|yml|yaml|toml|ini|cfg|xml|html|css|scss|md|txt|sql|sh|bat|ps1|cmake|gradle|proto|vue|svelte))\b/gi;

function planFiles(todos) {
  const out = new Set();
  for (const t of todos || []) {
    const text = String((t && t.content) ?? t ?? '');
    for (const m of text.matchAll(FILE_EXT)) out.add(m[1].toLowerCase());
  }
  return [...out];
}

const EscalationExports = { commandRuns, commandFailStreak, planFiles };
if (typeof module !== 'undefined' && module.exports) module.exports = EscalationExports;
if (typeof window !== 'undefined') window.Escalation = EscalationExports;
