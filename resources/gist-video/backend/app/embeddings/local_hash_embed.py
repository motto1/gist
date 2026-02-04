from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np


def _tokenize_char_ngrams(text: str, n: int) -> list[str]:
    s = "".join(ch for ch in text.strip() if not ch.isspace())
    if len(s) <= n:
        return [s] if s else []
    return [s[i : i + n] for i in range(0, len(s) - n + 1)]


def _stable_bucket(token: str, dim: int) -> int:
    h = hashlib.md5(token.encode("utf-8")).digest()
    x = int.from_bytes(h[:4], "little", signed=False)
    return x % dim


@dataclass(frozen=True)
class LocalHashEmbedding:
    dim: int = 512

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        # Offline embedding: hashing vectorizer with char 2-gram + 3-gram.
        vecs = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            grams = _tokenize_char_ngrams(t, 2) + _tokenize_char_ngrams(t, 3)
            if not grams:
                continue
            for g in grams:
                vecs[i, _stable_bucket(g, self.dim)] += 1.0
            norm = float(np.linalg.norm(vecs[i]))
            if norm > 1e-8:
                vecs[i] /= norm
        return vecs


def cosine_sim_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    # Assumes vectors are L2-normalized.
    if a.size == 0 or b.size == 0:
        return np.zeros((a.shape[0], b.shape[0]), dtype=np.float32)
    return a @ b.T

