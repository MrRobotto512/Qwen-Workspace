// Recipe smoke test: each app recipe installs into an empty folder through the real
// applyRecipe flow — files land, git init runs, and the first commit is made.
// Run under a display: xvfb-run -a npm run test:e2e:recipes
import { _electron as electron } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => {
  console.error(`RECIPES SMOKE FAIL: ${msg}`);
  process.exitCode = 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-rec-'));
const MUST_HAVE = {
  'python-gui': ['QWEN.md', 'pyproject.toml', 'app/main.py', 'tests/test_app.py', 'packaging/app.spec', '.gitignore', '.qwen/skills/python-gui/SKILL.md', '.github/workflows/build.yml'],
  'electron-app': ['QWEN.md', 'package.json', 'src/main.js', 'src/preload.js', 'src/index.html', 'test/smoke.test.js', '.gitignore', '.qwen/skills/electron-app/SKILL.md', '.github/workflows/build.yml'],
  'cli-wrapper': ['QWEN.md', 'pyproject.toml', 'app/main.py', 'app/args.py', 'tests/test_args.py', 'tests/test_window.py', 'packaging/app.spec', '.gitignore', '.qwen/skills/cli-wrapper/SKILL.md', '.github/workflows/build.yml']
};

const app = await electron.launch({ args: ['.'], env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } });
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('dialog', (d) => d.accept().catch(() => {}));

try {
  await win.waitForFunction(() => document.querySelector('#btn-settings')?.onclick && document.querySelector('#model-name')?.textContent, null, { timeout: 25_000 });

  const templates = await win.evaluate(() => api.templatesList());
  const recipes = templates.filter((t) => t.kind === 'recipe').map((t) => t.id).sort();
  if (recipes.join(',') !== 'cli-wrapper,electron-app,python-gui') fail(`expected the three recipes, got: ${recipes.join(',')}`);
  if (templates.find((t) => t.id === 'software-factory')?.kind === 'recipe') fail('software-factory must stay a workflow, not a recipe');

  for (const id of Object.keys(MUST_HAVE)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    await win.evaluate(async ([d, rid]) => {
      await openWorkspace(d);
      const t = (await api.templatesList()).find((x) => x.id === rid);
      await applyRecipe(t);
    }, [dir, id]);
    for (const f of MUST_HAVE[id]) {
      if (!fs.existsSync(path.join(dir, f))) fail(`${id}: missing ${f} after install`);
    }
    let log = '';
    try {
      log = execSync('git log --oneline', { cwd: dir, stdio: 'pipe' }).toString().trim();
    } catch {
      fail(`${id}: no git repository / commit after install`);
    }
    if (log && log.split('\n').length !== 1) fail(`${id}: expected exactly one commit, got:\n${log}`);
    if (log && !/start from the/.test(log)) fail(`${id}: unexpected first commit message: ${log}`);
  }
} catch (e) {
  fail(String(e).split('\n')[0]);
} finally {
  if (errors.length) fail(`renderer errors: ${errors.join(' || ').slice(0, 500)}`);
  await app.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
if (process.exitCode) process.exit(process.exitCode);
console.log('recipes smoke ok: 3 recipes install into empty folders with git init + first commit');
