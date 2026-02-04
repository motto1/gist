from __future__ import annotations

import json
import os
import time


def atomic_write_json(path: str, data: object) -> None:
    tmp = f"{path}.tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def wait_if_paused(pause_evt, cancel_evt) -> None:
    while pause_evt.is_set():
        if cancel_evt.is_set():
            raise RuntimeError("Cancelled")
        time.sleep(0.1)


def check_cancel(cancel_evt) -> None:
    if cancel_evt.is_set():
        raise RuntimeError("Cancelled")


def pct(i: int, n: int) -> int:
    if n <= 0:
        return 0
    return max(0, min(100, int((i / n) * 100)))

