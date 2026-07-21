"""Loopback auth token: the shared secret that proves a caller is QuickTerm's
own window rather than any other process that can reach 127.0.0.1.

The Host/Origin guard in server.py only stops *browser* attacks; it cannot stop
a native local program from forging a Host header. The token closes that gap:
it is delivered to the window through its launch URL fragment (never sent to the
server, never in logs) and stored in a user-private file for out-of-band callers.
"""

from __future__ import annotations

import os
import secrets
import time

from quickterm.config import config_dir

TOKEN_FILE = "runtime.token"
SUBPROTOCOL_PREFIX = "qtauth."  # WebSocket clients can't set headers; they pass
HEADER = "x-quickterm-token"    # the token as this subprotocol instead.


def token_path():
    return config_dir() / TOKEN_FILE


def get_or_create_token() -> str:
    """Return the persistent per-install token, creating it on first use.

    Persisted (not per-run) so every QuickTerm window and any authorized helper
    share one secret. The file lives under %APPDATA%/quickterm, which is already
    restricted to the current user, so other users' processes cannot read it.
    """
    path = token_path()
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            if os.name != "nt":
                path.chmod(0o600)
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(32)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process won first-start creation. Use its token so all windows
        # agree instead of overwriting it with a different secret.
        for _ in range(20):
            try:
                existing = path.read_text(encoding="utf-8").strip()
                if existing:
                    if os.name != "nt":
                        path.chmod(0o600)
                    return existing
            except OSError:
                pass
            time.sleep(0.01)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_TRUNC, 0o600)
        except OSError:
            return token
    except OSError:
        return token  # in-memory token still works for this run
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(token)
            handle.flush()
            os.fsync(handle.fileno())
        if os.name != "nt":
            path.chmod(0o600)
    except OSError:
        try:
            path.unlink()
        except OSError:
            pass
    return token
