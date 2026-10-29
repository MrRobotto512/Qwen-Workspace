"""The application window. Keep construction in make_window() so tests can build it."""
import sys

from PySide6.QtWidgets import QApplication, QLabel, QMainWindow, QPushButton, QVBoxLayout, QWidget

APP_NAME = "My App"


def make_window() -> QMainWindow:
    win = QMainWindow()
    win.setWindowTitle(APP_NAME)
    win.resize(640, 420)

    root = QWidget()
    layout = QVBoxLayout(root)
    label = QLabel("Hello! Describe what this app should do and let Qwen build it.")
    label.setObjectName("hello")
    button = QPushButton("Click me")
    button.setObjectName("action")
    button.clicked.connect(lambda: label.setText("It works."))
    layout.addWidget(label)
    layout.addWidget(button)
    layout.addStretch(1)
    win.setCentralWidget(root)
    return win


def main() -> int:
    app = QApplication(sys.argv)
    win = make_window()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
