"""Update check against GitHub releases + one-click installer hand-off.

check() asks the pinned repo's latest-release endpoint whether a newer version
exists (cached; at most one network call per _CACHE_TTL_S unless forced).
download_and_run() fetches the Windows Setup asset from that release, verifies
it against the release's SHA256SUMS.txt, and launches it — the Inno Setup
installer closes the running app and upgrades in place.

Trust model: only https URLs from the pinned REPO's release payload are ever
fetched, and the installer must hash-match the checksums file published by the
same release. Stdlib urllib only; calls run in a worker thread (server.py).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from quickterm import __version__

log = logging.getLogger(__name__)

REPO = "devincii-io/quickterm"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
_SETUP_RE = re.compile(r"^QuickTerm-v[\d.]+-Setup\.exe$")
_SUMS_NAME = "SHA256SUMS.txt"
_CACHE_TTL_S = 6 * 3600
_MAX_SETUP_BYTES = 200 * 1024 * 1024

_cache: dict | None = None
_cache_at = 0.0


def _get(url: str, timeout: int = 15) -> bytes:
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-https url: {url}")
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"quickterm/{__version__}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _version_tuple(v: str) -> tuple[int, ...]:
    parts = []
    for piece in v.strip().lstrip("v").split("."):
        m = re.match(r"\d+", piece)
        parts.append(int(m.group()) if m else 0)
    return tuple(parts) or (0,)


def is_newer(latest: str, current: str) -> bool:
    a, b = _version_tuple(latest), _version_tuple(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def check(force: bool = False) -> dict:
    """Latest-release probe. Raises on network failure (caller maps to 502)."""
    global _cache, _cache_at
    if not force and _cache is not None and time.monotonic() - _cache_at < _CACHE_TTL_S:
        return _cache
    data = json.loads(_get(API_LATEST))
    latest = str(data.get("tag_name") or "").lstrip("v")
    assets = data.get("assets") or []
    setup = next(
        (a for a in assets if _SETUP_RE.match(str(a.get("name", "")))), None
    )
    result = {
        "current": __version__,
        "latest": latest,
        "update_available": bool(latest) and is_newer(latest, __version__),
        "url": data.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "notes": (data.get("body") or "")[:2000],
        "installable": os.name == "nt" and setup is not None,
    }
    _cache, _cache_at = result, time.monotonic()
    return result


def download_and_run() -> dict:
    """Download the latest Setup, verify its SHA-256, start it. Windows only."""
    if os.name != "nt":
        raise ValueError("in-app update is only available on Windows")
    data = json.loads(_get(API_LATEST))
    assets = data.get("assets") or []

    def _asset(pred) -> dict | None:
        return next((a for a in assets if pred(str(a.get("name", "")))), None)

    setup = _asset(lambda n: bool(_SETUP_RE.match(n)))
    if setup is None:
        raise ValueError("latest release has no Windows installer asset")
    sums = _asset(lambda n: n == _SUMS_NAME)
    if setup.get("size", 0) > _MAX_SETUP_BYTES:
        raise ValueError("installer asset is implausibly large")

    blob = _get(str(setup["browser_download_url"]), timeout=120)
    digest = hashlib.sha256(blob).hexdigest()
    if sums is not None:  # released via our pipeline: hash must match
        sums_text = _get(str(sums["browser_download_url"])).decode("utf-8", "replace")
        wanted = _expected_hash(sums_text, str(setup["name"]))
        if wanted is None or wanted.lower() != digest:
            raise ValueError("installer failed checksum verification")
    else:
        log.warning("release has no %s; installing unverified", _SUMS_NAME)

    path = Path(tempfile.gettempdir()) / str(setup["name"])
    path.write_bytes(blob)
    # Detached: the installer outlives us — it closes QuickTerm and upgrades.
    subprocess.Popen([str(path)], close_fds=True)
    return {"launched": True, "version": str(data.get("tag_name") or "").lstrip("v")}


def _expected_hash(sums_text: str, filename: str) -> str | None:
    for line in sums_text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].strip("*") == filename:
            return parts[0]
    return None
