from __future__ import annotations

import os
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class AppPaths:
    root: str
    data_dir: str
    projects_dir: str


def _app_root() -> str:
    # Resolve project root independent of cwd (QFileDialog can change cwd).
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def default_paths() -> AppPaths:
    # Allow the Electron main process to override where we read/write runtime data.
    # This avoids writing into the app install directory (especially after packaging).
    root = os.path.abspath(os.environ.get("GIST_VIDEO_ROOT") or _app_root())
    data_dir = os.path.abspath(os.environ.get("GIST_VIDEO_DATA_DIR") or os.path.join(root, "data"))
    projects_dir = os.path.abspath(os.environ.get("GIST_VIDEO_PROJECTS_DIR") or os.path.join(data_dir, "projects"))
    return AppPaths(root=root, data_dir=data_dir, projects_dir=projects_dir)

