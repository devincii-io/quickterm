"""Release smoke test for the frozen Windows application folder.

Starts the real packaged app with isolated configuration, creates a PTY through
the authenticated API, verifies replay and live WebSocket traffic, then checks
the two importlib-backed routes that are easy to omit from a PyInstaller build.
"""

from __future__ import annotations

import argparse
import json
import os
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
        process = subprocess.Popen([str(executable), "--port", str(port)], env=env)
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
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            _wait_port_closed(port)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "executable",
        nargs="?",
        type=Path,
        default=Path("dist/QuickTerm/QuickTerm.exe"),
    )
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    smoke(args.executable, args.port or _free_port())


if __name__ == "__main__":
    main()
