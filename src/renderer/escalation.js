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

// Plan-first mode: the instruction the high-performance node gets for the one planning turn
// that opens a task. It must produce a plan a smaller model can follow mechanically — files
// and commands by name, simplest stack, recorded as todos — and must not start executing.
const PLAN_FIRST_REMINDER = [
  'You are the planning model for this task (a stronger model than the one that will do the work). Write a concrete plan that a smaller model will execute mechanically:',
  '- Make every decision NOW and bake it into the plan. A step may never say "choose", "decide" or "pick an approach" — the small model cannot make that call. If one crucial decision genuinely needs the user, ask with ask_user in this turn instead of planning.',
  '- Every step must name the exact file to create or change, or the exact command to run. A step with neither is not a step.',
  '- Command-line stacks only: the plan builds and runs everything with commands the small model can execute. Never plan around a GUI IDE (Xcode, Visual Studio, Android Studio) or an app store — if a toolchain is needed, the plan installs it with a command or install_app.',
  '- Prefer the simplest stack that satisfies the request, and avoid installing anything that is not strictly needed. Assume only standard OS tooling is present; make the first step verify the chosen toolchain with a version command.',
  '- Record the plan as one todo_write call with 3-8 steps. The todo list is the deliverable of this turn.',
  'Do not execute any step yourself — the everyday model takes over after this turn.'
].join('\n');

// The planning turn only gets planning tools: the plan (todo_write) and, when a decision is
// genuinely needed, the user (ask_user). Everything else would tempt it to start executing.
const PLANNING_TOOLS = new Set(['todo_write', 'ask_user']);
function planningTools(tools) {
  return (tools || []).filter((t) => PLANNING_TOOLS.has(t?.function?.name));
}

// A plan step is concrete when it names a file (known extension), carries a `backticked`
// token, or mentions a recognizable command — mechanical, so the app can bounce a vague plan
// back to the planning model once instead of handing the small model mush like "Create
// project directory and initial files" (a field report's 30B plan, written despite explicit
// instructions; prompts alone don't make a 30B obey).
const PLAN_COMMAND_RE = /\b(swift|swiftc|npm|npx|yarn|pnpm|pip3?|python3?|cargo|rustc|go|git|mkdir|touch|brew|winget|apt(-get)?|dotnet|node|deno|bun|make|cmake|gcc|clang|javac|gradle|mvn|curl|wget|tsc|install_app|xcode-select|electron|pyinstaller|pytest|unzip|tar)\b/i;

function vaguePlanSteps(todos) {
  const out = [];
  (todos || []).forEach((t, i) => {
    const text = String((t && t.content) ?? t ?? '');
    FILE_EXT.lastIndex = 0; // shared global regex: reset between tests
    const concrete = FILE_EXT.test(text) || /`[^`]+`/.test(text) || PLAN_COMMAND_RE.test(text);
    if (!concrete) out.push(i + 1);
  });
  return out;
}

// The one corrective re-ask a vague plan gets before the handoff proceeds anyway.
function planRetryReminder(vagueSteps) {
  return `Your plan is not executable by a smaller model: step${vagueSteps.length === 1 ? '' : 's'} ${vagueSteps.join(', ')} name${vagueSteps.length === 1 ? 's' : ''} no file and no command. Rewrite the COMPLETE todo list now in one todo_write call; every step must contain an exact file path (with extension) or an exact command.`;
}

// A planning turn may only plan. A field report's ⚡ node answered the rewrite request with
// run_command (not even offered on that turn); the call ran, no new plan came, and the vague
// plan went down to the small model anyway. Calls outside the planning tools are refused now.
const isPlanningTool = (name) => PLANNING_TOOLS.has(name);
const PLAN_ONLY_REFUSAL = 'Error: not now — this is the planning turn. Do not run or change anything yet; the everyday model executes after you. Reply with ONE todo_write call holding the complete plan.';
function planMissingReminder() {
  return 'You did not write a plan. Do not execute any step yourself. Reply now with ONE todo_write call holding the complete todo list (3-8 steps); every step must contain an exact file path (with extension) or an exact command.';
}

const EscalationExports = { commandRuns, commandFailStreak, planFiles, PLAN_FIRST_REMINDER, planningTools, isPlanningTool, PLAN_ONLY_REFUSAL, vaguePlanSteps, planRetryReminder, planMissingReminder };
if (typeof module !== 'undefined' && module.exports) module.exports = EscalationExports;
if (typeof window !== 'undefined') window.Escalation = EscalationExports;
