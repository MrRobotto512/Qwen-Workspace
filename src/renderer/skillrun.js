'use strict';

// Running a skill the way Claude Code does (needed by skills such as fpapleux/sdd-skill):
// "/<skill name> <arguments>" in the composer loads that skill's instructions straight into the
// message, and every loaded skill is told where its folder is, so instructions like
// "run python3 <skill folder>/scripts/sdd.py" point at a real path. Pure logic: no DOM, no fs.

// Commands QWS handles itself; a skill can never take these names over.
const RESERVED = new Set(['checks', 'goal']);

// "/sdd quick \"Add a total command\"" → { skill, args } when the name is an installed skill.
function parseSkillCommand(text, skills) {
  const m = /^\/([\w][\w.-]*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const skill = (skills || []).find((sk) => String(sk.name).toLowerCase() === m[1].toLowerCase());
  return skill ? { skill, args: (m[2] || '').trim() } : null;
}

// Placeholders skills use for their own folder, replaced with the real one.
const FOLDER_TOKENS = [/<skill folder>/gi, /\{baseDir\}/g, /\$\{CLAUDE_SKILL_DIR\}/g, /\$CLAUDE_SKILL_DIR\b/g];

function withFolder(text, folder) {
  if (!folder) return String(text || '');
  return FOLDER_TOKENS.reduce((t, re) => t.replace(re, folder), String(text || ''));
}

function folderNote(folder) {
  return folder
    ? `This skill's folder is ${folder}. Wherever the skill mentions its own folder (the skill folder, the directory containing SKILL.md), use that path; run its scripts from the project root by that path.`
    : '';
}

// The <skill> block a tool result or an invocation carries.
function skillBlock(name, content, folder, file) {
  const attrs = `name="${name}"${file ? ` file="${file}"` : ''}${folder ? ` folder="${folder}"` : ''}`;
  return `<skill ${attrs}>\n${withFolder(content, folder)}\n</skill>`;
}

// What the model receives when the user typed "/<skill> <args>".
function invocationPrompt(text, skill, args, body, folder, files) {
  const more = files?.length ? `\nSupporting files (load one with load_skill and file): ${files.join(', ')}` : '';
  return [
    text,
    '',
    '<system-reminder>',
    `The user invoked the "${skill.name}" skill${args ? ` with: ${args}` : ' with no arguments'}. Its instructions are below (already loaded — do not call load_skill for SKILL.md again). Follow them for this request.`,
    folderNote(folder) || null,
    skillBlock(skill.name, body, folder) + more,
    '</system-reminder>'
  ].filter((l) => l !== null).join('\n');
}

const SkillRunExports = { RESERVED, parseSkillCommand, withFolder, folderNote, skillBlock, invocationPrompt };
if (typeof module !== 'undefined' && module.exports) module.exports = SkillRunExports;
if (typeof window !== 'undefined') window.SkillRun = SkillRunExports;
