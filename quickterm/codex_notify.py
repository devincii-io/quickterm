"""Codex's notify program when the user already has one: run theirs, then report.

Codex allows one ``notify`` program, and a per-launch ``-c notify=...``
replaces the user's. So a Codex that QuickTerm launches while ``config.toml``
sets ``notify`` gets ``[<this program>, --codex-notify, <their argv>...]``
instead (``agent_hooks.codex_args``), and Codex appends the notification JSON
as the last argument. This runs their program with that JSON exactly as Codex
would have, then posts the JSON to QuickTerm the way the curl config does.

It runs once per finished Codex turn, never per tool call, so starting
QuickTerm's program for it is affordable. Stdlib only, and it never raises:
a notifier that fails must not show up in the user's Codex session.
"""

from __future__ import annotations

import os
import subprocess
import urllib.parse
import urllib.request

FLAG = "--codex-notify"
POST_TIMEOUT_S = 2.0


def _run_user_notify(argv: list[str], payload: str) -> None:
    if not argv:
        return
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        subprocess.Popen(
            [*argv, payload],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
    except (OSError, ValueError):
        pass


def _report(payload: str) -> None:
    sid = os.environ.get("QUICKTERM_SESSION_ID")
    port = os.environ.get("QUICKTERM_PORT")
    token = os.environ.get("QUICKTERM_HOOK_TOKEN")
    if not sid or not port or not port.isdigit() or not token:
        return
    url = (
        f"http://127.0.0.1:{int(port)}/api/sessions/"
        f"{urllib.parse.quote(sid, safe='')}/agent-event?agent=codex"
    )
    request = urllib.request.Request(
        url,
        data=payload.encode("utf-8", "replace"),
        headers={"Content-Type": "application/json", "X-QuickTerm-Hook-Token": token},
        method="POST",
    )
    # No proxy handler: a system proxy would see the hook token, and a
    # corporate one would make a running QuickTerm look absent (as cli.py).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(request, timeout=POST_TIMEOUT_S).close()
    except (OSError, ValueError):
        pass


def run(argv: list[str]) -> int:
    """``argv`` is the user's notify command followed by Codex's JSON."""
    if not argv:
        return 0
    payload = argv[-1]
    _run_user_notify(argv[:-1], payload)
    _report(payload)
    return 0
