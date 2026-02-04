from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass

from app.core.paths import default_paths


@dataclass(frozen=True)
class Project:
    project_id: str
    name: str
    created_at: float


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", name.strip())
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "project"


class ProjectStore:
    def __init__(self, projects_dir: str) -> None:
        self._projects_dir = projects_dir
        os.makedirs(self._projects_dir, exist_ok=True)

    @staticmethod
    def default() -> "ProjectStore":
        return ProjectStore(default_paths().projects_dir)

    def list_projects(self) -> list[Project]:
        out: list[Project] = []
        if not os.path.isdir(self._projects_dir):
            return out
        for name in sorted(os.listdir(self._projects_dir)):
            pdir = os.path.join(self._projects_dir, name)
            meta_path = os.path.join(pdir, "project.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                out.append(
                    Project(
                        project_id=meta["project_id"],
                        name=meta["name"],
                        created_at=meta["created_at"],
                    )
                )
            except Exception:
                continue
        return out

    def _project_dir(self, project_id: str) -> str:
        return os.path.join(self._projects_dir, project_id)

    def create_project(self, name: str) -> Project:
        pid = f"{_slugify(name)}_{uuid.uuid4().hex[:8]}"
        pdir = self._project_dir(pid)
        os.makedirs(pdir, exist_ok=False)
        os.makedirs(os.path.join(pdir, "cache"), exist_ok=True)
        os.makedirs(os.path.join(pdir, "jobs"), exist_ok=True)
        meta = {"project_id": pid, "name": name, "created_at": time.time(), "videos": []}
        with open(os.path.join(pdir, "project.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return Project(project_id=pid, name=name, created_at=meta["created_at"])

    def add_videos(self, project_id: str, video_paths: list[str]) -> None:
        pdir = self._project_dir(project_id)
        meta_path = os.path.join(pdir, "project.json")
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        existing = set(meta.get("videos", []))
        for vp in video_paths:
            vp = os.path.abspath(vp)
            if os.path.isfile(vp) and vp not in existing:
                meta.setdefault("videos", []).append(vp)
                existing.add(vp)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    def get_project_meta(self, project_id: str) -> dict:
        pdir = self._project_dir(project_id)
        meta_path = os.path.join(pdir, "project.json")
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def project_cache_dir(self, project_id: str) -> str:
        return os.path.join(self._project_dir(project_id), "cache")

    def project_jobs_dir(self, project_id: str) -> str:
        return os.path.join(self._project_dir(project_id), "jobs")

