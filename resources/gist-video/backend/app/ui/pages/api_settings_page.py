from __future__ import annotations

import os
from dataclasses import dataclass

from PySide6.QtWidgets import (
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QFileDialog,
    QSpinBox,
    QWidget,
    QComboBox,
)

from app.core.paths import default_paths
from app.core.settings import AppSettings, EmbeddingSettings, RenderSettings, VisionSettings, load_settings, save_settings
from app.vision.gemini_proxy import GeminiRelayCaptionProvider


@dataclass(frozen=True)
class _UiState:
    busy: bool


class ApiSettingsPage(QWidget):
    def __init__(self) -> None:
        super().__init__()

        self._api_base = QLineEdit()
        self._api_base.setPlaceholderText("例如：https://motto.2116666.xyz/opus （推荐填到 /v1 也可以）")

        self._api_key = QLineEdit()
        self._api_key.setEchoMode(QLineEdit.EchoMode.Password)
        self._api_key.setPlaceholderText("粘贴你的密钥（不会显示明文）")

        self._vision_model = QComboBox()
        self._vision_model.setEditable(True)
        self._vision_model.setInsertPolicy(QComboBox.InsertPolicy.InsertAtTop)
        if hasattr(self._vision_model, "setPlaceholderText"):
            self._vision_model.setPlaceholderText("例如：gpt-4o / gemini-1.5-pro / 以中转站实际模型名为准")

        self._backend = QComboBox()
        self._backend.addItem("自动（已配置则使用API；否则关闭）", userData="auto")
        self._backend.addItem("Gemini/第三方中转站（OpenAI兼容）", userData="gemini_proxy")
        self._backend.addItem("关闭图生文（不推荐）", userData="null")

        self._caption_workers = QSpinBox()
        self._caption_workers.setRange(1, 8)
        self._caption_workers.setValue(2)

        self._caption_in_flight = QSpinBox()
        self._caption_in_flight.setRange(1, 32)
        self._caption_in_flight.setValue(8)

        self._skip_head = QSpinBox()
        self._skip_head.setRange(0, 600)
        self._skip_head.setValue(60)
        self._skip_head.setToolTip("跳过每个源视频开头N秒（避免广告/片头/版权声明）")

        self._skip_tail = QSpinBox()
        self._skip_tail.setRange(0, 600)
        self._skip_tail.setValue(60)
        self._skip_tail.setToolTip("跳过每个源视频结尾N秒（避免广告/片尾/字幕组声明）")

        self._save_btn = QPushButton("保存设置")
        self._save_btn.clicked.connect(self._save)

        self._reload_btn = QPushButton("重新加载")
        self._reload_btn.clicked.connect(lambda: self._load(show_path=True))

        self._fetch_models_btn = QPushButton("获取模型列表")
        self._fetch_models_btn.clicked.connect(self._fetch_models)

        self._test_caption_btn = QPushButton("测试图生文（选3张图）")
        self._test_caption_btn.clicked.connect(self._test_caption)

        self._note = QLabel("说明：建库时会对每个切片的3帧做图生文，并写入索引用于后续匹配。")
        self._log = QPlainTextEdit()
        self._log.setReadOnly(True)

        row = QHBoxLayout()
        row.addWidget(self._save_btn)
        row.addWidget(self._reload_btn)
        row.addWidget(self._fetch_models_btn)
        row.addWidget(self._test_caption_btn)
        row.addStretch(1)

        form = QFormLayout(self)
        form.addRow("图生文方式：", self._backend)
        form.addRow("中转站地址：", self._api_base)
        form.addRow("密钥：", self._api_key)
        form.addRow("Vision模型：", self._vision_model)
        form.addRow("并发线程数：", self._caption_workers)
        form.addRow("最大排队请求：", self._caption_in_flight)
        form.addRow("跳过片头（秒）：", self._skip_head)
        form.addRow("跳过片尾（秒）：", self._skip_tail)
        form.addRow(row)
        form.addRow(self._note)
        form.addRow(QLabel("日志："))
        form.addRow(self._log)

        self._load(clear_log=True)
        self._set_ui(_UiState(busy=False))

    def _set_ui(self, st: _UiState) -> None:
        for w in (
            self._backend,
            self._api_base,
            self._api_key,
            self._vision_model,
            self._caption_workers,
            self._caption_in_flight,
            self._skip_head,
            self._skip_tail,
        ):
            w.setEnabled(not st.busy)
        self._save_btn.setEnabled(not st.busy)
        self._reload_btn.setEnabled(not st.busy)
        self._fetch_models_btn.setEnabled(not st.busy)
        self._test_caption_btn.setEnabled(not st.busy)

    def _log_line(self, s: str) -> None:
        self._log.appendPlainText(s)

    def _load(self, *, show_path: bool = False, clear_log: bool = False) -> None:
        st = load_settings()
        paths = default_paths()
        path = os.path.join(paths.data_dir, "settings.json")
        # backend
        backend = (st.vision.backend or "auto").strip()
        unsupported_backend: str | None = None
        idx = self._backend.findData(backend)
        if idx >= 0:
            self._backend.setCurrentIndex(idx)
        else:
            self._backend.setCurrentIndex(0)
            unsupported_backend = backend

        self._api_base.setText(st.vision.api_base or "")
        # Do not auto-fill key if empty; if exists, keep masked but present.
        self._api_key.setText(st.vision.api_key or "")
        self._vision_model.setCurrentText(st.vision.vision_model or "")
        self._caption_workers.setValue(int(st.vision.caption_workers or 2))
        self._caption_in_flight.setValue(int(st.vision.caption_in_flight or 8))
        sh = getattr(st.vision, "skip_head_sec", 60)
        stl = getattr(st.vision, "skip_tail_sec", 60)
        self._skip_head.setValue(int(sh) if sh is not None else 60)
        self._skip_tail.setValue(int(stl) if stl is not None else 60)
        if clear_log:
            self._log.clear()
        else:
            self._log_line("----")
        self._log_line(f"加载路径：{path}")
        self._log_line(f"存在：{os.path.isfile(path)}")
        try:
            self._log_line(f"mtime：{os.path.getmtime(path):.0f}")
        except Exception:
            pass
        self._log_line(f"cwd：{os.path.abspath(os.getcwd())}")
        self._log_line(f"root：{paths.root}")
        if unsupported_backend:
            self._log_line(f"WARNING: settings.json 中的 vision.backend={unsupported_backend!r} 已不支持；请点击“保存设置”写回新配置。")
        self._log_line(f"已加载：skip_head_sec={self._skip_head.value()}, skip_tail_sec={self._skip_tail.value()}")
        if show_path:
            QMessageBox.information(self, "已加载", f"加载路径：\n{path}")

    def _save(self) -> None:
        backend = str(self._backend.currentData() or "auto")
        api_base = self._api_base.text().strip()
        api_key = self._api_key.text().strip()
        vision_model = self._vision_model.currentText().strip()
        caption_workers = int(self._caption_workers.value())
        caption_in_flight = int(self._caption_in_flight.value())
        skip_head_sec = int(self._skip_head.value())
        skip_tail_sec = int(self._skip_tail.value())

        # Preserve embedding settings.
        old = load_settings()
        old_vis = getattr(old, "vision", VisionSettings())
        st = AppSettings(
            embedding=EmbeddingSettings(backend=old.embedding.backend, model_id=old.embedding.model_id),
            vision=VisionSettings(
                backend=backend,
                api_base=api_base,
                api_key=api_key,
                vision_model=vision_model,
                caption_workers=caption_workers,
                caption_in_flight=caption_in_flight,
                # Preserve advanced vision/index tuning fields not shown in UI.
                caption_batch_clips=int(getattr(old_vis, "caption_batch_clips", 1)),
                caption_batch_max_images=int(getattr(old_vis, "caption_batch_max_images", 0)),
                skip_head_sec=skip_head_sec,
                skip_tail_sec=skip_tail_sec,
                slice_mode=str(getattr(old_vis, "slice_mode", "scene") or "scene").strip(),
                scene_threshold=float(getattr(old_vis, "scene_threshold", 0.35) or 0.35),
                scene_fps=float(getattr(old_vis, "scene_fps", 4.0) or 4.0),
                clip_min_sec=float(getattr(old_vis, "clip_min_sec", 3.0) or 3.0),
                clip_target_sec=float(getattr(old_vis, "clip_target_sec", 4.5) or 4.5),
                clip_max_sec=float(getattr(old_vis, "clip_max_sec", 6.0) or 6.0),
            ),
            # Preserve render settings to avoid wiping user config in settings.json.
            render=getattr(old, "render", RenderSettings()),
        )
        path = save_settings(st)
        QMessageBox.information(self, "已保存", f"设置已保存到：\n{path}")
        self._log_line(f"保存成功：{path}")

    def _fetch_models(self) -> None:
        backend = str(self._backend.currentData() or "auto")
        if backend not in ("gemini_proxy", "auto"):
            QMessageBox.information(self, "提示", "只有选择“中转站/OpenAI兼容”时才需要获取模型列表。")
            return
        api_base = self._api_base.text().strip()
        api_key = self._api_key.text().strip()
        if not api_base or not api_key:
            QMessageBox.warning(self, "缺少配置", "请先填写中转站地址与密钥。")
            return
        try:
            import requests

            b = api_base.rstrip("/")
            if not b.endswith("/v1"):
                b = b + "/v1"
            url = b + "/models"
            r = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
            if r.status_code >= 400:
                raise RuntimeError(f"{r.status_code}: {r.text[:300]}")
            data = r.json()
            ids = []
            for item in (data.get("data") or []):
                mid = item.get("id")
                if mid:
                    ids.append(str(mid))
            if not ids:
                raise RuntimeError("没有获取到模型列表（返回为空）。")
            # Update dropdown.
            cur = self._vision_model.currentText().strip()
            self._vision_model.clear()
            self._vision_model.addItems(ids)
            if cur:
                self._vision_model.setCurrentText(cur)
            self._log_line(f"获取模型列表成功：{len(ids)} 个")
        except Exception as e:
            QMessageBox.critical(self, "获取失败", str(e))
            self._log_line(f"获取模型列表失败：{e}")

    def _test_caption(self) -> None:
        api_base = self._api_base.text().strip()
        api_key = self._api_key.text().strip()
        model = self._vision_model.currentText().strip()
        if not api_base or not api_key or not model:
            QMessageBox.warning(self, "缺少配置", "请先填写中转站地址、密钥、Vision模型。")
            return
        paths, _ = QFileDialog.getOpenFileNames(self, "选择3张图片（同一个切片的3帧）", "", "Images (*.jpg *.jpeg *.png);;All files (*.*)")
        if not paths:
            return
        if len(paths) != 3:
            QMessageBox.warning(self, "数量不对", "请一次选择 3 张图片（对应一个切片的3帧）。")
            return
        try:
            prov = GeminiRelayCaptionProvider(api_base=api_base, api_key=api_key, model=model)
            caps = prov.caption_image_paths(paths)
            self._log_line("测试图生文结果：")
            for i, c in enumerate(caps):
                self._log_line(f"{i}: {c}")
        except Exception as e:
            QMessageBox.critical(self, "测试失败", str(e))
            self._log_line(f"测试图生文失败：{e}")
