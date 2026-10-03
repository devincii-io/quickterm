"""Read ~/.ssh/config and locate the OpenSSH client.

`parse` is pure apart from the Include globs. It follows ssh_config(5) where
it matters for listing hosts: the first value obtained for a keyword wins,
Include is followed, Match blocks are skipped, and only literal Host patterns
become aliases. `resolve` asks `ssh -G` for the real answer and falls back to
the parser. Key files are never read.
"""

from __future__ import annotations

import fnmatch
import glob
import os
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

MAX_INCLUDE_DEPTH = 8
_ALIAS = re.compile(r"^[A-Za-z0-9._@:%-]{1,255}$")
_KEYWORD = re.compile(r"([^\s=]+)(?:\s*=\s*|\s+)(.*)")
_FIELDS = {"hostname", "user", "port", "identityfile", "proxyjump"}


@dataclass
class HostEntry:
    alias: str
    hostname: str | None = None
    user: str | None = None
    port: int | None = None
    identity_file: str | None = None
    proxy_jump: str | None = None


def config_path() -> Path:
    return Path.home() / ".ssh" / "config"


def valid_alias(alias: object) -> bool:
    return isinstance(alias, str) and not alias.startswith("-") and bool(_ALIAS.fullmatch(alias))


def openssh_path(kind: str) -> Path | None:
    """ssh or sftp from the Windows optional feature, else from PATH."""
    if kind not in ("ssh", "sftp"):
        raise ValueError(f"unknown OpenSSH program: {kind}")
    if os.name == "nt":
        system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "OpenSSH" / f"{kind}.exe"
        try:
            if system.is_file():
                return system
        except OSError:
            pass
    found = shutil.which(kind)
    return Path(found) if found else None


def _read_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _words(text: str) -> list[str]:
    """Arguments of one line: double quotes group, an unquoted # ends the line."""
    words: list[str] = []
    current: list[str] = []
    quoted = False
    started = False
    for char in text:
        if char == '"':
            quoted = not quoted
            started = True
        elif char.isspace() and not quoted:
            if started:
                words.append("".join(current))
                current, started = [], False
        elif char == "#" and not quoted and not started:
            break
        else:
            current.append(char)
            started = True
    if started:
        words.append("".join(current))
    return words


def _directives(
    text: str, base_dir: Path, read: Callable[[Path], str | None], depth: int, stack: frozenset[str]
) -> list[tuple[str, list[str]]]:
    """Every (keyword, args) line in order, with Include expanded in place."""
    out: list[tuple[str, list[str]]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = _KEYWORD.fullmatch(line)
        if match is None:
            continue
        keyword = match.group(1).lower()
        args = _words(match.group(2))
        if keyword != "include":
            out.append((keyword, args))
            continue
        if depth >= MAX_INCLUDE_DEPTH:
            continue
        for pattern in args:
            expanded = os.path.expanduser(pattern)
            if not os.path.isabs(expanded):
                expanded = str(base_dir / expanded)
            for name in sorted(glob.glob(expanded)):
                key = os.path.normcase(os.path.abspath(name))
                if key in stack:
                    continue
                included = read(Path(name))
                if included is not None:
                    out += _directives(included, base_dir, read, depth + 1, stack | {key})
    return out


def _literal(pattern: str) -> bool:
    return not pattern.startswith("!") and "*" not in pattern and "?" not in pattern


def _applies(patterns: list[str], alias: str) -> bool:
    hit = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        if fnmatch.fnmatchcase(alias, pattern[1:] if negated else pattern):
            if negated:
                return False
            hit = True
    return hit


def parse(
    text: str,
    *,
    base_dir: Path,
    read: Callable[[Path], str | None] = _read_file,
    depth: int = 0,
) -> list[HostEntry]:
    """Literal Host aliases with the first value each keyword obtains for them."""
    directives = _directives(text, Path(base_dir), read, depth, frozenset())
    aliases: list[str] = []
    for keyword, args in directives:
        if keyword == "host":
            for pattern in args:
                if _literal(pattern) and pattern not in aliases:
                    aliases.append(pattern)
    return [_entry(alias, directives) for alias in aliases]


def _entry(alias: str, directives: list[tuple[str, list[str]]]) -> HostEntry:
    values: dict[str, str] = {}
    active = True  # lines before the first Host apply to every host
    for keyword, args in directives:
        if keyword == "host":
            active = _applies(args, alias)
        elif keyword == "match":
            active = False
        elif active and keyword in _FIELDS and args and keyword not in values:
            values[keyword] = args[0]
    entry = HostEntry(alias=alias)
    if "hostname" in values:
        entry.hostname = values["hostname"].replace("%h", alias)
    entry.user = values.get("user")
    port = values.get("port", "")
    entry.port = int(port) if port.isdecimal() and 0 < int(port) < 65536 else None
    if "identityfile" in values and values["identityfile"].lower() != "none":
        entry.identity_file = os.path.expanduser(values["identityfile"])
    jump = values.get("proxyjump")
    entry.proxy_jump = None if jump is None or jump.lower() == "none" else jump
    return entry


def hosts(path: Path | None = None) -> list[dict]:
    """Every literal alias in the user's ssh_config, as plain dicts."""
    path = Path(path) if path is not None else config_path()
    text = _read_file(path)
    if text is None:
        return []
    return [asdict(entry) for entry in parse(text, base_dir=path.parent)]


def parse_dump(output: str) -> dict:
    """The fields QuickTerm uses from `ssh -G` output (lowercase keys)."""
    result: dict = {"hostname": None, "user": None, "port": None, "identity_files": [], "proxy_jump": None}
    for line in output.splitlines():
        key, _sep, value = line.strip().partition(" ")
        value = value.strip()
        if not value:
            continue
        if key == "hostname" and result["hostname"] is None:
            result["hostname"] = value
        elif key == "user" and result["user"] is None:
            result["user"] = value
        elif key == "port" and result["port"] is None and value.isdecimal():
            result["port"] = int(value)
        elif key == "identityfile":
            result["identity_files"].append(os.path.expanduser(value))
        elif key == "proxyjump" and result["proxy_jump"] is None:
            result["proxy_jump"] = None if value.lower() == "none" else value
    return result


def resolve(alias: str, *, timeout: float = 3.0) -> dict:
    """`{alias, hostname, user, port, identity_files, proxy_jump}` for one alias.

    Blocking (runs ssh). ValueError for an alias that could pass as an
    option, KeyError when neither ssh nor the parser knows it.
    """
    if not valid_alias(alias):
        raise ValueError("invalid host alias")
    ssh = openssh_path("ssh")
    if ssh is not None:
        try:
            completed = subprocess.run(
                [str(ssh), "-G", alias],
                capture_output=True,
                timeout=timeout,
                check=False,
                stdin=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if completed.returncode == 0:
                dump = parse_dump(completed.stdout.decode("utf-8", errors="replace"))
                return {"alias": alias, **dump}
        except (OSError, subprocess.SubprocessError):
            pass
    for entry in hosts():
        if entry["alias"] == alias:
            identity = entry["identity_file"]
            return {
                "alias": alias,
                "hostname": entry["hostname"],
                "user": entry["user"],
                "port": entry["port"],
                "identity_files": [identity] if identity else [],
                "proxy_jump": entry["proxy_jump"],
            }
    raise KeyError(alias)
