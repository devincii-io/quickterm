"""The `quickterm` command line against a stand-in backend on a free port."""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from quickterm import cli

SESSIONS = [
    {
        "id": "a1b2c3d4e5f6", "name": "pwsh", "workspace": "dev", "alive": True,
        "busy": False, "exit_code": None, "cwd": "C:\\src\\dev",
    },
    {
        "id": "a1ffee000000", "name": "build", "workspace": None, "alive": True,
        "busy": True, "exit_code": None, "cwd": None,
    },
    {
        "id": "99aa00000000", "name": "pwsh", "workspace": None, "alive": False,
        "busy": False, "exit_code": 3, "cwd": "/tmp",
    },
]


class Backend:
    """What the app answers: /api/health, the session list, launches, input."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict | None, str | None]] = []
        self.refuse: tuple[int, dict | str] | None = None
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _answer(self, status, payload=None):
                data = b""
                if isinstance(payload, (dict, list)):
                    data = json.dumps(payload).encode()
                elif isinstance(payload, str):
                    data = payload.encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                token = self.headers.get("X-QuickTerm-Token")
                if self.path == "/api/health":
                    return self._answer(200, {"app": "quickterm", "version": "x"})
                backend.requests.append((method, self.path, body, token))
                if backend.refuse is not None:
                    return self._answer(*backend.refuse)
                if self.path.startswith("/api/sessions") and method == "GET":
                    return self._answer(200, SESSIONS)
                if self.path == "/api/launches":
                    return self._answer(200, body)
                if self.path.endswith("/input"):
                    return self._answer(204)
                return self._answer(404, {"detail": "Not Found"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    # The token file lives under %APPDATA%/quickterm; never the real one.
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    # Summoning would raise the developer's own QuickTerm window.
    summoned: list[bool] = []
    monkeypatch.setattr(cli, "_summon", lambda: summoned.append(True))
    # Windows retries a refused loopback connect for about two seconds; the
    # "not running" answers need not wait for that here.
    monkeypatch.setattr(cli, "_HEALTH_TIMEOUT_S", 0.2)
    return summoned


@pytest.fixture
def backend():
    server = Backend()
    yield server
    server.close()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _run(capsys, *argv):
    code = cli.run(list(argv))
    out, err = capsys.readouterr()
    return code, out, err


# --- when argv is a verb ---------------------------------------------------------------


def test_only_verbs_and_version_are_commands(tmp_path, monkeypatch):
    assert cli.is_command(["ls"])
    assert cli.is_command(["send", "x", "y"])
    assert cli.is_command(["--version"])
    assert not cli.is_command([])
    assert not cli.is_command([str(tmp_path)])
    assert not cli.is_command(["--port", "8641"])
    assert not cli.is_command(["list"])


def test_a_folder_named_like_a_verb_still_opens_the_folder(tmp_path, monkeypatch):
    (tmp_path / "open").mkdir()
    monkeypatch.chdir(tmp_path)
    assert not cli.is_command(["open"])
    assert cli.is_command(["ls"])


def test_version(capsys):
    from quickterm import __version__

    code, out, _err = _run(capsys, "--version")
    assert code == 0
    assert out.strip() == f"QuickTerm {__version__}"


def test_usage_errors_exit_1(capsys):
    code, _out, err = _run(capsys, "send", "only-a-session")
    assert code == cli.EXIT_USAGE
    assert "usage:" in err
    assert _run(capsys, "ls", "--bogus")[0] == cli.EXIT_USAGE
    assert _run(capsys, "ls", "--port", "70000")[0] == cli.EXIT_USAGE


def test_help_exits_0(capsys):
    code, out, _err = _run(capsys, "new", "--help")
    assert code == 0
    assert "--profile" in out


# --- ls -------------------------------------------------------------------------------


def test_ls_prints_one_line_per_session(capsys, backend):
    code, out, _err = _run(capsys, "ls", "--port", str(backend.port))
    assert code == 0
    lines = out.splitlines()
    assert len(lines) == 3
    assert lines[0].split() == ["a1b2c3d4", "pwsh", "dev", "live", "C:\\src\\dev"]
    assert lines[1].split() == ["a1ffee00", "build", "-", "busy", "-"]
    assert lines[2].split() == ["99aa0000", "pwsh", "-", "exited", "3", "/tmp"]
    # The columns line up.
    assert lines[0].index("live") == lines[1].index("busy")
    method, path, _body, token = backend.requests[0]
    assert (method, path) == ("GET", "/api/sessions")
    from quickterm import auth

    assert token == auth.get_or_create_token()


def test_ls_json_prints_the_raw_list(capsys, backend):
    code, out, _err = _run(capsys, "ls", "--json", "--port", str(backend.port))
    assert code == 0
    assert json.loads(out) == SESSIONS


def test_the_port_comes_from_the_config(capsys, backend, tmp_path):
    folder = tmp_path / "appdata" / "quickterm"
    folder.mkdir(parents=True)
    (folder / "config.json").write_text(json.dumps({"port": backend.port}), encoding="utf-8")
    assert _run(capsys, "ls")[0] == 0
    assert backend.requests


def test_a_verb_with_no_app_running_exits_2(capsys):
    port = str(_free_port())
    for argv in (["ls"], ["open", "dev"], ["send", "a1", "x"]):
        code, _out, err = _run(capsys, *argv, "--port", port)
        assert code == cli.EXIT_NOT_RUNNING, argv
        assert "not running" in err


def test_a_refusal_exits_3_with_the_servers_detail(capsys, backend):
    backend.refuse = (404, {"detail": "no such workspace: gone"})
    code, _out, err = _run(capsys, "open", "gone", "--port", str(backend.port))
    assert code == cli.EXIT_REFUSED
    assert "no such workspace: gone" in err
    backend.refuse = (403, "forbidden: bad token")
    code, _out, err = _run(capsys, "ls", "--port", str(backend.port))
    assert code == cli.EXIT_REFUSED
    assert "forbidden: bad token" in err


# --- new and open ------------------------------------------------------------------------


def test_new_hands_the_launch_to_the_running_app(capsys, backend, tmp_path, monkeypatch, isolated):
    monkeypatch.chdir(tmp_path)
    port = str(backend.port)
    assert _run(capsys, "new", "--port", port)[0] == 0
    assert backend.requests[-1][:3] == ("POST", "/api/launches", {"cwd": str(tmp_path)})
    assert _run(capsys, "new", "--profile", "pwsh", "--workspace", "dev", "--port", port)[0] == 0
    # A profile without --cwd starts in the workspace root, not here.
    assert backend.requests[-1][2] == {"profile": "pwsh", "workspace": "dev"}
    (tmp_path / "sub").mkdir()
    assert _run(capsys, "new", "--cwd", "sub", "--workspace", "dev", "--port", port)[0] == 0
    assert backend.requests[-1][2] == {"cwd": str(tmp_path / "sub"), "workspace": "dev"}
    assert len(isolated) == 3


def test_open_asks_for_the_workspace(capsys, backend, isolated):
    assert _run(capsys, "open", "dev", "--port", str(backend.port))[0] == 0
    assert backend.requests[-1][:3] == ("POST", "/api/launches", {"workspace": "dev"})
    assert isolated == [True]


def test_new_with_no_app_starts_it_with_the_launch(tmp_path, monkeypatch):
    port = _free_port()
    monkeypatch.chdir(tmp_path)
    folder_only = cli.run(["new", "--port", str(port)])
    # A folder alone rides the positional argument, like Explorer's handoff.
    assert folder_only == cli.StartApp(argv=[str(tmp_path), "--port", str(port)])
    # Anything more is queued once the app is up.
    outcome = cli.run(["new", "--profile", "pwsh", "--port", str(port)])
    assert outcome == cli.StartApp(argv=["--port", str(port)], handoff={"profile": "pwsh"})


# --- send ------------------------------------------------------------------------------


def test_send_by_id_prefix_or_exact_name(capsys, backend):
    port = str(backend.port)
    assert _run(capsys, "send", "a1b", "echo", "hi", "--enter", "--port", port)[0] == 0
    assert backend.requests[-1][:3] == (
        "POST", "/api/sessions/a1b2c3d4e5f6/input", {"text": "echo hi", "enter": True},
    )
    assert _run(capsys, "send", "build", "make", "--port", port)[0] == 0
    assert backend.requests[-1][1:3] == (
        "/api/sessions/a1ffee000000/input", {"text": "make", "enter": False},
    )
    # The list call skips the process snapshot it does not need.
    assert ("GET", "/api/sessions?metrics=false") in [r[:2] for r in backend.requests]


def test_send_to_an_ambiguous_or_unknown_session_lists_the_candidates(capsys, backend):
    port = str(backend.port)
    code, _out, err = _run(capsys, "send", "a1", "x", "--port", port)
    assert code == cli.EXIT_USAGE
    assert "matches 2 sessions" in err
    assert "a1b2c3d4" in err and "a1ffee00" in err and "99aa0000" not in err
    code, _out, err = _run(capsys, "send", "pwsh", "x", "--port", port)
    assert code == cli.EXIT_USAGE
    assert "a1b2c3d4" in err and "99aa0000" in err
    code, _out, err = _run(capsys, "send", "zz", "x", "--port", port)
    assert code == cli.EXIT_USAGE
    assert "matches no session" in err
    assert all(line in err for line in ("a1b2c3d4", "a1ffee00", "99aa0000"))
    assert not any(path.endswith("/input") for _m, path, _b, _t in backend.requests)


def test_an_exact_id_wins_over_a_prefix():
    sessions = [{"id": "ab", "name": "x"}, {"id": "abc", "name": "y"}]
    assert cli.match_session(sessions, "ab")[0] == [sessions[0]]


def test_a_send_the_app_refuses_exits_3(capsys, backend):
    port = str(backend.port)
    code = cli.run(["send", "99aa", "x", "--port", port])
    assert code == 0  # the stand-in accepts it; the real route answers 409
    backend.refuse = (409, {"detail": "the terminal has exited"})
    code, _out, err = _run(capsys, "send", "99aa", "x", "--port", port)
    assert code == cli.EXIT_REFUSED
    assert "the terminal has exited" in err


# --- the app side ------------------------------------------------------------------------


def test_post_launch_says_why_not(backend):
    assert cli.post_launch(backend.port, {"workspace": "dev"}) is None
    backend.refuse = (404, {"detail": "unknown profile: nope"})
    assert cli.post_launch(backend.port, {"profile": "nope"}) == "unknown profile: nope"
    assert cli.post_launch(_free_port(), {"cwd": "x"}) == "the app did not answer"


def test_the_app_runs_a_verb_and_exits_with_its_code(monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(sys, "argv", ["quickterm", "ls"])
    monkeypatch.setattr(app_mod.cli, "run", lambda argv: 2)
    with pytest.raises(SystemExit) as raised:
        app_mod.main()
    assert raised.value.code == 2


def test_an_app_that_came_up_meanwhile_still_gets_the_launch(monkeypatch, tmp_path):
    from quickterm import app as app_mod

    posted = []
    monkeypatch.setattr(sys, "argv", ["quickterm", "new", "--profile", "pwsh"])
    monkeypatch.setattr(
        app_mod.cli, "run",
        lambda argv: cli.StartApp(argv=["--port", "8655"], handoff={"profile": "pwsh"}),
    )
    monkeypatch.setattr(app_mod.cli, "post_launch", lambda *args: posted.append(args))
    monkeypatch.setattr(app_mod, "_harden_program_lookup", lambda: None)
    monkeypatch.setattr(app_mod, "_already_running", lambda port, host: True)
    monkeypatch.setattr(app_mod, "_launch_window", lambda *a, **k: None)
    from quickterm import hotkeys

    monkeypatch.setattr(hotkeys, "summon_window", lambda: None)
    app_mod.main()
    assert posted == [(8655, {"profile": "pwsh"}, "127.0.0.1")]


async def test_a_launch_the_app_was_started_for_is_queued_once_it_is_up(monkeypatch):
    from quickterm import app as app_mod

    posted = []

    def post(port, launch, host):
        posted.append((port, launch, host))
        return "unknown profile: nope"

    monkeypatch.setattr(app_mod.cli, "post_launch", post)
    cfg = types.SimpleNamespace(port=8655, host="127.0.0.1", profiles=[], launch_error=None)
    server = types.SimpleNamespace(started=True)
    await app_mod._after_ready(
        server, object(), cfg, launch_window=False, handoff={"profile": "nope"}
    )
    assert posted == [(8655, {"profile": "nope"}, "127.0.0.1")]
    # Nobody is at a console any more: the window shows it after boot.
    assert cfg.launch_error == "quickterm new: unknown profile: nope"


@pytest.mark.skipif(os.name != "nt", reason="the console attach exists only on Windows")
def test_a_console_build_keeps_its_own_streams(monkeypatch):
    # Under pytest stdout exists and the process is not frozen: nothing is
    # attached, and letting go changes nothing.
    before = (sys.stdout, sys.stderr)
    release = cli._attach_parent_console()
    assert (sys.stdout, sys.stderr) == before
    release()
    assert (sys.stdout, sys.stderr) == before


@pytest.mark.skipif(os.name != "nt", reason="the console attach exists only on Windows")
def test_a_windowed_build_with_no_parent_console_prints_nowhere(monkeypatch, capsys):
    import ctypes

    freed = []
    fake = types.SimpleNamespace(AttachConsole=lambda _pid: 0, FreeConsole=lambda: freed.append(1))
    monkeypatch.setattr(ctypes, "WinDLL", lambda *_a, **_k: fake)
    piped = sys.stderr
    monkeypatch.setattr(sys, "stdout", None)
    release = cli._attach_parent_console()
    # A stream that exists (piped) is kept; the missing one writes nowhere.
    assert sys.stderr is piped
    assert sys.stdout is not None
    print("into the void")
    release()
    assert sys.stdout is None
    assert freed == []  # nothing was attached, so nothing is freed


def test_a_new_that_starts_the_app_lets_go_of_the_console(monkeypatch):
    released = []
    monkeypatch.setattr(cli, "_attach_parent_console", lambda: lambda: released.append(True))
    monkeypatch.setattr(cli, "_HEALTH_TIMEOUT_S", 0.2)
    outcome = cli.run(["new", "--profile", "pwsh", "--port", str(_free_port())])
    assert isinstance(outcome, cli.StartApp)
    # pty_session would otherwise hide the terminal the command was typed in.
    assert released == [True]
    assert cli.run(["--version"]) == 0
    assert released == [True]
