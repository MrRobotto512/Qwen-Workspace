'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/renderer/guitest.js');

test('parseActions accepts the short and long forms and rejects junk', () => {
  const r = G.parseActions([{ click: [10.4, 20] }, { action: 'click', x: 5, y: 6 }, { type: '12+7' }, { key: 'Enter' }, { wait: 0.5 }, { action: 'type', text: 'hi' }]);
  assert.deepEqual(r.actions, [{ click: [10, 20] }, { click: [5, 6] }, { type: '12+7' }, { key: 'enter' }, { wait: 0.5 }, { type: 'hi' }]);
  assert.deepEqual(G.parseActions(undefined), { actions: [] });
  assert.match(G.parseActions('click').error, /must be a list/);
  assert.match(G.parseActions([{ click: [-1, 3] }]).error, /pixel coordinates/);
  assert.match(G.parseActions([{ key: 'F13' }]).error, /Unknown key "F13"/);
  assert.match(G.parseActions([{ wait: 99 }]).error, /0–10 seconds/);
  assert.match(G.parseActions([{ drag: 1 }]).error, /Unknown action/);
  assert.match(G.parseActions(Array(21).fill({ wait: 1 })).error, /At most 20/);
});

test('windowIdFromSource and pickWindow find the new app window', () => {
  assert.equal(G.windowIdFromSource('window:2097155:0'), 2097155);
  assert.equal(G.windowIdFromSource('screen:0:0'), null);
  const sources = [{ id: 'window:1:0', name: 'Terminal' }, { id: 'window:2:0', name: 'Qwen Workspace' }, { id: 'window:3:0', name: '' }, { id: 'window:4:0', name: 'Calculator' }, { id: 'window:5:0', name: 'Calc Settings' }];
  const before = new Set(['window:1:0']);
  const own = new Set(['window:2:0']);
  assert.equal(G.pickWindow(sources, before, own).name, 'Calculator');
  assert.equal(G.pickWindow(sources, before, own, 'settings').name, 'Calc Settings');
  assert.equal(G.pickWindow(sources, before, own, 'nope'), null);
  assert.equal(G.pickWindow([{ id: 'window:1:0', name: 'Terminal' }], before, own), null);
});

test('scalePoint and xdotoolSteps map screenshot pixels to the window', () => {
  assert.deepEqual(G.scalePoint([100, 50], { width: 640, height: 400 }, { width: 1280, height: 800 }), [200, 100]);
  assert.deepEqual(G.scalePoint([100, 50], { width: 320, height: 240 }, null), [100, 50]);
  const steps = G.xdotoolSteps([{ click: [10, 20] }, { type: 'abc' }, { key: 'enter' }, { wait: 1 }], 77, { width: 100, height: 100 }, { width: 200, height: 200 });
  assert.deepEqual(steps, [
    ['mousemove', '--window', '77', '20', '40', 'click', '1'],
    ['windowfocus', '--sync', '77'], ['type', '--delay', '40', 'abc'],
    ['windowfocus', '--sync', '77'], ['key', 'Return'],
    { sleep: 1 }
  ]);
});

test('windowsScript escapes SendKeys syntax and quotes; macScript targets the window number', () => {
  assert.equal(G.sendKeysEscape('2+3*(4)'), '2{+}3*{(}4{)}');
  const ps = G.windowsScript(1234, [{ click: [5, 6] }, { type: "it's 1+1" }, { key: 'tab' }, { wait: 0.5 }], { width: 320, height: 240 });
  assert.match(ps, /\$h = \[IntPtr\]1234/);
  assert.match(ps, /\$sx = \(\$r\.R - \$r\.L\) \/ 320; \$sy = \(\$r\.B - \$r\.T\) \/ 240/);
  assert.match(ps, /SetCursorPos\(\[int\]\(\$r\.L \+ 5 \* \$sx\), \[int\]\(\$r\.T \+ 6 \* \$sy\)\)/);
  assert.match(ps, /SendWait\('it''s 1\{\+\}1'\)/);
  assert.match(ps, /SendWait\('\{TAB\}'\)/);
  assert.match(ps, /Start-Sleep -Milliseconds 500/);
  const js = G.macScript(88, [{ click: [1, 2] }, { type: 'a"b' }, { key: 'enter' }], { width: 10, height: 10 });
  assert.match(js, /kCGWindowNumber === 88/);
  assert.match(js, /click\(1, 2\);/);
  assert.match(js, /se\.keystroke\("a\\"b"\)/);
  assert.match(js, /se\.keyCode\(36\)/);
});

test('summarize reports crashes, missing windows and successful runs', () => {
  assert.match(G.summarize({ windowFound: false, exitCode: 1, output: 'Traceback: ImportError PySide6' }), /exited \(exit code 1\) before any window appeared[\s\S]*ImportError PySide6/);
  assert.match(G.summarize({ windowFound: false, exitCode: null, waitSeconds: 8, windowTitle: 'Calc' }), /No new window appeared within 8s with "Calc" in its title/);
  const ok = G.summarize({ windowFound: true, windowTitle: 'Calculator', windowAfterMs: 1500, alive: true, actions: [{ click: [1, 2] }, { type: '7' }], shot: { width: 320, height: 240 }, output: '' }, true);
  assert.match(ok, /Window "Calculator" appeared after 1\.5s\./);
  assert.match(ok, /Actions: clicked \(1, 2\); typed "7"\./);
  assert.match(ok, /still running at the end/);
  assert.match(ok, /screenshot of the window is attached \(320×240 px\)/);
  assert.match(G.summarize({ windowFound: true, windowTitle: 'C', windowAfterMs: 1, alive: true, shot: { width: 1, height: 1 } }, false), /cannot see images/);
  assert.equal(G.summarize({ error: 'empty command' }), 'Error: empty command');
});

test('webTarget spots web pages behind start/open, and single-letter keys parse', () => {
  assert.deepEqual(G.webTarget('start D:/GAme Test with QWS/subwaysurfer/index.html'), { file: 'D:/GAme Test with QWS/subwaysurfer/index.html' });
  assert.deepEqual(G.webTarget('start "" "game/index.html"'), { file: 'game/index.html' });
  assert.deepEqual(G.webTarget('open index.htm'), { file: 'index.htm' });
  assert.deepEqual(G.webTarget('http://localhost:5173/'), { url: 'http://localhost:5173/' });
  assert.equal(G.webTarget('python main.py'), null);
  assert.equal(G.webTarget('cat a.html | more'), null);
  assert.deepEqual(G.parseActions([{ key: 'ArrowLeft' }, { key: 'W' }, { key: '7' }]).actions, [{ key: 'left' }, { key: 'w' }, { key: '7' }]);
  assert.equal(G.electronKey('left'), 'Left');
  assert.equal(G.electronKey('w'), 'w');
  assert.deepEqual(G.xdotoolSteps([{ key: 'w' }], 5, null, null).at(-1), ['key', 'w']);
  assert.match(G.summarizePage({ loaded: true, title: 'G', errors: ['Uncaught ReferenceError: animate is not defined (main.js:5)'], logs: ['ready'], shot: { width: 1024, height: 768 } }, true), /Page "G" loaded\.\nConsole errors \(1\) — fix these first:\n- Uncaught ReferenceError[\s\S]*Console output \(last 1\):\n  ready[\s\S]*attached \(1024×768 px\)/);
  assert.match(G.summarizePage({ loaded: false, loadError: 'ERR_FILE_NOT_FOUND' }, false), /did not load: ERR_FILE_NOT_FOUND/);
});

test('pixel check flags a flat screenshot', () => {
  const flat = new Uint8Array(100 * 100 * 4).fill(20);
  const st = G.pixelStats(flat, 100, 100);
  assert.equal(st.topShare, 1);
  assert.match(G.pixelNote(st), /100% one colour/);
  const busy = new Uint8Array(100 * 100 * 4);
  for (let i = 0; i < busy.length; i++) busy[i] = (i * 37) % 256;
  assert.equal(G.pixelNote(G.pixelStats(busy, 100, 100)), '');
  assert.equal(G.pixelNote(null), '');
});
