"""A terminal survives its window process: the PTY host, end to end, on Windows.

Run with `uv run --no-sync python scripts/smoke_pty_host.py [--port N]`, or pass a
packaged `QuickTerm.exe` to check the frozen build and its copy under the host
folder. Isolated %APPDATA%, host folder and port; no global hotkeys are
registered. A real QuickTerm window appears twice for a few seconds, and the
tray icon shows while the backend runs.

1. The launcher starts the backend detached and asks it for a window; the
   launcher itself exits.
2. A terminal is started and typed into (so it is touched).
3. The window process is killed outright, as a crash would.
4. The backend keeps running, the terminal is alive, the dead window's claims
   are gone, and it stays in the tray (a touched terminal is worth keeping).
5. Launching again opens a new window process on the same backend, and the
   terminal's earlier output comes back through the replay. A second window
   opens inside that same process (a command over its stdin).
6. The backend is retired, and its window process goes with it.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Backend:
    def __init__(self, port: int, appdata: Path) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.port = port
        self.appdata = appdata

    @property
    def token(self) -> str:
        return (self.appdata / "quickterm" / "runtime.token").read_text(encoding="utf-8").strip()

    def request(
        self, path: str, *, method: str = "GET", payload: object = None, timeout: float = 15
    ) -> tuple[int, object]:
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Origin": self.base, "X-QuickTerm-Token": self.token}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", errors="replace")

    def up(self) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                return True
        except OSError:
            return False


def _wait(predicate, label: str, timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            if predicate():
                return
        except (OSError, urllib.error.URLError, ValueError):
            pass
        if time.monotonic() > deadline:
            raise TimeoutError(label)
        time.sleep(0.2)


def _pid_alive(pid: int) -> bool:
    found = subprocess.run(
        ["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True, check=False
    ).stdout
    return str(pid) in found


def _host(backend: Backend) -> dict:
    status, info = backend.request("/api/host")
    if status != 200 or not isinstance(info, dict):
        raise RuntimeError(f"/api/host answered {status}: {info!r}")
    return info


def _replay(backend: Backend, session_id: str) -> bytes:
    with connect(
        f"ws://127.0.0.1:{backend.port}/ws/session/{session_id}",
        subprotocols=["qtauth." + backend.token],
        origin=backend.base,
        open_timeout=10,
    ) as ws:
        first = json.loads(ws.recv(timeout=10))
        if first.get("type") != "replay_size":
            raise RuntimeError(f"unexpected first frame {first!r}")
        replay = bytearray()
        while True:
            frame = ws.recv(timeout=10)
            if isinstance(frame, bytes):
                replay.extend(frame)
                if frame:
                    ws.send(json.dumps({"type": "replay_ack"}))
                continue
            if json.loads(frame).get("type") == "replay_done":
                return bytes(replay)


def smoke(launcher: list[str], port: int) -> None:
    with tempfile.TemporaryDirectory(
        prefix="quickterm-host-smoke-", ignore_cleanup_errors=True
    ) as isolated:
        appdata = Path(isolated) / "appdata"
        (appdata / "quickterm").mkdir(parents=True)
        config = {
            "port": port,
            "update_check": False,
            "summon_hotkey": "",
            "scratch_dir": isolated,
            "agents": {},
            "shell": "cmd",
        }
        (appdata / "quickterm" / "config.json").write_text(json.dumps(config), encoding="utf-8")
        env = os.environ.copy()
        env["APPDATA"] = str(appdata)
        env["QUICKTERM_HOST_DIR"] = str(Path(isolated) / "host")
        env["PYTHONPATH"] = os.pathsep.join(
            [str(ROOT), *([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])]
        )
        backend = Backend(port, appdata)
        backend_pid = None
        viewers: list[int] = []
        try:
            # 1. the launcher starts the backend and a window, then exits
            first = subprocess.run(launcher, env=env, cwd=isolated, timeout=90, check=False)
            if first.returncode != 0:
                raise RuntimeError(f"launcher exited {first.returncode}")
            info = _host(backend)
            backend_pid = int(info["pid"])
            _wait(lambda: _host(backend)["viewer"], "the window process started")
            viewers.append(int(_host(backend)["viewer"]))
            _wait(
                lambda: backend.request("/api/windows")[1]["windows"],
                "the window's shell registered",
            )
            print(f"backend {backend_pid} ({info['build']}, copy={info['copy']}), "
                  f"window process {viewers[0]}", flush=True)

            # 2. a terminal, typed into
            status, spawned = backend.request(
                "/api/sessions", method="POST",
                payload={"cmd": "cmd.exe", "args": ["/q", "/k"], "cwd": isolated,
                         "name": "Survivor", "kind": "terminal"},
            )
            if status != 200 or not isinstance(spawned, dict):
                raise RuntimeError(f"spawn failed ({status}): {spawned!r}")
            session_id = str(spawned["id"])
            status, _ = backend.request(
                f"/api/sessions/{session_id}/input", method="POST",
                payload={"text": "echo SURVIVES_THE_WINDOW", "enter": True},
            )
            if status not in (200, 204):
                raise RuntimeError(f"input failed ({status})")
            _wait(lambda: b"SURVIVES_THE_WINDOW\r\n" in _replay(backend, session_id),
                  "the echo ran")

            # 3. the window process dies without a word
            subprocess.run(["taskkill", "/F", "/PID", str(viewers[0])],
                           capture_output=True, check=False)
            _wait(lambda: not _pid_alive(viewers[0]), "the window process is gone")

            # 4. the backend and the terminal are still there
            _wait(lambda: _host(backend)["viewer"] is None, "the backend saw it go")
            status, sessions = backend.request("/api/sessions?metrics=false")
            survivor = next((s for s in sessions if s.get("id") == session_id), None)
            if not survivor or not survivor.get("alive") or not survivor.get("touched", True):
                raise RuntimeError(f"the terminal did not survive: {survivor!r}")
            windows = backend.request("/api/windows")[1]["windows"]
            if windows:
                raise RuntimeError(f"the dead window's claims stayed: {windows!r}")
            if int(_host(backend)["pid"]) != backend_pid:
                raise RuntimeError("a different backend answers")
            print("window process killed: backend, terminal and tray stay", flush=True)

            # 5. a new window on the same backend replays the terminal
            again = subprocess.run(launcher, env=env, cwd=isolated, timeout=90, check=False)
            if again.returncode != 0:
                raise RuntimeError(f"second launcher exited {again.returncode}")
            _wait(lambda: _host(backend)["viewer"], "a new window process started")
            viewers.append(int(_host(backend)["viewer"]))
            if viewers[1] == viewers[0] or int(_host(backend)["pid"]) != backend_pid:
                raise RuntimeError("the second launch did not reattach to the same backend")
            _wait(lambda: backend.request("/api/windows")[1]["windows"],
                  "the new window's shell registered")
            replay = _replay(backend, session_id)
            if b"SURVIVES_THE_WINDOW" not in replay:
                raise RuntimeError("the new window did not get the terminal's output back")
            print(f"new window process {viewers[1]} reattached, "
                  f"{len(replay)} replay bytes", flush=True)

            # A second window is a command down the window process's stdin,
            # answered on its stdout; no second process.
            started = time.monotonic()
            status, opened = backend.request(
                "/api/windows/open", method="POST", payload={"workspace": "Second"}
            )
            if status != 200 or not isinstance(opened, dict) or not opened.get("opened"):
                raise RuntimeError(f"opening a second window failed ({status}): {opened!r}")
            if _host(backend)["viewer"] != viewers[1]:
                raise RuntimeError("a second window started a second window process")
            _wait(lambda: any(w.get("id") == opened["window_id"]
                              for w in backend.request("/api/windows")[1]["windows"]),
                  "the second window registered")
            print(f"second window {opened['window_id']} opened in "
                  f"{time.monotonic() - started:.1f} s", flush=True)

            # 6. retiring the backend takes its window along
            status, body = backend.request("/api/host/retire", method="POST",
                                           payload={"force": False})
            if status != 409:
                raise RuntimeError(f"a touched terminal must refuse a retire, got {status}")
            status, body = backend.request("/api/host/retire", method="POST",
                                           payload={"force": True})
            if status != 202:
                raise RuntimeError(f"forced retire answered {status}: {body!r}")
            _wait(lambda: not backend.up(), "the backend let go of its port", timeout=20)
            _wait(lambda: not _pid_alive(viewers[1]), "the window process followed", timeout=20)
            _wait(lambda: not _pid_alive(backend_pid), "the backend process ended", timeout=20)
            print("PTY host smoke passed", flush=True)
        finally:
            if backend.up():
                try:
                    backend.request("/api/host/retire", method="POST", payload={"force": True})
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(2)
            for pid in [*viewers, *([backend_pid] if backend_pid else [])]:
                if _pid_alive(pid):
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                   capture_output=True, check=False)


def main() -> None:
    if sys.platform != "win32":
        raise SystemExit("the PTY host smoke needs Windows")
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", nargs="?", type=Path,
                        help="a packaged QuickTerm.exe (default: this source checkout)")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    port = args.port or _free_port()
    if args.executable:
        launcher = [str(args.executable.resolve()), "--port", str(port)]
    else:
        launcher = [sys.executable, "-c", "from quickterm.app import main; main()",
                    "--port", str(port)]
    smoke(launcher, port)


if __name__ == "__main__":
    main()
