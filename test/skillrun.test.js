'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/renderer/skillrun.js');
const P = require('../src/pyshim.js');

test('parseSkillCommand matches installed skills only, never QWS commands', () => {
  const skills = [{ name: 'sdd', id: 'project:sdd' }, { name: 'checks', id: 'x' }];
  assert.deepEqual(R.parseSkillCommand('/sdd quick "Add a total command"', skills), { skill: skills[0], args: 'quick "Add a total command"' });
  assert.deepEqual(R.parseSkillCommand('/SDD', skills), { skill: skills[0], args: '' });
  assert.equal(R.parseSkillCommand('/checks run', skills), null);
  assert.equal(R.parseSkillCommand('/nope x', skills), null);
  assert.equal(R.parseSkillCommand('use /sdd', skills), null);
});

test('the skill folder replaces its placeholders and is stated', () => {
  const body = 'SDD means `python3 <skill folder>/scripts/sdd.py`. Also {baseDir}/x and ${CLAUDE_SKILL_DIR}/y.';
  const out = R.skillBlock('sdd', body, '.qwen/skills/sdd');
  assert.match(out, /^<skill name="sdd" folder=".qwen\/skills\/sdd">/);
  assert.match(out, /python3 \.qwen\/skills\/sdd\/scripts\/sdd\.py/);
  assert.match(out, /\.qwen\/skills\/sdd\/x and \.qwen\/skills\/sdd\/y/);
  const p = R.invocationPrompt('/sdd status', { name: 'sdd' }, 'status', body, '.qwen/skills/sdd', ['method/overview.md']);
  assert.match(p, /^\/sdd status\n\n<system-reminder>\nThe user invoked the "sdd" skill with: status/);
  assert.match(p, /This skill's folder is \.qwen\/skills\/sdd/);
  assert.match(p, /Supporting files \(load one with load_skill and file\): method\/overview\.md\n<\/system-reminder>$/);
});

test('python3 on Windows: rewritten only where python3 is not real', () => {
  assert.deepEqual(P.rewritePython3('python3 .qwen/skills/sdd/scripts/sdd.py status', 'py -3'), { command: 'py -3 .qwen/skills/sdd/scripts/sdd.py status', changed: true });
  assert.equal(P.rewritePython3('cd x && python3 -m pytest -q && pip3 install y', 'python').command, 'cd x && python -m pytest -q && python -m pip install y');
  assert.equal(P.rewritePython3('mypython3 x && C:\\python3\\x.exe', 'py -3').changed, false);
  assert.equal(P.rewritePython3('python3 x', null).changed, false);
  const stub = 'C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe\r\n';
  assert.equal(P.choosePython({ venv: null, wherePython3: 'C:\\Python312\\python3.exe', wherePy: 'C:\\Windows\\py.exe', wherePython: '' }), null);
  assert.equal(P.choosePython({ venv: 'D:\\My Game\\.venv\\Scripts\\python.exe', wherePython3: stub, wherePy: '', wherePython: '' }), '"D:\\My Game\\.venv\\Scripts\\python.exe"');
  assert.equal(P.choosePython({ venv: null, wherePython3: stub, wherePy: 'C:\\Windows\\py.exe', wherePython: stub }), 'py -3');
  assert.equal(P.choosePython({ venv: null, wherePython3: '', wherePy: '', wherePython: 'C:\\Python312\\python.exe' }), 'python');
  assert.equal(P.choosePython({ venv: null, wherePython3: '', wherePy: '', wherePython: stub }), null);
});
