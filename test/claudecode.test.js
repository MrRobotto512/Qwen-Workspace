const test = require('node:test');
const assert = require('node:assert');
const CC = require('../src/renderer/claudecode.js');

test('ccBaseUrl strips /v1 and trailing slashes — the Anthropic API lives at the root', () => {
  assert.strictEqual(CC.ccBaseUrl({ baseUrl: 'http://localhost:11434/v1' }), 'http://localhost:11434');
  assert.strictEqual(CC.ccBaseUrl({ baseUrl: 'http://100.88.91.13:11434/' }), 'http://100.88.91.13:11434');
  assert.strictEqual(CC.ccBaseUrl({ baseUrl: 'http://x:11434' }), 'http://x:11434');
});

test('ollamaSupportsAnthropic gates on 0.14', () => {
  assert.strictEqual(CC.ollamaSupportsAnthropic('0.13.5'), false);
  assert.strictEqual(CC.ollamaSupportsAnthropic('0.14.0'), true);
  assert.strictEqual(CC.ollamaSupportsAnthropic('0.20.1'), true);
  assert.strictEqual(CC.ollamaSupportsAnthropic('1.0.0'), true);
  assert.strictEqual(CC.ollamaSupportsAnthropic(undefined), true); // unknown never blocks
});

test('sortModelsForClaude puts catalog models strongest-first, the rest after', () => {
  const catalog = [
    { id: 'qwen3-coder:30b', rank: 10 },
    { id: 'qwen2.5-coder:7b', rank: 4.5 }
  ];
  const sorted = CC.sortModelsForClaude(['mystery:1b', 'qwen2.5-coder:7b', 'qwen3-coder:30b'], catalog);
  assert.deepStrictEqual(sorted, ['qwen3-coder:30b', 'qwen2.5-coder:7b', 'mystery:1b']);
});

test('buildClaudeLaunch wires the environment on every platform', () => {
  const url = 'http://100.88.91.13:11434';
  const win = CC.buildClaudeLaunch('win32', 'C:\\My Projects\\app', url, 'qwen3-coder:30b');
  assert.ok(win.startsWith('start "Claude Code" /D "C:\\My Projects\\app" cmd /k "'), win);
  assert.ok(win.includes(`set ANTHROPIC_BASE_URL=${url}&& `), 'no space may precede && or it lands in the value');
  assert.ok(win.includes('set ANTHROPIC_AUTH_TOKEN=ollama&& '), win);
  assert.ok(win.endsWith('claude --model qwen3-coder:30b"'), win);

  const mac = CC.buildClaudeLaunch('darwin', '/Users/ryan/My App', url, 'qwen3-coder:30b');
  assert.ok(mac.startsWith("osascript -e 'tell application \"Terminal\" to do script \""), mac);
  assert.ok(mac.includes('cd \\"/Users/ryan/My App\\" && '), 'the dir is quoted for the inner shell, escaped for AppleScript');
  assert.ok(mac.includes(`ANTHROPIC_BASE_URL=${url} ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= claude --model qwen3-coder:30b`), mac);
  assert.ok(mac.endsWith("-e 'tell application \"Terminal\" to activate'"), mac);
  assert.ok(!mac.includes("'\\''"), 'no single quotes may appear inside the single-quoted osascript args');

  const lin = CC.buildClaudeLaunch('linux', '/home/ryan/app', url, 'qwen3-coder:30b');
  assert.ok(lin.includes(`x-terminal-emulator -e bash -lc 'cd "/home/ryan/app" && ANTHROPIC_BASE_URL=${url}`), lin);
  assert.ok(lin.includes('|| xterm -e bash -lc '), lin);
});

test('buildClaudeLaunch refuses anything it cannot place in a command safely', () => {
  const url = 'http://x:11434';
  assert.strictEqual(CC.buildClaudeLaunch('linux', '/ok', url, 'bad model name'), null); // space
  assert.strictEqual(CC.buildClaudeLaunch('linux', '/ok', url, 'model;rm -rf /'), null);
  assert.strictEqual(CC.buildClaudeLaunch('linux', '/has"quote', url, 'qwen3:8b'), null);
  assert.strictEqual(CC.buildClaudeLaunch('darwin', "/has'quote", url, 'qwen3:8b'), null);
  assert.strictEqual(CC.buildClaudeLaunch('linux', '', url, 'qwen3:8b'), null);
  assert.ok(CC.buildClaudeLaunch('linux', '/ok', url, 'hf.co/unsloth/Qwen3-32B-128K-GGUF:Q4_K_M'), 'hf.co tags are legal');
});
