'use strict';

// Command-approval rules, kept free of DOM/state so they can be unit-tested in Node.
// Loaded as a plain <script> in the renderer (globals) and required by test/approvals.test.js.

// Commands that always ask, in every approval mode. Includes anything that fetches from the
// network or launches another program, since those can run arbitrary code.
const DANGEROUS_COMMAND = /\b(rm\s+-[a-z]*[rf]|rmdir|rd\s+\/s|del(?=\s)|erase(?=\s)|format(?=\s)|mkfs|shutdown|reboot|reg\s+delete|remove-item|git\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D)|npm\s+publish|diskpart|bcdedit|takeown|icacls|curl|wget|invoke-webrequest|iwr|invoke-expression|iex|powershell|pwsh|cmd\s+\/c|start(?=\s)|msiexec|certutil|bitsadmin|scp|ssh|sudo|osascript)\b/i;

// Shell metacharacters that chain commands, redirect output, spawn subshells or expand
// variables. A command using any of these is split into segments and every segment must be
// allow-listed, so an always-allowed prefix can't smuggle a second command after `&&`.
const SHELL_SPLIT = /&&|\|\||;|\||&|\n/;
const SHELL_META = /[>`]|\$\(|%[^%\s]+%/;

function commandSegments(cmd) {
  return String(cmd).split(SHELL_SPLIT).map((x) => x.trim()).filter(Boolean);
}

// Pure allow-list check: every segment must match an allowed prefix, and the command must not
// use redirection, subshells or variable expansion.
function isCommandAllowed(cmd, allowed) {
  const list = (allowed || []).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const whole = String(cmd).trim().toLowerCase();
  const segMatches = (seg) =>
    list.some((pre) => (pre.endsWith('__') ? seg.startsWith(pre) : seg === pre || seg.startsWith(pre + ' ')));
  // MCP tool calls (mcp__server__tool) carry no shell syntax; match the whole string.
  if (whole.startsWith('mcp__')) return segMatches(whole);
  if (SHELL_META.test(whole)) return false;
  const segs = commandSegments(whole);
  return segs.length > 0 && segs.every(segMatches);
}


// ---- Read-only commands that run without an approval card ----
// Ported from Strata's agent gate (github.com/Niko1221/Strata, apps/host/server/agent/plugins/
// strata-gate.mjs, MIT). Safe by construction: a command is listed WITH the options known to
// only look; every other option, long or short, makes it ask — so a write mode (`sort -o`), a
// program-execution mode (`rg --pre`, `git grep -O`), a setting mode (`date -s`) or one that
// never ends (`tail -f`) can't slip in. Quoted text is data and is set aside before the checks.
// QWS adds the cmd.exe commands Windows models actually run (dir /s, findstr, where, tree).
//
// A spec: f short flags without a value · v short options needing a value · vn the same, numeric ·
// o optional attached value · n bare -5 allowed · l long options · lv long options needing a
// value · max operand count · op a check per operand · post a last check (options seen, count).
const roWords = (text) => (text ? text.trim().split(/\s+/) : []);
const roSpec = ({ f = '', v = '', vn = '', o = '', n = false, l = '', lv = '', max = Infinity, op = null, post = null, slash = false }) =>
  ({ f, v, vn, o, n, l: new Set(roWords(l)), lv: new Set(roWords(lv)), max, op, post, slash });
const RO_NUMBER = /^[+-]?\d+[A-Za-z]{0,3}$/;
const RO_LS = { f: 'aAbBcdDFgGhHiklLmnNopqQrRsStuUvxX1CZ', v: 'ITw', slash: true,
  l: 'all almost-all human-readable recursive directory classify reverse size inode dereference color group-directories-first sort time time-style block-size indicator-style si numeric-uid-gid no-group literal hide ignore quote-name escape author file-type full-time width tabsize' };
const RO_CAT = { f: 'AbeEnstTuv', l: 'show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting' };
const RO_GREP = { f: 'aiIlLcnvwHhEFGPqrRsTUyzZbxo', v: 'efdD', vn: 'ABCm', n: true,
  l: 'extended-regexp fixed-strings basic-regexp perl-regexp ignore-case no-ignore-case word-regexp line-regexp invert-match count color colour files-with-matches files-without-match max-count only-matching quiet silent no-messages byte-offset with-filename no-filename label line-buffered initial-tab null after-context before-context context text recursive dereference-recursive include exclude exclude-dir binary-files line-number null-data no-group-separator group-separator regexp file directories devices binary' };

const RO_SPECS = new Map();
const roAdd = (names, s) => { for (const name of roWords(names)) RO_SPECS.set(name, roSpec(s)); };
roAdd('ls dir', RO_LS);
roAdd('cat type', RO_CAT);
roAdd('pwd', { f: 'LP' });
roAdd('echo', { f: 'neE' });
roAdd('head', { f: 'qvz', vn: 'nc', n: true, l: 'quiet silent verbose zero-terminated lines bytes' });
roAdd('tail', { f: 'qvz', vn: 'nc', n: true, l: 'quiet silent verbose zero-terminated lines bytes' }); // no -f/-F/--follow: they never end
roAdd('wc', { f: 'lwcmL', l: 'lines words bytes chars max-line-length' });
roAdd('grep egrep fgrep', RO_GREP);
roAdd('rg', { f: 'iIsSnNHlcwFxvUoLaquhVpbP', v: 'efgtTr', vn: 'ABCjdMm', // no --pre/--pre-glob/-z: they run programs
  l: 'ignore-case no-ignore-case smart-case case-sensitive fixed-strings word-regexp line-regexp invert-match count count-matches files-with-matches files-without-match files type-list hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-dot no-ignore-global no-ignore-messages follow line-number no-line-number with-filename no-filename column heading no-heading null only-matching quiet text multiline multiline-dotall pcre2 no-messages json stats trim unrestricted binary no-config vimgrep pretty byte-offset passthru crlf one-file-system no-unicode regexp file glob iglob type type-not max-count max-depth maxdepth context after-context before-context color replace threads sort sortr max-filesize max-columns path-separator encoding engine ignore-file glob-case-insensitive no-glob-case-insensitive' });
roAdd('stat', { f: 'LtxlnqrsFf', v: 'c', l: 'dereference file-system terse format printf' });
roAdd('file', { f: 'bhikLnNrvI', l: 'brief dereference no-dereference mime mime-type mime-encoding keep-going no-pad no-buffer raw' });
roAdd('du', { f: 'abchHklmsxLPSD0', v: 'tB', vn: 'd', l: 'all apparent-size bytes total dereference-args human-readable si summarize one-file-system dereference no-dereference separate-dirs count-links inodes null max-depth threshold block-size time time-style exclude' });
roAdd('df', { f: 'ahHiklmPTv', v: 'txB', l: 'all human-readable si inodes local portability print-type total sync no-sync output block-size type exclude-type' });
roAdd('uname', { f: 'asnrvmpio', max: 0, l: 'all kernel-name nodename kernel-release kernel-version machine processor hardware-platform operating-system' });
roAdd('which', { f: 'as', l: 'all' });
roAdd('basename', { f: 'az', v: 's', l: 'multiple zero suffix' });
roAdd('dirname', { f: 'z', l: 'zero' });
roAdd('realpath', { f: 'emsqzLP', l: 'canonicalize-existing canonicalize-missing no-symlinks quiet zero strip logical physical relative-to relative-base' });
roAdd('sort', { f: 'bdfghiMnRrsuVzmcC', v: 'kt', l: 'ignore-leading-blanks dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting month-sort numeric-sort random-sort reverse stable unique version-sort zero-terminated check merge sort field-separator key' }); // no -o: writes
roAdd('uniq', { f: 'cdDuiz', vn: 'fsw', max: 1, l: 'count repeated all-repeated unique ignore-case skip-fields skip-chars check-chars zero-terminated group' }); // a 2nd operand is an OUTPUT file
roAdd('cut', { f: 'snz', v: 'bcfd', l: 'complement only-delimited zero-terminated bytes characters fields delimiter output-delimiter' });
roAdd('date', { f: 'uR', o: 'I', v: 'dr', lv: 'date reference', l: 'utc universal rfc-email rfc-2822 iso-8601 rfc-3339', op: (word) => word.startsWith('+') }); // a bare operand SETS the clock
roAdd('id', { f: 'ugGnrazZ', l: 'user group groups name real context zero' });
roAdd('hostname', { f: 'sfiIdaAyv', max: 0 }); // `hostname NAME` renames the machine
roAdd('whoami', { op: (word) => /^\/(all|user|groups|priv|upn|fqdn|logonid|nh)$/i.test(word) });
roAdd('tree', { f: 'adfilpsugDFqNQrtvxCnASUchJX', v: 'LPIHT', slash: true, l: 'filelimit charset sort timefmt noreport dirsfirst filesfirst prune du si gitignore matchdirs ignore-case inodes device nolinks' }); // no -o, -R
// cmd.exe. Their switches are /x; every switch these take only changes what is shown.
roAdd('where', { slash: true });
roAdd('findstr', { slash: true });
roAdd('ver systeminfo', { max: 0, slash: true });

const RO_GIT_VIEW = 'oneline graph decorate no-decorate all branches tags remotes stat shortstat numstat dirstat name-only name-status patch no-patch raw summary compact-summary abbrev-commit no-abbrev-commit abbrev reverse follow no-merges merges first-parent full-history simplify-by-decoration simplify-merges ancestry-path left-right left-only right-only cherry-pick cherry-mark cherry topo-order date-order author-date-order relative-date all-match invert-grep regexp-ignore-case extended-regexp fixed-strings perl-regexp no-color color color-words word-diff word-diff-regex minimal patience histogram diff-algorithm check exit-code quiet cached staged merge-base no-index no-ext-diff no-textconv find-renames find-copies find-copies-harder no-renames ignore-space-change ignore-all-space ignore-space-at-eol ignore-blank-lines ignore-cr-at-eol function-context show-function unified inter-hunk-context src-prefix dst-prefix no-prefix full-index binary text source use-mailmap mailmap no-mailmap log-size notes no-notes show-signature diff-merges boundary children parents no-walk sparse date format pretty author committer grep since until after before max-count skip min-parents max-parents diff-filter encoding stat-width stat-name-width stat-graph-width stat-count count';
const RO_LISTING = ['l', 'list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at'];
const RO_GIT = new Map(Object.entries({
  status: roSpec({ f: 'sbvz', o: 'u', l: 'short branch porcelain long ignored untracked-files ignore-submodules renames no-renames find-renames show-stash ahead-behind no-ahead-behind column no-column verbose null' }),
  log: roSpec({ f: 'pswbMCizuacmrtqEFPR', vn: 'nU', v: 'SGL', n: true, l: RO_GIT_VIEW }),
  diff: roSpec({ f: 'pswbMCizuacmrtqEFPR', vn: 'nU', v: 'SGL', n: true, l: RO_GIT_VIEW }),
  show: roSpec({ f: 'pswbMCizuacmrtqEFPR', vn: 'nU', v: 'SGL', n: true, l: RO_GIT_VIEW }),
  'rev-list': roSpec({ f: 'pswbMCizuacmrtqEFPR', vn: 'nU', v: 'SGL', n: true, l: RO_GIT_VIEW }),
  shortlog: roSpec({ f: 'sneciw', l: `${RO_GIT_VIEW} summary numbered email committer group` }),
  // Listing forms only: a bare name would CREATE a branch or tag.
  branch: roSpec({ f: 'avri', l: 'list all remotes verbose show-current ignore-case contains no-contains merged no-merged points-at sort format abbrev no-abbrev color no-color column no-column omit-empty',
    post: (seen, count) => count === 0 || RO_LISTING.some((name) => seen.has(name)) }),
  tag: roSpec({ f: 'li', o: 'n', l: 'list sort contains no-contains merged no-merged points-at format column no-column ignore-case omit-empty color no-color',
    post: (seen, count) => count === 0 || RO_LISTING.some((name) => seen.has(name)) }),
  remote: roSpec({ f: 'v', l: 'verbose', max: 0 }),
  // `git config KEY` reads but `git config KEY VALUE` writes: a key only with --get.
  config: roSpec({ f: 'lz', l: 'list get get-all get-regexp show-origin show-scope local global system worktree bool int bool-or-int path expiry-date type null name-only includes no-includes', lv: 'default',
    post: (seen, count) => (count > 0 ? ['get', 'get-all', 'get-regexp'].some((name) => seen.has(name)) : seen.has('list') || seen.has('l')) }),
  'rev-parse': roSpec({ f: 'q', l: 'show-toplevel git-dir git-common-dir absolute-git-dir abbrev-ref symbolic symbolic-full-name short verify is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository show-prefix show-cdup show-superproject-working-tree all branches tags remotes quiet revs-only no-revs flags no-flags local-env-vars show-object-format path-format', lv: 'default git-path' }),
  'ls-files': roSpec({ f: 'cdmoiskuzvtfD', l: 'cached deleted modified others ignored stage directory unmerged killed no-empty-directory error-unmatch exclude-standard exclude full-name eol deduplicate recurse-submodules sparse abbrev resolve-undo format' }),
  'ls-tree': roSpec({ f: 'rtdlz', l: 'name-only name-status long full-name full-tree object-only abbrev format' }),
  blame: roSpec({ f: 'wMCespltbfnc', v: 'L', l: 'porcelain line-porcelain incremental show-email show-name show-number date root abbrev' }),
  describe: roSpec({ l: 'all tags always long dirty broken contains abbrev match exclude first-parent exact-match candidates' }),
  grep: roSpec({ f: 'aiIlLcnvwHhEFGPqpWrzUo', v: 'e', vn: 'ABCm', n: true, l: 'no-index untracked cached no-exclude-standard exclude-standard recurse-submodules text ignore-case word-regexp invert-match full-name extended-regexp basic-regexp perl-regexp fixed-strings line-number column files-with-matches name-only files-without-match count null only-matching quiet no-color color break heading show-function function-context all-match and or not max-depth max-count threads after-context before-context context recursive no-recursive' }) // no -O: runs a program
}));

function roArgumentsSafe(sp, args) {
  const seen = new Set();
  let operands = 0;
  let ended = false;
  const operand = (arg) => { operands++; return operands <= sp.max && (!sp.op || sp.op(arg.t, arg.q)); };
  const valueOf = (i, numeric) => {
    const arg = args[i + 1];
    if (!arg) return false;
    return numeric ? RO_NUMBER.test(arg.t) : arg.q || !arg.t.startsWith('-') || RO_NUMBER.test(arg.t);
  };
  for (let i = 0; i < args.length; i++) {
    const { t, q } = args[i];
    // cmd.exe switches (/s, /b, /i): every switch of a slash-command only changes the listing.
    if (!q && sp.slash && /^\/[A-Za-z?]/.test(t)) continue;
    if (q || ended || t === '-' || t[0] !== '-') { if (!operand(args[i])) return false; continue; }
    if (t === '--') { ended = true; continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (sp.l.has(name)) { seen.add(name); continue; }
      if (sp.lv.has(name)) { seen.add(name); if (eq < 0) { if (!valueOf(i, false)) return false; i++; } continue; }
      return false;
    }
    if (sp.n && /^-\d+$/.test(t)) continue;
    for (let j = 1; j < t.length; j++) {
      const ch = t[j];
      if (sp.f.includes(ch)) { seen.add(ch); continue; }
      if (sp.o.includes(ch)) { seen.add(ch); break; }
      const numeric = sp.vn.includes(ch);
      if (!numeric && !sp.v.includes(ch)) return false;
      seen.add(ch);
      const rest = t.slice(j + 1);
      if (rest) { if (numeric && !RO_NUMBER.test(rest)) return false; } else { if (!valueOf(i, numeric)) return false; i++; }
      break;
    }
  }
  return sp.post ? sp.post(seen, operands) : true;
}

const RO_SAFE_VERSION = /^(node|python|python3|py|npm|pnpm|git|dotnet|cargo|rustc|go|java|pip|pip3|swift|ollama|gh|winget|brew)\s+(--version|-v|-version|version)$/i;
// Anything that can chain, redirect, expand or start something else is not read-only. QWS adds
// cmd.exe's %VAR% expansion and `^` escapes.
const RO_UNSAFE = /[;&<>`${}()%^]|\r|\n|\bcurl\b|\bwget\b|\bsudo\b|(?<![-\w])sh(?![-\w])|\bbash\b|\bpwsh\b|\bpowershell\b|\bcmd\b|-exec\b|-delete\b|-execdir\b/i;

// The command with quoted text set aside (it is data: a path like "C:\Q&A", a pattern 'a|b'),
// or null when it can't be read safely (an unterminated quote, $ or ` inside double quotes, a
// quote glued to other characters or starting with a dash, which could hide an option).
function roMaskQuotes(text, quoted) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '"' && ch !== "'") { out += ch; continue; }
    let end = text.indexOf(ch, i + 1);
    while (end >= 0 && text[end + 1] === ch) end = text.indexOf(ch, end + 2);
    if (end < 0) return null;
    if (ch === '"' && /[$`%]/.test(text.slice(i + 1, end))) return null;
    const before = text[i - 1];
    const after = text[end + 1];
    if ((before !== undefined && !/[\s|]/.test(before)) || (after !== undefined && !/[\s|]/.test(after)) || text[i + 1] === '-') return null;
    out += '"_"';
    quoted.push(text.slice(i + 1, end));
    i = end;
  }
  return out;
}

// Whether a shell command only reads. Conservative by design: one unrecognised word or option
// and the answer is no.
function isReadOnlyCommand(command) {
  const text = String(command ?? '').trim();
  if (!text || text.length > 600) return false;
  if (RO_SAFE_VERSION.test(text)) return true;
  const quoted = [];
  const masked = roMaskQuotes(text, quoted);
  if (masked === null || RO_UNSAFE.test(masked)) return false;
  let next = 0;
  const segments = masked.split('|').map((segment) => roWords(segment.trim()).map((w) => (w === '"_"' ? { t: quoted[next++] ?? '', q: true } : { t: w, q: false })));
  return segments.every((segment) => {
    if (!segment.length || segment[0].q) return false;
    const first = segment[0].t.toLowerCase().replace(/^\.[\\/]/, '').replace(/\.exe$/, '');
    if (first === 'git') {
      const sub = segment[1];
      const sp = sub && !sub.q ? RO_GIT.get(sub.t) : null;
      return !!sp && roArgumentsSafe(sp, segment.slice(2));
    }
    const sp = RO_SPECS.get(first);
    return !!sp && roArgumentsSafe(sp, segment.slice(1));
  });
}

// Pure approval decision for a command, so it can be unit-tested without the UI. A command
// that provably only reads runs without a card in every mode; dangerous ones still always ask.
function commandNeedsApproval(mode, command, allowed) {
  if (DANGEROUS_COMMAND.test(command)) return true;
  if (isReadOnlyCommand(command)) return false;
  if (mode === 'auto') return false;
  return mode === 'ask' || !isCommandAllowed(command, allowed);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DANGEROUS_COMMAND, SHELL_SPLIT, SHELL_META, commandSegments, isCommandAllowed, commandNeedsApproval, isReadOnlyCommand };
}
