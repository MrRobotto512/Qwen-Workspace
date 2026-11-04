'use strict';

// Repeating cycles of tool calls (from Hermes Agent's agent/tool_guardrails.py, itself a port of
// oh-my-pi#10521): a model that alternates A, B, A, B … — test the page, make the same failing
// edit, test again — with the same arguments and the same results each time never trips the
// "same call twice" guards, because every alternation breaks the streak. Here the recent calls
// are kept with a fingerprint of their result, and a cycle of 2-4 calls that has repeated three
// laps unchanged is named to the model and stops counting as progress.
// Pure: no DOM.

(() => {
const MAX_PERIOD = 4;
const LAPS = 3; // laps of the same cycle that count as a loop
const HISTORY = 64;

function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// Add one finished call to `history` (an array kept on the conversation) and look for a cycle
// ending with it. Returns { period, laps, names } or null.
function observe(history, signature, result, name) {
  history.push({ sig: String(signature), res: fingerprint(result), name: String(name || '') });
  if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
  return detect(history);
}

// The smallest period 2..4 whose last LAPS laps are identical, call for call and result for
// result. (Period 1 — the same call again and again — is the existing repeat guards' job.)
function detect(history) {
  for (let period = 2; period <= MAX_PERIOD; period++) {
    if (history.length < period * LAPS) continue;
    const end = history.length;
    const same = (a, b) => a.sig === b.sig && a.res === b.res;
    // A cycle that is really one call repeated is period 1, not this.
    const tail = history.slice(end - period);
    if (tail.every((x) => same(x, tail[0]))) continue;
    let laps = 1;
    while (end - period * (laps + 1) >= 0) {
      const base = end - period * (laps + 1);
      let ok = true;
      for (let i = 0; i < period && ok; i++) ok = same(history[base + i], history[end - period + i]);
      if (!ok) break;
      laps++;
    }
    if (laps >= LAPS) return { period, laps, names: tail.map((x) => x.name) };
  }
  return null;
}

function notice(cycle) {
  const names = [...new Set(cycle.names)].join(', ');
  return `\n[QWS: the last ${cycle.laps} rounds repeated the same ${cycle.period} calls (${names}) with the same arguments and the same results. Repeating them changes nothing. Do something different: change the arguments, use another tool, ask consult_planner, or tell the user what is blocking you.]`;
}

const LoopGuardExports = { MAX_PERIOD, LAPS, fingerprint, observe, detect, notice };
if (typeof module !== 'undefined' && module.exports) module.exports = LoopGuardExports;
if (typeof window !== 'undefined') window.LoopGuard = LoopGuardExports;
})();
