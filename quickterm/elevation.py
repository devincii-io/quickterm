"""Windows UAC handoff for an administrator QuickTerm window."""

from __future__ import annotations

import base64
import ctypes
import json
import os
import subprocess
import sys
from typing import Any


def _clean_spec(spec: dict[str, Any]) -> dict[str, Any]:
    cmd = spec.get("cmd")
    if not isinstance(cmd, str) or not cmd.strip():
        raise ValueError("an executable is required")
    args = spec.get("args") or []
    env = spec.get("env") or {}
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise ValueError("args must be a list of strings")
    if not isinstance(env, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in env.items()
    ):
        raise ValueError("env must contain string values")
    label = spec.get("name") or spec.get("label") or os.path.basename(cmd)
    if isinstance(label, str) and label.startswith("Administrator - "):
        marked_name = label
    else:
        marked_name = f"Administrator - {label}"
    return {
        "cmd": cmd,
        "args": args,
        "cwd": spec.get("cwd") if isinstance(spec.get("cwd"), str) else None,
        "env": env,
        "name": marked_name,
    }


def encode_spec(spec: dict[str, Any]) -> str:
    raw = json.dumps(_clean_spec(spec), separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_spec(token: str) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        decoded = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit("Invalid elevated terminal request.") from exc
    if not isinstance(decoded, dict):
        raise SystemExit("Invalid elevated terminal request.")
    try:
        return _clean_spec(decoded)
    except ValueError as exc:
        raise SystemExit(f"Invalid elevated terminal request: {exc}") from exc


def launch(spec: dict[str, Any]) -> None:
    """Ask Windows to start a separate elevated QuickTerm desktop window."""
    if os.name != "nt":
        raise OSError("administrator terminals are only available on Windows")
    token = encode_spec(spec)
    if getattr(sys, "frozen", False):
        executable = sys.executable
        argv = ["--elevated-spec", token]
    else:
        executable = sys.executable
        argv = ["-m", "quickterm.app", "--elevated-spec", token]
    params = subprocess.list2cmdline(argv)
    result = ctypes.windll.shell32.ShellExecuteW(
        None, "runas", executable, params, os.getcwd(), 1
    )
    if result <= 32:
        raise OSError(f"Windows elevation failed ({result})")
