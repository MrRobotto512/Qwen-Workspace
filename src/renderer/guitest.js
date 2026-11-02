'use strict';

// Test built GUI apps: launch the app the agent just built, wait for its window, screenshot just
// that window, optionally click / type / press keys in it like a user would, screenshot again,
// and report whether it is still running plus its console output — then close it. The window is
// found by diffing the desktop's window list before and after launch (Electron desktopCapturer);
// input goes through the platform's own automation: xdotool on Linux, user32 via PowerShell on
// Windows, System Events via osascript on macOS. This file is the pure part: action parsing,
// window picking, coordinate scaling, the per-platform scripts, and the summary for the model.

const MAX_ACTIONS = 20;
const SHOT_BOX = 1024; // screenshots fit in 1024×1024 (Chromium scales small windows UP to the box)

// Keys the model may press, with each platform's name for them.
const KEYS = {
  enter: { x: 'Return', w: '{ENTER}', m: 36 },
  return: { x: 'Return', w: '{ENTER}', m: 36 },
  tab: { x: 'Tab', w: '{TAB}', m: 48 },
  escape: { x: 'Escape', w: '{ESC}', m: 53 },
  esc: { x: 'Escape', w: '{ESC}', m: 53 },
  backspace: { x: 'BackSpace', w: '{BACKSPACE}', m: 51 },
  delete: { x: 'Delete', w: '{DELETE}', m: 117 },
  space: { x: 'space', w: ' ', m: 49 },
  up: { x: 'Up', w: '{UP}', m: 126 },
  down: { x: 'Down', w: '{DOWN}', m: 125 },
  left: { x: 'Left', w: '{LEFT}', m: 123 },
  right: { x: 'Right', w: '{RIGHT}', m: 124 },
  home: { x: 'Home', w: '{HOME}', m: 115 },
  end: { x: 'End', w: '{END}', m: 119 }
};

// The model's actions → { actions } or { error }. Accepted shapes: {click:[x,y]},
// {type:"text"}, {key:"Enter"}, {wait:1.5}; also {action:"click", x, y} and friends.
function parseActions(raw) {
  if (raw == null) return { actions: [] };
  if (!Array.isArray(raw)) return { error: '"actions" must be a list, e.g. [{"click": [120, 80]}, {"type": "12+7"}, {"key": "Enter"}].' };
  if (raw.length > MAX_ACTIONS) return { error: `At most ${MAX_ACTIONS} actions per test.` };
  const actions = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') return { error: `Not an action: ${JSON.stringify(a)}` };
    const kind = a.action || Object.keys(a).find((k) => ['click', 'type', 'key', 'wait'].includes(k));
    if (kind === 'click') {
      const pt = Array.isArray(a.click) ? a.click : [a.x, a.y];
      const [x, y] = pt.map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return { error: `A click needs pixel coordinates in the screenshot: {"click": [x, y]} (got ${JSON.stringify(a)}).` };
      actions.push({ click: [Math.round(x), Math.round(y)] });
    } else if (kind === 'type') {
      const text = String(a.type === true || a.action ? a.text ?? '' : a.type ?? '');
      if (!text || text.length > 500) return { error: 'A type action needs 1–500 characters of text.' };
      actions.push({ type: text });
    } else if (kind === 'key') {
      const k = String(a.key || '').trim().toLowerCase();
      if (!KEYS[k]) return { error: `Unknown key "${a.key}". Use one of: ${Object.keys(KEYS).join(', ')}.` };
      actions.push({ key: k });
    } else if (kind === 'wait') {
      const s = Number(a.wait ?? a.seconds);
      if (!Number.isFinite(s) || s <= 0 || s > 10) return { error: 'A wait is 0–10 seconds: {"wait": 1}.' };
      actions.push({ wait: s });
    } else {
      return { error: `Unknown action ${JSON.stringify(a)}. Use {"click": [x, y]}, {"type": "text"}, {"key": "Enter"} or {"wait": 1}.` };
    }
  }
  return { actions };
}

// desktopCapturer ids look like "window:<native id>:0" — the X11 window id, the Win32 HWND, or
// the macOS CGWindowID — which is exactly what each platform's input tool needs.
function windowIdFromSource(id) {
  const m = /^window:(\d+):/.exec(String(id || ''));
  return m ? Number(m[1]) : null;
}

// The app's window: one that was not there before launch and is not one of QWS's own; with a
// title hint, the first whose title contains it (case-insensitive).
function pickWindow(sources, beforeIds, ownIds, titleHint) {
  const hint = String(titleHint || '').trim().toLowerCase();
  const fresh = (sources || []).filter((s) => !beforeIds.has(s.id) && !ownIds.has(s.id) && String(s.name || '').trim());
  if (hint) return fresh.find((s) => s.name.toLowerCase().includes(hint)) || null;
  return fresh[0] || null;
}

// Screenshot pixels → window pixels, when the screenshot was scaled to fit SHOT_BOX.
function scalePoint([x, y], shot, win) {
  const sx = shot?.width && win?.width ? win.width / shot.width : 1;
  const sy = shot?.height && win?.height ? win.height / shot.height : 1;
  return [Math.round(x * sx), Math.round(y * sy)];
}

// Linux: xdotool argument lists, one per step (a wait is { sleep: seconds }).
function xdotoolSteps(actions, wid, shot, win) {
  const steps = [];
  for (const a of actions) {
    if (a.click) {
      const [x, y] = scalePoint(a.click, shot, win);
      steps.push(['mousemove', '--window', String(wid), String(x), String(y), 'click', '1']);
    } else if (a.type) {
      steps.push(['windowfocus', '--sync', String(wid)], ['type', '--delay', '40', a.type]);
    } else if (a.key) {
      steps.push(['windowfocus', '--sync', String(wid)], ['key', KEYS[a.key].x]);
    } else if (a.wait) {
      steps.push({ sleep: a.wait });
    }
  }
  return steps;
}

// SendKeys treats + ^ % ~ ( ) { } [ ] as syntax; each must be wrapped in braces to be typed.
function sendKeysEscape(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (ch) => `{${ch}}`);
}
const psString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Windows: one PowerShell script that brings the window forward and performs every action.
// GetWindowRect is the whole window, which is what the window screenshot shows too.
function windowsScript(hwnd, actions, shot) {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public struct QRECT { public int L; public int T; public int R; public int B; }',
    'public static class QW {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out QRECT r);',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);',
    '}',
    '"@',
    `$h = [IntPtr]${Number(hwnd)}`,
    '$r = New-Object QRECT',
    'if (-not [QW]::GetWindowRect($h, [ref]$r)) { throw "The app window is gone." }',
    `$sx = ($r.R - $r.L) / ${shot?.width || 1}; $sy = ($r.B - $r.T) / ${shot?.height || 1}`,
    '[void][QW]::SetForegroundWindow($h); Start-Sleep -Milliseconds 300'
  ];
  for (const a of actions) {
    if (a.click) {
      lines.push(`[void][QW]::SetCursorPos([int]($r.L + ${a.click[0]} * $sx), [int]($r.T + ${a.click[1]} * $sy)); Start-Sleep -Milliseconds 80; [QW]::mouse_event(2,0,0,0,0); [QW]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 250`);
    } else if (a.type) {
      lines.push(`[void][QW]::SetForegroundWindow($h); [System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeysEscape(a.type))}); Start-Sleep -Milliseconds 200`);
    } else if (a.key) {
      lines.push(`[void][QW]::SetForegroundWindow($h); [System.Windows.Forms.SendKeys]::SendWait(${psString(KEYS[a.key].w)}); Start-Sleep -Milliseconds 200`);
    } else if (a.wait) {
      lines.push(`Start-Sleep -Milliseconds ${Math.round(a.wait * 1000)}`);
    }
  }
  return lines.join('\n');
}

// macOS: a JavaScript-for-Automation script. The window's bounds come from CoreGraphics by its
// window number; clicks and keys go through System Events, which needs QWS to be allowed under
// Privacy & Security → Accessibility.
function macScript(windowNumber, actions, shot) {
  const steps = actions.map((a) => {
    if (a.click) return `click(${a.click[0]}, ${a.click[1]});`;
    if (a.type) return `se.keystroke(${JSON.stringify(a.type)}); delay(0.2);`;
    if (a.key) return `se.keyCode(${KEYS[a.key].m}); delay(0.2);`;
    if (a.wait) return `delay(${a.wait});`;
    return '';
  });
  return [
    "ObjC.import('CoreGraphics');",
    `const info = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)).find((w) => w.kCGWindowNumber === ${Number(windowNumber)});`,
    "if (!info) throw new Error('The app window is gone.');",
    'const b = info.kCGWindowBounds;',
    `const sx = b.Width / ${shot?.width || 1}, sy = b.Height / ${shot?.height || 1};`,
    "const se = Application('System Events');",
    "const owner = se.processes.whose({ unixId: info.kCGWindowOwnerPID })[0]; owner.frontmost = true; delay(0.3);",
    'function click(x, y) { se.click({ at: [Math.round(b.X + x * sx), Math.round(b.Y + y * sy)] }); delay(0.25); }',
    ...steps
  ].join('\n');
}

function describeAction(a) {
  if (a.click) return `clicked (${a.click[0]}, ${a.click[1]})`;
  if (a.type) return `typed "${a.type.slice(0, 40)}"`;
  if (a.key) return `pressed ${a.key}`;
  return `waited ${a.wait}s`;
}

// The report for the model. `r` is what the main process returned; `sent` says whether the
// screenshot is attached for the model to see.
function summarize(r, sent) {
  const lines = [];
  if (r.error) return `Error: ${r.error}`;
  if (!r.windowFound) {
    lines.push(r.exitCode != null
      ? `The app exited (exit code ${r.exitCode}) before any window appeared — it most likely crashed on startup.`
      : `No new window appeared within ${r.waitSeconds}s${r.windowTitle ? ` with "${r.windowTitle}" in its title` : ''}. The app may still be starting, may have no window, or the title hint may not match.`);
  } else {
    lines.push(`Window "${r.windowTitle}" appeared after ${(r.windowAfterMs / 1000).toFixed(1)}s.`);
    if (r.actions?.length) lines.push(`Actions: ${r.actions.map(describeAction).join('; ')}.${r.actionError ? ` Stopped early: ${r.actionError}` : ''}`);
    lines.push(r.alive ? 'The app was still running at the end of the test; it has been closed.' : `The app exited (exit code ${r.exitCode}) during the test.`);
    if (r.shot) {
      lines.push(sent
        ? `A screenshot of the window is attached (${r.shot.width}×${r.shot.height} px). Click coordinates for the next test_app call are pixels in this screenshot.`
        : `A ${r.shot.width}×${r.shot.height} screenshot was taken, but the current model does not look able to see images, so only the text above is reported.`);
    } else {
      lines.push('The window could not be captured (on macOS, QWS needs Screen Recording permission).');
    }
  }
  const out = String(r.output || '').trim();
  lines.push(out ? `Console output:\n${out.length > 4000 ? '…' + out.slice(-4000) : out}` : 'Console output: (none)');
  return lines.join('\n');
}

const GuiTestExports = { MAX_ACTIONS, SHOT_BOX, KEYS, parseActions, windowIdFromSource, pickWindow, scalePoint, xdotoolSteps, sendKeysEscape, windowsScript, macScript, describeAction, summarize };
if (typeof module !== 'undefined' && module.exports) module.exports = GuiTestExports;
if (typeof window !== 'undefined') window.GuiTest = GuiTestExports;
