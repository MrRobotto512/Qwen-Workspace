"""Runs headless: QT_QPA_PLATFORM=offscreen is set here so CI needs no display."""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from app.main import APP_NAME, make_window

app = QApplication.instance() or QApplication([])


def test_window_builds():
    win = make_window()
    assert win.windowTitle() == APP_NAME
    assert win.centralWidget() is not None


def test_button_updates_label():
    win = make_window()
    win.findChild(object, "action").click()
    assert win.findChild(object, "hello").text() == "It works."
