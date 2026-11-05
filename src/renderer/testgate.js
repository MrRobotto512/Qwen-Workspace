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

const TestGateExports = { isCode, kindOf, suggestion, nudgeText, userSaidNoTest };
if (typeof module !== 'undefined' && module.exports) module.exports = TestGateExports;
if (typeof window !== 'undefined') window.TestGate = TestGateExports;
})();
