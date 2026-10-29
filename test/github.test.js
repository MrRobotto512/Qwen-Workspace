const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/renderer/github.js');

test('slug flattens a task title into a branch-safe name', () => {
  assert.strictEqual(G.slug('Fix the login crash!'), 'fix-the-login-crash');
  assert.strictEqual(G.slug("Add PS2 'Local Library' support — v2"), 'add-ps2-local-library-suppor');
  assert.strictEqual(G.slug('   '), 'task');
  assert.strictEqual(G.slug('???!!!'), 'task');
  assert.ok(G.slug('a'.repeat(100)).length <= 28);
});

test('taskBranchName avoids existing branches with a numeric suffix', () => {
  assert.strictEqual(G.taskBranchName('Fix login', []), 'qwen/fix-login');
  assert.strictEqual(G.taskBranchName('Fix login', ['qwen/fix-login']), 'qwen/fix-login-2');
  assert.strictEqual(G.taskBranchName('Fix login', ['* qwen/fix-login', '  qwen/fix-login-2']), 'qwen/fix-login-3');
});

test('parseStatusBranch reads ahead/behind/gone from git status -sb', () => {
  assert.deepStrictEqual(G.parseStatusBranch('## main...origin/main [ahead 1, behind 3]\n M a.js'), {
    branch: 'main', upstream: 'origin/main', ahead: 1, behind: 3, gone: false
  });
  assert.deepStrictEqual(G.parseStatusBranch('## main...origin/main [behind 2]'), {
    branch: 'main', upstream: 'origin/main', ahead: 0, behind: 2, gone: false
  });
  assert.deepStrictEqual(G.parseStatusBranch('## feature/x'), {
    branch: 'feature/x', upstream: '', ahead: 0, behind: 0, gone: false
  });
  assert.strictEqual(G.parseStatusBranch('## qwen/task...origin/qwen/task [gone]').gone, true);
  assert.strictEqual(G.parseStatusBranch('## HEAD (no branch)').branch, '');
  assert.strictEqual(G.parseStatusBranch('').branch, '');
  assert.strictEqual(G.parseStatusBranch('fatal: not a git repository').branch, '');
});

test('syncLabel formats the arrows and stays empty when in sync', () => {
  assert.strictEqual(G.syncLabel({ ahead: 1, behind: 3 }), '↓3 ↑1');
  assert.strictEqual(G.syncLabel({ ahead: 2, behind: 0 }), '↑2');
  assert.strictEqual(G.syncLabel({ ahead: 0, behind: 0 }), '');
  assert.strictEqual(G.syncLabel(), '');
});

test('versionFrom prefers package.json and falls back to TOML files', () => {
  assert.strictEqual(G.versionFrom({ packageJson: '{"name":"x","version":"0.12.0"}' }), '0.12.0');
  assert.strictEqual(G.versionFrom({ packageJson: '{broken', pyproject: '[project]\nname = "x"\nversion = "1.2.3"\n' }), '1.2.3');
  assert.strictEqual(G.versionFrom({ cargoToml: '[package]\nversion = "0.3.1"' }), '0.3.1');
  assert.strictEqual(G.versionFrom({}), '');
});

test('bulletsFromLog strips hashes and merge commits', () => {
  const log = 'ac18c80 Add escalation triggers\n3035688 Add Ollama nodes\n73c574b Merge pull request #3 from x/y\n';
  assert.strictEqual(G.bulletsFromLog(log), '- Add escalation triggers\n- Add Ollama nodes');
  assert.strictEqual(G.bulletsFromLog(''), '');
});

test('shellSafe neutralizes quoting and expansion characters', () => {
  assert.strictEqual(G.shellSafe('fix: handle "quotes" & $HOME `rm` %PATH%'), "fix: handle 'quotes' ' 'HOME 'rm' 'PATH'");
  assert.ok(!/[\r\n]/.test(G.shellSafe('a\nb\r\nc')));
});

test('repoNameFrom produces a valid GitHub name', () => {
  assert.strictEqual(G.repoNameFrom('My Cool App!'), 'My-Cool-App');
  assert.strictEqual(G.repoNameFrom('..weird..'), 'weird');
  assert.strictEqual(G.repoNameFrom(''), 'my-project');
});
