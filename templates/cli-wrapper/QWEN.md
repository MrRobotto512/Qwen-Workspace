# My Tool GUI — CLI wrapper

A PySide6 window around an external command-line tool: pick inputs, build the argument list, stream output into the log pane, cancel, and remember the tool's path (QSettings).

## The wrapped tool

> Qwen: describe the tool here once you know it — its name, where it lives, and every
> argument this GUI exposes. Then keep `app/args.py` and this section in sync.

Not filled in yet. Paste the tool's `--help` into the chat and ask Qwen to wire up its options.

## Commands

- Set up: `python -m venv .venv` then `.venv\Scripts\pip install -e .[dev]` (Windows) or `.venv/bin/pip install -e ".[dev]"`
- Run: `python -m app.main`
- Test: `pytest` (headless; the window test runs a real tiny process)
- Build the .exe: `pyinstaller packaging/app.spec` → `dist/MyToolGui.exe`
- Release: bump `version` in pyproject.toml, tag `vX.Y.Z`, publish a GitHub release — the workflow builds and attaches the .exe.

## Rules

- Argument building stays in `app/args.py` (pure, no Qt) with a test per option.
- The UI thread never blocks: the tool runs in QProcess, output streams via signals.
