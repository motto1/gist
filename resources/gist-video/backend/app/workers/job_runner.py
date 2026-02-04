from __future__ import annotations

import traceback
from threading import Event

from PySide6.QtCore import QObject, QThread, Signal

from app.jobs.index_job import IndexJobRequest, run_index_job
from app.jobs.render_job import RenderJobRequest, run_render_job


class _Worker(QObject):
    progress = Signal(int, str)
    log = Signal(str)
    finished_ok = Signal()
    finished_err = Signal(str)

    def __init__(self, fn, *, pause_evt: Event, cancel_evt: Event) -> None:
        super().__init__()
        self._fn = fn
        self._pause_evt = pause_evt
        self._cancel_evt = cancel_evt

    def run(self) -> None:
        try:
            self._fn(self.progress.emit, self.log.emit, self._pause_evt, self._cancel_evt)
        except Exception:
            self.finished_err.emit(traceback.format_exc())
            return
        self.finished_ok.emit()


class JobRunner(QObject):
    progress = Signal(int, str)
    log = Signal(str)
    finished_ok = Signal()
    finished_err = Signal(str)

    def __init__(self, parent=None) -> None:
        super().__init__(parent=parent)
        self._thread: QThread | None = None
        self._worker: _Worker | None = None
        self._pause_evt = Event()
        self._cancel_evt = Event()
        self._paused = False

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.isRunning()

    @property
    def is_paused(self) -> bool:
        return self._paused

    def pause(self) -> None:
        self._paused = True
        self._pause_evt.set()

    def resume(self) -> None:
        self._paused = False
        self._pause_evt.clear()

    def cancel(self) -> None:
        self._cancel_evt.set()

    def cancel_and_wait(self, timeout_ms: int = 3000) -> bool:
        """
        Best-effort shutdown to avoid `QThread: Destroyed while thread is still running`.
        Note: if a job is blocked in an external process/network call, it may need more time.
        """
        if not self.is_running:
            return True
        self._cancel_evt.set()
        self._pause_evt.clear()
        self._paused = False
        if self._thread is None:
            return True
        # Asking the event loop to quit won't stop a busy worker immediately; we still wait a bit.
        self._thread.quit()
        return bool(self._thread.wait(timeout_ms))

    def _start(self, fn) -> None:
        if self.is_running:
            return
        self._cancel_evt.clear()
        self._pause_evt.clear()
        self._paused = False

        thread = QThread(self)
        worker = _Worker(fn, pause_evt=self._pause_evt, cancel_evt=self._cancel_evt)
        worker.moveToThread(thread)

        thread.started.connect(worker.run)
        worker.progress.connect(self.progress)
        worker.log.connect(self.log)
        worker.finished_ok.connect(thread.quit)
        worker.finished_ok.connect(worker.deleteLater)
        worker.finished_ok.connect(self.finished_ok)
        worker.finished_err.connect(thread.quit)
        worker.finished_err.connect(worker.deleteLater)
        worker.finished_err.connect(self.finished_err)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(self._on_thread_finished)

        self._thread = thread
        self._worker = worker
        thread.start()

    def _on_thread_finished(self) -> None:
        self._thread = None
        self._worker = None

    def start_index_job(self, req: IndexJobRequest) -> None:
        self._start(
            lambda progress, log, pause_evt, cancel_evt: run_index_job(
                req, progress, log, pause_evt, cancel_evt
            )
        )

    def start_render_job(self, req: RenderJobRequest) -> None:
        self._start(
            lambda progress, log, pause_evt, cancel_evt: run_render_job(
                req, progress, log, pause_evt, cancel_evt
            )
        )
