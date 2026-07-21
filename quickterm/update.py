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
import os
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from quickterm import __version__

REPO = "devincii-io/quickterm"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
_SUMS_NAME = "SHA256SUMS.txt"
_CACHE_TTL_S = 6 * 3600
_MAX_SETUP_BYTES = 200 * 1024 * 1024
_MAX_METADATA_BYTES = 2 * 1024 * 1024
_ALLOWED_DOWNLOAD_HOSTS = {
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}

_cache: dict | None = None
_cache_at = 0.0


def _validate_download_url(url: str) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_DOWNLOAD_HOSTS:
        raise ValueError(f"refusing non-GitHub https url: {url}")


def _get(url: str, timeout: int = 15, max_bytes: int = _MAX_METADATA_BYTES) -> bytes:
    _validate_download_url(url)
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"quickterm/{__version__}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        # urllib follows redirects. Re-check the final location so a poisoned
        # redirect cannot move downloads outside GitHub's asset infrastructure.
        _validate_download_url(resp.geturl())
        data = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError(f"download exceeds {max_bytes} bytes")
        return data


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
    expected_setup = f"QuickTerm-v{latest}-Setup.exe" if latest else ""
    setup = next(
        (a for a in assets if str(a.get("name", "")) == expected_setup), None
    )
    sums = next((a for a in assets if str(a.get("name", "")) == _SUMS_NAME), None)
    result = {
        "current": __version__,
        "latest": latest,
        "update_available": bool(latest) and is_newer(latest, __version__),
        "url": data.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "notes": (data.get("body") or "")[:2000],
        "installable": os.name == "nt" and setup is not None and sums is not None,
    }
    _cache, _cache_at = result, time.monotonic()
    return result


def download_and_run() -> dict:
    """Download the latest Setup, verify its SHA-256, start it. Windows only."""
    if os.name != "nt":
        raise ValueError("in-app update is only available on Windows")
    data = json.loads(_get(API_LATEST))
    latest = str(data.get("tag_name") or "").lstrip("v")
    if not latest or not is_newer(latest, __version__):
        raise ValueError("latest release is not newer than this installation")
    assets = data.get("assets") or []

    def _asset(pred) -> dict | None:
        return next((a for a in assets if pred(str(a.get("name", "")))), None)

    expected_setup = f"QuickTerm-v{latest}-Setup.exe"
    setup = _asset(lambda n: n == expected_setup)
    if setup is None:
        raise ValueError(f"latest release has no matching {expected_setup} asset")
    sums = _asset(lambda n: n == _SUMS_NAME)
    try:
        declared_size = int(setup.get("size", 0))
    except (TypeError, ValueError):
        raise ValueError("installer asset has an invalid size") from None
    if declared_size < 1 or declared_size > _MAX_SETUP_BYTES:
        raise ValueError("installer asset is implausibly large")

    blob = _get(
        str(setup["browser_download_url"]),
        timeout=120,
        max_bytes=_MAX_SETUP_BYTES,
    )
    digest = hashlib.sha256(blob).hexdigest()
    if sums is None:
        raise ValueError(f"latest release has no {_SUMS_NAME}; refusing unverified install")
    sums_text = _get(str(sums["browser_download_url"])).decode("utf-8", "replace")
    wanted = _expected_hash(sums_text, str(setup["name"]))
    if wanted is None or not re.fullmatch(r"[0-9a-fA-F]{64}", wanted) or wanted.lower() != digest:
        raise ValueError("installer failed checksum verification")

    update_dir = Path(tempfile.mkdtemp(prefix="quickterm-update-"))
    path = update_dir / str(setup["name"])
    path.write_bytes(blob)
    # Detached: the installer outlives us — it closes QuickTerm and upgrades.
    subprocess.Popen([str(path)], close_fds=True)
    return {"launched": True, "version": latest}


def _expected_hash(sums_text: str, filename: str) -> str | None:
    for line in sums_text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].strip("*") == filename:
            return parts[0]
    return None
