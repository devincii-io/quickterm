"""Entry point: version check, config, SessionManager + uvicorn bootstrap, browser launch."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import threading
import webbrowser
from typing import TYPE_CHECKING, Any, Callable

import uvicorn

from quickterm.server import create_app

if TYPE_CHECKING:
    from quickterm.config import AppConfig, Profile
    from quickterm.session_manager import SessionManager

MIN_BUILD = 17763  # Windows 10 1809, first usable ConPTY


def main() -> None:
    _check_windows_build()
    from quickterm.config import load_config

    cfg = load_config()
    try:
        asyncio.run(_serve(cfg))
    except KeyboardInterrupt:
        pass


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
    try:
        await server.serve()
    finally:
        boot.cancel()
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
    for name in ("msedge", "chrome"):
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
