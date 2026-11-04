'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require('../src/cmdrun.js');
const B = require('../src/renderer/browserctl.js');

test('Git Unix tools go after the system PATH', () => {
  const g = C.gitPathParts('C:\\Program Files\\Git\\cmd', path.win32.join);
  assert.deepStrictEqual(g.before, ['C:\\Program Files\\Git\\cmd', 'C:\\Program Files\\Git\\bin', 'C:\\Program Files\\Git\\mingw64\\bin']);
  assert.deepStrictEqual(g.after, ['C:\\Program Files\\Git\\usr\\bin']);
  assert.deepStrictEqual(C.gitPathParts('C:\\Git\\cmd', path.win32.join, (p) => !/mingw64/.test(p)).before, ['C:\\Git\\cmd', 'C:\\Git\\bin']);
  assert.deepStrictEqual(C.gitPathParts(null, path.join), { before: [], after: [] });
});

test('timeout /t becomes a ping wait', () => {
  const r = C.rewriteWindowsWait('start /b python -m http.server 8765 >nul 2>&1 & timeout /t 2 >nul & curl -s http://localhost:8765/');
  assert.ok(r.changed);
  assert.strictEqual(r.command, 'start /b python -m http.server 8765 >nul 2>&1 & ping -n 3 127.0.0.1 >nul & curl -s http://localhost:8765/');
  assert.strictEqual(C.rewriteWindowsWait('timeout /t 5 /nobreak && dir').command, 'ping -n 6 127.0.0.1 >nul && dir');
  assert.strictEqual(C.rewriteWindowsWait('timeout /T 0').command, 'ping -n 1 127.0.0.1 >nul');
  for (const keep of ['npm test -- --timeout 5000', 'git config http.timeout 30', 'echo timeout', 'node x.js --timeout /t']) {
    assert.strictEqual(C.rewriteWindowsWait(keep).changed, false, keep);
  }
});

test('servers are recognised, other commands are not', () => {
  for (const s of ['python -m http.server 8765', 'start /b python -m http.server 8765 >nul 2>&1', 'py -3 -m http.server', 'python3 -u -m http.server 9000', 'npx http-server -p 8080', 'npx serve .', 'npm run dev', 'npm start', 'pnpm dev', 'npx vite', 'vite --port 3000', 'flask run', 'uvicorn main:app --reload', 'python manage.py runserver', 'php -S localhost:8000', 'npm run build && npm run preview']) {
    assert.ok(C.isServerCommand(s), s);
  }
  for (const s of ['npm install vite', 'npm run build', 'npm test', 'vite build', 'python main.py', 'echo serve the food', 'git status', 'node server-check.js', 'curl http://localhost:8765/']) {
    assert.ok(!C.isServerCommand(s), s);
  }
});

test('only a server in the foreground counts', () => {
  assert.ok(C.foregroundServer('python -m http.server 8000', 'linux'));
  assert.ok(C.foregroundServer('npm run build && npm run preview', 'win32'));
  assert.ok(!C.foregroundServer('python3 -m http.server 8000 & sleep 1; curl localhost:8000', 'linux'));
  assert.ok(C.foregroundServer('python -m http.server 8000 & curl localhost:8000', 'win32'));
  assert.ok(!C.foregroundServer('start /b python -m http.server 8765 >nul 2>&1 & timeout /t 2 >nul & curl -s http://localhost:8765/', 'win32'));
  assert.ok(!C.foregroundServer('npm test', 'linux'));
});

test('server readiness lines', () => {
  for (const t of ['Serving HTTP on :: port 8765 (http://[::]:8765/) ...', '  ➜  Local:   http://localhost:5173/', 'Server listening on 3000', ' * Running on http://127.0.0.1:5000', 'VITE v5.0.0  ready in 300 ms']) assert.ok(C.SERVER_UP.test(t), t);
  assert.ok(!C.SERVER_UP.test('building for production...'));
});

test('background note says how to stop it and points at test_app', () => {
  const w = C.backgroundNote({ pids: [4242], platform: 'win32' });
  assert.match(w, /still running in the background \(process 4242\)/);
  assert.match(w, /taskkill \/PID 4242 \/T \/F/);
  assert.match(w, /do not start it again/);
  assert.match(w, /test_app opens an \.html file directly/);
  assert.match(C.backgroundNote({ pids: [7], foreground: true, platform: 'linux' }), /once it was up QWS moved it to the background[\s\S]*kill 7/);
  assert.deepStrictEqual(C.parsePids('\r\n1234\r\n  88 \r\nfoo\r\n1234\r\n'), [1234, 88]);
  assert.ok(C.describe('x'.repeat(300)).length <= 120);
});

test('the browser tools send project pages to test_app', () => {
  const root = 'C:\\Users\\ryan3\\AppData\\Roaming\\Qwen Workspace\\bench\\run\\web-counter';
  const r = B.localFileRedirect('browser_navigate', { url: 'file:///C:/Users/ryan3/AppData/Roaming/Qwen%20Workspace/bench/run/web-counter/counter.html' }, root);
  assert.match(r, /^Not run: the browser tools do not open files/);
  assert.match(r, /test_app with \{"command": "counter.html"\}/);
  assert.match(B.localFileRedirect('browser_navigate', { url: 'file:///home/u/elsewhere/x.html' }, '/home/u/proj'), /"\/home\/u\/elsewhere\/x.html"/);
  assert.match(B.localFileRedirect('browser_navigate', { url: 'game/index.html' }, '/p'), /"game\/index.html"/);
  assert.strictEqual(B.localFileRedirect('browser_navigate', { url: 'http://localhost:8765/counter.html' }, '/p'), null);
  assert.strictEqual(B.localFileRedirect('browser_navigate', { url: 'https://example.com/a.html' }, '/p'), null);
  assert.strictEqual(B.localFileRedirect('browser_click', { url: 'file:///x.html' }, '/p'), null);
});
