# QWS optimization plan

Goal, in your words: QWS should get results instead of failed attempts, and the app should be
debuggable without you watching it. "Optimize" here means tasks finish correctly on your own
hardware, and when they do not, the reason is recorded in a form a person or a model can act on.

Constraints you set: benchmark both setups (qwen3:8b on the Alien node, and a 14B model on this
PC's 12 GB GPU) and compare; clarify ambiguous task wording; no cloud spend during benchmark runs.

## What the evidence says (before any change)

Sources: the 9 benchmark runs saved today under the app's data folder, and the 13 real
conversations on this PC.

| Finding | Evidence | Cost |
|---|---|---|
| A model partly on the CPU makes every step take minutes, and the app only warns | Calculator task, 2 Nov: qwen3:14b at 69% in GPU, steps of 2 to 10 min, dead after 52 min on a body timeout, 11 steps, nothing working | The real "it just stops" |
| test_app calls a working page "blank screen" | Latest run: counter, hello-world and to-do pages all passed their hidden checks but test_app reported blank; the to-do task then looped and handed off to Opus | Extra steps, loops, cloud hand-offs |
| Small edits that leave a small file broken keep going as edits | json-fix: two edits, syntax check "still broken", reasoning loop, Opus rewrote the 6-line file. runner-game: write with a syntax error, failed edit, Opus rescue | Only passes with cloud help |
| wordcount task wording is ambiguous | Fails identically on every run: `split('\n')` counts the trailing newline as a line | A fixed 1/8 loss |
| The benchmark only runs from the Settings UI and blocks the app | bench.js runs in the renderer; no way to run it unattended or on a schedule | Nobody runs it twice |
| Failure causes are only visible one conversation at a time | Debug reports exist per conversation; no view across tasks of why each ended | You have to notice and report |

Secondary: qwen3:8b spends most of its wall time thinking (600 to 2,400 output tokens per step at
70 tok/s); the first prompt is about 5,200 tokens, which is not the bottleneck.

## Phase 0: measurement that runs without you

1. **Headless benchmark runner** `test/bench-run.mjs` (npm script `bench`): launches the real app
   with Playwright, applies a named setup (model, node, context window, planner off), runs the
   full or quick set, prints the table, and saves the run with a label. Settings are restored
   afterwards. This is the same path as the existing bench smoke test, pointed at real Ollama.
2. **Triage CLI** `test/triage.mjs` (npm script `triage`): reads every saved conversation and
   prints how each ended (done, stopped, step limit, reasoning loop, model error, timed out),
   the slowest step, CPU-spill notices, escalations and the last error, then totals by cause.
   Later this can back a "Diagnose" view in Settings; the CLI comes first because it is what
   lets a model debug the app from a transcript.

Done when: one command runs the suite on a chosen setup and one command explains the last week.

## Phase 1: baseline both setups, planner off

- Setup A: qwen3:8b on Alien (today's node), planner disabled.
- Setup B: qwen3:14b on this PC, context window fitted to the 12 GB GPU, planner disabled.

Done when: two saved runs with labels, so every later run has something to be compared against.

## Phase 2: fixes, ranked by what they cost you today

1. **CPU spill: act, do not warn.** When a non-MoE model is predicted or observed to be partly on
   the CPU and a context window exists that fits, apply Fit to GPU for the task and say so in the
   transcript, instead of a 30-second toast. If nothing fits, say the task will be slow before
   the first step rather than after it.
2. **Blank-screen check uses the page, not only pixels.** A page with a number or a line of text
   on white has almost no brightness variance, so the pixel test flags it. Treat a page as blank
   only when it also has no visible text and no interactive elements.
3. **Small file, broken after an edit: rewrite it whole now.** When the syntax check says a file
   under about 80 lines is still broken after an edit, the next nudge says to rewrite it with
   write_file immediately, instead of after the third failed edit. A write_file refused for a
   syntax error includes the offending line's text.
4. **wordcount task wording:** state that a final line break does not start a new line (the
   `wc` convention) and keep the hidden test as is.
5. **Escalation without a planner:** confirm the ladder still uses a high-performance node when
   the planner is off, so "no cloud" does not mean "no help".
6. Experiment, only if the baseline shows thinking dominating: shorter thinking on the
   test-before-done and summary steps for the qwen3 family. Kept only if the benchmark improves.

Each fix gets a unit test; the bench and checks e2e tests are rerun.

## Phase 3: re-run and compare

Both setups again with the same labels; the report lists per task pass/fail, minutes, requests,
and which tasks were fixed or broken against the baseline. Anything that got worse is reverted.

## Phase 4: ship

Unit tests, the affected e2e tests, README notes under a new version entry, one PR against main.

## Out of scope for this round

App startup and editor responsiveness (no evidence they are a problem); new benchmark tasks
beyond clarifying the existing one; changes to your node or model setup beyond what the runs
measure.

## Results (2026-11-05, planner off, this PC + Alien)

All four runs used `npm run bench`. "Before" ran from a frozen copy of the code as it was; "after"
ran the fixed code.

### Setup A: qwen3:8b on Alien (8 tasks)

| Task | Before | After |
|---|---|---|
| Counter page | pass, 0.9 min | pass, 0.7 min |
| Fix a one-line page | pass, 0.8 min | pass, 0.8 min |
| Fix two bugs in a JS module | pass, 0.7 min | fail, 1.1 min (wrong median formula for odd lists; three `\s+` edits missed, then a rewrite) |
| To-do list page | pass, 0.7 min | pass, 0.7 min |
| Python module from scratch | pass, 0.5 min | pass, 0.4 min |
| Repair a broken JSON file | pass, 1.6 min | pass, 0.4 min |
| Command-line tool | fail (4 lines, not 3) | fail (same; tested its own file without a trailing line break) |
| 3-lane runner game | fail (self-test returned no steps) | fail (duplicate identifier it could not fix in 10 steps) |
| **Total** | **6/8 in 8 min, 38 requests** | **5/8 in 10 min, 46 requests** |

False "blank screen" verdicts from test_app: 3 before (counter, one-line page, to-do), 0 after.
The JS-module flip is the model, not the app: the same model passed before and the failing
formula was written on its first try. The two shared failures are both the model not testing
the case the request named; the test-before-done nudge for command-line tools now asks for an
example that covers the request's named edge cases (not in these runs).

### Setup B: qwen3:14b on this PC (12 GB GPU, Ollama holds 10.5 GB)

Before, all 8 tasks: 4/7 passed in 74 minutes (the 8th was cut off at the 100-minute limit).
Every task took 6 to 16 minutes at 3 to 5 requests, because 4.4 GB of the model sits in system
RAM at a 28K window. After, quick set: 2/3 in 22 minutes, the same speed, which is the point:
no context window of 8K or more fits this model on this GPU, so the app cannot make it fast.
What changed is the first second of the task, which now says so:

> Heads-up: qwen3:14b with a 28672-token context window needs about 14.5 GB, but this PC's GPU
> has about 10.5 GB — part of it will run on the CPU, several times slower: expect minutes per
> step. Even a 4K context window would not fit it — pick a smaller model: qwen2.5-coder:7b is
> installed on this PC and fits with this window.

On a GPU where a window of 8K or more does fit, the window is lowered automatically before the
first request (covered by the gpufit e2e test with a 12 GB GPU and a 14B model at 32K → 9216).

### What this means for you

- Use qwen3:8b (or the 7B coder) on this PC; qwen3:14b cannot do agent work on a 12 GB GPU at
  a useful window. Alien, with its ~10.5 GB, is the same story.
- The two remaining qwen3:8b failures (wc line count, runner game) are the model's; the next
  lever is the planner or a stronger node, which these runs deliberately left off.
- Run `npm run bench -- --label 8b-alien --model qwen3:8b --node Alien` after any change to the
  agent, and `npm run triage` whenever a task ends badly.
