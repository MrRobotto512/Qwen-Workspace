'use strict';
// Git flows: availability (with the portable-Git installer), commit with an
// AI-written message, push and clone - all behind the usual confirms.

async function git(cmd) {
  return api.runCommand(cmd);
}

// Makes sure a working git is available before a git action. If none is found, offers to
// download a portable copy into the app's folder (Windows). Resolves true when git is ready.
let gitReady = false;
let gitInstallPromise = null;
async function ensureGit() {
  if (gitReady) return true;
  let status;
  try {
    status = await api.gitEnsure();
  } catch {
    status = { ok: false, canInstall: false };
  }
  if (status.ok) {
    gitReady = true;
    return true;
  }
  if (gitInstallPromise) return gitInstallPromise;
  if (!status.canInstall) {
    const mac = state.appInfo?.platform === 'darwin';
    toast({ key: 'git-install', icon: 'alert', timeout: 0,
      text: mac ? 'Git isn’t installed. Run "xcode-select --install" in Terminal (or "brew install git"), then try again.' : 'Git isn’t installed. Install Git, then restart the app.',
      actions: mac ? [] : [{ label: 'Get Git', onClick: () => api.openExternal('https://git-scm.com/download/win') }] });
    return false;
  }
  const wants = await new Promise((resolve) => {
    toast({ key: 'git-install', icon: 'gitCommit', timeout: 0,
      text: 'Git isn’t installed on this PC. Download a portable copy now? (~50 MB, no admin needed)',
      actions: [
        { label: 'Download Git', primary: true, keep: true, onClick: () => resolve(true) },
        { label: 'Not now', onClick: () => resolve(false) }
      ] });
  });
  if (!wants) return false;
  gitInstallPromise = runGitInstall();
  const ok = await gitInstallPromise;
  gitInstallPromise = null;
  return ok;
}

async function runGitInstall() {
  toast({ key: 'git-install', icon: 'download', text: 'Finding the latest Git…', timeout: 0 });
  const setText = (msg) => {
    const n = document.querySelector('#toasts .toast[data-key="git-install"] .t-text');
    if (n) n.textContent = msg;
  };
  const off = api.onGitInstallProgress((p) => {
    if (p.phase === 'download') setText(`Downloading Git… ${p.percent || 0}%`);
    else if (p.phase === 'extract') setText('Unpacking Git…');
    else if (p.phase === 'find') setText('Finding the latest Git…');
  });
  try {
    const r = await api.gitInstall();
    if (r.ok) {
      gitReady = true;
      toast({ key: 'git-install', icon: 'check', text: 'Git is ready. You can clone, commit and push now.', timeout: 6000 });
      return true;
    }
    toast({ key: 'git-install', icon: 'alert', text: `Couldn’t install Git: ${r.output}`, timeout: 0,
      actions: [{ label: 'Get Git manually', onClick: () => api.openExternal('https://git-scm.com/download/win') }] });
    return false;
  } catch (e) {
    toast({ key: 'git-install', icon: 'alert', text: `Couldn’t install Git: ${cleanError(e)}`, timeout: 0 });
    return false;
  } finally {
    off();
  }
}

async function isGitRepo() {
  const r = await git('git rev-parse --is-inside-work-tree');
  return r.code === 0 && /true/.test(r.output);
}

// Stages everything, asks the model for a Conventional Commits message from the diff, shows it
// in an editable card, and commits on approve.
async function commitFlow() {
  if (!requireWorkspace() || state.committing) return;
  if (!(await ensureGit())) return;
  if (!(await isGitRepo())) {
    if (!confirm('This folder is not a git repository. Run "git init" here?')) return;
    const init = await api.gitInit();
    if (!init.ok) return alert(`git init failed:
${init.output}`);
  }
  const status = await git('git status --porcelain');
  if (status.code !== 0) return alert(`git failed:
${status.output}`);
  if (!status.output.trim()) return flash('Nothing to commit — the working tree is clean.');

  state.committing = true;
  showView('changes');
  const card = el('div', { class: 'commit-card' }, el('div', { class: 'commit-head' }, iconEl('gitCommit'), el('span', { text: 'Writing a commit message…' }), el('span', { class: 'spinner' })));
  $('#changes-list').prepend(card);
  try {
    // Stage everything so new files show in the diff, then summarize it for the model.
    await git('git add -A');
    const diff = (await git('git --no-pager diff --cached --stat')).output + '\n\n' + (await git('git --no-pager diff --cached')).output;
    const message = await generateCommitMessage(diff.slice(0, 12000), status.output);
    renderCommitCard(card, message);
  } catch (e) {
    card.remove();
    state.committing = false;
    alert(`Could not prepare the commit: ${cleanError(e)}`);
  }
}

async function generateCommitMessage(diff, porcelain) {
  const res = await api.chatStream(`commit${Date.now()}`, {
    messages: [
      { role: 'system', content: 'You write Conventional Commits messages. Reply with only the commit message: a subject line "type(scope): summary" under 72 chars (types: feat, fix, docs, refactor, test, chore, build), optionally a blank line and a short body of what changed and why. No backticks, no preamble.' },
      { role: 'user', content: `Write a commit message for these staged changes.

Changed files:
${porcelain}

Diff:
${diff}` }
    ]
  });
  const msg = res.ok ? stripThink(res.content || '').replace(/^```[\w]*\n?|```$/g, '').trim() : '';
  return msg || 'Update project files';
}

function renderCommitCard(card, message) {
  const box = el('textarea', { class: 'commit-msg', spellcheck: 'true' });
  box.value = message;
  const done = (committed) => {
    card.remove();
    state.committing = false;
    if (committed) renderChanges();
  };
  card.replaceChildren(
    el('div', { class: 'commit-head' }, iconEl('gitCommit'), el('span', { text: 'Commit message (editable)' })),
    box,
    el('div', { class: 'btns' },
      el('button', { class: 'ghost', onclick: () => done(false) }, 'Cancel'),
      el('button', { class: 'primary', onclick: async (e) => {
        const msg = box.value.trim();
        if (!msg) return;
        e.currentTarget.disabled = true;
        const r = await api.gitCommit(msg);
        if (r.ok) {
          flash('Committed');
          toast({ icon: 'check', text: [el('b', { text: 'Committed.' }), ' ' + r.output.split('\n')[0]], actions: [{ label: 'Push', primary: true, onClick: pushFlow }], timeout: 15000 });
          done(true);
        } else {
          e.currentTarget.disabled = false;
          alert(`git commit failed:\n${r.output}`);
        }
      } }, iconEl('gitCommit'), 'Commit'))
  );
  box.focus();
  box.setSelectionRange(message.length, message.length);
  box.scrollIntoView({ block: 'nearest' });
}

async function pushFlow() {
  if (!requireWorkspace()) return;
  if (!(await ensureGit())) return;
  if (!(await isGitRepo())) return alert('This folder is not a git repository yet.');
  const branch = (await git('git rev-parse --abbrev-ref HEAD')).output.trim() || 'HEAD';
  const remote = (await git('git remote')).output.trim().split(/\s+/)[0];
  if (!remote) return alert('No git remote is set. Add one first, e.g. git remote add origin <url>.');
  if (!confirm(`Push ${branch} to ${remote}? This publishes your commits.`)) return;
  flash(`Pushing ${branch} to ${remote}…`);
  const hasUpstream = (await git('git rev-parse --abbrev-ref --symbolic-full-name @{u}')).code === 0;
  const r = await git(hasUpstream ? `git push ${remote} ${branch}` : `git push -u ${remote} ${branch}`);
  if (r.code === 0) {
    // A push from a task branch is one click away from review: offer the pull request.
    const base = state.gitDefaultBranch || 'main';
    const offerPr = branch !== base && branch !== 'HEAD';
    toast({
      icon: 'check',
      text: [el('b', { text: 'Pushed.' }), ` ${branch} → ${remote}`],
      timeout: offerPr ? 20000 : 12000,
      actions: offerPr ? [{ label: 'Open pull request', primary: true, onClick: prFlow }] : []
    });
    refreshGitSync(false);
  } else alert(`git push failed:\n${r.output}`);
}

async function cloneFlow() {
  const url = await askInput('Clone a GitHub repository', 'https://github.com/owner/repo.git');
  if (!url) return;
  if (!(await ensureGit())) return;
  flash('Cloning…');
  let r;
  try {
    r = await api.gitClone(url.trim());
  } catch (e) {
    return alert(cleanError(e));
  }
  if (r.cancelled) return;
  if (!r.ok) return alert(`git clone failed:\n${r.output}`);
  await openWorkspace(r.dir);
  flash(`Cloned into ${r.dir}`);
}

// ===================================================================
// GitHub flow: gh CLI, sync status, branch-per-task, publish, PRs, releases
// ===================================================================
// Every action that touches GitHub (create repo, push, PR, release) goes through an
// explicit editable card or confirm, in every approval mode. Tokens are never stored:
// auth belongs to `gh auth login`, which keeps credentials in gh's own store.

// --- gh CLI availability and sign-in ---
let ghState = { checked: false, installed: false, authed: false };

async function ghCheck(force) {
  if (ghState.checked && !force) return ghState;
  const installed = (await git('gh --version')).code === 0;
  const authed = installed && (await git('gh auth status')).code === 0;
  ghState = { checked: true, installed, authed };
  return ghState;
}

// Opens the user's real terminal with `gh auth login --web` — the sign-in is interactive
// and needs a TTY, which the app's output-only terminal panel can't provide.
function openAuthTerminal() {
  const p = state.appInfo?.platform;
  if (p === 'win32') return api.runCommand('start "GitHub sign-in" cmd /k "gh auth login --web"');
  if (p === 'darwin') return api.runCommand('osascript -e \'tell application "Terminal" to do script "gh auth login --web"\' -e \'tell application "Terminal" to activate\'');
  return api.runCommand('x-terminal-emulator -e gh auth login --web || xterm -e gh auth login --web');
}

// Makes sure the GitHub CLI is installed and signed in, walking the user through both.
// Resolves true only when `gh` is ready; false when the user bows out.
async function ensureGh() {
  let st = await ghCheck(true);
  if (st.installed && st.authed) return true;

  if (!st.installed) {
    const platform = state.appInfo?.platform;
    const cmd = platform === 'win32'
      ? 'winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements'
      : platform === 'darwin' ? 'brew install gh' : null;
    const wants = await new Promise((resolve) => {
      toast({ key: 'gh', icon: 'download', timeout: 0,
        text: 'This needs the GitHub CLI (gh), which isn’t installed.',
        actions: [
          cmd ? { label: platform === 'win32' ? 'Install with winget' : 'Install with Homebrew', primary: true, onClick: () => resolve(true) } : { label: 'Get gh', primary: true, onClick: () => { api.openExternal('https://cli.github.com'); resolve(false); } },
          { label: 'Not now', onClick: () => resolve(false) }
        ] });
    });
    if (!wants || !cmd) return false;
    showTerminal(true, false);
    termWrite(`\n❯ ${cmd}\n`, 'term-cmd');
    const r = await api.runCommand(cmd, 600_000);
    termWrite(`[exit code ${r.code}]\n`, 'term-exit');
    st = await ghCheck(true);
    if (!st.installed) {
      toast({ key: 'gh', icon: 'alert', timeout: 0, text: 'gh still isn’t available. Install it from cli.github.com, then try again.', actions: [{ label: 'Open cli.github.com', onClick: () => api.openExternal('https://cli.github.com') }] });
      return false;
    }
  }

  while (!st.authed) {
    const action = await new Promise((resolve) => {
      toast({ key: 'gh', icon: 'shield', timeout: 0,
        text: 'gh isn’t signed in to GitHub. A terminal will open to sign you in with your browser — the token stays in gh’s own store, never in this app.',
        actions: [
          { label: 'Sign in with browser', primary: true, keep: true, onClick: () => resolve('login') },
          { label: 'I’m signed in — check again', keep: true, onClick: () => resolve('check') },
          { label: 'Cancel', onClick: () => resolve('cancel') }
        ] });
    });
    if (action === 'cancel') return false;
    if (action === 'login') await openAuthTerminal();
    if (action === 'check') {
      st = await ghCheck(true);
      if (!st.authed) flash('gh is still not signed in');
    }
  }
  document.querySelector('#toasts .toast[data-key="gh"]')?.remove();
  return true;
}

// --- behind/ahead sync status: fetched on project open and every 10 minutes ---
let gitSyncTimer = null;

async function refreshGitSync(fetchFirst) {
  if (!state.ws) return;
  if (!(await isGitRepo())) {
    state.gitSync = null;
    renderGitSync();
    return;
  }
  if (fetchFirst) await git('git fetch --quiet');
  const st = await git('git status -sb');
  state.gitSync = st.code === 0 ? GitHub.parseStatusBranch(st.output) : null;
  state.gitRemote = (await git('git remote')).output.trim().split(/\s+/)[0] || '';
  if (state.gitRemote) {
    const head = await git(`git symbolic-ref --short refs/remotes/${state.gitRemote}/HEAD`);
    if (head.code === 0) state.gitDefaultBranch = head.output.trim().replace(`${state.gitRemote}/`, '');
    else {
      const branches = (await git('git branch --list main master')).output;
      state.gitDefaultBranch = /\bmain\b/.test(branches) ? 'main' : 'master';
    }
  } else state.gitDefaultBranch = '';
  renderGitSync();
}

function startGitSyncTimer() {
  clearInterval(gitSyncTimer);
  gitSyncTimer = setInterval(() => refreshGitSync(true), 10 * 60 * 1000);
  refreshGitSync(true);
}

function renderGitSync() {
  const pill = $('#sb-git');
  if (pill) {
    const s = state.gitSync;
    pill.classList.toggle('hidden', !s?.branch);
    if (s?.branch) {
      const label = GitHub.syncLabel(s);
      pill.lastChild.textContent = label ? `${s.branch} ${label}` : s.branch;
      pill.classList.toggle('bad', s.behind > 0);
      pill.title = s.upstream
        ? `${s.branch} → ${s.upstream}${s.behind ? ` — ${s.behind} to pull` : ''}${s.ahead ? ` — ${s.ahead} to push` : ''}${s.gone ? ' — upstream is gone' : ''}`
        : `${s.branch} (no upstream yet)`;
    }
  }
  renderGitBar();
}

function showGitSyncMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const s = state.gitSync || {};
  const items = [];
  if (s.behind > 0) items.push({ label: `Pull ${s.behind} commit${s.behind === 1 ? '' : 's'}`, desc: 'git pull --ff-only', icon: 'download', onClick: pullFF });
  if (s.ahead > 0 || (s.branch && !s.upstream)) items.push({ label: 'Push', desc: s.upstream ? `${s.ahead} to push` : 'publish this branch', icon: 'arrowUp', onClick: pushFlow });
  items.push({ label: 'Fetch now', icon: 'refresh', onClick: () => refreshGitSync(true) });
  showMenu(r.left, r.top, items, { above: true });
}

// Fast-forward only: on any conflict or divergence, show git's own output and change nothing.
async function pullFF() {
  if (!(await ensureGit())) return;
  showTerminal(true, false);
  termWrite('\n❯ git pull --ff-only\n', 'term-cmd');
  const r = await git('git pull --ff-only');
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  if (r.code === 0) flash('Pulled');
  else toast({ icon: 'alert', timeout: 0, text: [el('b', { text: 'Pull needs your attention' }), ` — the branches have diverged or there are local changes. Nothing was merged.\n${r.output.slice(0, 400)}`] });
  refreshGitSync(false);
  state.fileIndex = null;
  renderTree();
}

// --- branch per task (setting, off by default) ---
// Called when an agent task records its first file change in a git repo: the work moves to
// qwen/<slug> so main stays clean and the task can become a pull request.
async function maybeTaskBranch(c) {
  if (!state.settings.branchPerTask || c.taskBranch || c.taskBranchTried) return;
  c.taskBranchTried = true;
  if (!state.ws || !(await isGitRepo())) return;
  const branches = (await git('git branch --list')).output.split('\n');
  const name = GitHub.taskBranchName(c.title || 'task', branches);
  const r = await git(`git checkout -b ${name}`);
  if (r.code !== 0) return; // e.g. mid-rebase; the task just stays on the current branch
  c.taskBranch = name;
  const item = { t: 'notice', text: `Working on branch ${name}.` };
  c.display.push(item);
  renderNotice(c, item);
  refreshGitSync(false);
}

// --- the git bar in the Changes panel ---
function renderGitBar() {
  const bar = $('#git-bar');
  if (!bar) return;
  const s = state.gitSync;
  bar.classList.toggle('hidden', !state.ws || !s?.branch);
  if (!state.ws || !s?.branch) return;
  const label = GitHub.syncLabel(s);
  const onDefault = !state.gitDefaultBranch || s.branch === state.gitDefaultBranch;
  bar.replaceChildren(...[
    el('span', { class: 'git-branch', title: state.conv?.taskBranch === s.branch ? 'This task’s branch' : 'Current branch' }, iconEl('gitCommit'), el('span', { text: s.branch })),
    label ? el('button', { class: 'ghost small', title: 'Fetched on open and every 10 minutes', onclick: s.behind > 0 ? pullFF : () => refreshGitSync(true) }, label + (s.behind > 0 ? ' · Pull' : '')) : null,
    el('span', { class: 'spacer' }),
    !state.gitRemote ? el('button', { class: 'ghost small', onclick: publishRepoFlow }, 'Publish to GitHub') : null,
    state.gitRemote && !onDefault ? el('button', { class: 'ghost small', onclick: prFlow }, 'Open pull request') : null,
    state.gitRemote ? el('button', { class: 'ghost small', onclick: releaseFlow }, 'Publish release') : null
  ].filter(Boolean));
}

// Asks the model to draft text for a card; falls back to the given default offline.
async function draftText(system, user, fallback) {
  try {
    const res = await api.chatStream(`draft${Date.now()}`, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    });
    const out = res.ok ? stripThink(res.content || '').replace(/^```[\w]*\n?|```$/g, '').trim() : '';
    return out || fallback;
  } catch {
    return fallback;
  }
}

// A generic editable card in the Changes panel: fields + confirm, like the commit card.
function ghCard(title, fields, confirmLabel, onConfirm) {
  showView('changes');
  const inputs = {};
  const card = el('div', { class: 'commit-card' },
    el('div', { class: 'commit-head' }, iconEl('gitCommit'), el('span', { text: title })),
    ...fields.map((f) => {
      if (f.kind === 'select') {
        inputs[f.id] = el('select', {}, ...f.options.map(([v, t]) => el('option', { value: v, text: t })));
        inputs[f.id].value = f.value;
      } else if (f.kind === 'textarea') {
        inputs[f.id] = el('textarea', { class: 'commit-msg', spellcheck: 'true' });
        inputs[f.id].value = f.value;
      } else {
        inputs[f.id] = el('input', { value: f.value, spellcheck: 'false' });
      }
      return el('label', { class: 'gh-field' }, el('span', { class: 'hint', text: f.label }), inputs[f.id]);
    }),
    el('div', { class: 'btns' },
      el('button', { class: 'ghost', onclick: () => card.remove() }, 'Cancel'),
      el('button', { class: 'primary', onclick: async (e) => {
        e.currentTarget.disabled = true;
        const values = Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value]));
        const ok = await onConfirm(values, card);
        if (ok) card.remove();
        else e.currentTarget.disabled = false;
      } }, confirmLabel))
  );
  $('#changes-list').prepend(card);
  card.scrollIntoView({ block: 'nearest' });
  return card;
}

// Runs a gh command with the terminal visible, returning the result.
async function runGh(cmd, timeoutMs = 120_000) {
  showTerminal(true, false);
  termWrite(`\n❯ ${cmd}\n`, 'term-cmd');
  const r = await api.runCommand(cmd, timeoutMs);
  termWrite(`[exit code ${r.code}]\n`, 'term-exit');
  return r;
}

// --- Publish to GitHub: create a repo for a folder with no remote ---
async function publishRepoFlow() {
  if (!requireWorkspace()) return;
  if (!(await ensureGit())) return;
  if (!(await isGitRepo())) {
    if (!confirm('This folder is not a git repository. Run "git init" here first?')) return;
    const init = await api.gitInit();
    if (!init.ok) return alert(`git init failed:\n${init.output}`);
  }
  if (!(await ensureGh())) return;
  ghCard('Publish this folder to GitHub', [
    { id: 'name', label: 'Repository name', value: GitHub.repoNameFrom(state.ws.name) },
    { id: 'visibility', label: 'Visibility', kind: 'select', value: 'private', options: [['private', 'Private (only you)'], ['public', 'Public (anyone can see it)']] }
  ], 'Create repository', async (v) => {
    const name = GitHub.repoNameFrom(v.name);
    const r = await runGh(`gh repo create ${name} --${v.visibility === 'public' ? 'public' : 'private'} --source . --remote origin`);
    if (r.code !== 0) {
      toast({ icon: 'alert', timeout: 0, text: `gh repo create failed:\n${r.output.slice(0, 400)}` });
      return false;
    }
    toast({ icon: 'check', text: [el('b', { text: 'Repository created.' }), ' Now push your commits.'], timeout: 10000 });
    await refreshGitSync(false);
    pushFlow();
    return true;
  });
}

// --- Open a pull request from the current (non-default) branch ---
async function prFlow() {
  if (!requireWorkspace() || !(await ensureGit())) return;
  const branch = state.gitSync?.branch || (await git('git rev-parse --abbrev-ref HEAD')).output.trim();
  const base = state.gitDefaultBranch || 'main';
  if (!branch || branch === base) return flash(`You are on ${base} — switch to a task branch first`);
  if (!(await ensureGh())) return;
  const card = ghCard('Open a pull request', [
    { id: 'title', label: 'Title', value: 'Drafting…' },
    { id: 'body', label: 'Description (markdown)', kind: 'textarea', value: 'Drafting from the commits and diff…' }
  ], 'Create pull request', async (v) => {
    const title = GitHub.shellSafe(v.title, 150);
    if (!title) return false;
    await api.write('.qwen/pr-body.md', v.body || '');
    const r = await runGh(`gh pr create --base ${base} --head ${branch} --title "${title}" --body-file ".qwen/pr-body.md"`);
    api.remove('.qwen/pr-body.md').catch(() => {});
    if (r.code !== 0) {
      toast({ icon: 'alert', timeout: 0, text: `gh pr create failed:\n${r.output.slice(0, 400)}` });
      return false;
    }
    const url = /https:\/\/\S+\/pull\/\d+/.exec(r.output)?.[0];
    toast({ icon: 'check', timeout: 0, text: [el('b', { text: 'Pull request opened.' }), url ? ` ${url}` : ''], actions: url ? [{ label: 'Open on GitHub', primary: true, onClick: () => api.openExternal(url) }] : [] });
    return true;
  });
  // Draft the title and body from the real commits and diff while the card is on screen.
  const log = (await git(`git --no-pager log ${base}..HEAD --oneline`)).output;
  const stat = (await git(`git --no-pager diff ${base}...HEAD --stat`)).output;
  const fallback = `${branch}\n\n${GitHub.bulletsFromLog(log)}`;
  const draft = await draftText(
    'You write pull request titles and descriptions. Reply with the title on the first line (no prefix, under 70 chars), a blank line, then a short markdown body: what changed, why, and anything the reviewer should look at. No backticks fence, no preamble.',
    `Branch: ${branch} -> ${base}\n\nCommits:\n${log}\n\nChanged files:\n${stat.slice(0, 4000)}`,
    fallback
  );
  const [first, ...rest] = draft.split('\n');
  const titleInput = card.querySelectorAll('input')[0];
  const bodyInput = card.querySelector('textarea');
  if (titleInput && titleInput.value === 'Drafting…') titleInput.value = first.trim();
  if (bodyInput && bodyInput.value.startsWith('Drafting')) bodyInput.value = rest.join('\n').trim();
}

// --- Publish a release: version from the project files, notes from the commits ---
async function releaseFlow() {
  if (!requireWorkspace() || !(await ensureGit())) return;
  if (!(await ensureGh())) return;
  const files = {};
  for (const [key, name] of [['packageJson', 'package.json'], ['pyproject', 'pyproject.toml'], ['cargoToml', 'Cargo.toml']]) {
    try {
      files[key] = await api.read(name);
    } catch {
      /* file not in this project */
    }
  }
  const version = GitHub.versionFrom(files) || '0.1.0';
  const lastTag = (await git('git describe --tags --abbrev=0')).code === 0
    ? (await git('git describe --tags --abbrev=0')).output.trim()
    : '';
  const log = (await git(`git --no-pager log ${lastTag ? `${lastTag}..HEAD` : '-30'} --oneline`)).output;
  const ahead = state.gitSync?.ahead || 0;
  const card = ghCard(`Publish a release${lastTag ? ` (last: ${lastTag})` : ''}${ahead ? ` — note: ${ahead} commit${ahead === 1 ? '' : 's'} not pushed yet` : ''}`, [
    { id: 'tag', label: 'Tag', value: `v${version}` },
    { id: 'title', label: 'Title', value: `v${version}` },
    { id: 'notes', label: 'Release notes (markdown)', kind: 'textarea', value: 'Drafting from the commits…' }
  ], 'Create release', async (v) => {
    const tag = GitHub.shellSafe(v.tag, 60).replace(/\s+/g, '');
    const title = GitHub.shellSafe(v.title, 120);
    if (!tag) return false;
    await api.write('.qwen/release-notes.md', v.notes || '');
    const r = await runGh(`gh release create ${tag} --title "${title || tag}" --notes-file ".qwen/release-notes.md"`, 300_000);
    api.remove('.qwen/release-notes.md').catch(() => {});
    if (r.code !== 0) {
      toast({ icon: 'alert', timeout: 0, text: `gh release create failed:\n${r.output.slice(0, 400)}` });
      return false;
    }
    const url = /https:\/\/\S+\/releases\/\S+/.exec(r.output)?.[0];
    toast({ icon: 'check', timeout: 0, text: [el('b', { text: `Release ${tag} published.` })], actions: url ? [{ label: 'Open on GitHub', primary: true, onClick: () => api.openExternal(url) }] : [] });
    refreshGitSync(true);
    return true;
  });
  const notes = GitHub.bulletsFromLog(log);
  const draft = await draftText(
    'You write GitHub release notes. Reply with short markdown: a one-line summary, then grouped bullets of what changed (New, Fixes, Other as applicable). No heading with the version, no backtick fences, no preamble.',
    `Version: ${version}\nCommits since ${lastTag || 'the beginning'}:\n${log.slice(0, 6000)}`,
    notes
  );
  const notesInput = card.querySelector('textarea');
  if (notesInput && notesInput.value.startsWith('Drafting')) notesInput.value = draft;
}
