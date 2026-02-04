from __future__ import annotations

import os

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QProgressBar,
    QPlainTextEdit,
    QTextEdit,
    QWidget,
)

from app.core.project_store import ProjectStore
from app.jobs.render_job import RenderJobRequest
from app.workers.job_runner import JobRunner


class RenderPage(QWidget):
    def __init__(self, project_store: ProjectStore) -> None:
        super().__init__()
        self._store = project_store

        self._runner = JobRunner(parent=self)
        self._runner.progress.connect(self._on_progress)
        self._runner.log.connect(self._append_log)
        self._runner.finished_ok.connect(self._on_job_ok)
        self._runner.finished_err.connect(self._on_job_err)

        self._project = QComboBox()
        self.refresh_projects()

        self._audio = QLineEdit()
        self._audio_btn = QPushButton("浏览...")
        self._audio_btn.clicked.connect(self._pick_audio)

        self._tts_json = QLineEdit()
        self._tts_json.setPlaceholderText("可选：EdgeTTS 时间轴 JSON（同名自动识别，也可手动指定）")
        self._tts_json_btn = QPushButton("浏览...")
        self._tts_json_btn.clicked.connect(self._pick_tts_json)

        self._bgm = QLineEdit()
        self._bgm_btn = QPushButton("浏览...")
        self._bgm_btn.clicked.connect(self._pick_bgm)

        self._out = QLineEdit(os.path.join(os.getcwd(), "output.mp4"))
        self._out_btn = QPushButton("另存为...")
        self._out_btn.clicked.connect(self._pick_out)

        self._aspect = QComboBox()
        self._aspect.addItem("横屏 16:9（1920x1080）", userData=(1920, 1080))
        self._aspect.addItem("竖屏 9:16（1080x1920）", userData=(1080, 1920))
        self._aspect.setCurrentIndex(0)

        self._keep_speed = QCheckBox("保持原速（不加速/不减速）")
        self._keep_speed.setChecked(True)

        self._emph = QLineEdit()
        self._emph.setPlaceholderText("可选：执掌权柄,天才（也可在文案里用 [[词/句]] 标记）")
        self._emph_enable = QCheckBox("启用花字（关键词/标记弹出）")
        self._emph_enable.setChecked(True)

        self._script = QTextEdit()
        self._script.setPlaceholderText("在这里粘贴解说文案...")

        self._dedup = QLineEdit("60")
        self._run_btn = QPushButton("开始生成MP4")
        self._run_btn.clicked.connect(self._render)
        self._pause_btn = QPushButton("暂停")
        self._pause_btn.clicked.connect(self._pause_or_resume)
        self._cancel_btn = QPushButton("取消")
        self._cancel_btn.clicked.connect(self._cancel)

        self._progress = QProgressBar()
        self._progress.setRange(0, 100)
        self._status = QLabel("空闲")
        self._log = QPlainTextEdit()
        self._log.setReadOnly(True)

        form = QFormLayout(self)
        form.addRow("选择项目：", self._project)

        row_audio = QHBoxLayout()
        row_audio.addWidget(self._audio, 1)
        row_audio.addWidget(self._audio_btn)
        self._audio_btn.setText("浏览...")
        form.addRow("解说音频：", row_audio)

        row_tts = QHBoxLayout()
        row_tts.addWidget(self._tts_json, 1)
        row_tts.addWidget(self._tts_json_btn)
        form.addRow("时间轴JSON（可选）：", row_tts)

        row_bgm = QHBoxLayout()
        row_bgm.addWidget(self._bgm, 1)
        row_bgm.addWidget(self._bgm_btn)
        self._bgm_btn.setText("浏览...")
        form.addRow("背景音乐（可选）：", row_bgm)

        row_out = QHBoxLayout()
        row_out.addWidget(self._out, 1)
        row_out.addWidget(self._out_btn)
        form.addRow("输出文件：", row_out)

        form.addRow("画面比例：", self._aspect)
        form.addRow("", self._keep_speed)
        form.addRow("花字关键词：", self._emph)
        form.addRow("", self._emph_enable)
        form.addRow("去重窗口（秒）：", self._dedup)
        form.addRow("解说文案：", self._script)

        actions = QHBoxLayout()
        actions.addWidget(self._run_btn)
        actions.addWidget(self._pause_btn)
        actions.addWidget(self._cancel_btn)
        actions.addStretch(1)
        form.addRow(actions)

        form.addRow(self._status)
        form.addRow(self._progress)
        form.addRow(QLabel("日志："))
        form.addRow(self._log)

        self._sync_buttons()

    @property
    def has_running_job(self) -> bool:
        return self._runner.is_running

    def cancel_and_wait(self, timeout_ms: int = 3000) -> bool:
        return self._runner.cancel_and_wait(timeout_ms=timeout_ms)

    def refresh_projects(self) -> None:
        self._project.clear()
        for p in self._store.list_projects():
            self._project.addItem(p.name, userData=p.project_id)

    def _sync_buttons(self) -> None:
        busy = self._runner.is_running
        self._run_btn.setEnabled(not busy)
        self._audio_btn.setEnabled(not busy)
        self._tts_json_btn.setEnabled(not busy)
        self._bgm_btn.setEnabled(not busy)
        self._out_btn.setEnabled(not busy)
        self._aspect.setEnabled(not busy)
        self._keep_speed.setEnabled(not busy)
        self._emph.setEnabled(not busy)
        self._emph_enable.setEnabled(not busy)
        self._pause_btn.setEnabled(busy)
        self._cancel_btn.setEnabled(busy)
        if not busy:
            self._pause_btn.setText("暂停")

    def _append_log(self, msg: str) -> None:
        self._log.appendPlainText(msg)

    def _pick_audio(self) -> None:
        p, _ = QFileDialog.getOpenFileName(
            self, "选择解说音频", os.getcwd(), "音频 (*.mp3 *.wav *.m4a);;所有文件 (*.*)"
        )
        if p:
            self._audio.setText(p)
            # Auto-fill matching JSON if present.
            base, _ext = os.path.splitext(p)
            meta = base + ".json"
            if os.path.isfile(meta):
                self._tts_json.setText(meta)

    def _pick_tts_json(self) -> None:
        p, _ = QFileDialog.getOpenFileName(self, "选择时间轴JSON", os.getcwd(), "JSON (*.json);;所有文件 (*.*)")
        if p:
            self._tts_json.setText(p)

    def _pick_bgm(self) -> None:
        p, _ = QFileDialog.getOpenFileName(
            self, "选择背景音乐", os.getcwd(), "音频 (*.mp3 *.wav *.m4a);;所有文件 (*.*)"
        )
        if p:
            self._bgm.setText(p)

    def _pick_out(self) -> None:
        p, _ = QFileDialog.getSaveFileName(self, "选择输出MP4", os.getcwd(), "MP4 (*.mp4)")
        if p:
            if not p.lower().endswith(".mp4"):
                p += ".mp4"
            self._out.setText(p)

    def _render(self) -> None:
        project_id = self._project.currentData()
        if not project_id:
            QMessageBox.warning(self, "缺少项目", "请先选择一个项目。")
            return
        audio = self._audio.text().strip()
        if not audio:
            QMessageBox.warning(self, "缺少音频", "请选择解说音频文件。")
            return
        script = self._script.toPlainText().strip()
        if not script:
            QMessageBox.warning(self, "缺少文案", "请粘贴解说文案。")
            return
        out = self._out.text().strip()
        if not out:
            QMessageBox.warning(self, "缺少输出路径", "请选择输出文件。")
            return
        try:
            dedup_sec = int(self._dedup.text().strip())
        except ValueError:
            QMessageBox.warning(self, "参数错误", "去重窗口必须是整数（秒）。")
            return

        self._log.clear()
        self._progress.setValue(0)
        self._status.setText("正在生成视频...")

        req = RenderJobRequest(
            project_id=project_id,
            voice_audio_path=audio,
            script_text=script,
            tts_meta_path=self._tts_json.text().strip() or None,
            bgm_audio_path=self._bgm.text().strip() or None,
            output_path=out,
            dedup_window_sec=dedup_sec,
            output_width=int(self._aspect.currentData()[0]),
            output_height=int(self._aspect.currentData()[1]),
            keep_speed=bool(self._keep_speed.isChecked()),
            emphasis_enable=bool(self._emph_enable.isChecked()),
            emphasis_phrases=tuple(
                s.strip()
                for s in self._emph.text().replace("，", ",").split(",")
                if s.strip()
            ),
        )
        self._runner.start_render_job(req)
        self._sync_buttons()

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
        self._sync_buttons()

    def _on_job_err(self, err: str) -> None:
        self._append_log(err)
        QMessageBox.critical(self, "任务失败", err)
        self._status.setText("空闲")
        self._sync_buttons()
