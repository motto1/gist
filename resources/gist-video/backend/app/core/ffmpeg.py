from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass

from app.core.paths import default_paths

@dataclass(frozen=True)
class FFmpegBins:
    ffmpeg: str
    ffprobe: str


def find_ffmpeg() -> FFmpegBins:
    env_ffmpeg = (os.environ.get("GIST_VIDEO_FFMPEG") or "").strip()
    env_ffprobe = (os.environ.get("GIST_VIDEO_FFPROBE") or "").strip()
    if env_ffmpeg and env_ffprobe and os.path.isfile(env_ffmpeg) and os.path.isfile(env_ffprobe):
        return FFmpegBins(ffmpeg=env_ffmpeg, ffprobe=env_ffprobe)

    env_bin_dir = (os.environ.get("GIST_VIDEO_BIN_DIR") or "").strip()
    if env_bin_dir:
        ffmpeg = os.path.join(env_bin_dir, "ffmpeg.exe")
        ffprobe = os.path.join(env_bin_dir, "ffprobe.exe")
        if os.path.isfile(ffmpeg) and os.path.isfile(ffprobe):
            return FFmpegBins(ffmpeg=ffmpeg, ffprobe=ffprobe)

    root = default_paths().root
    local_ffmpeg = os.path.join(root, "bin", "ffmpeg.exe")
    local_ffprobe = os.path.join(root, "bin", "ffprobe.exe")
    if os.path.isfile(local_ffmpeg) and os.path.isfile(local_ffprobe):
        return FFmpegBins(ffmpeg=local_ffmpeg, ffprobe=local_ffprobe)

    ffmpeg = shutil.which("ffmpeg") or ""
    ffprobe = shutil.which("ffprobe") or ""
    if ffmpeg and ffprobe:
        return FFmpegBins(ffmpeg=ffmpeg, ffprobe=ffprobe)

    raise FileNotFoundError(
        "ffmpeg/ffprobe not found. Put them in ./bin, set GIST_VIDEO_BIN_DIR, or add to PATH."
    )


def _decode_process_output(b: bytes) -> str:
    """
    ffmpeg/ffprobe output encoding varies on Windows (UTF-8 vs local codepage).
    Decode defensively so we never crash on UnicodeDecodeError.
    """
    if not b:
        return ""
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", errors="replace")


def run_cmd(args: list[str], *, log_fn=None) -> None:
    if log_fn:
        log_fn(" ".join(args))
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = _decode_process_output(p.stdout).strip()
    if log_fn and out:
        log_fn(out)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(args)}")
