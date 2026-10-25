"""Run a program in a workspace's folder: on this computer, in WSL, or over SSH.

The one way backend code runs something like `git status` for a workspace, so
the same caller works wherever `Workspace.host` puts the folder. No local
shell: `argv` is passed as a list. In WSL it is
`wsl.exe -d <distro> --cd <folder> --exec ...`, which hands Linux the words as
they are. Over SSH the remote command is `cd <folder> && <argv>`, every word
POSIX-quoted, run by OpenSSH with `-o BatchMode=yes` so a password prompt can
never hang a request.
"""

from __future__ import annotations

import importlib
import os
import re
import shlex
import subprocess
import threading
import time
from typing import Any

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

OPENSSH_MISSING = (
    "OpenSSH client not found. Install it under Settings > Apps > Optional features > OpenSSH Client."
)
WSL_MISSING = "WSL is not installed"
# A folder check and `exists` answer from memory for this long.
EXISTS_TTL_S = 30.0
# wsl.exe --cd on a folder that is not there says so on stderr and runs the
# program in / anyway; this refuses to go on there. The words after it are
# only ever "$@", never read by the shell.
_WSL_GUARD = 'if [ "$(pwd -P)" = / ]; then printf "%s is not a folder\\n" "$0" >&2; exit 1; fi; exec "$@"'


class RemoteUnavailable(FileNotFoundError):
    """The workspace's location cannot be reached from here (no ssh, no WSL)."""


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


# --- the programs that reach a location ----------------------------------------


def ssh_program() -> str:
    """OpenSSH's ssh. RemoteUnavailable when it is not installed."""
    # Through sys.modules so tests can stub the client lookup.
    found = importlib.import_module("quickterm.ssh_config").openssh_path("ssh")
    if found is None:
        raise RemoteUnavailable(OPENSSH_MISSING)
    return str(found)


def wsl_program() -> str:
    found = importlib.import_module("quickterm.shells").wsl_program()
    if found is None:
        raise RemoteUnavailable(WSL_MISSING)
    return str(found)


def ssh_argv(destination: str, options: list[str], command: str | None = None) -> list[str]:
    """ssh, `options`, the destination (checked by workspace.normalize_host,
    so it cannot pass as an option), then `command`."""
    return [ssh_program(), *options, destination, *([command] if command is not None else [])]


def wsl_argv(distro: str, folder: str | None, argv: list[str]) -> list[str]:
    """`argv` in `folder` (`~` without one) of a WSL distribution. --cd
    expands `~` itself; nothing reads the words of `argv` again."""
    where = folder or "~"
    head = [wsl_program(), "-d", distro, "--cd", where, "--exec"]
    if where == "/":
        return [*head, *argv]
    return [*head, "sh", "-c", _WSL_GUARD, where, *argv]


def _host(ws: Any) -> str | None:
    host = getattr(ws, "host", None)
    return host if isinstance(host, str) and host.strip() else None


def _distro(host: str) -> str | None:
    return importlib.import_module("quickterm.workspace").wsl_distro(host)


def _folder(ws: Any) -> str | None:
    path = getattr(ws, "path", None)
    return path if isinstance(path, str) and path.strip() else None


# --- sleeping WSL distributions -------------------------------------------------

RUNNING_TTL_S = 15.0
_running: tuple[float, frozenset[str]] | None = None
_running_lock = threading.Lock()


def _running_distros() -> frozenset[str]:
    """The running WSL distributions, cached briefly. Listing them starts none."""
    global _running
    with _running_lock:
        if _running is not None and time.monotonic() - _running[0] < RUNNING_TTL_S:
            return _running[1]
    names: frozenset[str] = frozenset()
    try:
        result = subprocess.run(
            [wsl_program(), "--list", "--running", "--quiet"],
            capture_output=True, timeout=3, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # With none running wsl.exe exits non-zero and prints a sentence.
        if result.returncode == 0:
            raw = result.stdout or b""
            text = raw.decode("utf-16-le" if b"\x00" in raw else "utf-8", errors="replace")
            names = frozenset(line.strip() for line in text.splitlines() if line.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    with _running_lock:
        _running = (time.monotonic(), names)
    return names


def asleep(ws: Any) -> bool:
    """True for a workspace in a WSL distribution that is not running.

    Background checks (folder, git, the board) skip such a workspace: any
    wsl.exe call into a distribution boots it and keeps its VM in memory.
    Blocking (wsl.exe --list), so only background threads call it."""
    host = _host(ws)
    distro = _distro(host) if host else None
    return distro is not None and distro not in _running_distros()


def _batch_options(timeout: float) -> list[str]:
    seconds = max(1, min(int(timeout), 15))
    # No forwardings: a background call must not fight a terminal to the same
    # host over a port its ssh_config forwards.
    return ["-o", "BatchMode=yes", "-o", f"ConnectTimeout={seconds}", "-o", "ClearAllForwardings=yes", "-T"]


def remote_argv(ws: Any, argv: list[str], *, timeout: float = 10.0) -> list[str]:
    """The local argv that runs `argv` in the folder of a WSL or SSH workspace."""
    host = _host(ws)
    if host is None:
        raise ValueError("not a WSL or SSH workspace")
    distro = _distro(host)
    if distro is not None:
        return wsl_argv(distro, _folder(ws), argv)
    return ssh_argv(host, _batch_options(timeout), remote_command(_folder(ws), argv))


def _wsl_env() -> dict[str, str]:
    # wsl.exe writes its own messages in UTF-16 unless told otherwise.
    return {**os.environ, "WSL_UTF8": "1"}


def _run(
    argv: list[str], timeout: float, input: str | None, env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
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
        env=env,
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

    The options come first: env reads everything after the first assignment
    as the command. Neither ssh nor wsl.exe carries this process's
    environment, so the variables travel as words of the command.
    """
    unset: list[str] = []
    assign: list[str] = []
    for name, value in env.items():
        if not _ENV_NAME.fullmatch(name):
            raise ValueError(f"not an environment variable name: {name!r}")
        if value is None:
            unset += ["-u", name]
        else:
            assign.append(f"{name}={value}")
    return ["env", *unset, *assign, *argv]


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
    wherever it runs. Never put a secret in it: in WSL and over SSH the
    values are part of the command line.

    Raises FileNotFoundError when the program or the local folder is missing,
    or there is no ssh or WSL to reach the location (RemoteUnavailable), and
    subprocess.TimeoutExpired after `timeout` seconds. In WSL and over SSH a
    missing folder is a non-zero exit with a message on stderr.
    """
    host = _host(ws)
    if host is not None:
        words = _with_env(argv, env) if env else argv
        local_env = _wsl_env() if _distro(host) is not None else None
        return _run(remote_argv(ws, words, timeout=timeout), timeout, input, local_env)
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
_lock = threading.Lock()


def _message(result: subprocess.CompletedProcess[str]) -> str:
    lines = [line.strip() for line in (result.stderr or "").splitlines() if line.strip()]
    return " ".join(lines[-3:])[:500]


def check_folder(host: str, path: str, *, timeout: float = 10.0) -> tuple[bool, str]:
    """Is `path` a folder at the location `host` (WSL or SSH)?

    Over SSH `ssh -o BatchMode=yes <destination> test -d <path>`; in WSL
    `wsl.exe -d <distro> --cd <path>` and the guard. Returns (found, what was
    said). Blocking. RemoteUnavailable when ssh or WSL is not installed.
    """
    distro = _distro(host)
    if distro is not None:
        argv = wsl_argv(distro, path, ["true"])
        where, env = f"in WSL: {distro}", _wsl_env()
        program = "WSL"
    else:
        argv = ssh_argv(host, _batch_options(timeout), f"test -d {folder_word(path)}")
        where, env = f"on {host}", None
        program = f"ssh to {host}"
    try:
        result = _run(argv, timeout + 5, None, env)
    except subprocess.TimeoutExpired:
        return False, f"{program} did not answer within {int(timeout)} s"
    except OSError as exc:
        raise RemoteUnavailable(str(exc)) from exc
    if result.returncode == 0:
        _exists_cache[(host, path)] = (time.monotonic(), True)
        return True, ""
    message = _message(result)
    if result.returncode == 1:
        # `test -d` or the WSL guard said no (stderr may only hold login
        # noise); ssh itself fails with 255, wsl.exe with its own codes.
        _exists_cache[(host, path)] = (time.monotonic(), False)
        return False, f"{path} is not a folder {where}"
    return False, message or f"{program} exited with {result.returncode}"


def cached_exists(ws: Any) -> bool:
    """`exists` for a request handler: what the last check found, never a
    wait for ssh or WSL. Unknown counts as present (a password-only host
    never answers a background check), and a stale entry is checked again in
    the background."""
    host, folder = _host(ws), _folder(ws)
    if host is None:
        return exists(ws)
    if folder is None:
        return False
    key = (host, folder)
    cached = _exists_cache.get(key)
    if cached is None or time.monotonic() - cached[0] >= EXISTS_TTL_S:
        with _lock:
            start = key not in _checking
            _checking.add(key)
        if start:
            def check() -> None:
                try:
                    if not asleep(ws):
                        exists(ws)
                finally:
                    with _lock:
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
    # Only a definite answer was cached; a location that could not be reached
    # (a password, the network) does not make the folder missing.
    cached = _exists_cache.get((host, folder))
    if cached is None or time.monotonic() - cached[0] >= EXISTS_TTL_S:
        _exists_cache[(host, folder)] = (time.monotonic(), True)
        return True
    return cached[1]
