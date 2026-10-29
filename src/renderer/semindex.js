'use strict';

// Semantic code index (ported from qws): structural chunking at function/class boundaries,
// pluggable embeddings (Ollama's embed endpoint, or a deterministic hash-trigram fallback that
// needs no model), brute-force cosine search (a few thousand chunks is milliseconds), and a
// regex import graph for one-hop "related files". Pure: no DOM, no fs — loaded as a plain
// <script> in the renderer, require()d by the main process and by tests.

const SEM_CODE_EXTS = ['.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const MAX_CHUNK_LINES = 200;
const WINDOW_LINES = 120;
const WINDOW_OVERLAP = 20;

// ---------- hashing ----------
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------- chunking ----------
const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/;
const JS_DEF = /^(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s*\*?\s*(\w+)|class\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)|(\w+)\s*\([^)]*\)\s*\{\s*$)/;

function chunkFile(path, text) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
  const lines = String(text).split(/\r?\n/);
  if (!lines.length || (lines.length === 1 && !lines[0])) return [];
  let defs = [];
  if (ext === '.py') defs = pythonDefs(lines);
  else if (SEM_CODE_EXTS.includes(ext)) defs = jsDefs(lines);
  if (!defs.length) return windowChunks(path, lines);

  const chunks = [];
  if (defs[0].start > 1) chunks.push(makeChunk(path, 'module', 'prelude', 1, defs[0].start - 1, lines));
  for (const d of defs) {
    for (const c of splitBig(path, d.kind, d.name, d.start, d.end, lines)) chunks.push(c);
  }
  return chunks;
}

// Top-level and class-level defs by indentation; a def ends where the next same-or-shallower
// def starts (or at EOF).
function pythonDefs(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF.exec(lines[i]);
    if (!m || m[1].length > 8) continue; // only top-level and first-level methods
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--; // decorators belong to the def
    found.push({ indent: m[1].length, kind: m[2] === 'class' ? 'class' : 'function', name: m[3], start: start + 1 });
  }
  const defs = [];
  for (let i = 0; i < found.length; i++) {
    const d = found[i];
    let end = lines.length;
    for (let j = i + 1; j < found.length; j++) {
      if (found[j].indent <= d.indent) {
        end = found[j].start - 1;
        break;
      }
      if (d.kind === 'class' && found[j].indent > d.indent) {
        end = found[j].start - 1; // a class chunk is its header up to the first method
        break;
      }
    }
    defs.push({ ...d, end });
  }
  return dedupeOverlaps(defs);
}

// Brace-balanced blocks from recognizable definition lines.
function jsDefs(lines) {
  const defs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s/.test(lines[i]) && !/^\s{2}[\w$]/.test(lines[i])) continue; // top level + class methods
    const m = JS_DEF.exec(lines[i].trim());
    if (!m) continue;
    const name = m[1] || m[2] || m[3] || m[4] || '(anonymous)';
    if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
    let depth = 0;
    let end = i;
    let opened = false;
    for (let j = i; j < Math.min(lines.length, i + 2000); j++) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') depth--;
      }
      if (opened && depth <= 0) {
        end = j;
        break;
      }
      end = j;
    }
    defs.push({ kind: /^\s*(export\s+)?class/.test(lines[i]) ? 'class' : 'function', name, start: i + 1, end: end + 1 });
  }
  return dedupeOverlaps(defs);
}

function dedupeOverlaps(defs) {
  // Methods already covered by an enclosing function chunk are kept (they aid retrieval) but
  // exact duplicates are dropped.
  const seen = new Set();
  return defs.filter((d) => {
    const key = `${d.start}:${d.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeChunk(path, kind, name, start, end, lines) {
  const text = lines.slice(start - 1, end).join('\n');
  return { id: fnv1a64(`${path}\x00${text}`), path, kind, name, start, end, text };
}

function splitBig(path, kind, name, start, end, lines) {
  if (end - start + 1 <= MAX_CHUNK_LINES) return [makeChunk(path, kind, name, start, end, lines)];
  const out = [];
  let pos = start;
  while (pos <= end) {
    const stop = Math.min(pos + MAX_CHUNK_LINES - 1, end);
    out.push(makeChunk(path, kind, `${name}[${pos}-${stop}]`, pos, stop, lines));
    pos = stop + 1;
  }
  return out;
}

function windowChunks(path, lines) {
  const out = [];
  let pos = 1;
  for (;;) {
    const stop = Math.min(pos + WINDOW_LINES - 1, lines.length);
    out.push(makeChunk(path, 'window', `L${pos}`, pos, stop, lines));
    if (stop >= lines.length) break;
    pos = stop + 1 - WINDOW_OVERLAP;
  }
  return out;
}

function promptText(chunk) {
  return `# ${chunk.path}:${chunk.start}-${chunk.end} (${chunk.kind} ${chunk.name})\n${chunk.text}`;
}

// ---------- embeddings ----------
// Deterministic hashed character trigrams, L2-normalized. Not semantically smart, but stable,
// offline and fine for keyword-ish recall; Ollama embeddings replace it when available.
function hashEmbed(texts, dim = 256) {
  return texts.map((text) => {
    const vec = new Array(dim).fill(0);
    const t = String(text).toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 2; i++) {
      const h = parseInt(fnv1a64(t.slice(i, i + 3)).slice(-8), 16);
      vec[h % dim] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  });
}

function cosineTopK(query, chunks, k = 6) {
  const scored = chunks
    .filter((c) => Array.isArray(c.vec) && c.vec.length === query.length)
    .map((c) => {
      let dot = 0;
      let nc = 0;
      for (let i = 0; i < query.length; i++) {
        dot += query[i] * c.vec[i];
        nc += c.vec[i] * c.vec[i];
      }
      return { chunk: c, score: dot / (Math.sqrt(nc) || 1) };
    });
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, k);
}

// ---------- import graph ----------
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/gm;
const JS_IMPORT = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function importsOf(path, text, allFiles) {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
  const out = new Set();
  if (ext === '.py') {
    const pkgDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const m of String(text).matchAll(PY_IMPORT)) {
      const mods = m[1] ? [m[1]] : (m[2] || '').split(',').map((x) => x.trim());
      for (const mod of mods.filter(Boolean)) {
        let candidate;
        if (mod.startsWith('.')) {
          const up = mod.length - mod.replace(/^\.+/, '').length;
          let base = pkgDir;
          for (let i = 1; i < up; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
          const rest = mod.replace(/^\.+/, '');
          candidate = [base, rest.replaceAll('.', '/')].filter(Boolean).join('/');
        } else {
          candidate = mod.replaceAll('.', '/');
        }
        for (const probe of [`${candidate}.py`, `${candidate}/__init__.py`]) {
          if (allFiles.has(probe)) {
            out.add(probe);
            break;
          }
        }
      }
    }
  } else if (SEM_CODE_EXTS.includes(ext)) {
    const base = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    for (const m of String(text).matchAll(JS_IMPORT)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = normalizePath(`${base}/${spec}`);
      for (const probe of [target, `${target}.js`, `${target}.ts`, `${target}.jsx`, `${target}.tsx`, `${target}/index.js`, `${target}/index.ts`]) {
        if (allFiles.has(probe)) {
          out.add(probe);
          break;
        }
      }
    }
  }
  return out;
}

function normalizePath(p) {
  const parts = [];
  for (const part of p.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

function depNeighbors(files, hitPaths) {
  // files: Map/obj path -> text. One hop in both directions around the hit paths.
  const all = new Set(Object.keys(files));
  const graph = {};
  for (const p of all) graph[p] = importsOf(p, files[p], all);
  const out = new Set();
  for (const p of hitPaths) {
    for (const t of graph[p] || []) out.add(t);
    for (const src of all) if (graph[src].has(p)) out.add(src);
  }
  for (const p of hitPaths) out.delete(p);
  return out;
}

function formatHits(scored, neighbors) {
  const parts = scored.map(({ chunk }) => `— ${chunk.path}:${chunk.start}-${chunk.end} (${chunk.kind} ${chunk.name})\n${chunk.text}`);
  if (neighbors && neighbors.size) parts.push(`Related files by import graph: ${[...neighbors].sort().join(', ')}`);
  return parts.length ? parts.join('\n\n') : 'No matches in the semantic index.';
}

const SemIndexExports = { SEM_CODE_EXTS, fnv1a64, chunkFile, promptText, hashEmbed, cosineTopK, importsOf, depNeighbors, formatHits };
if (typeof module !== 'undefined' && module.exports) module.exports = SemIndexExports;
if (typeof window !== 'undefined') window.SemIndex = SemIndexExports;
