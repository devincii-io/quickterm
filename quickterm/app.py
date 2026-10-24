"""Entry point: the launcher, the backend (`--serve`) and the window process (`--viewer`).

On Windows the backend, which owns every PTY, and the window process are
separate (see pty_host.py), so closing or restarting the window and installing
an update leave the terminals running. POSIX keeps one process with a browser
window.
"""

from __future__ import annotations

import asyncio
import argparse
import functools
import json
import logging
import os
import shutil
import subprocess
import socket
import sys
import threading
import time
import types
import urllib.parse
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from uvicorn.config import Config as UvicornConfig
from uvicorn.server import Server as UvicornServer

from quickterm import __version__, cli, launch, pty_host
from quickterm.server import client_host, create_app
from quickterm.windows import (
    WindowInfo,
    WindowRegistry,
    WorkspaceClaimed,
    new_window_id,
    normalize_workspace,
    window_title,
)

if TYPE_CHECKING:
    from quickterm.config import AppConfig, Profile
    from quickterm.session_manager import SessionManager

MIN_BUILD = 17763  # Windows 10 1809, first usable ConPTY
REAP_INTERVAL_S = 30
MIN_WINDOW_SIZE = (760, 480)
# Painted before the page loads. Keep it equal to --bg in css/app.css :root
# (the default theme's background), or the window flashes another colour.
WINDOW_BACKGROUND = "#15140f"
SECONDARY_OFFSET = 32
BOUNDS_SAVE_DELAY_S = 0.5
# Spec defaults, for a config.py that predates the window and overlay fields.
_WINDOW_DEFAULTS = {"width": 1280, "height": 800, "remember_bounds": True}
TITLE = "QuickTerm"
ELEVATED_TITLE = "QuickTerm - Administrator"
# How long the launcher waits for a backend it started, or for a retired one
# to let go of the port.
BACKEND_START_S = 30.0
BACKEND_RETIRE_S = 20.0
GRACEFUL_SHUTDOWN_S = 3
log = logging.getLogger("quickterm")

# Hotkey launches run as tasks nobody awaits; the loop keeps only weak
# references, so they are held here until they finish.
_launch_tasks: set[asyncio.Task] = set()


def begin_update_shutdown() -> bool:
    """The in-app updater's stand-down; pty_host.begin_update decides."""
    return pty_host.begin_update()


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

    def __init__(self, viewers: "Any | None" = None) -> None:
        self._window: Any | None = None
        self._viewers = viewers

    def _bind_window(self, window: Any) -> None:
        self._window = window

    def open_window(self, workspace: Any = "", cwd: Any = "") -> dict:
        """Open another native viewer onto this same backend.

        This is the primary route for "new window": the bridge runs each call
        on its own thread, which is exactly where pywebview will materialise a
        window while the GUI loop owns the main thread. The frontend may pass
        the two values positionally or as one options object, because the
        bridge forwards whatever JavaScript handed it.

        Never raises: a rejected bridge promise carries a Python traceback into
        the page, and a refusal here is ordinary (the workspace is already open
        in another window), not a fault.
        """
        if isinstance(workspace, dict):
            options = workspace
            workspace = options.get("workspace", "")
            cwd = options.get("cwd", cwd)
        viewers = self._viewers
        if viewers is None:
            return {"opened": False, "error": "unavailable"}
        try:
            name = normalize_workspace(workspace)
        except ValueError as exc:
            return {"opened": False, "error": "invalid_workspace", "detail": str(exc)}
        target = cwd.strip() if isinstance(cwd, str) else ""
        try:
            window_id = viewers.open(workspace=name, cwd=target or None)
        except WorkspaceClaimed as exc:
            return {
                "opened": False,
                "error": "workspace_claimed",
                "detail": str(exc),
                "workspace": exc.workspace,
                "owner": exc.owner.id,
            }
        except Exception as exc:
            log.warning("could not open a second window", exc_info=True)
            return {"opened": False, "error": "failed", "detail": str(exc)}
        return {"opened": True, "window_id": window_id, "workspace": name}

    def window_bounds(self) -> dict | None:
        """This window's size in pywebview logical units, for Settings'
        "Use this window's size". None when it cannot be read."""
        window = self._window
        if window is None:
            return None
        try:
            return {"width": int(window.width), "height": int(window.height)}
        except Exception:
            log.debug("window size unavailable", exc_info=True)
            return None

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
    argv = sys.argv[1:]
    # A verb (`quickterm ls`, `new`, `open`, `send`) drives the running app and
    # exits; nothing below runs for it. `new` with no app running starts this
    # program again, detached, with --handoff.
    if cli.is_command(argv):
        sys.exit(cli.run(argv))
    parser = argparse.ArgumentParser(prog="QuickTerm")
    parser.add_argument("--elevated-spec", help=argparse.SUPPRESS)
    parser.add_argument("--handoff", help=argparse.SUPPRESS)
    # The roles of pty_host.py: the backend, the window process, and a
    # launcher that starts the backend without asking it for a window.
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--viewer", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--background", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--window-id", help=argparse.SUPPRESS)
    parser.add_argument("--workspace", help=argparse.SUPPRESS)
    parser.add_argument("--cwd", help=argparse.SUPPRESS)
    parser.add_argument("--elevated", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int, help="override the local backend port")
    parser.add_argument(
        "path", nargs="?", help="open a terminal in this directory (Explorer 'Open QuickTerm here')"
    )
    args = parser.parse_args(argv)
    handoff = None
    if args.handoff is not None:
        try:
            handoff = _parse_handoff(args.handoff)
        except ValueError as exc:
            parser.error(f"--handoff: {exc}")
    open_dir = None
    if args.path:
        candidate = os.path.abspath(os.path.expanduser(args.path))
        if os.path.isdir(candidate):
            open_dir = candidate
    # The launch folder is captured above, so the process may leave it now.
    _harden_program_lookup()
    if sys.platform == "win32":
        _check_windows_build()
    from quickterm.config import load_config

    cfg = load_config()
    cfg.runtime_overrides = set()
    cfg.launch_error = None
    if args.port is not None:
        if not 0 <= args.port <= 65535:
            parser.error("--port must be between 0 and 65535")
        _override_port(cfg, _free_port(cfg.host) if args.port == 0 else args.port)
    if args.viewer:
        _setup_logging("viewer.log")
        if sys.platform != "win32":
            sys.exit("The window process exists only on Windows.")
        sys.exit(
            _run_viewer(
                cfg,
                window_id=args.window_id,
                workspace=args.workspace,
                cwd=args.cwd,
                elevated=args.elevated,
            )
        )
    initial_launch = None
    elevated = bool(args.elevated_spec)
    if args.elevated_spec:
        from quickterm.elevation import decode_spec

        initial_launch = decode_spec(args.elevated_spec)
        _override_port(cfg, _free_port(cfg.host))
    if sys.platform == "win32":
        if args.serve or elevated:
            _setup_logging()
            log.info("QuickTerm %s backend starting on %s:%s", __version__, cfg.host, cfg.port)
            # The elevated instance is its own backend, run in place, with its
            # one window; it ends with that window.
            code = _run_backend(
                cfg, initial_launch=initial_launch, elevated=elevated, handoff=handoff,
                open_viewer=elevated,
            )
        else:
            _setup_logging("launcher.log")
            code = _run_launcher(
                cfg, open_dir=open_dir, handoff=handoff, background=args.background,
                port_override=args.port,
            )
        if code:
            sys.exit(code)
        return
    _setup_logging()
    log.info("QuickTerm %s starting on %s:%s", __version__, cfg.host, cfg.port)
    # One ordinary backend: later launches hand work to it instead of starting
    # another one onto the same session set.
    if not elevated and _already_running(cfg.port, cfg.host):
        if open_dir:
            _queue_running_launch(cfg.port, open_dir, cfg.host)
        if handoff:
            # Another app came up between the verb's check and this one.
            failure = cli.post_launch(cfg.port, handoff, cfg.host)
            if failure:
                log.error("command-line launch handoff failed: %s", failure)
        _launch_window(cfg.port, cwd=open_dir, host=cfg.host)
        return
    try:
        asyncio.run(_serve(cfg, initial_launch=initial_launch, cwd=open_dir, handoff=handoff))
    except KeyboardInterrupt:
        pass


def _parse_handoff(text: str) -> dict[str, str]:
    """The launch `quickterm new` started this app for; /api/launches checks the rest."""
    value = json.loads(text)
    if (
        not isinstance(value, dict)
        or not value
        or not set(value) <= {"cwd", "profile", "workspace"}
        or not all(isinstance(item, str) for item in value.values())
    ):
        raise ValueError("expected a JSON object of cwd, profile and workspace strings")
    return value


def _harden_program_lookup() -> None:
    """Stop Windows program lookups from searching QuickTerm's own folder.

    CreateProcess with a bare name, and shutil.which, look in the current
    directory before PATH. "Open QuickTerm here" starts the app in the folder
    the user clicked (an untrusted clone, Downloads), and an elevated instance
    inherits that folder, so a taskkill.exe or pwsh.exe planted there ran
    instead of the real one. The launch folder travels explicitly as ?cwd=, so
    nothing needs the process to stay in it.

    NoDefaultCurrentDirectoryInExePath would say the same thing, but it is an
    environment variable: every terminal, the relaunched app after an update
    and VS Code opened from a pane would inherit it, and cmd.exe there would
    stop running programs from its own folder. Leaving the folder is enough.
    """
    if os.name != "nt":
        return
    for folder in (Path.home(), Path(os.environ.get("SystemRoot", r"C:\Windows"))):
        try:
            os.chdir(folder)
            return
        except (OSError, RuntimeError):
            continue
    log.warning("could not leave the launch folder")


def _override_port(cfg: "AppConfig", port: int) -> None:
    """Run on `port` without it ever reaching config.json.

    `runtime_overrides` names what this run changed on the live config; PUT
    /api/config guards exactly those names against a stale client writing the
    runtime value back, and nothing else.
    """
    cfg.port = port
    overrides = set(getattr(cfg, "runtime_overrides", None) or ())
    overrides.add("port")
    cfg.runtime_overrides = overrides


def _base_url(port: int, host: str = "127.0.0.1") -> str:
    return f"http://{client_host(host)}:{port}"


def _setup_logging(filename: str = "quickterm.log") -> None:
    """One file per process role: the backend, the window process and the
    launcher run at the same time, and a rotation renames a file the other
    process still holds open."""
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
        log_dir / filename, maxBytes=128 * 1024, backupCount=1, encoding="utf-8"
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


def _already_running(port: int, host: str = "127.0.0.1") -> bool:
    # Through the command line's probe: no proxy, and only a backend that
    # proves it holds this user's token counts as QuickTerm.
    try:
        return cli.probe(_base_url(port, host), timeout=0.6) == cli.QUICKTERM
    except Exception:
        return False


def _queue_running_launch(port: int, cwd: str, host: str = "127.0.0.1") -> bool:
    """Hand Explorer's folder launch to the already-running authenticated app."""
    for attempt in range(3):
        failure = cli.post_launch(port, {"cwd": cwd}, host, timeout=1.5)
        if failure is None:
            return True
        if attempt < 2:
            time.sleep(0.15)
    log.error("running-instance folder handoff failed: %s", failure)
    return False


def _check_windows_build() -> None:
    getver = getattr(sys, "getwindowsversion", None)
    if getver is None or getver().build < MIN_BUILD:
        sys.exit(
            f"QuickTerm requires Windows 10 1809 (build {MIN_BUILD}) or newer for ConPTY support."
        )


def _quiet_connection_resets(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    """Drop the one asyncio error that is not an error: a peer that is gone.

    On Windows the proactor loop shuts a socket down when it closes the
    connection, and when the peer (a WebView2 window that just closed, a
    browser tab) has already reset it, that shutdown raises and asyncio logs
    "Exception in callback _call_connection_lost" at ERROR, which reached the
    log on every quit. Everything else goes to the default handler.
    """
    exc = context.get("exception")
    handle = repr(context.get("handle", ""))
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError)) and "_call_connection_lost" in handle:
        return
    loop.default_exception_handler(context)


async def _serve(
    cfg: "AppConfig",
    *,
    ready_event: threading.Event | None = None,
    launch_window: bool = True,
    state: dict[str, Any] | None = None,
    initial_launch: dict[str, Any] | None = None,
    elevated: bool = False,
    cwd: str | None = None,
    windows: WindowRegistry | None = None,
    open_window: Callable[[str | None, str | None], str] | None = None,
    notify: Callable[[str, str, str, str | None], None] | None = None,
    handoff: dict[str, str] | None = None,
    summon: Callable[[], None] | None = None,
) -> None:
    from quickterm.session_manager import SessionManager
    from quickterm.ws_protocol import WebSocketProtocol

    from quickterm import auth

    _prepare_workspaces(elevated)
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(_quiet_connection_resets)
    manager = SessionManager(loop, cfg.scrollback_bytes, cfg.max_sessions)
    # Started before the app so its routes can rebind and suspend them.
    hotkeys = _start_hotkeys(loop, manager, cfg, summon=summon)
    try:
        app = create_app(
            manager,
            cfg,
            auth.get_or_create_token(),
            elevated=elevated,
            windows=windows,
            open_window=open_window,
            notify=notify,
            rebind_hotkeys=hotkeys.rebind if hotkeys is not None else None,
            suspend_hotkeys=hotkeys.suspend if hotkeys is not None else None,
        )
    except BaseException:
        if hotkeys is not None:
            hotkeys.stop()
        raise
    server = UvicornServer(
        UvicornConfig(
            app,
            host=cfg.host,
            port=cfg.port,
            loop="asyncio",
            http="h11",
            ws=WebSocketProtocol,
            lifespan="on",
            log_config=None,
            access_log=False,
            ws_max_size=256 * 1024,
            ws_max_queue=16,
            ws_per_message_deflate=False,
            # Without a bound uvicorn waits for every request in flight, and the
            # launch long-poll holds one for up to 20 s while a WebView2 process
            # that outlives its window keeps the socket open: the terminals
            # were stopped that much later than the port closed.
            timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
        )
    )
    if state is not None:
        state.update(server=server, loop=loop, manager=manager)
    boot = asyncio.ensure_future(
        _after_ready(
            server,
            manager,
            cfg,
            ready_event=ready_event,
            launch_window=launch_window,
            initial_launch=initial_launch,
            cwd=cwd,
            handoff=handoff,
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
    """The close-to-tray rule (pty_host.sessions_worth_keeping)."""
    return pty_host.sessions_worth_keeping(manager)


def attention_balloon(name: str, kind: str, text: str | None) -> tuple[str, str]:
    """Title and body of the tray balloon (pty_host.attention_balloon)."""
    return pty_host.attention_balloon(name, kind, text)


class _HostLink:
    """The window process's line to the backend's window registry.

    `owner_of` asks the registry over the authenticated API; `adopted` and
    `forget` go over the control channel, so the backend also knows which
    claims to drop when this process dies without saying goodbye. Without a
    channel (a viewer nobody started) a closed window frees its claim through
    the API instead.
    """

    def __init__(self, cfg: Any, channel: Any | None) -> None:
        self._cfg = cfg
        self._channel = channel

    def _client(self) -> cli.Client:
        return cli.Client(cli.base_url(self._cfg.port, self._cfg.host), timeout=5.0)

    def owner_of(self, workspace: str) -> WindowInfo | None:
        try:
            payload = self._client().call("GET", "/api/windows")
        except cli.CliError:
            log.debug("window registry unavailable", exc_info=True)
            return None
        windows = payload.get("windows") if isinstance(payload, dict) else None
        for item in windows if isinstance(windows, list) else []:
            if isinstance(item, dict) and item.get("workspace") == workspace:
                return WindowInfo(
                    id=str(item.get("id") or ""),
                    workspace=workspace,
                    title=str(item.get("title") or ""),
                    primary=bool(item.get("primary")),
                )
        return None

    def adopted(self, window_id: str) -> None:
        if self._channel is not None:
            self._channel.send({"event": "adopted", "window_id": window_id})

    def forget(self, window_id: str) -> None:
        if self._channel is not None and self._channel.send(
            {"event": "closed", "window_id": window_id}
        ):
            return
        try:
            self._client().call("DELETE", f"/api/windows/{urllib.parse.quote(window_id, safe='')}")
        except cli.CliError:
            log.debug("could not release a window claim", exc_info=True)


class _ViewerWindows:
    """Every native window this window process owns.

    Two lists of windows exist and they are deliberately not the same thing.
    `WindowRegistry` (in the backend) records what each window CLAIMS and
    expires an entry on a missed heartbeat, because a viewer can be a browser
    tab that dies without a word. This class records the native shells this
    process actually created: when the last one closes the process ends, and
    the backend, which sees it go, decides whether to stay in the tray. A
    window never hides on close any more; the terminals live in the backend.
    """

    def __init__(self, cfg: "AppConfig", registry: Any, *, base_title: str) -> None:
        self._cfg = cfg
        self._registry = registry
        self._base_title = base_title
        self._lock = threading.Lock()
        self._live: dict[str, Any] = {}  # pywebview uid -> window, oldest first
        self._ids: dict[str, str] = {}  # pywebview uid -> registry window id
        self.quitting = threading.Event()

    def adopt(self, window: Any, window_id: str) -> None:
        """Take ownership of a native window's lifetime and file drops."""
        uid = str(getattr(window, "uid", "") or window_id)
        with self._lock:
            self._live[uid] = window
            self._ids[uid] = window_id
        # Zero-argument lambda on purpose: pywebview inspects the handler
        # signature and only calls a no-parameter handler with no arguments.
        window.events.closed += lambda: self._on_closed(uid)
        _wire_native_file_drop(window)
        adopted = getattr(self._registry, "adopted", None)
        if adopted is not None:
            adopted(window_id)

    def count(self) -> int:
        with self._lock:
            return len(self._live)

    def open(
        self, *, workspace: str | None = None, cwd: str | None = None, check_claim: bool = True
    ) -> str:
        """Create another window onto the same backend. Returns its window id.

        `check_claim=False` when the backend already checked, because it asked.
        """
        if threading.current_thread() is threading.main_thread():
            # pywebview materialises a window at runtime only when
            # create_window is called off the main thread; from the main thread
            # it merely appends one that never appears, because webview.start()
            # is already running the GUI loop there.
            raise RuntimeError("a window cannot be opened from the main thread")
        name = normalize_workspace(workspace)
        if name is not None and check_claim:
            # Refuse before anything is drawn. Letting the window open and then
            # fail its claim would show the user an empty shell and no reason.
            owner = self._registry.owner_of(name)
            if owner is not None:
                raise WorkspaceClaimed(name, owner)
        import webview

        window_id = new_window_id()
        api = _DesktopApi(self)
        window = webview.create_window(
            window_title(self._base_title, name, primary=False),
            _window_url(
                self._cfg.port, cwd, host=self._cfg.host, workspace=name, window_id=window_id
            ),
            **self._secondary_geometry(),
            min_size=MIN_WINDOW_SIZE,
            background_color=WINDOW_BACKGROUND,
            js_api=api,
            text_select=True,
        )
        if window is None:
            raise RuntimeError("pywebview declined to create the window")
        api._bind_window(window)
        self.adopt(window, window_id)
        return window_id

    def _secondary_geometry(self) -> dict[str, int]:
        """The configured size, 32 px down and right of the primary when
        its position is known, so the new window does not hide it exactly."""
        settings = _window_cfg(self._cfg)
        geometry = {"width": settings.width, "height": settings.height}
        primary = next(
            (w for w in self._snapshot() if getattr(w, "title", None) == self._base_title), None
        )
        try:
            x, y = int(primary.x), int(primary.y)
        except Exception:
            return geometry
        candidate = {**geometry, "x": x + SECONDARY_OFFSET, "y": y + SECONDARY_OFFSET}
        # A minimized primary reports about -32000/-32000. Offsetting from that
        # would open the new window off every monitor, so only a position that
        # still meets a screen is used.
        from quickterm import window_state

        try:
            on_screen = window_state.clamp_to_screens(candidate, _screen_list())
        except Exception:
            log.debug("screens unavailable for the new window", exc_info=True)
            on_screen = None
        return candidate if on_screen is not None else geometry

    def show_all(self, *, skip_primary: bool = False) -> None:
        """Show and restore every window (tray Open, a second launch).

        The backend owns the drop-down overlay; when it already dropped the
        primary down it passes `skip_primary`. Runs on the control thread.
        """
        for window in self._snapshot():
            if skip_primary and getattr(window, "title", None) == self._base_title:
                continue
            _show_window(window)

    def quit_all(self) -> None:
        """Every window goes, and with the last one this process."""
        self.quitting.set()
        for window in self._snapshot():
            try:
                window.destroy()
            except Exception:
                log.debug("window destroy failed", exc_info=True)

    def _snapshot(self) -> list[Any]:
        with self._lock:
            return list(self._live.values())

    def _on_closed(self, uid: str) -> None:
        with self._lock:
            self._live.pop(uid, None)
            window_id = self._ids.pop(uid, None)
        if window_id:
            # Free the workspace claim now instead of waiting out the heartbeat
            # TTL: the user may well be reopening that workspace right away.
            self._registry.forget(window_id)
        self._promote_title()

    def _promote_title(self) -> None:
        """Keep exactly one live window holding the bare base title.

        hotkeys.py matches the window to summon by exact title, so closing the
        first window would otherwise leave the summon hotkey and the Explorer
        folder handoff with nothing to aim at.
        """
        if self.quitting.is_set():
            return
        live = self._snapshot()
        if not live:
            return
        if any(getattr(win, "title", None) == self._base_title for win in live):
            return
        try:
            live[0].set_title(self._base_title)
        except Exception:
            log.debug("could not promote a window title", exc_info=True)


# ---------------------------------------------------------------------------
# The launcher: find or start the backend, then ask it for a window
# ---------------------------------------------------------------------------


def _run_launcher(
    cfg: "AppConfig",
    *,
    open_dir: str | None = None,
    handoff: dict[str, str] | None = None,
    background: bool = False,
    port_override: int | None = None,
) -> int:
    """What a plain `QuickTerm.exe` does on Windows. Returns the exit code.

    The backend outlives this process; a backend that is already running gets
    the launch handed to it, exactly as a second launch always did. A backend
    of another build (an update was installed meanwhile) is replaced when no
    terminal would lose work, otherwise the user is asked.
    """
    started = False
    if _already_running(cfg.port, cfg.host):
        info = _host_info(cfg)
        if _should_hand_over(info):
            outcome = _hand_over(cfg, info or {}, handoff=handoff, port_override=port_override)
            if outcome == "failed":
                return 2
            started = outcome == "started"
    else:
        if not _start_backend(cfg, handoff=handoff, port_override=port_override):
            log.error("the QuickTerm backend did not start on %s:%s", cfg.host, cfg.port)
            return 2
        started = True
    if not started:
        if open_dir:
            _queue_running_launch(cfg.port, open_dir, cfg.host)
        if handoff:
            # Another app came up between the verb's check and this one.
            failure = cli.post_launch(cfg.port, handoff, cfg.host)
            if failure:
                log.error("command-line launch handoff failed: %s", failure)
    if not background:
        # A first window opens in the Explorer folder itself; a running one
        # already has the folder queued above.
        _summon_backend(cfg, cwd=open_dir if started else None)
    return 0


def _host_call(
    cfg: "AppConfig", method: str, path: str, body: Any = None
) -> tuple[int, Any]:
    """One call to the backend; (0, None) when it could not be made."""
    client = cli.Client(cli.base_url(cfg.port, cfg.host), timeout=15.0)
    try:
        return client.call_status(method, path, body)
    except cli.CliError:
        log.debug("backend call %s %s failed", method, path, exc_info=True)
        return 0, None


def _host_info(cfg: "AppConfig") -> dict[str, Any] | None:
    status, payload = _host_call(cfg, "GET", "/api/host")
    return payload if status == 200 and isinstance(payload, dict) else None


def _should_hand_over(info: dict[str, Any] | None) -> bool:
    """A frozen launcher meets a frozen backend of another, not newer, build."""
    if not info or not info.get("managed") or not info.get("frozen") or not pty_host.frozen():
        return False
    if info.get("build") == pty_host.running_build():
        return False
    from quickterm.update import is_newer

    # Never replace a newer backend with an older install.
    return not is_newer(str(info.get("version") or "0"), __version__)


def _hand_over(
    cfg: "AppConfig",
    info: dict[str, Any],
    *,
    handoff: dict[str, str] | None = None,
    port_override: int | None = None,
) -> str:
    """Replace the running backend with this build: "started", "kept" or "failed"."""
    status, payload = _host_call(cfg, "POST", "/api/host/retire", {"force": False})
    if status == 409:
        if info.get("superseded"):
            # The user already said no once; it leaves on its own when nothing
            # is at risk, and asking at every launch would be nagging.
            return "kept"
        sessions = payload.get("sessions") if isinstance(payload, dict) else None
        if not _ask_restart(str(info.get("version") or ""), sessions or []):
            log.info("update: the running backend keeps its terminals for now")
            return "kept"
        status, payload = _host_call(cfg, "POST", "/api/host/retire", {"force": True})
    if status != 202:
        log.warning("update: the running backend did not retire (%s)", status)
        return "kept"
    if not _wait_for_backend(cfg, running=False, timeout=BACKEND_RETIRE_S):
        log.warning("update: the old backend still answers; attaching to it")
        return "kept"
    if not _start_backend(cfg, handoff=handoff, port_override=port_override):
        log.error("update: the new backend did not start")
        return "failed"
    return "started"


def _ask_restart(old_version: str, sessions: list[Any]) -> bool:
    """Ask whether to stop the old version's terminals now. Windows only."""
    if os.name != "nt":
        return False
    names = []
    for item in sessions[:8]:
        if not isinstance(item, dict):
            continue
        label = str(item.get("name") or str(item.get("id") or "")[:8] or "a terminal")
        names.append(f"  {label}" + (" (running a program)" if item.get("busy") else ""))
    if len(sessions) > len(names):
        names.append(f"  and {len(sessions) - len(names)} more")
    text = (
        f"QuickTerm {__version__} is installed, but QuickTerm {old_version or 'the old version'} "
        "is still running these terminals:\n\n"
        + "\n".join(names)
        + "\n\nRestart QuickTerm now? These terminals will be closed.\n\n"
        "Choose No to keep them running. QuickTerm switches to the new version the next "
        "time none of them is in use."
    )
    try:
        import ctypes

        mb_yesno, mb_iconquestion, mb_setforeground, mb_topmost = 0x4, 0x20, 0x10000, 0x40000
        answer = ctypes.windll.user32.MessageBoxW(
            None, text, "QuickTerm update",
            mb_yesno | mb_iconquestion | mb_setforeground | mb_topmost,
        )
    except Exception:
        log.warning("could not ask about the update restart", exc_info=True)
        return False
    return answer == 6  # IDYES


def _backend_command(argv: list[str]) -> list[str]:
    """The backend's command line: frozen, from this build's copy under the
    host folder, so Setup can replace the program files while it runs."""
    if not pty_host.frozen():
        return pty_host.program_command(argv)
    exe = Path(sys.executable).resolve()
    try:
        build = pty_host.build_id(exe.parent, exe.name)
        root = pty_host.host_root()
        copy = pty_host.ensure_copy(exe.parent, root, build, exe_name=exe.name)
        pty_host.prune(root, build)
        return [str(copy), *argv]
    except OSError:
        # Running in place still works; only an update then has to stop it.
        log.warning("could not copy the backend; it runs from the install folder", exc_info=True)
        return [str(exe), *argv]


def _start_backend(
    cfg: "AppConfig",
    *,
    handoff: dict[str, str] | None = None,
    port_override: int | None = None,
) -> bool:
    """Start a detached backend and wait until it answers the verified probe."""
    argv = ["--serve"]
    if port_override is not None:
        argv += ["--port", str(cfg.port)]
    if handoff:
        argv += ["--handoff", json.dumps(handoff)]
    command = _backend_command(argv)
    try:
        process = pty_host.spawn_backend(command)
    except OSError:
        log.exception("could not start the QuickTerm backend")
        process = None
    if process is not None and _wait_for_backend(
        cfg, running=True, timeout=BACKEND_START_S, process=process
    ):
        return True
    copy = Path(command[0])
    if copy.name.lower() != pty_host.HOST_EXE.lower() or (
        process is not None and process.poll() is None
    ):
        return False
    # The copy died before it answered: a file in it may have been taken away
    # (antivirus quarantine). Throw it away so the next start copies afresh,
    # and start this once from the install folder instead.
    log.warning("the backend copy failed to start; running from the install folder")
    pty_host.discard(copy.parent)
    try:
        process = pty_host.spawn_backend([sys.executable, *argv])
    except OSError:
        log.exception("could not start the QuickTerm backend in place")
        return False
    return _wait_for_backend(cfg, running=True, timeout=BACKEND_START_S, process=process)


def _wait_for_backend(
    cfg: "AppConfig", *, running: bool, timeout: float, process: Any | None = None
) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        if _already_running(cfg.port, cfg.host) is running:
            return True
        if process is not None and process.poll() is not None:
            # Another launcher's backend may have won the port meanwhile.
            return _already_running(cfg.port, cfg.host) is running
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.1)


def _summon_backend(cfg: "AppConfig", cwd: str | None = None) -> None:
    """Ask the backend to show its windows, or to start its window process."""
    pty_host.allow_foreground()
    status, _payload = _host_call(cfg, "POST", "/api/host/summon", {"cwd": cwd} if cwd else {})
    if status == 200:
        return
    # A backend from before the PTY host has no such route; its window lives
    # in its own process and the cross-process summon still finds it.
    from quickterm.hotkeys import summon_window

    summon_window()


# ---------------------------------------------------------------------------
# The backend
# ---------------------------------------------------------------------------


def _stop_server(state: dict[str, Any]) -> None:
    server = state.get("server")
    loop = state.get("loop")
    if server is None or loop is None:
        state["exit_requested"] = True
        return
    try:
        loop.call_soon_threadsafe(setattr, server, "should_exit", True)
    except RuntimeError:
        pass


def _run_backend(
    cfg: "AppConfig",
    *,
    initial_launch: dict[str, Any] | None = None,
    elevated: bool = False,
    handoff: dict[str, str] | None = None,
    open_viewer: bool = False,
) -> int:
    """The process that owns the PTYs: server, hotkeys and tray, no window.

    Windows come from the window process it starts (pty_host.Host). The tray
    and the global hotkeys live here because they must keep working while no
    window exists: they are how the user gets one back, and a profile hotkey
    spawns its PTY here anyway.
    """
    if not elevated and _already_running(cfg.port, cfg.host):
        # Two launchers raced and the other backend won. Going on would discard
        # its scratch workspace at startup before failing to bind the port.
        log.info("a backend already runs on %s:%s", cfg.host, cfg.port)
        return 0
    title = ELEVATED_TITLE if elevated else TITLE
    registry = WindowRegistry()
    state: dict[str, Any] = {}
    host = pty_host.Host(
        cfg,
        registry,
        base_title=title,
        elevated=elevated,
        manager=lambda: state.get("manager"),
        request_exit=lambda: _stop_server(state),
    )
    pty_host.install(host)
    overlay_mod = None
    if os.name == "nt":
        from quickterm import overlay as overlay_mod

        overlay_mod.set_owner_pids(host.viewer_pids)
    tray = None
    if not elevated and os.name == "nt":
        try:
            from quickterm.tray import TrayIcon

            tray = TrayIcon(on_open=host.show, on_quit=host.quit)
            # start() reports whether an icon really exists. Staying resident
            # behind no icon would look like a crash.
            if tray.start() is False:
                log.warning("tray icon unavailable; the last window close will quit")
                tray.dispose()
                tray = None
            else:
                host.tray = tray
        except Exception:
            log.exception("tray unavailable; the last window close will quit")
            tray = None
    ready = threading.Event()

    def when_ready() -> None:
        if not ready.wait(60):
            return
        host.start_checks()
        if open_viewer:
            host.summon()

    threading.Thread(target=when_ready, name="host-ready", daemon=True).start()
    try:
        asyncio.run(
            _serve(
                cfg,
                ready_event=ready,
                launch_window=False,
                state=state,
                initial_launch=initial_launch,
                elevated=elevated,
                windows=registry,
                open_window=host.open_window,
                notify=host.notify_attention,
                handoff=handoff,
                summon=host.toggle,
            )
        )
    except KeyboardInterrupt:
        pass
    except Exception:
        log.exception("the backend failed")
        return 1
    finally:
        host.close()
        if tray is not None:
            tray.dispose()
        pty_host.install(None)
        if overlay_mod is not None:
            overlay_mod.set_owner_pids(None)
    return 0


# ---------------------------------------------------------------------------
# The window process
# ---------------------------------------------------------------------------


def _run_viewer(
    cfg: "AppConfig",
    *,
    window_id: str | None = None,
    workspace: str | None = None,
    cwd: str | None = None,
    elevated: bool = False,
    control: bool = True,
) -> int:
    """The native windows onto a running backend, on the main thread.

    The backend starts this process and talks to it over stdin and stdout
    (`control`); the process ends with its last window, or when the backend
    goes, because a window onto a dead backend shows only dead panes.
    """
    if sys.platform != "win32":
        return 2
    try:
        import webview
    except ImportError:
        log.exception("native WebView is unavailable")
        return 2
    channel = None
    if control:
        try:
            channel = pty_host.ViewerChannel()
        except OSError:
            log.warning("no control channel; running without the backend's commands")
    title = ELEVATED_TITLE if elevated else TITLE
    viewers = _ViewerWindows(cfg, _HostLink(cfg, channel), base_title=title)
    window_id = window_id or new_window_id()
    desktop_api = _DesktopApi(viewers)
    # Remembered bounds belong to the normal primary window. The administrator
    # window shares %APPDATA%, so it neither restores them nor records its own.
    geometry = (
        {"width": _window_cfg(cfg).width, "height": _window_cfg(cfg).height}
        if elevated else _initial_geometry(cfg, _screen_list)
    )
    try:
        name = normalize_workspace(workspace)
    except ValueError:
        name = None
    window = webview.create_window(
        title,
        _window_url(cfg.port, cwd, host=cfg.host, workspace=name, window_id=window_id, primary=True),
        **geometry,
        min_size=MIN_WINDOW_SIZE,
        background_color=WINDOW_BACKGROUND,
        js_api=desktop_api,
        text_select=True,
    )
    desktop_api._bind_window(window)
    viewers.adopt(window, window_id)
    if not elevated:
        _BoundsRecorder(
            window, cfg, initial=geometry, overlay_applied=lambda: _overlay_style(title)
        ).wire()

    def control_loop() -> None:
        if channel is None:
            return
        channel.send({"event": "ready"})
        _serve_viewer_control(channel, viewers)

    from quickterm.config import config_dir

    # Returns once the last window is destroyed; pywebview ends its GUI loop on
    # the last window, not on the first. control_loop runs on its own thread
    # once the loop is up, which is where runtime windows can be created.
    webview.start(
        control_loop,
        gui="edgechromium",
        private_mode=False,
        storage_path=str(config_dir() / "webview"),
    )
    return 0


def _serve_viewer_control(channel: Any, viewers: _ViewerWindows) -> None:
    """Run the backend's commands until it says quit or its pipe closes."""
    for message in channel.commands():
        op = message.get("op")
        if op == "open":
            request = message.get("request")
            try:
                window_id = viewers.open(
                    workspace=message.get("workspace"),
                    cwd=message.get("cwd") or None,
                    check_claim=False,
                )
            except WorkspaceClaimed as exc:
                channel.send({"event": "open_failed", "request": request,
                              "error": "workspace_claimed", "detail": str(exc)})
            except Exception as exc:
                log.warning("could not open a window", exc_info=True)
                channel.send({"event": "open_failed", "request": request,
                              "error": "failed", "detail": str(exc)})
            else:
                channel.send({"event": "opened", "request": request, "window_id": window_id})
        elif op == "show":
            viewers.show_all(skip_primary=bool(message.get("skip_primary")))
        elif op == "quit":
            break
    # A quit, or the backend is gone: either way nothing here is useful now.
    viewers.quit_all()


def _overlay_style(title: str) -> bool:
    """Whether this process's primary window is in drop-down style right now."""
    if os.name != "nt":
        return False
    try:
        from quickterm import overlay, tray

        found = tray.own_window(title)
        return bool(found) and overlay.looks_applied(found[0])
    except Exception:
        return False


def _show_window(window: Any) -> None:
    try:
        window.show()
        window.restore()
    except Exception:
        log.debug("window show failed", exc_info=True)


def _window_cfg(cfg: Any) -> Any:
    """`cfg.window` with every missing field at its spec default."""
    window = getattr(cfg, "window", None)
    return types.SimpleNamespace(
        **{name: getattr(window, name, default) for name, default in _WINDOW_DEFAULTS.items()}
    )


def _screen_list() -> list[Any]:
    """pywebview's monitors as a plain list.

    In pywebview 6 `webview.screens` is a module property: the value is a
    proxy around a list, and calling it raises TypeError. Older releases had a
    function. Iterate first and call only what cannot be iterated.
    """
    import webview

    screens = webview.screens
    try:
        return list(screens)
    except TypeError:
        return list(screens())


def _initial_geometry(cfg: Any, screens: Callable[[], Any]) -> dict[str, Any]:
    """create_window keywords for the primary window: the remembered bounds
    when they still meet a monitor, else the configured size."""
    from quickterm import window_state

    settings = _window_cfg(cfg)
    geometry: dict[str, Any] = {"width": settings.width, "height": settings.height}
    if not settings.remember_bounds:
        return geometry
    try:
        bounds = window_state.clamp_to_screens(window_state.load(), screens())
    except Exception:
        log.debug("remembered window bounds unavailable", exc_info=True)
        return geometry
    if bounds is None:
        return geometry
    return {
        "x": bounds["x"],
        "y": bounds["y"],
        "width": max(MIN_WINDOW_SIZE[0], bounds["width"]),
        "height": max(MIN_WINDOW_SIZE[1], bounds["height"]),
        "maximized": bounds["maximized"],
    }


class _BoundsRecorder:
    """Saves the primary window's bounds 500 ms after the last change.

    pywebview fires each event on a short thread of its own, so a resize can
    arrive before or after the maximize that caused it. The events therefore
    only set flags and restart the timer; the geometry is read from the
    window when the timer fires, once the burst has settled. The write runs on
    that `threading.Timer`, never on the GUI thread or the event loop.

    The saved size is the normal one: a maximized window keeps its last normal
    bounds plus the flag. Nothing is recorded while minimized or while the
    overlay owns the window.
    """

    _KEYS = ("x", "y", "width", "height")

    def __init__(
        self,
        window: Any,
        cfg: Any,
        *,
        initial: dict[str, Any] | None = None,
        delay: float = BOUNDS_SAVE_DELAY_S,
        save: Callable[[dict], None] | None = None,
        overlay_applied: Callable[[], bool] | None = None,
    ) -> None:
        self._window = window
        self._cfg = cfg
        self._delay = delay
        self._save = save
        self._overlay_applied = overlay_applied
        self._lock = threading.Lock()
        start = initial or {}
        self._normal = {key: start[key] for key in self._KEYS if isinstance(start.get(key), int)}
        self._maximized = bool(start.get("maximized"))
        self._minimized = False
        self._timer: threading.Timer | None = None

    def wire(self) -> None:
        events = self._window.events
        events.resized += self.changed
        events.moved += self.changed
        events.maximized += lambda: self._flags(maximized=True, minimized=False)
        events.restored += lambda: self._flags(maximized=False, minimized=False)
        if getattr(events, "minimized", None) is not None:
            events.minimized += lambda: self._flags(minimized=True)

    def changed(self, *_args: Any) -> None:
        if not self._overlay_on():
            self._schedule()

    def _flags(self, **flags: bool) -> None:
        with self._lock:
            self._maximized = flags.get("maximized", self._maximized)
            self._minimized = flags.get("minimized", self._minimized)
        self.changed()

    def _overlay_on(self) -> bool:
        if self._overlay_applied is not None:
            return self._overlay_applied()
        if os.name != "nt":
            return False
        from quickterm import overlay

        return overlay.is_applied()

    def _schedule(self) -> None:
        timer = threading.Timer(self._delay, self.flush)
        timer.daemon = True
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = timer
        timer.start()

    def _read(self) -> dict[str, int] | None:
        window = self._window
        try:
            return {
                "x": int(window.x),
                "y": int(window.y),
                "width": int(window.width),
                "height": int(window.height),
            }
        except Exception:
            return None

    def flush(self) -> None:
        if self._overlay_on() or not _window_cfg(self._cfg).remember_bounds:
            return
        with self._lock:
            minimized, maximized = self._minimized, self._maximized
        if minimized:
            return
        if not maximized:
            current = self._read()
            if current is None:
                return
            with self._lock:
                self._normal = current
        with self._lock:
            if len(self._normal) != len(self._KEYS):
                return
            bounds = {**self._normal, "maximized": maximized}
        try:
            if self._save is not None:
                self._save(bounds)
            else:
                from quickterm import window_state

                window_state.save(bounds)
        except Exception:
            log.debug("could not remember the window bounds", exc_info=True)


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


def _free_port(host: str = "127.0.0.1") -> int:
    # Probe the address family the server will bind: a port free on
    # 127.0.0.1 says nothing about ::1.
    address = client_host(host).strip("[]")
    if address == "localhost":
        address = "127.0.0.1"
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((address, 0))
        return int(sock.getsockname()[1])


def _window_url(
    port: int,
    cwd: str | None = None,
    *,
    host: str = "127.0.0.1",
    workspace: str | None = None,
    window_id: str | None = None,
    primary: bool = False,
) -> str:
    # The auth token rides in the URL fragment: the browser reads it client-side
    # and it is never sent to the server or written to any log. An optional cwd
    # query tells the frontend to open its first terminal in that directory
    # (Explorer "Open QuickTerm here"). `window` and `workspace` tell a second
    # window who it is and what it should claim; `primary` marks the one window
    # the Explorer handoff and the summon hotkey aim at.
    from quickterm import auth

    params: list[tuple[str, str]] = []
    if cwd:
        params.append(("cwd", cwd))
    if workspace:
        params.append(("workspace", workspace))
    if window_id:
        params.append(("window", window_id))
    if primary:
        params.append(("primary", "1"))
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    return f"{_base_url(port, host)}/{query}#t={auth.get_or_create_token()}"


async def _after_ready(
    server: UvicornServer,
    manager: "SessionManager",
    cfg: "AppConfig",
    *,
    ready_event: threading.Event | None = None,
    launch_window: bool = True,
    initial_launch: dict[str, Any] | None = None,
    cwd: str | None = None,
    handoff: dict[str, str] | None = None,
) -> None:
    while not server.started:
        await asyncio.sleep(0.05)
    if initial_launch:
        # The elevated instance's first terminal goes through the same
        # resolver as every other launch: its folder is checked and the PuTTY
        # tools land on its PATH.
        await _launch_terminal(
            manager,
            cfg,
            initial_launch.get("name") or initial_launch.get("cmd") or "",
            cmd=initial_launch.get("cmd"),
            args=initial_launch.get("args"),
            env=initial_launch.get("env"),
            name=initial_launch.get("name"),
            request_cwd=initial_launch.get("cwd"),
        )
    else:
        await _spawn_autostart(manager, cfg)
    if handoff:
        await _queue_startup_handoff(cfg, handoff)
    if ready_event is not None:
        ready_event.set()
    if launch_window:
        _launch_window(cfg.port, cwd=cwd, host=cfg.host)


async def _queue_startup_handoff(cfg: "AppConfig", handoff: dict[str, str]) -> None:
    """Queue the `quickterm new` this app was started for, through its own route.

    Posting to /api/launches runs the same checks as a launch handed to an app
    that was already up, and the window claims it like any other. Before the
    window opens, so a refusal lands in `launch_error`, which the window shows
    once it has booted.
    """
    failure = await asyncio.to_thread(cli.post_launch, cfg.port, handoff, cfg.host)
    if failure:
        _report_launch_failure(cfg, f"quickterm new: {failure}")


async def _reap_loop(manager: "SessionManager", cfg: "AppConfig") -> None:
    # Periodically clear background clutter: detached, silent sessions that no
    # saved workspace (scratch included) still references.
    while True:
        await asyncio.sleep(REAP_INTERVAL_S)
        try:
            # Everything in this pass is blocking: referenced_session_ids()
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
    import quickterm.workspace as workspace

    return manager.reap_idle(idle_timeout_s, workspace.referenced_session_ids())


def _prepare_workspaces(elevated: bool) -> None:
    if elevated:
        # An elevated instance is a second backend with its own window
        # registry. Sharing workspace files let both autosave one layout, and
        # its scratch discard deleted the normal instance's live scratch.json.
        # So it gets its own folder, before anything reads or deletes a file.
        import quickterm.workspace as workspace

        workspace.set_namespace("elevated")
    # The "scratch" workspace is ephemeral: it only mirrors the current scratch
    # layout during a run. Discard at startup too, so a crash can't leak it.
    _discard_scratch_workspace()


def _discard_scratch_workspace() -> None:
    """Drop the ephemeral "scratch" workspace file (never survives a run)."""
    try:
        import quickterm.workspace as workspace

        workspace.delete_workspace("scratch")
        for name in workspace.list_workspaces():
            saved = workspace.load_workspace(name)
            if saved is not None and getattr(saved, "temporary", False):
                workspace.delete_workspace(name)
    except Exception:
        log.debug("could not discard scratch workspace", exc_info=True)


async def _spawn_autostart(manager: "SessionManager", cfg: "AppConfig") -> None:
    for prof in list(cfg.profiles):
        if prof.autostart:
            await _launch_profile(manager, prof, cfg)


async def _launch_profile(manager: "SessionManager", prof: "Profile", cfg: "AppConfig") -> None:
    # Identical to a launch from the UI, because it is the same resolver: a
    # profile does not mean something else when a hotkey starts it.
    await _launch_terminal(manager, cfg, prof.name, profile=prof, name=prof.name)


async def _launch_terminal(
    manager: "SessionManager", cfg: "AppConfig", label: str, **request: Any
) -> None:
    """Resolve and spawn one terminal nobody is waiting on; report, never raise.

    Autostart, hotkeys and the elevated first terminal have no request to
    answer, so a failure used to vanish into `except Exception: pass`. It is
    logged and kept on the live config as `launch_error`, which the UI shows.
    """
    from quickterm.session_manager import SessionLimitError, SpawnError

    try:
        spec = await asyncio.to_thread(functools.partial(launch.resolve, cfg, **request))
        await manager.spawn_async(**spec.spawn_kwargs())
    except (launch.LaunchError, SpawnError, SessionLimitError) as exc:
        _report_launch_failure(cfg, launch.describe_failure(label, exc))
    except Exception as exc:
        # A broken profile must not take down startup or the hotkey thread.
        log.debug("terminal launch failed", exc_info=True)
        _report_launch_failure(cfg, launch.describe_failure(label, exc))


def _report_launch_failure(cfg: "AppConfig", message: str) -> None:
    cfg.launch_error = message
    log.warning("terminal launch failed: %s", message)


def hotkey_error_text(failed: list[str]) -> str | None:
    """`cfg.hotkey_error` for the bindings Windows refused, or None."""
    if not failed:
        return None
    if len(failed) == 1:
        return f"{failed[0]} is in use by another program"
    return f"{', '.join(failed)} are in use by other programs"


class _GlobalHotkeys:
    """The summon key and every profile key, registered with Windows.

    `rebind` and `suspend` are what PUT /api/config and
    POST /api/hotkeys/suspend call, through `asyncio.to_thread`: both wait for
    the hotkey thread.
    """

    def __init__(
        self,
        hotkeys_mod: Any,
        hk: Any,
        loop: asyncio.AbstractEventLoop,
        manager: "SessionManager",
        cfg: "AppConfig",
        *,
        summon: Callable[[], None] | None = None,
    ) -> None:
        self._mod = hotkeys_mod
        self._hk = hk
        self._loop = loop
        self._manager = manager
        self._cfg = cfg
        # The backend's Host.toggle: it also starts the window process when
        # there is no window to toggle.
        self._summon = summon
        self._lock = threading.Lock()

    def _entries(self, cfg: "AppConfig") -> tuple[list[Any], list[str]]:
        entry = self._mod.HotkeyEntry
        entries: list[Any] = []
        labels: list[str] = []
        for prof in cfg.profiles:
            if not prof.keybinding:
                continue
            entries.append(
                entry(prof.keybinding, _profile_callback(self._loop, self._manager, prof, cfg))
            )
            labels.append(f"{prof.keybinding} ({prof.name})")
        if cfg.summon_hotkey:
            toggle = self._mod.toggle_window
            # Reads the live overlay settings at press time, and runs on the
            # hotkey thread: the Win32 window work never touches the loop.
            press = self._summon or (lambda: toggle(TITLE, getattr(cfg, "overlay", None)))
            entries.append(entry(cfg.summon_hotkey, press, True))
            labels.append(cfg.summon_hotkey)
        return entries, labels

    def rebind(self, cfg: "AppConfig") -> None:
        """Register exactly the bindings `cfg` names; record what failed."""
        with self._lock:
            entries, labels = self._entries(cfg)
            results = self._hk.rebind(entries)
            # Only Windows has RegisterHotKey; elsewhere every result is False
            # and there is nothing worth reporting.
            failed = (
                [label for label, ok in zip(labels, results) if ok is False]
                if os.name == "nt"
                else []
            )
            cfg.hotkey_error = hotkey_error_text(failed)
            if failed:
                log.warning("global hotkey registration failed: %s", ", ".join(failed))

    def suspend(self, suspended: bool) -> None:
        if suspended:
            self._hk.suspend()
        else:
            self._hk.resume()

    def stop(self) -> None:
        self._hk.stop()


def _start_hotkeys(
    loop: asyncio.AbstractEventLoop,
    manager: "SessionManager",
    cfg: "AppConfig",
    *,
    summon: Callable[[], None] | None = None,
) -> _GlobalHotkeys | None:
    # lazy + guarded: a missing or broken hotkeys module never blocks startup
    try:
        import quickterm.hotkeys as hotkeys_mod

        hk = hotkeys_mod.HotkeyManager(loop)
        hotkeys = _GlobalHotkeys(hotkeys_mod, hk, loop, manager, cfg, summon=summon)
        # Windows refuses a combination another program already owns. That
        # used to fail silently and leave a tray-hidden window unreachable;
        # Settings renders cfg.hotkey_error next to the field instead.
        hotkeys.rebind(cfg)
        _wire_voice(hk, manager, cfg)
        if os.name == "nt":
            from quickterm import overlay

            hk.run_on_thread(
                lambda: overlay.install_foreground_watcher(lambda: getattr(cfg, "overlay", None)),
                on_exit=overlay.remove_foreground_watcher,
            )
        hk.start()
        return hotkeys
    except Exception:
        log.debug("global hotkeys unavailable", exc_info=True)
        return None


def _profile_callback(
    loop: asyncio.AbstractEventLoop, manager: "SessionManager", prof: "Profile", cfg: "AppConfig"
) -> Callable[[], None]:
    # HotkeyManager runs callbacks on the loop thread; the launch itself
    # resolves off the loop, so the callback only schedules it.
    binding = prof.keybinding

    def fire() -> None:
        # The profile as it is now: a save that edits the profile but keeps its
        # key does not rebind, and must not leave the old command bound.
        current = next((p for p in cfg.profiles if p.keybinding == binding), prof)
        task = loop.create_task(_launch_profile(manager, current, cfg))
        _launch_tasks.add(task)
        task.add_done_callback(_launch_tasks.discard)

    return fire


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


def _launch_window(port: int, cwd: str | None = None, host: str = "127.0.0.1") -> None:
    url = _window_url(port, cwd, host=host)
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
