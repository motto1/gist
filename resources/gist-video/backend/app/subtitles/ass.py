from __future__ import annotations

import os
import re


def _fmt_time(t: float) -> str:
    # ASS uses h:mm:ss.cc (centiseconds)
    if t < 0:
        t = 0.0
    cs = int(round(t * 100.0))
    s = cs // 100
    cc = cs % 100
    m = s // 60
    ss = s % 60
    h = m // 60
    mm = m % 60
    return f"{h}:{mm:02d}:{ss:02d}.{cc:02d}"


_PUNCT_RE = re.compile(r"[，,、。！？!?;；：:]")


def _wrap_text(text: str, *, max_chars_per_line: int = 22, max_lines: int = 1) -> str:
    """
    Subtitle wrapping for Chinese-heavy scripts:
    - Prefer breaking on punctuation (do not cut in the middle when possible)
    - If still too long, hard cut as a last resort (with ellipsis)
    """
    s = " ".join(text.strip().split())
    if not s:
        return ""

    if len(s) <= max_chars_per_line:
        return s

    # For 1-line mode, try to cut at the last punctuation before limit.
    if max_lines == 1:
        cut = -1
        for m in _PUNCT_RE.finditer(s):
            if m.start() < max_chars_per_line:
                cut = m.start() + 1
        if cut > 0:
            out = s[:cut].strip()
            return out[: max_chars_per_line - 1] + "…" if len(out) > max_chars_per_line else out
        return s[: max_chars_per_line - 1] + "…"

    # 2-line mode: prefer splitting on punctuation while balancing lengths.
    if max_lines >= 2:
        max_total = max_chars_per_line * 2
        s2 = s if len(s) <= max_total else (s[: max_total - 1] + "…")

        # Candidate breakpoints: punctuation (preferred), then spaces; always allow hard split.
        cand: list[int] = []
        for m in _PUNCT_RE.finditer(s2):
            cand.append(m.start() + 1)
        cand.extend([i for i, ch in enumerate(s2) if ch == " "])
        cand.append(max_chars_per_line)

        target = len(s2) // 2
        best_b: int | None = None
        best_score: tuple[int, int] | None = None
        for b in cand:
            if b <= 0 or b >= len(s2):
                continue
            left = s2[:b].strip()
            right = s2[b:].strip()
            if not left or not right:
                continue
            if len(left) > max_chars_per_line or len(right) > max_chars_per_line:
                continue
            # Avoid a "single char line" when possible.
            if len(left) < 2 or len(right) < 2:
                continue
            score = (abs(len(left) - target), abs(len(left) - len(right)))
            if best_score is None or score < best_score:
                best_score = score
                best_b = b

        if best_b is not None:
            return s2[:best_b].strip() + r"\N" + s2[best_b:].strip()

        # Fallback: hard split into 2 lines.
        left = s2[:max_chars_per_line].strip()
        right = s2[max_chars_per_line : max_chars_per_line * 2].strip()
        if len(s) > max_total:
            right = (right[:-1] + "…") if right else "…"
        return left + r"\N" + right

    # Multi-line fallback (>2): greedy slice.
    lines: list[str] = []
    i = 0
    while i < len(s) and len(lines) < max_lines:
        lines.append(s[i : i + max_chars_per_line])
        i += max_chars_per_line
    if i < len(s) and lines:
        lines[-1] = lines[-1][:-1] + "…"
    return r"\N".join(lines)


def _ass_safe_text(s: str) -> str:
    # Prevent accidental ASS tag injection via braces.
    return str(s).replace("{", "（").replace("}", "）").strip()


def write_simple_ass(
    path: str,
    events: list[dict],
    *,
    play_res_x: int = 1080,
    play_res_y: int = 1920,
    font_name: str = "MicrosoftYaHeiUI",
    font_size: int | None = None,
    margin_v: int | None = None,
    margin_l: int | None = None,
    margin_r: int | None = None,
    # Soft shadow (recommended vs hard outline).
    shadow_alpha: float = 0.5,
    shadow_blur: float = 3.0,
    shadow_x: int = 0,
    shadow_y: int = 2,
    max_chars_per_line: int = 22,
    max_lines: int = 1,
    # "花字" pop-up emphasis (optional).
    emphasis_enable: bool = False,
    emphasis_max_per_line: int = 1,
    emphasis_popup_sec: float = 0.9,
    emphasis_y: float = 0.42,
) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if font_size is None:
        font_size = 48 if play_res_y >= 1600 else 40
    if margin_v is None:
        margin_v = 130 if play_res_y >= 1600 else 70
    if margin_l is None:
        margin_l = 40
    if margin_r is None:
        margin_r = 40

    # ASS color format: &HAABBGGRR (AA: 00 opaque, FF transparent).
    a = int(round(max(0.0, min(1.0, float(shadow_alpha))) * 255.0))
    back_colour = f"&H{a:02X}000000"
    # Keep glyphs crisp: use minimal blur (blur too high makes the whole subtitle look fuzzy).
    default_line_tags = (
        r"{\bord0\shad2"
        + f"\\xshad{int(shadow_x)}\\yshad{int(shadow_y)}\\blur{float(shadow_blur):.1f}"
        + "}"
    )
    emph_size = int(round(font_size * 1.6))
    emph_mv = int(round(play_res_y * 0.10))
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: {x}
PlayResY: {y}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},&H00FFFFFF,&H000000FF,&H00000000,{back},0,0,0,0,100,100,0,0,1,0,2,2,{ml},{mr},{mv},1
Style: Emph,{font},{esize},&H00FFFFFF,&H000000FF,&H00000000,{back},1,0,0,0,100,100,0,0,1,6,2,5,{ml},{mr},{emv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""".format(
        x=int(play_res_x),
        y=int(play_res_y),
        font=font_name,
        size=int(font_size),
        mv=int(margin_v),
        ml=int(margin_l),
        mr=int(margin_r),
        esize=int(emph_size),
        emv=int(emph_mv),
        back=back_colour,
    )
    lines = [header]
    for ev in events:
        start = _fmt_time(float(ev["start"]))
        end = _fmt_time(float(ev["end"]))
        text = _wrap_text(_ass_safe_text(str(ev["text"])), max_chars_per_line=max_chars_per_line, max_lines=max_lines)
        if not text:
            continue
        lines.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{default_line_tags}{text}\n")

        if not emphasis_enable:
            continue
        emph = ev.get("emphasis")
        if not emph:
            continue
        if not isinstance(emph, (list, tuple)):
            emph = [str(emph)]

        # Show up to N phrases, prefer longer ones.
        phrases = [str(x).strip() for x in emph if str(x).strip()]
        phrases = sorted(set(phrases), key=lambda x: (-len(x), x))[: max(0, int(emphasis_max_per_line))]
        if not phrases:
            continue

        ev_start = float(ev["start"])
        ev_end = float(ev["end"])
        x = int(play_res_x // 2)
        y = int(play_res_y * float(emphasis_y))
        popup = max(0.2, float(emphasis_popup_sec))

        for j, p in enumerate(phrases):
            # Stagger multiple emphasis pops slightly.
            st = ev_start + 0.10 + j * 0.45
            en = min(ev_end, st + popup)
            if en <= st + 0.05:
                continue
            p = _ass_safe_text(p)
            # "Pop" animation: scale down to normal; center aligned.
            # Use ASS override tags: \an5 center, \pos, \fad, \fscx/\fscy + \t.
            tags = (
                r"{\an5\pos("
                + f"{x},{y}"
                + r")\fad(0,180)\fscx180\fscy180\t(0,250,\fscx100\fscy100)}"
            )
            lines.append(f"Dialogue: 1,{_fmt_time(st)},{_fmt_time(en)},Emph,,0,0,0,,{tags}{p}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
