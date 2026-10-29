---
name: cli-wrapper
description: How to wire a command-line tool's options into this GUI and ship it.
---

# Wrapping a CLI tool

- `app/args.py` is the contract: one pure `build_args(...)` that turns the UI's choices into the tool's argument list. Add a parameter per option, a widget per parameter, and a test per option in `tests/test_args.py`.
- The tool runs through `QProcess` with merged channels; never `subprocess.run` on the UI thread. Output streams into the log via `readyReadStandardOutput`.
- If the tool prints progress (like `42%`), parse it in `read_output` and switch the progress bar from indeterminate to a real 0–100 range.
- The tool's path persists in `QSettings("my-tools", "my-tool-gui")`; keep new persistent choices there too.
- Document the wrapped tool's arguments in QWEN.md's "The wrapped tool" section so the next task knows the interface.
