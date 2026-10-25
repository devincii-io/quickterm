"""Release smoke test for the frozen Windows application folder.

Starts the real packaged backend (`--serve`) with isolated configuration,
creates a PTY through the authenticated API, verifies replay and live
WebSocket traffic, then checks the importlib-backed routes that are easy to
omit from a PyInstaller build.

Then the update path, without a window: two copies of the build stand in for
an installed version and its update. The first launcher starts its backend
from a copy under an isolated host folder; its whole install folder is then
deleted while a terminal runs, as Setup replaces it; the second launcher
retires that backend (nothing is busy or touched) and starts its own.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from websockets.sync.client import connect


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(
    base: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    payload: dict[str, object] | None = None,
    timeout: float = 10,
) -> tuple[int, object]:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Origin": base}
    if token:
        headers["X-QuickTerm-Token"] = token
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def _wait_ready(base: str, timeout: float = 20) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, body = _request(base, "/api/health", timeout=1)
            if status == 200 and isinstance(body, dict):
                return body
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError("packaged health endpoint did not become ready")


def _receive_replay(ws: object) -> bytes:
    first = json.loads(ws.recv(timeout=10))
    if first.get("type") != "replay_size":
        raise RuntimeError(f"unexpected first WebSocket frame: {first!r}")
    replay = bytearray()
    while True:
        frame = ws.recv(timeout=10)
        if isinstance(frame, bytes):
            replay.extend(frame)
            if frame:
                ws.send(json.dumps({"type": "replay_ack"}))
            continue
        control = json.loads(frame)
        if control.get("type") != "replay_done":
            raise RuntimeError(f"unexpected replay control frame: {control!r}")
        return bytes(replay)


def _receive_until(ws: object, marker: bytes, timeout: float = 10) -> bytes:
    deadline = time.monotonic() + timeout
    received = bytearray()
    while marker not in received:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"terminal marker was not received: {marker!r}")
        frame = ws.recv(timeout=remaining)
        if isinstance(frame, bytes):
            received.extend(frame)
    return bytes(received)


def _wait_for_exit(ws: object) -> None:
    while True:
        frame = ws.recv(timeout=15)
        if isinstance(frame, str) and json.loads(frame).get("type") == "exit":
            return


def _wait_port_closed(port: int, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f"packaged app left port {port} listening")


def smoke(executable: Path, port: int) -> None:
    executable = executable.resolve()
    if not executable.is_file():
        raise FileNotFoundError(executable)
    base = f"http://127.0.0.1:{port}"
    ws_base = f"ws://127.0.0.1:{port}"

    with tempfile.TemporaryDirectory(prefix="quickterm-package-smoke-") as isolated:
        env = os.environ.copy()
        env["APPDATA"] = isolated
        env["QUICKTERM_HOST_DIR"] = str(Path(isolated) / "host")
        # The backend itself, in place: a plain QuickTerm.exe is the launcher,
        # which would exit at once and leave a backend copy and a window.
        process = subprocess.Popen([str(executable), "--serve", "--port", str(port)], env=env)
        try:
            health = _wait_ready(base)
            token_path = Path(isolated) / "quickterm" / "runtime.token"
            token = token_path.read_text(encoding="utf-8").strip()
            status, spawned = _request(
                base,
                "/api/sessions",
                token=token,
                method="POST",
                payload={
                    "cmd": "cmd.exe",
                    "args": ["/q", "/k"],
                    "cwd": isolated,
                    "name": "Package smoke",
                    "kind": "terminal",
                },
            )
            if status != 200 or not isinstance(spawned, dict):
                raise RuntimeError(f"packaged PTY spawn failed ({status}): {spawned!r}")
            session_id = str(spawned["id"])

            status, sessions = _request(base, "/api/sessions?metrics=false", token=token)
            current = next(
                (item for item in sessions if item.get("id") == session_id),
                None,
            ) if isinstance(sessions, list) else None
            if status != 200 or not current or not current.get("alive"):
                raise RuntimeError("spawned packaged PTY was not reported alive")

            protocols = ["qtauth." + token]
            origin = base
            with connect(
                f"{ws_base}/ws/session/{session_id}",
                subprotocols=protocols,
                origin=origin,
                open_timeout=10,
            ) as ws:
                _receive_replay(ws)
                ws.send(b"echo PACKAGED_REPLAY_OK\r\n")
                _receive_until(ws, b"PACKAGED_REPLAY_OK")

            with connect(
                f"{ws_base}/ws/session/{session_id}",
                subprotocols=protocols,
                origin=origin,
                open_timeout=10,
            ) as ws:
                replay = _receive_replay(ws)
                if b"PACKAGED_REPLAY_OK" not in replay:
                    raise RuntimeError("packaged reconnect did not replay prior output")
                ws.send(b"echo PACKAGED_LIVE_OK\r\n")
                live = _receive_until(ws, b"PACKAGED_LIVE_OK")
                ws.send(b"exit\r\n")
                _wait_for_exit(ws)

            open_status, _ = _request(
                base,
                "/api/open",
                token=token,
                method="POST",
                payload={"target": "ftp://invalid"},
            )
            if open_status != 400:
                raise RuntimeError(f"packaged opener route returned {open_status}, expected 400")
            before_status, before_config = _request(base, "/api/config/full", token=token)
            config_status, _ = _request(
                base, "/api/config", token=token, method="PUT", payload={"profiles": [{
                    "name": "Missing desktop viewer", "cmd": str(Path(isolated) / "missing.exe"),
                    "terminal_type": "vnc", "connection": {"host": "localhost"},
                }]},
            )
            if config_status != 204:
                raise RuntimeError(f"packaged connection config returned {config_status}")
            connection_status, _ = _request(
                base, "/api/connections/Missing%20desktop%20viewer/open", token=token, method="POST",
            )
            if connection_status != 400:
                raise RuntimeError(f"packaged connection route returned {connection_status}, expected 400")
            desktop_pty_status, _ = _request(
                base, "/api/sessions", token=token, method="POST",
                payload={"profile": "Missing desktop viewer"},
            )
            if desktop_pty_status != 400:
                raise RuntimeError("packaged desktop connection must not create a PTY")
            layout = {"type": "pane", "title": "Package workspace"}
            workspace_status, _ = _request(
                base, "/api/workspaces/Package", token=token, method="PUT",
                payload={"layout": layout, "path": isolated, "session_ids": []},
            )
            project = Path(isolated) / "project"
            project.mkdir()
            patch_status, _ = _request(
                base, "/api/workspaces/Package", token=token, method="PATCH",
                payload={"path": str(project)},
            )
            read_status, saved = _request(base, "/api/workspaces/Package", token=token)
            if (
                workspace_status != 204 or patch_status != 204 or read_status != 200
                or not isinstance(saved, dict) or saved.get("layout") != layout
                or saved.get("path") != str(project) or saved.get("session_ids") != []
            ):
                raise RuntimeError("packaged metadata edit changed the workspace layout or ownership")
            history_status, history = _request(base, "/api/config/history", token=token)
            if history_status != 200 or not isinstance(history, list) or not history:
                raise RuntimeError("packaged settings backup was not retained")
            restore_status, _ = _request(
                base, f"/api/config/history/{history[0]['id']}/restore", token=token, method="POST",
            )
            after_status, restored_config = _request(base, "/api/config/full", token=token)
            if (
                before_status != 200 or restore_status != 204 or after_status != 200
                or restored_config != before_config
            ):
                raise RuntimeError("packaged settings restore did not recover the previous configuration")
            update_status, _ = _request(base, "/api/update", token=token, timeout=20)
            # 502 is the deliberate network-failure mapping, so an offline or
            # rate-limited machine must not fail the release gate. Only a 500
            # (ModuleNotFoundError from a missing hiddenimport) is a packaging
            # failure, which is exactly what this check exists to catch.
            if update_status == 500:
                raise RuntimeError(
                    f"packaged update route returned {update_status} "
                    "(quickterm.update missing from hiddenimports?)"
                )

            host_status, host = _request(base, "/api/host", token=token)
            if host_status != 200 or not isinstance(host, dict) or not host.get("managed"):
                raise RuntimeError(f"packaged host route returned {host_status}: {host!r}")

            package_bytes = sum(
                path.stat().st_size for path in executable.parent.rglob("*") if path.is_file()
            )
            print(
                "packaged smoke passed: "
                f"v{health.get('version')} | PTY alive | auth/replay/live/exit | "
                f"dynamic routes | {package_bytes / 1024 / 1024:.2f} MB | "
                f"{len(replay)} replay bytes, {len(live)} live bytes"
            )
        finally:
            _stop(base, process, port, isolated)


def _token(appdata: str) -> str:
    return (Path(appdata) / "quickterm" / "runtime.token").read_text(encoding="utf-8").strip()


def _stop(base: str, process: subprocess.Popen | None, port: int, appdata: str) -> None:
    """Retire the backend the way the tray's Quit does, then make sure."""
    try:
        _request(base, "/api/host/retire", token=_token(appdata), method="POST",
                 payload={"force": True})
    except (OSError, urllib.error.URLError):
        pass
    if process is not None:
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    _wait_port_closed(port, timeout=20)


def _install_copy(executable: Path, target: Path, *, stamp: float) -> Path:
    """A second install of the same build with its own build id (its exe time)."""
    shutil.copytree(executable.parent, target)
    exe = target / executable.name
    os.utime(exe, (stamp, stamp))
    return exe


def _host(base: str, appdata: str) -> dict:
    status, info = _request(base, "/api/host", token=_token(appdata))
    if status != 200 or not isinstance(info, dict):
        raise RuntimeError(f"/api/host answered {status}: {info!r}")
    return info


def update_smoke(executable: Path, port: int) -> None:
    executable = executable.resolve()
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(
        prefix="quickterm-update-smoke-", ignore_cleanup_errors=True
    ) as isolated:
        env = os.environ.copy()
        env["APPDATA"] = isolated
        host_dir = Path(isolated) / "host"
        env["QUICKTERM_HOST_DIR"] = str(host_dir)
        now = time.time()
        old = _install_copy(executable, Path(isolated) / "old", stamp=now - 86400)
        new = _install_copy(executable, Path(isolated) / "new", stamp=now)
        try:
            first = subprocess.run(
                [str(old), "--background", "--port", str(port)], env=env, timeout=120, check=False
            )
            if first.returncode != 0:
                raise RuntimeError(f"the first launcher exited {first.returncode}")
            before = _host(base, isolated)
            if not before.get("copy"):
                raise RuntimeError(f"the backend does not run from its copy: {before!r}")
            if not (host_dir / str(before["build"]) / "QuickTerm-host.exe").is_file():
                raise RuntimeError("the backend copy is not where the launcher put it")
            status, spawned = _request(
                base, "/api/sessions", token=_token(isolated), method="POST",
                payload={"cmd": "cmd.exe", "args": ["/q", "/k"], "cwd": isolated,
                         "name": "Update smoke", "kind": "terminal"},
            )
            if status != 200 or not isinstance(spawned, dict):
                raise RuntimeError(f"PTY spawn from the copy failed ({status}): {spawned!r}")

            # What Setup does to the program folder: nothing in it may be held.
            shutil.rmtree(old.parent)
            status, sessions = _request(base, "/api/sessions?metrics=false", token=_token(isolated))
            if not any(s.get("id") == spawned["id"] and s.get("alive") for s in sessions):
                raise RuntimeError("the terminal died with the install folder")

            second = subprocess.run(
                [str(new), "--background", "--port", str(port)], env=env, timeout=120, check=False
            )
            if second.returncode != 0:
                raise RuntimeError(f"the second launcher exited {second.returncode}")
            after = _host(base, isolated)
            if after["build"] == before["build"] or after["pid"] == before["pid"]:
                raise RuntimeError(f"the new build did not take over: {before!r} -> {after!r}")
            builds = sorted(p.name for p in host_dir.iterdir() if not p.name.startswith("."))
            if builds != sorted([before["build"], after["build"]]):
                raise RuntimeError(f"unexpected copies in the host folder: {builds}")
            print(
                "update smoke passed: install folder replaced under a running backend | "
                f"{before['build']} -> {after['build']} | copies kept: {len(builds)}"
            )
        finally:
            _stop(base, None, port, isolated)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "executable",
        nargs="?",
        type=Path,
        default=Path("dist/QuickTerm/QuickTerm.exe"),
    )
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--skip-update", action="store_true", help="skip the update phase")
    args = parser.parse_args()
    smoke(args.executable, args.port or _free_port())
    if not args.skip_update:
        update_smoke(args.executable, args.port or _free_port())


if __name__ == "__main__":
    main()
