# My App — Python GUI

A PySide6 desktop app. Keep UI construction in functions (like `make_window`) so tests can drive it headless.

## Commands

- Set up: `python -m venv .venv` then `.venv\Scripts\pip install -e .[dev]` (Windows) or `.venv/bin/pip install -e ".[dev]"`
- Run: `python -m app.main`
- Test: `pytest` (tests run headless via QT_QPA_PLATFORM=offscreen)
- Build the .exe: `pyinstaller packaging/app.spec` → `dist/MyApp.exe`
- Release: bump `version` in pyproject.toml, tag `vX.Y.Z`, publish a GitHub release — the workflow builds and attaches the .exe.

## Rules

- Add a test in `tests/` for every feature; keep logic out of event handlers so it stays testable.
- `pytest` must pass before a commit.
