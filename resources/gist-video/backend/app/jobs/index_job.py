from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import os
import re
import time
from dataclasses import dataclass

import numpy as np

from app.core.ffmpeg import find_ffmpeg, run_cmd
from app.core.project_store import ProjectStore
from app.core.settings import load_settings
from app.core.util import atomic_write_json, check_cancel, pct, wait_if_paused
from app.embeddings.provider import get_embedding_provider
from app.vision.provider import get_caption_provider


@dataclass(frozen=True)
class IndexJobRequest:
    project_id: str
    # Optional explicit video list override (CLI use-case). When provided, we won't read videos from project.json.
    videos_override: tuple[str, ...] | None = None
    proxy_height: int = 180
    frames_per_clip: int = 3
    fixed_clip_sec_fallback: float = 4.0
    # Slicing overrides (None = use settings.json defaults).
    slice_mode: str | None = None  # "scene" | "fixed"
    scene_threshold: float | None = None
    scene_fps: float | None = None
    min_clip_sec: float | None = None
    target_clip_sec: float | None = None
    max_clip_sec: float | None = None
    # Preview mode: only process the first N videos (0 = all).
    max_videos: int = 0
    # Caption concurrency: overlap API captioning with frame extraction.
    caption_workers: int | None = None
    caption_in_flight: int | None = None
    # Caption batching overrides (None = use settings.json defaults).
    caption_batch_clips: int | None = None
    caption_batch_max_images: int | None = None
    # Filter overrides (None = use settings.json defaults).
    skip_head_sec: int | None = None
    skip_tail_sec: int | None = None
    caption_flush_every: int = 10


def _ensure_proxy(ffmpeg: str, src: str, dst: str, *, proxy_height: int, log) -> None:
    if os.path.isfile(dst):
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    run_cmd(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            src,
            "-vf",
            f"scale=-2:{proxy_height}",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            dst,
        ],
        log_fn=log,
    )


def _probe_duration(ffprobe: str, path: str) -> float:
    import subprocess

    p = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stdout.strip())
    return float(p.stdout.strip())


def _fixed_slices(duration: float, *, clip_sec: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    t = 0.0
    while t < duration:
        end = min(duration, t + clip_sec)
        if end - t >= 0.5:
            out.append((t, end))
        t = end
    return out


def _decode_process_output(b: bytes) -> str:
    if not b:
        return ""
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode("utf-8", errors="replace")


_PTS_TIME_RE = re.compile(r"pts_time:([0-9]+(?:\\.[0-9]+)?)")


def _scene_cut_times(ffmpeg: str, proxy_path: str, *, threshold: float, fps: float, log) -> list[float]:
    """
    Run ffmpeg scene detection on the proxy video and return cut times (seconds).
    This is intentionally run on proxy.mp4 (low-res, silent) to stay friendly on low-end CPUs.
    """
    import subprocess

    threshold = float(max(0.0, min(1.0, float(threshold))))
    fps = float(max(0.5, min(30.0, float(fps))))

    # Note: showinfo prints only for frames that pass `select`, so logs stay manageable.
    vf = f"fps={fps:.3f},select='gt(scene,{threshold:.4f})',showinfo"
    args = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "info",
        "-i",
        proxy_path,
        "-an",
        "-sn",
        "-dn",
        "-vf",
        vf,
        "-f",
        "null",
        "-",
    ]
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = _decode_process_output(p.stdout)
    if p.returncode != 0:
        raise RuntimeError(out.strip() or f"ffmpeg scene detect failed ({p.returncode})")

    times: list[float] = []
    for m in _PTS_TIME_RE.finditer(out):
        try:
            times.append(float(m.group(1)))
        except ValueError:
            continue

    # Dedup while preserving order (rounded to milliseconds).
    uniq: list[float] = []
    seen: set[float] = set()
    for t in times:
        t2 = round(float(t), 3)
        if t2 not in seen:
            seen.add(t2)
            uniq.append(t2)
    return uniq


def _scene_raw_slices(
    ffmpeg: str,
    proxy_path: str,
    duration: float,
    *,
    threshold: float,
    fps: float,
    log,
) -> list[tuple[float, float]]:
    t0 = time.time()
    cuts = _scene_cut_times(ffmpeg, proxy_path, threshold=threshold, fps=fps, log=log)
    dt = time.time() - t0
    log(f"Scene scan: threshold={threshold:.3f}, fps={fps:.2f}, cuts={len(cuts)}, time={dt:.1f}s")

    pts: list[float] = [0.0]
    for x in cuts:
        if 0.05 < float(x) < float(duration) - 0.05:
            pts.append(float(x))
    pts.append(float(duration))
    pts = sorted(set(round(float(x), 3) for x in pts))

    out: list[tuple[float, float]] = []
    for a, b in zip(pts, pts[1:]):
        if float(b) - float(a) >= 0.5:
            out.append((float(a), float(b)))
    return out


def _window_clips_from_shots(
    shots: list[tuple[float, float]],
    *,
    min_sec: float,
    target_sec: float,
    max_sec: float,
) -> list[dict]:
    """
    Build index clips within each detected shot boundary.

    Why:
    - We must NOT cross real shot boundaries (user doesn't accept "natural cut" inside an output segment)
    - Still want 3-6s indexing granularity for better retrieval.
    """
    min_sec = float(max(0.5, min_sec))
    max_sec = float(max(min_sec, max_sec))
    target_sec = float(max(min_sec, min(target_sec, max_sec)))

    out: list[dict] = []
    shot_id = 0
    for ss, se in shots:
        ss = float(ss)
        se = float(se)
        if se <= ss + 0.2:
            continue
        shot_len = se - ss
        # If the whole shot is already within max, keep as one clip.
        if shot_len <= max_sec + 1e-6:
            out.append({"start": ss, "end": se, "shot_id": shot_id, "shot_start": ss, "shot_end": se})
            shot_id += 1
            continue

        # Otherwise, split inside the shot into non-overlapping windows close to target_sec.
        t = ss
        while t + min_sec <= se + 1e-6:
            e = min(se, t + target_sec)
            # If remainder would be too tiny, extend last window to end.
            if (se - e) < min_sec:
                e = se
            out.append({"start": t, "end": e, "shot_id": shot_id, "shot_start": ss, "shot_end": se})
            t = e
            if se - t < 1e-3:
                break
        shot_id += 1
    return out


def _clamp_slices(
    slices: list[tuple[float, float]],
    *,
    start: float,
    end: float,
    min_keep_sec: float = 0.5,
) -> list[tuple[float, float]]:
    start = float(max(0.0, start))
    end = float(max(start, end))
    out: list[tuple[float, float]] = []
    for s, e in slices:
        s2 = max(float(s), start)
        e2 = min(float(e), end)
        if e2 - s2 >= float(min_keep_sec):
            out.append((round(s2, 3), round(e2, 3)))
    return out


def _normalize_slices(
    slices: list[tuple[float, float]],
    *,
    min_sec: float,
    target_sec: float,
    max_sec: float,
) -> list[tuple[float, float]]:
    """
    Enforce clip length constraints while staying close to scene boundaries:
    - Merge tiny slices (< min_sec) into the next/previous slice.
    - Split long slices (> max_sec) into ~target_sec chunks (each <= max_sec).
    """
    min_sec = float(max(0.5, min_sec))
    max_sec = float(max(min_sec, max_sec))
    target_sec = float(max(min_sec, min(target_sec, max_sec)))

    if not slices:
        return []

    # Merge short neighbors first (scene boundaries often create tiny slices).
    merged: list[tuple[float, float]] = []
    cur_s, cur_e = float(slices[0][0]), float(slices[0][1])
    for s, e in slices[1:]:
        s = float(s)
        e = float(e)
        if (cur_e - cur_s) < min_sec:
            cur_e = e
            continue
        merged.append((cur_s, cur_e))
        cur_s, cur_e = s, e
    merged.append((cur_s, cur_e))

    # If the last slice is still too short, merge it back.
    if len(merged) >= 2 and (merged[-1][1] - merged[-1][0]) < min_sec:
        a0, a1 = merged[-2]
        b0, b1 = merged[-1]
        merged[-2] = (a0, b1)
        merged.pop()

    def _split_one(s: float, e: float) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        s = float(s)
        e = float(e)
        while (e - s) > max_sec + 1e-6:
            nxt = s + target_sec
            if (e - nxt) < min_sec:
                nxt = e - min_sec
            nxt = max(s + 0.5, min(nxt, e - 0.5))
            out.append((s, nxt))
            s = nxt
        out.append((s, e))
        return out

    split: list[tuple[float, float]] = []
    for s, e in merged:
        split.extend(_split_one(s, e))

    # Final cleanup: drop ultra-short tails; merge into previous.
    cleaned: list[tuple[float, float]] = []
    for s, e in split:
        if cleaned and (e - s) < min_sec:
            ps, pe = cleaned.pop()
            # Prefer merging tiny tails, but keep max_sec respected.
            if (e - ps) > max_sec + 1e-6:
                cleaned.extend(_split_one(ps, e))
            else:
                cleaned.append((ps, e))
        else:
            cleaned.append((s, e))

    out = [(round(float(s), 3), round(float(e), 3)) for s, e in cleaned if (float(e) - float(s)) >= 0.5]
    return out


def _pick_frame_times(start: float, end: float, n: int) -> list[float]:
    if n <= 1:
        return [(start + end) / 2.0]
    span = max(1e-6, end - start)
    return [start + span * (k / (n + 1)) for k in range(1, n + 1)]


def _extract_frame(ffmpeg: str, src: str, t: float, out_jpg: str, *, log) -> None:
    if os.path.isfile(out_jpg):
        return
    os.makedirs(os.path.dirname(out_jpg), exist_ok=True)
    run_cmd(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            f"{t:.3f}",
            "-i",
            src,
            "-vf",
            "scale=640:-2",
            # Avoid "image sequence pattern" warnings when writing a single JPG.
            "-update",
            "1",
            "-frames:v",
            "1",
            "-q:v",
            "4",
            out_jpg,
        ],
        log_fn=log,
    )


def _load_caption_cache(path: str) -> dict[str, str]:
    if not os.path.isfile(path):
        return {}
    try:
        import json

        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            return {str(k): str(v) for k, v in raw.items()}
    except Exception:
        pass
    return {}


@dataclass
class _PendingCaption:
    clip_idx: int
    rel_keys: list[str]
    keys: list[str]
    img_paths: list[str] | None = None
    # Used for "make-up" retry later (compute abs paths from cache_dir + rel key).


@dataclass
class _PendingCaptionBatch:
    items: list[_PendingCaption]
    keys: list[str]
    mode: str = "frames"  # "frames" | "clips"


def run_index_job(req: IndexJobRequest, progress, log, pause_evt, cancel_evt) -> None:
    store = ProjectStore.default()
    meta = store.get_project_meta(req.project_id)
    project_name = str(meta.get("name") or "").strip()
    project_hint = str(meta.get("series_hint") or meta.get("ip_hint") or project_name).strip()
    videos_all: list[str] = list(req.videos_override) if req.videos_override else meta.get("videos", [])
    max_videos = int(req.max_videos or 0)
    videos: list[str] = videos_all[:max_videos] if max_videos > 0 else videos_all
    if not videos:
        raise RuntimeError("No videos in this project. Add videos first.")

    bins = find_ffmpeg()
    emb = get_embedding_provider()
    cap = get_caption_provider()
    log(f"Embedding backend: {type(emb).__name__}")
    log(f"Caption backend: {type(cap).__name__}")
    if project_hint:
        # Gemini prompt can use this to identify characters/entities more reliably (single-work projects).
        try:
            fn = getattr(cap, "set_project_hint", None)
            if callable(fn):
                fn(project_hint)
                log(f"Project hint: {project_hint}")
        except Exception:
            pass

    cap_is_null = type(cap).__name__.lower().startswith("null")
    if cap_is_null:
        log("WARNING: caption backend is null; clip_text will be empty and matching quality will be poor.")

    st = load_settings().vision

    cap_workers = int(req.caption_workers if req.caption_workers is not None else st.caption_workers)
    cap_in_flight = int(req.caption_in_flight if req.caption_in_flight is not None else st.caption_in_flight)
    slice_mode = (req.slice_mode if req.slice_mode is not None else st.slice_mode) or "scene"
    scene_threshold = float(req.scene_threshold if req.scene_threshold is not None else st.scene_threshold)
    scene_fps = float(req.scene_fps if req.scene_fps is not None else st.scene_fps)
    min_clip_sec = float(req.min_clip_sec if req.min_clip_sec is not None else st.clip_min_sec)
    target_clip_sec = float(req.target_clip_sec if req.target_clip_sec is not None else st.clip_target_sec)
    max_clip_sec = float(req.max_clip_sec if req.max_clip_sec is not None else st.clip_max_sec)
    cap_workers = max(1, min(8, cap_workers))
    cap_in_flight = max(1, min(32, cap_in_flight))
    log(f"Caption concurrency: workers={cap_workers}, in_flight={cap_in_flight}")
    skip_head = int(req.skip_head_sec) if req.skip_head_sec is not None else int(getattr(st, "skip_head_sec", 60) or 0)
    skip_tail = int(req.skip_tail_sec) if req.skip_tail_sec is not None else int(getattr(st, "skip_tail_sec", 60) or 0)
    skip_head = max(0, skip_head)
    skip_tail = max(0, skip_tail)
    log(f"片头/片尾过滤: skip_head={skip_head}s, skip_tail={skip_tail}s")

    cache_dir = store.project_cache_dir(req.project_id)
    index_dir = os.path.join(cache_dir, "index")
    os.makedirs(index_dir, exist_ok=True)

    captions_path = os.path.join(index_dir, "frame_captions.json")
    captions = _load_caption_cache(captions_path)
    # If caption backend/prompt changes, we should refresh captions (otherwise quality improvements won't apply).
    cap_key = ""
    try:
        fn = getattr(cap, "cache_key", None)
        cap_key = str(fn() if callable(fn) else "").strip()
    except Exception:
        cap_key = ""
    if not cap_key:
        cap_key = type(cap).__name__
    cap_meta_path = os.path.join(index_dir, "caption_cache_meta.json")
    try:
        import json

        old_key = ""
        meta_exists = os.path.isfile(cap_meta_path)
        if meta_exists:
            with open(cap_meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if isinstance(meta, dict):
                old_key = str(meta.get("cache_key") or "").strip()
        # First run after upgrade (no meta yet): force refresh so prompt improvements apply.
        if (not meta_exists) and captions and (not cap_is_null):
            log("Caption cache metadata missing; re-captioning all frames to apply current prompt/model...")
            captions = {}
        if old_key and old_key != cap_key:
            log(f"Caption prompt/model changed ({old_key} -> {cap_key}). Re-captioning all frames...")
            captions = {}
    except Exception:
        pass
    atomic_write_json(cap_meta_path, {"cache_key": cap_key, "updated_at": time.time()})
    captions_dirty = 0

    clips_meta: list[dict] = []
    clip_texts: list[str] = []

    pending: dict[object, object] = {}
    failed: list[_PendingCaption] = []
    caption_errors = 0

    def _is_missing_caption(v: str | None) -> bool:
        if v is None:
            return True
        v2 = (v or "").strip()
        if not v2:
            return True
        return v2.startswith("__FAILED__")

    def _mark_failed(key: str) -> None:
        # Persist failure state so future "update index" runs can retry these frames.
        # Keep it as a string for backward compatibility with existing cache files.
        cur = captions.get(key)
        n = 0
        if isinstance(cur, str) and cur.startswith("__FAILED__"):
            try:
                n = int(cur.split(":", 1)[1])
            except Exception:
                n = 0
        captions[key] = f"__FAILED__:{n+1}"

    def _flush_captions_if_needed(force: bool = False) -> None:
        nonlocal captions_dirty
        if captions_dirty <= 0 and not force:
            return
        atomic_write_json(captions_path, captions)
        captions_dirty = 0

    def _merge_caps(clip_caps: list[str]) -> str:
        uniq: list[str] = []
        seen: set[str] = set()
        for c in clip_caps:
            c2 = (c or "").strip()
            if " FLAGS:" in c2:
                c2 = c2.split(" FLAGS:", 1)[0].strip()
            if not c2 or c2 in seen:
                continue
            seen.add(c2)
            uniq.append(c2)
        return " ; ".join(uniq)

    def _flags_from_caps(clip_caps: list[str]) -> set[str]:
        flags: set[str] = set()
        for c in clip_caps:
            s = (c or "").strip()
            if " FLAGS:" not in s:
                continue
            _, f = s.split(" FLAGS:", 1)
            for part in f.split(","):
                p = part.strip().lower()
                if p:
                    flags.add(p)
        return flags

    def _drain_some(executor: ThreadPoolExecutor, *, block: bool) -> None:
        nonlocal captions_dirty
        nonlocal caption_errors
        if not pending:
            return
        timeout = None if block else 0.1
        done, _ = wait(list(pending.keys()), timeout=timeout, return_when=FIRST_COMPLETED)
        for fut in done:
            info = pending.pop(fut)
            items = info.items if isinstance(info, _PendingCaptionBatch) else [info]
            keys = info.keys if isinstance(info, _PendingCaptionBatch) else info.keys
            mode = info.mode if isinstance(info, _PendingCaptionBatch) else "frames"
            try:
                caps = fut.result()
            except Exception as e:
                caption_errors += 1
                log(f"WARNING: 图生文失败（稍后自动补跑）：{e}")
                fail_keys = list(keys) if keys else [k for it in items for k in it.rel_keys]
                for k in fail_keys:
                    _mark_failed(k)
                    captions_dirty += 1
                # Defer filling clip text until we retry later.
                for it in items:
                    failed.append(it)
                if captions_dirty >= int(req.caption_flush_every):
                    _flush_captions_if_needed(force=True)
                continue

            if mode == "clips":
                if len(caps) != len(items):
                    raise RuntimeError("Caption backend returned unexpected clip batch size.")
                # Use the same clip-level caption for all frames in that clip.
                for it, c in zip(items, caps):
                    cap_text = (c or "").strip()
                    for k in it.rel_keys:
                        captions[k] = cap_text
                        captions_dirty += 1
            else:
                if len(caps) != len(keys):
                    raise RuntimeError("Caption backend returned unexpected batch size.")
                for k, c in zip(keys, caps):
                    captions[k] = (c or "").strip()
                    captions_dirty += 1

            for it in items:
                clip_caps = [captions.get(k, "") for k in it.rel_keys]
                clip_text = _merge_caps(clip_caps)
                clips_meta[it.clip_idx]["captions"] = clip_caps
                clips_meta[it.clip_idx]["text"] = clip_text
                flags = sorted(_flags_from_caps(clip_caps))
                clips_meta[it.clip_idx]["flags"] = flags
                clips_meta[it.clip_idx]["blocked"] = any(x in {"ad", "intro", "outro", "credit"} for x in flags)
                clip_texts[it.clip_idx] = clip_text

            if captions_dirty >= int(req.caption_flush_every):
                _flush_captions_if_needed(force=True)

    total = len(videos)
    if max_videos > 0 and len(videos_all) > len(videos):
        log(f"预览模式：本次只处理前 {len(videos)}/{len(videos_all)} 个视频（想处理全部请把N设为0）。")
    executor: ThreadPoolExecutor | None = None
    try:
        executor = ThreadPoolExecutor(max_workers=cap_workers)

        # Batch multiple clips' frames into one Vision request to reduce per-request overhead.
        cap_batch_clips = int(req.caption_batch_clips) if req.caption_batch_clips is not None else int(getattr(st, "caption_batch_clips", 1) or 1)
        cap_batch_max_images = int(req.caption_batch_max_images) if req.caption_batch_max_images is not None else int(getattr(st, "caption_batch_max_images", 0) or 0)
        cap_batch_clips = max(1, min(20, cap_batch_clips))
        cap_batch_max_images = max(0, min(120, cap_batch_max_images))
        if (not cap_is_null) and cap_batch_clips > 1:
            if cap_batch_max_images > 0:
                log(f"Caption batching: clips_per_request={cap_batch_clips}, max_images={cap_batch_max_images}")
            else:
                log(f"Caption batching: clips_per_request={cap_batch_clips}")

        batch_items: list[_PendingCaption] = []
        batch_imgs: list[str] = []
        batch_keys: list[str] = []

        def _submit_caption_batch(*, force: bool) -> None:
            nonlocal batch_items, batch_imgs, batch_keys
            if cap_is_null:
                batch_items, batch_imgs, batch_keys = [], [], []
                return
            if not batch_items:
                return

            # Decide whether we should flush now.
            fn_groups = getattr(cap, "caption_image_groups", None)
            use_groups = callable(fn_groups)
            total_imgs = (
                sum(len(it.img_paths or []) or len(it.rel_keys) for it in batch_items) if use_groups else len(batch_imgs)
            )
            if (not force) and (len(batch_items) < cap_batch_clips) and (
                cap_batch_max_images <= 0 or total_imgs < cap_batch_max_images
            ):
                return

            while len(pending) >= cap_in_flight:
                _drain_some(executor, block=True)

            # Prefer true "clip batching" if provider supports it: one caption per clip using multi-frame context.
            if use_groups:
                groups = []
                for it in batch_items:
                    if it.img_paths:
                        groups.append(list(it.img_paths))
                    else:
                        groups.append([os.path.join(cache_dir, k.replace("/", os.sep)) for k in it.rel_keys])
                fut = executor.submit(fn_groups, groups)
                pending[fut] = _PendingCaptionBatch(items=list(batch_items), keys=[], mode="clips")
            else:
                fut = executor.submit(cap.caption_image_paths, list(batch_imgs))
                pending[fut] = _PendingCaptionBatch(items=list(batch_items), keys=list(batch_keys), mode="frames")
            batch_items, batch_imgs, batch_keys = [], [], []

        for vi, video_path in enumerate(videos, start=1):
            wait_if_paused(pause_evt, cancel_evt)
            check_cancel(cancel_evt)

            # Emit a stage update before long-running steps so UI doesn't look "stuck".
            progress(int(((vi - 1) / max(1, total)) * 100), f"视频 {vi}/{total}：准备中…")
            log(f"[{vi}/{total}] Video: {video_path}")
            vkey = f"v{vi:04d}"
            vcache = os.path.join(cache_dir, vkey)
            proxy = os.path.join(vcache, "proxy.mp4")
            progress(int(((vi - 1) / max(1, total)) * 100), f"视频 {vi}/{total}：生成代理视频…")
            _ensure_proxy(bins.ffmpeg, video_path, proxy, proxy_height=req.proxy_height, log=log)

            progress(int(((vi - 1) / max(1, total)) * 100), f"视频 {vi}/{total}：分析时长/切片…")
            dur = _probe_duration(bins.ffprobe, proxy)
            if str(slice_mode).strip().lower() == "scene":
                try:
                    shots = _scene_raw_slices(
                        bins.ffmpeg,
                        proxy,
                        dur,
                        threshold=scene_threshold,
                        fps=scene_fps,
                        log=log,
                    )
                except Exception as e:
                    log(f"WARNING: 场景识别切片失败，回退固定切片。原因: {e}")
                    shots = _fixed_slices(dur, clip_sec=req.fixed_clip_sec_fallback)
            else:
                shots = _fixed_slices(dur, clip_sec=req.fixed_clip_sec_fallback)

            if skip_head or skip_tail:
                cutoff_end = max(0.0, float(dur) - float(skip_tail))
                shots = _clamp_slices(shots, start=float(skip_head), end=float(cutoff_end))

            # Build index clips INSIDE each shot so index granularity is still ~3-6s but never crosses a real cut.
            if str(slice_mode).strip().lower() == "scene":
                clips = _window_clips_from_shots(
                    shots,
                    min_sec=min_clip_sec,
                    target_sec=target_clip_sec,
                    max_sec=max_clip_sec,
                )
            else:
                clips = [{"start": float(s), "end": float(e), "shot_id": i, "shot_start": float(s), "shot_end": float(e)} for i, (s, e) in enumerate(shots)]

            if not clips:
                log("WARNING: 切片结果为空，回退固定切片。")
                shots2 = _fixed_slices(dur, clip_sec=req.fixed_clip_sec_fallback)
                if skip_head or skip_tail:
                    cutoff_end = max(0.0, float(dur) - float(skip_tail))
                    shots2 = _clamp_slices(shots2, start=float(skip_head), end=float(cutoff_end))
                clips = [{"start": float(s), "end": float(e), "shot_id": i, "shot_start": float(s), "shot_end": float(e)} for i, (s, e) in enumerate(shots2)]

            nslices = max(1, len(clips))
            log(
                f"[{vi}/{total}] 切片数: {len(clips)}（mode={slice_mode}, index_clip目标{min_clip_sec:.1f}-{max_clip_sec:.1f}s），每片抽帧: {req.frames_per_clip}，总帧数: {len(clips) * req.frames_per_clip}"
            )

            frames_dir = os.path.join(vcache, "frames")
            for si, cinfo in enumerate(clips):
                wait_if_paused(pause_evt, cancel_evt)
                check_cancel(cancel_evt)

                # Keep caption requests flowing in parallel.
                while len(pending) >= cap_in_flight:
                    _drain_some(executor, block=True)

                # Also drain opportunistically to update cache while extracting.
                _drain_some(executor, block=False)

                overall = ((vi - 1) / max(1, total)) + ((si / nslices) / max(1, total))
                progress(int(overall * 100), f"视频 {vi}/{total}：抽帧 {si+1}/{len(clips)}…（并发图生文: {len(pending)}）")

                s = float(cinfo["start"])
                e = float(cinfo["end"])
                frame_ts = _pick_frame_times(s, e, req.frames_per_clip)
                frame_paths: list[str] = []
                for fi, t in enumerate(frame_ts):
                    overall_f = ((vi - 1) / max(1, total)) + (
                        ((si + (fi / max(1, req.frames_per_clip))) / nslices) / max(1, total)
                    )
                    progress(
                        int(overall_f * 100),
                        f"视频 {vi}/{total}：抽帧 {si+1}/{len(clips)}（{fi+1}/{req.frames_per_clip}）…（并发图生文: {len(pending)}）",
                    )
                    out_jpg = os.path.join(frames_dir, f"clip_{si:05d}_f{fi}.jpg")
                    _extract_frame(bins.ffmpeg, video_path, t, out_jpg, log=log)
                    frame_paths.append(out_jpg)

                rel_keys = [os.path.relpath(p, cache_dir).replace("\\", "/") for p in frame_paths]
                missing = [(k, p) for k, p in zip(rel_keys, frame_paths) if _is_missing_caption(captions.get(k))]

                # Reserve slot now; fill later when caption returns.
                clip_idx = len(clips_meta)
                clips_meta.append(
                    {
                        "clip_id": f"{vkey}_c{si:05d}",
                        "source_path": video_path,
                        "start": float(s),
                        "end": float(e),
                        "shot_id": int(cinfo.get("shot_id", si)),
                        "shot_start": float(cinfo.get("shot_start", s)),
                        "shot_end": float(cinfo.get("shot_end", e)),
                        "frames": frame_paths,
                        "captions": ["" for _ in rel_keys],
                        "text": "",
                        "flags": [],
                        "blocked": False,
                    }
                )
                clip_texts.append("")

                if cap_is_null:
                    continue

                if missing:
                    keys = [k for k, _ in missing]
                    imgs = [p for _, p in missing]
                    # Queue into a clip-batch to reduce per-request overhead.
                    progress(int(overall * 100), f"视频 {vi}/{total}：排队图生文 {si+1}/{len(clips)}（{len(imgs)}帧）…（并发: {len(pending)}）")
                    # For clip-batching providers, we prefer sending all frames for this clip (multi-frame context),
                    # and write the same caption back to all frame keys.
                    batch_items.append(
                        _PendingCaption(clip_idx=clip_idx, rel_keys=rel_keys, keys=list(rel_keys), img_paths=list(frame_paths))
                    )
                    batch_imgs.extend(imgs)
                    batch_keys.extend(keys)
                    _submit_caption_batch(force=False)
                else:
                    clip_caps = [captions.get(k, "") for k in rel_keys]
                    clip_text = _merge_caps(clip_caps)
                    clips_meta[clip_idx]["captions"] = clip_caps
                    clips_meta[clip_idx]["text"] = clip_text
                    flags = sorted(_flags_from_caps(clip_caps))
                    clips_meta[clip_idx]["flags"] = flags
                    clips_meta[clip_idx]["blocked"] = any(x in {"ad", "intro", "outro", "credit"} for x in flags)
                    clip_texts[clip_idx] = clip_text

            # Flush any remaining queued caption batch for this video.
            _submit_caption_batch(force=True)
            progress(pct(vi, total), f"视频 {vi}/{total}：完成（并发图生文: {len(pending)}）")

        # Drain remaining caption tasks.
        if executor is not None:
            _submit_caption_batch(force=True)
            while pending:
                wait_if_paused(pause_evt, cancel_evt)
                check_cancel(cancel_evt)
                _drain_some(executor, block=True)

        # Make-up pass: retry failed clips after we've finished extracting frames.
        if (not cap_is_null) and failed:
            progress(92, f"补跑图生文：{len(failed)} 个切片…")
            log(f"补跑图生文：{len(failed)} 个切片（失败后自动补跑）")
            # Retry sequentially to reduce stress on the relay.
            for i, info in enumerate(list(failed), start=1):
                wait_if_paused(pause_evt, cancel_evt)
                check_cancel(cancel_evt)

                # Recompute which frames are still missing for this clip.
                still = [k for k in info.rel_keys if _is_missing_caption(captions.get(k))]
                if not still:
                    continue
                # Best effort: request only missing frames for this clip.
                imgs = [os.path.join(cache_dir, k.replace("/", os.sep)) for k in still]
                progress(92, f"补跑图生文 {i}/{len(failed)}（{len(imgs)}帧）…")
                try:
                    caps = cap.caption_image_paths(imgs)
                    if len(caps) != len(imgs):
                        raise RuntimeError("Caption backend returned unexpected batch size.")
                    for k, c in zip(still, caps):
                        captions[k] = (c or "").strip()
                        captions_dirty += 1
                except Exception as e:
                    # Keep failed markers; will be retried on next "update index".
                    caption_errors += 1
                    log(f"WARNING: 补跑图生文仍失败（保留失败标记，后续可再次更新索引重试）：{e}")
                # Update clip text after each retry.
                clip_caps = [captions.get(k, "") for k in info.rel_keys]
                clip_text = _merge_caps(clip_caps)
                clips_meta[info.clip_idx]["captions"] = clip_caps
                clips_meta[info.clip_idx]["text"] = clip_text
                flags = sorted(_flags_from_caps(clip_caps))
                clips_meta[info.clip_idx]["flags"] = flags
                clips_meta[info.clip_idx]["blocked"] = any(x in {"ad", "intro", "outro", "credit"} for x in flags)
                clip_texts[info.clip_idx] = clip_text

                if captions_dirty >= int(req.caption_flush_every):
                    _flush_captions_if_needed(force=True)

        _flush_captions_if_needed(force=True)
    finally:
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)

    progress(95, "向量化文本（Embedding）…")
    log("Embedding clip texts...")
    try:
        vecs = emb.embed_texts(clip_texts)
    except Exception as e:
        # Fast fallback so users can still preview end-to-end without heavyweight deps.
        log(f"WARNING: 向量化失败，将回退到轻量本地向量（local_hash）。原因：{e}")
        from app.embeddings.provider import LocalHashEmbeddingProvider

        emb = LocalHashEmbeddingProvider()
        vecs = emb.embed_texts(clip_texts)
    npy_path = os.path.join(index_dir, "clip_vectors.npy")
    os.makedirs(os.path.dirname(npy_path), exist_ok=True)
    np.save(npy_path, vecs)

    meta_path = os.path.join(index_dir, "clips.json")
    atomic_write_json(
        meta_path,
        {
            "created_at": time.time(),
            "clips": clips_meta,
            "embedding": {
                "type": type(emb).__name__,
                "dim": int(vecs.shape[1]) if vecs.ndim == 2 else 0,
                "model_id": getattr(emb, "model_id", None),
            },
        },
    )
    log(f"Index ready: {meta_path}")
    if caption_errors:
        # Count remaining failed frame captions.
        remaining_failed = sum(1 for v in captions.values() if isinstance(v, str) and v.startswith("__FAILED__"))
        log(f"WARNING: 图生文失败次数：{caption_errors}，仍失败帧数：{remaining_failed}（索引仍可用，但匹配效果会变差）")
    progress(100, "Index complete")
