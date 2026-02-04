from __future__ import annotations

import argparse

import uvicorn

from app.server.api import create_app
from app.server.job_manager import JobManager


def main() -> int:
    ap = argparse.ArgumentParser(description="gist-video local HTTP/WebSocket server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--log-level", default="info")
    ap.add_argument(
        "--self-check-onnxruntime",
        action="store_true",
        help="run `import onnxruntime` self-check then exit",
    )
    args = ap.parse_args()

    if args.self_check_onnxruntime:
        import sys

        try:
            import os

            from app.embeddings.onnx_m3e import _prepare_onnxruntime_dll_search

            dll_dirs = _prepare_onnxruntime_dll_search()
            capi_dir = None
            for d in dll_dirs:
                if os.path.isfile(os.path.join(d, "onnxruntime.dll")):
                    capi_dir = d
                    break

            if os.name == "nt" and capi_dir:
                import ctypes

                def _try_load(label: str, p: str) -> None:
                    try:
                        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                        load_ex = getattr(kernel32, "LoadLibraryExW", None)
                        if not load_ex:
                            print(f"preload[{label}]=skip path={p} err=LoadLibraryExW not found")
                            return
                        load_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_uint32]
                        load_ex.restype = ctypes.c_void_p
                        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR = 0x00000100
                        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS = 0x00001000
                        h = load_ex(p, None, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
                        if not h:
                            err = ctypes.get_last_error()
                            print(f"preload[{label}]=fail path={p} winerror={err}")
                            return
                        print(f"preload[{label}]=ok path={p}")
                    except OSError as e:
                        winerror = getattr(e, "winerror", None)
                        print(f"preload[{label}]=fail path={p} winerror={winerror} err={e}")

                _try_load("onnxruntime_providers_shared.dll", os.path.join(capi_dir, "onnxruntime_providers_shared.dll"))
                _try_load("onnxruntime.dll", os.path.join(capi_dir, "onnxruntime.dll"))

            import onnxruntime as ort  # type: ignore

            print(f"python={sys.executable}")
            print(f"version={sys.version}")
            print(f"onnxruntime={ort.__version__}")
            try:
                print(f"providers={ort.get_available_providers()}")
            except Exception:
                pass
            print(f"dll_candidates={dll_dirs}")
            return 0
        except Exception as e:
            print(f"self-check failed: {e}")
            return 1

    jm = JobManager()
    app = create_app(job_manager=jm)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
