'use strict';

// Connection doctor: pure interpretation of a node diagnosis. The probes themselves run in
// the main process (nodes:diagnose) — raw TCP, HTTP, a loopback control, the proxy
// environment — and this file turns their results into a verdict a person can act on,
// because "EACCES" alone turned a two-machine Tailscale setup into a guessing game in the
// field. Loaded as a plain <script> and require()d by tests.

// steps: [{ step, ok, detail, ms }] in probe order. Known steps: parse, tcp, http, control.
function diagVerdict(steps, platform) {
  const by = Object.fromEntries((steps || []).map((s) => [s.step, s]));
  const p = platform || 'win32';
  if (by.parse && !by.parse.ok) return 'The node URL is not a valid http(s) URL — fix it in Settings → Ollama nodes.';
  if (by.tcp?.ok && by.http?.ok) return 'Everything works from the app. If tasks still fail, the problem is past the connection (model missing, Ollama version) — check the Test button and the Models window.';
  if (by.tcp?.ok && by.http && !by.http.ok) return `The port answers but does not speak Ollama's API (${by.http.detail}). Something else is listening there — check the address and port.`;
  const code = String(by.tcp?.detail || '');
  const appBlocked = /EACCES|EPERM/.test(code);
  const refused = /ECONNREFUSED/.test(code);
  const timedOut = /ETIMEDOUT|TIMEOUT/i.test(code);
  const controlOk = by.control?.ok === true;
  if (appBlocked) {
    const who = p === 'darwin'
      ? 'macOS is denying this app local-network access: allow Qwen Workspace under System Settings → Privacy & Security → Local Network (relaunch the app if it is not listed).'
      : 'something on THIS computer forbids the app from making this connection — a firewall rule or security software (per-app filtering), not the network';
    return `The OS refused the connection before it left this machine (${code}) — ${who}.${controlOk ? ' Local connections still work, so only outbound/remote traffic is being filtered for this app.' : ''}`;
  }
  if (refused) {
    return `The target actively refused (${code}): nothing is listening at that address and port${controlOk ? ' (local connections from the app work fine)' : ''}. If this is an Ollama PC, check Ollama is running there and OLLAMA_HOST=0.0.0.0 is set; if it is a relay (netsh portproxy), check the relay is registered and the IP Helper service is running.`;
  }
  if (timedOut) {
    return `The connection timed out (${code}): packets go out and nothing comes back. The machine is off or asleep, the VPN/Tailscale link is down on one side, or a firewall on the TARGET machine drops the port.`;
  }
  if (by.tcp && !by.tcp.ok) return `TCP connect failed (${code || 'unknown error'}). ${controlOk ? 'Local connections from the app work, so the path to this node is the problem.' : 'The loopback control also failed — either this PC runs no local Ollama on 11434 (then ignore that probe), or the app itself is blocked by security software.'}`;
  return 'Probes incomplete — run Diagnose again.';
}

// The report block shown under the node list (and worth pasting into a bug report).
function diagReport(nodeName, baseUrl, steps, platform, appVersion) {
  const lines = [`Connection doctor — ${nodeName} (${baseUrl})`, ''];
  for (const s of steps || []) {
    lines.push(`${s.ok ? 'OK  ' : 'FAIL'} ${s.step.padEnd(8)} ${s.detail}${typeof s.ms === 'number' ? ` (${s.ms}ms)` : ''}`);
  }
  lines.push('');
  lines.push(`Verdict: ${diagVerdict(steps, platform)}`);
  lines.push('');
  lines.push(`App ${appVersion || '?'} on ${platform || '?'}`);
  return lines.join('\n');
}

const DiagnoseExports = { diagVerdict, diagReport };
if (typeof module !== 'undefined' && module.exports) module.exports = DiagnoseExports;
if (typeof window !== 'undefined') window.Diagnose = DiagnoseExports;
