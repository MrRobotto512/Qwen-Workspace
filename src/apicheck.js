'use strict';

// check_api: before (or after) writing code, the agent confirms that a name it wants to use
// really exists in the project's installed packages — the idea behind XR Blocks' MCP
// `search_api` ("hallucinated APIs are the single biggest cause of broken generated apps").
// A field report's small model wrote `from PyQt5.QtGui import Qt` (Qt lives in QtCore); this
// answers that in one call: "not in PyQt5.QtGui — found in PyQt5.QtCore".
//
// Python names are checked by the project's own interpreter (its venv when there is one), run
// from QWS's private folder, so the project folder is NOT on sys.path and none of the project's own code runs — only
// installed packages are imported. JavaScript names are resolved from the project's
// node_modules (or Node's built-ins) by Electron's bundled Node.

const path = require('path');
const fs = require('fs');

const MAX_NAMES = 12;

// Dotted names → cleaned list; "from X import Y" and "X.Y()" forms are accepted too.
function parseNames(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/))
    .map((s) => String(s || '').trim())
    .map((s) => {
      const from = /^from\s+([\w.]+)\s+import\s+([\w.]+)/.exec(s);
      if (from) return `${from[1]}.${from[2]}`;
      return s.replace(/^import\s+/, '').replace(/\(.*$/, '').replace(/\s+as\s+\w+$/, '').trim();
    })
    .filter((s) => /^@?[\w$][\w$.\-/@]*$/.test(s));
  return [...new Set(list)].slice(0, MAX_NAMES);
}

// Which language a name belongs to: explicit, else Node when its first segment is a Node
// built-in or a package in node_modules, else Python.
const NODE_BUILTINS = new Set(require('module').builtinModules.map((m) => m.replace(/^node:/, '')));
function nodePackageOf(name) {
  const n = name.replace(/^node:/, '');
  if (n.startsWith('@')) return n.split(/[./]/).slice(0, 2).join('/').replace(/^(@[^/.]+)\.(.*)$/, '$1/$2');
  return n.split(/[./]/)[0];
}
const BOTH_STDLIBS = new Set(['os', 'http', 'zlib', 'readline', 'sys', 'trace', 'test', 'tty', 'select', 'sqlite', 'string_decoder']);

function projectKinds(root) {
  let names = [];
  try {
    names = fs.readdirSync(root || '.');
  } catch {
    /* no project */
  }
  return {
    node: names.includes('package.json'),
    python: names.some((n) => /\.py$/.test(n) || ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].includes(n))
  };
}
function languageOf(name, root, explicit) {
  if (explicit === 'python' || explicit === 'node') return explicit;
  const pkg = nodePackageOf(name);
  const kinds = projectKinds(root);
  if (root && fs.existsSync(path.join(root, 'node_modules', pkg))) return 'node';
  if (NODE_BUILTINS.has(pkg)) {
    // Names that are also Python standard modules ("os", "http", "sys"…) mean Python in a mixed project.
    if (kinds.python && (!kinds.node || BOTH_STDLIBS.has(pkg))) return 'python';
    return kinds.node ? 'node' : 'python';
  }
  return kinds.node && !kinds.python ? 'node' : 'python';
}

// The project's Python: its venv first, then the platform's usual name.
function pythonCandidates(root, platform) {
  const out = [];
  for (const v of ['.venv', 'venv', 'env']) {
    out.push(platform === 'win32' ? path.join(root, v, 'Scripts', 'python.exe') : path.join(root, v, 'bin', 'python'));
  }
  return [...out.filter((p) => fs.existsSync(p)), ...(platform === 'win32' ? ['python', 'py'] : ['python3', 'python'])];
}

// Runs inside the target Python. Prints one JSON object per name.
const PY_SCRIPT = String.raw`
import sys, json, importlib, inspect, difflib, pkgutil
def sig(o):
    try:
        return str(inspect.signature(o))
    except Exception:
        return None
def kind(o):
    if inspect.ismodule(o): return 'module'
    if inspect.isclass(o): return 'class'
    if callable(o): return 'function'
    return type(o).__name__
def public(o):
    try:
        return [n for n in dir(o) if not n.startswith('_')]
    except Exception:
        return []
def where_else(top, attr, skip):
    hits = []
    try:
        pkg = importlib.import_module(top)
    except Exception:
        return hits
    for info in list(pkgutil.iter_modules(getattr(pkg, '__path__', []) or []))[:60]:
        if info.name.startswith('_'): continue
        modname = top + '.' + info.name
        if modname == skip: continue
        try:
            m = importlib.import_module(modname)
        except Exception:
            continue
        if hasattr(m, attr):
            hits.append(modname + '.' + attr)
        if len(hits) >= 3: break
    return hits
for name in json.loads(sys.argv[1]):
    parts = name.split('.')
    mod, i = None, len(parts)
    while i > 0:
        try:
            mod = importlib.import_module('.'.join(parts[:i])); break
        except ModuleNotFoundError:
            i -= 1
        except Exception as e:
            print(json.dumps({'name': name, 'ok': False, 'error': 'importing ' + '.'.join(parts[:i]) + ' failed: ' + type(e).__name__ + ': ' + str(e)[:200]})); mod = False; break
    if mod is False: continue
    if mod is None:
        print(json.dumps({'name': name, 'ok': False, 'missingModule': parts[0]})); continue
    obj, path = mod, '.'.join(parts[:i])
    bad = None
    for p in parts[i:]:
        if hasattr(obj, p):
            obj, path = getattr(obj, p), path + '.' + p
        else:
            bad = p; break
    if bad is None:
        print(json.dumps({'name': name, 'ok': True, 'kind': kind(obj), 'signature': sig(obj) if callable(obj) else None}))
    else:
        print(json.dumps({'name': name, 'ok': False, 'owner': path, 'missing': bad,
            'similar': difflib.get_close_matches(bad, public(obj), n=4, cutoff=0.6),
            'elsewhere': where_else(parts[0], bad, path) if inspect.ismodule(obj) else []}))
`;

// Runs inside Electron's Node (ELECTRON_RUN_AS_NODE). argv: names JSON, project root.
const NODE_SCRIPT = String.raw`
const { createRequire } = require('module');
const names = JSON.parse(process.argv[2]);
const req = createRequire(require('path').join(process.argv[3], 'noop.js'));
const close = (a, list) => {
  const d = (x, y) => { const m = Array.from({ length: x.length + 1 }, (_, i) => [i]); for (let j = 1; j <= y.length; j++) m[0][j] = j; for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); return m[x.length][y.length]; };
  return list.filter((k) => !k.startsWith('_')).map((k) => [k, d(a.toLowerCase(), k.toLowerCase())]).filter(([, s]) => s <= Math.max(2, Math.floor(a.length / 3))).sort((x, y) => x[1] - y[1]).slice(0, 4).map(([k]) => k);
};
const keys = (o) => { const out = new Set(); let p = o; for (let i = 0; p && i < 3; i++, p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) out.add(k); return [...out]; };
(async () => {
  for (const name of names) {
    const raw = name.replace(/^node:/, '');
    const scoped = raw.startsWith('@');
    const segs = raw.split('.');
    let pkg = scoped ? segs[0] : segs[0].split('/')[0];
    let rest = segs.slice(1);
    if (!scoped && segs[0].includes('/')) pkg = segs[0];
    let mod;
    try { mod = req(pkg); } catch (e) {
      if (e.code === 'ERR_REQUIRE_ESM') { try { mod = await import(req.resolve(pkg)); } catch (e2) { console.log(JSON.stringify({ name, ok: false, error: String(e2.message).slice(0, 200) })); continue; } }
      else { console.log(JSON.stringify({ name, ok: false, missingModule: pkg })); continue; }
    }
    let obj = mod, path = pkg, bad = null;
    for (const p of rest) {
      const next = obj != null ? (obj[p] !== undefined ? obj[p] : obj.default?.[p]) : undefined;
      if (next === undefined) { bad = p; break; }
      obj = next; path += '.' + p;
    }
    if (bad === null) {
      const kind = typeof obj === 'function' ? (/^class\s/.test(Function.prototype.toString.call(obj)) ? 'class' : 'function') : typeof obj;
      const sig = typeof obj === 'function' ? (Function.prototype.toString.call(obj).match(/^[^{=]*\(([^)]*)\)/)?.[1] ?? null) : null;
      console.log(JSON.stringify({ name, ok: true, kind, signature: sig === null ? null : '(' + sig.replace(/\s+/g, ' ').slice(0, 120) + ')' }));
    } else {
      console.log(JSON.stringify({ name, ok: false, owner: path, missing: bad, similar: close(bad, obj != null && typeof obj !== 'string' ? keys(obj) : []) }));
    }
  }
})();
`;

function pipInstallHint(mod) {
  const known = { PyQt5: 'PyQt5', PySide6: 'PySide6', cv2: 'opencv-python', PIL: 'Pillow', yaml: 'PyYAML', sklearn: 'scikit-learn', bs4: 'beautifulsoup4' };
  return known[mod] || mod;
}

// The model-facing report, one line per name.
function formatResults(results, lang) {
  return results.map((r) => {
    if (r.ok) return `✓ ${r.name} — ${r.kind}${r.signature ? ` ${r.signature.length > 140 ? r.signature.slice(0, 140) + '…' : r.signature}` : ''}`;
    if (r.error) return `? ${r.name} — ${r.error}`;
    if (r.missingModule) return `✗ ${r.name} — "${r.missingModule}" is not installed${lang === 'python' ? ` for this Python (pip install ${pipInstallHint(r.missingModule)})` : ' in this project (npm install ' + r.missingModule + ')'}`;
    const where = r.elsewhere?.length ? ` It exists as: ${r.elsewhere.join(', ')} — import it from there.` : '';
    const sim = r.similar?.length ? ` Did you mean: ${r.similar.join(', ')}?` : '';
    return `✗ ${r.name} — ${r.owner} has no "${r.missing}".${where}${sim}${!where && !sim ? ' Do not use it; look up the real API (read the package docs or source) instead of guessing.' : ''}`;
  }).join('\n');
}

function parseLines(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// `run(cmd, args, opts)` → { code, out } (stdout only). Returns { text, results }.
async function checkApi({ names, language, root, platform, electronPath, tmpDir, run }) {
  const list = parseNames(names);
  if (!list.length) return { text: 'Error: give "names" like ["PyQt5.QtCore.Qt", "fs.promises.readFile"].', results: [] };
  const groups = { python: [], node: [] };
  for (const n of list) groups[languageOf(n, root, language)].push(n);
  const parts = [];
  const all = [];
  if (groups.python.length) {
    const script = path.join(tmpDir, 'qws-check-api.py');
    fs.writeFileSync(script, PY_SCRIPT);
    let res = null;
    let used = null;
    for (const py of pythonCandidates(root, platform)) {
      // The script's folder (QWS's private one) is sys.path[0]; the project folder is not on it.
      const args = py === 'py' ? ['-3', script, JSON.stringify(groups.python)] : [script, JSON.stringify(groups.python)];
      res = await run(py, args, { cwd: tmpDir });
      if (!/ENOENT|not recognized/i.test(res.out) || res.code === 0) {
        used = py;
        break;
      }
    }
    const rs = parseLines(res?.out);
    if (!rs.length) parts.push(`Python check failed${used ? ` (${used})` : ': no Python found'}: ${String(res?.out || '').trim().slice(0, 300) || 'no output'}`);
    else {
      parts.push(`Python${used && used !== 'python' && used !== 'python3' ? ` (${used})` : ''}:\n${formatResults(rs, 'python')}`);
      all.push(...rs);
    }
  }
  if (groups.node.length) {
    const script = path.join(tmpDir, 'qws-check-api.js');
    fs.writeFileSync(script, NODE_SCRIPT);
    const res = await run(electronPath, [script, JSON.stringify(groups.node), root || tmpDir], { cwd: tmpDir, env: { ELECTRON_RUN_AS_NODE: '1' } });
    const rs = parseLines(res.out);
    if (!rs.length) parts.push(`JavaScript check failed: ${String(res.out || '').trim().slice(0, 300) || 'no output'}`);
    else {
      parts.push(`JavaScript:\n${formatResults(rs, 'node')}`);
      all.push(...rs);
    }
  }
  return { text: parts.join('\n\n'), results: all };
}

module.exports = { MAX_NAMES, parseNames, languageOf, nodePackageOf, pythonCandidates, formatResults, checkApi, PY_SCRIPT, NODE_SCRIPT };
