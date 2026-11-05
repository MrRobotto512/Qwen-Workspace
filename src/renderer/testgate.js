'use strict';

// Test before done (a benchmark run with no planner: qwen3:8b passed 5 of 8 and every failure
// had the same shape — it wrote wc.js and stopped without running it (an off-by-one any run
// would have shown), edited stats.js and stopped (one bug still there), wrote runner.html and
// stopped (a blank page with no self-test)). When the model is about to finish and code it
// changed has not been run since, it is asked — once or twice per task — to test it, with the
// test that fits the file. Any real command or test_app after the last change counts.
// Pure: no DOM.

(() => {
const CODE = /\.(html?|m?jsx?|cjs|tsx?|py|pyw|sh|bash|ps1|bat|cmd|rb|go|rs|java|kt|c|cc|cpp|cs|php|lua|swift|dart|gd)$/i;
const isCode = (path) => CODE.test(String(path || ''));

// What kind of thing a changed file is, from its name and content:
// 'page' | 'cli' | 'module' | 'script'.
function kindOf(path, content) {
  const p = String(path || '');
  const t = String(content || '');
  if (/\.html?$/i.test(p)) return 'page';
  if (/\.py[w]?$/i.test(p)) {
    if (/sys\.argv|argparse|input\(|__name__\s*==\s*['"]__main__['"]/.test(t)) return 'cli';
    if (/^\s*(def|class)\s/m.test(t)) return 'module';
    return 'script';
  }
  if (/\.(m?js|cjs|jsx?|tsx?)$/i.test(p)) {
    if (/process\.argv|readline|process\.stdin/.test(t)) return 'cli';
    if (/module\.exports|^\s*export\s/m.test(t)) return 'module';
    return 'script';
  }
  return 'script';
}

const base = (p) => String(p).split('/').pop();
const stem = (p) => base(p).replace(/\.[^.]+$/, '');

// The test that fits one file, in a few words with an example command.
function suggestion(path, kind, platform) {
  const py = platform === 'win32' ? 'python' : 'python3';
  const p = String(path);
  const isPy = /\.pyw?$/i.test(p);
  if (kind === 'page') return `${p}: call test_app with "${p}" (it loads the page, reports console errors and a screenshot, and runs a game's window.selfTest())`;
  if (kind === 'cli') return `${p}: run it on a small example with run_command (e.g. ${isPy ? `${py} ${p}` : `node ${p}`} <example input>) — work out the right answer for that example yourself first, then compare it with the output. Make the example exercise the details the request spells out (an edge case it names, such as empty input, a zero, or a file whose last character is a line break)`;
  if (kind === 'module') {
    return isPy
      ? `${p}: import it and call what you changed on a small example with run_command (e.g. ${py} -c "import ${stem(p)}; print(${stem(p)}.<function>(<example>))"), and compare with the answer you expect`
      : `${p}: load it and call what you changed on a small example with run_command (e.g. node -e "const m = require('./${p}'); console.log(m.<function>(<example>))"), and compare with the answer you expect`;
  }
  if (isPy) return `${p}: run it with run_command (${py} ${p}) and read the output`;
  if (/\.(m?js|cjs)$/i.test(p)) return `${p}: run it with run_command (node ${p}) and read the output`;
  return `${p}: run it the way the user will, with run_command, and read the output`;
}

// The reminder for files changed since the last test: [{ path, kind }].
function nudgeText(files, platform) {
  const list = files.slice(0, 4);
  const more = files.length > list.length ? ` (and ${files.length - list.length} more)` : '';
  return `You changed ${list.map((f) => base(f.path)).join(', ')}${more} but have not run ${files.length === 1 ? 'it' : 'them'} since, so nothing shows the change works. Test before you finish:\n${list.map((f) => `- ${suggestion(f.path, f.kind, platform)}`).join('\n')}\nIf the test shows a problem, fix it and test again. Then reply with what you checked and what it showed.`;
}

// The user asked for code without running it ("don't run it", "just write it").
const NO_TEST = /\b(?:do not|don't|dont|never|no need to)\s+(?:\w+\s+){0,2}(?:run|test|execute)|\bwithout\s+(?:running|testing|executing)\b|\bjust\s+(?:write|create)\s+(?:the\s+)?(?:file|code)\b/i;
const userSaidNoTest = (words) => (words || []).some((w) => NO_TEST.test(String(w)));

// ---------- the last test failed, or a file is still broken (v0.58) ----------
// From a no-planner benchmark run after v0.57: the runner game was tested — test_app said "the
// self-test returned no steps" — and qwen3:8b finished anyway, because a failing test cleared
// the gate like a passing one; and a JSON file left with a syntax error at line 7 ended the task
// because JSON is not "code". A finish now also needs the last test of the changed code to pass
// and every changed file to pass its syntax check.

// Commands that test something: a test runner, or a command naming a changed file. A failing
// `pip install` or `where python` after an edit is not a failed test of that edit.
const TEST_RUNNER = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bpython[\d.]*\s+-m\s+(?:unittest|pytest)\b|\bpy\s+(?:-3\s+)?-m\s+(?:unittest|pytest)\b|\bnode\s+--test\b|\b(?:jest|vitest|mocha)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\b(?:mvn|gradle\w*)\s+test\b|\bctest\b|\bmake\s+(?:test|check)\b/i;
function isTestOf(command, files) {
  const c = String(command || '');
  if (TEST_RUNNER.test(c)) return true;
  return (files || []).some((f) => {
    const b = base(f);
    const s = stem(f);
    return c.includes(b) || (s.length >= 3 && new RegExp(`(^|[^\\w])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(c));
  });
}

// What a failed test said, in a line or two: its errors, not the boilerplate around them.
const BOILER = /cannot see this screenshot|screenshot was taken|Pixel check|What the screenshot shows|Matches the request|^Page ".*" loaded/i;
function failureSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !BOILER.test(l));
  const bad = lines.filter((l) => /\b(fail(?:ed|s|ure)?|error|exception|blank|not done|missing|crash(?:ed)?|traceback|not loaded|did not load|no window|returned no steps|expected)\b|^Exit code: [1-9-]|^✗/i.test(l));
  const pick = (bad.length ? bad : lines).slice(0, 2).join(' · ');
  return pick.length > 240 ? `${pick.slice(0, 237)}…` : pick;
}

function failedTestText(fail) {
  return `Your last test failed — ${fail.tool === 'test_app' ? `test_app ${fail.target}` : `\`${String(fail.target).slice(0, 120)}\``}: ${String(fail.summary || 'it reported a failure').replace(/[.\s]+$/, '')}. The task is not done while it fails. Fix the cause and run the same test again. If it truly cannot be fixed, say plainly in your reply what still fails — do not report it as working.`;
}

function brokenText(list) {
  const items = list.slice(0, 3).map((b) => `- ${b.path}${b.line ? ` line ${b.line}` : ''}: ${b.message}${b.text ? ` (line ${b.line} is: ${String(b.text).slice(0, 120)})` : ''}`);
  return `${list.length === 1 ? `${list[0].path} still has` : 'These files still have'} a syntax error, so ${list.length === 1 ? 'it' : 'they'} cannot be used as ${list.length === 1 ? 'it is' : 'they are'}:\n${items.join('\n')}\nFix ${list.length === 1 ? 'it' : 'them'} before you finish (a small file is easiest to rewrite whole with write_file, correct from top to bottom).`;
}

const TestGateExports = { isCode, kindOf, suggestion, nudgeText, userSaidNoTest, isTestOf, failureSummary, failedTestText, brokenText, TEST_RUNNER };
if (typeof module !== 'undefined' && module.exports) module.exports = TestGateExports;
if (typeof window !== 'undefined') window.TestGate = TestGateExports;
})();
