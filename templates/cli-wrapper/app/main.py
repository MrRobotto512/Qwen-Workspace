"""A window that runs the wrapped tool with QProcess: pick an input, run, watch the log,
cancel if needed. The tool's path is remembered between launches with QSettings."""
import sys

from PySide6.QtCore import QProcess, QSettings
from PySide6.QtWidgets import (
    QApplication, QFileDialog, QHBoxLayout, QLabel, QLineEdit, QMainWindow,
    QPlainTextEdit, QProgressBar, QPushButton, QVBoxLayout, QWidget,
)

from app.args import build_args

APP_NAME = "My Tool GUI"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(760, 520)
        self.settings = QSettings("my-tools", "my-tool-gui")
        self.process: QProcess | None = None

        root = QWidget()
        layout = QVBoxLayout(root)

        tool_row = QHBoxLayout()
        tool_row.addWidget(QLabel("Tool:"))
        self.tool_edit = QLineEdit(self.settings.value("toolPath", ""))
        self.tool_edit.setObjectName("tool")
        self.tool_edit.setPlaceholderText("Path to the command-line tool this app wraps")
        browse_tool = QPushButton("Browse…")
        browse_tool.clicked.connect(self.pick_tool)
        tool_row.addWidget(self.tool_edit, 1)
        tool_row.addWidget(browse_tool)
        layout.addLayout(tool_row)

        in_row = QHBoxLayout()
        in_row.addWidget(QLabel("Input:"))
        self.input_edit = QLineEdit()
        self.input_edit.setObjectName("input")
        browse_in = QPushButton("Browse…")
        browse_in.clicked.connect(self.pick_input)
        in_row.addWidget(self.input_edit, 1)
        in_row.addWidget(browse_in)
        layout.addLayout(in_row)

        run_row = QHBoxLayout()
        self.run_btn = QPushButton("Run")
        self.run_btn.setObjectName("run")
        self.run_btn.clicked.connect(self.run_tool)
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.setObjectName("cancel")
        self.cancel_btn.setEnabled(False)
        self.cancel_btn.clicked.connect(self.cancel_tool)
        self.progress = QProgressBar()
        self.progress.setRange(0, 1)  # idle; indeterminate (0,0) while running
        run_row.addWidget(self.run_btn)
        run_row.addWidget(self.cancel_btn)
        run_row.addWidget(self.progress, 1)
        layout.addLayout(run_row)

        self.log = QPlainTextEdit()
        self.log.setObjectName("log")
        self.log.setReadOnly(True)
        layout.addWidget(self.log, 1)

        self.status = QLabel("Ready.")
        self.status.setObjectName("status")
        layout.addWidget(self.status)
        self.setCentralWidget(root)

    # --- pickers ---
    def pick_tool(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Pick the tool")
        if path:
            self.tool_edit.setText(path)
            self.settings.setValue("toolPath", path)

    def pick_input(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "Pick an input file")
        if path:
            self.input_edit.setText(path)

    # --- running ---
    def run_tool(self) -> None:
        tool = self.tool_edit.text().strip()
        if not tool:
            self.status.setText("Pick the tool first.")
            return
        self.settings.setValue("toolPath", tool)
        self.log.clear()
        args = build_args(self.input_edit.text().strip())
        self.process = QProcess(self)
        self.process.setProcessChannelMode(QProcess.ProcessChannelMode.MergedChannels)
        self.process.readyReadStandardOutput.connect(self.read_output)
        self.process.finished.connect(self.tool_finished)
        self.process.errorOccurred.connect(lambda _e: self.tool_finished(-1))
        self.run_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)
        self.progress.setRange(0, 0)
        self.status.setText("Running…")
        self.process.start(tool, args)

    def read_output(self) -> None:
        if self.process:
            self.log.appendPlainText(bytes(self.process.readAllStandardOutput()).decode(errors="replace").rstrip())

    def cancel_tool(self) -> None:
        if self.process:
            self.process.kill()
            self.status.setText("Cancelled.")

    def tool_finished(self, code: int = 0, *_rest) -> None:
        self.run_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.progress.setRange(0, 1)
        self.progress.setValue(1 if code == 0 else 0)
        if self.status.text() != "Cancelled.":
            self.status.setText("Done." if code == 0 else f"Failed (exit code {code}).")


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
