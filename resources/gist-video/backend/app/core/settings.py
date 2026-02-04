from __future__ import annotations

import json
import os
from dataclasses import dataclass

from app.core.paths import default_paths


@dataclass(frozen=True)
class EmbeddingSettings:
    # backend: "auto" | "local_hash" | "onnx_m3e"
    backend: str = "auto"
    # Default to a lightweight local ONNX model shipped alongside the tool when available.
    model_id: str = "m3e-small/onnx/model.onnx"


@dataclass(frozen=True)
class VisionSettings:
    # backend: "auto" | "gemini_proxy" | "null"
    backend: str = "auto"
    # OpenAI-compatible relay base URL (recommended to end with /v1).
    api_base: str = ""
    api_key: str = ""
    vision_model: str = ""
    caption_workers: int = 2
    caption_in_flight: int = 8
    # Batch N clips' frames (e.g. 5 clips * 3 frames = 15 images) into one Vision request to reduce per-request overhead.
    # Set to 1 to disable batching (best quality, highest request count).
    caption_batch_clips: int = 1
    # Optional safety cap on images per request (0 = no cap).
    caption_batch_max_images: int = 0
    # Filter: skip selecting clips from the first/last seconds of each source video (ads/credits).
    # Default to 0 to avoid accidentally skipping the whole video on short clips.
    skip_head_sec: int = 0
    skip_tail_sec: int = 0
    # Index slicing mode: "scene" uses ffmpeg scene detection on proxy.mp4; "fixed" uses fixed seconds.
    slice_mode: str = "scene"
    # ffmpeg select(scene) threshold: 0..1 (higher = fewer cuts). Anime often works around 0.30-0.45.
    scene_threshold: float = 0.35
    # Downsample FPS during scene scan for speed (proxy is low-res already).
    scene_fps: float = 4.0
    # Clip duration constraints (seconds).
    clip_min_sec: float = 3.0
    clip_target_sec: float = 4.5
    clip_max_sec: float = 6.0


@dataclass(frozen=True)
class RenderSettings:
    # Keep original playback speed (avoid speed-up/slow-down artifacts).
    keep_speed: bool = True
    # Optional global emphasis phrases for "花字" (can also be marked inline via [[...]] / 【...】).
    emphasis_enable: bool = True
    emphasis_phrases: list[str] | None = None
    emphasis_max_per_line: int = 1
    emphasis_popup_sec: float = 0.9
    # Matching quality knobs (simple rerank on top of embedding cosine).
    match_keyword_boost: float = 0.05
    # Penalize undesirable clips (helps avoid selecting title cards / heavy subtitles / UI overlays).
    match_penalty_subtitle_heavy: float = 0.06

    # Subtitle appearance (ASS). Horizontal output defaults are tuned for readability.
    subtitles_font_name: str = "MicrosoftYaHeiUI"
    subtitles_font_size_vh: float = 6.0
    subtitles_margin_bottom_vh: float = 14.0
    subtitles_safe_lr_vw: float = 5.0
    # Soft shadow (instead of hard outline).
    subtitles_shadow_alpha: float = 0.5
    subtitles_shadow_blur: float = 0.3
    subtitles_shadow_x: int = 0
    subtitles_shadow_y: int = 2

    # Timeline mode: only "edgetts" is supported.
    timeline_mode: str = "edgetts"

    # Background music volume (0.0~1.0). Applied when bgm_audio_path is provided.
    bgm_volume: float = 0.12
    # Output video FPS for segment rendering / concat stability.
    output_fps: int = 25


@dataclass(frozen=True)
class AppSettings:
    embedding: EmbeddingSettings = EmbeddingSettings()
    vision: VisionSettings = VisionSettings()
    render: RenderSettings = RenderSettings()


def load_settings() -> AppSettings:
    """
    Runtime settings live in ./data/settings.json (not checked in).
    Keep this file small and human-editable.
    """
    paths = default_paths()
    path = os.path.join(paths.data_dir, "settings.json")
    if not os.path.isfile(path):
        return AppSettings()
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        emb = raw.get("embedding", {}) if isinstance(raw, dict) else {}
        vis = raw.get("vision", {}) if isinstance(raw, dict) else {}
        ren = raw.get("render", {}) if isinstance(raw, dict) else {}
        def _int_or_default(v: object, default: int) -> int:
            try:
                return int(v)
            except Exception:
                return int(default)
        def _float_or_default(v: object, default: float) -> float:
            try:
                return float(v)
            except Exception:
                return float(default)
        emph = ren.get("emphasis_phrases")
        if isinstance(emph, str):
            emph = [s.strip() for s in emph.replace("，", ",").split(",") if s.strip()]
        elif isinstance(emph, list):
            emph = [str(s).strip() for s in emph if str(s).strip()]
        else:
            emph = None
        return AppSettings(
            embedding=EmbeddingSettings(
                backend=str(emb.get("backend", "auto")),
                model_id=str(emb.get("model_id", EmbeddingSettings().model_id)),
            ),
            vision=VisionSettings(
                backend=str(vis.get("backend", "auto")),
                api_base=str(vis.get("api_base", "")),
                api_key=str(vis.get("api_key", "")),
                vision_model=str(vis.get("vision_model", "")),
                caption_workers=int(vis.get("caption_workers", 2) or 2),
                caption_in_flight=int(vis.get("caption_in_flight", 8) or 8),
                caption_batch_clips=int(vis.get("caption_batch_clips", 1) or 1),
                caption_batch_max_images=int(vis.get("caption_batch_max_images", 0) or 0),
                skip_head_sec=_int_or_default(vis.get("skip_head_sec", 0), 0),
                skip_tail_sec=_int_or_default(vis.get("skip_tail_sec", 0), 0),
                slice_mode=str(vis.get("slice_mode", "scene") or "scene").strip(),
                scene_threshold=_float_or_default(vis.get("scene_threshold", 0.35), 0.35),
                scene_fps=_float_or_default(vis.get("scene_fps", 4.0), 4.0),
                clip_min_sec=_float_or_default(vis.get("clip_min_sec", 3.0), 3.0),
                clip_target_sec=_float_or_default(vis.get("clip_target_sec", 4.5), 4.5),
                clip_max_sec=_float_or_default(vis.get("clip_max_sec", 6.0), 6.0),
            ),
            render=RenderSettings(
                keep_speed=bool(ren.get("keep_speed", True)),
                emphasis_enable=bool(ren.get("emphasis_enable", True)),
                emphasis_phrases=emph,
                emphasis_max_per_line=int(ren.get("emphasis_max_per_line", 1) or 1),
                emphasis_popup_sec=float(ren.get("emphasis_popup_sec", 0.9) or 0.9),
                match_keyword_boost=float(ren.get("match_keyword_boost", 0.05) or 0.05),
                match_penalty_subtitle_heavy=float(ren.get("match_penalty_subtitle_heavy", 0.06) or 0.06),

                subtitles_font_name=str(ren.get("subtitles_font_name", "MicrosoftYaHeiUI") or "MicrosoftYaHeiUI"),
                subtitles_font_size_vh=float(ren.get("subtitles_font_size_vh", 6.0) or 6.0),
                subtitles_margin_bottom_vh=float(ren.get("subtitles_margin_bottom_vh", 14.0) or 14.0),
                subtitles_safe_lr_vw=float(ren.get("subtitles_safe_lr_vw", 5.0) or 5.0),
                subtitles_shadow_alpha=float(ren.get("subtitles_shadow_alpha", 0.5) or 0.5),
                subtitles_shadow_blur=float(ren.get("subtitles_shadow_blur", 0.3) or 0.3),
                subtitles_shadow_x=int(ren.get("subtitles_shadow_x", 0) or 0),
                subtitles_shadow_y=int(ren.get("subtitles_shadow_y", 2) or 2),

                timeline_mode=str(ren.get("timeline_mode", "edgetts") or "edgetts").strip(),
                bgm_volume=float(ren.get("bgm_volume", 0.12) or 0.12),
                output_fps=int(ren.get("output_fps", 25) or 25),
            ),
        )
    except Exception:
        return AppSettings()


def save_settings(st: AppSettings) -> str:
    paths = default_paths()
    os.makedirs(paths.data_dir, exist_ok=True)
    path = os.path.join(paths.data_dir, "settings.json")
    data = {
        "embedding": {
            "backend": st.embedding.backend,
            "model_id": st.embedding.model_id,
        },
        "vision": {
            "backend": st.vision.backend,
            "api_base": st.vision.api_base,
            "api_key": st.vision.api_key,
            "vision_model": st.vision.vision_model,
            "caption_workers": int(st.vision.caption_workers),
            "caption_in_flight": int(st.vision.caption_in_flight),
            "caption_batch_clips": int(st.vision.caption_batch_clips),
            "caption_batch_max_images": int(st.vision.caption_batch_max_images),
            "skip_head_sec": int(st.vision.skip_head_sec),
            "skip_tail_sec": int(st.vision.skip_tail_sec),
            "slice_mode": str(st.vision.slice_mode),
            "scene_threshold": float(st.vision.scene_threshold),
            "scene_fps": float(st.vision.scene_fps),
            "clip_min_sec": float(st.vision.clip_min_sec),
            "clip_target_sec": float(st.vision.clip_target_sec),
            "clip_max_sec": float(st.vision.clip_max_sec),
        },
        "render": {
            "keep_speed": bool(getattr(st, "render", RenderSettings()).keep_speed),
            "emphasis_enable": bool(getattr(st, "render", RenderSettings()).emphasis_enable),
            "emphasis_phrases": list(getattr(st, "render", RenderSettings()).emphasis_phrases or []),
            "emphasis_max_per_line": int(getattr(st, "render", RenderSettings()).emphasis_max_per_line),
            "emphasis_popup_sec": float(getattr(st, "render", RenderSettings()).emphasis_popup_sec),
            "match_keyword_boost": float(getattr(st, "render", RenderSettings()).match_keyword_boost),
            "match_penalty_subtitle_heavy": float(getattr(st, "render", RenderSettings()).match_penalty_subtitle_heavy),

            "subtitles_font_name": str(getattr(st, "render", RenderSettings()).subtitles_font_name),
            "subtitles_font_size_vh": float(getattr(st, "render", RenderSettings()).subtitles_font_size_vh),
            "subtitles_margin_bottom_vh": float(getattr(st, "render", RenderSettings()).subtitles_margin_bottom_vh),
            "subtitles_safe_lr_vw": float(getattr(st, "render", RenderSettings()).subtitles_safe_lr_vw),
            "subtitles_shadow_alpha": float(getattr(st, "render", RenderSettings()).subtitles_shadow_alpha),
            "subtitles_shadow_blur": float(getattr(st, "render", RenderSettings()).subtitles_shadow_blur),
            "subtitles_shadow_x": int(getattr(st, "render", RenderSettings()).subtitles_shadow_x),
            "subtitles_shadow_y": int(getattr(st, "render", RenderSettings()).subtitles_shadow_y),
            "timeline_mode": str(getattr(st, "render", RenderSettings()).timeline_mode),
            "bgm_volume": float(getattr(st, "render", RenderSettings()).bgm_volume),
            "output_fps": int(getattr(st, "render", RenderSettings()).output_fps),
        },
    }
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return path
