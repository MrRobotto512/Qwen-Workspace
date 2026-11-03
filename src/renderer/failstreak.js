'use strict';

// "When something breaks: stop, analyze, think, plan, execute" (from fpapleux/sdd-skill). Small
// models answer a failing command by stacking guesses: tweak, rerun, tweak, rerun. QWS counts
// failures per command within a task — the same command failing the same way: the first asks
// the model to name the root cause before fixing; after two fixes have failed it must stop and
// report (or ask the planner once, when "Agent consults freely" is on); a command that keeps
// failing after that is not run again in this task. A success clears its count. Pure logic.

// Same command = same problem: case, spacing and a trailing `2>&1` do not matter.
function signature(kind, command) {
  return `${kind}:${String(command || '').trim().replace(/\s+2>&1\s*$/, '').replace(/\s+/g, ' ').toLowerCase()}`;
}

// A non-zero exit that is an answer, not a failure: a search with no hits, a test for a file.
const PROBE = /^(grep|egrep|rg|findstr|test|\[|diff|cmp|where|which|command -v|type|git diff\b.*--exit-code|git grep)\b/i;
function isProbe(command, output) {
  return PROBE.test(String(command || '').trim()) || !String(output || '').trim();
}

const ANALYZE = 'Before you change anything: read the whole error above, name its root cause in one sentence (the test, the code, the request/spec, or the environment), then make the one smallest fix for that cause and rerun. Do not stack guesses.';

// What the failure says, ignoring numbers, timings and addresses: a fix that turns one error into
// another is a new problem (progress, often: one failing test fewer), not the same one again.
const ERROR_LINE = /(error|exception|traceback|failed|failure|not ok|✖|✕|assert|cannot|could not|not found|undefined|refused|denied|missing)/i;
function fingerprint(output) {
  const lines = String(output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const norm = (l) => l.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 200);
  const picked = lines.filter((l) => ERROR_LINE.test(l)).slice(0, 12);
  return [...new Set((picked.length ? picked : lines.slice(-3)).map(norm))].sort().join('\n');
}

// Record one run → { level, fails, note }. level: ok | analyze | last | consult | stop.
// `canConsult`: the planner is on call (consult freely). `consulted`: the agent asked it during
// this streak.
function record(streaks, sig, ok, output, { canConsult = false, consulted = false } = {}) {
  if (ok) {
    streaks.delete(sig);
    return { level: 'ok', fails: 0, note: '' };
  }
  const fp = fingerprint(output);
  const prev = streaks.get(sig);
  const fails = prev && prev.fp === fp ? prev.fails + 1 : 1;
  streaks.set(sig, { fails, fp });
  if (fails === 1) return { level: 'analyze', fails, note: ANALYZE };
  if (fails === 2) return { level: 'last', fails, note: `This command has now failed the same way twice. ${ANALYZE} If this next fix does not work either, stop: you will report instead of trying a third.` };
  if (fails === 3 && canConsult && !consulted) {
    return { level: 'consult', fails, note: 'Two fixes for this failure have not worked. Do not try a third on your own: call consult_planner now with the exact error, the root cause you suspect, and the two fixes you tried. Make the one fix it advises; if that fails too, stop and report to the user.' };
  }
  return {
    level: 'stop',
    fails,
    note: 'Two fixes for this failure have not worked. Stop now: do not try another fix. Reply to the user with (1) what fails — the exact error, (2) the root cause you suspect, (3) the fixes you tried, (4) what you would try next or what you need from them. Then end your turn.'
  };
}

// Whether to refuse running this command again: it reached the stop step. After the consult
// step, one more run is allowed if the agent did ask the planner (to try its advice).
function blocked(streaks, sig, { canConsult = false, consulted = false } = {}) {
  const fails = streaks.get(sig)?.fails || 0;
  return fails >= 3 && !(fails === 3 && canConsult && consulted);
}

const REFUSAL = 'Not run: this command has failed after two planned fixes, so the stop rule applies. Do not run it again in this task. Report to the user now: the exact error, the root cause you suspect, the fixes you tried, and what you need from them.';

const SYSTEM_LINE = '- When something fails (a command error, a test that does not pass): stop, read the whole error, name the root cause (the test, the code, the request, or the environment), plan the smallest fix, then make that one fix and rerun. After two failed fixes for the same problem, stop and report to the user instead of trying a third.';

const FailStreakExports = { signature, isProbe, fingerprint, record, blocked, REFUSAL, SYSTEM_LINE, ANALYZE };
if (typeof module !== 'undefined' && module.exports) module.exports = FailStreakExports;
if (typeof window !== 'undefined') window.FailStreak = FailStreakExports;
