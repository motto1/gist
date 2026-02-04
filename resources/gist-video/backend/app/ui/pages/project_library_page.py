from __future__ import annotations

import os
from dataclasses import dataclass

from PySide6.QtWidgets import (
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMessageBox,
    QPushButton,
    QProgressBar,
    QPlainTextEdit,
    QSpinBox,
    QWidget,
)

from app.core.project_store import ProjectStore
from app.jobs.index_job import IndexJobRequest
from app.workers.job_runner import JobRunner


@dataclass(frozen=True)
class _UiState:
    busy: bool


class ProjectLibraryPage(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.project_store = ProjectStore.default()

        self._runner = JobRunner(parent=self)
        self._runner.progress.connect(self._on_progress)
        self._runner.log.connect(self._append_log)
        self._runner.finished_ok.connect(self._on_job_ok)
        self._runner.finished_err.connect(self._on_job_err)

        self._project_name = QLineEdit()
        self._create_btn = QPushButton("Create Project")
        self._create_btn.clicked.connect(self._create_project)

        self._projects = QListWidget()
        self._projects.itemSelectionChanged.connect(self._sync_buttons)

        self._add_videos_btn = QPushButton("添加视频...")
        self._add_videos_btn.clicked.connect(self._add_videos)

        self._build_btn = QPushButton("建立/更新索引")
        self._build_btn.clicked.connect(self._build_index)

        self._max_videos = QSpinBox()
        self._max_videos.setRange(0, 9999)
        self._max_videos.setValue(0)
        self._max_videos.setToolTip("0=全部；填2表示只处理前2个视频，用于快速预览效果。")

        self._pause_btn = QPushButton("暂停")
        self._pause_btn.clicked.connect(self._pause_or_resume)
        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.clicked.connect(self._cancel)

        self._progress = QProgressBar()
        self._progress.setRange(0, 100)
        self._progress.setValue(0)

        self._status = QLabel("空闲")
        self._log = QPlainTextEdit()
        self._log.setReadOnly(True)

        top = QFormLayout()
        top.addRow("项目名称：", self._project_name)

        actions = QHBoxLayout()
        self._create_btn.setText("新建项目")
        actions.addWidget(self._create_btn)
        actions.addStretch(1)
        actions.addWidget(self._add_videos_btn)
        actions.addWidget(QLabel("本次处理前N个视频(0=全部)："))
        actions.addWidget(self._max_videos)
        actions.addWidget(self._build_btn)
        actions.addWidget(self._pause_btn)
        actions.addWidget(self._cancel_btn)

        layout = QHBoxLayout(self)
        left = QFormLayout()
        left.addRow(QLabel("项目列表："))
        left.addRow(self._projects)
        left_widget = QWidget()
        left_widget.setLayout(left)

        right = QFormLayout()
        right.addRow(top)
        right.addRow(actions)
        right.addRow(self._status)
        right.addRow(self._progress)
        right.addRow(QLabel("日志："))
        right.addRow(self._log)
        right_widget = QWidget()
        right_widget.setLayout(right)

        layout.addWidget(left_widget, 1)
        layout.addWidget(right_widget, 2)

        self._refresh_projects()
        self._set_ui(_UiState(busy=False))

    @property
    def has_running_job(self) -> bool:
        return self._runner.is_running

    def cancel_and_wait(self, timeout_ms: int = 3000) -> bool:
        return self._runner.cancel_and_wait(timeout_ms=timeout_ms)

    def _refresh_projects(self) -> None:
        self._projects.clear()
        for p in self.project_store.list_projects():
            self._projects.addItem(f"{p.name}  ({p.project_id})")

    def _selected_project_id(self) -> str | None:
        row = self._projects.currentRow()
        if row < 0:
            return None
        p = self.project_store.list_projects()[row]
        return p.project_id

    def _sync_buttons(self) -> None:
        has_project = self._selected_project_id() is not None
        self._add_videos_btn.setEnabled(has_project and not self._runner.is_running)
        self._build_btn.setEnabled(has_project and not self._runner.is_running)

    def _set_ui(self, st: _UiState) -> None:
        self._create_btn.setEnabled(not st.busy)
        self._project_name.setEnabled(not st.busy)
        self._pause_btn.setEnabled(st.busy)
        self._cancel_btn.setEnabled(st.busy)
        self._sync_buttons()
        if not st.busy:
            self._pause_btn.setText("暂停")

    def _append_log(self, msg: str) -> None:
        self._log.appendPlainText(msg)

    def _create_project(self) -> None:
        name = self._project_name.text().strip()
        if not name:
            QMessageBox.warning(self, "缺少项目名称", "请输入项目名称。")
            return
        p = self.project_store.create_project(name=name)
        self._project_name.setText("")
        self._refresh_projects()
        for i in range(self._projects.count()):
            if p.project_id in self._projects.item(i).text():
                self._projects.setCurrentRow(i)
                break

    def _add_videos(self) -> None:
        project_id = self._selected_project_id()
        if not project_id:
            return
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "选择视频文件",
            os.getcwd(),
            "Videos (*.mp4 *.mkv *.mov *.avi);;All files (*.*)",
        )
        if not paths:
            return
        self.project_store.add_videos(project_id=project_id, video_paths=paths)
        QMessageBox.information(self, "已添加", f"已添加 {len(paths)} 个视频。")

    def _build_index(self) -> None:
        project_id = self._selected_project_id()
        if not project_id:
            return
        req = IndexJobRequest(
            project_id=project_id,
            frames_per_clip=3,
            max_videos=int(self._max_videos.value()),
        )
        self._log.clear()
        self._status.setText("正在建立索引...")
        self._progress.setValue(0)
        self._set_ui(_UiState(busy=True))
        self._runner.start_index_job(req)

    def _pause_or_resume(self) -> None:
        if not self._runner.is_running:
            return
        if self._runner.is_paused:
            self._runner.resume()
            self._pause_btn.setText("暂停")
            self._status.setText("运行中...")
        else:
            self._runner.pause()
            self._pause_btn.setText("继续")
            self._status.setText("已暂停")

    def _cancel(self) -> None:
        if not self._runner.is_running:
            return
        self._runner.cancel()
        self._status.setText("正在取消...")

    def _on_progress(self, pct: int, stage: str) -> None:
        self._progress.setValue(pct)
        self._status.setText(stage)

    def _on_job_ok(self) -> None:
        self._append_log("完成。")
        self._status.setText("空闲")
        self._set_ui(_UiState(busy=False))

    def _on_job_err(self, err: str) -> None:
        self._append_log(err)
        QMessageBox.critical(self, "任务失败", err)
        self._status.setText("空闲")
        self._set_ui(_UiState(busy=False))
