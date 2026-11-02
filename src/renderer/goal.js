'use strict';

// Goal mode — a port of Hermes Agent's /goal (itself after Codex CLI's): the user gives a
// conversation a standing objective; after every finished turn a judge model checks the
// agent's last reply against it, and if the goal isn't met the task continues automatically
// with the judge's feedback, until the goal is achieved, the user clears it, or the turn
// budget runs out. It targets the failure QWS field reports show most: small models that end
// a task early, declaring victory mid-way. The wiring lives in agent-loop.js; this file is
// pure and require()d by tests.

const GOAL_MAX_TURNS = 8;

// "/goal <text>" sets a goal, "/goal off" (or clear/stop/none) clears it, "/goal" alone shows
// it. Anything else is not a goal command (null).
function parseGoalCommand(text) {
  const m = /^\s*\/goal\b\s*([\s\S]*)$/i.exec(String(text || ''));
  if (!m) return null;
  const arg = m[1].trim();
  if (!arg) return { show: true };
  if (/^(off|clear|stop|none|cancel)$/i.test(arg)) return { clear: true };
  return { set: arg };
}

const JUDGE_SYSTEM = [
  'You judge whether an AI coding agent has achieved a goal. You see the goal, the agent\'s latest reply, and evidence of what it actually did (commands it ran with their exit codes, files it changed).',
  'Judge by the evidence, not by the agent\'s claims: a reply saying "done" while a required file was never written or a required command never succeeded is NOT done.',
  'Answer in exactly this format, nothing else:',
  'DONE: <one sentence on why the goal is met>',
  'or',
  'CONTINUE: <the specific missing piece, as a direct instruction to the agent>'
].join('\n');

function judgeMessages(goal, lastReply, evidence) {
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    {
      role: 'user',
      content: `Goal:\n${String(goal || '').slice(0, 2000)}\n\nThe agent's latest reply:\n${String(lastReply || '(no reply text)').slice(0, 3000)}\n\nEvidence of what the agent did:\n${String(evidence || '(nothing recorded)').slice(0, 4000)}`
    }
  ];
}

// The judge's answer. Tolerant of models that wrap it in prose or markdown, but an answer
// with neither keyword counts as not-done with no reason — the loop then asks the agent to
// keep going generically rather than stopping on an unreadable verdict.
function parseVerdict(text) {
  const t = String(text || '').replace(/[*_`]/g, '');
  const m = /\b(DONE|CONTINUE)\s*[:\-–]\s*([^\n]*)/i.exec(t);
  if (!m) return { done: false, reason: '' };
  return { done: m[1].toUpperCase() === 'DONE', reason: m[2].trim() };
}

// The continuation the agent receives when the judge says the goal isn't met.
function continuePrompt(goal, reason, turn, max) {
  return `<system-reminder>\nThe goal is not achieved yet (goal check ${turn}/${max}).\nGoal: ${goal}\n${reason ? `What is missing: ${reason}\n` : ''}Keep working toward the goal now with real tool calls. Do not claim it is done until the evidence (files written, commands succeeding) shows it.\n</system-reminder>`;
}

const GoalExports = { GOAL_MAX_TURNS, parseGoalCommand, judgeMessages, parseVerdict, continuePrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = GoalExports;
if (typeof window !== 'undefined') window.Goal = GoalExports;
