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
  if (r.code === 0) toast({ icon: 'check', text: [el('b', { text: 'Pushed.' }), ` ${branch} → ${remote}`], timeout: 12000 });
  else alert(`git push failed:\n${r.output}`);
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
