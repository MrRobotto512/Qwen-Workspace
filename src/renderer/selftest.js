'use strict';

// A game that draws isn't yet a game that plays (storytold/craft-anything's self-test contract):
// every game QWS's agent builds gets a self-test — it starts a game the way a player would,
// drives it with scripted input for a few seconds, measures from the game's OWN STATE whether
// each step of the core loop works, and reports. test_app runs it and reads the report itself,
// so a model that cannot see the screen cannot wave a broken game through:
//  - a web game: `window.selfTest = async () => ({ version: 1, steps: [...] })`, called by
//    test_app after the page loads;
//  - a desktop game: a `--self-test <file.json>` option that writes the same report and exits,
//    run by test_app with `self_test: true`.
// Pure: parses and judges reports.

(() => {
const VERSION = 1;
// The core loop: (step, what it shows).
const CORE = [['move', 'the player moves'], ['act', "the player's main action works"], ['hud', 'the on-screen information is drawn']];

const REPORT = '{"version": 1, "steps": [{"step": "move", "passed": true, "detail": "lane 1 → 2 after ArrowRight"}, {"step": "act", "passed": true, "detail": "jumped: y 0 → 1.8"}, {"step": "hud", "passed": true, "detail": "score 120 and coins 3 drawn"}, {"step": "spawn", "passed": true, "detail": "6 coins and 4 obstacles ahead of the camera, all inside the view"}]}';

const WEB_CONTRACT = `Give every browser game a self-test: define window.selfTest = async () => report, which starts a game the way a player would, drives it with scripted input for a few seconds (dispatch KeyboardEvents or call the game's own input handlers), measures from the game's own state whether each step works, and returns ${REPORT}. Required steps: "move" (the player moves), "act" (the main action works: jump, shoot, eat…), "hud" (score, health or other on-screen info is drawn). Add a step for anything the user said is broken or missing — e.g. "spawn": objects exist, are in front of the camera and inside the view (check positions against the camera, not just that arrays are non-empty). Measure, never hard-code passed: true. test_app runs it after the page loads and the game isn't done until every step passes.`;

const DESKTOP_CONTRACT = `Give every desktop game a --self-test <file.json> option: start a game the way a player would, drive it with scripted input for a few seconds, measure from the game's own state whether each step works, write ${REPORT} to that file and exit. Required steps: "move", "act", "hud", plus one for anything the user said is broken. Then call test_app with self_test: true — it runs the game that way and reads the file.`;

const SYSTEM_LINE = '- When you build a game, give it a self-test (window.selfTest() in a browser game, a --self-test <file.json> option in a desktop game) that plays the core loop with scripted input and measures the game\'s own state; test_app runs it. A game is not done until every self-test step passes — "no console errors" is not enough.';

// A request for a game (so a canvas page from it gets the game contract), not a chart or a
// drawing tool that happens to use a <canvas>.
const GAME_WORDS = /\b(game|games|player|players|level|levels|enemy|enemies|jump|jumps|shooter|runner|platformer|arcade|snake|tetris|pong|breakout|asteroids|flappy|racing|racer|lives|high ?score|surfers?|minecraft|mario|zelda|puzzle|maze)\b/i;
const looksLikeGame = (text) => GAME_WORDS.test(String(text || ''));

// One step of a report, read in the shape QWS asks for ({step, passed, detail}) or the shapes
// models write anyway: {name|id|title|test, pass|ok|success, details|message|info}. A field
// report: the planner gave a counter page a `{pass, steps: [{name, pass, detail}]}` self-test,
// QWS looked only for {step, passed} and called a working page "3 of 3 steps failed".
function readStep(x) {
  if (!x || typeof x !== 'object') return null;
  const name = [x.step, x.name, x.id, x.title, x.test, x.check].find((v) => typeof v === 'string' && v.trim());
  if (!name) return null;
  const flag = [x.passed, x.pass, x.ok, x.success].find((v) => typeof v === 'boolean');
  const st = typeof x.status === 'string' ? x.status.toLowerCase() : '';
  const passed = flag === true || (flag === undefined && /^(pass|passed|ok|success)$/.test(st));
  const detail = [x.detail, x.details, x.message, x.info, x.reason].find((v) => v != null && String(v).trim());
  return { step: name.trim().slice(0, 40), passed, detail: detail == null ? '' : String(typeof detail === 'object' ? JSON.stringify(detail) : detail).trim().slice(0, 200) };
}

// Judge a report (an object, or JSON text). { ok, passed, steps, text }: `ok` false when the
// report can't be read; `passed` only when every step passed. A game (`game: true`, or a report
// that names a core step) must also have passed "move", "act" and "hud"; any other page is judged
// by its own steps.
function judge(report, { game = true } = {}) {
  let r = report;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch (e) {
      return { ok: false, passed: false, steps: [], text: `The self-test report can't be read (${e.message}). ${REPORT}` };
    }
  }
  const raw = Array.isArray(r) ? r : r && typeof r === 'object' ? r.steps || r.results || r.checks || r.tests : null;
  if (!Array.isArray(raw)) return { ok: false, passed: false, steps: [], text: `The self-test returned no steps. It must return ${REPORT}` };
  if (!Array.isArray(r) && Number(r.version) > VERSION) return { ok: false, passed: false, steps: [], text: `The self-test says version ${r.version}; QWS reads version ${VERSION}.` };
  const given = raw.slice(0, 20).map(readStep).filter(Boolean);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const isCore = (s) => CORE.some(([c]) => c === norm(s.step));
  const asGame = game || given.some(isCore);
  if (!asGame && !given.length) return { ok: false, passed: false, steps: [], text: 'The self-test returned no steps with a name, so it shows nothing. Each step needs a name and a measured true/false: {"step": "plus adds one", "passed": true, "detail": "0 → 1"}.' };
  const steps = [];
  if (asGame) {
    for (const [step, shows] of CORE) {
      const s = given.find((x) => norm(x.step) === step);
      steps.push(s ? { step, passed: s.passed, detail: s.detail || (s.passed ? shows : 'failed') } : { step, passed: false, detail: `not tested (${shows})` });
    }
  }
  for (const s of given) if (!(asGame && isCore(s))) steps.push({ ...s, detail: s.detail || (s.passed ? 'passed' : 'failed') });
  const passed = steps.every((s) => s.passed);
  const lines = steps.map((s) => `${s.passed ? '✓' : '✗'} ${s.step}: ${s.detail}`);
  const failed = steps.filter((s) => !s.passed).map((s) => s.step);
  const who = asGame ? 'the game' : 'the page';
  return { ok: true, passed, steps, text: `Self-test (measured by ${who} itself): ${passed ? `every step passed (${steps.length})` : `${failed.length} of ${steps.length} steps failed (${failed.join(', ')}) — ${asGame ? 'the game' : 'it'} is not done`}.\n${lines.join('\n')}` };
}

// The line test_app adds for a page that looks like a game (it draws on a <canvas>) but has no
// self-test, so the model adds one before calling it done.
const MISSING_WEB = `This page draws on a <canvas> but has no window.selfTest(). ${WEB_CONTRACT}`;

const SelfTestExports = { VERSION, CORE, REPORT, WEB_CONTRACT, DESKTOP_CONTRACT, SYSTEM_LINE, MISSING_WEB, judge, readStep, looksLikeGame };
if (typeof module !== 'undefined' && module.exports) module.exports = SelfTestExports;
if (typeof window !== 'undefined') window.SelfTest = SelfTestExports;
})();
