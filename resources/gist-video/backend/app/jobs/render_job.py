from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass

import numpy as np

from app.audio.edgetts_meta import align_script_parts_to_words, load_edgetts_meta
from app.core.ffmpeg import find_ffmpeg, run_cmd
from app.core.project_store import ProjectStore
from app.core.settings import load_settings
from app.core.util import atomic_write_json, check_cancel, wait_if_paused
from app.embeddings.local_hash_embed import cosine_sim_matrix
from app.embeddings.provider import LocalHashEmbeddingProvider, get_embedding_provider
from app.subtitles.ass import write_simple_ass


@dataclass(frozen=True)
class RenderJobRequest:
    project_id: str
    voice_audio_path: str
    script_text: str
    output_path: str
    # Optional EdgeTTS metadata JSON path (WordBoundary/SentenceBoundary). If omitted, we'll auto-detect
    # `voice_audio_path` with the same basename but `.json` extension.
    tts_meta_path: str | None = None
    bgm_audio_path: str | None = None
    dedup_window_sec: int = 60
    # Output resolution (16:9 horizontal defaults). Keep segments + final mux consistent.
    output_width: int = 1920
    output_height: int = 1080
    # Prefer constant playback speed (no speed-up/slow-down artifacts).
    keep_speed: bool = True
    # Optional emphasis phrases for "花字" (comma-separated in UI; inline markup also supported).
    emphasis_phrases: tuple[str, ...] = ()
    emphasis_enable: bool = True


def _load_index(store: ProjectStore, project_id: str) -> tuple[list[dict], np.ndarray, dict]:
    cache_dir = store.project_cache_dir(project_id)
    index_dir = os.path.join(cache_dir, "index")
    clips_json = os.path.join(index_dir, "clips.json")
    vecs_npy = os.path.join(index_dir, "clip_vectors.npy")
    if not os.path.isfile(clips_json) or not os.path.isfile(vecs_npy):
        raise RuntimeError("Index not found. Build the project index first.")
    with open(clips_json, "r", encoding="utf-8") as f:
        meta = json.load(f)
    clips = meta["clips"]
    vecs = np.load(vecs_npy)
    emb_meta = meta.get("embedding", {}) if isinstance(meta, dict) else {}
    return clips, vecs, emb_meta


def _filter_blocked(clips: list[dict], vecs: np.ndarray, log) -> tuple[list[dict], np.ndarray]:
    if vecs.ndim != 2 or len(clips) != int(vecs.shape[0]):
        return clips, vecs
    keep_idx = []
    blocked = 0
    for i, c in enumerate(clips):
        if bool(c.get("blocked")):
            blocked += 1
            continue
        keep_idx.append(i)
    if blocked:
        log(f"过滤广告/片头片尾/版权切片：{blocked} 个")
    if not keep_idx:
        raise RuntimeError("所有切片都被过滤掉了（请把API设置里的跳过片头/片尾调小，或关闭过滤）。")
    return [clips[i] for i in keep_idx], vecs[keep_idx, :]


def _provider_for_index(emb_meta: dict, *, fallback_dim: int) -> object:
    # Prefer the same backend used during indexing to avoid dim mismatch.
    t = str(emb_meta.get("type", "")).lower()
    if "localhash" in t:
        dim = int(emb_meta.get("dim", fallback_dim) or fallback_dim)
        return LocalHashEmbeddingProvider(dim=dim)
    if "onnx" in t:
        from app.embeddings.onnx_m3e import OnnxM3EEmbeddingProvider

        return OnnxM3EEmbeddingProvider(model_id=str(emb_meta.get("model_id") or ""))
    if "modelscope" in t or "m3e" in t:
        raise RuntimeError(
            "当前版本已移除 torch/transformers 的本地 embedding 后端。\\n"
            f"检测到索引使用了旧的 embedding 类型：{t}。\\n"
            "请重新执行“建立/更新索引”，并在 data/settings.json 设置：\\n"
            "- embedding.backend=onnx_m3e\\n"
            f"- embedding.model_id={emb_meta.get('model_id')!r}（改为你的 ONNX model.onnx 路径）"
        )
    return get_embedding_provider()


def _split_script(text: str) -> list[str]:
    """
    Split script into narration units. Hard rule: only split on:
    - Newlines
    - Chinese/English comma/period/question/exclamation: ，, 。. ？? ！!
    - Semicolons: ； ;
    - Dashes (破折号): — – － -

    Punctuation stays attached to the previous unit.
    Content inside double quotes is treated as atomic (do not split within quotes).
    """
    raw = str(text or "")
    if not raw.strip():
        return []

    split_chars = set(["，", "。", "？", "！", ",", ".", "?", "!", "；", ";", "—", "–", "－", "-"])
    dash_chars = set(["—", "–", "－", "-"])
    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        s = "".join(buf).strip()
        buf.clear()
        if s:
            out.append(s)

    in_quote = False
    for i, ch in enumerate(raw):
        if ch == "\r":
            continue
        if ch == "\n":
            flush()
            continue

        # Treat content inside double quotes as atomic (don't split).
        # Supports Chinese quotes “...” and ASCII quotes "...".
        if ch == "“":
            in_quote = True
        elif ch == "”":
            in_quote = False
        elif ch == '"':
            in_quote = not in_quote

        buf.append(ch)

        if in_quote:
            continue

        if ch in split_chars:
            # Avoid splitting twice on "——" / "--" sequences.
            if ch in dash_chars:
                nxt = raw[i + 1] if (i + 1) < len(raw) else ""
                if nxt in dash_chars:
                    continue
            flush()

    flush()

    # Post-process: don't leave a quoted sentence as a standalone unit.
    # If a unit is entirely a quoted fragment (e.g. “xxx。”), merge it into the previous unit when possible.
    merged: list[str] = []

    def _is_quoted_only(s: str) -> bool:
        t = str(s or "").strip()
        if not t:
            return False
        # Remove trailing split punctuation for quote-only detection.
        t2 = re.sub(r"[，,。\.？?!！；;—–－\-]+$", "", t).strip()
        if not t2:
            return False
        if (t2.startswith("“") and "”" in t2):
            # e.g. “xxx” or “xxx”
            return t2.endswith("”")
        if t2.startswith('"') and t2.count('"') >= 2 and t2.endswith('"'):
            return True
        return False

    for s in out:
        if merged and _is_quoted_only(s):
            merged[-1] = merged[-1].rstrip() + s
        else:
            merged.append(s)

    return merged


_INLINE_EMPH_RE = re.compile(r"\[\[(.+?)\]\]|【(.+?)】")
_HASH_TAG_RE = re.compile(r"#([0-9A-Za-z_\u4e00-\u9fff]{2,})")


def _parse_line_markup(s: str) -> tuple[str, list[str], list[str]]:
    """
    Return (clean_text, emphasis_phrases, match_tags).

    - Emphasis markup: [[执掌权柄]] or 【执掌权柄】
    - Matching hint tags: #符文 #战斗 (removed from subtitle text, used to rerank matches)
    """
    text = str(s or "").strip()
    emph: list[str] = []
    tags: list[str] = []

    def _repl(m: re.Match) -> str:
        p = (m.group(1) or m.group(2) or "").strip()
        if p:
            emph.append(p)
        return p

    text = _INLINE_EMPH_RE.sub(_repl, text)

    def _tag_repl(m: re.Match) -> str:
        t = (m.group(1) or "").strip()
        if t:
            tags.append(t)
        return ""

    text = _HASH_TAG_RE.sub(_tag_repl, text)
    text = re.sub(r"\s+", " ", text).strip()

    # Dedup while preserving order.
    def _uniq(xs: list[str]) -> list[str]:
        out = []
        seen = set()
        for x in xs:
            if x and x not in seen:
                seen.add(x)
                out.append(x)
        return out

    return text, _uniq(emph), _uniq(tags)


_SUB_DISPLAY_DROP_RE = re.compile(r"[，,。\.、；;：:…—\-《》“”‘’\"'（）()【】\[\]{}]+")
_SUB_END_KEEP_RE = re.compile(r"([？！?!]+)$")


def _subtitle_display_text(s: str) -> str:
    """
    Subtitle display rules:
    - Do NOT show comma/period/dash/etc (they are only used for splitting).
    - Only keep ?/! (中文/英文) at the END of the subtitle.
    """
    t = str(s or "").strip()
    if not t:
        return ""
    m = _SUB_END_KEEP_RE.search(t)
    end = m.group(1) if m else ""
    if end:
        t = t[: m.start()].strip()
        end = end[-2:]  # e.g. "?!"
    t = _SUB_DISPLAY_DROP_RE.sub("", t)
    t = t.replace("？", "").replace("！", "").replace("?", "").replace("!", "")
    t = t.strip()
    return (t + end) if t else end


def _snap_line_times_to_fps(
    line_times: list[tuple[float, float]],
    *,
    fps: int,
    total_dur: float,
) -> tuple[list[tuple[float, float]], list[int]]:
    """
    Snap narration unit boundaries onto a fixed FPS grid to prevent cumulative drift.

    Why: ffmpeg segment rendering is frame-based, so per-segment durations can round to the nearest frame.
    If we don't snap boundaries, small rounding errors accumulate and later cuts may drift into mid-sentence.

    Returns:
    - snapped_line_times: per-line (start,end) in seconds on the FPS grid
    - frames_per_line: exact output frames for each line
    """
    if not line_times:
        return [], []

    fps = int(fps) if int(fps) > 0 else 25
    fps = max(10, min(60, fps))
    total_dur = max(0.0, float(total_dur))
    # Use ceil so the rendered video is never shorter than the narration audio.
    total_frames = max(1, int((total_dur * fps) + 0.999999))

    n = len(line_times)
    # Desired end times (seconds), clamped to total_dur.
    ends = [max(0.0, min(total_dur, float(en))) for (_st, en) in line_times]
    # Force the last boundary to be exactly at total_dur (avoids leftover tail drift).
    ends[-1] = total_dur

    # Convert to frame indices, then enforce strictly increasing and feasible.
    end_frames = [int(round(t * fps)) for t in ends]
    # Reserve at least 1 frame per remaining unit.
    for i in range(n):
        min_f = (end_frames[i - 1] + 1) if i > 0 else 1
        max_f = total_frames - (n - i - 1)
        end_frames[i] = max(min_f, min(int(end_frames[i]), max_f))
    end_frames[-1] = total_frames
    for i in range(n - 2, -1, -1):
        end_frames[i] = min(end_frames[i], end_frames[i + 1] - 1)
    end_frames[0] = max(1, min(end_frames[0], total_frames - (n - 1)))

    start_frames = [0] + end_frames[:-1]
    frames_per = [max(1, int(e - s)) for s, e in zip(start_frames, end_frames)]

    snapped: list[tuple[float, float]] = []
    for s, e in zip(start_frames, end_frames):
        snapped.append((float(s) / fps, float(e) / fps))
    return snapped, frames_per


_AUTO_KW_RE = re.compile(r"[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}")
_STOPWORDS = {
    "我们",
    "你们",
    "他们",
    "这个",
    "那个",
    "这种",
    "那种",
    "于是",
    "然后",
    "但是",
    "因为",
    "所以",
    "如果",
    "就是",
    "一个",
    "一些",
    "开始",
    "最后",
}

# Script phrase -> visual keyword expansions (used for rerank substring hits).
# This is intentionally shallow and cheap: it boosts retrieval for metaphors like "脑洞大开" -> head wound/blood/gun.
_HINT_ALIASES: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"脑洞大开"), ["爆头", "头部受伤", "流血", "血", "手枪", "枪", "枪击", "开枪"]),
    (re.compile(r"来一枪|开一枪|给自己来一枪|一枪"), ["手枪", "枪", "枪击", "开枪", "血", "流血"]),
    (re.compile(r"头(上|里)?都是血|满头血|血淋淋"), ["头部", "受伤", "流血", "血迹", "血"]),
    (re.compile(r"笔记|日记|手稿|记事本"), ["笔记", "书", "纸张", "翻书", "翻页", "手写"]),
    (re.compile(r"醒来|苏醒"), ["醒来", "躺着", "房间", "床"]),
]


def _extract_hints(clean_text: str, *, emph: list[str], tags: list[str], extra: list[str]) -> list[str]:
    """
    Hints used for reranking matches. Keep it simple (substring checks on clip text).
    """
    hints: list[str] = []
    for x in (emph or []):
        if len(x) >= 2:
            hints.append(x)
    for x in (tags or []):
        if len(x) >= 2:
            hints.append(x)
    for x in (extra or []):
        x = str(x).strip()
        if len(x) >= 2:
            hints.append(x)

    for m in _AUTO_KW_RE.finditer(clean_text):
        w = m.group(0).strip()
        if not w or w in _STOPWORDS:
            continue
        # Avoid flooding: keep longer words first.
        if len(w) >= 2:
            hints.append(w)

    # Add alias expansions for specific phrases (improves recall on "metaphor" narration).
    for pat, adds in _HINT_ALIASES:
        if pat.search(clean_text):
            for a in adds:
                if a and len(a) >= 2:
                    hints.append(a)

    # Dedup + sort by length desc for better substring hit rate.
    seen = set()
    out = []
    for w in sorted(hints, key=lambda x: (-len(x), x)):
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out[:12]


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


def _allocate_durations(lines: list[str], *, total_sec: float) -> list[float]:
    """
    Allocate per-line target durations that sum to `total_sec`.
    Weights are based on visible character count so longer lines get more time.
    """
    if not lines:
        return []
    total_sec = max(1e-3, float(total_sec))

    weights = []
    for s in lines:
        # Count non-space chars (Chinese/English). Keep at least 1 to avoid zero.
        w = len(re.sub(r"\s+", "", str(s)))
        weights.append(float(max(1, w)))
    sw = float(sum(weights)) or 1.0

    durs = [total_sec * (w / sw) for w in weights]

    # Keep individual lines within reasonable bounds, while preserving total.
    # (Use wide bounds to avoid fighting the actual narration pacing.)
    min_d, max_d = 0.8, 30.0
    durs = [max(min_d, min(max_d, float(d))) for d in durs]

    # Redistribute rounding/clamp error over adjustable lines.
    def _redistribute(durs_: list[float]) -> list[float]:
        target = total_sec
        eps = 1e-6
        for _ in range(10):
            cur = float(sum(durs_))
            diff = target - cur
            if abs(diff) < 1e-3:
                break
            if diff > 0:
                adjustable = [i for i, d in enumerate(durs_) if d < (max_d - eps)]
            else:
                adjustable = [i for i, d in enumerate(durs_) if d > (min_d + eps)]
            if not adjustable:
                break
            share = diff / len(adjustable)
            for i in adjustable:
                durs_[i] = max(min_d, min(max_d, durs_[i] + share))
        # Fix any tiny drift on the last item (within bounds).
        drift = target - float(sum(durs_))
        if durs_:
            durs_[-1] = max(min_d, min(max_d, durs_[-1] + drift))
        return durs_

    return _redistribute(durs)


def _compute_line_times(script_lines: list[str], *, voice_audio_path: str, voice_dur: float, subtitle_timing: str, cfg: WhisperAlignConfig, log) -> list[tuple[float, float]]:
    mode = (subtitle_timing or "estimate").strip().lower()
    if mode != "whisper":
        # Legacy heuristic: distribute by script length.
        durs = _allocate_durations(script_lines, total_sec=float(voice_dur))
        t = 0.0
        out: list[tuple[float, float]] = []
        for d in durs:
            out.append((t, t + float(d)))
            t += float(d)
        if out:
            out[-1] = (out[-1][0], float(voice_dur))
        return out

    # Whisper alignment: use audio timestamps to prevent drift.
    try:
        segs = transcribe_faster_whisper(voice_audio_path, cfg)
    except ModuleNotFoundError:
        log("WARNING: faster-whisper not installed; falling back to estimated subtitle timing.")
        return _compute_line_times(
            script_lines,
            voice_audio_path=voice_audio_path,
            voice_dur=float(voice_dur),
            subtitle_timing="estimate",
            cfg=cfg,
            log=log,
        )
    except Exception as e:
        log(f"WARNING: faster-whisper failed; falling back to estimated subtitle timing. Reason: {e}")
        return _compute_line_times(
            script_lines,
            voice_audio_path=voice_audio_path,
            voice_dur=float(voice_dur),
            subtitle_timing="estimate",
            cfg=cfg,
            log=log,
        )

    times = align_script_to_asr_segments(
        script_lines,
        segs,
        voice_dur=float(voice_dur),
        max_group_sec=float(cfg.max_group_sec),
    )
    if len(times) != len(script_lines):
        log("WARNING: whisper alignment returned unexpected size; falling back to estimated timing.")
        return _compute_line_times(
            script_lines,
            voice_audio_path=voice_audio_path,
            voice_dur=float(voice_dur),
            subtitle_timing="estimate",
            cfg=cfg,
            log=log,
        )
    return times


def _merge_asr_segments(
    segs: list[dict],
    *,
    min_sec: float,
    max_sec: float,
    pause_sec: float,
) -> list[dict]:
    """
    Merge faster-whisper segments into fewer units so we don't cut visuals too frequently.
    Units are still strictly derived from whisper timestamps (audio-driven), but prefer splitting on pauses/punctuation.
    """
    min_sec = float(max(0.3, min_sec))
    max_sec = float(max(min_sec, max_sec))
    pause_sec = float(max(0.0, pause_sec))

    def _clean(s: str) -> str:
        return re.sub(r"\s+", " ", str(s or "")).strip()

    def _ends_with_punct(s: str) -> bool:
        s = str(s or "").strip()
        return bool(s) and s[-1] in "，,、。！？!?；;：:"

    out: list[dict] = []
    cur: dict | None = None
    for seg in segs:
        st = float(seg.get("start", 0.0) or 0.0)
        en = float(seg.get("end", 0.0) or 0.0)
        tx = _clean(seg.get("text", ""))
        if en <= st:
            continue
        if cur is None:
            cur = {"start": st, "end": en, "text": tx}
            continue

        gap = st - float(cur["end"])
        new_end = en
        new_dur = new_end - float(cur["start"])
        cur_text = str(cur["text"] or "")
        # Decide whether to cut before this segment.
        should_cut = False
        if new_dur >= max_sec:
            should_cut = True
        elif new_dur >= min_sec and gap >= pause_sec:
            should_cut = True
        elif new_dur >= min_sec and _ends_with_punct(cur_text):
            should_cut = True

        if should_cut:
            out.append(cur)
            cur = {"start": st, "end": en, "text": tx}
        else:
            # Merge: keep time continuity but preserve tiny gaps in text with a space.
            cur["end"] = new_end
            if tx:
                sep = "" if (not cur_text) else " "
                cur["text"] = (cur_text + sep + tx).strip()

    if cur is not None:
        out.append(cur)

    # Merge tiny tail back to previous if needed.
    if len(out) >= 2:
        last = out[-1]
        if (float(last["end"]) - float(last["start"])) < min_sec:
            prev = out[-2]
            prev["end"] = float(last["end"])
            prev["text"] = (str(prev.get("text") or "").strip() + " " + str(last.get("text") or "").strip()).strip()
            out.pop()

    # Final clamp: ensure <= max_sec by splitting if necessary.
    final: list[dict] = []
    for it in out:
        st = float(it["start"])
        en = float(it["end"])
        tx = _clean(it.get("text", ""))
        if en - st <= max_sec + 1e-6:
            final.append({"start": st, "end": en, "text": tx})
            continue
        # Split long chunk evenly to keep <= max_sec.
        t = st
        while t < en - 1e-6:
            t2 = min(en, t + max_sec)
            final.append({"start": t, "end": t2, "text": tx})
            t = t2
    return final


def _semantic_match_script_to_asr_units(
    script_lines: list[str],
    asr_texts: list[str],
    emb_provider,
) -> tuple[list[int], list[float]]:
    """
    For each ASR unit, pick the most semantically similar script line (no monotonic constraint).
    Returns (best_script_idx_per_unit, best_sim_per_unit).
    """
    if not asr_texts:
        return [], []
    if not script_lines:
        return [0 for _ in asr_texts], [0.0 for _ in asr_texts]

    script_vecs = emb_provider.embed_texts(script_lines)
    asr_vecs = emb_provider.embed_texts(asr_texts)
    if script_vecs.ndim != 2 or asr_vecs.ndim != 2 or script_vecs.shape[1] != asr_vecs.shape[1]:
        raise RuntimeError(
            f"Embedding dim mismatch: asr={getattr(asr_vecs,'shape',None)} vs script={getattr(script_vecs,'shape',None)}"
        )
    sims = cosine_sim_matrix(asr_vecs, script_vecs)
    idxs: list[int] = []
    bests: list[float] = []
    for i in range(int(sims.shape[0])):
        row = sims[i]
        j = int(np.argmax(row)) if row.size else 0
        idxs.append(j)
        bests.append(float(row[j]) if row.size else 0.0)
    return idxs, bests


def _group_lines_for_shots(
    script_lines: list[str],
    line_times: list[tuple[float, float]],
    *,
    min_sec: float,
    max_sec: float,
    pause_sec: float,
) -> list[tuple[int, int]]:
    """
    Group adjacent subtitle lines into fewer "shots" to avoid rapid visual cuts while voice is still flowing.
    Cuts still happen only on line boundaries (which are punctuation-based splits).
    """
    n = min(len(script_lines), len(line_times))
    if n <= 0:
        return []

    min_sec = float(max(0.3, min_sec))
    max_sec = float(max(min_sec, max_sec))
    pause_sec = float(max(0.0, pause_sec))

    def _dur(a: int, b_excl: int) -> float:
        st = float(line_times[a][0])
        en = float(line_times[b_excl - 1][1])
        return max(0.0, en - st)

    groups: list[tuple[int, int]] = []
    i = 0
    while i < n:
        start = i
        end = i + 1
        while end < n:
            d = _dur(start, end)
            if d >= max_sec:
                break

            # If we have enough duration already, prefer cutting at an audible pause.
            gap = float(line_times[end][0]) - float(line_times[end - 1][1])
            if d >= min_sec and gap >= pause_sec:
                break

            end += 1

        groups.append((start, end))
        i = end

    # Merge the last group back if it's too short and we have a previous group.
    if len(groups) >= 2:
        a0, a1 = groups[-2]
        b0, b1 = groups[-1]
        if _dur(b0, b1) < min_sec and _dur(a0, b1) <= (max_sec * 1.35):
            groups[-2] = (a0, b1)
            groups.pop()

    return groups


def _pick_timeline(
    script_lines: list[str],
    target_durs: list[float],
    line_hints: list[list[str]],
    clips: list[dict],
    clip_vecs: np.ndarray,
    emb_meta: dict,
    *,
    keep_speed: bool,
    dedup_window_sec: int,
    keyword_boost: float,
    continuity_boost: float,
    short_clip_penalty: float = 0.0,
    min_clip_ratio: float = 0.0,
    subtitle_heavy_penalty: float = 0.0,
) -> list[dict]:
    emb = _provider_for_index(emb_meta, fallback_dim=int(clip_vecs.shape[1]) if clip_vecs.ndim == 2 else 512)
    script_vecs = emb.embed_texts(script_lines)
    if script_vecs.ndim != 2 or clip_vecs.ndim != 2 or script_vecs.shape[1] != clip_vecs.shape[1]:
        raise RuntimeError(
            f"Embedding dim mismatch: script={getattr(script_vecs, 'shape', None)} vs clips={getattr(clip_vecs, 'shape', None)}. Rebuild index or align embedding settings."
        )

    sims = cosine_sim_matrix(script_vecs, clip_vecs)
    timeline: list[dict] = []
    used: dict[str, float] = {}  # shot_key -> last_used_output_time
    prev_source: str | None = None

    out_t = 0.0
    for i, line in enumerate(script_lines):
        scores = sims[i] if sims.size else np.zeros((len(clips),), dtype=np.float32)
        ranked = np.argsort(scores)[::-1] if len(scores) else np.arange(len(clips))

        # Rerank on top-N using simple hint overlap + source continuity.
        hints = line_hints[i] if i < len(line_hints) else []
        top_k = int(min(80, len(ranked)))
        best = None
        best_adj = None
        best_idx = None

        def _overlap_bonus(clip_text: str) -> int:
            if not hints or not clip_text:
                return 0
            n = 0
            for h in hints:
                if h and h in clip_text:
                    n += 1
            return n

        def _shot_key(c: dict) -> str:
            src = str(c.get("source_path") or "")
            if "shot_id" in c:
                return f"{src}#shot{int(c.get('shot_id', -1))}"
            return f"{src}#clip{str(c.get('clip_id') or '')}"

        def _shot_bounds(c: dict) -> tuple[float, float]:
            st = float(c.get("shot_start", c.get("start", 0.0)) or 0.0)
            en = float(c.get("shot_end", c.get("end", 0.0)) or 0.0)
            if en <= st + 1e-6:
                st = float(c.get("start", 0.0) or 0.0)
                en = float(c.get("end", 0.0) or 0.0)
            return float(st), float(en)

        def _pick_within_shot(c: dict, *, need_sec: float) -> tuple[float, float]:
            ss, se = _shot_bounds(c)
            shot_dur = max(1e-3, se - ss)
            take = min(float(need_sec), float(shot_dur))
            mid = (float(c.get("start", ss)) + float(c.get("end", se))) / 2.0
            # Clamp to stay within shot (never cross a natural cut).
            start = max(ss, min(mid - take / 2.0, se - take))
            end = start + take
            return float(start), float(end)

        for idx in ranked[:top_k]:
            c = clips[int(idx)]
            last = used.get(_shot_key(c))
            if last is not None and (out_t - last) < float(dedup_window_sec):
                continue
            adj = float(scores[int(idx)])
            adj += float(keyword_boost) * float(_overlap_bonus(str(c.get("text") or "")))
            if prev_source and str(c.get("source_path") or "") == prev_source:
                adj += float(continuity_boost)
            if float(subtitle_heavy_penalty) > 1e-9:
                flags = c.get("flags") or []
                if isinstance(flags, list) and any(str(x).strip().lower() == "subtitle_heavy" for x in flags):
                    adj -= float(subtitle_heavy_penalty)
            target_dur = float(target_durs[i]) if i < len(target_durs) else float(target_durs[-1])
            ss, se = _shot_bounds(c)
            shot_dur = max(1e-3, se - ss)
            # In constant-speed mode, prefer shots that can cover the whole narration duration without padding.
            if bool(keep_speed) and float(min_clip_ratio) > 1e-9 and shot_dur + 1e-3 < float(target_dur) * float(min_clip_ratio):
                continue
            if bool(keep_speed) and float(short_clip_penalty) > 1e-9 and shot_dur + 1e-3 < target_dur:
                adj -= float(short_clip_penalty) * float((target_dur - shot_dur) / max(1e-3, target_dur))
            if best_adj is None or adj > best_adj:
                best_adj = adj
                best = c
                best_idx = int(idx)

        # If dedup filtered everything, fall back to best regardless of dedup.
        if best is None and len(ranked):
            idx0 = int(ranked[0])
            best = clips[idx0]
            best_idx = idx0
        if best is None:
            raise RuntimeError("No clips available in index.")

        target_dur = float(target_durs[i]) if i < len(target_durs) else float(target_durs[-1])
        cand = [clips[int(x)]["clip_id"] for x in ranked[:top_k]]
        in_t, out_t_src = _pick_within_shot(best, need_sec=float(target_dur))
        timeline.append(
            {
                "text": line,
                "source": best["source_path"],
                "in": float(in_t),
                "out": float(out_t_src),
                "target_dur": target_dur,
                "clip_id": best["clip_id"],
                "candidates": cand,
                "shot_id": int(best.get("shot_id", -1)),
                "shot_start": float(best.get("shot_start", best.get("start", 0.0))),
                "shot_end": float(best.get("shot_end", best.get("end", 0.0))),
            }
        )
        used[_shot_key(best)] = out_t
        prev_source = str(best.get("source_path") or "") or prev_source
        out_t += target_dur
    return timeline


def _build_shot_index(clips: list[dict]) -> tuple[dict[tuple[str, int], dict], dict[str, list[int]]]:
    """
    Build shot-level metadata from clip records.

    Returns:
    - shot_map[(source_path, shot_id)] = {"start":..., "end":..., "clip_idxs":[...], "shot_id":...}
    - shot_ids_by_source[source_path] = sorted shot_id list
    """
    shot_map: dict[tuple[str, int], dict] = {}
    ids_by_src: dict[str, set[int]] = {}
    for idx, c in enumerate(clips):
        src = str(c.get("source_path") or "")
        sid = int(c.get("shot_id", -1))
        if sid < 0 or not src:
            continue
        ss = float(c.get("shot_start", c.get("start", 0.0)) or 0.0)
        se = float(c.get("shot_end", c.get("end", 0.0)) or 0.0)
        if se <= ss + 1e-6:
            ss = float(c.get("start", 0.0) or 0.0)
            se = float(c.get("end", 0.0) or 0.0)
        key = (src, sid)
        if key not in shot_map:
            shot_map[key] = {"source": src, "shot_id": sid, "start": ss, "end": se, "clip_idxs": [idx]}
        else:
            shot_map[key]["clip_idxs"].append(idx)
            # Keep the widest bounds we see (clips are windows inside the same shot).
            shot_map[key]["start"] = min(float(shot_map[key]["start"]), ss)
            shot_map[key]["end"] = max(float(shot_map[key]["end"]), se)
        ids_by_src.setdefault(src, set()).add(sid)

    shot_ids_by_source: dict[str, list[int]] = {src: sorted(list(sids)) for src, sids in ids_by_src.items()}
    return shot_map, shot_ids_by_source


def _pick_visual_segments_edgetts(
    unit_texts: list[str],
    unit_queries: list[str],
    unit_hints: list[list[str]],
    unit_times: list[tuple[float, float]],
    clips: list[dict],
    clip_vecs: np.ndarray,
    emb_meta: dict,
    *,
    dedup_window_sec: int,
    keyword_boost: float,
    subtitle_heavy_penalty: float,
    min_same_source_gap_sec: float = 0.8,
    log,
) -> list[dict]:
    """
    EdgeTTS timeline mode (strict):
    - Narration units are defined by script punctuation (not by shot boundaries).
    - Each unit maps to exactly ONE continuous video segment (no internal cuts).
    - Never cross real shot boundaries (user rejects natural cuts inside a narration unit).
    - If the best-matching shot is too short, pick a longer shot even if similarity is lower.
    """
    if not unit_texts:
        return []

    if not unit_queries or len(unit_queries) != len(unit_texts):
        unit_queries = list(unit_texts)
    if not unit_hints or len(unit_hints) != len(unit_texts):
        unit_hints = [[] for _ in range(len(unit_texts))]
    if not unit_times or len(unit_times) != len(unit_texts):
        raise RuntimeError("unit_times length mismatch.")

    emb = _provider_for_index(emb_meta, fallback_dim=int(clip_vecs.shape[1]) if clip_vecs.ndim == 2 else 512)
    unit_vecs = emb.embed_texts(unit_queries)
    if unit_vecs.ndim != 2 or clip_vecs.ndim != 2 or unit_vecs.shape[1] != clip_vecs.shape[1]:
        raise RuntimeError(
            f"Embedding dim mismatch: units={getattr(unit_vecs, 'shape', None)} vs clips={getattr(clip_vecs, 'shape', None)}. Rebuild index or align embedding settings."
        )

    sims = cosine_sim_matrix(unit_vecs, clip_vecs)
    shot_map, _shot_ids_by_source = _build_shot_index(clips)
    if not shot_map:
        raise RuntimeError("Index clips missing shot_id/shot_start/shot_end. Please rebuild index with scene slicing.")

    used: dict[str, float] = {}  # shot_key -> last_used_output_time
    out_t = 0.0
    prev_src: str | None = None
    prev_out_src_t: float | None = None

    def _shot_key(src: str, sid: int) -> str:
        return f"{src}#shot{int(sid)}"

    def _overlap_bonus(hints: list[str], clip_text: str) -> int:
        if not hints or not clip_text:
            return 0
        n = 0
        for h in hints:
            if h and h in clip_text:
                n += 1
        return int(n)

    def _clip_adj_score(score: float, c: dict, *, hints: list[str]) -> float:
        adj = float(score)
        adj += float(keyword_boost) * float(_overlap_bonus(hints, str(c.get("text") or "")))
        if float(subtitle_heavy_penalty) > 1e-9:
            flags = c.get("flags") or []
            if isinstance(flags, list) and any(str(x).strip().lower() == "subtitle_heavy" for x in flags):
                adj -= float(subtitle_heavy_penalty)
        return float(adj)

    segments: list[dict] = []
    for ui, text in enumerate(unit_texts):
        stt, ent = unit_times[ui]
        target = max(0.05, float(ent) - float(stt))
        hints = unit_hints[ui] if ui < len(unit_hints) else []

        scores = sims[ui] if sims.size else np.zeros((len(clips),), dtype=np.float32)

        # Best clip per shot for this unit (max score).
        shot_best: dict[tuple[str, int], tuple[float, int, int]] = {}  # (score, clip_idx, hit_count)
        for ci, c in enumerate(clips):
            src = str(c.get("source_path") or "")
            sid = int(c.get("shot_id", -1))
            if not src or sid < 0:
                continue
            key = (src, sid)
            hit = _overlap_bonus(hints, str(c.get("text") or "")) if hints else 0
            adj = _clip_adj_score(float(scores[int(ci)]), c, hints=hints)
            prev = shot_best.get(key)
            if prev is None or adj > float(prev[0]):
                shot_best[key] = (float(adj), int(ci), int(hit))

        # Candidates that can fit the full narration duration.
        cand: list[tuple[int, float, float, str, int, int]] = []  # (hit, score, shot_len, src, sid, ci)
        for (src, sid), (sc, ci, hit) in shot_best.items():
            m = shot_map.get((src, int(sid)))
            if not m:
                continue
            ss = float(m["start"])
            se = float(m["end"])
            shot_len = max(0.0, se - ss)
            if shot_len + 1e-6 < target:
                continue
            last = used.get(_shot_key(src, sid))
            if last is not None and (out_t - last) < float(dedup_window_sec):
                continue
            cand.append((int(hit), float(sc), float(shot_len), src, int(sid), int(ci)))

        # Fallback A: ignore dedup, still require shot_len >= target.
        if not cand:
            for (src, sid), (sc, ci, hit) in shot_best.items():
                m = shot_map.get((src, int(sid)))
                if not m:
                    continue
                ss = float(m["start"])
                se = float(m["end"])
                shot_len = max(0.0, se - ss)
                if shot_len + 1e-6 < target:
                    continue
                cand.append((int(hit), float(sc), float(shot_len), src, int(sid), int(ci)))

        if not cand:
            # Absolute fallback: clamp to the longest shot.
            best_long: tuple[float, str, int, int] | None = None
            for (src, sid), (_sc, ci) in shot_best.items():
                m = shot_map.get((src, int(sid)))
                if not m:
                    continue
                ss = float(m["start"])
                se = float(m["end"])
                shot_len = max(0.0, se - ss)
                if best_long is None or shot_len > best_long[0]:
                    best_long = (float(shot_len), src, int(sid), int(ci))
            if best_long is None:
                raise RuntimeError("No usable shots available in index.")
            shot_len, src, sid, ci = best_long
            log(f"WARNING: unit {ui} wants {target:.2f}s but max shot is {shot_len:.2f}s; clamping.")
            target = float(max(0.05, min(target, shot_len)))
            cand = [(0, 0.0, float(shot_len), src, int(sid), int(ci))]

        # Prefer candidates with lexical hits when available; then similarity; then longer shots.
        has_hit = any(h > 0 for (h, _sc, _sl, _src, _sid, _ci) in cand)
        if has_hit:
            cand = [x for x in cand if x[0] > 0] or cand
        cand.sort(key=lambda x: (x[0], x[1], x[2]), reverse=True)

        chosen: dict | None = None
        for hit, sc, _shot_len, src, sid, ci in cand[:240]:
            m = shot_map.get((src, int(sid)))
            if not m:
                continue
            ss = float(m["start"])
            se = float(m["end"])
            if (se - ss) + 1e-6 < target:
                continue

            c = clips[int(ci)]
            mid = (float(c.get("start", ss)) + float(c.get("end", se))) / 2.0
            in_t = max(ss, min(mid - target / 2.0, se - target))
            out_t_src = in_t + target

            # If too close to previous segment in the same source, shift forward within this shot.
            if prev_src and prev_out_src_t is not None and src == prev_src:
                min_gap = float(max(0.0, min_same_source_gap_sec))
                if float(in_t) < float(prev_out_src_t) + min_gap:
                    shifted = max(float(in_t), float(prev_out_src_t) + min_gap)
                    shifted = min(float(shifted), float(se - target))
                    if shifted > float(in_t) + 1e-3:
                        in_t = float(shifted)
                        out_t_src = float(in_t + target)
                    else:
                        continue

            chosen = {
                "unit_i": int(ui),
                "text": str(text),
                "source": str(src),
                "in": float(in_t),
                "out": float(out_t_src),
                "shot_id": int(sid),
                "shot_start": float(ss),
                "shot_end": float(se),
                "hit": int(hit),
                "score": float(sc),
                "anchor_clip_id": str(c.get("clip_id") or ""),
                "start": float(stt),
                "end": float(ent),
            }
            break

        if chosen is None:
            hit, sc, _shot_len, src, sid, ci = cand[0]
            m = shot_map[(src, int(sid))]
            ss = float(m["start"])
            se = float(m["end"])
            c = clips[int(ci)]
            mid = (float(c.get("start", ss)) + float(c.get("end", se))) / 2.0
            in_t = max(ss, min(mid - target / 2.0, se - target))
            out_t_src = in_t + target
            chosen = {
                "unit_i": int(ui),
                "text": str(text),
                "source": str(src),
                "in": float(in_t),
                "out": float(out_t_src),
                "shot_id": int(sid),
                "shot_start": float(ss),
                "shot_end": float(se),
                "hit": int(hit),
                "score": float(sc),
                "anchor_clip_id": str(c.get("clip_id") or ""),
                "start": float(stt),
                "end": float(ent),
            }

        segments.append(chosen)
        used[_shot_key(str(chosen["source"]), int(chosen["shot_id"]))] = float(out_t)
        prev_src = str(chosen["source"])
        prev_out_src_t = float(chosen["out"])
        out_t += float(target)

    return segments


def _ffmpeg_escape_path(p: str) -> str:
    # For subtitles filter; keep it simple for Windows paths.
    return p.replace("\\", "/").replace(":", "\\:")


def _ffmpeg_escape_drawtext(s: str) -> str:
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _render_segment(
    ffmpeg: str,
    *,
    src: str,
    in_t: float,
    nframes: int,
    out_fps: int,
    out_w: int,
    out_h: int,
    out_ts: str,
    log,
) -> None:
    if os.path.isfile(out_ts):
        return
    os.makedirs(os.path.dirname(out_ts), exist_ok=True)

    out_fps = int(out_fps) if int(out_fps) > 0 else 25
    out_fps = max(10, min(60, out_fps))
    nframes = int(nframes)
    if nframes <= 0:
        raise RuntimeError(f"Invalid nframes: {nframes}")

    blur_h = "ih*0.22"
    blur_y = "ih*0.78"
    # NOTE: `overlay` doesn't have `ih/iw` vars; use main_h/main_w there.
    overlay_y = "main_h*0.78"
    if int(out_w) == 1080 and int(out_h) == 1920:
        scale = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    else:
        # Preserve full frame (no crop) and pad to target; keeps output truly 16:9.
        scale = (
            f"scale={int(out_w)}:{int(out_h)}:force_original_aspect_ratio=decrease,"
            f"pad={int(out_w)}:{int(out_h)}:(ow-iw)/2:(oh-ih)/2:color=black"
        )

    vf = (
        "split=2[vbase][vblur];"
        f"[vblur]crop=w=iw:h={blur_h}:x=0:y={blur_y},boxblur=10:1[vb];"
        f"[vbase][vb]overlay=x=0:y={overlay_y},"
        "unsharp=5:5:0.4,eq=saturation=1.03:contrast=1.02,"
        f"{scale},fps={out_fps},setsar=1,setpts=PTS-STARTPTS"
    )

    run_cmd(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-ss",
            f"{float(in_t):.3f}",
            "-i",
            src,
            "-an",
            "-vf",
            vf,
            "-frames:v",
            str(int(nframes)),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "mpegts",
            out_ts,
        ],
        log_fn=log,
    )


def run_render_job(req: RenderJobRequest, progress, log, pause_evt, cancel_evt) -> None:
    store = ProjectStore.default()
    clips, clip_vecs, emb_meta = _load_index(store, req.project_id)
    clips, clip_vecs = _filter_blocked(clips, clip_vecs, log)

    if not os.path.isfile(req.voice_audio_path):
        raise RuntimeError(f"Voice audio not found: {req.voice_audio_path}")
    if req.bgm_audio_path and not os.path.isfile(req.bgm_audio_path):
        raise RuntimeError(f"BGM not found: {req.bgm_audio_path}")
    if os.path.isfile(req.output_path):
        raise RuntimeError(f"Output already exists (refusing to overwrite): {req.output_path}")

    bins = find_ffmpeg()
    out_dir = os.path.dirname(os.path.abspath(req.output_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    # Render settings (defaults can be overridden by UI request).
    st = load_settings()
    timeline_mode = str(getattr(st.render, "timeline_mode", "edgetts") or "edgetts").strip().lower()
    if timeline_mode != "edgetts":
        raise RuntimeError(
            f"目前仅支持 timeline_mode=edgetts（使用 EdgeTTS 元数据 JSON 驱动时间轴）。当前：{timeline_mode}"
        )
    keep_speed = True
    emphasis_enable = bool(req.emphasis_enable)
    out_fps = int(getattr(st.render, "output_fps", 25) or 25)
    out_fps = max(10, min(60, out_fps))

    # Merge emphasis phrases: settings.json + UI (inline markup comes from req.script_text parsing below).
    global_emph = list(st.render.emphasis_phrases or [])
    ui_emph = [s.strip() for s in (req.emphasis_phrases or ()) if str(s).strip()]
    extra_emph = global_emph + ui_emph

    voice_dur = _probe_duration(bins.ffprobe, req.voice_audio_path)

    script_lines: list[str] = []
    emph_per_line: list[list[str]] = []
    tags_per_line: list[list[str]] = []
    line_times: list[tuple[float, float]] = []
    target_durs: list[float] = []

    meta_path = (str(req.tts_meta_path).strip() if req.tts_meta_path else "").strip()
    if not meta_path:
        meta_path = os.path.splitext(os.path.abspath(req.voice_audio_path))[0] + ".json"
    log(f"EdgeTTS meta: {meta_path}")
    if not os.path.isfile(meta_path):
        raise RuntimeError(
            "timeline_mode=edgetts 需要 EdgeTTS 元数据 JSON（WordBoundary/SentenceBoundary）。"
            f" 未找到：{meta_path}"
        )
    words, _sents = load_edgetts_meta(meta_path)
    if not words:
        raise RuntimeError("EdgeTTS 元数据里没有 WordBoundary（无法对齐时间轴）。")
    meta_dur = float(words[-1].end)
    # EdgeTTS JSON often excludes encoder delay / trailing silence; small tail differences are normal and safe.
    # We only fail when JSON claims speech beyond the audio, or when the delta is huge.
    dur_delta = float(meta_dur) - float(voice_dur)
    if dur_delta > 0.50:
        raise RuntimeError(
            f"JSON 时长({meta_dur:.2f}s) 比音频时长({float(voice_dur):.2f}s)还长："
            "很可能选错了 JSON 或音频不是同一次 TTS 生成，已停止渲染以避免不同步。"
        )
    if abs(dur_delta) > 5.0:
        raise RuntimeError(
            f"JSON 时长({meta_dur:.2f}s) 与音频时长({float(voice_dur):.2f}s)差异过大："
            "很可能选错了 JSON 或音频不是同一次 TTS 生成，已停止渲染以避免不同步。"
        )
    if abs(dur_delta) > 0.80:
        log(
            f"WARNING: JSON 时长({meta_dur:.2f}s) 与音频时长({float(voice_dur):.2f}s)有差异（{dur_delta:+.2f}s），"
            "通常是编码延迟/尾部静音；将按音频时长收尾。"
        )

    raw_lines = _split_script(req.script_text)
    if not raw_lines:
        raise RuntimeError("Script is empty.")
    for ln in raw_lines:
        clean, emph, tags = _parse_line_markup(ln)
        if clean:
            script_lines.append(clean)
            emph_per_line.append(emph)
            tags_per_line.append(tags)
    if not script_lines:
        raise RuntimeError("Script is empty.")

    # Align strictly using WordBoundary, then clamp end to the probed audio duration.
    line_times = align_script_parts_to_words(words, script_lines, total_dur=float(voice_dur))
    if len(line_times) != len(script_lines):
        raise RuntimeError(f"EdgeTTS 对齐失败：lines={len(script_lines)} times={len(line_times)}")
    # Snap to FPS grid to avoid cumulative drift of cut points.
    line_times, frames_per_line = _snap_line_times_to_fps(line_times, fps=out_fps, total_dur=float(voice_dur))
    if len(line_times) != len(script_lines) or len(frames_per_line) != len(script_lines):
        raise RuntimeError("Line time snapping failed (size mismatch).")
    target_durs = [max(0.05, float(en) - float(stt)) for (stt, en) in line_times]
    log(f"Voice duration: {voice_dur:.2f}s, script units: {len(script_lines)} (edgetts)")

    wait_if_paused(pause_evt, cancel_evt)
    check_cancel(cancel_evt)
    progress(10, "Matching scenes...")

    # Build per-script-line hints (used after mapping).
    per_line_hints = [
        _extract_hints(script_lines[i], emph=emph_per_line[i], tags=tags_per_line[i], extra=extra_emph)
        for i in range(len(script_lines))
    ]

    # Project hint helps disambiguate and also matches our caption format ("作品:...").
    try:
        project_name = str((store.get_project_meta(req.project_id) or {}).get("name") or "").strip()
    except Exception:
        project_name = ""

    # Visual matching (edgetts only).
    # Query text for embedding can include project hint, but subtitle text stays clean.
    unit_hints = [list(hs) for hs in per_line_hints]
    if project_name:
        for hs in unit_hints:
            if project_name not in hs:
                hs.append(project_name)
    unit_queries: list[str] = []
    for i in range(len(script_lines)):
        q = script_lines[i]
        if project_name:
            q = f"作品:{project_name}；{q}"
        hs = unit_hints[i] if i < len(unit_hints) else []
        # Add a small amount of hint text into the embedding query (improves recall on metaphors).
        if hs:
            q = q + "；关键词:" + " ".join(str(x) for x in hs[:6] if str(x).strip())
        unit_queries.append(q)

    segments = _pick_visual_segments_edgetts(
        unit_texts=script_lines,
        unit_queries=unit_queries,
        unit_hints=unit_hints,
        unit_times=line_times,
        clips=clips,
        clip_vecs=clip_vecs,
        emb_meta=emb_meta,
        dedup_window_sec=req.dedup_window_sec,
        keyword_boost=float(st.render.match_keyword_boost),
        subtitle_heavy_penalty=float(getattr(st.render, "match_penalty_subtitle_heavy", 0.06) or 0.06),
        log=log,
    )
    log(f"Subtitle units: {len(script_lines)}, visual segments: {len(segments)} (edgetts)")

    jobs_dir = store.project_jobs_dir(req.project_id)
    os.makedirs(jobs_dir, exist_ok=True)
    job_id = f"render_{int(time.time())}"
    job_dir = os.path.join(jobs_dir, job_id)
    os.makedirs(job_dir, exist_ok=True)

    edl_path = os.path.join(job_dir, "edl.json")
    # Keep both subtitle units (timing/text) and visuals (selected segments) for debugging.
    edl = {
        "created_at": time.time(),
        "timeline_mode": timeline_mode,
        "project_name": project_name,
        "lines": [
            {"i": i, "start": float(line_times[i][0]), "end": float(line_times[i][1]), "text": script_lines[i]}
            for i in range(min(len(script_lines), len(line_times)))
        ],
    }
    edl["segments"] = list(segments)
    atomic_write_json(edl_path, edl)

    progress(30, "Generating subtitles...")
    ass_path = os.path.join(job_dir, "subtitles.ass")
    events = []
    # Subtitles use the script text (your use-case: audio is generated from the script).
    for i in range(min(len(script_lines), len(line_times))):
        stt = float(line_times[i][0])
        ent = float(line_times[i][1])
        txt = _subtitle_display_text(script_lines[i])
        if txt:
            events.append({"start": stt, "end": ent, "text": txt, "emphasis": []})

    out_w = int(req.output_width)
    out_h = int(req.output_height)
    # Subtitle style (settings.json); default tuned for 16:9.
    font_size = int(round(out_h * float(st.render.subtitles_font_size_vh) / 100.0))
    margin_v = int(round(out_h * float(st.render.subtitles_margin_bottom_vh) / 100.0))
    safe_lr = int(round(out_w * float(st.render.subtitles_safe_lr_vw) / 100.0))
    # Hard rule for your workflow: 1-line subtitles; do NOT auto-wrap or ellipsis.
    max_chars = 10_000
    write_simple_ass(
        ass_path,
        events,
        play_res_x=out_w,
        play_res_y=out_h,
        font_name=str(st.render.subtitles_font_name),
        font_size=font_size,
        margin_v=margin_v,
        margin_l=safe_lr,
        margin_r=safe_lr,
        shadow_alpha=float(st.render.subtitles_shadow_alpha),
        shadow_blur=float(st.render.subtitles_shadow_blur),
        shadow_x=int(st.render.subtitles_shadow_x),
        shadow_y=int(st.render.subtitles_shadow_y),
        max_chars_per_line=max_chars,
        max_lines=1,
        emphasis_enable=emphasis_enable,
        emphasis_max_per_line=int(st.render.emphasis_max_per_line),
        emphasis_popup_sec=float(st.render.emphasis_popup_sec),
    )

    wait_if_paused(pause_evt, cancel_evt)
    check_cancel(cancel_evt)
    progress(50, "Rendering segments...")

    seg_dir = os.path.join(job_dir, "segments")
    os.makedirs(seg_dir, exist_ok=True)
    seg_paths: list[str] = []

    # Render inputs: one visual segment per narration unit (no padding/no speed change).
    render_items = []
    for i, item in enumerate(segments):
        clip_len = max(1e-3, float(item["out"]) - float(item["in"]))
        nframes = int(frames_per_line[i]) if i < len(frames_per_line) else int(round(clip_len * out_fps))
        render_items.append(
            {
                "source": str(item["source"]),
                "in": float(item["in"]),
                "clip_len": float(clip_len),
                # Ensure _render_segment never pads in edgetts mode.
                "target_dur": float(clip_len),
                "nframes": int(max(1, nframes)),
            }
        )
    nseg = len(render_items)

    for i, item in enumerate(render_items):
        wait_if_paused(pause_evt, cancel_evt)
        check_cancel(cancel_evt)

        out_ts = os.path.join(seg_dir, f"seg_{i:05d}.ts")
        _render_segment(
            bins.ffmpeg,
            src=item["source"],
            in_t=float(item["in"]),
            nframes=int(item["nframes"]),
            out_fps=int(out_fps),
            out_w=out_w,
            out_h=out_h,
            out_ts=out_ts,
            log=log,
        )
        seg_paths.append(out_ts)
        progress(50 + int((i + 1) / max(1, nseg) * 30), f"Rendered segment {i+1}/{nseg}")

    wait_if_paused(pause_evt, cancel_evt)
    check_cancel(cancel_evt)
    progress(82, "Concatenating...")

    concat_list = os.path.join(job_dir, "concat.txt")
    with open(concat_list, "w", encoding="utf-8") as f:
        for p in seg_paths:
            p2 = p.replace("\\", "/")
            f.write("file '{}'\n".format(p2))

    joined_ts = os.path.join(job_dir, "joined.ts")
    run_cmd(
        [bins.ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concat_list, "-c", "copy", joined_ts],
        log_fn=log,
    )

    wait_if_paused(pause_evt, cancel_evt)
    check_cancel(cancel_evt)
    progress(90, "Final mux (audio + subtitles)...")

    vf_final = (
        "[0:v]setsar=1[v0];"
        f"[v0]subtitles='{_ffmpeg_escape_path(ass_path)}'[vout]"
    )

    args = [bins.ffmpeg, "-y", "-i", joined_ts, "-i", req.voice_audio_path]
    if req.bgm_audio_path:
        args += ["-stream_loop", "-1", "-i", req.bgm_audio_path]

    if req.bgm_audio_path:
        bgm_vol = float(getattr(st.render, "bgm_volume", 0.12) or 0.12)
        bgm_vol = max(0.0, min(1.0, bgm_vol))
        af = (
            "[1:a]aresample=44100[a1];"
            f"[2:a]volume={bgm_vol:.3f},aresample=44100[a2];"
            "[a1][a2]amix=inputs=2:duration=first:dropout_transition=2[aout]"
        )
        args += ["-filter_complex", vf_final + ";" + af, "-map", "[vout]", "-map", "[aout]"]
    else:
        args += ["-filter_complex", vf_final, "-map", "[vout]", "-map", "1:a"]

    args += [
        # Clamp final output to narration length (avoids accidental truncation of audio/video).
        "-t",
        f"{float(voice_dur):.3f}",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        req.output_path,
    ]
    run_cmd(args, log_fn=log)

    progress(100, "Render complete")
