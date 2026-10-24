"""The PTY host: the versioned copy, the backend's keep rules, the control
channel to the window process, and the /api/host routes.

The window process is a real child process here (a stub that speaks the
control protocol), so the pipes, the exit detection and the claims a dead
window process leaves behind are exercised for real; only pywebview is not.
"""

from __future__ import annotations

import io
import os
import sys
import textwrap
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from quickterm import pty_host
from quickterm.windows import WindowRegistry

# --- the versioned copy -----------------------------------------------------


def _install(root: Path, payload: bytes = b"exe-1") -> Path:
    install = root / "Programs" / "QuickTerm"
    (install / "_internal" / "conpty").mkdir(parents=True, exist_ok=True)
    (install / "QuickTerm.exe").write_bytes(payload)
    (install / "_internal" / "conpty" / "OpenConsole.exe").write_bytes(b"console")
    (install / "unins000.exe").write_bytes(b"uninstaller")
    (install / "unins000.dat").write_bytes(b"uninstaller data")
    return install


def test_the_copy_is_complete_renamed_and_without_the_uninstaller(tmp_path):
    install = _install(tmp_path)
    root = tmp_path / "host"
    build = pty_host.build_id(install)

    exe = pty_host.ensure_copy(install, root, build)

    assert exe == root / build / pty_host.HOST_EXE
    assert exe.read_bytes() == b"exe-1"
    # The installer closes QuickTerm.exe by image name; the backend is not one.
    assert not (root / build / "QuickTerm.exe").exists()
    assert (root / build / "_internal" / "conpty" / "OpenConsole.exe").is_file()
    assert not list((root / build).glob("unins*"))
    assert (root / build / pty_host.SOURCE_FILE).read_text(encoding="utf-8") == str(
        install / "QuickTerm.exe"
    )
    assert not [p for p in root.iterdir() if p.name.startswith(".staging-")]


def test_a_finished_copy_is_reused_and_a_new_build_gets_its_own(tmp_path):
    install = _install(tmp_path)
    root = tmp_path / "host"
    first = pty_host.ensure_copy(install, root, pty_host.build_id(install))
    (install / "_internal" / "conpty" / "OpenConsole.exe").unlink()
    assert pty_host.ensure_copy(install, root, pty_host.build_id(install)) == first

    os.utime(install / "QuickTerm.exe", ns=(1, 2_000_000_000))
    (install / "QuickTerm.exe").write_bytes(b"exe-2, a different build")
    second_build = pty_host.build_id(install)
    assert second_build != first.parent.name
    second = pty_host.ensure_copy(install, root, second_build)
    assert second.read_bytes() == b"exe-2, a different build"
    assert first.is_file()  # the running build is never touched by a copy


def test_a_copy_left_half_done_is_replaced(tmp_path):
    install = _install(tmp_path)
    root = tmp_path / "host"
    build = pty_host.build_id(install)
    (root / build).mkdir(parents=True)
    (root / build / "stray").write_text("from a crash", encoding="utf-8")

    exe = pty_host.ensure_copy(install, root, build)
    assert exe.is_file()
    assert not (root / build / "stray").exists()


def _fake_copy(root: Path, name: str, used_at: float) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / pty_host.HOST_EXE).write_bytes(b"exe")
    marker = folder / pty_host.COMPLETE_MARKER
    marker.write_text(name, encoding="utf-8")
    os.utime(marker, (used_at, used_at))
    return folder


def test_prune_keeps_the_running_build_and_one_more(tmp_path):
    root = tmp_path / "host"
    now = time.time()
    _fake_copy(root, "4.2.0-aaaa", now - 300)
    _fake_copy(root, "4.1.9-bbbb", now - 200)
    _fake_copy(root, "4.2.1-cccc", now - 100)
    _fake_copy(root, "4.2.2-dddd", now)

    removed = pty_host.prune(root, "4.2.2-dddd")

    assert sorted(removed) == ["4.1.9-bbbb", "4.2.0-aaaa"]
    assert sorted(p.name for p in root.iterdir()) == ["4.2.1-cccc", "4.2.2-dddd"]


@pytest.mark.skipif(os.name != "nt", reason="only Windows refuses to delete a file in use")
def test_prune_never_touches_a_copy_that_is_running(tmp_path):
    root = tmp_path / "host"
    now = time.time()
    old = _fake_copy(root, "4.0.0-old", now - 300)
    _fake_copy(root, "4.1.0-mid", now - 100)
    _fake_copy(root, "4.2.0-new", now)
    (old / "_internal").mkdir()
    (old / "_internal" / "module.pyd").write_bytes(b"loaded lazily")
    # An open handle without delete sharing behaves like a running image.
    with open(old / pty_host.HOST_EXE, "rb"):
        assert pty_host.prune(root, "4.2.0-new") == []
    # Nothing inside it was deleted either: the backend imports lazily.
    assert (old / "_internal" / "module.pyd").is_file()
    assert pty_host.prune(root, "4.2.0-new") == ["4.0.0-old"]


def test_prune_leaves_a_copy_in_progress_and_clears_old_leftovers(tmp_path):
    root = tmp_path / "host"
    fresh = root / ".staging-4.2.0-x-1-abc"
    stale = root / ".staging-4.1.0-x-2-def"
    trash = root / ".trash-4.0.0-ghi"
    for folder in (fresh, stale, trash):
        folder.mkdir(parents=True)
    old = time.time() - pty_host.STALE_STAGING_S - 60
    os.utime(stale, (old, old))

    pty_host.prune(root, "4.2.0-x")
    assert fresh.is_dir()
    assert not stale.exists()
    assert not trash.exists()


def test_the_build_of_a_source_checkout_is_its_version(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert pty_host.running_build().endswith("-dev")
    assert pty_host.running_from_copy() is False
    assert pty_host.program_command(["--serve"])[-1] == "--serve"
    assert pty_host.program_command(["--serve"])[0] == sys.executable


def test_the_frozen_backend_runs_its_own_copy(monkeypatch, tmp_path):
    exe = tmp_path / "host" / "4.2.0-abc" / pty_host.HOST_EXE
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    assert pty_host.running_from_copy() is True
    assert pty_host.running_build() == "4.2.0-abc"
    assert pty_host.program_command(["--viewer"]) == [str(exe), "--viewer"]


def test_the_host_folder_can_be_isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("QUICKTERM_HOST_DIR", str(tmp_path))
    assert pty_host.host_root() == tmp_path
    monkeypatch.delenv("QUICKTERM_HOST_DIR")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    assert pty_host.host_root() == tmp_path / "local" / "QuickTerm" / "host"


# --- the control channel ------------------------------------------------------


def test_the_channel_reads_whole_lines_and_skips_junk():
    reader = io.BytesIO(b'{"op":"show"}\nnot json\n[1]\n{"op":"open","workspace":"d\xc3\xa9v"}\n{"op"')
    channel = pty_host.ViewerChannel(reader, io.BytesIO())
    assert list(channel.commands()) == [{"op": "show"}, {"op": "open", "workspace": "d\u00e9v"}]


def test_the_channel_writes_one_line_per_event():
    writer = io.BytesIO()
    channel = pty_host.ViewerChannel(io.BytesIO(), writer)
    assert channel.send({"event": "ready"}) is True
    assert channel.send({"event": "closed", "window_id": "w1"}) is True
    assert writer.getvalue().splitlines() == [
        b'{"event":"ready"}', b'{"event":"closed","window_id":"w1"}'
    ]


# --- the keep rules -------------------------------------------------------------


@dataclass
class _Info:
    id: str
    alive: bool = True
    touched: bool = False
    retained: bool = False
    name: str = ""


class _Manager:
    def __init__(self, infos, busy=()):
        self.infos = infos
        self.busy = set(busy)

    def list(self):
        return self.infos

    def busy_ids(self):
        return self.busy


class _Tray:
    def __init__(self):
        self.balloons = []

    def balloon_once(self, title, text):
        self.balloons.append(title)

    def balloon(self, title, text):
        self.balloons.append(title)


def _host(manager=None, **kwargs):
    exits = []
    host = pty_host.Host(
        SimpleNamespace(port=8650, host="127.0.0.1"),
        kwargs.pop("registry", WindowRegistry()),
        manager=lambda: manager,
        request_exit=lambda: exits.append(True),
        from_copy=kwargs.pop("from_copy", True),
        **kwargs,
    )
    host.tray = _Tray()
    return host, exits


def test_a_touched_terminal_keeps_the_backend_after_the_last_window():
    host, exits = _host(_Manager([_Info("a", touched=True)]))
    host.after_last_window()
    assert exits == []
    assert host.tray.balloons == ["QuickTerm is still running"]


def test_a_busy_or_retained_terminal_keeps_it_too():
    host, exits = _host(_Manager([_Info("a"), _Info("b", retained=True)]))
    host.after_last_window()
    host2, exits2 = _host(_Manager([_Info("a")], busy={"a"}))
    host2.after_last_window()
    assert (exits, exits2) == ([], [])


def test_nothing_worth_keeping_ends_the_backend():
    host, exits = _host(_Manager([_Info("a"), _Info("b", alive=False, touched=True)]))
    host.after_last_window()
    assert exits == [True]


def test_an_elevated_backend_or_one_without_a_tray_always_ends():
    manager = _Manager([_Info("a", touched=True)])
    elevated, exits = _host(manager, elevated=True)
    elevated.after_last_window()
    trayless, exits2 = _host(manager)
    trayless.tray = None
    trayless.after_last_window()
    assert (exits, exits2) == ([True], [True])


def test_a_quit_in_progress_decides_nothing():
    host, exits = _host(_Manager([]))
    host.quitting.set()
    host.after_last_window()
    assert exits == []


def test_retire_is_refused_while_work_is_at_risk_and_marks_the_backend():
    manager = _Manager([_Info("a", touched=True, name="build"), _Info("b"), _Info("c")], busy={"c"})
    host, exits = _host(manager)
    retiring, sessions = host.retire()
    assert retiring is False
    assert [s["id"] for s in sessions] == ["a", "c"]
    assert sessions[0] == {"id": "a", "name": "build", "busy": False, "touched": True}
    assert host.superseded is True
    # Retained but idle and untouched is not at risk for an update restart.
    host2, _ = _host(_Manager([_Info("r", retained=True)]))
    assert host2.retire()[0] is True


def test_a_forced_retire_stops_the_backend_soon(monkeypatch):
    host, exits = _host(_Manager([_Info("a", touched=True)]))
    retiring, _ = host.retire(force=True)
    assert retiring is True
    assert host.quitting.is_set()
    deadline = time.monotonic() + 5
    while not exits and time.monotonic() < deadline:
        time.sleep(0.02)
    assert exits == [True]


def test_a_superseded_backend_leaves_once_nothing_is_at_risk():
    manager = _Manager([_Info("a", touched=True)])
    host, exits = _host(manager)
    host.superseded = True
    host.check()
    assert exits == []
    manager.infos[0].alive = False
    host.check()
    assert exits == [True]


def test_a_backend_nobody_ever_opened_a_window_on_leaves_after_the_grace():
    now = [0.0]
    host, exits = _host(_Manager([_Info("a")]), clock=lambda: now[0])
    host.check()
    now[0] = pty_host.ORPHAN_GRACE_S + 1
    host.check()
    assert exits == [True]
    # Unless it holds work: `quickterm new` with no window still counts.
    kept, kept_exits = _host(_Manager([_Info("a", touched=True)]), clock=lambda: now[0])
    now[0] += pty_host.ORPHAN_GRACE_S * 2
    kept.check()
    assert kept_exits == []


def test_an_update_leaves_a_backend_running_from_its_copy_alone(monkeypatch):
    host, exits = _host(_Manager([]), from_copy=True)
    assert host.begin_update() is False
    assert exits == []

    class _Now:
        def __init__(self, _delay, fn):
            self.fn = fn
            self.daemon = False

        def start(self):
            self.fn()

    monkeypatch.setattr(pty_host.threading, "Timer", _Now)
    in_place, in_place_exits = _host(_Manager([]), from_copy=False)
    assert in_place.begin_update() is True
    assert in_place_exits == [True]


def test_the_module_level_update_hook_reaches_the_installed_host(monkeypatch):
    host, _ = _host(_Manager([]), from_copy=True)
    calls = []
    monkeypatch.setattr(host, "begin_update", lambda: calls.append(True) or False)
    pty_host.install(host)
    try:
        assert pty_host.begin_update() is False
        assert calls == [True]
    finally:
        pty_host.install(None)
    assert pty_host.begin_update() is False


# --- a real window process (a stub that speaks the protocol) ------------------

_STUB = textwrap.dedent(
    """
    import json, sys
    args = sys.argv[1:]
    window = args[args.index("--window-id") + 1]
    out = sys.stdout.buffer
    def send(message):
        out.write((json.dumps(message) + "\\n").encode())
        out.flush()
    send({"event": "adopted", "window_id": window})
    send({"event": "ready"})
    count = 0
    for line in sys.stdin.buffer:
        message = json.loads(line)
        if message["op"] == "open":
            if message.get("workspace") == "taken":
                send({"event": "open_failed", "request": message["request"],
                      "error": "workspace_claimed", "detail": "taken"})
                continue
            count += 1
            new = f"{window}-{count}"
            send({"event": "adopted", "window_id": new})
            send({"event": "opened", "request": message["request"], "window_id": new})
        elif message["op"] == "show":
            send({"event": "shown", "skip_primary": message.get("skip_primary")})
        elif message["op"] == "close":
            send({"event": "closed", "window_id": message["window_id"]})
        elif message["op"] == "quit":
            break
    """
)


@pytest.fixture
def stub_host(tmp_path):
    stub = tmp_path / "viewer_stub.py"
    stub.write_text(_STUB, encoding="utf-8")
    manager = _Manager([_Info("a", touched=True)])
    registry = WindowRegistry()
    commands = []

    def command(argv):
        commands.append(argv)
        return [sys.executable, str(stub), *argv]

    host, exits = _host(manager, registry=registry, viewer_command=command)
    events = []
    original = host._on_event

    def record(viewer, message):
        events.append(message)
        original(viewer, message)

    host._on_event = record
    host.events = events
    host.commands = commands
    host.exits = exits
    host.manager_ref = manager
    yield host
    host.close()


def _wait(predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.02)


def test_summon_starts_one_window_process_and_then_only_shows_it(stub_host):
    assert stub_host.summon(cwd=None) == "started"
    pid = next(iter(stub_host.viewer_pids()))
    assert stub_host.summon() == "shown"
    _wait(lambda: any(e.get("event") == "shown" for e in stub_host.events))
    assert stub_host.viewer_pids() == {pid}
    assert len(stub_host.commands) == 1
    argv = stub_host.commands[0]
    assert argv[:2] == ["--port", "8650"] and "--window-id" in argv
    assert stub_host.info()["viewer"] == pid


def test_a_window_opened_with_no_window_process_starts_one_with_that_workspace(stub_host):
    window_id = stub_host.open_window("dev", None)
    argv = stub_host.commands[0]
    assert argv[argv.index("--window-id") + 1] == window_id
    assert argv[argv.index("--workspace") + 1] == "dev"


def test_more_windows_are_commands_to_the_same_process(stub_host):
    first = stub_host.open_window(None, None)
    second = stub_host.open_window("dev", None)
    assert second == f"{first}-1"
    assert len(stub_host.commands) == 1
    _wait(lambda: stub_host.window_count() == 2)


def test_a_claimed_workspace_is_refused_with_the_owner(stub_host):
    from quickterm.windows import WorkspaceClaimed

    stub_host.open_window(None, None)
    stub_host.registry.register(window_id="other", workspace="taken")
    with pytest.raises(WorkspaceClaimed):
        stub_host.open_window("taken", None)


def test_a_crashed_window_process_frees_its_claims_and_the_terminals_stay(stub_host):
    window_id = stub_host.open_window(None, None)
    second = stub_host.open_window("dev", None)
    stub_host.registry.register(window_id=window_id, workspace=None)
    stub_host.registry.register(window_id=second, workspace="dev")
    viewer = stub_host._viewer

    viewer.kill()  # no goodbyes: a crash, or the window process being killed
    assert viewer.wait(10)
    _wait(lambda: stub_host.viewer_pids() == set())

    # The next window may claim "dev" at once, not after the heartbeat TTL.
    assert stub_host.registry.owner_of("dev") is None
    # A touched terminal keeps the backend; it says so in the tray.
    assert stub_host.exits == []
    assert stub_host.tray.balloons == ["QuickTerm is still running"]
    # And a new window process comes up on the same backend.
    assert stub_host.summon() == "started"
    assert stub_host.viewer_pids() and stub_host.viewer_pids() != {viewer.pid}


def test_the_last_window_closing_with_nothing_to_keep_ends_the_backend(stub_host):
    stub_host.manager_ref.infos[0].touched = False
    stub_host.summon()
    viewer = stub_host._viewer
    viewer.send({"op": "quit"})
    assert viewer.wait(10)
    _wait(lambda: stub_host.exits == [True])


def test_quit_closes_the_window_process_then_the_backend(stub_host):
    stub_host.summon()
    viewer = stub_host._viewer
    stub_host.quit()
    assert viewer.exited.is_set()
    assert stub_host.exits == [True]
    assert stub_host.summon() == "unavailable"


# --- /api/host --------------------------------------------------------------------


@pytest.fixture
def client():
    from quickterm.server import create_app
    from tests.test_server import FakeConfig, FakeSessionManager

    with TestClient(
        create_app(FakeSessionManager(), FakeConfig()), base_url="http://127.0.0.1:8620"
    ) as c:
        yield c


def test_host_info_without_a_host_says_unmanaged(client):
    body = client.get("/api/host").json()
    assert body["managed"] is False
    assert body["pid"] == os.getpid()
    assert {"version", "build", "frozen", "copy", "viewer", "superseded"} <= set(body)
    assert client.post("/api/host/summon", json={}).json() == {"shown": "unavailable"}
    assert client.post("/api/host/retire", json={}).status_code == 409


def test_host_routes_reach_the_installed_host(client, tmp_path):
    host, exits = _host(_Manager([_Info("a", touched=True, name="agent")]))
    summoned = []
    host.summon = lambda cwd=None: summoned.append(cwd) or "shown"
    pty_host.install(host)
    try:
        assert client.get("/api/host").json()["managed"] is True
        assert client.post("/api/host/summon", json={"cwd": str(tmp_path)}).json() == {
            "shown": "shown"
        }
        assert summoned == [str(tmp_path)]
        assert client.post("/api/host/summon", json={"cwd": 3}).status_code == 400
        refused = client.post("/api/host/retire", json={"force": False})
        assert refused.status_code == 409
        assert refused.json()["sessions"][0]["name"] == "agent"
        assert client.post("/api/host/retire", json={"force": "yes"}).status_code == 400
        accepted = client.post("/api/host/retire", json={"force": True})
        assert (accepted.status_code, accepted.json()) == (202, {"retiring": True})
    finally:
        pty_host.install(None)
        host.quitting.set()


def test_the_launcher_hands_over_only_between_two_frozen_builds(monkeypatch):
    from quickterm import app

    info = {"managed": True, "frozen": True, "build": "4.1.1-old", "version": "4.1.1"}
    monkeypatch.setattr(pty_host, "frozen", lambda: True)
    monkeypatch.setattr(pty_host, "running_build", lambda: "4.2.0-new")
    monkeypatch.setattr(app, "__version__", "4.2.0")
    assert app._should_hand_over(info) is True
    assert app._should_hand_over({**info, "build": "4.2.0-new"}) is False
    assert app._should_hand_over({**info, "frozen": False}) is False  # a source checkout
    assert app._should_hand_over({**info, "managed": False}) is False
    # Never replace a newer backend with an older install.
    assert app._should_hand_over({**info, "version": "4.3.0", "build": "4.3.0-x"}) is False
    assert app._should_hand_over(None) is False


def test_a_declined_restart_keeps_the_old_backend(monkeypatch):
    from quickterm import app

    calls = []

    def fake_call(cfg, method, path, body=None):
        calls.append((method, path, body))
        return 409, {"sessions": [{"id": "a", "name": "build", "busy": True}]}

    monkeypatch.setattr(app, "_host_call", fake_call)
    monkeypatch.setattr(app, "_ask_restart", lambda version, sessions: False)
    monkeypatch.setattr(app, "_start_backend", lambda *a, **k: pytest.fail("must not start"))
    cfg = SimpleNamespace(port=8650, host="127.0.0.1")
    assert app._hand_over(cfg, {"version": "4.1.1"}) == "kept"
    assert calls == [("POST", "/api/host/retire", {"force": False})]


def test_an_accepted_restart_retires_waits_and_starts_the_new_backend(monkeypatch):
    from quickterm import app

    answers = iter([(409, {"sessions": []}), (202, {"retiring": True})])
    calls = []
    monkeypatch.setattr(app, "_host_call", lambda cfg, m, p, b=None: calls.append(b) or next(answers))
    monkeypatch.setattr(app, "_ask_restart", lambda version, sessions: True)
    monkeypatch.setattr(app, "_wait_for_backend", lambda cfg, **kw: kw["running"] is False)
    started = []
    monkeypatch.setattr(app, "_start_backend", lambda cfg, **kw: started.append(kw) or True)
    cfg = SimpleNamespace(port=8650, host="127.0.0.1")
    assert app._hand_over(cfg, {"version": "4.1.1"}, handoff={"cwd": "x"}) == "started"
    assert calls == [{"force": False}, {"force": True}]
    assert started == [{"handoff": {"cwd": "x"}, "port_override": None}]


def test_the_launcher_starts_a_backend_and_asks_it_for_a_window(monkeypatch):
    from quickterm import app

    started, summoned = [], []
    monkeypatch.setattr(app, "_already_running", lambda port, host: False)
    monkeypatch.setattr(app, "_start_backend", lambda cfg, **kw: started.append(kw) or True)
    monkeypatch.setattr(app, "_summon_backend", lambda cfg, cwd=None: summoned.append(cwd))
    cfg = SimpleNamespace(port=8650, host="127.0.0.1")
    assert app._run_launcher(cfg, open_dir="C:/proj", handoff={"profile": "p"}) == 0
    assert started == [{"handoff": {"profile": "p"}, "port_override": None}]
    # The folder rides the first window's URL; the handoff went to the backend.
    assert summoned == ["C:/proj"]

    summoned.clear()
    assert app._run_launcher(cfg, background=True) == 0
    assert summoned == []


def test_a_running_backend_gets_the_folder_queued_and_is_summoned(monkeypatch):
    from quickterm import app

    queued, summoned = [], []
    monkeypatch.setattr(app, "_already_running", lambda port, host: True)
    monkeypatch.setattr(app, "_host_info", lambda cfg: None)
    monkeypatch.setattr(app, "_queue_running_launch", lambda port, cwd, host: queued.append(cwd))
    monkeypatch.setattr(app, "_summon_backend", lambda cfg, cwd=None: summoned.append(cwd))
    cfg = SimpleNamespace(port=8650, host="127.0.0.1")
    assert app._run_launcher(cfg, open_dir="C:/proj") == 0
    assert (queued, summoned) == (["C:/proj"], [None])


def test_the_backend_command_runs_the_copy_when_frozen(monkeypatch, tmp_path):
    from quickterm import app

    install = _install(tmp_path)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(install / "QuickTerm.exe"))
    monkeypatch.setenv("QUICKTERM_HOST_DIR", str(tmp_path / "host"))
    command = app._backend_command(["--serve"])
    assert Path(command[0]).name == pty_host.HOST_EXE
    assert Path(command[0]).parent.parent == tmp_path / "host"
    assert command[1:] == ["--serve"]


def test_a_failed_copy_runs_the_backend_in_place(monkeypatch, tmp_path):
    from quickterm import app

    install = _install(tmp_path)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(install / "QuickTerm.exe"))

    def broken(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(pty_host, "ensure_copy", broken)
    assert app._backend_command(["--serve"]) == [str(install / "QuickTerm.exe"), "--serve"]


def test_viewer_events_keep_the_window_list(stub_host):
    host = stub_host
    viewer = SimpleNamespace(window_ids=["w1"], ready=threading.Event())
    host._on_event(viewer, {"event": "adopted", "window_id": "w2"})
    host._on_event(viewer, {"event": "adopted", "window_id": "w2"})
    host.registry.register(window_id="w2", workspace="dev")
    host._on_event(viewer, {"event": "closed", "window_id": "w2"})
    host._on_event(viewer, {"event": "ready"})
    assert viewer.window_ids == ["w1"]
    assert viewer.ready.is_set()
    assert host.registry.owner_of("dev") is None
