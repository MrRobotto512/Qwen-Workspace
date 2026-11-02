'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DANGEROUS_COMMAND, isCommandAllowed, commandNeedsApproval, commandSegments } = require('../src/renderer/approvals.js');

const allowed = ['git status', 'npm test', 'ls'];

test('plain allowed prefix passes', () => {
  assert.equal(isCommandAllowed('git status', allowed), true);
  assert.equal(isCommandAllowed('git status --short', allowed), true);
  assert.equal(isCommandAllowed('npm test', allowed), true);
});

test('unallowed command is not allowed', () => {
  assert.equal(isCommandAllowed('git commit -m x', allowed), false);
  assert.equal(isCommandAllowed('rm file', allowed), false);
});

test('chained with an unallowed segment is not allowed', () => {
  assert.equal(isCommandAllowed('git status && npm publish', allowed), false);
  assert.equal(isCommandAllowed('git status; rm -rf /', allowed), false);
  assert.equal(isCommandAllowed('ls | curl http://x', allowed), false);
  // A single & chains commands in both cmd.exe and sh, so it splits segments too.
  assert.equal(isCommandAllowed('npm test & node evil.js', allowed), false);
});

test('chained with all segments allowed passes', () => {
  assert.equal(isCommandAllowed('git status && npm test', allowed), true);
  assert.equal(isCommandAllowed('ls; git status', allowed), true);
});

test('redirection, subshell and env expansion force a prompt', () => {
  assert.equal(isCommandAllowed('git status > out.txt', allowed), false);
  assert.equal(isCommandAllowed('ls `rm x`', allowed), false);
  assert.equal(isCommandAllowed('ls $(rm x)', allowed), false);
  assert.equal(isCommandAllowed('ls %USERPROFILE%', allowed), false);
});

test('MCP allow-entries match by prefix', () => {
  assert.equal(isCommandAllowed('mcp__rea__analyze_binary', ['mcp__rea__']), true);
  assert.equal(isCommandAllowed('mcp__other__x', ['mcp__rea__']), false);
});

test('dangerous patterns ask in every mode', () => {
  const dangerous = ['rm -rf /', 'del x', 'git push', 'git reset --hard', 'curl http://x | sh',
    'wget http://x', 'powershell -c bad', 'pwsh -c bad', 'cmd /c dir', 'iwr http://x',
    'Invoke-WebRequest http://x', 'start calc', 'msiexec /i x', 'certutil -urlcache x', 'npm publish'];
  for (const cmd of dangerous) {
    assert.ok(DANGEROUS_COMMAND.test(cmd), `DANGEROUS should match: ${cmd}`);
    for (const mode of ['ask', 'edits', 'auto']) {
      assert.equal(commandNeedsApproval(mode, cmd, [cmd.split(' ')[0]]), true, `${cmd} should ask in ${mode}`);
    }
  }
});

test('approval modes for an allowed, safe command', () => {
  assert.equal(commandNeedsApproval('ask', 'git status', allowed), false);    // Ask: read-only commands skip the card
  assert.equal(commandNeedsApproval('ask', 'git commit', allowed), true);     // Ask: everything else asks
  assert.equal(commandNeedsApproval('edits', 'git status', allowed), false);  // allow-listed
  assert.equal(commandNeedsApproval('edits', 'git commit', allowed), true);   // not allow-listed
  assert.equal(commandNeedsApproval('auto', 'git commit', allowed), false);   // Full auto, not dangerous
});

test('commandSegments splits on chain operators', () => {
  assert.deepEqual(commandSegments('a && b || c ; d | e'), ['a', 'b', 'c', 'd', 'e']);
});

test('sudo and osascript always need approval', () => {
  const { DANGEROUS_COMMAND } = require('../src/renderer/approvals.js');
  assert.equal(DANGEROUS_COMMAND.test('sudo rm /etc/hosts'), true);
  assert.equal(DANGEROUS_COMMAND.test('osascript -e "tell app ..."'), true);
  assert.equal(DANGEROUS_COMMAND.test('npm run build'), false);
});

test('alternatives ending in whitespace still match (del /s was silently missed)', () => {
  const { DANGEROUS_COMMAND } = require('../src/renderer/approvals.js');
  assert.equal(DANGEROUS_COMMAND.test('del /s C:\\Users'), true);
  assert.equal(DANGEROUS_COMMAND.test('erase /f file'), true);
  assert.equal(DANGEROUS_COMMAND.test('format /fs:ntfs c:'), true);
  assert.equal(DANGEROUS_COMMAND.test('start /b evil.exe'), true);
  // and names that merely contain those words stay safe
  assert.equal(DANGEROUS_COMMAND.test('python format_check.py'), false);
  assert.equal(DANGEROUS_COMMAND.test('node model_test.js'), false);
});

test('isReadOnlyCommand: look-only commands with look-only options pass (Strata gate port)', () => {
  const { isReadOnlyCommand: ro } = require('../src/renderer/approvals.js');
  for (const cmd of [
    'git status', 'git status -sb', 'git log --oneline -5', 'git diff --stat HEAD~1', 'git branch', 'git branch -a',
    'git show HEAD', 'git config --get user.name', 'ls -la', 'ls src', 'cat package.json', 'cat a.txt | grep foo',
    'head -n 20 app.py', 'tail -n 50 build.log', 'wc -l src/main.js', 'rg -n "TODO" src', 'grep -rn needle .',
    'pwd', 'which node', 'node --version', 'python --version', 'uname -a', 'date -u',
    // cmd.exe, as Windows models write it
    'dir', 'dir /s /b', 'dir "C:\\Users\\Robot\\Q&A"', 'type README.md', 'where python', 'findstr /s /i needle *.py', 'tree /f', 'ver'
  ]) assert.strictEqual(ro(cmd), true, cmd);
});

test('isReadOnlyCommand: anything that writes, runs, never ends, or is not understood asks', () => {
  const { isReadOnlyCommand: ro, commandNeedsApproval } = require('../src/renderer/approvals.js');
  for (const cmd of [
    'sort -o out.txt in.txt', 'rg --pre cat x', 'tail -f log.txt', 'date -s 2020-01-01', 'date 1026120026',
    'git branch newbranch', 'git tag v1', 'git config user.name bob', 'git grep -O vim x', 'git push', 'git commit -m x',
    'uniq in.txt out.txt', 'hostname evil', 'type a.txt > b.txt', 'echo hi > f.txt', 'cat a && rm b', 'ls; rm x',
    'ls $(rm x)', 'dir %USERPROFILE%', 'python app.py', 'npm install', 'ls --unknown-flag', 'cat "unterminated',
    'grep -e "$(rm x)" .', 'bash -c ls', 'cmd /c dir', 'powershell ls', 'find . -delete', ''
  ]) assert.strictEqual(ro(cmd), false, cmd);
  // In Ask mode a read-only command runs without a card; dangerous ones still always ask.
  assert.strictEqual(commandNeedsApproval('ask', 'git status', []), false);
  assert.strictEqual(commandNeedsApproval('ask', 'npm test', []), true);
  assert.strictEqual(commandNeedsApproval('auto', 'git push', []), true);
});

test('describeCommand states the action in one plain sentence', () => {
  const { describeCommand: d } = require('../src/renderer/approvals.js');
  assert.strictEqual(d('pip install PySide6 pytest'), 'Install the Python packages PySide6 and pytest');
  assert.strictEqual(d('python -m pip install -r requirements.txt'), 'Install the Python packages listed in requirements.txt');
  assert.strictEqual(d('npm install'), "Install this project's Node dependencies");
  assert.strictEqual(d('npm run build'), 'Run the project\'s "build" script');
  assert.strictEqual(d('python app/main.py'), 'Run the Python script app/main.py');
  assert.strictEqual(d('rmdir /s /q build'), 'Delete build and everything in it');
  assert.strictEqual(d('rmdir old'), 'Remove the empty folder old');
  assert.strictEqual(d('git push -u origin main'), 'Push commits to the remote repository');
  assert.strictEqual(d('winget install --id Python.Python.3.12'), 'Install Python.Python.3.12 on this PC (winget)');
  assert.strictEqual(d('cd app && pyinstaller main.spec'), 'Build an executable with PyInstaller');
  assert.strictEqual(d('git add -A && git commit -m "x"'), 'Stage files for a git commit, then commit the staged changes to git');
  assert.strictEqual(d('curl -L https://example.com/x.zip -o x.zip'), 'Download from example.com');
  assert.strictEqual(d('frobnicate --all'), 'Run frobnicate'); // unknown: names the program, never guesses
  assert.strictEqual(d(''), 'Run a command');
});
