"""Launch arguments for configured terminal and desktop connections."""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any

from . import putty_tools

DESKTOP_TYPES = frozenset({"rdp", "vnc"})
CONNECTION_TYPES = frozenset({"telnet", "serial", "docker", "podman", "kubernetes", *DESKTOP_TYPES})
OPTION_NAMES = frozenset({
    "host", "port", "device", "baud", "data_bits", "parity", "stop_bits", "flow",
    "target", "shell", "user", "context", "namespace", "container", "fullscreen",
    "width", "height",
})


def validate(profile: Any) -> None:
    options = getattr(profile, "connection", {})
    if not isinstance(options, dict) or any(
        key not in OPTION_NAMES or not isinstance(value, str) or "\0" in value
        for key, value in options.items()
    ):
        raise ValueError("connection options must contain named text fields")
    kind = profile.terminal_type
    if kind in DESKTOP_TYPES and (profile.autostart or profile.keybinding):
        raise ValueError("Desktop clients must be opened explicitly from Connections")
    required = "host" if kind in {"telnet", *DESKTOP_TYPES} else (
        "device" if kind == "serial" else "target" if kind in {"docker", "podman", "kubernetes"} else None
    )
    if required and not options.get(required, "").strip():
        raise ValueError(f"{kind}: {required} is required")
    for key, low, high in (("port", 1, 65535), ("baud", 50, 4000000), ("width", 200, 16384), ("height", 200, 16384)):
        value = options.get(key)
        if value and (not value.isdecimal() or not low <= int(value) <= high):
            raise ValueError(f"{key} must be between {low} and {high}")
    if kind == "serial":
        for key, values in {
            "data_bits": {"5", "6", "7", "8"}, "parity": {"n", "o", "e", "m", "s"},
            "stop_bits": {"1", "1.5", "2"}, "flow": {"N", "X", "R", "D"},
        }.items():
            if options.get(key) and options[key] not in values:
                raise ValueError(f"invalid serial {key}")
    if options.get("fullscreen") not in {None, "", "true", "false"}:
        raise ValueError("fullscreen must be true or false")


def resolve(profile: Any, cwd: str | None) -> tuple[str, list[str], str | None]:
    validate(profile)
    kind = profile.terminal_type
    options = profile.connection
    extra = list(profile.args or [])
    configured = (profile.cmd or "").strip()
    if kind in {"telnet", "serial"}:
        tool = putty_tools.plink_path()
        if tool is None:
            raise ValueError("The bundled PuTTY client is missing")
        if kind == "telnet":
            args = ["-telnet"]
            if options.get("port"):
                args += ["-P", options["port"]]
            args += extra + [options["host"]]
        else:
            settings = ",".join(options.get(key) or default for key, default in (
                ("baud", "9600"), ("data_bits", "8"), ("parity", "n"), ("stop_bits", "1"), ("flow", "N"),
            ))
            args = ["-serial", options["device"], "-sercfg", settings] + extra
        return str(tool), args, cwd
    if kind in {"docker", "podman", "kubernetes"}:
        args = []
        if options.get("context"):
            args += ["--context" if kind != "podman" else "--connection", options["context"]]
        if kind == "kubernetes" and options.get("namespace"):
            args += ["--namespace", options["namespace"]]
        args += ["exec", "-it"]
        if kind == "kubernetes" and options.get("container"):
            args += ["-c", options["container"]]
        if kind != "kubernetes" and options.get("user"):
            args += ["--user", options["user"]]
        args += extra + [options["target"]]
        if kind == "kubernetes":
            args += ["--"]
        args += [options.get("shell") or "/bin/sh"]
        return configured or ("kubectl" if kind == "kubernetes" else kind), args, cwd
    host = options["host"]
    if kind == "rdp":
        if os.name != "nt":
            raise ValueError("RDP uses the Windows Remote Desktop client")
        args = [f"/v:{host}" + (f":{options['port']}" if options.get("port") else "")]
        if options.get("fullscreen") == "true":
            args.append("/f")
        else:
            for key, flag in (("width", "w"), ("height", "h")):
                if options.get(key):
                    args.append(f"/{flag}:{options[key]}")
        executable = configured or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "mstsc.exe")
        return executable, args + extra, cwd
    if kind == "vnc":
        if not configured:
            raise ValueError("Choose the VNC viewer executable first")
        return configured, extra + [host + (f"::{options['port']}" if options.get("port") else "")], cwd
    raise ValueError(f"unsupported connection type: {kind}")


def open_desktop(profile: Any) -> dict:
    if profile.terminal_type not in DESKTOP_TYPES:
        raise ValueError("This connection opens in a terminal")
    executable, args, cwd = resolve(profile, None)
    resolved = shutil.which(executable)
    if not resolved:
        raise ValueError(f"Client not found: {executable}")
    process = subprocess.Popen([resolved, *args], cwd=cwd, env={**os.environ, **profile.env})
    return {"pid": process.pid, "profile": profile.name, "type": profile.terminal_type, "external": True}
