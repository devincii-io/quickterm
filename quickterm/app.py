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
import time
import urllib.parse
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from typing import TYPE_CHECKING, Any, Callable

from uvicorn.config import Config as UvicornConfig
from uvicorn.server import Server as UvicornServer

from quickterm import __version__
from quickterm.server import create_app

if TYPE_CHECKING:
    from quickterm.config import AppConfig, Profile
    from quickterm.session_manager import SessionManager

MIN_BUILD = 17763  # Windows 10 1809, first usable ConPTY
REAP_INTERVAL_S = 30
log = logging.getLogger("quickterm")

# Set by the in-app updater immediately before it launches the installer. The
# close-to-tray policy must stand down for that one close, or Inno Setup is
# left asking a window that refuses to go away.
_updating = threading.Event()
_shutdown_hook: Callable[[], None] | None = None


def begin_update_shutdown() -> None:
    """Stand down close-to-tray and quit shortly, for the in-app updater."""
    _updating.set()
    hook = _shutdown_hook
    if hook is None:
        return
    # Deferred so the /api/update/install response reaches the window first.
    timer = threading.Timer(1.5, hook)
    timer.daemon = True
    timer.start()


class _PrivacyFormatter(logging.Formatter):
    """Redact common user-local path prefixes from shareable diagnostics."""

    def format(self, record: logging.LogRecord) -> str:
        rendered = super().format(record)
        prefixes = {
            "USERPROFILE": os.environ.get("USERPROFILE"),
            "APPDATA": os.environ.get("APPDATA"),
            "LOCALAPPDATA": os.environ.get("LOCALAPPDATA"),
            "TEMP": os.environ.get("TEMP"),
            "TMP": os.environ.get("TMP"),
        }
        for label, value in sorted(
            prefixes.items(), key=lambda item: len(item[1] or ""), reverse=True
        ):
            if not value:
                continue
            rendered = rendered.replace(value, f"%{label}%")
            rendered = rendered.replace(value.replace("\\", "/"), f"%{label}%")
        return rendered


class _DesktopApi:
    """Small, local-only bridge for native desktop capabilities.

    This used to claim the browser frontend deliberately cannot learn arbitrary
    host paths, and that stopped being true when ``GET /api/fs/dirs`` gave the
    frontend its own directory browser. The claim was decorative even before
    that: the real boundary is the loopback bind plus the per-install token, and
    behind that token ``GET /api/file`` reads any file on the host while
    ``POST /api/sessions`` spawns arbitrary processes.

    What this bridge still is: the route to the operating system's own folder
    dialog, offered as a secondary choice inside the in-app browser for people
    who prefer it. It exists only in the installed pywebview shell, so nothing
    may depend on it being there.
    """

    def __init__(self) -> None:
        self._window: Any | None = None

    def _bind_window(self, window: Any) -> None:
        self._window = window

    def pick_folder(self, initial_directory: str = "") -> str | None:
        window = self._window
        if window is None:
            return None
        initial = initial_directory.strip() if isinstance(initial_directory, str) else ""
        if initial:
            expanded = os.path.expandvars(os.path.expanduser(initial))
            initial = expanded if os.path.isdir(expanded) else ""
        try:
            # pywebview FileDialog.FOLDER is the stable value 20. Keeping the
            # bridge independent of a module-global webview import preserves
            # headless imports and the existing POSIX fallback.
            selected = window.create_file_dialog(20, directory=initial)
        except Exception:
            log.warning("native folder picker failed", exc_info=True)
            return None
        if not selected:
            return None
        candidate = selected if isinstance(selected, str) else selected[0]
        if not isinstance(candidate, str) or not os.path.isdir(candidate):
            return None
        return os.path.abspath(candidate)


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
    # One ordinary backend and one viewer: later launches hand work to it and
    # summon it instead of creating another window onto the same session set.
    if not elevated and _already_running(cfg.port):
        if open_dir:
            _queue_running_launch(cfg.port, open_dir)
        if sys.platform == "win32":
            from quickterm.hotkeys import summon_window

            summon_window()
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
    # Older builds kept INFO-level lifecycle records and three rotations. Purge
    # those once when adopting the privacy-first warning/error log policy.
    privacy_marker = log_dir / ".privacy-v2"
    if not privacy_marker.exists():
        for old_log in log_dir.glob("quickterm.log*"):
            if old_log.is_file():
                try:
                    old_log.unlink()
                except OSError:
                    pass
        try:
            privacy_marker.touch()
        except OSError:
            pass
    debug_io = os.environ.get("QUICKTERM_DEBUG_IO") == "1"
    handler = RotatingFileHandler(
        log_dir / "quickterm.log", maxBytes=128 * 1024, backupCount=1, encoding="utf-8"
    )
    handler.setLevel(logging.INFO if debug_io else logging.WARNING)
    handler.setFormatter(_PrivacyFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    if not any(isinstance(h, RotatingFileHandler) for h in root.handlers):
        root.setLevel(logging.INFO)
        root.addHandler(handler)
    if debug_io:
        log.warning(
            "QUICKTERM_DEBUG_IO=1: raw terminal input is being written to the local log"
        )


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=0.6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return isinstance(data, dict) and data.get("app") == "quickterm"
    except Exception:
        return False


def _queue_running_launch(port: int, cwd: str) -> bool:
    """Hand Explorer's folder launch to the already-running authenticated app."""
    from quickterm import auth

    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/launches",
        data=json.dumps({"cwd": cwd}).encode("utf-8"),
        headers={"Content-Type": "application/json", auth.HEADER: auth.get_or_create_token()},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=1.5) as response:
                return response.status == 200
        except Exception:
            if attempt < 2:
                time.sleep(0.15)
    log.error("running-instance folder handoff failed")
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
    server = UvicornServer(
        UvicornConfig(
            app,
            host=cfg.host,
            port=cfg.port,
            loop="asyncio",
            http="h11",
            ws="websockets-sansio",
            lifespan="on",
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
    work: a live session the user typed into, explicitly retained, or one with a child process.
    Untouched empty shells are not worth staying resident for.
    """
    try:
        busy = manager.busy_ids() if hasattr(manager, "busy_ids") else set()
        return any(
            i.alive and (
                getattr(i, "touched", False)
                or getattr(i, "retained", False)
                or getattr(i, "id", None) in busy
            )
            for i in manager.list()
        )
    except Exception:
        # Fail safe: an unexpected error here must hide to tray, never quit and
        # take the user's running terminals with it.
        log.exception("could not evaluate session keep policy; hiding to tray")
        return True


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
    desktop_api = _DesktopApi()
    window = webview.create_window(
        title,
        _window_url(cfg.port, cwd),
        width=1280,
        height=800,
        min_size=(760, 480),
        background_color="#171918",
        js_api=desktop_api,
        text_select=True,
    )
    desktop_api._bind_window(window)
    _wire_native_file_drop(window)

    # Hide-to-tray: closing the primary window keeps terminals alive in the
    # background when they hold real work; otherwise it quits. Elevated windows
    # always quit on close: a resident admin backend would be a foot-gun.
    quitting = threading.Event()
    global _shutdown_hook
    _shutdown_hook = lambda: _quit_window(window, quitting)  # noqa: E731 (updater hand-off)
    tray = None
    if not elevated:
        try:
            from quickterm.tray import TrayIcon

            tray = TrayIcon(
                on_open=lambda: _show_window(window),
                on_quit=lambda: _quit_window(window, quitting),
            )
            # start() now reports whether an icon really exists. Without that,
            # close-to-tray could hide the window behind nothing.
            if tray.start() is False:
                log.warning("tray icon unavailable; window close will quit")
                tray.dispose()
                tray = None
        except Exception:
            log.exception("tray unavailable; window close will quit")
            tray = None

    def on_closing() -> bool:
        # _updating: the in-app updater is about to run Setup, which asks this
        # window to close. Hiding to tray there strands the installer.
        if quitting.is_set() or _updating.is_set() or tray is None:
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


def _native_drop_paths(event: Any) -> list[str]:
    """Extract host-verified full paths added by pywebview's WebView2 bridge."""
    if not isinstance(event, dict):
        return []
    transfer = event.get("dataTransfer")
    files = transfer.get("files", []) if isinstance(transfer, dict) else []
    paths: list[str] = []
    for file in files if isinstance(files, list) else []:
        path = file.get("pywebviewFullPath") if isinstance(file, dict) else None
        if isinstance(path, str) and path and path not in paths:
            paths.append(path)
    return paths


def _wire_native_file_drop(window: Any) -> None:
    """Bridge WebView2 file objects to the page without guessing basenames.

    Browser JavaScript intentionally cannot see an Explorer drop's absolute
    path. pywebview obtains it from CoreWebView2File and adds
    ``pywebviewFullPath`` to its Python DOM event; only that host-derived value
    is sent back to the selected pane.
    """
    def install() -> None:
        try:
            from webview.dom import DOMEventHandler

            def on_drop(event: Any) -> None:
                paths = _native_drop_paths(event)
                if not paths:
                    return
                payload = json.dumps(paths, ensure_ascii=False)
                window.evaluate_js(
                    f"window.quicktermNativeDrop && window.quicktermNativeDrop({payload})"
                )

            window.dom.document.events.drop += DOMEventHandler(on_drop)
        except Exception:
            log.warning("native file-drop bridge unavailable", exc_info=True)

    window.events.loaded += install


def _quit_window(window: Any, quitting: threading.Event) -> None:
    quitting.set()  # checked by on_closing: this close is a real quit
    try:
        window.destroy()
    except Exception:
        log.debug("tray quit failed", exc_info=True)


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
    server: UvicornServer,
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
            # Everything in this pass is blocking: _workspace_session_ids()
            # globs and parses every workspace file, busy_ids() takes a full
            # Toolhelp snapshot, and killing a live shell spawns taskkill /T /F
            # and waits on process handles (hundreds of ms). On the event loop
            # that froze every pane and every keystroke for the duration, and
            # the freeze then overflowed the fan-out queues it had stalled.
            # kill()/_finish_kill already marshal their registry and queue
            # mutations back with call_soon_threadsafe.
            reaped = await asyncio.to_thread(
                _reap_pass, manager, cfg.idle_timeout_s
            )
            if reaped:
                # Lifecycle logs deliberately omit session IDs. They are not
                # terminal history, but retaining identifiers adds no value to
                # routine diagnostics and makes logs harder to share safely.
                log.info("reaped %d idle session(s)", len(reaped))
        except Exception:
            log.exception("reaper pass failed")


def _reap_pass(manager: "SessionManager", idle_timeout_s: int) -> list:
    """One reaper pass. Runs in a worker thread, never on the event loop."""
    return manager.reap_idle(idle_timeout_s, _workspace_session_ids())


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
        # register() returns False when the combination parses but Windows
        # refuses it, almost always because another program already owns it.
        # Discarding that made the documented escape hatch for a tray-hidden
        # window fail silently; Settings renders cfg.hotkey_error next to the
        # field instead.
        # Only Windows has RegisterHotKey; elsewhere register() always returns
        # False and there is nothing worth reporting.
        report = os.name == "nt"
        failed: list[str] = []
        for prof in cfg.profiles:
            if not prof.keybinding:
                continue
            ok = hk.register(prof.keybinding, _profile_callback(manager, prof, cfg))
            if report and ok is False:
                failed.append(f"{prof.keybinding} ({prof.name})")
        toggle = getattr(hotkeys_mod, "toggle_window", None) or getattr(
            hotkeys_mod, "summon_window", None
        )
        if cfg.summon_hotkey and toggle is not None:
            if hk.register(cfg.summon_hotkey, toggle) is False and report:
                failed.append(cfg.summon_hotkey)
        if failed:
            detail = ", ".join(failed)
            cfg.hotkey_error = f"already in use by another program: {detail}"
            log.warning("global hotkey registration failed: %s", detail)
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
    # quickterm/voice/. Re-wire here (see git history) once the UI exists.
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
