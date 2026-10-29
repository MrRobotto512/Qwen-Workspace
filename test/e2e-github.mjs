// GitHub-flow smoke test: a real local git repo with a bare "origin" plus a fake `gh`
// binary prove the whole phase — the sync pill and ahead/behind, pull --ff-only,
// branch-per-task, and the publish / pull-request / release cards invoking gh.
// Run under a display: xvfb-run -a npm run test:e2e:github
import { _electron as electron } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`GITHUB SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-gh-'));
const bare = path.join(root, 'origin.git');
const bare2 = path.join(root, 'published.git'); // what the fake `gh repo create` wires up
const ws = path.join(root, 'project');
const other = path.join(root, 'other'); // a second clone, to make the origin move ahead
const noRemote = path.join(root, 'fresh'); // a repo with no remote, for Publish to GitHub
const fakeBin = path.join(root, 'bin');
const ghLog = path.join(root, 'gh-calls.log');

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const G = 'git -c user.name=T -c user.email=t@t.t -c commit.gpgsign=false';

// ---- repos ----
run(`git init --bare --initial-branch=main ${JSON.stringify(bare)}`, root);
run(`git init --bare --initial-branch=main ${JSON.stringify(bare2)}`, root);
run(`git clone ${JSON.stringify(bare)} ${JSON.stringify(ws)}`, root);
fs.writeFileSync(path.join(ws, 'readme.md'), 'hello\n');
run(`${G} add -A && ${G} commit -m "feat: initial" && git push -u origin main`, ws);
run(`git clone ${JSON.stringify(bare)} ${JSON.stringify(other)}`, root);
fs.mkdirSync(noRemote);
fs.writeFileSync(path.join(noRemote, 'app.py'), 'print(1)\n');
run(`git init --initial-branch=main . && ${G} add -A && ${G} commit -m "start"`, noRemote);

// ---- fake gh on PATH ----
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/bin/sh
echo "gh $@" >> ${JSON.stringify(ghLog)}
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo create") git remote add origin ${JSON.stringify(bare2)} 2>/dev/null; echo "https://github.com/mock/$3"; exit 0 ;;
  "pr create") echo "https://github.com/mock/repo/pull/7"; exit 0 ;;
  "release create") echo "https://github.com/mock/repo/releases/tag/$3"; exit 0 ;;
esac
echo "gh version 2.70.0 (fake)"
exit 0
`);
fs.chmodSync(path.join(fakeBin, 'gh'), 0o755);

const app = await electron.launch({ args: ['.'], env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
// pushFlow and git-init prompts use native confirm(); accept them so the flow continues.
win.on('dialog', (d) => d.accept().catch(() => {}));
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8') : '');

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
  }, ws);

  // --- sync pill: visible with the branch name once the repo is detected ---
  await win.waitForFunction(() => !document.querySelector('#sb-git').classList.contains('hidden') && document.querySelector('#sb-git').textContent.includes('main'), null, { timeout: 15_000 })
    .catch(() => fail('the git sync pill never showed the branch'));

  // --- behind: the origin moves ahead; fetch must show ↓1 and Pull must fast-forward ---
  fs.writeFileSync(path.join(other, 'remote-change.txt'), 'from the shop PC\n');
  run(`${G} add -A && ${G} commit -m "fix: remote change" && git push`, other);
  await win.evaluate(() => refreshGitSync(true));
  await win.waitForFunction(() => document.querySelector('#sb-git').textContent.includes('↓1'), null, { timeout: 15_000 })
    .catch(() => fail('behind count ↓1 never appeared after the origin moved'));
  await win.evaluate(() => pullFF());
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(path.join(ws, 'remote-change.txt')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (!fs.existsSync(path.join(ws, 'remote-change.txt'))) fail('pull --ff-only did not bring the remote commit in');

  // --- branch per task: the first recorded change moves the task to qwen/<slug> ---
  await win.evaluate(async () => {
    state.settings.branchPerTask = true;
    const c = state.conv;
    c.title = 'Fix the login crash';
    await maybeTaskBranch(c);
  });
  const branchNow = run('git rev-parse --abbrev-ref HEAD', ws).trim();
  if (branchNow !== 'qwen/fix-the-login-crash') fail(`branch per task made "${branchNow}", expected qwen/fix-the-login-crash`);
  fs.writeFileSync(path.join(ws, 'fix.js'), 'ok\n');
  run(`${G} add -A && ${G} commit -m "fix: login crash" && git push -u origin qwen/fix-the-login-crash`, ws);
  await win.evaluate(() => refreshGitSync(true));

  // --- pull request card: drafts (offline fallback), then invokes gh pr create ---
  await win.evaluate(() => prFlow());
  await win.waitForFunction(() => {
    const t = document.querySelector('.commit-card input');
    return t && t.value && t.value !== 'Drafting…';
  }, null, { timeout: 20_000 }).catch(() => fail('the PR card never finished drafting'));
  await win.evaluate(() => {
    document.querySelector('.commit-card input').value = 'Fix the login crash';
    document.querySelector('.commit-card textarea').value = 'Body from the test.';
    document.querySelector('.commit-card .btns .primary').click();
  });
  await win.waitForFunction(() => !document.querySelector('.commit-card'), null, { timeout: 15_000 }).catch(() => fail('the PR card never closed'));
  // The shell strips the quotes before argv, so the log shows bare words.
  if (!/pr create --base main --head qwen\/fix-the-login-crash --title Fix the login crash --body-file/.test(ghCalls())) fail(`gh pr create was not invoked as expected:\n${ghCalls()}`);

  // --- release card: version from package.json, notes drafted, gh release create ---
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'proj', version: '1.4.0' }));
  await win.evaluate(() => releaseFlow());
  await win.waitForFunction(() => {
    const t = document.querySelector('.commit-card textarea');
    return t && t.value && !t.value.startsWith('Drafting');
  }, null, { timeout: 20_000 }).catch(() => fail('the release card never finished drafting'));
  const tagVal = await win.evaluate(() => document.querySelector('.commit-card input').value);
  if (tagVal !== 'v1.4.0') fail(`release tag prefilled as "${tagVal}", expected v1.4.0`);
  await win.evaluate(() => document.querySelector('.commit-card .btns .primary').click());
  await win.waitForFunction(() => !document.querySelector('.commit-card'), null, { timeout: 15_000 }).catch(() => fail('the release card never closed'));
  if (!/release create v1\.4\.0 --title v1\.4\.0 --notes-file/.test(ghCalls())) fail(`gh release create was not invoked as expected:\n${ghCalls()}`);

  // --- publish to GitHub: a folder with no remote gets the repo-create card ---
  await win.evaluate(async (dir) => {
    await openWorkspace(dir);
    newChat();
    publishRepoFlow();
  }, noRemote);
  await win.waitForFunction(() => document.querySelector('.commit-card select'), null, { timeout: 15_000 }).catch(() => fail('the publish card never appeared'));
  await win.evaluate(() => document.querySelector('.commit-card .btns .primary').click());
  await win.waitForFunction(() => !document.querySelector('.commit-card'), null, { timeout: 15_000 }).catch(() => fail('the publish card never closed'));
  if (!/repo create fresh --private --source \. --remote origin/.test(ghCalls())) fail(`gh repo create was not invoked as expected:\n${ghCalls()}`);
  const remotes = run('git remote', noRemote).trim();
  if (remotes !== 'origin') fail(`the fake gh should have added the origin remote, got "${remotes}"`);
  // publishRepoFlow chains into pushFlow (confirm accepted by the dialog handler). Wait for
  // the push to land before closing — tearing down while its dialog is up hangs app.close().
  const pushDeadline = Date.now() + 20_000;
  let pushed = false;
  while (Date.now() < pushDeadline && !pushed) {
    try {
      run('git rev-parse main', bare2);
      pushed = true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!pushed) fail('the publish flow never pushed main to the new origin');
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('github smoke ok: sync pill + ↓1 + pull, branch per task, PR card → gh, release card → gh, publish card → gh');
