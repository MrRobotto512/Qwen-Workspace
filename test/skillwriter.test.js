'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SW = require('../src/renderer/skillwriter.js');

const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });

test('shouldPropose: long clean tasks, or shorter rescued ones', () => {
  const base = { agent: true, steps: 8 };
  assert.equal(SW.shouldPropose(base), true);
  assert.equal(SW.shouldPropose({ ...base, steps: 7 }), false);
  assert.equal(SW.shouldPropose({ ...base, steps: 3, rescued: true }), true);
  assert.equal(SW.shouldPropose({ ...base, steps: 2, rescued: true }), false);
  for (const k of ['failed', 'stopped', 'already', 'usedSkill']) assert.equal(SW.shouldPropose({ ...base, [k]: true }), false, k);
  assert.equal(SW.shouldPropose({ ...base, enabled: false }), false);
  assert.equal(SW.shouldPropose({ ...base, agent: false }), false);
});

test('taskStartIndex skips app reminders and honours a tracked index', () => {
  const h = [{ role: 'user', content: 'old task' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'package the app' }, { role: 'user', content: '<system-reminder>\nkeep going\n</system-reminder>' }];
  assert.equal(SW.taskStartIndex(h), 2);
  assert.equal(SW.taskStartIndex(h, 0), 0);
  assert.equal(SW.taskStartIndex(h, 99), 2);
});

test('taskDigest counts this task only and pairs failures with output', () => {
  const h = [
    { role: 'user', content: 'earlier' }, call('a', 'read_file', { path: 'x' }), result('a', 'x'),
    { role: 'user', content: 'build the exe\n\n---\nAttached context:\nhuge' },
    call('b', 'run_command', { command: 'pyinstaller calc.spec' }), result('b', 'Exit code: 1\nTypeError: onefile is not an EXE kwarg'),
    call('c', 'edit_file', { path: 'calc.spec' }), result('c', 'Edited calc.spec'),
    { role: 'user', content: '<system-reminder>\nnudge\n</system-reminder>' },
    call('d', 'run_command', { command: 'pyinstaller calc.spec' }), result('d', 'Exit code: 0\nok'),
    call('e', 'write_file', { path: 'b.txt' }), result('e', 'The user rejected this change. Do not retry it'),
    { role: 'assistant', content: 'Built dist/calc.exe.' }
  ];
  const d = SW.taskDigest(h);
  assert.equal(d.steps, 4);
  assert.equal(d.failed, 2);
  assert.equal(d.request, 'build the exe');
  assert.match(d.text, /1\. run_command\(pyinstaller calc\.spec\) -> FAILED: Exit code: 1 TypeError: onefile/);
  assert.match(d.text, /3\. run_command\(pyinstaller calc\.spec\) -> ok/);
  assert.match(d.text, /final answer:\nBuilt dist\/calc\.exe\./);
  assert.doesNotMatch(d.text, /huge|nudge/);
});

test('parseSkillDraft rebuilds clean front matter, rejects NONE and thin drafts', () => {
  const body = '# Package a PySide6 app\n\n## Steps\n1. pip install pyinstaller\n2. pyinstaller --onefile --windowed main.py\n\n## Pitfalls\n- onefile is a CLI flag, not an EXE() kwarg in the spec.';
  const d = SW.parseSkillDraft(`<think>hmm</think>\n\`\`\`markdown\n---\nname: Package PySide6 EXE!\ndescription: "Build a one-file Windows EXE from a PySide6 app with PyInstaller"\n---\n${body}\n\`\`\``);
  assert.equal(d.name, 'package-pyside6-exe');
  assert.equal(d.description, 'Build a one-file Windows EXE from a PySide6 app with PyInstaller');
  assert.match(d.content, /^---\nname: package-pyside6-exe\ndescription: Build a one-file .*\ncreated_by: qws\n---\n\n# Package a PySide6 app/);
  assert.equal(SW.parseSkillDraft('NONE'), null);
  assert.equal(SW.parseSkillDraft('none.'), null);
  assert.equal(SW.parseSkillDraft(body), null, 'no front matter');
  assert.equal(SW.parseSkillDraft('---\nname: x\ndescription: Build things with care\n---\n' + body), null, 'name too short');
  assert.equal(SW.parseSkillDraft('---\nname: ok-name\ndescription: Build things with care\n---\nshort'), null, 'body too thin');
});

test('similarSkill catches duplicates by name or wording', () => {
  const draft = { name: 'package-pyside6-exe', description: 'Package a PySide6 app as a one-file Windows EXE with PyInstaller' };
  assert.equal(SW.similarSkill(draft, [{ name: 'package-pyside6-exe', description: 'other' }])?.name, 'package-pyside6-exe');
  assert.ok(SW.similarSkill(draft, [{ name: 'pyside6-exe-packaging', description: 'Package PySide6 as one-file Windows EXE via PyInstaller' }]));
  assert.equal(SW.similarSkill(draft, [{ name: 'android-apk', description: 'Build an Android APK with Gradle and sign it' }]), null);
});

test('uniqueName suffixes taken names', () => {
  assert.equal(SW.uniqueName('calc', ['other']), 'calc');
  assert.equal(SW.uniqueName('calc', ['calc', 'Calc-2']), 'calc-3');
});

test('curatorPlan: only QWS-written skills, stale at 30 days, archived at 60, a use revives', () => {
  const now = Date.UTC(2026, 10, 2);
  const days = (n) => now - n * 86400000;
  const plan = SW.curatorPlan({
    fresh: { createdBy: 'qws', createdAt: days(40), lastUsed: days(5), state: 'active' },
    old: { createdBy: 'qws', createdAt: days(35), state: 'active' },
    alreadyStale: { createdBy: 'qws', createdAt: days(45), state: 'stale' },
    ancient: { createdBy: 'qws', createdAt: days(90), lastUsed: days(61), state: 'stale' },
    archived: { createdBy: 'qws', createdAt: days(200), state: 'archived' },
    pinned: { createdBy: 'qws', createdAt: days(200), pinned: true },
    installed: { createdBy: 'user', createdAt: days(200) }
  }, now);
  assert.deepEqual(plan, { stale: ['old'], archive: ['ancient'] });
  const used = SW.recordUse({ createdBy: 'qws', uses: 2, state: 'stale' }, now);
  assert.deepEqual(used, { createdBy: 'qws', uses: 3, lastUsed: now, state: 'active' });
});
