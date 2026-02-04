from __future__ import annotations

from dataclasses import dataclass

from app.core.settings import load_settings


class VisionCaptionProvider:
    def caption_image_paths(self, image_paths: list[str]) -> list[str]:
        raise NotImplementedError

    def cache_key(self) -> str:
        # Used for invalidating frame caption cache when backend/prompt/model changes.
        return type(self).__name__


@dataclass
class NullCaptionProvider(VisionCaptionProvider):
    def caption_image_paths(self, image_paths: list[str]) -> list[str]:
        return ["" for _ in image_paths]


def get_caption_provider() -> VisionCaptionProvider:
    st = load_settings().vision
    backend = (st.backend or "auto").lower().strip()

    if backend in ("none", "null"):
        return NullCaptionProvider()

    if backend in ("gemini_proxy", "relay", "openai_vision"):
        from app.vision.gemini_proxy import GeminiRelayCaptionProvider

        return GeminiRelayCaptionProvider(
            api_base=st.api_base,
            api_key=st.api_key,
            model=st.vision_model,
        )

    # The legacy ModelScope caption backend has been removed to keep the project lightweight.
    # Keep a clear error for users who still have old settings.json values.
    if backend in ("modelscope_caption", "modelscope"):
        raise RuntimeError(
            "已移除 ModelScope 图生文后端。请在 data/settings.json 或 UI 中将 vision.backend 改为：\n"
            "- gemini_proxy（推荐）\n"
            "- auto（已配置 api_base/api_key/vision_model 时等价于 gemini_proxy；否则为 null）\n"
            "- null（关闭图生文）"
        )

    # auto
    if (st.api_base or "").strip() and (st.api_key or "").strip() and (st.vision_model or "").strip():
        from app.vision.gemini_proxy import GeminiRelayCaptionProvider

        return GeminiRelayCaptionProvider(
            api_base=st.api_base,
            api_key=st.api_key,
            model=st.vision_model,
        )
    return NullCaptionProvider()
