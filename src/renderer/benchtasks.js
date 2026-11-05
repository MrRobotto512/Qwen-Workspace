'use strict';

// The benchmark's tasks: real requests of the kinds QWS gets, each scored by checks the agent
// never sees — hidden test files are written into the project only after the agent finishes,
// and page checks click and read the page in a hidden window. A task that needs a tool this PC
// lacks (node, python) is skipped, not failed. Pure data plus small helpers: no DOM.

(() => {
const py = (platform) => (platform === 'win32' ? 'python' : 'python3');

const TASKS = [
  {
    id: 'web-counter',
    title: 'Counter page',
    quick: true,
    minutes: 6,
    prompt: 'Make counter.html: a page that shows a number starting at 0 in an element with id "count", a "+" button with id "plus" that adds one and a "−" button with id "minus" that subtracts one.',
    checks: [{ type: 'page', file: 'counter.html', probe: "(() => { const p = document.getElementById('plus'), m = document.getElementById('minus'), n = document.getElementById('count'); if (!p || !m || !n) return 'missing #plus, #minus or #count'; p.click(); p.click(); m.click(); return n.textContent.trim() === '1' || ('after +, +, − the count shows ' + JSON.stringify(n.textContent.trim())); })()" }]
  },
  {
    id: 'fix-oneline-html',
    title: 'Fix a one-line page',
    quick: true,
    minutes: 6,
    // The field report that looped ten times on edit_file: a minified one-line HTML file.
    seed: { 'index.html': '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Hello</title><style>body{margin:0;font-family:sans-serif}</style></head><body></body></html>' },
    prompt: 'index.html shows nothing. Change index.html so the page shows "Hello, world!" inside a <p id="out"> element, written there by a script.',
    checks: [{ type: 'page', file: 'index.html', probe: "(() => { const o = document.getElementById('out'); return (!!o && o.textContent.includes('Hello, world!')) || ('#out is ' + (o ? JSON.stringify(o.textContent) : 'missing')); })()" }]
  },
  {
    id: 'js-bugfix',
    title: 'Fix two bugs in a JS module',
    quick: true,
    minutes: 8,
    needs: 'node',
    seed: {
      'stats.js': "function mean(xs) {\n  let sum = 0;\n  for (const x of xs) sum += x;\n  return sum / xs.length;\n}\n\nfunction median(xs) {\n  const s = xs.slice().sort();\n  return s[Math.floor(s.length / 2)];\n}\n\nmodule.exports = { mean, median };\n"
    },
    prompt: 'stats.js has two bugs. median() gives wrong answers for lists with an even number of items (it should return the average of the two middle numbers after sorting numerically), and mean([]) returns NaN (it should return 0). Fix both, keeping the exports.',
    hidden: {
      '_bench_check.js': "const assert = require('assert');\nconst { mean, median } = require('./stats.js');\nassert.strictEqual(mean([]), 0);\nassert.strictEqual(mean([1, 2, 3, 4]), 2.5);\nassert.strictEqual(median([3, 1, 2]), 2);\nassert.strictEqual(median([4, 1, 3, 2]), 2.5);\nassert.strictEqual(median([10, 9, 100, 1]), 9.5);\nconsole.log('ok');\n"
    },
    checks: [{ type: 'command', command: 'node _bench_check.js' }]
  },
  {
    id: 'todo-page',
    title: 'To-do list page',
    minutes: 10,
    prompt: 'Make todo.html: a text input with id "new", an "Add" button with id "add" and a list with id "list". Clicking Add puts the input\'s text into the list as an <li>; every <li> has its own delete button that removes it. Keep the items in localStorage so they survive a reload.',
    checks: [{ type: 'page', file: 'todo.html', probe: "(() => { const i = document.getElementById('new'), a = document.getElementById('add'), l = document.getElementById('list'); if (!i || !a || !l) return 'missing #new, #add or #list'; i.value = 'milk'; i.dispatchEvent(new Event('input', { bubbles: true })); a.click(); const li = l.querySelectorAll('li'); if (li.length !== 1 || !li[0].textContent.includes('milk')) return 'after adding \"milk\" the list has ' + li.length + ' items'; const del = li[0].querySelector('button'); if (!del) return 'the item has no delete button'; del.click(); return l.querySelectorAll('li').length === 0 || 'delete left the item in the list'; })()" }]
  },
  {
    id: 'py-calc',
    title: 'Python module from scratch',
    minutes: 8,
    needs: 'python',
    prompt: 'Create calc.py with functions add(a, b), sub(a, b), mul(a, b) and div(a, b). div must raise ZeroDivisionError when b is 0.',
    hidden: {
      '_bench_test_calc.py': "import unittest\nimport calc\n\nclass T(unittest.TestCase):\n    def test_ops(self):\n        self.assertEqual(calc.add(2, 3), 5)\n        self.assertEqual(calc.sub(2, 3), -1)\n        self.assertEqual(calc.mul(4, 3), 12)\n        self.assertEqual(calc.div(9, 3), 3)\n\n    def test_zero(self):\n        with self.assertRaises(ZeroDivisionError):\n            calc.div(1, 0)\n\nif __name__ == '__main__':\n    unittest.main()\n"
    },
    checks: [{ type: 'command', command: (platform) => `${py(platform)} -m unittest _bench_test_calc` }]
  },
  {
    id: 'json-fix',
    title: 'Repair a broken JSON file',
    minutes: 6,
    needs: 'node',
    seed: { 'config.json': "{\n  'name': \"shop\",\n  \"port\": 8080\n  \"debug\": true,\n  \"origins\": [\"a.example\", \"b.example\",],\n}\n" },
    prompt: 'config.json has syntax errors, so the app cannot read it. Fix the JSON without changing, adding or removing any value.',
    hidden: { '_bench_json.js': "const assert = require('assert');\nconst c = JSON.parse(require('fs').readFileSync('config.json', 'utf8'));\nassert.deepStrictEqual(c, { name: 'shop', port: 8080, debug: true, origins: ['a.example', 'b.example'] });\nconsole.log('ok');\n" },
    checks: [{ type: 'command', command: 'node _bench_json.js' }]
  },
  {
    id: 'wordcount-cli',
    title: 'Command-line tool',
    minutes: 8,
    needs: 'node',
    prompt: 'Create wc.js, run as `node wc.js <file>`: it prints the number of lines, words and characters in the file, separated by single spaces (for example "2 5 31"). Lines are the lines of text, words are runs of non-whitespace, characters are all characters including line breaks. A line break ends a line, so a file whose last character is a line break has no extra empty line after it (the counts the Unix `wc` command gives).',
    hidden: {
      'sample.txt': 'one two\nthree four five\nsix seven\n',
      '_bench_wc.js': "let out;\ntry {\n  out = require('child_process').execFileSync(process.execPath, ['wc.js', 'sample.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();\n} catch (e) {\n  console.error('wc.js crashed:\\n' + String(e.stderr || e.message));\n  process.exit(1);\n}\nif (out !== '3 7 34') { console.error('expected \"3 7 34\", got ' + JSON.stringify(out)); process.exit(1); }\nconsole.log('ok');\n"
    },
    checks: [{ type: 'command', command: 'node _bench_wc.js' }]
  },
  {
    id: 'runner-game',
    title: '3-lane runner game',
    minutes: 25,
    prompt: 'make runner.html: a small 3D endless runner with Three.js loaded from a CDN. Three lanes; the player switches lanes with the left/right arrow keys and jumps with space; obstacles come toward the player and end the game on contact; the score goes up over time. Include a window.selfTest() that plays it with scripted input and reports move, act and hud steps.',
    checks: [{ type: 'page', file: 'runner.html', selfTest: true, notBlank: true }]
  }
];

// The line of a failed check's output that says what went wrong: the error itself (a crash
// prints it above ten lines of Node's own stack trace, which the table showed instead — a field
// report's "at wrapModuleLoad (node:internal/modules/cjs/loader…)"), an assertion, or the
// check's own "expected … got …"; else the last lines.
function failureLine(output, max = 300) {
  const lines = String(output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !/^at\s|^node:internal|^Node\.js v\d|^\^+$|^throw err;?$|^Command failed:/.test(l));
  const err = useful.find((l) => /^(?:[A-Z]\w*)?(?:Error|Exception)\b|^expected\b|^AssertionError|^FAIL|^E\s{2,}/.test(l)) || useful.find((l) => /\bError:/.test(l));
  if (err) {
    // A crash's location ("wc.js:3") sits a few lines above its message.
    const i = useful.indexOf(err);
    const where = useful.slice(Math.max(0, i - 3), i).reverse().find((l) => /^\S+\.(?:m?js|cjs|py):\d+$/.test(l) || /^File ".+", line \d+/.test(l));
    const file = where ? (/([^\\/]+\.(?:m?js|cjs|py)):(\d+)$/.exec(where) || /File ".*?([^\\/"]+)", line (\d+)/.exec(where)) : null;
    return `${err}${file ? ` (${file[1]}:${file[2]})` : ''}`.slice(0, max);
  }
  return useful.slice(-3).join(' · ').slice(-max);
}

function tasksFor(set) {
  return set === 'quick' ? TASKS.filter((t) => t.quick) : TASKS.slice();
}

// A run's summary line: "5/7 passed (1 skipped) in 42 min".
function summary(results) {
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.passed).length;
  const skipped = results.length - ran.length;
  const minutes = Math.round(ran.reduce((a, r) => a + (r.minutes || 0), 0));
  return `${passed}/${ran.length} passed${skipped ? ` (${skipped} skipped)` : ''} in ${minutes} min`;
}

// What changed since the previous run, per task: 'fixed', 'broke' or ''.
function compare(results, previous) {
  const before = new Map((previous?.results || []).map((r) => [r.id, r]));
  return results.map((r) => {
    const b = before.get(r.id);
    if (!b || b.skipped || r.skipped) return '';
    if (r.passed && !b.passed) return 'fixed';
    if (!r.passed && b.passed) return 'broke';
    return '';
  });
}

const BenchTasksExports = { TASKS, tasksFor, summary, compare, failureLine };
if (typeof module !== 'undefined' && module.exports) module.exports = BenchTasksExports;
if (typeof window !== 'undefined') window.BenchTasks = BenchTasksExports;
})();
