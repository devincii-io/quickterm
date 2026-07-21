"""Entry point: config, backend bootstrap, and native desktop window."""

from __future__ import annotations

import asyncio
import argparse
import json
import logging
import os
import shutil
import subprocess
import socket
import sys
import threading
import urllib.parse
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
    parser = argparse.ArgumentParser(prog="QuickTerm")
    parser.add_argument("--elevated-spec", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, help="override the local backend port")
    parser.add_argument(
        "path", nargs="?", help="open a terminal in this directory (Explorer 'Open QuickTerm here')"
    )
    args = parser.parse_args()
    open_dir = None
    if args.path:
        candidate = os.path.abspath(os.path.expanduser(args.path))
        if os.path.isdir(candidate):
            open_dir = candidate
    if sys.platform == "win32":
        _check_windows_build()
    from quickterm.config import load_config

    cfg = load_config()
    if args.port is not None:
        if not 0 <= args.port <= 65535:
            parser.error("--port must be between 0 and 65535")
        cfg.port = _free_port() if args.port == 0 else args.port
    initial_launch = None
    elevated = bool(args.elevated_spec)
    if args.elevated_spec:
        from quickterm.elevation import decode_spec

        initial_launch = decode_spec(args.elevated_spec)
        cfg.port = _free_port()
    _setup_logging()
    log.info("QuickTerm %s starting on %s:%s", __version__, cfg.host, cfg.port)
    # One backend per port: a second launch just summons the existing window.
    if not elevated and _already_running(cfg.port):
        log.info("QuickTerm already running on port %s; opening window", cfg.port)
        if sys.platform == "win32":
            _open_native_window(cfg.port, cwd=open_dir)
        else:
            _launch_window(cfg.port, cwd=open_dir)
        return
    if sys.platform == "win32":
        if not _run_desktop(cfg, initial_launch=initial_launch, elevated=elevated, cwd=open_dir):
            sys.exit("QuickTerm could not create its native desktop window.")
        return
    try:
        asyncio.run(_serve(cfg, initial_launch=initial_launch, cwd=open_dir))
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


async def _serve(
    cfg: "AppConfig",
    *,
    ready_event: threading.Event | None = None,
    launch_window: bool = True,
    state: dict[str, Any] | None = None,
    initial_launch: dict[str, Any] | None = None,
    elevated: bool = False,
    cwd: str | None = None,
) -> None:
    from quickterm.session_manager import SessionManager

    from quickterm import auth

    loop = asyncio.get_running_loop()
    manager = SessionManager(loop, cfg.scrollback_bytes, cfg.max_sessions)
    app = create_app(manager, cfg, auth.get_or_create_token(), elevated=elevated)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=cfg.host,
            port=cfg.port,
            log_config=None,
            access_log=False,
            ws_max_size=256 * 1024,
            ws_max_queue=16,
            ws_per_message_deflate=False,
        )
    )
    if state is not None:
        state.update(server=server, loop=loop, manager=manager)
    # The "scratch" workspace is ephemeral: it only mirrors the current scratch
    # layout during a run. Discard at startup too, so a crash can't leak it.
    _discard_scratch_workspace()
    hotkeys = _start_hotkeys(loop, manager, cfg)
    boot = asyncio.ensure_future(
        _after_ready(
            server,
            manager,
            cfg,
            ready_event=ready_event,
            launch_window=launch_window,
            initial_launch=initial_launch,
            cwd=cwd,
        )
    )
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
        _discard_scratch_workspace()


def _sessions_worth_keeping(manager: Any) -> bool:
    """Closing the window only hides to tray when quitting would lose real
    work: a live session the user typed into or one with a child process.
    Untouched empty shells are not worth staying resident for.
    """
    try:
        busy = manager.busy_ids() if hasattr(manager, "busy_ids") else set()
        return any(
            i.alive and (getattr(i, "touched", False) or getattr(i, "id", None) in busy)
            for i in manager.list()
        )
    except Exception:
        return False


def _run_desktop(
    cfg: "AppConfig",
    *,
    initial_launch: dict[str, Any] | None = None,
    elevated: bool = False,
    cwd: str | None = None,
) -> bool:
    """Run the backend beside a native Windows WebView on the main thread."""
    if sys.platform != "win32":
        return False
    try:
        import webview
    except ImportError:
        log.exception("native WebView is unavailable")
        return False

    ready = threading.Event()
    state: dict[str, Any] = {}
    errors: list[BaseException] = []

    def serve() -> None:
        try:
            asyncio.run(
                _serve(
                    cfg,
                    ready_event=ready,
                    launch_window=False,
                    state=state,
                    initial_launch=initial_launch,
                    elevated=elevated,
                )
            )
        except BaseException as exc:
            errors.append(exc)
            ready.set()

    backend = threading.Thread(target=serve, name="quickterm-server", daemon=True)
    backend.start()
    ready.wait(timeout=15)
    if errors or not ready.is_set():
        if errors:
            log.error("backend failed before the desktop window opened", exc_info=errors[0])
        return False

    title = "QuickTerm - Administrator" if elevated else "QuickTerm"
    window = webview.create_window(
        title,
        _window_url(cfg.port, cwd),
        width=1280,
        height=800,
        min_size=(760, 480),
        background_color="#171918",
        text_select=True,
    )

    # Hide-to-tray: closing the primary window keeps terminals alive in the
    # background when they hold real work; otherwise it quits. Elevated windows
    # always quit on close — a resident admin backend would be a foot-gun.
    quitting = threading.Event()
    tray = None
    if not elevated:
        try:
            from quickterm.tray import TrayIcon

            tray = TrayIcon(
                on_open=lambda: _show_window(window),
                on_quit=lambda: _quit_window(window, quitting),
            )
            tray.start()
        except Exception:
            log.exception("tray unavailable; window close will quit")
            tray = None

    def on_closing() -> bool:
        if quitting.is_set() or tray is None:
            return True
        if not _sessions_worth_keeping(state.get("manager")):
            return True  # nothing running worth the RAM: real quit
        window.hide()
        tray.balloon_once(
            "QuickTerm is still running",
            "Your terminals keep running in the background. "
            "Click the tray icon to reopen, right-click it to quit.",
        )
        return False  # cancel the close; we merely hid

    window.events.closing += on_closing
    try:
        from quickterm.config import config_dir

        webview.start(
            gui="edgechromium",
            private_mode=False,
            storage_path=str(config_dir() / "webview"),
        )
    finally:
        if tray is not None:
            tray.dispose()
        server = state.get("server")
        loop = state.get("loop")
        if server is not None and loop is not None:
            loop.call_soon_threadsafe(setattr, server, "should_exit", True)
        backend.join(timeout=10)
    return True


def _show_window(window: Any) -> None:
    try:
        window.show()
        window.restore()
    except Exception:
        log.debug("tray show failed", exc_info=True)


def _quit_window(window: Any, quitting: threading.Event) -> None:
    quitting.set()  # checked by on_closing: this close is a real quit
    try:
        window.destroy()
    except Exception:
        log.debug("tray quit failed", exc_info=True)


def _open_native_window(port: int, cwd: str | None = None) -> bool:
    """Open another native view onto an already-running QuickTerm backend."""
    try:
        import webview
    except ImportError:
        return False
    webview.create_window(
        "QuickTerm",
        _window_url(port, cwd),
        width=1280,
        height=800,
        min_size=(760, 480),
        background_color="#171918",
        text_select=True,
    )
    webview.start(gui="edgechromium", private_mode=False)
    return True


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _window_url(port: int, cwd: str | None = None) -> str:
    # The auth token rides in the URL fragment: the browser reads it client-side
    # and it is never sent to the server or written to any log. An optional cwd
    # query tells the frontend to open its first terminal in that directory
    # (Explorer "Open QuickTerm here").
    from quickterm import auth

    query = f"?cwd={urllib.parse.quote(cwd)}" if cwd else ""
    return f"http://127.0.0.1:{port}/{query}#t={auth.get_or_create_token()}"


async def _after_ready(
    server: uvicorn.Server,
    manager: "SessionManager",
    cfg: "AppConfig",
    *,
    ready_event: threading.Event | None = None,
    launch_window: bool = True,
    initial_launch: dict[str, Any] | None = None,
    cwd: str | None = None,
) -> None:
    while not server.started:
        await asyncio.sleep(0.05)
    if initial_launch:
        manager.spawn(**initial_launch)
    else:
        _spawn_autostart(manager, cfg)
    if ready_event is not None:
        ready_event.set()
    if launch_window:
        _launch_window(cfg.port, cwd=cwd)


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


def _discard_scratch_workspace() -> None:
    """Drop the ephemeral "scratch" workspace file (never survives a run)."""
    try:
        import quickterm.workspace as workspace

        workspace.delete_workspace("scratch")
    except Exception:
        log.debug("could not discard scratch workspace", exc_info=True)


def _workspace_session_ids() -> set[str]:
    import quickterm.workspace as workspace

    ids: set[str] = set()
    for name in workspace.list_workspaces():
        if name.startswith("."):
            continue
        ws = workspace.load_workspace(name)
        if ws is not None:
            _collect_session_ids(ws.layout, ids)
            ids.update(getattr(ws, "session_ids", []) or [])
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
            _spawn_profile(manager, prof, cfg)


def _spawn_profile(manager: "SessionManager", prof: "Profile", cfg: "AppConfig") -> None:
    try:
        # Keep autostart/global-hotkey launches identical to API/UI launches:
        # terminal types, WSL distro, and start_command must all be resolved.
        from quickterm.server import _resolve_profile

        cmd, args, cwd = _resolve_profile(prof)
        manager.spawn(
            name=prof.name,
            profile=prof.name,
            cmd=cmd,
            args=args,
            cwd=cwd,
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
                hk.register(prof.keybinding, _profile_callback(manager, prof, cfg))
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


def _profile_callback(
    manager: "SessionManager", prof: "Profile", cfg: "AppConfig"
) -> Callable[[], None]:
    return lambda: _spawn_profile(manager, prof, cfg)


def _wire_voice(hotkeys: Any, manager: "SessionManager", cfg: "AppConfig") -> None:
    # Voice is parked: without a capture overlay the hotkey gives no feedback
    # at all, which reads as "broken". The capture/transcribe modules stay in
    # quickterm/voice/ — re-wire here (see git history) once the UI exists.
    del hotkeys, manager, cfg


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


def _launch_window(port: int, cwd: str | None = None) -> None:
    url = _window_url(port, cwd)
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
