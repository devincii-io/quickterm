"""Run a program in a workspace's folder, on this computer or on its SSH host.

The one way backend code runs something like `git status` for a workspace, so
the same caller works for a local folder and for a folder on the host named
by `Workspace.host`. No local shell: `argv` is passed as a list. On a host the
remote command is `cd <folder> && <argv>`, every word POSIX-quoted, run by
OpenSSH with `-o BatchMode=yes` so a password prompt can never hang a request.
"""

from __future__ import annotations

import importlib
import json
import os
import re
import shlex
import subprocess
import threading
import time
from typing import Any

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

NEEDS_OPENSSH = "remote workspaces need an OpenSSH profile"
# A folder check and `exists` answer from memory for this long.
EXISTS_TTL_S = 30.0


class RemoteUnavailable(FileNotFoundError):
    """The workspace's host cannot be reached through a usable SSH profile."""


# --- quoting ----------------------------------------------------------------


def posix_quote(word: str) -> str:
    """One word of a POSIX shell command line. ValueError for NUL or a line
    break, which no quoting carries safely through every remote shell."""
    if any(char in word for char in ("\0", "\n", "\r")):
        raise ValueError("a remote command word must not contain NUL or a line break")
    return shlex.quote(word)


def folder_word(path: str) -> str:
    """A remote folder as one shell word; a leading `~` stays unquoted so the
    remote shell expands it to the home folder."""
    if path == "~":
        return "~"
    if path.startswith("~/"):
        rest = path[2:]
        return "~/" + posix_quote(rest) if rest else "~/"
    return posix_quote(path)


def remote_command(folder: str | None, argv: list[str]) -> str:
    words = " ".join(posix_quote(word) for word in argv)
    return f"cd {folder_word(folder)} && {words}" if folder else words


# --- the SSH profile behind a host ---------------------------------------------

_config_cache: dict[str, Any] = {"key": None, "profiles": []}
_config_lock = threading.Lock()


def _saved_profiles() -> list[Any]:
    """The profiles in config.json, read without migrating or writing it.

    The running server holds the config in memory, but this module is called
    from places that have no handle on it; the file is the same truth, read
    again only when it changed.
    """
    config = importlib.import_module("quickterm.config")
    path = config.config_dir() / "config.json"
    try:
        stat = path.stat()
    except OSError:
        return []
    key = (stat.st_mtime_ns, stat.st_size)
    with _config_lock:
        if _config_cache["key"] == key:
            return list(_config_cache["profiles"])
    try:
        cfg = config.config_from_dict(json.loads(config.read_text(path)))
        profiles = list(cfg.profiles)
    except (OSError, ValueError, TypeError, AttributeError):
        profiles = []
    with _config_lock:
        _config_cache.update(key=key, profiles=profiles)
    return profiles


def find_profile(host: str, profiles: list[Any] | None = None) -> Any:
    """The OpenSSH profile named `host`. RemoteUnavailable with a sentence
    for the user when there is none, or it uses PuTTY."""
    listed = _saved_profiles() if profiles is None else profiles
    profile = next((item for item in listed if getattr(item, "name", None) == host), None)
    if profile is None or getattr(profile, "terminal_type", None) != "ssh":
        raise RemoteUnavailable(f'no SSH profile named "{host}"')
    if getattr(profile, "ssh_client", None) != "openssh":
        raise RemoteUnavailable(NEEDS_OPENSSH)
    return profile


def ssh_argv(profile: Any, options: list[str], command: str | None = None) -> list[str]:
    """The full OpenSSH argv for a profile: program, `options`, the profile's
    port, key, ProxyJump and own arguments, the target, then `command`."""
    launch = importlib.import_module("quickterm.launch")
    try:
        program, args = launch.openssh_args(profile, options)
    except ValueError as exc:
        raise RemoteUnavailable(str(exc)) from exc
    return [program, *args, *([command] if command is not None else [])]


def _host(ws: Any) -> str | None:
    host = getattr(ws, "host", None)
    return host if isinstance(host, str) and host.strip() else None


def _folder(ws: Any) -> str | None:
    path = getattr(ws, "path", None)
    return path if isinstance(path, str) and path.strip() else None


def _batch_options(timeout: float) -> list[str]:
    seconds = max(1, min(int(timeout), 15))
    # No forwardings: a background call must not fight a terminal of the same
    # profile over a port the profile forwards.
    return ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={seconds}", "-o", "ClearAllForwardings=yes", "-T"]


def remote_argv(ws: Any, argv: list[str], *, timeout: float = 10.0) -> list[str]:
    host = _host(ws)
    if host is None:
        raise ValueError("not a remote workspace")
    profile = find_profile(host)
    return ssh_argv(profile, _batch_options(timeout), remote_command(_folder(ws), argv))


def _run(argv: list[str], timeout: float, input: str | None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        input=input,
        stdin=subprocess.DEVNULL if input is None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_NO_WINDOW,
    )


_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# Git must never stop to ask for a password in a background call, and must
# work on the workspace folder, not on a repository the backend's own
# environment happens to name.
GIT_ENV: dict[str, str | None] = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_DIR": None,
    "GIT_WORK_TREE": None,
    "GIT_INDEX_FILE": None,
    "GIT_COMMON_DIR": None,
}


def _with_env(argv: list[str], env: dict[str, str | None]) -> list[str]:
    """`argv` behind POSIX `env`: `-u NAME` for a None value, NAME=value else.

    ssh carries no environment of its own (SendEnv needs the server's
    consent), so on a host the variables travel as words of the command.
    """
    prefix = ["env"]
    for name, value in env.items():
        if not _ENV_NAME.fullmatch(name):
            raise ValueError(f"not an environment variable name: {name!r}")
        prefix += ["-u", name] if value is None else [f"{name}={value}"]
    return [*prefix, *argv]


def _local_env(env: dict[str, str | None]) -> dict[str, str]:
    merged = dict(os.environ)
    for name, value in env.items():
        # Windows names are case-insensitive; drop every spelling first.
        for existing in [key for key in merged if key.upper() == name.upper()]:
            del merged[existing]
        if value is not None:
            merged[name] = value
    return merged


def run(
    ws: Any, argv: list[str], *, timeout: float = 10.0, input: str | None = None,
    env: dict[str, str | None] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `argv` in the workspace folder and return the finished process.

    `env` sets (a string) or removes (None) variables for this one program,
    on this computer and on a host alike. Never put a secret in it: on a host
    the values are part of the remote command line.

    Raises FileNotFoundError when the program or the local folder is missing,
    or the host has no usable OpenSSH profile (RemoteUnavailable), and
    subprocess.TimeoutExpired after `timeout` seconds. On a host, a missing
    folder is a non-zero exit with the remote shell's message.
    """
    if _host(ws) is not None:
        remote = _with_env(argv, env) if env else argv
        return _run(remote_argv(ws, remote, timeout=timeout), timeout, input)
    folder = _folder(ws)
    if folder is None or not os.path.isdir(folder):
        raise FileNotFoundError(f"workspace folder not found: {folder}")
    return subprocess.run(
        argv,
        cwd=folder,
        input=input,
        stdin=subprocess.DEVNULL if input is None else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_NO_WINDOW,
        env=_local_env(env) if env else None,
    )


# --- folder checks --------------------------------------------------------------

_exists_cache: dict[tuple[str, str], tuple[float, bool]] = {}
_checking: set[tuple[str, str]] = set()


def _ssh_message(result: subprocess.CompletedProcess[str]) -> str:
    lines = [line.strip() for line in (result.stderr or "").splitlines() if line.strip()]
    return " ".join(lines[-3:])[:500]


def check_folder(
    host: str, path: str, *, profiles: list[Any] | None = None, timeout: float = 10.0
) -> tuple[bool, str]:
    """`ssh -o BatchMode=yes <profile args> <host> test -d <path>`.

    Returns (found, what ssh said). Blocking. A profile that is missing or
    uses PuTTY raises RemoteUnavailable.
    """
    profile = find_profile(host, profiles)
    argv = ssh_argv(profile, _batch_options(timeout), f"test -d {folder_word(path)}")
    try:
        result = _run(argv, timeout + 5, None)
    except subprocess.TimeoutExpired:
        return False, f"ssh to {host} did not answer within {int(timeout)} s"
    except OSError as exc:
        raise RemoteUnavailable(str(exc)) from exc
    if result.returncode == 0:
        _exists_cache[(host, path)] = (time.monotonic(), True)
        return True, ""
    message = _ssh_message(result)
    if result.returncode == 1:
        # `test -d` said no (stderr may only hold the host's login noise);
        # ssh itself fails with 255.
        _exists_cache[(host, path)] = (time.monotonic(), False)
        return False, f"{path} is not a folder on {host}"
    return False, message or f"ssh exited with {result.returncode}"


def cached_exists(ws: Any) -> bool:
    """`exists` for a request handler: what the last check found, never a
    wait for ssh. Unknown counts as present (a password-only host never
    answers a background check), and a stale entry is checked again in the
    background."""
    host, folder = _host(ws), _folder(ws)
    if host is None:
        return exists(ws)
    if folder is None:
        return False
    key = (host, folder)
    cached = _exists_cache.get(key)
    if cached is None or time.monotonic() - cached[0] >= EXISTS_TTL_S:
        with _config_lock:
            start = key not in _checking
            _checking.add(key)
        if start:
            def check() -> None:
                try:
                    exists(ws)
                finally:
                    with _config_lock:
                        _checking.discard(key)

            threading.Thread(target=check, name="remote-exists", daemon=True).start()
    return True if cached is None else cached[1]


def exists(ws: Any) -> bool:
    folder = _folder(ws)
    host = _host(ws)
    if host is None:
        return folder is not None and os.path.isdir(folder)
    if folder is None:
        return False
    cached = _exists_cache.get((host, folder))
    if cached is not None and time.monotonic() - cached[0] < EXISTS_TTL_S:
        return cached[1]
    try:
        check_folder(host, folder, timeout=5.0)
    except FileNotFoundError:
        return False
    # Only a definite answer was cached; a host ssh could not reach (a
    # password, the network) does not make the folder missing.
    cached = _exists_cache.get((host, folder))
    if cached is None or time.monotonic() - cached[0] >= EXISTS_TTL_S:
        _exists_cache[(host, folder)] = (time.monotonic(), True)
        return True
    return cached[1]
