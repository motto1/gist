from __future__ import annotations

import base64
import json
import random
import time
from dataclasses import dataclass


_PROMPT_VERSION = 4


def _normalize_api_base(api_base: str) -> str:
    b = (api_base or "").strip().rstrip("/")
    if not b:
        return b
    # Most relays are OpenAI-compatible and expect /v1.
    if b.endswith("/v1"):
        return b
    return b + "/v1"


def _extract_json_text(s: str) -> dict:
    """
    The relay may wrap JSON in markdown fences; try to pull the first JSON object.
    """
    s = (s or "").strip()
    if not s:
        return {}
    if "```" in s:
        # take the largest fenced block
        parts = s.split("```")
        s = max((p.strip() for p in parts if p.strip()), key=len, default=s)
        if s.lower().startswith("json"):
            s = s[4:].strip()
    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        s = s[start : end + 1]
    return json.loads(s)


def _as_list(v: object) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        # allow comma/space separated
        parts = [p.strip() for p in s.replace("，", ",").split(",")]
        return [p for p in parts if p]
    return [str(v).strip()]


def _format_caption_item(item: dict) -> str:
    summary = "、".join(_as_list(item.get("summary")))
    title = "、".join(_as_list(item.get("title")))
    chars = _as_list(item.get("characters"))
    who = "、".join(_as_list(item.get("who")))
    action = "、".join(_as_list(item.get("action")))
    scene = "、".join(_as_list(item.get("scene")))
    objects = "、".join(_as_list(item.get("objects")))
    mood = "、".join(_as_list(item.get("mood")))
    shot = "、".join(_as_list(item.get("shot")))
    tags = _as_list(item.get("tags"))
    flags = [f.lower() for f in _as_list(item.get("flags"))]

    # Caption part is used for embedding; FLAGS is used for filtering only.
    parts = []
    if title:
        parts.append(f"作品:{title}")
    if chars:
        parts.append("角色:" + "、".join(chars[:8]))
    if summary:
        parts.append(f"概述:{summary}")
    if who:
        parts.append(f"人物:{who}")
    if action:
        parts.append(f"动作:{action}")
    if scene:
        parts.append(f"场景:{scene}")
    if objects:
        parts.append(f"物体:{objects}")
    if mood:
        parts.append(f"情绪:{mood}")
    if shot:
        parts.append(f"镜头:{shot}")
    if tags:
        parts.append("标签:" + "、".join(tags[:18]))
    cap = "；".join(parts).strip()
    flag_str = ",".join(sorted(set([f for f in flags if f])))
    if flag_str:
        return f"{cap} FLAGS:{flag_str}"
    return cap


@dataclass
class GeminiRelayCaptionProvider:
    api_base: str
    api_key: str
    model: str
    timeout_sec: int = 90
    max_retries: int = 5
    backoff_base_sec: float = 0.8
    project_hint: str = ""

    def cache_key(self) -> str:
        # Changing this will trigger re-captioning via index_job caption cache key.
        hint = (self.project_hint or "").strip()
        # Keep it stable for cache keys (avoid huge strings).
        hint = hint[:80]
        return f"gemini_relay|model={self.model}|prompt_v={_PROMPT_VERSION}|hint={hint}"

    def set_project_hint(self, hint: str) -> None:
        self.project_hint = str(hint or "").strip()

    def caption_image_groups(self, groups: list[list[str]]) -> list[str]:
        """
        Caption multiple clips per request. Each clip can contain multiple frames.
        Returns one caption string per clip (we write it back to all frames for caching).
        """
        try:
            import requests  # type: ignore
        except ModuleNotFoundError as e:
            raise RuntimeError("缺少依赖：requests。请先 pip install requests") from e

        if not groups:
            return []
        api_base = _normalize_api_base(self.api_base)
        if not api_base:
            raise RuntimeError("API地址未配置（vision.api_base）。")
        if not (self.api_key or "").strip():
            raise RuntimeError("API密钥未配置（vision.api_key）。")
        if not (self.model or "").strip():
            raise RuntimeError("Vision模型未配置（vision.vision_model）。")

        content: list[dict] = []
        for i, paths in enumerate(groups):
            content.append({"type": "text", "text": f"CLIP {i}"})
            for p in (paths or []):
                with open(p, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode("ascii")
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

        hint = (self.project_hint or "").strip()
        hint_line = f"本项目作品/IP 提示：{hint}\\n" if hint else ""
        system_prompt = (
            "你是短视频剪辑助手（偏动漫/影视解说）。你将看到多个切片，每个切片包含多帧截图。\\n"
            f"{hint_line}"
            "任务：为【每一个切片】输出可检索、可复用、可匹配的结构化标签（用于后续语义匹配剪辑）。\\n"
            "输入说明：每个切片开始会有一行 'CLIP i'，后面跟随该切片的若干帧图片。\\n"
            "输出要求：只输出严格 JSON（不要 markdown/解释/多余文字）。\\n"
            "JSON 的 key 为切片序号 0..K-1。每个 value 为对象，字段与单图相同：summary/title/characters/who/action/scene/objects/mood/shot/tags/flags。\\n"
            "注意：tags 必须包含可稳定检索的道具/动作词（如：枪、血、翻书、笔记、醒来）。\\n"
        )
        user_prompt = "请按要求输出JSON。"

        body = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [{"type": "text", "text": user_prompt}] + content},
            ],
        }

        url = api_base + "/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        last_err: Exception | None = None
        for attempt in range(int(self.max_retries)):
            try:
                r = requests.post(url, headers=headers, json=body, timeout=(10, self.timeout_sec))
                if r.status_code in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"Vision API临时错误 {r.status_code}: {r.text[:200]}")
                if r.status_code >= 400:
                    raise RuntimeError(f"Vision API错误 {r.status_code}: {r.text[:500]}")
                data = r.json()
                last_err = None
                break
            except Exception as e:
                last_err = e
                if attempt + 1 >= int(self.max_retries):
                    break
                sleep_s = float(self.backoff_base_sec) * (2**attempt) + random.uniform(0.0, 0.25)
                time.sleep(min(10.0, sleep_s))

        if last_err is not None:
            raise RuntimeError(
                "Vision API请求失败（多次重试仍失败）。"
                "如果你开启了较高并发，请在“API设置”里把并发线程数/最大排队请求调小。"
                f"\n原始错误：{last_err}"
            ) from last_err

        try:
            text = data["choices"][0]["message"]["content"]
        except Exception:
            raise RuntimeError(f"Vision API返回格式异常: {str(data)[:500]}")

        obj = _extract_json_text(text)
        out: list[str] = []
        for i in range(len(groups)):
            item = obj.get(str(i)) or obj.get(i) or {}
            if isinstance(item, dict):
                out.append(_format_caption_item(item))
            else:
                out.append(str(item or "").strip())
        return out

    def caption_image_paths(self, image_paths: list[str]) -> list[str]:
        try:
            import requests  # type: ignore
        except ModuleNotFoundError as e:
            raise RuntimeError("缺少依赖：requests。请先 pip install requests") from e

        if not image_paths:
            return []
        api_base = _normalize_api_base(self.api_base)
        if not api_base:
            raise RuntimeError("API地址未配置（vision.api_base）。")
        if not (self.api_key or "").strip():
            raise RuntimeError("API密钥未配置（vision.api_key）。")
        if not (self.model or "").strip():
            raise RuntimeError("Vision模型未配置（vision.vision_model）。")

        images = []
        for p in image_paths:
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            images.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

        hint = (self.project_hint or "").strip()
        hint_line = f"本项目作品/IP 提示：{hint}\\n" if hint else ""
        system_prompt = (
            # This method may be used with batched images; do NOT assume adjacency implies same clip.
            "你是短视频剪辑助手（偏动漫/影视解说）。你将看到一批截图：每张图独立分析（不要假设相邻图片属于同一切片）。\\n"
            f"{hint_line}"
            "任务：为【每一张图】输出可检索、可复用、可匹配的结构化标签（用于后续语义匹配剪辑）。\\n"
            "输出要求：只输出严格 JSON（不要 markdown/解释/多余文字）。\\n"
            "JSON 的 key 为图片序号 0..N-1。每张图的 value 为对象，字段如下：\\n"
            "1) summary: 一句话客观描述（不写剧情推断，只写你看到的画面）\\n"
            "2) title: 作品名/IP（如果能识别就写；不确定可空。单一作品项目允许你大胆猜）\\n"
            "3) characters: 角色名列表（如果能识别就写；不确定可空。单一作品项目允许你大胆猜）\\n"
            "4) who: 人物类型/数量（不要猜具体人名，可写 男主/女主/少年/少女/怪物/路人/群像 等）\\n"
            "5) action: 动作/事件（动词短语，尽量具体，如 醒来/受伤/流血/拿枪/开枪/翻书/翻笔记/对话/追逐/打斗）\\n"
            "6) scene: 场景地点/环境（室内/室外 + 具体地点，如 房间/桌边/街道/森林/战场/宫殿）\\n"
            "7) objects: 关键物体/道具（手枪/左轮/血迹/书/笔记/纸张/信封/钥匙/徽章 等）\\n"
            "8) mood: 情绪氛围（紧张/压抑/恐惧/震撼/温馨/搞笑 等）\\n"
            "9) shot: 镜头语言（特写/中景/远景/俯视/仰视/跟拍/对话镜头/大场景/快切）\\n"
            "10) tags: 12-18 个【可复用检索词】（只要词/短语，不要句子；避免同义堆砌；覆盖 人物/动作/冲突/情绪/地点/道具/镜头）\\n"
            "11) flags: 需要过滤或降权的标记（数组，可包含：ad/intro/outro/credit/subtitle_heavy/ui_overlay/watermark/logo/qr_code）\\n"
            "   - subtitle_heavy: 大量字幕或文字占屏\\n"
            "   - ui_overlay: 进度条/弹幕/界面按钮等明显 UI\\n"
            "   - watermark/logo/qr_code: 水印/台标/二维码明显\\n"
            "注意：tags 一定要包含能稳定检索的道具/动作词（例如：枪、血、翻书、笔记、醒来）。\\n"
        )
        user_prompt = "请按要求输出JSON。"

        body = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [{"type": "text", "text": user_prompt}] + images},
            ],
        }

        url = api_base + "/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        last_err: Exception | None = None
        for attempt in range(int(self.max_retries)):
            try:
                # Use separate connect/read timeouts; SSL EOF often benefits from retry.
                r = requests.post(url, headers=headers, json=body, timeout=(10, self.timeout_sec))
                if r.status_code in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"Vision API临时错误 {r.status_code}: {r.text[:200]}")
                if r.status_code >= 400:
                    raise RuntimeError(f"Vision API错误 {r.status_code}: {r.text[:500]}")
                data = r.json()
                last_err = None
                break
            except Exception as e:
                last_err = e
                # backoff with jitter
                if attempt + 1 >= int(self.max_retries):
                    break
                sleep_s = float(self.backoff_base_sec) * (2**attempt) + random.uniform(0.0, 0.25)
                time.sleep(min(10.0, sleep_s))

        if last_err is not None:
            raise RuntimeError(
                "Vision API请求失败（多次重试仍失败）。"
                "如果你开启了较高并发，请在“API设置”里把并发线程数/最大排队请求调小。"
                f"\n原始错误：{last_err}"
            ) from last_err

        try:
            text = data["choices"][0]["message"]["content"]
        except Exception:
            raise RuntimeError(f"Vision API返回格式异常: {str(data)[:500]}")

        obj = _extract_json_text(text)
        out: list[str] = []
        for i in range(len(image_paths)):
            item = obj.get(str(i)) or obj.get(i) or {}
            if isinstance(item, dict):
                out.append(_format_caption_item(item))
            else:
                out.append(str(item or "").strip())
        return out
