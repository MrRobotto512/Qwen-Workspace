'use strict';

// Self-written skills (an idea from Hermes Agent's agent-managed skills + curator). After a long
// task that worked, a teacher model turns what the task did into a reusable SKILL.md — "lessons,
// not logs": the procedure, the commands that worked, the pitfalls — shown in an approval card
// and saved to the personal skills folder only when the user says so. Skills QWS wrote are
// tracked (uses, last used); the curator marks unused ones stale and later archives them, so the
// <skills> list does not fill up with one-offs. This file is the pure logic: no DOM, no fs.

// A task this long is worth a skill; shorter ones only when a stronger model had to rescue it
// (the rescue is exactly the knowledge the everyday model was missing).
const MIN_STEPS = 8;
const MIN_STEPS_RESCUED = 3;
const STALE_DAYS = 30;
const ARCHIVE_DAYS = 60;
const BODY_CAP = 6000;
const SIMILAR = 0.6;
const DAY = 86400000;

function shouldPropose(o) {
  if (!o || o.enabled === false || !o.agent || o.failed || o.stopped || o.already || o.usedSkill) return false;
  const steps = o.steps || 0;
  return steps >= MIN_STEPS || (!!o.rescued && steps >= MIN_STEPS_RESCUED);
}

const isReminder = (m) => m?.role === 'user' && /^\s*<system-reminder>/.test(String(m.content || ''));

// Where the current task began: the given index when the caller tracked it, otherwise the last
// user message that is not an app-injected reminder.
function taskStartIndex(history, start) {
  const h = history || [];
  if (Number.isInteger(start) && start >= 0 && start < h.length) return start;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'user' && !isReminder(h[i])) return i;
  return 0;
}

function argSummary(name, raw) {
  let a = {};
  try {
    a = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  } catch {
    return String(raw || '').slice(0, 80);
  }
  if (a.command) return String(a.command).slice(0, 160);
  if (a.path) return String(a.path).slice(0, 120);
  if (a.query) return String(a.query).slice(0, 120);
  if (a.name) return String(a.name).slice(0, 80);
  if (a.url) return String(a.url).slice(0, 120);
  return JSON.stringify(a).slice(0, 80);
}

const failedResult = (text) => /^Error\b|^Exit code: (?!0\b)-?\d+|^The user (?:declined|rejected)\b/i.test(String(text || '').trim());

// What the task did, compactly, for the teacher: the request, each tool step with its outcome
// (failures carry a snippet of their output so the teacher can pair an error with its fix),
// and the final answer.
function taskDigest(history, start, maxChars = 5000) {
  const h = history || [];
  const s = taskStartIndex(h, start);
  const request = String(h[s]?.content || '').split('\n---\nAttached context:')[0].trim().slice(0, 600);
  const pending = new Map();
  const lines = [];
  let steps = 0;
  let failed = 0;
  let answer = '';
  for (let i = s + 1; i < h.length; i++) {
    const m = h[i];
    if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) pending.set(tc.id, `${tc.function?.name}(${argSummary(tc.function?.name, tc.function?.arguments)})`);
      } else if (String(m.content || '').trim()) {
        answer = String(m.content).trim();
      }
    } else if (m.role === 'tool' && pending.has(m.tool_call_id)) {
      steps++;
      const text = String(m.content || '');
      if (failedResult(text)) {
        failed++;
        lines.push(`${steps}. ${pending.get(m.tool_call_id)} -> FAILED: ${text.replace(/\s+/g, ' ').slice(0, 240)}`);
      } else {
        lines.push(`${steps}. ${pending.get(m.tool_call_id)} -> ok`);
      }
      pending.delete(m.tool_call_id);
    } else if (m.role === 'user' && !isReminder(m) && i > s) {
      lines.push(`(user added: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 200)})`);
    }
  }
  let body = lines.join('\n');
  if (body.length > maxChars) body = '…\n' + body.slice(body.length - maxChars);
  const text = `The user asked:\n${request || '(no text)'}\n\nWhat the agent did (${steps} tool steps, ${failed} failed):\n${body || '(no tool steps)'}\n\nThe agent's final answer:\n${answer.slice(0, 800) || '(none)'}`;
  return { steps, failed, request, text };
}

const SKILL_WRITER_SYSTEM = `You write reusable skills for an AI coding agent. A skill is a SKILL.md file the agent loads before a task it covers. From the finished task below, decide whether it holds a REUSABLE procedure — something the agent will likely do again (in this or another project) and would do faster and with fewer mistakes with written guidance. If it was a one-off (a specific bug, a question, trivial edits), reply with exactly NONE.

Otherwise reply with only the SKILL.md, in this shape:
---
name: short-kebab-case-name
description: One line saying WHEN to use this skill (the agent picks skills by this line)
---
# Title

## When to use
## Steps
Numbered, concrete, in the order that worked.
## Commands
The exact commands that worked, in code blocks.
## Pitfalls
Each error the task hit and the fix that worked; wrong turns to avoid.

Write lessons, not logs: general instructions for the next time, not a story of this run. No project-specific file names unless every project of this kind has them. Keep it under 60 lines.`;

function slugName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

// The teacher's reply → a draft, or null (NONE, missing front matter, too thin to be useful).
// The file is rebuilt from its parts so the front matter is always clean and marks QWS as author.
function parseSkillDraft(reply) {
  let t = String(reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(t);
  if (fenced) t = fenced[1].trim();
  if (/^NONE\.?$/i.test(t)) return null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  if (!fm) return null;
  const meta = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  const name = slugName(meta.name);
  const description = String(meta.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let body = t.slice(fm[0].length).trim();
  if (name.length < 3 || description.length < 10 || body.length < 80) return null;
  if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP).replace(/\n[^\n]*$/, '') + '\n…';
  const content = `---\nname: ${name}\ndescription: ${description}\ncreated_by: qws\n---\n\n${body}\n`;
  return { name, description, body, content };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'use', 'when', 'how', 'this', 'that', 'from', 'into', 'your', 'you', 'app', 'apps', 'skill', 'using', 'build', 'make', 'create', 'new']);
function words(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

// An existing skill that already covers the draft (same name, or name + description words
// overlapping by Jaccard ≥ 0.6) — then no card: the skill exists, it just was not loaded.
function similarSkill(draft, skills) {
  const dw = words(`${draft?.name?.replace(/-/g, ' ')} ${draft?.description}`);
  for (const sk of skills || []) {
    if (slugName(sk.name) === draft?.name) return sk;
    const sw = words(`${String(sk.name || '').replace(/-/g, ' ')} ${sk.description}`);
    if (!dw.size || !sw.size) continue;
    let inter = 0;
    for (const w of dw) if (sw.has(w)) inter++;
    if (inter / (dw.size + sw.size - inter) >= SIMILAR) return sk;
  }
  return null;
}

function uniqueName(name, taken) {
  const set = new Set([...(taken || [])].map((n) => String(n).toLowerCase()));
  if (!set.has(name)) return name;
  for (let i = 2; i < 100; i++) if (!set.has(`${name}-${i}`)) return `${name}-${i}`;
  return `${name}-${Date.now()}`;
}

// The curator: only skills QWS wrote are ever touched. Unused for 30 days → stale (still listed,
// flagged in Settings); 60 days → archived (moved out of the list, restorable). A use revives it.
function curatorPlan(entries, now) {
  const stale = [];
  const archive = [];
  for (const [name, e] of Object.entries(entries || {})) {
    if (!e || e.createdBy !== 'qws' || e.state === 'archived' || e.pinned) continue;
    const last = Math.max(Number(e.lastUsed) || 0, Number(e.createdAt) || 0);
    if (!last) continue;
    const age = (now - last) / DAY;
    if (age >= ARCHIVE_DAYS) archive.push(name);
    else if (age >= STALE_DAYS && e.state !== 'stale') stale.push(name);
  }
  return { stale, archive };
}

function recordUse(entry, now) {
  return { ...(entry || {}), uses: (Number(entry?.uses) || 0) + 1, lastUsed: now, state: 'active' };
}

const SkillWriterExports = { MIN_STEPS, MIN_STEPS_RESCUED, STALE_DAYS, ARCHIVE_DAYS, SKILL_WRITER_SYSTEM, shouldPropose, taskStartIndex, taskDigest, slugName, parseSkillDraft, similarSkill, uniqueName, curatorPlan, recordUse };
if (typeof module !== 'undefined' && module.exports) module.exports = SkillWriterExports;
if (typeof window !== 'undefined') window.SkillWriter = SkillWriterExports;
