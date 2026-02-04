from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from app.core.paths import default_paths


_WIN_DLL_SEARCH_READY = False


def _configure_windows_dll_search() -> None:
    """
    In PyInstaller-built executables, Windows DLL search defaults can differ from a normal
    CPython process. Ensure AddDllDirectory/os.add_dll_directory works reliably for subsequent
    LoadLibrary calls (including those made inside onnxruntime.dll).
    """
    global _WIN_DLL_SEARCH_READY
    if _WIN_DLL_SEARCH_READY or os.name != "nt":
        return
    _WIN_DLL_SEARCH_READY = True
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        set_default = getattr(kernel32, "SetDefaultDllDirectories", None)
        if not set_default:
            return
        set_default.argtypes = [ctypes.c_uint32]
        set_default.restype = ctypes.c_int
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000
        set_default(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
    except Exception:
        # Best-effort: fallback to PATH prepending below.
        pass


def _maybe_add_dll_dir(dir_path: str) -> None:
    """
    Help Windows resolve dependent DLLs for binary Python modules (e.g. onnxruntime).

    This is intentionally best-effort: we don't want embedding to crash the whole job just because
    the DLL directory cannot be added.
    """
    _configure_windows_dll_search()
    p = (dir_path or "").strip()
    if not p or not os.path.isdir(p):
        return
    try:
        add = getattr(os, "add_dll_directory", None)
        if callable(add):
            add(p)  # Python 3.8+ on Windows
    except Exception:
        # Fall back to PATH prepending below.
        pass
    # Also prepend to PATH for older loaders / edge cases.
    try:
        cur = os.environ.get("PATH") or ""
        parts = [x for x in cur.split(os.pathsep) if x]
        if p not in parts:
            os.environ["PATH"] = p + (os.pathsep + cur if cur else "")
    except Exception:
        pass


def _prepare_onnxruntime_dll_search() -> list[str]:
    """
    Prepare DLL search paths so `import onnxruntime` can reliably find:
    - onnxruntime.dll
    - onnxruntime_providers_shared.dll

    This matters in packaged builds where the parent process PATH may contain other onnxruntime.dll
    (e.g. from TTS/sherpa-onnx), which can cause a confusing "DLL 初始化例程失败" during import.
    """
    import sys
    import importlib.util

    candidates: list[str] = []

    # PyInstaller: onefile/onedir extracted location.
    meipass = getattr(sys, "_MEIPASS", None)
    if isinstance(meipass, str) and meipass:
        candidates.append(os.path.join(meipass, "onnxruntime", "capi"))
        candidates.append(os.path.join(meipass, "_internal", "onnxruntime", "capi"))
        # Include the base extraction dir itself. In onedir builds, many dependent DLLs live in _MEIPASS.
        candidates.append(meipass)

    # PyInstaller onedir: DLLs may sit next to sys.executable in _internal.
    exe_dir = os.path.dirname(sys.executable or "")
    if exe_dir:
        candidates.append(os.path.join(exe_dir, "_internal", "onnxruntime", "capi"))
        candidates.append(os.path.join(exe_dir, "onnxruntime", "capi"))
        candidates.append(os.path.join(exe_dir, "_internal"))
        candidates.append(exe_dir)

    # Normal Python site-packages (no import side effects).
    try:
        spec = importlib.util.find_spec("onnxruntime")
        if spec and spec.origin:
            candidates.append(os.path.join(os.path.dirname(spec.origin), "capi"))
    except Exception:
        pass

    # De-dup while preserving order.
    uniq: list[str] = []
    seen = set()
    for p in candidates:
        p2 = os.path.abspath(p)
        if p2 in seen:
            continue
        seen.add(p2)
        uniq.append(p2)

    # _maybe_add_dll_dir prepends to PATH. Add in reverse order so the final PATH keeps our intended priority.
    for p in reversed(uniq):
        _maybe_add_dll_dir(p)

    # On Windows, proactively load the *exact* onnxruntime.dll we ship (or resolved from site-packages).
    # This makes DLL resolution deterministic when the parent process PATH contains another onnxruntime.dll
    # (for example: sherpa-onnx/TTS bundles one too), which can otherwise lead to:
    # "DLL load failed while importing onnxruntime_pybind11_state: DLL 初始化例程失败".
    if os.name == "nt":
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            load_ex = getattr(kernel32, "LoadLibraryExW", None)
            if not load_ex:
                return uniq
            load_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
            load_ex.restype = ctypes.c_void_p

            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100
            LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000

            def _load(path: str) -> None:
                h = load_ex(path, None, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
                if not h:
                    err = ctypes.get_last_error()
                    raise OSError(err, f"LoadLibraryExW failed: {path}")

            for p in uniq:
                ort_dll = os.path.join(p, "onnxruntime.dll")
                if not os.path.isfile(ort_dll):
                    continue
                shared = os.path.join(p, "onnxruntime_providers_shared.dll")
                cpu = os.path.join(p, "onnxruntime_providers_cpu.dll")
                if os.path.isfile(shared):
                    _load(shared)
                if os.path.isfile(cpu):
                    _load(cpu)
                _load(ort_dll)
                break
        except Exception:
            # Best-effort: if preloading fails, we still try the normal import path.
            pass

    return uniq


def can_resolve_onnx_model(model_id_or_path: str) -> bool:
    try:
        _resolve_onnx_and_tokenizer(model_id_or_path)
        return True
    except Exception:
        return False


def _resolve_tokenizer_json(onnx_path: str) -> str | None:
    base = os.path.dirname(onnx_path)
    return _find_first_existing(
        [
            os.path.join(base, "tokenizer.json"),
            os.path.join(os.path.dirname(base), "tokenizer.json"),
            os.path.join(os.path.dirname(os.path.dirname(base)), "tokenizer.json"),
        ]
    )


def _l2_normalize(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    norms = np.where(norms < 1e-8, 1.0, norms)
    return x / norms


def _mean_pool(last_hidden: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    # last_hidden: [B, T, H], attention_mask: [B, T]
    mask = attention_mask.astype(np.float32)
    mask = np.expand_dims(mask, axis=-1)  # [B,T,1]
    summed = (last_hidden.astype(np.float32) * mask).sum(axis=1)
    denom = mask.sum(axis=1)
    denom = np.where(denom < 1e-6, 1.0, denom)
    return summed / denom


def _find_first_existing(paths: list[str]) -> str | None:
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def _resolve_onnx_and_tokenizer(model_id_or_path: str) -> tuple[str, str]:
    """
    Resolve ONNX model path + tokenizer.json path from a user-provided model_id.

    Supported inputs:
    - absolute path to a .onnx file (e.g. F:/gist-video/m3e-small/onnx/model.onnx)
    - a directory containing model.onnx
    - a directory containing onnx/model.onnx
    """
    raw = (model_id_or_path or "").strip()
    if not raw:
        raise RuntimeError("embedding.model_id 为空（请填入 ONNX 模型路径）。")

    # Treat relative paths as relative to the app root, not cwd (Qt dialogs can change cwd).
    p = raw
    if not os.path.isabs(p):
        p = os.path.join(default_paths().root, p)
    p = os.path.abspath(p)

    if os.path.isfile(p) and p.lower().endswith(".onnx"):
        onnx_path = p
        tok = _resolve_tokenizer_json(onnx_path)
        if not tok:
            raise RuntimeError(
                "未找到 tokenizer.json（ONNX embedding 需要 tokenizer）。\n"
                f"- 已找到模型：{onnx_path}\n"
                "- 期望 tokenizer.json 位于同目录或其上级目录。\n"
                "提示：可从原 HF/Sentence-Transformers 模型导出 tokenizer.json。"
            )
        return onnx_path, tok

    if os.path.isdir(p):
        candidates = [
            os.path.join(p, "model.onnx"),
            os.path.join(p, "onnx", "model.onnx"),
        ]
        onnx_path = _find_first_existing(candidates)
        if not onnx_path:
            raise RuntimeError(
                "未找到 ONNX 模型文件。\n"
                f"- 当前配置：{p}\n"
                "- 期望文件：model.onnx 或 onnx/model.onnx"
            )
        tok = _find_first_existing([os.path.join(p, "tokenizer.json"), _resolve_tokenizer_json(onnx_path) or ""])
        if not tok:
            raise RuntimeError(
                "未找到 tokenizer.json（ONNX embedding 需要 tokenizer）。\n"
                f"- 已找到模型：{onnx_path}\n"
                f"- 期望文件：{os.path.join(p, 'tokenizer.json')}"
            )
        return onnx_path, tok

    # Last-chance: allow using HF-style model ids (e.g. "AI-ModelScope/m3e-small") by searching common local layouts.
    root = default_paths().root
    name = raw.replace("\\", "/").strip().strip("/")
    base_name = name.split("/")[-1] if name else ""
    candidates = []
    if base_name:
        candidates.append(os.path.join(root, base_name, "onnx", "model.onnx"))
    if name:
        candidates.append(os.path.join(root, "models", *name.split("/"), "onnx", "model.onnx"))
    if base_name:
        candidates.append(os.path.join(root, "models", base_name, "onnx", "model.onnx"))
    onnx_path = _find_first_existing(candidates)
    if onnx_path:
        tok = _resolve_tokenizer_json(onnx_path)
        if not tok and base_name:
            tok = _find_first_existing([os.path.join(root, base_name, "tokenizer.json")])
        if not tok:
            raise RuntimeError(
                "已找到 ONNX 模型，但未找到 tokenizer.json。\n"
                f"- 已找到模型：{onnx_path}\n"
                "请把 tokenizer.json 放在模型目录或其上级目录。"
            )
        return onnx_path, tok

    raise RuntimeError(f"embedding.model_id 无法解析为本地 ONNX 模型：{raw}")


@dataclass
class OnnxM3EEmbeddingProvider:
    """
    Lightweight local embedding provider via ONNX Runtime.

    Dependencies:
    - onnxruntime (CPU)
    - tokenizers
    - numpy
    """

    model_id: str
    max_length: int = 256
    batch_size: int = 32
    _sess: object | None = None
    _tok: object | None = None
    _pad_id: int = 0
    _input_names: tuple[str, ...] | None = None
    _output_names: tuple[str, ...] | None = None

    def _ensure_loaded(self) -> None:
        if self._sess is not None and self._tok is not None:
            return

        try:
            # Best-effort to make DLL resolution deterministic on Windows.
            _prepare_onnxruntime_dll_search()
            import onnxruntime as ort  # type: ignore
        except ModuleNotFoundError as e:
            import sys

            py = sys.executable or "python"
            raise RuntimeError(
                "缺少依赖：onnxruntime。\n"
                f"当前 Python：{py}\n"
                f"请执行：\"{py}\" -m pip install onnxruntime"
            ) from e
        except Exception as e:
            import sys

            # Provide actionable diagnostics (especially for packaged builds).
            dll_dirs = []
            try:
                dll_dirs = _prepare_onnxruntime_dll_search()
            except Exception:
                dll_dirs = []
            capi_checks: list[dict[str, object]] = []
            try:
                for d in dll_dirs:
                    capi_checks.append(
                        {
                            "dir": d,
                            "onnxruntime.dll": os.path.isfile(os.path.join(d, "onnxruntime.dll")),
                            "onnxruntime_providers_shared.dll": os.path.isfile(
                                os.path.join(d, "onnxruntime_providers_shared.dll")
                            ),
                            "onnxruntime_pybind11_state.pyd": os.path.isfile(
                                os.path.join(d, "onnxruntime_pybind11_state.pyd")
                            ),
                            # NOTE: Older onnxruntime wheels shipped this DLL. Newer Windows wheels may not.
                            "onnxruntime_providers_cpu.dll": os.path.isfile(
                                os.path.join(d, "onnxruntime_providers_cpu.dll")
                            ),
                        }
                    )
            except Exception:
                capi_checks = []
            frozen = bool(getattr(sys, "frozen", False))
            meipass = getattr(sys, "_MEIPASS", None)
            py = sys.executable or "python"
            detail = [
                "onnxruntime 导入失败（通常是 DLL 加载/初始化失败）。",
                f"Python: {py}",
                f"frozen: {frozen}",
                f"_MEIPASS: {meipass}",
                f"dll_candidates: {dll_dirs}",
                f"capi_files: {capi_checks}",
                f"原始错误: {e}",
                "提示1：检查安装包是否包含 onnxruntime.dll / onnxruntime_providers_shared.dll / onnxruntime_pybind11_state.pyd。",
                "提示2：Windows 新版 onnxruntime 可能不再包含 onnxruntime_providers_cpu.dll，这是正常的。",
                "提示3：如果你的主程序/其它组件也带了 onnxruntime.dll（例如 tts 目录），可能会被 PATH 误命中导致冲突。",
                "提示4：如果文件齐全仍报“DLL 初始化例程失败”，常见原因包括：VC 运行库缺失、杀软拦截、或 CPU 指令集不兼容（可在目标机用独立 Python 执行 `import onnxruntime` 验证）。",
            ]
            raise RuntimeError("\n".join(detail)) from e

        try:
            from tokenizers import Tokenizer  # type: ignore
        except ModuleNotFoundError as e:
            import sys

            py = sys.executable or "python"
            raise RuntimeError(
                "缺少依赖：tokenizers。\n"
                f"当前 Python：{py}\n"
                f"请执行：\"{py}\" -m pip install tokenizers"
            ) from e

        onnx_path, tok_json = _resolve_onnx_and_tokenizer(self.model_id)
        self._tok = Tokenizer.from_file(tok_json)
        try:
            pid = self._tok.token_to_id("[PAD]")  # type: ignore[attr-defined]
            self._pad_id = int(pid) if pid is not None else 0
        except Exception:
            self._pad_id = 0

        # Keep it CPU-only; avoid provider surprises.
        so = ort.SessionOptions()
        # Conservative defaults; users on low-end CPUs can still run this.
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._sess = ort.InferenceSession(onnx_path, sess_options=so, providers=["CPUExecutionProvider"])

        ins = self._sess.get_inputs()
        outs = self._sess.get_outputs()
        self._input_names = tuple(i.name for i in ins)
        self._output_names = tuple(o.name for o in outs)

    def _tokenize(self, texts: list[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
        assert self._tok is not None
        # Keep empties stable as a single space.
        safe = [(" " if not (t or "").strip() else str(t)) for t in texts]
        encs = self._tok.encode_batch(safe)

        max_len = int(self.max_length) if int(self.max_length) > 0 else 256
        max_len = max(8, min(512, max_len))

        input_ids = np.full((len(encs), max_len), int(self._pad_id), dtype=np.int64)
        attention = np.zeros((len(encs), max_len), dtype=np.int64)
        for i, e in enumerate(encs):
            ids = list(getattr(e, "ids", []) or [])
            if not ids:
                continue
            ids = ids[:max_len]
            input_ids[i, : len(ids)] = np.asarray(ids, dtype=np.int64)
            attention[i, : len(ids)] = 1

        # Some exported models expect token_type_ids.
        token_type = np.zeros_like(input_ids, dtype=np.int64)
        return input_ids, attention, token_type

    def embed_texts(self, texts: list[str]) -> np.ndarray:
        self._ensure_loaded()
        assert self._sess is not None and self._input_names is not None and self._output_names is not None

        if not texts:
            return np.zeros((0, 0), dtype=np.float32)

        empty_mask = [not (t or "").strip() for t in texts]
        bs = max(1, int(self.batch_size))
        vecs: list[np.ndarray] = []

        for i in range(0, len(texts), bs):
            batch = texts[i : i + bs]
            input_ids, attention, token_type = self._tokenize(batch)

            feed: dict[str, np.ndarray] = {}
            names = set(self._input_names)
            if "input_ids" in names:
                feed["input_ids"] = input_ids
            if "attention_mask" in names:
                feed["attention_mask"] = attention
            if "token_type_ids" in names:
                feed["token_type_ids"] = token_type

            # Compatibility: some exports use different names.
            if not feed:
                # Fall back to feeding by order (common for simple exports).
                for n, arr in zip(self._input_names, [input_ids, attention, token_type]):
                    feed[n] = arr

            outs = self._sess.run(list(self._output_names), feed)
            if not outs:
                raise RuntimeError("ONNX embedding 推理无输出。")

            out0 = outs[0]
            arr = np.asarray(out0)
            if arr.ndim == 3:
                emb = _mean_pool(arr, attention)
            elif arr.ndim == 2:
                emb = arr.astype(np.float32)
            else:
                raise RuntimeError(f"ONNX embedding 输出维度不支持：shape={getattr(arr, 'shape', None)}")

            emb = emb.astype(np.float32)
            emb = _l2_normalize(emb)
            vecs.append(emb)

        out = np.concatenate(vecs, axis=0) if vecs else np.zeros((0, 0), dtype=np.float32)
        # Keep empties stable as zeros.
        for idx, is_empty in enumerate(empty_mask):
            if is_empty and idx < out.shape[0]:
                out[idx, :] = 0.0
        return out
