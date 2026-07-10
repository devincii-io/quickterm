"""Entry point: version check, config, SessionManager + uvicorn bootstrap, browser launch."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from typing import TYPE_CHECKING, Any, Callable

import uvicorn

from quickterm import __version__
from quickterm.server import create_app

if TYPE_CHECKING:
    from quickterm.config import AppConfig, Profile
    from quickterm.session_manager import SessionManager

MIN_BUILD = 17763  # Windows 10 1809, first usable ConPTY
REAP_INTERVAL_S = 30
log = logging.getLogger("quickterm")


def main() -> None:
    if sys.platform == "win32":
        _check_windows_build()
    from quickterm.config import load_config

    cfg = load_config()
    _setup_logging()
    log.info("QuickTerm %s starting on %s:%s", __version__, cfg.host, cfg.port)
    # One backend per port: a second launch just summons the existing window.
    if _already_running(cfg.port):
        log.info("QuickTerm already running on port %s; opening window", cfg.port)
        _launch_window(cfg.port)
        return
    try:
        asyncio.run(_serve(cfg))
    except KeyboardInterrupt:
        pass


def _setup_logging() -> None:
    from quickterm.config import config_dir

    log_dir = config_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_dir / "quickterm.log", maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        root.setLevel(logging.INFO)
        root.addHandler(handler)


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return isinstance(data, dict) and data.get("app") == "quickterm"
    except Exception:
        return False


def _check_windows_build() -> None:
    getver = getattr(sys, "getwindowsversion", None)
    if getver is None or getver().build < MIN_BUILD:
        sys.exit(
            f"QuickTerm requires Windows 10 1809 (build {MIN_BUILD}) or newer for ConPTY support."
        )


async def _serve(cfg: "AppConfig") -> None:
    from quickterm.session_manager import SessionManager

    loop = asyncio.get_running_loop()
    manager = SessionManager(loop, cfg.scrollback_bytes)
    app = create_app(manager, cfg)
    server = uvicorn.Server(
        uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning")
    )
    hotkeys = _start_hotkeys(loop, manager, cfg)
    boot = asyncio.ensure_future(_after_ready(server, manager, cfg))
    reaper = asyncio.ensure_future(_reap_loop(manager, cfg))
    try:
        await server.serve()
    finally:
        boot.cancel()
        reaper.cancel()
        if hotkeys is not None:
            try:
                hotkeys.stop()
            except Exception:
                pass
        manager.shutdown()


async def _after_ready(server: uvicorn.Server, manager: "SessionManager", cfg: "AppConfig") -> None:
    while not server.started:
        await asyncio.sleep(0.05)
    _spawn_autostart(manager, cfg)
    _launch_window(cfg.port)


async def _reap_loop(manager: "SessionManager", cfg: "AppConfig") -> None:
    # Periodically clear background clutter: detached, silent sessions that no
    # saved workspace (scratch included) still references.
    while True:
        await asyncio.sleep(REAP_INTERVAL_S)
        try:
            reaped = manager.reap_idle(cfg.idle_timeout_s, _workspace_session_ids())
            if reaped:
                log.info("reaped %d idle session(s): %s", len(reaped), ", ".join(reaped))
        except Exception:
            log.exception("reaper pass failed")


def _workspace_session_ids() -> set[str]:
    import quickterm.workspace as workspace

    ids: set[str] = set()
    for name in workspace.list_workspaces():
        if name.startswith("."):
            continue
        ws = workspace.load_workspace(name)
        if ws is not None:
            _collect_session_ids(ws.layout, ids)
    return ids


def _collect_session_ids(node: Any, out: set[str]) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "split":
        for child in node.get("children", []):
            _collect_session_ids(child, out)
        return
    sid = node.get("session_id")
    if isinstance(sid, str) and sid:
        out.add(sid)


def _spawn_autostart(manager: "SessionManager", cfg: "AppConfig") -> None:
    for prof in cfg.profiles:
        if prof.autostart:
            _spawn_profile(manager, prof)


def _spawn_profile(manager: "SessionManager", prof: "Profile") -> None:
    try:
        manager.spawn(
            name=prof.name,
            profile=prof.name,
            cmd=prof.cmd,
            args=list(prof.args),
            cwd=prof.cwd,
            env=dict(prof.env),
        )
    except Exception:
        pass  # a broken profile must not take down startup


def _start_hotkeys(
    loop: asyncio.AbstractEventLoop, manager: "SessionManager", cfg: "AppConfig"
) -> Any | None:
    # lazy + guarded: a missing or broken hotkeys module never blocks startup
    try:
        import quickterm.hotkeys as hotkeys_mod

        hk = hotkeys_mod.HotkeyManager(loop)
        for prof in cfg.profiles:
            if prof.keybinding:
                hk.register(prof.keybinding, _profile_callback(manager, prof))
        toggle = getattr(hotkeys_mod, "toggle_window", None) or getattr(
            hotkeys_mod, "summon_window", None
        )
        if cfg.summon_hotkey and toggle is not None:
            hk.register(cfg.summon_hotkey, toggle)
        _wire_voice(hk, manager, cfg)
        hk.start()
        return hk
    except Exception:
        return None


def _profile_callback(manager: "SessionManager", prof: "Profile") -> Callable[[], None]:
    return lambda: _spawn_profile(manager, prof)


def _wire_voice(hotkeys: Any, manager: "SessionManager", cfg: "AppConfig") -> None:
    # optional extra: any import/init failure silently disables voice
    try:
        import quickterm.voice as voice

        if not (cfg.voice.enabled and voice.voice_available()):
            return
        from quickterm.voice.capture import Recorder
        from quickterm.voice.transcribe import Transcriber
    except Exception:
        return
    recorder = Recorder()
    transcriber = Transcriber(cfg.voice.model_size)
    recording = threading.Event()

    def finish() -> None:
        try:
            audio = recorder.stop()
            text = transcriber.transcribe(audio)
            sid = manager.focused_session_id
            if sid and text:
                manager.write(sid, text.encode())
        except Exception:
            pass

    def toggle() -> None:
        try:
            if not recording.is_set():
                recorder.start()
                recording.set()
            else:
                recording.clear()
                # transcription is slow; keep it off the event loop
                threading.Thread(target=finish, daemon=True).start()
        except Exception:
            recording.clear()

    hotkeys.register(cfg.voice.hotkey, toggle)


def _find_browser() -> str | None:
    for name in ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LocalAppData", "")
    candidates = [
        os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _launch_window(port: int) -> None:
    url = f"http://127.0.0.1:{port}"
    browser = _find_browser()
    try:
        if browser:
            subprocess.Popen([browser, f"--app={url}"])
        else:
            webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    main()
