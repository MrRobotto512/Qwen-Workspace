# Qwen Workspace

A desktop coding workspace for Windows and macOS, powered by **Qwen**. It has a file explorer, a VS Code–style editor (Monaco), a terminal, and a Qwen chat panel that can read, search and edit your project. Every edit and command needs your approval.

## Download

Grab the latest build from the [Releases page](https://github.com/MrRobotto512/Qwen-Workspace/releases):

- **Windows:** the installer, a portable `.exe`, or a zip. The builds aren't code-signed, so SmartScreen may warn you the first time — click **More info → Run anyway**.
- **macOS:** the `.dmg` (Apple Silicon `arm64` or Intel `x64`). The app isn't notarized, so the first launch needs a right-click → **Open** → **Open**; if macOS still refuses, run `xattr -cr "/Applications/Qwen Workspace.app"` once. Updates on macOS open the download page.

On macOS the app installs software with [Homebrew](https://brew.sh) when you ask it to, and Git comes from `xcode-select --install`.

## Features

- **App recipes:** **Start from scratch** now opens a recipe picker. Three working skeletons install into a fresh folder — **Python GUI app** (PySide6 window, pytest, PyInstaller one-file .exe), **Electron app** (electron-builder NSIS + portable, with the tag-vs-version release check), and **CLI wrapper GUI** (a PySide6 window around a command-line tool: pick inputs, stream output into a log pane, cancel, remember the tool's path — made for engines like LibOrbisPkg or AudioSR). Each comes with a QWEN.md (build/run/test/release commands), a skill, a .gitignore and a GitHub Actions release workflow, its tests passing out of the box. Picking one installs it, runs `git init`, makes the first commit and opens a conversation that knows the recipe. "Blank" keeps the old describe-it prompt.
- **Build from scratch:**
  - Ask for something new ("help me make a Switch homebrew app"), or use **Start from scratch** on the home screen.
  - Qwen asks what only you can answer with `ask_user`. Click a suggested answer or type your own, in the question card or the message box.
  - It researches the toolchain with `web_search` and `fetch_url`, preferring official docs and repositories.
  - It saves what it learns (toolchain, build commands, links) to `QWEN.md`, so later conversations start with it.
  - Search uses DuckDuckGo without a key, or Brave Search / SearXNG (**Settings → Research**).
  - Pages on this PC or your local network can't be fetched unless you allow it, because web content can try to steer the AI.
- **Conversations & task history:**
  - Every conversation or agent task is saved per project.
  - The **History** panel lists them by Today / Yesterday / Earlier, with status (running, needs approval, done, failed, stopped) and how many files each changed. Search, rename or delete them.
  - Reopen any of them to see the full transcript and keep going; Qwen remembers the earlier messages.
  - Start a **new conversation** (`Ctrl+N`) while another task keeps running in the background. A badge and the "needs you" pill show when a background task is waiting for approval.
- **Models for this PC:**
  - Detects your GPU, VRAM, RAM and CPU.
  - Rates each catalog model — Qwen, plus Google's Gemma 4 (e2b, e4b, 26B MoE, 31B; tool-capable, needs Ollama 0.20+) — as fast (fits in GPU memory), usable (partly on CPU), slow, or too large, and picks a context window that fits. Older Gemma generations can't use tools in Ollama, so Agent mode doesn't work with them and the catalog leaves them out.
  - Marks the best choice as **Recommended**.
  - Downloads models through Ollama inside the app, with progress.

  Open it from the model menu (top right) or **Settings → Find models**.
- **Long context with YaRN:**
  - Most Qwen models are trained on 32K tokens. YaRN stretches their position encoding to read up to 128K.
  - Ollama can't turn YaRN on by itself, so the **Long context (YaRN)** tab in **Models for this PC** offers builds with YaRN built in (Unsloth's 128K GGUFs on Hugging Face), downloaded through Ollama.
  - For each model, it plans the largest context that fits this PC's memory and sets it when you click **Use**.
  - Qwen3-Coder 30B is natively 256K, so it just gets a bigger context window, with no YaRN build needed.
  - The app warns when the context window is set beyond what the current model handles, and suggests a YaRN build when a conversation is running out of room.

  Qwen notes YaRN can slightly lower quality on short prompts. Use these builds for big tasks and keep a standard model for everyday work.
- **Built-in updates:** the app checks GitHub Releases on startup and every 6 hours.
  - The **installed** version downloads the update in the background and installs it on restart.
  - The **portable** .exe and the zip open the download page instead.
- **Follow Qwen:**
  - The editor opens files as Qwen reads them.
  - Edits Qwen makes stay highlighted in the editor.
  - Edits that need your approval appear as a full-size diff with **Approve** / **Reject**.
- **Changes panel:** every file the current conversation created or edited, with added/removed line counts. Click one to see its diff, or revert it. Reverting only undoes that conversation's changes.
- **Git built in:** clone a repo from the home screen, and commit (with an AI-written message) and push from the Changes panel. If Git isn't on your PC, the app offers to download a portable copy into its own folder — no separate install and no admin rights — so clone, commit and push just work.
- **GitHub flow:** GitHub is the source of truth. The status bar shows your branch with ahead/behind arrows ("↓3 ↑1", fetched on open and every 10 minutes) and a one-click fast-forward Pull (never a merge — on conflicts it shows git's output and changes nothing). The Changes panel's git bar adds **Publish to GitHub** for a folder with no remote (name + private/public card, private by default), **Open pull request** from a task branch (title and description drafted from the commits and diff, editable before `gh pr create`), and **Publish release** (tag from `package.json`/`pyproject.toml`, notes drafted from the commits since the last tag, editable before `gh release create`). After a push from a non-default branch the app offers the PR directly. An optional **Branch per task** setting moves each agent task onto its own `qwen/<task>` branch the moment it first edits a file. Everything runs through the GitHub CLI: the app detects `gh`, offers to install it (winget / Homebrew), and signs you in with `gh auth login --web` in a real terminal — tokens live in gh's own store, never in the app's settings. Every GitHub action asks first, in every approval mode.
- **Claude Code on your nodes:** the folder menu's **Open in Claude Code…** runs Anthropic's `claude` CLI against any of your Ollama nodes — no Anthropic account or spend, since Ollama (0.14+) serves the Anthropic Messages API natively. Pick a node (health- and version-checked) and a model (strongest installed catalog model first), and the app opens your system terminal in the workspace with `ANTHROPIC_BASE_URL` pointed at the node and `claude --model <tag>` ready (Claude Code is a full-screen TUI, which the app's output-only terminal panel can't host). If `claude` isn't installed, the app offers the npm install. Works best with the biggest coder model your node runs — small models struggle with Claude Code's agent harness — and note the CLI still contacts anthropic.com for update checks.
- **Small-model hardening** (ideas from [Strata](https://github.com/Niko1221/Strata)): three fixes for the ways small local models fail. A tool call the model writes *inside its thinking* — so the turn ends with no call and the task just stops — is now found and run, using Strata's rules for telling a real call from a mention (it must end the thinking, start a line, sit outside code fences, name a real tool, and not be cut off), checked against Strata's 37 recorded cases. Garbled tool names (`mcp__fs=write_file`, `Write-File`, a bare name when only one tool has it) are repaired, never guessed when ambiguous. And thinking that goes in circles is caught while it streams — when over a quarter of the recent thinking is passages repeated three times — then stopped, with the model told to act and the step escalated, instead of burning the whole step.
- **Goal mode:** type `/goal` followed by what "done" means (`/goal the calculator builds and opens`). The goal sits above the message box, and after every task a judge — your ⚡ node's strongest model, else the planner, else your everyday model — compares the agent's last reply with the evidence (commands and their exit codes, files changed). Not met → the task continues on its own with the judge's feedback; met → the goal clears. Up to 8 checks per goal; a message after that grants a fresh budget. `/goal off` clears it. A port of Hermes Agent's `/goal`; it catches small models declaring "Done!" before the work exists.
- **Live step progress:** a slow local model no longer looks stuck. Each step shows what it's doing with a running clock — "Reading the prompt (~5.3K tokens) · 1:42" while Ollama processes the conversation, then "Thinking · ~840 tokens · 4.1 tok/s · 3:05" as it generates — and adds "slow: the model is partly on the CPU" when that's why. Debug reports record each step's prompt time, generation speed and output tokens, so you can see where the minutes went. When a model spills onto the CPU, the warning works out the largest context window that fits your GPU and offers **Fit to GPU**; if even 4K wouldn't fit, it says to pick a smaller model. QWS also predicts this *before* a model loads (from Ollama's model details and your GPU's memory), so the heads-up arrives during the first step instead of after a slow one.
- **Small-model safety nets:** an `edit_file` whose old text differs only in indentation is applied anyway (re-indented to match the file), instead of failing and costing another slow step. After a failed edit, the agent may read the file again; the repeat guard used to refuse it. A write that puts letters from another script inside code (`MeshStandard材料`, a known qwen glitch) is flagged at once. Slow local models are never cut off by the 5-minute network timeout any more — a long prompt on a model half on the CPU can take that long before the first token — and Stop still works.
- **API check (`check_api`):** made-up API names are the most common way generated code breaks (Google's XR Blocks team found the same). Before using an import, class or method it isn't sure of, the agent asks `check_api`, which looks in the project's installed packages and answers "✓ exists, with its signature" or "✗ `PyQt5.QtGui` has no `Qt` — it exists as `PyQt5.QtCore.Qt`" / "did you mean `join`?". It covers Python (the project's own interpreter, its venv if any) and JavaScript (`node_modules` and Node's built-ins). After a failed command with an ImportError or AttributeError, the result points the agent at it. Checking never runs your project's own code.
- **LM Studio nodes:** a node can run [LM Studio](https://lmstudio.ai)'s server (the app, or headless with `lms daemon up`) instead of Ollama — add its URL (port 1234) and **Test** detects it. Model names are matched across the two (`qwen3:14b` ↔ `qwen/qwen3-14b`), the node's keep-alive becomes LM Studio's idle TTL, and on a Mac it can serve the faster MLX builds. The ✨ button turns on **speculative decoding**: a small model of the same family drafts tokens that the main model checks, often 1.5–2× faster with identical output. **Auto** picks the largest same-family model at most a quarter of the main model's size. Debug reports show LM Studio's speed and how many draft tokens were kept. QWS doesn't store tokens, so leave "Require Authentication" off in LM Studio's server settings.
- **Images from MCP tools:** when an MCP server returns an image (a GIMP snapshot, a browser screenshot), vision models now see it, and the tool row shows it. Text-only models are told an image came back.
- **GIMP in one click:** Settings → Tools & MCP servers → **Set up GIMP** downloads [gimp-mcp](https://github.com/gimp-mcp/gimp-mcp) (GPL-3.0, pinned to a reviewed version), installs its plugin into GIMP 3.2+, and adds the server. Then in GIMP choose Tools → MCP → Start MCP Server, and Qwen can edit images — making app icons, removing backgrounds, adding text — and look at each result. Needs [uv](https://docs.astral.sh/uv/); QWS tells you how to install it if it's missing.
- **Paste screenshots:** paste (Ctrl+V) or drop an image into the message box — it shows as a chip and goes with your next message to a vision model (gemma4, qwen2.5vl, llava, and the cloud models), in each provider's own format (Ollama's `images`, OpenAI-style `image_url`, Anthropic image blocks). Up to 4 per message, 6 MB each. Only the most recent screenshot is re-sent on later steps; older ones become a short note, so a local vision model isn't re-reading every image each turn. A model name that doesn't look vision-capable gets a hint to switch.
- **Self-written skills:** after a long agent task that worked (8+ tool steps, or 3+ when a stronger model had to rescue it), the ⚡ node — or the planner, or your everyday model — turns what it did into a reusable `SKILL.md`: when to use it, the steps and commands that worked, the pitfalls it hit. It shows as a card; nothing is saved until you click **Save skill**, and then it lands in your personal skills folder for every project. At most one proposal per conversation, none when the task already used a skill or an existing skill covers the same ground. Skills QWS wrote are tracked (uses, last used): unused for 30 days they're marked stale, after 60 they're archived out of the list — restore them from Settings → Skills. Turn it off under Settings → Agent. Idea from Hermes Agent.
- **Checks gate:** type `/checks` and QWS finds your project's test runner (`npm test`, pytest, `cargo test`, `go test`, plus npm `lint`/`typecheck` scripts) and saves it to `.qwen/checks.json`. From then on the checks run before and after every agent task. If a check that passed before fails after, the failure goes back to the agent for one fix attempt; if it's still broken, a card offers to roll back exactly the files that task changed (a file you edited since is left alone). A task that makes a failing check pass says so. Checks are commands, so a `checks.json` that arrives with a cloned repo — or changes outside QWS — never runs until you allow it. `/checks run` runs them now, `/checks off` removes them; the switch is in Settings → Agent. Keep them fast: they run twice per task. Idea from Strata's test-gated attempts.
- **Parallel subagents:** with Ollama on two or more machines, the agent can hand 2–4 independent subtasks to `delegate_tasks`. Each runs as a fresh agent pinned to its own node, all at the same time, and only each one's short summary and list of changed files comes back — the main conversation's context never fills with their tool output. Subagents show up as their own conversations (↳ in the sidebar); a live card in the main chat shows each one's status, with **Open** to watch it or answer an approval it's waiting on. Their file changes join the main conversation's change list, so Review, Revert and the checks gate cover them. Subagents can't ask you questions or delegate further, and Stop stops them too. Turn it off under Settings → Agent. Idea from Hermes Agent's `delegate_task`.
- **Test built GUI apps:** the agent can check a desktop app it built with `test_app`: QWS launches it, waits for its window, screenshots just that window, and reports whether it started or crashed plus its console output — then closes it. It can also click, type and press keys in the window first, like a user ("click 7, click +, click 3, press Enter"), and look at the result. Vision models (gemma4, qwen2.5vl, the cloud models…) get the screenshot; other models get the text report. Launching asks like any command. Clicks and typing use Windows' own automation; on macOS allow QWS under Privacy & Security → Accessibility (and Screen Recording for screenshots); on Linux install `xdotool`.
- **Test web pages and browser games:** give `test_app` an `.html` file (or a localhost URL) and QWS loads it in a hidden, sandboxed window — nothing opens on your desktop. The agent gets the page's console errors (an undefined function, a misspelled variable, a missing file), its console output and a screenshot, and can click, type and press keys (arrows, space, letters) like a player before looking again. `start index.html` hints point the agent here.
- **Steer while it works:** type a message any time — mid-task too. It shows as waiting and reaches Qwen at its next step, with priority over the current plan ("no, use Python, not Swift"). A message sent while the final reply streams keeps the task going instead of getting lost; after a Stop, waiting messages join the conversation without restarting it. Works from paired devices too.
- **Plain-English approvals** (from Strata): a command's approval card states the action in one sentence — "Install the Python packages PySide6 and pytest?", "Delete build and everything in it?" — with the raw command under Details. Details stays open for dangerous commands, so those are always seen in full.
- **Model checks** (from Strata): Settings → Ollama nodes → the check button on a node lists its models; picking one sends a "reply with exactly: pong" prompt and a `get_weather(Paris)` tool call and grades the answer and the call's arguments, so you know which model really does tool calls on which node before relying on it. Results show in the model menu. And after a model's first reply, the app asks the node how much of the model fits in GPU memory — when part of it spills onto the CPU, the transcript says so ("only 11 of 20 GB fits…") and suggests a smaller context window or model.
- **Skills used:** a task that loaded skills ends with a short "Skills used: …" line.
- **Safe commands skip approval** (from [Strata](https://github.com/Niko1221/Strata)'s gate): commands that provably only *look* — `git status/log/diff/show`, `ls`/`dir`, `cat`/`type`, `grep`/`rg`/`findstr`, `head`/`tail`, `where`/`which`, `tree`, version checks — run without an approval card even in Ask mode. Each command is listed with exactly the options known to be read-only; any other option (`sort -o`, `rg --pre`, `tail -f`, `date -s`, `git branch NAME`), any chaining/redirect/expansion, or anything not understood still asks.
- **Approval modes** (in the message box):
  - **Ask:** approve every edit and command.
  - **Auto-edit** (default): edits apply right away, and commands ask unless you've marked them "Always allow".
  - **Full auto:** nothing asks.

  Destructive commands such as `rm -rf`, `del /s` or `git push` always ask.
- **Workspace:**
  - Explorer, project search (`Ctrl+Shift+F`) and go to file (`Ctrl+P`).
  - Monaco editor with tabs.
  - Terminal panel.
  - Home screen with quick actions and recent folders.
- **Qwen chat:**
  - Streaming answers with a collapsible thought process.
  - Each tool call shows as one compact line ("Read main.c · 120 lines ✓"); click it to open the file or diff.
  - Attaches the open file and your selection as context.
  - Code blocks get **Copy**, **Insert** and **Apply** buttons.
  - A context meter shows how full Qwen's memory is.
- **Agent tools:**
  - Always available: `list_files`, `read_file`, `search_code`, `edit_file`, `write_file`, `run_command`, `todo_write`, `ask_user`, `install_app`, plus `web_search` and `fetch_url` unless research is turned off.
  - On demand: `load_skill` (when the project has skills), `install_git`, and `delete_file` / `move_file`, which Qwen loads with `tool_search` when needed.
  - **Install apps by asking:** say "install iTunes" (or VLC, Chrome, VS Code…) and Qwen installs it with **winget**, the Windows Package Manager, after your approval. If winget isn't on the PC, it says so; for Git it falls back to `install_git`, which downloads a portable Git into the app's folder with no winget and no admin rights.
  - Independent lookups in one reply run in parallel; edits and commands run one at a time.
- **Semantic code search:** build an index in **Settings → Semantic code index** and Qwen gains a `semantic_search` tool — "where is auth handled?" finds the right functions by meaning, plus related files from the import graph. Chunked at function/class boundaries, embedded with Ollama's `nomic-embed-text` when installed (otherwise a built-in offline embedder), refreshed incrementally, stored in `.qwen/semindex.json`.
- **Block-level diff approval:** in Ask mode, an edit's approval card shows one checkbox per change block — untick what you don't want and **Apply selected** writes exactly the accepted blocks. Qwen is told the file diverged so it re-reads before editing again.
- **Tool programs (codemode):** with a cloud/planner model driving, Qwen can batch many tool calls into one short JavaScript program (`run_program`) — read ten files, collect results, apply the same edit everywhere — instead of one call per turn. The program runs in a locked-down sandbox (no network, file system, require or dynamic code; only the normal tools, each still under your approval rules; 50-call cap) on its own thread, so a runaway program is stopped at its time limit instead of freezing the app, and the program itself shows in an approval card first, like a command.
- **Automations:** recurring agent tasks — "every morning at 9, run the tests and fix simple failures", "every 4 hours, sweep TODOs". Set them up in **Settings → Automations** (every N hours, or daily at a time with catch-up on launch). Each runs in the project it was created for while the app is open, shows up in History with a ⏱ title, and can be paused, run now, or deleted.
- **Remote sessions (work with your other PCs' sessions):** turn on **Settings → Remote sessions → Allow other devices** on a PC, and it shows a pairing code. On another PC, add that device's URL (e.g. `http://100.88.91.13:8931` over Tailscale) and the code — its conversations now appear in **History → Other devices**. Open one for a live transcript; type to send instructions into *that PC's* agent (its workspace, its tools, its approval mode — a reply while it's asking a question answers the question), or hit Stop. You can also kick off brand-new tasks on the other machine. The host app must be running, raw model history never leaves the host (only the rendered transcript), and the pairing code is a password: whoever holds it can drive that PC's agent, so pair only over your own network.
- **Ollama nodes (run on more than one PC):** add a second Ollama server by URL in **Settings → Ollama nodes** — e.g. a shop PC on your network — and requests go to the first node that is online and has your model — and a task then stays on the node it started on (a busy Ollama can miss a health check, and hopping nodes mid-task cold-loads the model on both sides). If a node stops answering mid-task, the app retries once, moves the task to the next node, and says so in the transcript. Each node gets its own keep-alive, and a remote node defaults to `5m` — it unloads the model and frees its VRAM after 5 idle minutes (set `-1` on the node to keep it loaded; "This PC" follows the Model section's keep-alive as before). The status bar shows how many nodes are up, and the Models window lists what each remote node has installed. With only "This PC" enabled, nothing changes — and disabling "This PC" with a remote node enabled runs everything on that remote (e.g. a laptop using the home GPU over Tailscale). Each node row has a **Connection doctor** (bug icon): it probes the node from inside the app — raw TCP with the exact error code, HTTP, a loopback control, the proxy environment — and prints a verdict that names the actual culprit (per-app firewall/security filtering, macOS Local Network permission, nothing listening, machine asleep, wrong service on the port), with a copyable report. The ⚡ toggle marks a node (This PC included) as **high-performance**: when Qwen gets stuck, the stuck step runs there on the strongest catalog model that node has installed — a free escalation tier below the paid planner. The ladder is: first intervention, one step on the high-perf node; still stuck, the node drives the task; still stuck, the planner takes over. Without a high-perf node everything works as before, and the monthly budget cap only ever gates the planner rung. The optional **Plan first** setting (Settings → Agent) goes one step further, from reactive to proactive: a task's first turn runs on a stronger model, restricted to planning tools — **Plan with** picks which: the ⚡ node's strongest model (free), your planner model (cloud: the best plans, on the cost meter), or the ⚡ node with the planner as fallback when no node can serve — and writes the step plan as todos — naming files and commands, preferring the simplest stack, command-line toolchains only — which your everyday model then executes. The app checks the plan mechanically: steps that name no file and no command get sent back to the planning model once for a rewrite before the handoff. Big model plans, small model grinds, and the bad path never gets taken. The app only connects to URLs you type in; getting the shop PC reachable (LAN, VPN) is up to you, and Ollama on it must listen beyond localhost (`OLLAMA_HOST=0.0.0.0`).
- **Per-conversation model switch:** a model chip in the message box flips just that conversation between your default local Qwen, the planner model (e.g. Gemini), or any installed Ollama model — no trip to Settings. Messages driven by a non-default model carry a badge.
- **Smarter escalation (optional):** two triggers in **Settings → Escalation & costs**, both off by default — when the same command fails N times in a row (default 2), the next step runs on the planner automatically; when a plan touches more than N files (default 5), a card asks "Run this on the planner?" instead of switching silently. Every assistant reply also has a hover **Escalate** button (✦) that rewinds to that point and re-runs it on the planner.
- **Cloud cost meter:** cloud responses report their token usage, and you give the app your own price table (per million tokens — nothing is hard-coded). The conversation's cost shows next to its model chip, the month's total sits in the status bar, and totals survive restarts. An optional monthly budget makes escalations ask first once it's reached.
- **Anthropic Claude as a provider:** pick **Anthropic Claude** as the planner (or main provider) with an API key from [console.anthropic.com](https://console.anthropic.com). The app talks to Claude's native Messages API with full streaming and tool support, and the busy/retired failover knows Claude's model family (opus → sonnet → haiku, newest first).
- **Best Gemini (or Claude) without stalls:** type `auto` as the planner model (or the main model) and QWS uses the best model your key can reach right now — newest pro first, then flash, then flash-lite, read from Google's live model list. When a model is busy (503/429), or a cloud model sends nothing for two minutes, it rests for five minutes and the very next request goes to the next model down — no fixed wait, no retrying into the same overload — and when the rest is over QWS climbs back up instead of finishing the task on a weaker model. A model your key can't use rests a day. The same ladder covers every cloud call: task steps, escalations, plan-first, `consult_planner`, the review pass, the goal judge, lessons and skills; the cost meter charges whichever model actually answered. A named model works too — it is tried first, with its family behind it.
- **Spec-driven skills (from [sdd-skill](https://github.com/fpapleux/sdd-skill)):** type `/<skill> <arguments>` — for example `/sdd quick "Add a total command"` — and that skill's instructions go straight into the message, the way Claude Code runs skills. Every loaded skill is told its own folder, so a skill that says "run `python3 <skill folder>/scripts/sdd.py`" points at the real path, and on Windows `python3` (usually missing, or the Microsoft Store stub) runs with the project's virtualenv, the `py -3` launcher or `python` instead. Installing a skill from GitHub now takes folders of up to 80 files (sdd-skill is 39): paste `https://github.com/fpapleux/sdd-skill/tree/main/skill/sdd` under Settings → Skills.
- **Model per job:** `delegate_tasks` subtasks pick a tier — `strong` runs on the ⚡ node, else the planner model (writing or reviewing a spec, design, a bug the agent could not fix, checking finished work with fresh eyes), `mid` on the everyday model, `light` on a smaller model of the same family that a node has installed (qwen3:8b → qwen3:4b). Skills written for Claude Code's `opus`/`sonnet`/`haiku` map onto the same three. Subagents now work on one PC too, whenever a ⚡ node or a planner is set up; subtasks that share a machine run one after another, different machines at once. A strong subtask on a paid planner asks first, unless "Agent consults freely" is on, and the monthly budget always applies.
- **Stop rule:** when a command fails, the agent must name the root cause (the test, the code, the request or the environment) before fixing it. After two fixes for the same error have failed, it stops and reports to you — what fails, the cause it suspects, what it tried — instead of piling up guesses; with "Agent consults freely" it asks the planner first and gets one try of its advice. A third rerun of that command in the same task is refused. A fix that turns the error into a different one counts as progress, not as a failure. A stronger model taking over starts with a clean count. Toggle it in Settings → Agent.
- **Regressions vs. unfinished tests:** the checks gate now reads which tests failed (pytest, unittest, node:test, jest/vitest, go, cargo). A test that passed before the task and fails now is a regression, as before: one fix try, then the rollback card. A test the task wrote itself that doesn't pass yet just means the task isn't finished. The agent gets one try to make it pass, and its changes are never rolled back for it. Breaking more existing tests in a suite that was already failing now counts as a regression too.
- **Browser control:** Settings → Tools & MCP servers → **Set up browser control** adds Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp) (pinned, fetched by npx), so Qwen can open pages, click, type, fill forms and read pages as text — no vision model needed. Pick how it runs: **QWS's own browser profile** (a separate Chrome or Edge profile you sign in to once; your normal profile isn't touched), **My Chrome/Edge** (your running browser and its tabs, through the Playwright MCP Bridge extension) or **Headless** (invisible, no saved logins). Browser tools have their own rules in every approval mode, Auto included: reading a page never asks; opening, clicking and typing ask once per website ("Allow on github.com" is remembered and listed in Settings, where you can remove it); your own localhost pages never ask; running JavaScript in a page, uploading files from your PC and touching cookies or storage ask every time. Page text reaches the model as untrusted web content — it is told never to follow instructions found on a page and to stop and ask before buying, sending, posting or deleting anything.
- **Honest finish:** QWS no longer lets a small model "confirm" its way around the work. A command that only prints text (`echo "PROJECT COMPLETED"`) isn't run, and neither it nor an unchanged plan counts as progress; when the model sends the same final summary again with only such calls, the task ends there with that summary as the answer. When the model can't see images, every `test_app` screenshot comes with a plain warning that "no console errors" is not "looks right", a pixel check that flags an empty or flat picture, and a short description from a vision model — one on another Ollama node first, then the planner if it can see, then one on this PC (Settings → Agent → *Describe screenshots for models that can't see*). Compaction keeps your own messages word for word, so a bug you reported stays open until a test shows it fixed, and the summary marks the model's unproven claims as "Claimed, not verified". A cloud model that answers with a used-up quota (Gemini's `RESOURCE_EXHAUSTED`) rests until that quota resets — until midnight Pacific for a daily limit — instead of being retried every five minutes, and QWS explains it once: a free-tier API key's limits are not raised by a Google AI Plus, Pro or Ultra subscription; billing on the key's Cloud project is.
- **Prove it works** (ideas from [Craft Anything](https://github.com/storytold/craft-anything)): a game QWS builds gets a **self-test** — `window.selfTest()` in a browser game, a `--self-test <file.json>` option in a desktop game — that plays the core loop with scripted input and measures the game's own state (did the player move, did the jump work, is the score drawn, are the coins actually in view). `test_app` runs it and reads the report itself, and a failing step fails the test, so "no console errors" can't pass for "works". A **blank screenshot** (one flat colour) fails `test_app` too. Pass `compare_with` (a picture in the project, or the original page's URL) and `test_app` says how alike the build looks at **1440, 768 and 390 px** wide. Commands the agent runs can no longer hang waiting for a person: their input is closed and git's pager, editor and password prompts are off, so a `y/n` question fails in a second instead of eating the 2-minute timeout.
- **Craft Anything tools:** Settings → Tools & MCP servers → **Set up Craft Anything** downloads the [Craft Anything](https://github.com/storytold/craft-anything) command-line tool (pinned release, checked against its SHA-256 checksums) and adds it as an MCP server: ~320 tools that study programs (.NET, Java, Android, Electron, native code with its own disassembler and decompiler), firmware, game files and websites. Its results reach the model marked as untrusted content. Craft Anything is in early alpha; use it on software you own or may examine.
- **Free cloud models:** **OpenRouter** lists its free models in Settings (Fetch models, with *List free models only*) with what each can do — `free · tools · images · 131K` — and defaults to `openrouter/free`, which picks a free model able to call tools. **Groq** is a provider of its own (free tier, very fast). Each provider shows a sign-up link and what its free tier allows under the API key field (also Gemini and Anthropic). Free-tier limits are handled in plain words: a per-minute limit is waited out and the task carries on; OpenRouter's 50-requests-a-day limit (1,000 with $10 of credits) and Groq's daily limits stop the step with an explanation; a tool call Groq refuses as malformed is sent back to the model to fix.
- **GPU crash recovery and better plans:** when the model runner crashes mid-task (`CUDA error: an illegal memory access`, out of GPU memory, a runner that died), QWS retries the step once — the server reloads the model — then moves to another node that has the model, then runs the next step on the ⚡ node or the planner, and only then stops, saying what usually helps (update Ollama and the GPU driver, lower the context window). A task that ended in an error no longer gets a review pass. In plan-first mode, a plan that builds the whole thing in one step ("create the full game") or has bare "test" / "polish" steps goes back to the planner, which is asked for one checked piece per step — "<file>: <what to add> — done when <check>". The screenshot describer now says when it is looking at a start screen and where the Start button is, so the model knows to click it.
- **Detailed plans:** in plan-first mode the planner first explains, in its reply, how it would complete the request — the files, the main objects and functions and how they fit together, the numbers to use, the order of the work and what could go wrong — and then gives every step a **details** section: what to write (with names), the exact values, how it connects to earlier steps, pitfalls and the check that shows it done. A step without real details goes back for a rewrite. The everyday model gets the planner's approach and the current step's details on every turn (so a long task's summaries can't lose them), and the plan bar shows each step's **How** when you open it.
- **Plans that arrive, edits that land:** a planning turn gets room to answer (16,000 tokens, whatever "Max response tokens" says), and a reply cut off at the limit before it said anything is retried with more room instead of being passed on as an approved plan; a planner that sends nothing back is asked again, and after three tries the everyday model plans for itself. Files you name in your request ("make subwaysurfer.html") are passed to the planner and to every step, so the work goes into exactly those files. `edit_file` copes with text that differs only in spaces and line breaks (a one-line file edited as if it were pretty-printed), when it matches one place; a failed edit now counts as a failed step, the error shows a small file's real text, and the same failed edit is refused the third time with a nudge to rewrite a small file whole.
- **Planner handoff (two models):**
  - Let a local Qwen do the grunt work and hand the hard parts to a stronger "planner" model (e.g. Gemini 2.5 Pro, or another Qwen in the cloud). Set it up in **Settings → Planner (heavy model) handoff**.
  - When Qwen stalls — repeating steps without progress — the next step runs on the planner automatically to break the impasse, then control returns to Qwen.
  - Qwen can also ask the planner for help on demand with a `consult_planner` tool (a design decision, a tricky bug, a review), and uses the advice to keep working locally. By default it is told to do that sparingly; tick **Let Qwen consult the planner whenever it's unsure** (Settings → Planner) and it asks whenever it is unsure — a design choice, an error it doesn't understand, a fix that keeps failing — and a failed command nudges it to ask before trying again. Each consultation is on the cost meter, and once your monthly budget is reached it asks you first, like escalations do.
  - A small badge on a message shows when it ran on the planner. The planner's requests go to that provider and use its quota/billing; the grunt work stays on your local model.
- **MCP servers (external tools):**
  - Add servers in **Settings → Tools & MCP servers** (a command like `npx -y rea-agents mcp`, or an `https://` URL).
  - Their tools join Qwen's toolset as `mcp__<server>__<tool>`. Like the other extra tools, Qwen loads them with `tool_search` only when a task needs them, so a big server doesn't crowd the tool list — the system prompt lists each server as one line (tool count plus a few example names), not every tool's description, so even a 70-tool server costs a few dozen tokens. If the app's instructions and tool definitions ever take most of the model's context window, the conversation says so and points at the fix (a bigger context window, or fewer servers) instead of letting Ollama silently truncate your request.
  - **Per project:** each server row has an "On here / Off here" switch for the open project. A server switched off here stays connected for your other projects, but its tools are hidden from Qwen in this one (no context cost, and its tools refuse) — so a heavy reverse-engineering kit only costs context where you use it.
  - Each MCP call needs your approval (with an "Always allow" option per server). The status bar shows how many servers and tools are connected.
  - Works with any MCP server, e.g. [REA](https://github.com/morluto/rea) for reverse engineering. Node-based servers need Node.js installed.
- **Workflows:**
  - Bundled starter setups you install into a project from the home screen.
  - **Software factory:** adapted from the [multi-agent original](https://github.com/zazencodes/zazencodes-season-3/tree/main/src/software-factory-claude-code) for a single local model. Say "run the factory: <feature>" and Qwen runs it through spec → build → review (code + security) → decide, on its own git branch, writing a record of each stage under `factory/jobs/`. Nothing is merged or pushed without you asking.
- **Review pass (planner reviews, Qwen fixes):** the eye button in the Changes panel — or the optional "after every task" toggle in Settings → Escalation & costs — sends the conversation's diff to the planner model, which returns concrete findings: file, line, what breaks, and the exact fix. One click hands them to the local model to implement (through the normal edit approvals), a second automatic review confirms the fixes, and anything that survives two rounds gets implemented by the planner directly instead of ping-ponging. Reviews respect the monthly budget cap and show up on the cost meter; style nits are explicitly out of scope — it hunts real defects.
- **Search past chats** (from Hermes Agent): the agent has a `search_history` tool over your saved conversations in every project — "how did we fix the PyInstaller spec last time?" returns the matching conversations with snippets, and passing a result's id reads it. Runs without approval (it only reads).
- **Personal memory** (Hermes Agent's USER.md idea): one short file of facts about you and your setup — machines, OS, preferred stacks — that every conversation in every project sees. Edit it in Settings → Agent → Personal memory; the agent proposes additions with a `remember` tool, and because it reaches beyond the project, each fact asks for approval in every mode. Up to 4,000 characters; project details still belong in QWEN.md.
- **QWEN.md learns from each task (Lessons):** after an agent task that ran commands, up to 3 durable lessons are proposed — a build command that worked, an error and its fix, a toolchain quirk — as an edit to a `## Lessons` section of QWEN.md, shown in the block-level diff card. A task that needed rescuing teaches harder: the model that did the rescuing (the ⚡ node, or the planner) writes the lessons instead, fed a digest of the escalations and failed commands, and asked specifically what would have prevented them — phrased as instructions to the everyday model, which reads QWEN.md in its system prompt on the next task. Every escalation makes the next task smarter. Nothing is written without your approval; chat-only tasks and tasks with no commands are skipped; repeats of what QWEN.md already says are deduped away; and when the section fills past 40 lines the proposal merges old entries instead of growing forever. Turn it off in Settings → Agent.
- **Project memory and skills:**
  - Put standing instructions for Qwen in `QWEN.md` (or `AGENTS.md`) at the project root.
  - Put task-specific instructions in `.qwen/skills/<name>/SKILL.md`. Personal skills that apply to every project go in `%APPDATA%\qwen-workspace\skills\`.
  - **Claude-format skills work as-is:** the project's `.claude/skills` and your personal `~/.claude/skills` are picked up too, so skills made for Claude Code run here unchanged.
  - **Install from GitHub:** in **Settings → Skills**, paste a link to a repo or to a folder containing `SKILL.md` (e.g. `…/tree/main/skills/my-skill`) and click Install.
  - Qwen sees only each skill's name and description, and loads the rest when a task calls for it.
- **Plan and compaction:**
  - For multi-step tasks, Qwen keeps a plan (shown above the message box).
  - When a conversation nears the context window, older turns are summarized automatically. Click the context meter to summarize now.
- **Debug reports:** when a task goes sideways, click **Save debug report** (on any error message, or in the model chip's menu) and the whole story lands in `.qwen/debug/` as one markdown file: app version, redacted settings (API keys never leave the machine), the event timeline (every request with the model and node that served it, every tool run with its outcome and timing, every retry, failover, nudge, escalation and compaction), and the full message history the model actually saw. The toast's **Diagnose in a new chat** button opens a fresh conversation pre-filled to read the report — point it at the planner model and let it explain what went wrong.
- **Loop protection:** if Qwen repeats the exact same lookup, the app skips it and tells Qwen to move on. If it keeps stalling, Qwen is nudged to finish or ask a question. A task stops after a set number of steps (Settings → Agent, default 60) so a loop can't run forever; the stop message has a one-click **Continue**.

## 1. Get a Qwen model running

### Option A: Ollama (free, local, private)

1. Install Ollama from https://ollama.com/download.
2. Pull a Qwen coding model that fits your GPU:

   ```powershell
   ollama pull qwen2.5-coder:7b     # ~5 GB, good for 8 GB+ VRAM
   ollama pull qwen2.5-coder:14b    # better, needs ~12 GB VRAM
   ollama pull qwen3-coder:30b      # best local option if you have the memory
   ```

3. In the app, open the model menu (top right) → **Models for this PC** and download the recommended model. Or pull one yourself with the commands above.

The app talks to Ollama's own API and sets the context window itself (32,768 tokens by default; change it under **⚙ → Context window**). Use a lower value if Ollama runs out of GPU memory. The status line under the chat shows how much of the window is in use.

### Option B: LM Studio

Download a Qwen2.5-Coder or Qwen3-Coder model, then start the local server from the **Developer** tab (port 1234). For long context, download one of Unsloth's "128K" GGUFs (search for, say, `Qwen2.5-Coder-14B-Instruct-128K`). They have YaRN built in; raise the context length when loading the model.

### Option C: Cloud API

Use a cloud model when you want more capability than your PC can run locally. Pick the provider in **Settings → Provider**, paste your API key, click **Fetch models** and choose one:
- **Google Gemini** — a strong coder with a very large context window. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey); good default `gemini-2.5-flash` (fast/cheap) or `gemini-2.5-pro` (stronger).
- **Alibaba Cloud Model Studio (DashScope)** — `qwen3-coder-plus`.
- **OpenRouter** — `qwen/qwen3-coder` and many others.

Cloud models send your code and prompts to that provider and use its quota/billing, unlike local Ollama which stays on your machine. Set **Max response tokens** in Settings to bound cost.

## 2. Run the app

You need [Node.js 20+](https://nodejs.org) on Windows.

```powershell
git clone https://github.com/MrRobotto512/Qwen-Workspace.git
cd Qwen-Workspace
npm install
npm start
```

In the app:

1. Click **⚙** in the top-right.
2. Pick your provider, click **Fetch models**, choose a Qwen model and click **Save**.
3. Open your project folder.

The dot next to the model name turns green when the app can reach the model server.

## 3. Build a Windows installer

```powershell
npm run dist        # installer, portable .exe and zip in dist/
```

GitHub Actions also builds the app on every push to `main`; the builds are under **Actions → Build Windows app → Artifacts**. When you publish a release on GitHub, the same workflow attaches the installer, the portable .exe and the zip to it.

## Updates

Publishing a GitHub release is all it takes. The **Build Windows app** workflow:
1. Sets the app version from the release tag (`0.3.0` or `v0.3.0` both work).
2. Builds the app.
3. Attaches the installer, portable .exe, zip and the update feed (`latest.yml`) to the release.

Installed copies pick it up within six hours, or right away through **Settings → Check for updates**.

## Tips

- Switch between **Agent** and **Chat** below the message box. Agent mode needs a model that supports tool calling (Qwen2.5-Coder, Qwen3 and Qwen3-Coder all do). In Chat mode, Qwen labels full-file code blocks with their path, so **Apply** still works.
- Turn **Follow Qwen** on or off in the status bar.
- Manage always-allowed commands in **Settings → Agent**.
- Right-click a file in the explorer and choose **Add to chat**, or press `Ctrl+Shift+A` to attach any file.
- Keyboard shortcuts:
  - `Ctrl+N` new conversation
  - `Ctrl+Shift+H` history
  - `Ctrl+O` open a folder
  - `Ctrl+P` go to file
  - `Ctrl+Shift+F` search
  - `Ctrl+B` toggle the side panel
  - `Ctrl+S` save
  - `Ctrl+W` close the tab
  - `` Ctrl+` `` toggle the terminal
  - `Ctrl+L` focus the chat
  - `F12` open DevTools
- Qwen can only touch files inside the open project folder.
- Settings are stored in `%APPDATA%\qwen-workspace\` on Windows and `~/Library/Application Support/qwen-workspace/` on macOS (settings.json, conversations, skills).

## How Qwen's context is assembled

Each request is built in layers, from least to most likely to change, so Ollama can reuse its prompt cache:

1. **System prompt**, fixed for the whole conversation. It holds Qwen's role and rules, the OS and project folder, `QWEN.md`, the list of skills and the names of the deferred tools.
2. **History**, stored as it happened. Older turns may be replaced by a `<conversation-summary>`.
3. **A `<system-reminder>` on the newest message only.** It holds the open file and selection, the plan, and the files changed so far. It's rebuilt for every request and never stored, so earlier turns stay byte-identical.

Long tool results come back in pages (`read_file` returns 400 lines at a time with a pointer to the next page), instead of whole files.

### Skill file format

```markdown
---
name: build-cmake
description: How to configure and build this project with CMake on Windows
---
Steps, conventions and gotchas go here. Other files in the folder can be loaded by name.
```

## Project layout

```
src/
  main.js            Electron main process: window, file system, commands, streaming model API
  preload.js         Safe bridge exposed to the UI as window.api
  program-worker.js  Tool programs (run_program): the VM sandbox, on a worker thread main can kill
  mcp.js             MCP server connections (stdio and HTTP) for the main process
  remote.js          Remote sessions: the pairing-code HTTP server other devices talk to
  web.js             Web search and page fetch for the web tools
  hardware.js        GPU / VRAM / RAM / CPU detection
  updater.js         Update checks against GitHub Releases (electron-updater for the installer)
  renderer/          Classic scripts sharing one global scope, loaded in index.html order
    index.html       Layout and script order
    styles.css       Dark theme
    icons.js         Line icons and file-type badges
    models.js        Model catalog (Qwen + Gemma 4) and hardware fit estimates
    nodes.js         Ollama nodes: settings migration, health-based routing, failover picks
    github.js        GitHub flow helpers: branch slugs, ahead/behind parsing, versions, notes
    lessons.js       QWEN.md Lessons: bullet parsing, section math, dedupe, command summary
    debuglog.js      Debug reports: event log, settings redaction, markdown rendering
    remote-ui.js     Remote sessions: host-side run handlers, device list, live viewer
    reviewpass.js    Review pass: diff packaging, findings parsing, fix-handover prompts
    claudecode.js    Claude Code launcher: env/command building, node + model picking
  convsearch.js      Past-conversation search: term scoring, snippets, condensed reads
    escalation.js    Escalation triggers: command fail streaks, big-plan detection
    costs.js         Cloud cost meter: monthly spend record, price table math, budget cap
    approvals.js     Approval rules: dangerous-command detection, command chain splitting
    toolparse.js     Text tool-call parsing, stall/tutorial detection, model failover helpers
    schedule.js      Automation schedule parsing (every N minutes / daily at HH:MM)
    semindex.js      Semantic index: code chunking, hash embeddings, cosine search, dep graph
    diffblocks.js    Diff engine: ops, stats, unified view, block segments, partial apply
    providers.js     Provider catalog, planner (heavy) model, per-conversation override
    tools.js         Agent tool definitions, per-conversation toolset, tool display map
    git.js           Git flows: ensure/install git, commit card, push, clone
    history.js       Conversations: create, persist, restore, History panel
    agent-loop.js    The send/stream/tool loop, approvals, execution, recovery, compaction
    automations.js   Recurring agent tasks: scheduler tick and settings list
    settings-ui.js   Settings panel, model lists, connection checks, skills and MCP settings
    models-ui.js     "Models for this PC": catalog, downloads, YaRN builds
    app.js           Wiring: editor, explorer, chat UI, diff view, terminal, updates, menus
```
