from __future__ import annotations

from dataclasses import dataclass
from threading import Lock


@dataclass
class RuntimeVisionCredentials:
    api_base: str = ""
    api_key: str = ""


_LOCK = Lock()
_VISION = RuntimeVisionCredentials()


def set_runtime_vision_credentials(*, api_base: str, api_key: str) -> None:
    with _LOCK:
        _VISION.api_base = str(api_base or "").strip()
        _VISION.api_key = str(api_key or "").strip()


def clear_runtime_vision_credentials() -> None:
    with _LOCK:
        _VISION.api_base = ""
        _VISION.api_key = ""


def get_runtime_vision_credentials() -> RuntimeVisionCredentials:
    with _LOCK:
        return RuntimeVisionCredentials(api_base=_VISION.api_base, api_key=_VISION.api_key)


def has_runtime_vision_credentials() -> bool:
    c = get_runtime_vision_credentials()
    return bool(c.api_base and c.api_key)
