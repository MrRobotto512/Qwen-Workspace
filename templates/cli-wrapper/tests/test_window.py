"""Headless window test: builds the UI and runs a real (tiny) process through it."""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEventLoop, QTimer
from PySide6.QtWidgets import QApplication

from app.main import APP_NAME, MainWindow

app = QApplication.instance() or QApplication([])


def test_window_builds():
    win = MainWindow()
    assert win.windowTitle() == APP_NAME
    assert not win.cancel_btn.isEnabled()


def test_runs_a_process_and_streams_output():
    win = MainWindow()
    win.tool_edit.setText(sys.executable)
    win.input_edit.setText("-cprint('hello from the tool')")
    win.run_tool()
    loop = QEventLoop()
    win.process.finished.connect(lambda *_: loop.quit())
    QTimer.singleShot(10_000, loop.quit)  # safety net
    loop.exec()
    assert "hello from the tool" in win.log.toPlainText()
    assert win.status.text() == "Done."
    assert win.run_btn.isEnabled()
