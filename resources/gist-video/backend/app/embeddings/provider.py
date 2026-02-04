from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.core.settings import EmbeddingSettings, load_settings
from app.embeddings.local_hash_embed import LocalHashEmbedding


class EmbeddingProvider:
    def embed_texts(self, texts: list[str]) -> np.ndarray:
        raise NotImplementedError


@dataclass(frozen=True)
class LocalHashEmbeddingProvider(EmbeddingProvider):
    dim: int = 512

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        return LocalHashEmbedding(dim=self.dim).embed_texts(texts)


def get_embedding_provider() -> EmbeddingProvider:
    st = load_settings().embedding
    backend = (st.backend or "auto").lower().strip()

    if backend in ("local_hash", "hash"):
        return LocalHashEmbeddingProvider()

    if backend in ("onnx_m3e", "onnx"):
        from app.embeddings.onnx_m3e import OnnxM3EEmbeddingProvider

        # NOTE: class doesn't inherit EmbeddingProvider to avoid import cycles; it still implements embed_texts().
        return OnnxM3EEmbeddingProvider(model_id=st.model_id)  # type: ignore[return-value]

    # auto
    from app.embeddings.onnx_m3e import OnnxM3EEmbeddingProvider, can_resolve_onnx_model

    # Prefer ONNX whenever a local ONNX model can be resolved.
    mid = str(st.model_id or "").strip()
    if mid and can_resolve_onnx_model(mid):
        return OnnxM3EEmbeddingProvider(model_id=mid)  # type: ignore[return-value]

    # Backward-compatible fallback: if user still has an old model_id, use the default bundled ONNX if present.
    default_mid = str(EmbeddingSettings().model_id or "").strip()
    if default_mid and can_resolve_onnx_model(default_mid):
        return OnnxM3EEmbeddingProvider(model_id=default_mid)  # type: ignore[return-value]

    # Fallback: lightweight local hashing (no heavy deps).
    return LocalHashEmbeddingProvider()

