from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMainWindow, QStackedWidget, QTabBar, QVBoxLayout, QWidget, QMessageBox

from app.ui.pages.project_library_page import ProjectLibraryPage
from app.ui.pages.render_page import RenderPage
from app.ui.pages.api_settings_page import ApiSettingsPage


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("AI解说短视频生成器（MVP）")
        self.resize(1100, 720)

        self._tabs = QTabBar()
        self._tabs.addTab("素材库")
        self._tabs.addTab("一键成片")
        self._tabs.addTab("API设置")
        self._tabs.setExpanding(True)
        self._tabs.setDocumentMode(True)

        self._stack = QStackedWidget()
        self._project_page = ProjectLibraryPage()
        self._render_page = RenderPage(project_store=self._project_page.project_store)
        self._api_page = ApiSettingsPage()
        self._stack.addWidget(self._project_page)
        self._stack.addWidget(self._render_page)
        self._stack.addWidget(self._api_page)

        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.addWidget(self._tabs)
        layout.addWidget(self._stack, 1)
        self.setCentralWidget(root)

        self._tabs.currentChanged.connect(self._stack.setCurrentIndex)
        self._tabs.currentChanged.connect(self._on_tab_changed)
        self._tabs.setCurrentIndex(0)
        self._stack.setCurrentIndex(0)

        self.setWindowFlag(Qt.WindowType.WindowMaximizeButtonHint, True)

    def _on_tab_changed(self, idx: int) -> None:
        if idx == 1:
            self._render_page.refresh_projects()

    def closeEvent(self, event) -> None:  # type: ignore[override]
        # Avoid `QThread: Destroyed while thread is still running` on exit.
        if self._project_page.has_running_job or self._render_page.has_running_job:
            r = QMessageBox.question(
                self,
                "任务正在运行",
                "当前有任务正在运行（建库/生成）。\n\n"
                "建议：先点击“取消”，等待停止后再退出。\n\n"
                "是否现在尝试取消任务并退出？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                event.ignore()
                return

            ok1 = self._project_page.cancel_and_wait(timeout_ms=5000)
            ok2 = self._render_page.cancel_and_wait(timeout_ms=5000)
            if not (ok1 and ok2):
                QMessageBox.information(
                    self,
                    "仍在停止中",
                    "任务仍在停止中（可能正在运行FFmpeg或请求API）。\n"
                    "请稍等片刻后再退出，或等待任务自然完成。",
                )
                event.ignore()
                return
        super().closeEvent(event)
