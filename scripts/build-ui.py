import json
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk


def get_default_root_dir():
    if getattr(sys, "frozen", False):
        exe_dir = os.path.dirname(sys.executable)
        return os.path.abspath(os.path.join(exe_dir, ".."))
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def resolve_package_json(root_dir):
    return os.path.join(root_dir, "package.json")


def read_package_json(root_dir):
    package_json = resolve_package_json(root_dir)
    with open(package_json, "r", encoding="utf-8") as f:
        return json.load(f)


def write_package_json(root_dir, data):
    package_json = resolve_package_json(root_dir)
    with open(package_json, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def run_command(command, env, root_dir):
    return subprocess.Popen(
        command,
        cwd=root_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
    )


def build_yarn_command(target_arch: str) -> list[str] | None:
    yarn_path = (
        shutil.which("yarn") or shutil.which("yarn.cmd") or shutil.which("yarn.bat")
    )
    if not yarn_path:
        return None

    normalized_arch = (target_arch or "both").strip().lower()
    script = "build:win"
    if normalized_arch == "x64":
        script = "build:win:x64"
    elif normalized_arch == "arm64":
        script = "build:win:arm64"

    # On Windows, Yarn is commonly a .cmd shim which requires cmd.exe.
    lower = yarn_path.lower()
    if os.name == "nt" and (lower.endswith(".cmd") or lower.endswith(".bat")):
        return ["cmd.exe", "/d", "/s", "/c", "yarn", script]

    return [yarn_path, script]


def is_semver(value):
    return re.match(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$", value or "") is not None


def sanitize_suffix(value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"\s+", "-", cleaned)
    cleaned = re.sub(r"[^0-9A-Za-z._-]", "-", cleaned)
    cleaned = re.sub(r"-+", "-", cleaned).strip("-")
    return cleaned


def build_default_suffix(edition: str, voice: str) -> str:
    ed = (edition or "pro").strip().lower()
    ed = "basic" if ed == "basic" else "pro"
    vm = (voice or "full").strip().lower()
    vm = "none" if vm == "none" else "full"
    return f"{ed}-voice-{vm}"


def ensure_root_dir(root_dir):
    package_json = resolve_package_json(root_dir)
    if os.path.isfile(package_json):
        return root_dir
    return None


def main():
    root_dir = get_default_root_dir()

    app = tk.Tk()
    app.title("Build Tool")
    app.geometry("900x520")

    env = os.environ.copy()
    output_queue: queue.Queue[str] = queue.Queue()
    process_holder = {"process": None}

    def append_log(text: str):
        log.configure(state="normal")
        log.insert("end", text)
        log.see("end")
        log.configure(state="disabled")

    def drain_queue():
        while True:
            try:
                line = output_queue.get_nowait()
            except queue.Empty:
                break
            append_log(line)
        app.after(100, drain_queue)

    def browse_root():
        selected = filedialog.askdirectory(initialdir=root_var.get() or root_dir)
        if selected:
            root_var.set(selected)
            try_load_version(selected)

    def try_load_version(root_path: str):
        valid_root = ensure_root_dir(root_path)
        if not valid_root:
            return
        try:
            pkg = read_package_json(valid_root)
            version_var.set(pkg.get("version", "0.0.0"))
        except Exception:
            return

    def set_controls_enabled(enabled: bool):
        state = "normal" if enabled else "disabled"
        root_entry.configure(state=state)
        browse_btn.configure(state=state)
        edition_combo.configure(state="readonly" if enabled else "disabled")
        voice_combo.configure(state="readonly" if enabled else "disabled")
        arch_combo.configure(state="readonly" if enabled else "disabled")
        version_entry.configure(state=state)
        suffix_entry.configure(state=state)
        auto_suffix_check.configure(state=state)
        gen_btn.configure(state=state)
        build_btn.configure(state=state)

    def reader_thread(proc: subprocess.Popen):
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                output_queue.put(line)
        finally:
            code = proc.wait()
            output_queue.put(f"\nBuild finished (exit={code}).\n")
            process_holder["process"] = None
            app.after(0, lambda: set_controls_enabled(True))

    def on_build():
        if process_holder["process"] is not None:
            return

        root_path = (root_var.get() or "").strip()
        root_path = ensure_root_dir(root_path)
        if not root_path:
            messagebox.showerror("Error", "Project root must contain package.json")
            return

        try:
            pkg = read_package_json(root_path)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to read package.json: {e}")
            return

        edition = edition_var.get() or "pro"
        voice = voice_var.get() or "full"
        target_arch = arch_var.get() or "x64"
        version = (version_var.get() or "").strip()
        if auto_suffix_var.get():
            suffix_var.set(build_default_suffix(edition, voice))
        suffix = sanitize_suffix(suffix_var.get())
        suffix_var.set(suffix)

        if not is_semver(version):
            messagebox.showerror("Error", "Version must be semver, e.g. 1.2.3")
            return

        pkg["version"] = version
        try:
            write_package_json(root_path, pkg)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to write package.json: {e}")
            return

        env["APP_EDITION"] = edition
        env["BUILD_SUFFIX"] = suffix
        env["BUILD_VOICE"] = voice

        append_log(
            f"Project: {root_path}\nEdition: {edition}\nVoice: {voice}\nArch: {target_arch}\nVersion: {version}\nSuffix: {suffix}\n\n"
        )
        set_controls_enabled(False)

        try:
            cmd = build_yarn_command(target_arch)
            if not cmd:
                raise FileNotFoundError("yarn not found in PATH")
            proc = run_command(cmd, env, root_path)
        except Exception as e:
            set_controls_enabled(True)
            messagebox.showerror("Error", f"Failed to start build: {e}")
            return

        process_holder["process"] = proc
        t = threading.Thread(target=reader_thread, args=(proc,), daemon=True)
        t.start()

    def on_stop():
        proc = process_holder.get("process")
        if proc is None:
            return
        try:
            proc.terminate()
            append_log("\nStopping build...\n")
        except Exception:
            pass

    frame = ttk.Frame(app, padding=12)
    frame.pack(fill="both", expand=True)

    root_var = tk.StringVar(value=root_dir)
    edition_var = tk.StringVar(value="pro")
    voice_var = tk.StringVar(value="full")
    arch_var = tk.StringVar(value="x64")
    version_var = tk.StringVar(value="")
    suffix_var = tk.StringVar(value="")
    auto_suffix_var = tk.BooleanVar(value=True)

    def update_suffix_if_auto(*_args):
        if not auto_suffix_var.get():
            return
        suffix_var.set(build_default_suffix(edition_var.get(), voice_var.get()))

    ttk.Label(frame, text="Project root").grid(row=0, column=0, sticky="w")
    root_entry = ttk.Entry(frame, textvariable=root_var, width=70)
    root_entry.grid(row=0, column=1, sticky="we", padx=(8, 8))
    browse_btn = ttk.Button(frame, text="Browse", command=browse_root)
    browse_btn.grid(row=0, column=2, sticky="e")

    ttk.Label(frame, text="Edition").grid(row=1, column=0, sticky="w", pady=(8, 0))
    edition_combo = ttk.Combobox(
        frame, textvariable=edition_var, values=["pro", "basic"], state="readonly"
    )
    edition_combo.grid(row=1, column=1, sticky="w", padx=(8, 8), pady=(8, 0))

    ttk.Label(frame, text="Voice").grid(row=2, column=0, sticky="w", pady=(8, 0))
    voice_combo = ttk.Combobox(
        frame, textvariable=voice_var, values=["full", "none"], state="readonly"
    )
    voice_combo.grid(row=2, column=1, sticky="w", padx=(8, 8), pady=(8, 0))

    ttk.Label(frame, text="Arch").grid(row=3, column=0, sticky="w", pady=(8, 0))
    arch_combo = ttk.Combobox(
        frame, textvariable=arch_var, values=["x64", "arm64", "both"], state="readonly"
    )
    arch_combo.grid(row=3, column=1, sticky="w", padx=(8, 8), pady=(8, 0))

    ttk.Label(frame, text="Version").grid(row=4, column=0, sticky="w", pady=(8, 0))
    version_entry = ttk.Entry(frame, textvariable=version_var, width=24)
    version_entry.grid(row=4, column=1, sticky="w", padx=(8, 8), pady=(8, 0))

    ttk.Label(frame, text="Build suffix").grid(row=5, column=0, sticky="w", pady=(8, 0))
    suffix_entry = ttk.Entry(frame, textvariable=suffix_var, width=24)
    suffix_entry.grid(row=5, column=1, sticky="w", padx=(8, 8), pady=(8, 0))

    suffix_controls = ttk.Frame(frame)
    suffix_controls.grid(row=5, column=2, sticky="w", pady=(8, 0))
    auto_suffix_check = ttk.Checkbutton(
        suffix_controls,
        text="Auto",
        variable=auto_suffix_var,
        command=update_suffix_if_auto,
    )
    auto_suffix_check.pack(side="left")
    gen_btn = ttk.Button(
        suffix_controls,
        text="Generate",
        command=lambda: suffix_var.set(
            build_default_suffix(edition_var.get(), voice_var.get())
        ),
    )
    gen_btn.pack(side="left", padx=(8, 0))

    btn_row = ttk.Frame(frame)
    btn_row.grid(row=6, column=0, columnspan=3, sticky="w", pady=(12, 8))
    build_btn = ttk.Button(btn_row, text="Build", command=on_build)
    build_btn.pack(side="left")
    stop_btn = ttk.Button(btn_row, text="Stop", command=on_stop)
    stop_btn.pack(side="left", padx=(8, 0))

    log = tk.Text(frame, height=18, wrap="none")
    log.configure(state="disabled")
    log.grid(row=7, column=0, columnspan=3, sticky="nsew")

    frame.columnconfigure(1, weight=1)
    frame.rowconfigure(7, weight=1)

    edition_var.trace_add("write", update_suffix_if_auto)
    voice_var.trace_add("write", update_suffix_if_auto)
    update_suffix_if_auto()

    try_load_version(root_dir)
    app.after(100, drain_queue)
    app.mainloop()


if __name__ == "__main__":
    sys.exit(main())
