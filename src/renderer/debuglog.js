'use strict';

// Debug reports: every conversation keeps a compact, structured event log (requests,
// responses, tool runs, recoveries, errors), and "Save debug report" renders it — together
// with redacted settings and the full message history — into one markdown file under
// .qwen/debug/. The point: when the agent misbehaves, the report alone is enough to
// diagnose it (by a person, or by pointing a planner-model chat at the file), instead of
// screenshots that lose the system prompt and the recovery timeline.
// This file is pure (no DOM, no fs); the taps and the export button live elsewhere.

const DebugLogExports = (() => {
const LOG_CAP = 600; // events per conversation; oldest drop first

function add(c, kind, data) {
  if (!c) return;
  c.log = c.log || [];
  c.log.push({ at: Date.now(), kind, ...data });
  if (c.log.length > LOG_CAP) c.log.splice(0, c.log.length - LOG_CAP);
}

// Settings safe to put in a report: every key that smells like a secret is masked, deep.
// Anchored so counters survive: maxResponseTokens or promptTokens are numbers, not secrets.
const SECRET_KEY = /secret|password|key$|token$/i;

function redactSettings(s) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEY.test(k) ? (val ? '•••redacted•••' : '') : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(s || {});
}

function clock(at, t0) {
  return `+${((at - t0) / 1000).toFixed(1)}s`;
}

function line(ev, t0) {
  const t = clock(ev.at, t0);
  switch (ev.kind) {
    case 'request': return `${t} → request step ${ev.step + 1} · ${ev.model}${ev.provider ? ` (${ev.provider})` : ''}${ev.node ? ` · node ${ev.node}` : ''}${ev.escalated ? ' · ESCALATED' : ''}`;
    case 'response': return `${t} ← ${!ev.ok ? `MODEL ERROR: ${ev.error}` : ev.aborted ? 'ABORTED (the user clicked Stop)' : `ok · finish=${ev.finishReason || '-'} · ${ev.chars || 0} chars · ${ev.toolCalls || 0} tool calls${ev.promptTokens ? ` · ${ev.promptTokens} in/${ev.completionTokens || 0} out tokens` : ''}`}`;
    case 'tool': return `${t}   tool ${ev.name}${ev.meta ? ` (${ev.meta})` : ''} · ${ev.rejected ? 'REJECTED by user' : ev.failed ? 'FAILED' : 'ok'}${ev.ms ? ` · ${(ev.ms / 1000).toFixed(1)}s` : ''}`;
    case 'notice': return `${t} ⚑ ${ev.text}`;
    case 'escalate': return `${t} ⚑ intervention #${ev.interventions}: ${ev.reason}${ev.takeover ? ' → planner takeover' : ''}`;
    case 'compact': return `${t} ⚑ compacted context: ~${ev.before} → ~${ev.after} tokens`;
    case 'error': return `${t} ✖ ${ev.text}`;
    default: return `${t} ${ev.kind} ${JSON.stringify({ ...ev, at: undefined, kind: undefined })}`;
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} more chars truncated for the report]`;
}

// One markdown report: environment, redacted settings, the event timeline, and the full
// history (tool results shortened — they dominate the bytes and rarely the diagnosis).
function render({ conv, settings, appInfo, nodeHealth, mcp, systemPrompt }) {
  const t0 = conv.createdAt || conv.log?.[0]?.at || Date.now();
  const out = [];
  out.push(`# Debug report — ${conv.title || conv.id}`);
  out.push('');
  out.push(`- App: Qwen Workspace ${appInfo?.version || '?'} on ${appInfo?.platform || '?'}`);
  out.push(`- Conversation: ${conv.id} · mode ${conv.mode} · status ${conv.status} · created ${new Date(conv.createdAt || Date.now()).toISOString()}`);
  out.push(`- Model: ${conv.model || settings?.model} (${settings?.provider}) · planner: ${settings?.heavy?.enabled ? `${settings.heavy.model} (${settings.heavy.provider})` : 'off'}`);
  out.push(`- Context used: ${conv.usage ? `${conv.usage.promptTokens} of ${conv.usage.contextLength} tokens` : 'unknown'} · compactions: ${conv.compactions || 0}`);
  if (mcp?.length) out.push(`- MCP servers: ${mcp.map((m) => `${m.id}=${m.status}${m.error ? ` (${m.error})` : ''}`).join(', ')}`);
  if (nodeHealth && Object.keys(nodeHealth.byId || {}).length) {
    out.push(`- Nodes: ${Object.entries(nodeHealth.byId).map(([id, h]) => `${id}=${h.up ? `up (${(h.models || []).length} models)` : `down (${h.error || '?'})`}`).join(', ')}`);
  }
  out.push('');
  out.push('## Settings (secrets redacted)');
  out.push('');
  out.push('```json');
  out.push(JSON.stringify(redactSettings(settings), null, 2));
  out.push('```');
  out.push('');
  out.push('## Event timeline');
  out.push('');
  out.push('```');
  for (const ev of conv.log || []) out.push(line(ev, t0));
  if (!(conv.log || []).length) out.push('(no events recorded — the conversation predates the debug log)');
  out.push('```');
  out.push('');
  out.push('## Full message history (what the model saw)');
  out.push('');
  if (systemPrompt) {
    // The system prompt is assembled fresh on every request, so it lives here, not in history.
    out.push(`### system (assembled at request time)\n\n\`\`\`\n${truncate(systemPrompt, 10000)}\n\`\`\``);
    out.push('');
  }
  for (const m of conv.history || []) {
    if (m.role === 'system') {
      out.push(`### system\n\n\`\`\`\n${truncate(m.content, 8000)}\n\`\`\``);
    } else if (m.role === 'tool') {
      out.push(`### tool result (${m.tool_call_id})\n\n\`\`\`\n${truncate(m.content, 1500)}\n\`\`\``);
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((tc) => `\n→ CALL ${tc.function.name}(${truncate(tc.function.arguments, 600)})  [${tc.id}]`).join('');
      out.push(`### assistant\n\n\`\`\`\n${truncate(m.content, 3000)}${calls}\n\`\`\``);
    } else {
      out.push(`### ${m.role}\n\n\`\`\`\n${truncate(m.content, 3000)}\n\`\`\``);
    }
    out.push('');
  }
  out.push('---');
  out.push('To diagnose: open a new conversation (ideally on the planner model) and ask it to read this file and explain what went wrong and what to change.');
  out.push('');
  return out.join('\n');
}

  return { LOG_CAP, add, redactSettings, render };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DebugLogExports;
if (typeof window !== 'undefined') window.DebugLog = DebugLogExports;
