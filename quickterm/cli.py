"""The `quickterm` command line: verbs that drive the running app over HTTP.

`quickterm ls`, `new`, `open` and `send` talk to the backend of the running
app with the per-install token, the same way the Explorer handoff does. Only
the standard library: `app.main()` asks `is_command()` first and hands the
rest to `run()`, which returns the exit code. `new` with no app running starts
one as a detached process, so the shell it was typed in is never tied to it.

Exit codes: 0 success, 1 usage error (including a session name that matches
nothing or more than one session), 2 QuickTerm is not running (or something
else answers on its port), 3 the app refused the request or the request
failed after QuickTerm answered (the reason is printed).

The token is sent only to a backend that has proved it holds it: the health
check carries a fresh nonce, and the answer must include the HMAC of that
nonce under the token. On a shared machine another user can bind the port
first; that program then sees neither the token nor the text of a `send`.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import http.client
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
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
# How long `new` waits for an app it started to answer.
_START_WAIT_S = 20.0
_START_POLL_S = 0.25

# What a health check found on the port.
ABSENT = "absent"
QUICKTERM = "quickterm"
IMPOSTOR = "impostor"

# Every call here goes to loopback, so no proxy may see it. Plain urlopen
# honours HTTP_PROXY, and on Windows a system proxy whose override list is
# only <local>, which CPython applies to dotless host names and not to
# 127.0.0.1: an intercepting proxy then logged the token and every `send`,
# and a corporate one made every verb look like "not running". update.py
# keeps the default opener, because GitHub must go through the proxy.
_LOOPBACK = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open(request: str | urllib.request.Request, timeout: float) -> Any:
    return _LOOPBACK.open(request, timeout=timeout)


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


class CliError(Exception):
    pass


class NotRunning(CliError):
    """Nothing answered the health check: refused, or no answer in time."""


class Impostor(CliError):
    """Something answered on the port without proving it holds the token."""


class Refused(CliError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Failed(CliError):
    """QuickTerm answered the health check, then the request itself failed."""


def is_command(argv: list[str]) -> bool:
    """True when argv is a verb or --version rather than the app's own arguments.

    Explorer always passes an absolute folder ("%V"), so a bare verb is never
    a folder. Checking for a folder of that name in the current directory
    made `quickterm new` in a project with a new/ folder start the app parser
    instead.
    """
    return bool(argv) and (argv[0] == "--version" or argv[0] in VERBS)


def run(argv: list[str]) -> int:
    """Run one verb and return its exit code. Never raises."""
    release = _attach_parent_console()
    _utf8_streams()
    try:
        code = _run(argv)
    except _Exit as exc:
        code = exc.code
    except KeyboardInterrupt:
        code = EXIT_USAGE
    except Exception as exc:
        # The last resort for a promise the exit codes make: something went
        # wrong after the arguments parsed, which is a failed request.
        print(f"quickterm: {exc}", file=sys.stderr)
        code = EXIT_REFUSED
    finally:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except (AttributeError, OSError, ValueError):
                pass
        release()
    return code


def _run(argv: list[str]) -> int:
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
    handler: Callable[[Client, argparse.Namespace], int] = args.handler
    try:
        return handler(client, args)
    except NotRunning:
        print(f"quickterm: QuickTerm is not running on {client.base}.", file=sys.stderr)
        return EXIT_NOT_RUNNING
    except Impostor:
        print(_impostor_message(client.base), file=sys.stderr)
        return EXIT_NOT_RUNNING
    except Refused as exc:
        print(f"quickterm: {exc.detail}", file=sys.stderr)
        return EXIT_REFUSED
    except Failed as exc:
        print(f"quickterm: the request failed: {exc}", file=sys.stderr)
        return EXIT_REFUSED


def _impostor_message(base: str) -> str:
    return (
        f"quickterm: something else answers on {base} and it is not this user's "
        "QuickTerm, so nothing was sent to it."
    )


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

    open_ = verb("open", "Show a workspace in the running app.", _open_workspace)
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


def _new(client: Client, args: argparse.Namespace) -> int:
    body = new_launch(args)
    try:
        client.call("POST", "/api/launches", body)
    except NotRunning:
        # Only a health check nobody answered lands here. A failure after
        # QuickTerm answered is a Failed or a Refused: starting a second app
        # then would repeat the launch.
        return _start_app(client, app_arguments(body, args.port))
    _summon()
    return EXIT_OK


def app_arguments(body: dict[str, str], port: int | None) -> list[str]:
    """What the started app's own parser gets for this launch.

    A folder alone rides the positional argument, exactly like Explorer's
    "Open QuickTerm here", so it opens as the first terminal instead of beside
    one. Anything else goes through the hidden --handoff, which the app queues
    through its own /api/launches once its backend is up.
    """
    argv = [body["cwd"]] if set(body) == {"cwd"} else ["--handoff", json.dumps(body)]
    if port is not None:
        argv += ["--port", str(port)]
    return argv


def app_command(argv: list[str]) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *argv]
    return [sys.executable, "-c", "from quickterm.app import main; main()", *argv]


def _spawn_app(command: list[str]) -> Any:
    """Start the app detached from this process, its console and its signals.

    Running it inside the command-line process tied it to the shell: `start
    /wait` or a PowerShell pipe blocked for the app's lifetime, and Ctrl+C or
    closing the tab of a console launcher ended QuickTerm and every session.
    """
    options: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if sys.platform == "win32":
        options["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        options["start_new_session"] = True
    return subprocess.Popen(command, **options)


def _start_app(client: Client, argv: list[str]) -> int:
    try:
        process = _spawn_app(app_command(argv))
    except OSError as exc:
        print(f"quickterm: could not start QuickTerm: {exc}", file=sys.stderr)
        return EXIT_NOT_RUNNING
    deadline = time.monotonic() + _START_WAIT_S
    while True:
        state = client.probe()
        if state == QUICKTERM:
            _summon()
            return EXIT_OK
        if state == IMPOSTOR:
            print(_impostor_message(client.base), file=sys.stderr)
            return EXIT_NOT_RUNNING
        # An app that exits has either handed the launch to one that came up
        # meanwhile (the probe above finds it next time) or failed to start.
        exited = process.poll() is not None
        if exited or time.monotonic() >= deadline:
            if client.probe() == QUICKTERM:
                return EXIT_OK
            print(
                f"quickterm: QuickTerm did not start on {client.base}.", file=sys.stderr
            )
            return EXIT_NOT_RUNNING
        time.sleep(_START_POLL_S)


def _open_workspace(client: Client, args: argparse.Namespace) -> int:
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


def base_url(port: int, host: str = "127.0.0.1") -> str:
    return f"http://{_client_host(host)}:{port}"


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


def health_proof(token: str, nonce: str) -> str:
    """What /api/health?challenge=<nonce> must answer as `proof`."""
    return hmac.new(token.encode("utf-8"), nonce.encode("utf-8"), hashlib.sha256).hexdigest()


def _local_token() -> str:
    from quickterm import auth

    return auth.get_or_create_token()


def probe(base: str, token: Callable[[], str] = _local_token, timeout: float | None = None) -> str:
    """ABSENT, QUICKTERM or IMPOSTOR for whatever listens at `base`.

    ABSENT is only a refused connection or no answer in time. Anything that
    answers but cannot prove it holds this user's token is an IMPOSTOR, and
    it never receives the token: the proof is checked here, locally.
    """
    nonce = secrets.token_urlsafe(24)
    url = f"{base}/api/health?challenge={nonce}"
    try:
        with _open(url, _HEALTH_TIMEOUT_S if timeout is None else timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError:
        return IMPOSTOR
    except http.client.HTTPException:
        return IMPOSTOR
    except OSError:
        return ABSENT
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        return IMPOSTOR
    if not isinstance(data, dict) or data.get("app") != "quickterm":
        return IMPOSTOR
    proof = data.get("proof")
    if not isinstance(proof, str) or not hmac.compare_digest(proof, health_proof(token(), nonce)):
        return IMPOSTOR
    return QUICKTERM


class Client:
    def __init__(
        self, base: str, token: Callable[[], str] = _local_token, timeout: float = _TIMEOUT_S
    ) -> None:
        self.base = base
        self._token = token
        self._timeout = timeout
        self._checked = False

    @classmethod
    def from_config(cls, port: int | None = None) -> Client:
        host, configured = configured_endpoint()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("--port must be between 1 and 65535")
        return cls(base_url(port or configured, host))

    def probe(self) -> str:
        state = probe(self.base, self._token)
        self._checked = state == QUICKTERM
        return state

    def _ensure_running(self) -> None:
        if self._checked:
            return
        state = self.probe()
        if state == ABSENT:
            raise NotRunning()
        if state == IMPOSTOR:
            raise Impostor()

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
            with _open(request, self._timeout) as resp:
                payload = resp.read()
        except urllib.error.HTTPError as exc:
            raise Refused(exc.code, _detail(exc)) from None
        except (OSError, http.client.HTTPException) as exc:
            raise Failed(str(exc) or type(exc).__name__) from exc
        if not payload:
            return None
        try:
            return json.loads(payload.decode("utf-8"))
        except ValueError:
            return None


def _detail(exc: urllib.error.HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", "replace")
    except (OSError, http.client.HTTPException):
        raw = ""
    try:
        payload = json.loads(raw)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("detail"):
        return str(payload["detail"])
    return raw.strip() or f"the app answered {exc.code}"


def post_launch(
    port: int, launch: dict, host: str = "127.0.0.1", timeout: float = _TIMEOUT_S
) -> str | None:
    """Queue one launch on the app at host:port. None on success, else why not.

    app.py uses it for the Explorer folder and for a `new` it was started
    with, so every launch goes through the same checks and the same verified,
    proxy-free connection.
    """
    client = Client(base_url(port, host), timeout=timeout)
    try:
        client.call("POST", "/api/launches", launch)
    except NotRunning:
        return "the app did not answer"
    except Impostor:
        return "something else answers on that port"
    except Refused as exc:
        return exc.detail
    except Failed as exc:
        return str(exc)
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
