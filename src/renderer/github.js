'use strict';

// GitHub flow helpers: the pure, testable half of the branch-per-task, ahead/behind,
// publish, pull-request and release features. All of the UI, the git/gh invocations and
// the approval cards live in git.js; nothing here touches the DOM or runs a command.

// A short branch slug from a task title: "Fix the login crash!" -> "fix-the-login-crash".
function slug(text, max = 28) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/['"’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

// The branch a task should get: qwen/<slug>, with -2, -3… when the name is taken.
function taskBranchName(title, existingBranches) {
  const base = `qwen/${slug(title)}`;
  const taken = new Set((existingBranches || []).map((b) => String(b).trim().replace(/^\*?\s*/, '')));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now().toString(36)}`;
}

// Parse the first line of `git status -sb`:
//   "## main...origin/main [ahead 1, behind 3]"  "## main...origin/main [gone]"
//   "## main"  "## HEAD (no branch)"
function parseStatusBranch(output) {
  const line = String(output || '').split('\n')[0].trim();
  const m = /^## (?:(.+?)(?:\.\.\.(\S+))?)(?: \[(.+)\])?$/.exec(line);
  if (!m || !line.startsWith('## ')) return { branch: '', upstream: '', ahead: 0, behind: 0, gone: false };
  const branch = m[1] === 'HEAD (no branch)' ? '' : m[1];
  const flags = m[3] || '';
  return {
    branch,
    upstream: m[2] || '',
    ahead: Number(/ahead (\d+)/.exec(flags)?.[1] || 0),
    behind: Number(/behind (\d+)/.exec(flags)?.[1] || 0),
    gone: /\bgone\b/.test(flags)
  };
}

// "↓3 ↑1" for the status bar; empty when in sync or without an upstream.
function syncLabel({ ahead, behind } = {}) {
  const parts = [];
  if (behind > 0) parts.push(`↓${behind}`);
  if (ahead > 0) parts.push(`↑${ahead}`);
  return parts.join(' ');
}

// The project version for a release: package.json first, then pyproject.toml / Cargo.toml.
function versionFrom(files) {
  if (files?.packageJson) {
    try {
      const v = JSON.parse(files.packageJson).version;
      if (v) return String(v);
    } catch {
      /* fall through to the TOML files */
    }
  }
  for (const toml of [files?.pyproject, files?.cargoToml]) {
    const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(toml || '');
    if (m) return m[1];
  }
  return '';
}

// Markdown bullets from `git log --oneline` output, for the editable release notes.
function bulletsFromLog(output) {
  return String(output || '')
    .split('\n')
    .map((l) => l.trim().replace(/^[0-9a-f]{7,40}\s+/i, ''))
    .filter((l) => l && !/^Merge (branch|pull request)/.test(l))
    .map((l) => `- ${l}`)
    .join('\n');
}

// A string made safe to sit inside double quotes on both sh and cmd.exe: anything that
// could escape or expand is dropped rather than escaped, since these are titles and names.
function shellSafe(s, max = 200) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/["`$\\%!^<>|&]/g, "'").slice(0, max).trim();
}

// A valid-enough GitHub repository name from a folder name.
function repoNameFrom(folder) {
  const n = String(folder || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
  return n || 'my-project';
}

const GitHubExports = { slug, taskBranchName, parseStatusBranch, syncLabel, versionFrom, bulletsFromLog, shellSafe, repoNameFrom };
if (typeof module !== 'undefined' && module.exports) module.exports = GitHubExports;
if (typeof window !== 'undefined') window.GitHub = GitHubExports;
