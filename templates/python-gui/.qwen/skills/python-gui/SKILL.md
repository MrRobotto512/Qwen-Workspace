---
name: python-gui
description: How to develop, test and ship this PySide6 desktop app.
---

# Working on this PySide6 app

- UI lives in `app/`; build widgets in functions that return them (see `make_window`) and give important widgets `setObjectName` so tests can find them.
- Wire signals with small named functions when logic grows past a lambda, and put the logic itself in plain functions you can unit-test without Qt.
- Tests run headless: `tests/test_app.py` sets `QT_QPA_PLATFORM=offscreen` and reuses one `QApplication`.
- Long work must not block the UI thread: use `QThread` or `QProcess`, report progress with signals.
- Ship: `pyinstaller packaging/app.spec` makes `dist/MyApp.exe`; the GitHub workflow does the same on `windows-latest` when a release is published and attaches the file.
