from __future__ import annotations

import os
import time
from dataclasses import asdict
from typing import Any

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.core.paths import default_paths
from app.core.project_store import ProjectStore
from app.core.runtime_config import (
    clear_runtime_vision_credentials,
    has_runtime_vision_credentials,
    set_runtime_vision_credentials,
)
from app.core.settings import (
    AppSettings,
    EmbeddingSettings,
    RenderSettings,
    VisionSettings,
    load_settings,
    save_settings,
)
from app.jobs.render_job import RenderJobRequest
from app.server.job_manager import JobManager
from app.vision.gemini_proxy import GeminiRelayCaptionProvider


class CreateProjectIn(BaseModel):
    name: str = Field(min_length=1)


class AddVideosIn(BaseModel):
    video_paths: list[str] = Field(default_factory=list)


class EmbeddingSettingsPatch(BaseModel):
    backend: str | None = None
    model_id: str | None = None


class VisionSettingsPatch(BaseModel):
    backend: str | None = None
    api_base: str | None = None
    api_key: str | None = None
    vision_model: str | None = None
    caption_workers: int | None = None
    caption_in_flight: int | None = None
    caption_batch_clips: int | None = None
    caption_batch_max_images: int | None = None
    skip_head_sec: int | None = None
    skip_tail_sec: int | None = None
    slice_mode: str | None = None
    scene_threshold: float | None = None
    scene_fps: float | None = None
    clip_min_sec: float | None = None
    clip_target_sec: float | None = None
    clip_max_sec: float | None = None


class RenderSettingsPatch(BaseModel):
    keep_speed: bool | None = None
    emphasis_enable: bool | None = None
    emphasis_phrases: list[str] | None = None
    emphasis_max_per_line: int | None = None
    emphasis_popup_sec: float | None = None
    match_keyword_boost: float | None = None
    match_penalty_subtitle_heavy: float | None = None
    subtitles_font_name: str | None = None
    subtitles_font_size_vh: float | None = None
    subtitles_margin_bottom_vh: float | None = None
    subtitles_safe_lr_vw: float | None = None
    subtitles_shadow_alpha: float | None = None
    subtitles_shadow_blur: float | None = None
    subtitles_shadow_x: int | None = None
    subtitles_shadow_y: int | None = None
    timeline_mode: str | None = None
    bgm_volume: float | None = None
    output_fps: int | None = None


class SettingsPatch(BaseModel):
    embedding: EmbeddingSettingsPatch | None = None
    vision: VisionSettingsPatch | None = None
    render: RenderSettingsPatch | None = None


class RuntimeVisionIn(BaseModel):
    api_base: str = ""
    api_key: str = ""


class StartIndexJobIn(BaseModel):
    project_id: str
    videos_override: list[str] | None = None
    proxy_height: int = 180
    frames_per_clip: int = 3
    fixed_clip_sec_fallback: float = 4.0
    slice_mode: str | None = None
    scene_threshold: float | None = None
    scene_fps: float | None = None
    min_clip_sec: float | None = None
    target_clip_sec: float | None = None
    max_clip_sec: float | None = None
    max_videos: int = 0
    caption_workers: int | None = None
    caption_in_flight: int | None = None
    caption_batch_clips: int | None = None
    caption_batch_max_images: int | None = None
    skip_head_sec: int | None = None
    skip_tail_sec: int | None = None
    caption_flush_every: int = 10


class StartRenderJobIn(BaseModel):
    project_id: str
    voice_audio_path: str
    script_text: str
    output_path: str
    tts_meta_path: str | None = None
    bgm_audio_path: str | None = None
    dedup_window_sec: int = 60
    output_width: int = 1920
    output_height: int = 1080
    keep_speed: bool = True
    emphasis_phrases: list[str] = Field(default_factory=list)
    emphasis_enable: bool = True


class VisionModelsIn(BaseModel):
    api_base: str | None = None
    api_key: str | None = None


class VisionTestCaptionIn(BaseModel):
    image_paths: list[str] = Field(min_length=1)
    api_base: str | None = None
    api_key: str | None = None
    vision_model: str | None = None
    project_hint: str | None = None


def _settings_path_meta() -> dict[str, Any]:
    paths = default_paths()
    path = os.path.join(paths.data_dir, "settings.json")
    exists = os.path.isfile(path)
    mtime = None
    if exists:
        try:
            mtime = os.path.getmtime(path)
        except Exception:
            mtime = None
    return {"path": path, "exists": exists, "mtime": mtime, "root": paths.root}


def _settings_to_public_dict(st: AppSettings) -> dict[str, Any]:
    """Settings for UI.

    注意：当 API 凭据来自 env（由宿主进程注入）时，避免把密钥回显给前端。
    """

    data = asdict(st)
    try:
        # Always mask key in public response (defense in depth).
        vis = data.get("vision") or {}
        if isinstance(vis, dict) and vis.get("api_key"):
            vis["api_key"] = "***"
        data["vision"] = vis
    except Exception:
        pass
    return data


def create_app(*, job_manager: JobManager | None = None) -> FastAPI:
    jm = job_manager or JobManager()
    store = ProjectStore.default()

    app = FastAPI(title="gist-video local server", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "ts": time.time()}

    @app.get("/api/settings")
    def get_settings() -> dict[str, Any]:
        st = load_settings(apply_runtime=True)
        meta = _settings_path_meta()
        return {**meta, "settings": _settings_to_public_dict(st)}

    @app.put("/api/runtime/vision")
    def set_runtime_vision(inp: RuntimeVisionIn = Body(...)) -> dict[str, Any]:
        """Set runtime-only vision credentials.

        - Stored in memory only
        - Used by load_settings(apply_runtime=True)
        - Never persisted to settings.json
        """
        api_base = str(inp.api_base or "").strip()
        api_key = str(inp.api_key or "").strip()
        if not api_base or not api_key:
            raise HTTPException(status_code=400, detail="缺少 api_base/api_key")
        set_runtime_vision_credentials(api_base=api_base, api_key=api_key)
        return {"ok": True}

    @app.delete("/api/runtime/vision")
    def clear_runtime_vision() -> dict[str, Any]:
        clear_runtime_vision_credentials()
        return {"ok": True}

    @app.put("/api/settings")
    def patch_settings(patch: SettingsPatch = Body(...)) -> dict[str, Any]:
        # Important: do NOT apply runtime overrides here, otherwise a PUT would persist secrets into settings.json.
        cur = load_settings(apply_runtime=False)

        emb = cur.embedding
        if patch.embedding is not None:
            emb = EmbeddingSettings(
                backend=patch.embedding.backend if patch.embedding.backend is not None else cur.embedding.backend,
                model_id=patch.embedding.model_id if patch.embedding.model_id is not None else cur.embedding.model_id,
            )

        vis = cur.vision
        if patch.vision is not None:
            pv = patch.vision
            runtime_locked = has_runtime_vision_credentials()
            vis = VisionSettings(
                backend=pv.backend if pv.backend is not None else cur.vision.backend,
                # When runtime creds are present, keep file values (avoid persisting secrets).
                api_base=(cur.vision.api_base if runtime_locked else (pv.api_base if pv.api_base is not None else cur.vision.api_base)),
                api_key=(cur.vision.api_key if runtime_locked else (pv.api_key if pv.api_key is not None else cur.vision.api_key)),
                vision_model=pv.vision_model if pv.vision_model is not None else cur.vision.vision_model,
                caption_workers=int(pv.caption_workers) if pv.caption_workers is not None else int(cur.vision.caption_workers),
                caption_in_flight=int(pv.caption_in_flight) if pv.caption_in_flight is not None else int(cur.vision.caption_in_flight),
                caption_batch_clips=int(pv.caption_batch_clips) if pv.caption_batch_clips is not None else int(cur.vision.caption_batch_clips),
                caption_batch_max_images=int(pv.caption_batch_max_images) if pv.caption_batch_max_images is not None else int(cur.vision.caption_batch_max_images),
                skip_head_sec=int(pv.skip_head_sec) if pv.skip_head_sec is not None else int(cur.vision.skip_head_sec),
                skip_tail_sec=int(pv.skip_tail_sec) if pv.skip_tail_sec is not None else int(cur.vision.skip_tail_sec),
                slice_mode=str(pv.slice_mode) if pv.slice_mode is not None else str(cur.vision.slice_mode),
                scene_threshold=float(pv.scene_threshold) if pv.scene_threshold is not None else float(cur.vision.scene_threshold),
                scene_fps=float(pv.scene_fps) if pv.scene_fps is not None else float(cur.vision.scene_fps),
                clip_min_sec=float(pv.clip_min_sec) if pv.clip_min_sec is not None else float(cur.vision.clip_min_sec),
                clip_target_sec=float(pv.clip_target_sec) if pv.clip_target_sec is not None else float(cur.vision.clip_target_sec),
                clip_max_sec=float(pv.clip_max_sec) if pv.clip_max_sec is not None else float(cur.vision.clip_max_sec),
            )

        ren = getattr(cur, "render", RenderSettings())
        if patch.render is not None:
            pr = patch.render
            ren = RenderSettings(
                keep_speed=pr.keep_speed if pr.keep_speed is not None else ren.keep_speed,
                emphasis_enable=pr.emphasis_enable if pr.emphasis_enable is not None else ren.emphasis_enable,
                emphasis_phrases=pr.emphasis_phrases if pr.emphasis_phrases is not None else ren.emphasis_phrases,
                emphasis_max_per_line=int(pr.emphasis_max_per_line) if pr.emphasis_max_per_line is not None else int(ren.emphasis_max_per_line),
                emphasis_popup_sec=float(pr.emphasis_popup_sec) if pr.emphasis_popup_sec is not None else float(ren.emphasis_popup_sec),
                match_keyword_boost=float(pr.match_keyword_boost) if pr.match_keyword_boost is not None else float(ren.match_keyword_boost),
                match_penalty_subtitle_heavy=float(pr.match_penalty_subtitle_heavy) if pr.match_penalty_subtitle_heavy is not None else float(ren.match_penalty_subtitle_heavy),
                subtitles_font_name=pr.subtitles_font_name if pr.subtitles_font_name is not None else ren.subtitles_font_name,
                subtitles_font_size_vh=float(pr.subtitles_font_size_vh) if pr.subtitles_font_size_vh is not None else float(ren.subtitles_font_size_vh),
                subtitles_margin_bottom_vh=float(pr.subtitles_margin_bottom_vh) if pr.subtitles_margin_bottom_vh is not None else float(ren.subtitles_margin_bottom_vh),
                subtitles_safe_lr_vw=float(pr.subtitles_safe_lr_vw) if pr.subtitles_safe_lr_vw is not None else float(ren.subtitles_safe_lr_vw),
                subtitles_shadow_alpha=float(pr.subtitles_shadow_alpha) if pr.subtitles_shadow_alpha is not None else float(ren.subtitles_shadow_alpha),
                subtitles_shadow_blur=float(pr.subtitles_shadow_blur) if pr.subtitles_shadow_blur is not None else float(ren.subtitles_shadow_blur),
                subtitles_shadow_x=int(pr.subtitles_shadow_x) if pr.subtitles_shadow_x is not None else int(ren.subtitles_shadow_x),
                subtitles_shadow_y=int(pr.subtitles_shadow_y) if pr.subtitles_shadow_y is not None else int(ren.subtitles_shadow_y),
                timeline_mode=pr.timeline_mode if pr.timeline_mode is not None else ren.timeline_mode,
                bgm_volume=float(pr.bgm_volume) if pr.bgm_volume is not None else float(ren.bgm_volume),
                output_fps=int(pr.output_fps) if pr.output_fps is not None else int(ren.output_fps),
            )

        out = AppSettings(embedding=emb, vision=vis, render=ren)
        path = save_settings(out)
        meta = _settings_path_meta()
        return {**meta, "saved_to": path, "settings": _settings_to_public_dict(out)}

    @app.get("/api/projects")
    def list_projects() -> dict[str, Any]:
        ps = store.list_projects()
        return {
            "projects": [
                {"project_id": p.project_id, "name": p.name, "created_at": p.created_at} for p in ps
            ]
        }

    @app.post("/api/projects")
    def create_project(inp: CreateProjectIn) -> dict[str, Any]:
        p = store.create_project(name=inp.name.strip())
        return {"project": {"project_id": p.project_id, "name": p.name, "created_at": p.created_at}}

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict[str, Any]:
        try:
            meta = store.get_project_meta(project_id)
        except Exception as e:
            raise HTTPException(status_code=404, detail=str(e))
        return {"project": meta}

    @app.post("/api/projects/{project_id}/videos")
    def add_videos(project_id: str, inp: AddVideosIn) -> dict[str, Any]:
        store.add_videos(project_id=project_id, video_paths=list(inp.video_paths or []))
        meta = store.get_project_meta(project_id)
        return {"project": meta}

    @app.get("/api/jobs")
    def jobs_list() -> dict[str, Any]:
        return {"jobs": jm.list_jobs()}

    @app.get("/api/jobs/{job_id}")
    def job_get(job_id: str) -> dict[str, Any]:
        try:
            job = jm.get(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="job not found")
        return {"job": job.snapshot()}

    @app.post("/api/jobs/index")
    def job_start_index(inp: StartIndexJobIn) -> dict[str, Any]:
        from app.jobs.index_job import IndexJobRequest

        req = IndexJobRequest(
            project_id=inp.project_id,
            videos_override=tuple(inp.videos_override) if inp.videos_override else None,
            proxy_height=int(inp.proxy_height),
            frames_per_clip=int(inp.frames_per_clip),
            fixed_clip_sec_fallback=float(inp.fixed_clip_sec_fallback),
            slice_mode=inp.slice_mode,
            scene_threshold=inp.scene_threshold,
            scene_fps=inp.scene_fps,
            min_clip_sec=inp.min_clip_sec,
            target_clip_sec=inp.target_clip_sec,
            max_clip_sec=inp.max_clip_sec,
            max_videos=int(inp.max_videos or 0),
            caption_workers=inp.caption_workers,
            caption_in_flight=inp.caption_in_flight,
            caption_batch_clips=inp.caption_batch_clips,
            caption_batch_max_images=inp.caption_batch_max_images,
            skip_head_sec=inp.skip_head_sec,
            skip_tail_sec=inp.skip_tail_sec,
            caption_flush_every=int(inp.caption_flush_every),
        )
        job_id = jm.start_index_job(req)
        return {"job_id": job_id}

    @app.post("/api/jobs/render")
    def job_start_render(inp: StartRenderJobIn) -> dict[str, Any]:
        req = RenderJobRequest(
            project_id=inp.project_id,
            voice_audio_path=inp.voice_audio_path,
            script_text=inp.script_text,
            output_path=inp.output_path,
            tts_meta_path=inp.tts_meta_path,
            bgm_audio_path=inp.bgm_audio_path,
            dedup_window_sec=int(inp.dedup_window_sec),
            output_width=int(inp.output_width),
            output_height=int(inp.output_height),
            keep_speed=bool(inp.keep_speed),
            emphasis_enable=bool(inp.emphasis_enable),
            emphasis_phrases=tuple(str(s) for s in (inp.emphasis_phrases or []) if str(s).strip()),
        )
        job_id = jm.start_render_job(req)
        return {"job_id": job_id}

    @app.post("/api/jobs/{job_id}/pause")
    def job_pause(job_id: str) -> dict[str, Any]:
        try:
            snap = jm.pause(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="job not found")
        return {"job": snap}

    @app.post("/api/jobs/{job_id}/resume")
    def job_resume(job_id: str) -> dict[str, Any]:
        try:
            snap = jm.resume(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="job not found")
        return {"job": snap}

    @app.post("/api/jobs/{job_id}/cancel")
    def job_cancel(job_id: str) -> dict[str, Any]:
        try:
            snap = jm.cancel(job_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="job not found")
        return {"job": snap}

    @app.post("/api/vision/models")
    def vision_models(inp: VisionModelsIn) -> dict[str, Any]:
        st = load_settings().vision
        api_base = (inp.api_base if inp.api_base is not None else st.api_base) or ""
        api_key = (inp.api_key if inp.api_key is not None else st.api_key) or ""
        if not api_base.strip() or not api_key.strip():
            raise HTTPException(status_code=400, detail="缺少 api_base/api_key")
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
            ids: list[str] = []
            for item in (data.get("data") or []):
                mid = item.get("id")
                if mid:
                    ids.append(str(mid))
            return {"models": ids}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/api/vision/test-caption")
    def vision_test_caption(inp: VisionTestCaptionIn) -> dict[str, Any]:
        st = load_settings().vision
        api_base = (inp.api_base if inp.api_base is not None else st.api_base) or ""
        api_key = (inp.api_key if inp.api_key is not None else st.api_key) or ""
        model = (inp.vision_model if inp.vision_model is not None else st.vision_model) or ""
        if not api_base.strip() or not api_key.strip() or not model.strip():
            raise HTTPException(status_code=400, detail="缺少 api_base/api_key/vision_model")
        prov = GeminiRelayCaptionProvider(api_base=api_base, api_key=api_key, model=model)
        if inp.project_hint:
            try:
                prov.set_project_hint(inp.project_hint)
            except Exception:
                pass
        caps = prov.caption_image_paths(list(inp.image_paths))
        return {"captions": caps}

    @app.websocket("/ws/jobs/{job_id}")
    async def ws_job_events(websocket: WebSocket, job_id: str) -> None:
        await websocket.accept()
        try:
            job, q, history = jm.subscribe(job_id)
        except KeyError:
            await websocket.send_json({"type": "error", "error": "job not found"})
            await websocket.close()
            return
        try:
            # Send snapshot + history first (useful on refresh/reconnect).
            await websocket.send_json({"type": "snapshot", "job": job.snapshot(), "events": history})
            while True:
                try:
                    ev = await _queue_get_async(q)
                except Exception:
                    break
                await websocket.send_json(ev)
        except WebSocketDisconnect:
            pass
        finally:
            job.remove_subscriber(q)

    return app


async def _queue_get_async(q) -> Any:
    import asyncio

    return await asyncio.to_thread(q.get)
