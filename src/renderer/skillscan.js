'use strict';

// A safety scan of skills and instruction files from elsewhere (from Hermes Agent's
// tools/skills_guard.py): before a skill from GitHub is installed, every text file in it is
// checked for what a hostile skill would do — send keys or files somewhere, run code fetched
// from the web, delete or overwrite outside the project, plant itself to run at startup, change
// the agent's own instructions, or tell the agent to ignore its rules and hide things from the
// user. Findings are shown to the user, who decides. The same injection patterns are checked in
// folder instruction files (AGENTS.md, CLAUDE.md) before the agent is shown them.
// Pure: no DOM, no Electron.

(() => {
// [id, severity, category, regex, why]
const SECRET_WORD = '(?:KEY|TOKEN|SECRET|PASSW(?:OR)?D|CREDENTIAL)S?';
const NOT_LOCAL = '(?![^\\n]*https?://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]))';
const CRED_FILE = '(?:\\.ssh[/\\\\]id_(?:rsa|ed25519|ecdsa|dsa)(?!\\.pub)|\\.env\\b|credentials\\b|\\.netrc\\b|\\.pgpass\\b|\\.npmrc\\b|\\.pypirc\\b|\\.git-credentials\\b)';
const RULES = [
  // Exfiltration: secrets or credential files leaving the PC.
  ['send_secret', 'high', 'exfiltration', new RegExp(`\\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\\b${NOT_LOCAL}[^\\n]*(?:\\$\\{?\\w*${SECRET_WORD}\\b|\\$env:\\w*${SECRET_WORD}|%\\w*${SECRET_WORD}%)`, 'i'), 'sends an environment secret to a web address'],
  ['send_secret_code', 'high', 'exfiltration', new RegExp(`\\b(?:fetch|axios\\.\\w+|requests\\.\\w+|httpx\\.\\w+|urllib\\.request\\.urlopen)\\s*\\(${NOT_LOCAL}[^\\n]*${SECRET_WORD}`, 'i'), 'sends a secret from code to a web address'],
  ['read_cred_file', 'high', 'exfiltration', new RegExp(`\\b(?:cat|type|Get-Content|gc|more|less|head|tail)\\s+[^\\n|]*${CRED_FILE}`, 'i'), 'reads a credentials file (.env, SSH key, .netrc, .npmrc …)'],
  ['cred_dirs', 'high', 'exfiltration', /(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE)[/\\](?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[/\\]gcloud)\b/i, 'reaches into the user\'s SSH, cloud or keyring folders'],
  ['dump_env', 'medium', 'exfiltration', /\b(?:printenv|Get-ChildItem\s+env:|gci\s+env:|set\s*\|)|(?<![\w-])env\s*\|(?!\|)/i, 'dumps all environment variables (where API keys live)'],
  ['b64_env', 'high', 'exfiltration', /base64[^\n]*(?:\benv\b|environ|process\.env|\$env:)|(?:\benv\b|environ|process\.env|\$env:)[^\n]*base64/i, 'encodes environment variables, a common way to smuggle them out'],
  ['md_exfil', 'high', 'exfiltration', /!?\[[^\]\n]*\]\(https?:\/\/[^)\s]*(?:\$\{|\{\{|\$[A-Z_]{3,})/, 'a markdown image or link whose address is filled in with data'],
  // Running code fetched from the web.
  ['pipe_to_shell', 'critical', 'execution', /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b|\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:New-Object\s+(?:System\.)?Net\.WebClient|\[System\.Net\.WebClient\])[^\n]*DownloadString/i, 'downloads a script and runs it at once'],
  ['encoded_ps', 'high', 'execution', /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, 'runs a hidden (base64-encoded) PowerShell command'],
  ['certutil_dl', 'high', 'execution', /\bcertutil(?:\.exe)?\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*\/transfer/i, 'downloads a file with a Windows tool malware often uses'],
  ['eval_b64', 'high', 'execution', /\beval\s*\(\s*(?:atob|Buffer\.from|base64\.b64decode|codecs\.decode)\s*\(/i, 'runs code hidden in base64'],
  ['defender_off', 'critical', 'execution', /\bSet-MpPreference\b[^\n]*-Disable|\bAdd-MpPreference\b[^\n]*-Exclusion/i, 'turns off or bypasses Windows Defender'],
  // Destructive.
  ['rm_root_home', 'critical', 'destructive', /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME\b)/i, 'deletes the whole disk or the home folder'],
  ['del_drive', 'critical', 'destructive', /\b(?:Remove-Item|rm|del|rd|rmdir)\b[^\n]*(?:-Recurse|\/s)[^\n]*(?:[A-Z]:\\(?:\s|$|\*|Windows|Users\b)|\$env:USERPROFILE|%USERPROFILE%|\$HOME)/i, 'deletes a drive, Windows or the user\'s folder'],
  ['format_disk', 'critical', 'destructive', /\bformat\s+[A-Z]:|\bdiskpart\b|\bmkfs(?:\.\w+)?\b|\bdd\s+[^\n]*of=\/dev\/|\bcipher\s+\/w/i, 'formats or wipes a disk'],
  ['world_writable', 'medium', 'destructive', /\bchmod\s+(?:-R\s+)?777\b|\bicacls\b[^\n]*Everyone:\(?F/i, 'makes files writable by everyone'],
  ['etc_overwrite', 'critical', 'destructive', />\s*\/etc\/|>\s*C:\\Windows\\/i, 'overwrites system configuration'],
  // Persistence: making itself run later.
  ['autostart', 'high', 'persistence', /\bschtasks(?:\.exe)?\s+\/create\b|\breg(?:\.exe)?\s+add\s+[^\n]*\\(?:Run|RunOnce)\b|CurrentVersion\\Run\b|Start Menu\\Programs\\Startup|\bcrontab\b|launchctl\s+load|LaunchAgents/i, 'sets something to run automatically at startup or on a schedule'],
  ['shell_profile', 'high', 'persistence', />>?\s*~?\/?\.?(?:bashrc|zshrc|bash_profile|profile)\b|\$PROFILE\b[^\n]*(?:Add-Content|Set-Content|>>)/i, 'adds itself to the shell\'s startup file'],
  ['ssh_backdoor', 'critical', 'persistence', /authorized_keys/i, 'adds an SSH key that lets someone log in'],
  // QWEN.md is the project's notes file QWS itself asks the agent to keep, so it is not on this list.
  ['agent_config', 'medium', 'persistence', /\b(?:write|writes|append|appends|add|adds|edit|edits|modify|modifies|update|updates|overwrite|overwrites|replace|replaces)\b[^\n]{0,60}\b(?:USER\.md|AGENTS\.md|CLAUDE\.md|\.cursorrules)\b|(?:>>|Add-Content|Set-Content|Out-File)[^\n]{0,40}\b(?:USER\.md|AGENTS\.md|CLAUDE\.md)\b/i, 'changes the agent\'s personal memory or instruction files'],
  // Prompt injection: telling the agent to drop its rules.
  ['ignore_rules', 'high', 'injection', /\b(?:ignore|disregard|forget)\s+(?:\w+\s+){0,3}(?:previous|prior|above|earlier|all|any|your|the)\s+(?:\w+\s+){0,2}(?:instructions?|rules|guidelines|prompts?|directions)\b/i, 'tells the agent to ignore its instructions'],
  ['hide_from_user', 'high', 'injection', /\bdo\s+not\s+(?:\w+\s+){0,3}(?:tell|inform|show|mention|reveal)\s+(?:\w+\s+){0,2}(?:the\s+)?user\b(?![^\n]*\b(?:unless|until|before|confirm)\b)|\bwithout\s+(?:telling|informing|asking)\s+the\s+user\b/i, 'tells the agent to hide something from the user'],
  ['role_hijack', 'medium', 'injection', /\byou\s+are\s+now\s+(?:a|an|in|the)\b|\bpretend\s+(?:that\s+)?(?:you\s+are|to\s+be)\b|\bact\s+as\s+if\s+you\s+have\s+no\s+(?:restrictions|rules|limits)/i, 'tries to change who the agent is'],
  ['reveal_prompt', 'high', 'injection', /\b(?:print|output|reveal|show|repeat)\s+(?:\w+\s+){0,3}(?:system|initial|hidden)\s+(?:prompt|instructions)\b/i, 'asks the agent to reveal its hidden instructions'],
  ['unwatched', 'high', 'injection', /\b(?:when|if)\s+no\s*one\s+is\s+(?:watching|looking)\b/i, 'behaves differently when no one is watching'],
  ['hidden_comment', 'high', 'injection', /<!--[^>]*\b(?:ignore|override|disregard|bypass|secret instructions?|system prompt|you are now|do not (?:tell|reveal))\b[^>]*-->/i, 'hides instructions for the agent in an HTML comment'],
  ['safety_off', 'medium', 'injection', /\b(?:disable|bypass|turn\s+off|skip|ignore)\s+(?:\w+\s+){0,2}(?:safety|security|guardrails?|approvals?)(?:\s+(?:checks?|rules|prompts?|cards?))?\b/i, 'tells the agent to skip its safety checks or approvals']
];

const SEVERITY = { critical: 3, high: 2, medium: 1 };
const TEXT_FILE = /\.(md|markdown|txt|py|js|mjs|cjs|ts|sh|bash|zsh|ps1|psm1|bat|cmd|json|ya?ml|toml|ini|cfg|html?|rb|pl|lua)$|^[^.]+$/i;
const PROGRAM_FILE = /\.(exe|dll|scr|msi|com|so|dylib|jar|bin|app|pkg|deb|rpm|vbs|vbe|wsf|hta|lnk)$/i;

// Findings in one text: [{ id, severity, category, line, text, why }].
function scanText(text, rel = '') {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < 50; i++) {
    const l = lines[i];
    if (l.length > 4000) continue;
    for (const [id, severity, category, re, why] of RULES) {
      if (re.test(l)) out.push({ id, severity, category, rel, line: i + 1, text: l.trim().slice(0, 160), why });
    }
  }
  return out;
}

// A whole skill: files = [{ rel, text }] (text null for binaries). { verdict, findings }.
function scanFiles(files) {
  const findings = [];
  for (const f of files || []) {
    if (PROGRAM_FILE.test(f.rel)) {
      findings.push({ id: 'ships_program', severity: 'high', category: 'execution', rel: f.rel, line: 0, text: '', why: 'includes a program file that would run outside QWS\'s checks' });
      continue;
    }
    if (f.text == null || !TEXT_FILE.test(f.rel.split('/').pop())) continue;
    findings.push(...scanText(f.text, f.rel));
  }
  return { verdict: verdictOf(findings), findings };
}

function verdictOf(findings) {
  const top = Math.max(0, ...(findings || []).map((f) => SEVERITY[f.severity] || 0));
  return top >= 2 ? 'dangerous' : top === 1 ? 'caution' : 'safe';
}

// Skill repositories run by the companies behind the tools (Hermes's list): their "caution"
// findings are routine, their "dangerous" ones still ask.
const TRUSTED_REPOS = new Set(['anthropics/skills', 'openai/skills', 'huggingface/skills', 'nvidia/skills', 'wandb/skills', 'qdrant/skills', 'pinecone-io/skills', 'makenotion/skills', 'airtable/skills', 'shopify/shopify-ai-toolkit']);
const isTrusted = (owner, repo) => TRUSTED_REPOS.has(`${owner}/${repo}`.toLowerCase());

// Does installing need the user's yes? Safe: no. Caution: unless the repo is trusted. Dangerous: yes.
function needsConfirm(verdict, trusted) {
  if (verdict === 'dangerous') return true;
  if (verdict === 'caution') return !trusted;
  return false;
}

// The findings as text for the confirm dialog (most severe first, at most `max`).
function report(findings, max = 8) {
  const sorted = (findings || []).slice().sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));
  const lines = sorted.slice(0, max).map((f) => `• ${f.severity.toUpperCase()}: ${f.why} — ${f.rel}${f.line ? `:${f.line}` : ''}${f.text ? `\n    ${f.text}` : ''}`);
  if (sorted.length > max) lines.push(`… and ${sorted.length - max} more.`);
  return lines.join('\n');
}

// Instruction text from the project (a folder's AGENTS.md) that tries to steer the agent.
const INJECTION = new Set(['ignore_rules', 'hide_from_user', 'reveal_prompt', 'unwatched', 'hidden_comment']);
function injectionFindings(text, rel) {
  return scanText(text, rel).filter((f) => INJECTION.has(f.id));
}

const SkillScanExports = { RULES, scanText, scanFiles, verdictOf, isTrusted, needsConfirm, report, injectionFindings, PROGRAM_FILE };
if (typeof module !== 'undefined' && module.exports) module.exports = SkillScanExports;
if (typeof window !== 'undefined') window.SkillScan = SkillScanExports;
})();
