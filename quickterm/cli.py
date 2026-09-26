"""The `quickterm` command line: verbs that drive the running app over HTTP.

`quickterm ls`, `new`, `open` and `send` talk to the backend of the running
app with the per-install token, the same way the Explorer handoff does. Only
the standard library, and nothing here starts the app: `app.main()` asks
`is_command()` first and hands the rest to `run()`, which returns an exit code,
or a `StartApp` when `new` found no app to hand its launch to.

Exit codes: 0 success, 1 usage error (including a session name that matches
nothing or more than one session), 2 the app is not running, 3 the app
refused the request (its detail is printed).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, TextIO

VERBS = ("ls", "new", "open", "send")

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_NOT_RUNNING = 2
EXIT_REFUSED = 3

# The long list call takes a process snapshot on Windows; everything else is
# a queue put or a PTY enqueue.
_TIMEOUT_S = 10.0
_HEALTH_TIMEOUT_S = 1.0


@dataclass
class StartApp:
    """`new` found no running app: start it, and hand it this launch once it is up.

    `argv` is what the app's own parser gets. A launch that is only a folder
    rides the existing positional argument, exactly like Explorer's "Open
    QuickTerm here"; anything else becomes `handoff`, queued after startup.
    """

    argv: list[str] = field(default_factory=list)
    handoff: dict[str, str] | None = None


class _Exit(Exception):
    def __init__(self, code: int) -> None:
        super().__init__(code)
        self.code = code


class _Parser(argparse.ArgumentParser):
    """argparse, but a usage error exits 1 like every other usage error here."""

    def exit(self, status: int = 0, message: str | None = None) -> Any:
        if message:
            sys.stderr.write(message)
        raise _Exit(status)

    def error(self, message: str) -> Any:
        self.print_usage(sys.stderr)
        sys.stderr.write(f"{self.prog}: error: {message}\n")
        raise _Exit(EXIT_USAGE)


class NotRunning(Exception):
    pass


class Refused(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def is_command(argv: list[str]) -> bool:
    """True when argv is a verb or --version rather than the app's own arguments.

    Explorer passes an absolute folder as the only argument, so a verb counts
    only when it is not also an existing folder: a folder named "ls" opened
    from Explorer still opens the folder.
    """
    if not argv:
        return False
    first = argv[0]
    if first == "--version":
        return True
    return first in VERBS and not os.path.isdir(first)


def run(argv: list[str]) -> int | StartApp:
    """Run one verb. Never raises; returns the exit code or a StartApp."""
    release = _attach_parent_console()
    _utf8_streams()
    try:
        outcome = _run(argv)
    except _Exit as exc:
        outcome = exc.code
    except KeyboardInterrupt:
        outcome = EXIT_USAGE
    finally:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (AttributeError, OSError, ValueError):
                pass
    if isinstance(outcome, StartApp):
        # The app must not stay attached to the console the command was typed
        # in: pty_session hides the console it finds (it expects its own
        # hidden one), and closing that terminal would end the app.
        release()
    return outcome


def _run(argv: list[str]) -> int | StartApp:
    if argv and argv[0] == "--version":
        from quickterm import __version__

        print(f"QuickTerm {__version__}")
        return EXIT_OK
    args = _parser().parse_args(argv)
    try:
        client = Client.from_config(args.port)
    except ValueError as exc:
        print(f"quickterm: {exc}", file=sys.stderr)
        return EXIT_USAGE
    handler: Callable[[Client, argparse.Namespace], int | StartApp] = args.handler
    try:
        return handler(client, args)
    except NotRunning:
        print(f"quickterm: QuickTerm is not running on {client.base}.", file=sys.stderr)
        return EXIT_NOT_RUNNING
    except Refused as exc:
        print(f"quickterm: {exc.detail}", file=sys.stderr)
        return EXIT_REFUSED


def _parser() -> _Parser:
    parser = _Parser(
        prog="quickterm",
        description="Drive the running QuickTerm app.",
        epilog="Run 'quickterm' with no verb to start the app.",
    )
    verbs = parser.add_subparsers(dest="verb", required=True, parser_class=_Parser)

    def verb(name: str, help_text: str, handler: Callable[..., Any]) -> _Parser:
        sub = verbs.add_parser(name, help=help_text, description=help_text)
        sub.add_argument("--port", type=int, help="the app's port (default: from the config)")
        sub.set_defaults(handler=handler)
        return sub

    ls = verb("ls", "List the terminals the app runs.", _ls)
    ls.add_argument("--json", action="store_true", help="print the raw session list")

    new = verb("new", "Open a new terminal in the running app, or start the app with it.", _new)
    new.add_argument("--profile", help="the terminal profile to start")
    new.add_argument(
        "--cwd", help="the starting folder (default: this folder, unless --profile is given)"
    )
    new.add_argument("--workspace", help="the workspace to open it in")

    open_ = verb("open", "Show a workspace in the running app.", _open)
    open_.add_argument("workspace", help="the workspace name")

    send = verb("send", "Type text into a terminal.", _send)
    send.add_argument("session", help="a session id prefix or its exact name")
    send.add_argument("text", nargs="+", help="the text, joined with single spaces")
    send.add_argument("--enter", action="store_true", help="press Enter after the text")
    return parser


# --- verbs -------------------------------------------------------------------


def _ls(client: Client, args: argparse.Namespace) -> int:
    sessions = client.call("GET", "/api/sessions")
    if not isinstance(sessions, list):
        sessions = []
    if args.json:
        print(json.dumps(sessions, indent=2, ensure_ascii=False))
        return EXIT_OK
    rows = [_ls_row(item) for item in sessions if isinstance(item, dict)]
    widths = [max((len(row[col]) for row in rows), default=0) for col in range(4)]
    for row in rows:
        cells = [row[col].ljust(widths[col]) for col in range(4)]
        print("  ".join([*cells, row[4]]).rstrip())
    return EXIT_OK


def session_state(item: dict) -> str:
    if not item.get("alive"):
        code = item.get("exit_code")
        return "exited" if code is None else f"exited {code}"
    return "busy" if item.get("busy") else "live"


def _ls_row(item: dict) -> list[str]:
    return [
        str(item.get("id") or "")[:8],
        str(item.get("name") or "-"),
        str(item.get("workspace") or "-"),
        session_state(item),
        str(item.get("cwd") or "-"),
    ]


def new_launch(args: argparse.Namespace) -> dict[str, str]:
    """The handoff body for `new`.

    Without --cwd a profile starts in the workspace root, as a profile does
    everywhere else; without a profile either, the terminal starts in the
    folder the command was typed in, which is what "new terminal" means from
    a shell.
    """
    body: dict[str, str] = {}
    if args.profile:
        body["profile"] = args.profile
    if args.cwd:
        body["cwd"] = os.path.abspath(os.path.expanduser(args.cwd))
    elif not args.profile:
        body["cwd"] = os.getcwd()
    if args.workspace:
        body["workspace"] = args.workspace
    return body


def _new(client: Client, args: argparse.Namespace) -> int | StartApp:
    body = new_launch(args)
    try:
        client.call("POST", "/api/launches", body)
    except NotRunning:
        port = ["--port", str(args.port)] if args.port is not None else []
        if set(body) == {"cwd"}:
            return StartApp(argv=[body["cwd"], *port])
        return StartApp(argv=port, handoff=body)
    _summon()
    return EXIT_OK


def _open(client: Client, args: argparse.Namespace) -> int:
    client.call("POST", "/api/launches", {"workspace": args.workspace})
    _summon()
    return EXIT_OK


def _send(client: Client, args: argparse.Namespace) -> int:
    sessions = client.call("GET", "/api/sessions?metrics=false")
    listed = sessions if isinstance(sessions, list) else []
    matches, candidates = match_session(listed, args.session)
    if len(matches) != 1:
        what = "matches no session" if not matches else f"matches {len(matches)} sessions"
        print(f"quickterm: '{args.session}' {what}.", file=sys.stderr)
        if candidates:
            print("Candidates:", file=sys.stderr)
            for item in candidates:
                print("  " + "  ".join(_ls_row(item)[:4]), file=sys.stderr)
        return EXIT_USAGE
    sid = str(matches[0]["id"])
    client.call(
        "POST",
        f"/api/sessions/{urllib.parse.quote(sid, safe='')}/input",
        {"text": " ".join(args.text), "enter": bool(args.enter)},
    )
    return EXIT_OK


def match_session(sessions: list, wanted: str) -> tuple[list[dict], list[dict]]:
    """Sessions `wanted` names, and the ones to list when that is not exactly one.

    An exact id wins outright; otherwise every id with that prefix and every
    session with exactly that name is a match.
    """
    items = [item for item in sessions if isinstance(item, dict) and item.get("id")]
    exact = [item for item in items if item["id"] == wanted]
    if exact:
        return exact, exact
    matches = [
        item for item in items
        if (wanted and str(item["id"]).startswith(wanted)) or item.get("name") == wanted
    ]
    return matches, (matches if matches else items)


def _summon() -> None:
    """Bring the app's window forward, as a second launch from Explorer does."""
    if sys.platform != "win32":
        return
    try:
        from quickterm.hotkeys import summon_window

        summon_window()
    except Exception:
        pass


# --- HTTP ---------------------------------------------------------------------


def _client_host(host: str) -> str:
    # server.client_host, repeated because importing quickterm.server pulls in
    # FastAPI, which a one-shot command line does not need.
    if host in ("", "0.0.0.0"):
        return "127.0.0.1"
    if host == "::":
        return "[::1]"
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def configured_endpoint() -> tuple[str, int]:
    """Host and port from config.json, read only.

    load_config() would write: it creates a missing file, moves a broken one
    aside and re-encrypts plaintext secrets, none of which a query should do.
    """
    from quickterm.config import AppConfig, config_dir

    defaults = AppConfig()
    host, port = defaults.host, defaults.port
    try:
        raw = json.loads((config_dir() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return host, port
    if isinstance(raw, dict):
        if isinstance(raw.get("host"), str) and raw["host"].strip():
            host = raw["host"].strip()
        if isinstance(raw.get("port"), int) and not isinstance(raw.get("port"), bool):
            port = raw["port"]
    return host, port


class Client:
    def __init__(self, base: str, token: Callable[[], str]) -> None:
        self.base = base
        self._token = token
        self._checked = False

    @classmethod
    def from_config(cls, port: int | None = None) -> Client:
        host, configured = configured_endpoint()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("--port must be between 1 and 65535")

        def token() -> str:
            from quickterm import auth

            return auth.get_or_create_token()

        return cls(f"http://{_client_host(host)}:{port or configured}", token)

    def _ensure_running(self) -> None:
        # The port may belong to something else entirely, which would answer
        # the token-gated call with its own 404 and read as a refusal.
        if self._checked:
            return
        try:
            health = f"{self.base}/api/health"
            with urllib.request.urlopen(health, timeout=_HEALTH_TIMEOUT_S) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (OSError, ValueError) as exc:
            raise NotRunning() from exc
        if not isinstance(data, dict) or data.get("app") != "quickterm":
            raise NotRunning()
        self._checked = True

    def call(self, method: str, path: str, body: Any = None) -> Any:
        self._ensure_running()
        headers = {"X-QuickTerm-Token": self._token()}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as exc:
            raise Refused(exc.code, _detail(exc)) from None
        except OSError as exc:
            raise NotRunning() from exc
        if not payload:
            return None
        try:
            return json.loads(payload.decode("utf-8"))
        except ValueError:
            return None


def _detail(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except OSError:
        raw = ""
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("detail"):
        return str(payload["detail"])
    return raw.strip() or f"the app answered {exc.code}"


def post_launch(port: int, launch: dict, host: str = "127.0.0.1") -> str | None:
    """Queue one launch on the app at host:port. None on success, else why not.

    app.py uses it to queue a `new` it was started for, once its own backend
    is up, so the launch goes through the same checks as every other one.
    """
    from quickterm import auth

    client = Client(f"http://{_client_host(host)}:{port}", auth.get_or_create_token)
    try:
        client.call("POST", "/api/launches", launch)
    except NotRunning:
        return "the app did not answer"
    except Refused as exc:
        return exc.detail
    return None


# --- console ------------------------------------------------------------------


def _utf8_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def _attach_parent_console() -> Callable[[], None]:
    """Give a console-less build somewhere to print; returns how to let go of it.

    The frozen Windows build is a GUI-subsystem exe, so it starts with no
    console and sys.stdout is None. Attaching to the console of the process
    that ran it (cmd, PowerShell) makes the output appear where the command
    was typed. Without one, output goes nowhere and only the exit code
    remains. A stream that does exist (output piped into another program) is
    left alone, so `quickterm ls --json | ...` still reads it.
    """
    if sys.platform != "win32" or (sys.stdout is not None and sys.stderr is not None):
        return lambda: None
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    previous = (sys.stdout, sys.stderr)
    attach_parent_process = 0xFFFFFFFF  # (DWORD)-1
    attached = bool(kernel32.AttachConsole(attach_parent_process))
    stream: TextIO | None = None
    if attached:
        try:
            # "CONOUT$" opens the console itself, which Python writes as
            # UTF-16, so non-ASCII names survive any console code page.
            stream = open("CONOUT$", "w", encoding="utf-8")
        except OSError:
            stream = None
    if stream is None:
        stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream

    def release() -> None:
        sys.stdout, sys.stderr = previous
        try:
            stream.close()
        except OSError:
            pass
        if attached:
            kernel32.FreeConsole()

    return release
