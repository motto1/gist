from __future__ import annotations

import queue
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field

from app.jobs.index_job import IndexJobRequest, run_index_job
from app.jobs.render_job import RenderJobRequest, run_render_job


_MAX_EVENTS_PER_JOB = 5000


def _now_ts() -> float:
    return time.time()


@dataclass
class JobState:
    job_id: str
    kind: str  # "index" | "render"
    status: str = "queued"  # queued|running|paused|canceling|canceled|failed|succeeded
    created_at: float = field(default_factory=_now_ts)
    started_at: float | None = None
    finished_at: float | None = None
    progress_pct: int = 0
    stage: str = ""
    error: str | None = None

    pause_evt: threading.Event = field(default_factory=threading.Event, repr=False)
    cancel_evt: threading.Event = field(default_factory=threading.Event, repr=False)
    _thread: threading.Thread | None = field(default=None, repr=False)

    # Subscribers receive a copy of every event. Each subscriber has its own queue so messages
    # are not "stolen" by another consumer.
    _subscribers: set[queue.Queue] = field(default_factory=set, repr=False)
    _events: list[dict] = field(default_factory=list, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "job_id": self.job_id,
                "kind": self.kind,
                "status": self.status,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "progress_pct": int(self.progress_pct),
                "stage": str(self.stage or ""),
                "error": self.error,
            }

    def add_subscriber(self) -> tuple[queue.Queue, list[dict]]:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subscribers.add(q)
            # Send history first so UI can reconnect.
            history = list(self._events)
        return q, history

    def remove_subscriber(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def emit(self, event: dict) -> None:
        with self._lock:
            self._events.append(event)
            if len(self._events) > _MAX_EVENTS_PER_JOB:
                self._events = self._events[-_MAX_EVENTS_PER_JOB :]
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except Exception:
                # Best effort; a broken consumer shouldn't break the job.
                pass


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, JobState] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> JobState:
        with self._lock:
            if job_id not in self._jobs:
                raise KeyError(job_id)
            return self._jobs[job_id]

    def list_jobs(self) -> list[dict]:
        with self._lock:
            jobs = list(self._jobs.values())
        return [j.snapshot() for j in jobs]

    def subscribe(self, job_id: str) -> tuple[JobState, queue.Queue, list[dict]]:
        job = self.get(job_id)
        q, history = job.add_subscriber()
        return job, q, history

    def start_index_job(self, req: IndexJobRequest) -> str:
        job_id = uuid.uuid4().hex
        job = JobState(job_id=job_id, kind="index")
        with self._lock:
            self._jobs[job_id] = job

        def _progress(pct: int, stage: str) -> None:
            job.progress_pct = int(pct)
            job.stage = str(stage or "")
            job.emit({"type": "progress", "ts": _now_ts(), "pct": int(pct), "stage": str(stage or "")})

        def _log(msg: str) -> None:
            job.emit({"type": "log", "ts": _now_ts(), "message": str(msg or "")})

        def _run() -> None:
            job.started_at = _now_ts()
            job.status = "running"
            job.emit({"type": "state", "ts": _now_ts(), "status": job.status})
            try:
                run_index_job(req, _progress, _log, job.pause_evt, job.cancel_evt)
            except Exception as e:
                tb = traceback.format_exc()
                # Job functions raise RuntimeError("Cancelled") when cancel_evt is set.
                if job.cancel_evt.is_set() or str(e).strip().lower() == "cancelled":
                    job.status = "canceled"
                    job.finished_at = _now_ts()
                    job.emit({"type": "done", "ts": _now_ts(), "status": job.status})
                    return
                job.status = "failed"
                job.error = tb
                job.finished_at = _now_ts()
                job.emit({"type": "error", "ts": _now_ts(), "error": tb})
                job.emit({"type": "done", "ts": _now_ts(), "status": job.status})
                return

            job.status = "succeeded"
            job.finished_at = _now_ts()
            job.emit({"type": "done", "ts": _now_ts(), "status": job.status})

        t = threading.Thread(target=_run, name=f"job-index-{job_id}", daemon=True)
        job._thread = t
        t.start()
        return job_id

    def start_render_job(self, req: RenderJobRequest) -> str:
        job_id = uuid.uuid4().hex
        job = JobState(job_id=job_id, kind="render")
        with self._lock:
            self._jobs[job_id] = job

        def _progress(pct: int, stage: str) -> None:
            job.progress_pct = int(pct)
            job.stage = str(stage or "")
            job.emit({"type": "progress", "ts": _now_ts(), "pct": int(pct), "stage": str(stage or "")})

        def _log(msg: str) -> None:
            job.emit({"type": "log", "ts": _now_ts(), "message": str(msg or "")})

        def _run() -> None:
            job.started_at = _now_ts()
            job.status = "running"
            job.emit({"type": "state", "ts": _now_ts(), "status": job.status})
            try:
                run_render_job(req, _progress, _log, job.pause_evt, job.cancel_evt)
            except Exception as e:
                tb = traceback.format_exc()
                if job.cancel_evt.is_set() or str(e).strip().lower() == "cancelled":
                    job.status = "canceled"
                    job.finished_at = _now_ts()
                    job.emit({"type": "done", "ts": _now_ts(), "status": job.status})
                    return
                job.status = "failed"
                job.error = tb
                job.finished_at = _now_ts()
                job.emit({"type": "error", "ts": _now_ts(), "error": tb})
                job.emit({"type": "done", "ts": _now_ts(), "status": job.status})
                return

            job.status = "succeeded"
            job.finished_at = _now_ts()
            job.emit({"type": "done", "ts": _now_ts(), "status": job.status})

        t = threading.Thread(target=_run, name=f"job-render-{job_id}", daemon=True)
        job._thread = t
        t.start()
        return job_id

    def pause(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job.status not in ("running", "paused"):
            return job.snapshot()
        job.status = "paused"
        job.pause_evt.set()
        job.emit({"type": "state", "ts": _now_ts(), "status": job.status})
        return job.snapshot()

    def resume(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job.status not in ("paused", "running"):
            return job.snapshot()
        job.status = "running"
        job.pause_evt.clear()
        job.emit({"type": "state", "ts": _now_ts(), "status": job.status})
        return job.snapshot()

    def cancel(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job.status in ("canceled", "failed", "succeeded"):
            return job.snapshot()
        job.status = "canceling"
        job.cancel_evt.set()
        job.pause_evt.clear()
        job.emit({"type": "state", "ts": _now_ts(), "status": job.status})
        return job.snapshot()

