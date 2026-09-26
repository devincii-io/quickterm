"""The `quickterm` command line against a stand-in backend on a free port."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import socket
import sys
import threading
import types
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from quickterm import cli

_REAL_SPAWN = cli._spawn_app

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
    """What the app answers: /api/health, the session list, launches, input.

    `token` is what it proves it holds when asked; an impostor is a Backend
    with the wrong one. Every request except the health check is recorded.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self.requests: list[tuple[str, str, dict | None, str | None]] = []
        self.health_checks: list[str] = []
        self.refuse: tuple[int, dict | str] | None = None
        self.drop_after_health = False
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
                url = urllib.parse.urlsplit(self.path)
                if url.path == "/api/health":
                    backend.health_checks.append(self.path)
                    answer = {"app": "quickterm", "version": "x"}
                    nonce = urllib.parse.parse_qs(url.query).get("challenge", [""])[0]
                    if nonce:
                        answer["proof"] = cli.health_proof(backend.token, nonce)
                    return self._answer(200, answer)
                backend.requests.append((method, self.path, body, token))
                if backend.drop_after_health:
                    # Accept the request, then hang up without an answer.
                    self.close_connection = True
                    return None
                if backend.refuse is not None:
                    return self._answer(*backend.refuse)
                if url.path.startswith("/api/sessions") and method == "GET":
                    return self._answer(200, SESSIONS)
                if url.path == "/api/launches":
                    return self._answer(200, body)
                if url.path.endswith("/input"):
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
    # Never start a real app from a test.
    def no_spawn(command):
        raise AssertionError(f"a test tried to start the app: {command}")

    monkeypatch.setattr(cli, "_spawn_app", no_spawn)
    return summoned


def _token() -> str:
    from quickterm import auth

    return auth.get_or_create_token()


@pytest.fixture
def backend():
    server = Backend(_token())
    yield server
    server.close()


@pytest.fixture
def impostor():
    server = Backend("not-this-users-token")
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


def test_only_verbs_and_version_are_commands(tmp_path):
    assert cli.is_command(["ls"])
    assert cli.is_command(["send", "x", "y"])
    assert cli.is_command(["--version"])
    assert not cli.is_command([])
    assert not cli.is_command([str(tmp_path)])
    assert not cli.is_command(["--port", "8641"])
    assert not cli.is_command(["list"])
    assert not cli.is_command(["--handoff", "{}"])


def test_a_verb_stays_a_verb_beside_a_folder_of_that_name(tmp_path, monkeypatch):
    # Explorer always passes an absolute folder, so a project with a new/
    # folder must not turn `quickterm new` into "open the folder new".
    (tmp_path / "new").mkdir()
    monkeypatch.chdir(tmp_path)
    assert cli.is_command(["new", "--profile", "x"])
    assert not cli.is_command([str(tmp_path / "new")])


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


def test_run_never_raises(monkeypatch, capsys):
    def boom(_client, _args):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(cli, "_ls", boom)
    code, _out, err = _run(capsys, "ls", "--port", "1")
    assert code == cli.EXIT_REFUSED
    assert "unexpected" in err


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
    assert token == _token()


def test_ls_json_prints_the_raw_list(capsys, backend):
    code, out, _err = _run(capsys, "ls", "--json", "--port", str(backend.port))
    assert code == 0
    assert json.loads(out) == SESSIONS


def test_the_port_comes_from_the_config(capsys, backend, tmp_path):
    folder = tmp_path / "appdata" / "quickterm"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text(json.dumps({"port": backend.port}), encoding="utf-8")
    assert _run(capsys, "ls")[0] == 0
    assert backend.requests


def test_a_verb_with_no_app_running_exits_2(capsys):
    port = str(_free_port())
    for argv in (["ls"], ["open", "dev"], ["send", "a1", "x"]):
        code, _out, err = _run(capsys, *argv, "--port", port)
        assert code == cli.EXIT_NOT_RUNNING, argv
        assert "not running" in err


# --- who answers on the port ---------------------------------------------------------------


def test_a_port_that_does_not_prove_the_token_gets_nothing(capsys, impostor):
    # Another local user can bind the port first. The health answer looks
    # right but its proof is not ours, so neither the token nor the text of a
    # send may reach it, and `new` does not start an app that cannot bind.
    port = str(impostor.port)
    for argv in (["ls"], ["open", "dev"], ["send", "a1", "secret"], ["new", "--profile", "x"]):
        code, _out, err = _run(capsys, *argv, "--port", port)
        assert code == cli.EXIT_NOT_RUNNING, argv
        assert "something else answers" in err
    assert impostor.requests == []
    assert impostor.health_checks
    assert all("challenge=" in path for path in impostor.health_checks)
    assert cli.post_launch(impostor.port, {"cwd": "x"}) == "something else answers on that port"


@pytest.mark.parametrize("answer", [
    {"app": "quickterm", "version": "x"},
    {"app": "quickterm", "version": "x", "proof": 7},
    {"app": "quickterm", "version": "x", "proof": "0" * 64},
    {"app": "other", "proof": "x"},
    "not json",
])
def test_a_health_answer_without_a_valid_proof_is_an_impostor(answer, monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return (answer if isinstance(answer, str) else json.dumps(answer)).encode()

    monkeypatch.setattr(cli, "_open", lambda url, timeout: Response())
    assert cli.probe("http://127.0.0.1:1") == cli.IMPOSTOR


def test_every_nonce_is_fresh_and_the_proof_is_the_hmac(backend):
    base = f"http://127.0.0.1:{backend.port}"
    assert cli.probe(base) == cli.QUICKTERM
    assert cli.probe(base) == cli.QUICKTERM
    nonces = [
        urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)["challenge"][0]
        for path in backend.health_checks
    ]
    assert nonces[0] != nonces[1]
    assert all(16 <= len(nonce) <= 64 for nonce in nonces)
    expected = hmac.new(b"tok", b"n" * 16, hashlib.sha256).hexdigest()
    assert cli.health_proof("tok", "n" * 16) == expected


def test_a_proxy_in_the_environment_is_never_used(capsys, backend, monkeypatch):
    # An intercepting proxy would log the token and every send; a corporate
    # one would make every verb look like "not running".
    proxy = Backend("proxy")
    try:
        for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, f"http://127.0.0.1:{proxy.port}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        assert _run(capsys, "ls", "--port", str(backend.port))[0] == 0
        assert cli.post_launch(backend.port, {"cwd": "x"}) is None
    finally:
        proxy.close()
    assert proxy.requests == []
    assert proxy.health_checks == []
    assert len(backend.requests) == 2


def test_a_failure_after_quickterm_answered_is_exit_3(capsys, backend):
    # Only an unanswered health check means "not running": anything later is
    # a failed request, and `new` must not start a second app and repeat it
    # (the autouse fixture fails the test if it tries).
    backend.drop_after_health = True
    for argv in (["ls"], ["new", "--profile", "pwsh"]):
        code, _out, err = _run(capsys, *argv, "--port", str(backend.port))
        assert code == cli.EXIT_REFUSED, argv
        assert "the request failed" in err


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


def test_the_started_app_gets_the_launch_as_arguments():
    # A folder alone rides the positional argument, like Explorer's handoff;
    # anything more is queued by the app once its backend is up.
    assert cli.app_arguments({"cwd": "/p"}, None) == ["/p"]
    assert cli.app_arguments({"cwd": "/p"}, 8641) == ["/p", "--port", "8641"]
    handoff = cli.app_arguments({"profile": "pwsh", "workspace": "dev"}, None)
    assert handoff[0] == "--handoff"
    assert json.loads(handoff[1]) == {"profile": "pwsh", "workspace": "dev"}


def test_the_app_command_for_a_frozen_and_a_source_install(monkeypatch):
    monkeypatch.setattr(sys, "executable", "/x/python")
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert cli.app_command(["--handoff", "{}"]) == [
        "/x/python", "-c", "from quickterm.app import main; main()", "--handoff", "{}",
    ]
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "C:/QuickTerm/QuickTerm.exe")
    assert cli.app_command(["/p"]) == ["C:/QuickTerm/QuickTerm.exe", "/p"]


def test_the_app_is_started_detached_from_the_shell(monkeypatch):
    seen = {}

    def fake_popen(command, **options):
        seen.update(command=command, options=options)
        return types.SimpleNamespace(poll=lambda: None)

    monkeypatch.setattr(cli.subprocess, "Popen", fake_popen)
    # The autouse fixture replaced cli._spawn_app; this is the real one.
    _REAL_SPAWN(["prog", "--handoff", "{}"])
    options = seen["options"]
    assert seen["command"] == ["prog", "--handoff", "{}"]
    assert options["stdin"] == options["stdout"] == options["stderr"] == cli.subprocess.DEVNULL
    assert "cwd" not in options
    if sys.platform == "win32":
        flags = cli.subprocess.DETACHED_PROCESS | cli.subprocess.CREATE_NEW_PROCESS_GROUP
        assert options["creationflags"] == flags
    else:
        assert options["start_new_session"] is True


def test_new_with_no_app_starts_one_and_waits_for_it(capsys, tmp_path, monkeypatch, isolated):
    monkeypatch.chdir(tmp_path)
    port = _free_port()
    started = []
    states = iter([cli.ABSENT, cli.ABSENT, cli.QUICKTERM])

    def spawn(command):
        started.append(command)
        return types.SimpleNamespace(poll=lambda: None)

    monkeypatch.setattr(cli, "_spawn_app", spawn)
    monkeypatch.setattr(cli.Client, "probe", lambda self: next(states))
    monkeypatch.setattr(cli, "_START_POLL_S", 0)
    code, _out, _err = _run(capsys, "new", "--port", str(port))
    assert code == 0
    assert started == [cli.app_command([str(tmp_path), "--port", str(port)])]
    assert isolated == [True]


def test_new_reports_an_app_that_never_came_up(capsys, monkeypatch):
    monkeypatch.setattr(cli, "_spawn_app", lambda command: types.SimpleNamespace(poll=lambda: 1))
    monkeypatch.setattr(cli, "_START_POLL_S", 0)
    code, _out, err = _run(capsys, "new", "--profile", "pwsh", "--port", str(_free_port()))
    assert code == cli.EXIT_NOT_RUNNING
    assert "did not start" in err


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


def test_the_app_checks_the_proof_before_calling_it_running(backend, impostor):
    from quickterm import app as app_mod

    assert app_mod._already_running(backend.port) is True
    assert app_mod._already_running(impostor.port) is False
    assert app_mod._already_running(_free_port()) is False


def test_the_app_runs_a_verb_and_exits_with_its_code(monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(sys, "argv", ["quickterm", "ls"])
    monkeypatch.setattr(app_mod.cli, "run", lambda argv: 2)
    with pytest.raises(SystemExit) as raised:
        app_mod.main()
    assert raised.value.code == 2


def _quiet_main(monkeypatch):
    from quickterm import app as app_mod
    from quickterm import hotkeys

    monkeypatch.setattr(app_mod, "_harden_program_lookup", lambda: None)
    monkeypatch.setattr(app_mod, "_launch_window", lambda *a, **k: None)
    monkeypatch.setattr(hotkeys, "summon_window", lambda: None)
    return app_mod


def test_an_app_that_came_up_meanwhile_still_gets_the_launch(monkeypatch):
    app_mod = _quiet_main(monkeypatch)
    posted = []
    handoff = json.dumps({"profile": "pwsh"})
    monkeypatch.setattr(sys, "argv", ["quickterm", "--handoff", handoff, "--port", "8655"])
    monkeypatch.setattr(app_mod.cli, "post_launch", lambda *args: posted.append(args))
    monkeypatch.setattr(app_mod, "_already_running", lambda port, host: True)
    app_mod.main()
    assert posted == [(8655, {"profile": "pwsh"}, "127.0.0.1")]


@pytest.mark.parametrize("text", ["[]", "{}", '{"cmd": "x"}', '{"cwd": 3}', "nope"])
def test_a_bad_handoff_is_a_usage_error_of_the_app(text, monkeypatch):
    app_mod = _quiet_main(monkeypatch)
    monkeypatch.setattr(sys, "argv", ["quickterm", "--handoff", text])
    with pytest.raises(SystemExit) as raised:
        app_mod.main()
    assert raised.value.code == 2


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
def test_a_console_build_keeps_its_own_streams():
    # Under pytest stdout exists: nothing is attached, and letting go
    # changes nothing.
    before = (sys.stdout, sys.stderr)
    release = cli._attach_parent_console()
    assert (sys.stdout, sys.stderr) == before
    release()
    assert (sys.stdout, sys.stderr) == before


@pytest.mark.skipif(os.name != "nt", reason="the console attach exists only on Windows")
def test_a_windowed_build_with_no_parent_console_prints_nowhere(monkeypatch):
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
