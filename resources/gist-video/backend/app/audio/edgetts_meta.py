from __future__ import annotations

import json
import os
import re
from bisect import bisect_left
from dataclasses import dataclass


TICKS_PER_SEC = 10_000_000.0  # EdgeTTS uses 100ns ticks


def ticks_to_sec(ticks: int | float) -> float:
    return float(ticks) / TICKS_PER_SEC


_PUNCT = set("，。！？；：、,.!?;:…")
_SPACE_RE = re.compile(r"\s+")


def _visible_len_zh(s: str) -> int:
    """
    Count "subtitle-visible" characters. Ignore whitespace and most punctuation so the 12-char rule
    matches what users feel on screen.
    """
    s = _SPACE_RE.sub("", str(s or ""))
    n = 0
    for ch in s:
        if ch in _PUNCT:
            continue
        # CJK, letters, digits
        if ("\u4e00" <= ch <= "\u9fff") or ("A" <= ch <= "Z") or ("a" <= ch <= "z") or ("0" <= ch <= "9"):
            n += 1
        else:
            # Count other visible symbols conservatively.
            n += 1
    return int(n)


def visible_len_zh(s: str) -> int:
    return _visible_len_zh(s)


def split_one_line(text: str, *, max_chars: int) -> list[str]:
    """
    Split text into 1-line subtitle chunks, each <= max_chars (visible chars).
    Prefer punctuation boundaries; hard cut only as a last resort.
    """
    s = _SPACE_RE.sub("", str(text or "").strip())
    if not s:
        return []

    max_chars = int(max(1, max_chars))
    out: list[str] = []
    cur = ""
    cur_n = 0
    last_punct_pos = -1
    last_punct_n = 0

    def flush_at(pos: int) -> None:
        nonlocal cur, cur_n, last_punct_pos, last_punct_n
        if pos <= 0:
            return
        out.append(cur[:pos])
        rest = cur[pos:]
        cur = rest
        cur_n = _visible_len_zh(cur)
        # Recompute punct info for the remaining buffer.
        last_punct_pos = -1
        last_punct_n = 0
        tmp_n = 0
        for i, ch in enumerate(cur):
            if ch in _PUNCT:
                last_punct_pos = i + 1
                last_punct_n = tmp_n
            else:
                tmp_n += 1

    for ch in s:
        cur += ch
        if ch in _PUNCT:
            last_punct_pos = len(cur)
            last_punct_n = cur_n
        else:
            cur_n += 1
        if cur_n <= max_chars:
            continue

        # Prefer flushing at last punctuation if it keeps the chunk reasonably sized.
        if last_punct_pos > 0 and last_punct_n >= max(4, max_chars // 2):
            flush_at(last_punct_pos)
            continue

        # Hard cut: flush right before adding this char would exceed.
        # Find a cut position that keeps <= max_chars visible chars.
        tmp_n = 0
        cut = 0
        for i, c2 in enumerate(cur):
            if c2 in _PUNCT:
                pass
            else:
                tmp_n += 1
            if tmp_n > max_chars:
                cut = i
                break
        if cut <= 0:
            cut = max(1, len(cur) - 1)
        flush_at(cut)

    if cur.strip():
        out.append(cur)
    return [x for x in out if x and x.strip()]


@dataclass(frozen=True)
class WordItem:
    text: str
    start: float
    end: float

    @property
    def dur(self) -> float:
        return float(max(0.0, self.end - self.start))

    @property
    def weight(self) -> int:
        return max(1, _visible_len_zh(self.text))


@dataclass(frozen=True)
class SentenceItem:
    text: str
    start: float
    end: float

    @property
    def dur(self) -> float:
        return float(max(0.0, self.end - self.start))


def load_edgetts_meta(path: str) -> tuple[list[WordItem], list[SentenceItem]]:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    meta = raw.get("Metadata") if isinstance(raw, dict) else None
    if not isinstance(meta, list):
        raise RuntimeError("EdgeTTS meta JSON missing 'Metadata' list.")

    words: list[WordItem] = []
    sents: list[SentenceItem] = []
    for it in meta:
        if not isinstance(it, dict):
            continue
        t = str(it.get("Type") or "").strip()
        d = it.get("Data") or {}
        if not isinstance(d, dict):
            continue
        off = d.get("Offset")
        dur = d.get("Duration")
        txt = (d.get("text") or {}).get("Text") if isinstance(d.get("text"), dict) else None
        if off is None or dur is None or txt is None:
            continue
        try:
            st = ticks_to_sec(int(off))
            en = st + ticks_to_sec(int(dur))
        except Exception:
            continue
        txt2 = str(txt).strip()
        if not txt2:
            continue
        if t == "WordBoundary":
            words.append(WordItem(text=txt2, start=st, end=en))
        elif t == "SentenceBoundary":
            sents.append(SentenceItem(text=txt2, start=st, end=en))

    words.sort(key=lambda w: (w.start, w.end))
    sents.sort(key=lambda s: (s.start, s.end))
    return words, sents


def _partition_words_by_part_weights(words: list[WordItem], part_weights: list[int], *, total_dur: float) -> list[tuple[int, int]]:
    """
    Partition words into len(part_weights) groups (contiguous), minimizing mismatch to expected durations.
    Returns list of (a,b) word index ranges.
    """
    n = len(words)
    k = len(part_weights)
    if k <= 0:
        return []
    if n <= 0:
        return []
    if k >= n:
        return [(i, i + 1) for i in range(n)]

    ws = [max(1, int(w)) for w in part_weights]
    sw = float(sum(ws)) or 1.0
    exp = [float(total_dur) * (float(w) / sw) for w in ws]

    # DP over word boundaries. dp[j] = best score ending at word j.
    neg = -1e18
    dp = [neg] * (n + 1)
    bp: list[list[int]] = [[-1] * (n + 1) for _ in range(k + 1)]
    dp[0] = 0.0
    bp[0][0] = 0

    # Precompute start/end arrays for fast dur.
    st = [w.start for w in words]
    en = [w.end for w in words]

    for i in range(1, k + 1):
        ndp = [neg] * (n + 1)
        ed = max(0.25, exp[i - 1])
        for j in range(i, n + 1):
            best = neg
            best_a = -1
            # limit group size to keep it reasonable
            for a in range(i - 1, j):
                if dp[a] <= neg / 2:
                    continue
                dur = float(en[j - 1] - st[a])
                if dur <= 0:
                    continue
                dur_pen = abs(dur - ed) / ed
                # small penalty for making too many tiny groups
                score = -0.75 * dur_pen
                val = dp[a] + score
                if val > best:
                    best = val
                    best_a = a
            if best_a >= 0:
                ndp[j] = best
                bp[i][j] = best_a
        dp = ndp

    j = n
    if bp[k][j] < 0:
        # fallback: greedy by weights
        out = []
        a = 0
        for i in range(k - 1):
            target = (n - a) * (ws[i] / float(sum(ws[i:])))  # word-count proxy
            take = max(1, int(round(target)))
            b = min(n - (k - i - 1), a + take)
            out.append((a, b))
            a = b
        out.append((a, n))
        return out

    bounds = [0] * (k + 1)
    bounds[k] = j
    for i in range(k, 0, -1):
        a = bp[i][j]
        if a < 0:
            break
        bounds[i - 1] = a
        j = a

    out: list[tuple[int, int]] = []
    for i in range(k):
        out.append((bounds[i], bounds[i + 1]))
    return out


def build_units_from_meta(
    words: list[WordItem],
    sents: list[SentenceItem],
    *,
    max_sub_chars: int = 12,
) -> list[dict]:
    """
    Return units: [{text,start,end}, ...] suitable for both subtitle + visual matching.
    Uses SentenceBoundary as semantic container, then splits into <=max_sub_chars 1-line units.
    """
    max_sub_chars = int(max(1, max_sub_chars))
    if not sents:
        # Fallback: treat the whole thing as one sentence (then split).
        if not words:
            return []
        sents = [SentenceItem(text="".join(w.text for w in words), start=words[0].start, end=words[-1].end)]

    units: list[dict] = []
    wi = 0
    n_words = len(words)
    for s in sents:
        if s.end <= s.start + 1e-4:
            continue
        # Collect words within sentence time range.
        local: list[WordItem] = []
        while wi < n_words and words[wi].end <= s.start + 1e-4:
            wi += 1
        wj = wi
        while wj < n_words and words[wj].start < s.end - 1e-4:
            local.append(words[wj])
            wj += 1

        parts = split_one_line(s.text, max_chars=max_sub_chars)
        parts = [p.strip() for p in parts if p and p.strip()]
        if not parts:
            continue

        if not local:
            # No word boundaries found; fall back to sentence boundary times.
            per = max(0.05, (s.end - s.start) / float(len(parts)))
            t = float(s.start)
            for p in parts:
                units.append({"text": p, "start": t, "end": min(s.end, t + per)})
                t += per
            if units:
                units[-1]["end"] = float(s.end)
            continue

        # Ensure we don't create more parts than words; merge if needed.
        if len(parts) > len(local):
            merged: list[str] = []
            cur = ""
            for p in parts:
                if not cur:
                    cur = p
                elif _visible_len_zh(cur + p) <= max_sub_chars:
                    cur = cur + p
                else:
                    merged.append(cur)
                    cur = p
            if cur:
                merged.append(cur)
            parts = merged if len(merged) <= len(local) else parts[: len(local)]

        part_weights = [max(1, _visible_len_zh(p)) for p in parts]
        groups = _partition_words_by_part_weights(local, part_weights, total_dur=float(s.end - s.start))
        # Build units using exact word times (no drift).
        for p, (a, b) in zip(parts, groups):
            a = int(max(0, a))
            b = int(max(a + 1, b))
            b = min(len(local), b)
            st = float(local[a].start)
            en = float(local[b - 1].end)
            units.append({"text": p, "start": st, "end": en})

        wi = wj

    # Fix monotonicity + clamp.
    out: list[dict] = []
    prev = 0.0
    for u in units:
        st = float(u["start"])
        en = float(u["end"])
        st = max(prev, st)
        en = max(st + 0.02, en)
        out.append({"text": str(u["text"]), "start": st, "end": en})
        prev = en
    return out


def align_script_parts_to_words(
    words: list[WordItem],
    parts: list[str],
    *,
    total_dur: float | None = None,
    snap_window_words: int = 10,
    pause_ref_sec: float = 0.18,
    dist_pen: float = 0.06,
) -> list[tuple[float, float]]:
    """
    Align script parts (already split by punctuation) to EdgeTTS WordBoundary times.

    Assumptions:
    - Audio was generated from the same script (TTS), so order is identical.
    - We only need robust timestamps; text accuracy is provided by the script.

    STRICT strategy (no fallback):
    - Clean punctuation/whitespace from both the script parts and WordBoundary tokens.
    - Require an exact match of the cleaned full text.
    - Convert cumulative character positions to word indices to get exact per-part times.
    - Split gaps by midpoint so subtitle timing has no holes.
    """
    parts = [str(x).strip() for x in (parts or []) if str(x).strip()]
    if not parts:
        return []
    if not words:
        raise RuntimeError("EdgeTTS meta missing WordBoundary; cannot align.")

    def _clean_spoken(s: str) -> str:
        s = _SPACE_RE.sub("", str(s or ""))
        # Keep only "spoken" visible characters so script and WordBoundary match even if the script
        # contains quotes/marks that are not present in WordBoundary tokens.
        out: list[str] = []
        for ch in s:
            if ("\u4e00" <= ch <= "\u9fff") or ("A" <= ch <= "Z") or ("a" <= ch <= "z") or ("0" <= ch <= "9"):
                out.append(ch)
        return "".join(out)

    # Build cleaned word stream.
    word_tok: list[str] = []
    word_map: list[int] = []
    for i, w in enumerate(words):
        t = _clean_spoken(w.text)
        if t:
            word_tok.append(t)
            word_map.append(i)
    if not word_tok:
        raise RuntimeError("EdgeTTS WordBoundary tokens are empty after cleaning.")

    part_tok = [_clean_spoken(p) for p in parts]
    if any(not t for t in part_tok):
        raise RuntimeError("脚本分段里出现“只有标点/空白”的段，无法对齐。请检查文案是否有多余空行或独立标点。")

    whole_words = "".join(word_tok)
    whole_script = "".join(part_tok)
    if whole_script != whole_words:
        # Show first mismatch for debugging.
        m = 0
        mx = min(len(whole_script), len(whole_words))
        while m < mx and whole_script[m] == whole_words[m]:
            m += 1
        s_snip = whole_script[max(0, m - 20) : m + 40]
        w_snip = whole_words[max(0, m - 20) : m + 40]
        raise RuntimeError(
            "EdgeTTS 对齐失败：文案与 JSON 的 WordBoundary 文本不一致（可能选错 JSON 或文案不是生成该音频的原文）。"
            f" mismatch_at={m}, script_snip='{s_snip}', json_snip='{w_snip}'"
        )

    # Map cumulative character positions to token boundaries.
    cum_end: list[int] = []
    cur = 0
    for t in word_tok:
        cur += len(t)
        cum_end.append(cur)

    def _pos_to_tok_idx(char_pos: int) -> int:
        if char_pos <= 0:
            return 0
        j = bisect_left(cum_end, int(char_pos))
        return min(len(word_tok), int(j) + 1)

    bounds_tok: list[int] = [0]
    acc = 0
    for t in part_tok[:-1]:
        acc += len(t)
        bounds_tok.append(_pos_to_tok_idx(acc))
    bounds_tok.append(len(word_tok))

    # Convert token bounds -> word bounds (indices into `words` list).
    ranges: list[tuple[int, int]] = []
    for a_t, b_t in zip(bounds_tok, bounds_tok[1:]):
        a_t = int(max(0, min(len(word_map) - 1, a_t)))
        b_t = int(max(a_t + 1, min(len(word_map), b_t)))
        a_w = int(word_map[a_t])
        b_w = int(word_map[b_t - 1] + 1)
        ranges.append((a_w, b_w))

    starts = [float(words[a].start) for a, _b in ranges]
    ends = [float(words[b - 1].end) for _a, b in ranges]

    # Split gaps by midpoint (no holes).
    for i in range(len(starts) - 1):
        mid = 0.5 * (float(ends[i]) + float(starts[i + 1]))
        ends[i] = mid
        starts[i + 1] = mid

    if total_dur is not None and starts:
        starts[0] = 0.0
        ends[-1] = float(total_dur)

    out: list[tuple[float, float]] = []
    prev = 0.0
    for st, en in zip(starts, ends):
        st = max(prev, float(st))
        en = max(st + 0.02, float(en))
        out.append((st, en))
        prev = en
    return out
