'use strict';

// Line-diff machinery, kept free of DOM/state so it can be unit-tested in Node.
// Loaded as a plain <script> in the renderer (window.DiffBlocks) and required by tests.

function diffOps(a, b) {
  const A = a === '' ? [] : a.split(/\r?\n/);
  const B = b === '' ? [] : b.split(/\r?\n/);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  if (a2.length * b2.length > 4_000_000) return null;
  const n = a2.length;
  const m = b2.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', A[k], k, k]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) {
      ops.push([' ', a2[i], i + pre, j + pre]);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push(['+', b2[j], i + pre, j + pre]);
      j++;
    } else {
      ops.push(['-', a2[i], i + pre, j + pre]);
      i++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push([' ', A[A.length - suf + k], A.length - suf + k, B.length - suf + k]);
  return ops;
}

function diffStats(a, b) {
  const ops = diffOps(a, b);
  if (!ops) return { added: b.split('\n').length, removed: a.split('\n').length };
  let added = 0;
  let removed = 0;
  for (const [op] of ops) {
    if (op === '+') added++;
    else if (op === '-') removed++;
  }
  return { added, removed };
}

function unifiedDiff(a, b, context = 3) {
  const ops = diffOps(a, b);
  if (!ops) return '(change too large for an inline preview — use Review)';
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end][0] !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run][0] === ' ') run++;
      if (run > context * 2 || end + run >= ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    out.push(`@@ line ${ops[start][3] + 1} @@`);
    for (let x = start; x < end; x++) out.push(ops[x][0] + ops[x][1]);
    k = end;
  }
  return out.join('\n') || '(no changes)';
}

// Changed regions as blocks for per-block accept/reject. Each block is one contiguous run of
// +/- ops; `null` when diffOps gave up (change too large), so callers fall back to all-or-nothing.
function diffSegments(a, b) {
  const ops = diffOps(a, b);
  if (!ops) return null;
  const blocks = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    const startK = k;
    while (k < ops.length && ops[k][0] !== ' ') k++;
    const oldLines = [];
    const newLines = [];
    for (let x = startK; x < k; x++) (ops[x][0] === '-' ? oldLines : newLines).push(ops[x][1]);
    blocks.push({ index: blocks.length, startLine: ops[startK][3] + 1, oldLines, newLines });
  }
  return blocks;
}

// Compose the text with only the accepted change blocks applied (context always kept).
function applyBlocks(a, b, accepted) {
  const ops = diffOps(a, b);
  if (!ops) return b;
  const out = [];
  let block = -1;
  let k = 0;
  while (k < ops.length) {
    const [op, line] = ops[k];
    if (op === ' ') {
      out.push(line);
      k++;
      continue;
    }
    block++;
    const take = accepted.has(block);
    while (k < ops.length && ops[k][0] !== ' ') {
      const [o, l] = ops[k];
      if ((o === '+' && take) || (o === '-' && !take)) out.push(l);
      k++;
    }
  }
  return out.join('\n');
}

const DiffBlocksExports = { diffOps, diffStats, unifiedDiff, diffSegments, applyBlocks };
if (typeof module !== 'undefined' && module.exports) module.exports = DiffBlocksExports;
if (typeof window !== 'undefined') window.DiffBlocks = DiffBlocksExports;
