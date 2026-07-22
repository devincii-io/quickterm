"""Download the pinned PuTTY console tools into vendor/putty/.

Build/dev-time only — QuickTerm never downloads these at runtime. The version
and per-file SHA-256 hashes are pinned here; bumping PuTTY means updating this
manifest from https://the.earth.li/~sgtatham/putty/<version>/sha256sums (the
plain `w64/<name>` lines, not the "installer version" ones) and re-running the
script. quickterm.spec re-verifies the same hashes at build time.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

PUTTY_VERSION = "0.84"
# Official standalone w64 builds, published beside the binaries by the PuTTY
# project (https://www.chiark.greenend.org.uk/~sgtatham/putty/).
PUTTY_SHA256 = {
    "plink.exe": "e5621ffe4879f0ec39ed40f688db9399c2d43054d41ef14472fa335c4693b915",
    "pscp.exe": "fb2d69f840026a562629d757095c968b5748daaf1d08fad14414a8ef79de319e",
    "psftp.exe": "7b04cb14d2b5461598fe1fbd057a72092075b550a668492d031d13379f173031",
}
_BASE_URL = f"https://the.earth.li/~sgtatham/putty/{PUTTY_VERSION}/w64"
_MAX_BYTES = 16 * 1024 * 1024

VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "putty"


def verify_sha256(blob: bytes, expected: str) -> bool:
    return hashlib.sha256(blob).hexdigest() == expected.lower()


def _download(name: str) -> bytes:
    url = f"{_BASE_URL}/{name}"
    if not url.startswith("https://the.earth.li/"):
        raise ValueError(f"refusing non-pinned download URL: {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        blob = resp.read(_MAX_BYTES + 1)
    if len(blob) > _MAX_BYTES:
        raise ValueError(f"{name}: download exceeded {_MAX_BYTES} bytes")
    return blob


def main() -> int:
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    for name, expected in PUTTY_SHA256.items():
        target = VENDOR_DIR / name
        if target.is_file() and verify_sha256(target.read_bytes(), expected):
            print(f"{name}: already present and verified")
            continue
        print(f"{name}: downloading PuTTY {PUTTY_VERSION} ...")
        blob = _download(name)
        if not verify_sha256(blob, expected):
            target.unlink(missing_ok=True)
            print(f"{name}: SHA-256 mismatch — refusing to keep the file", file=sys.stderr)
            return 1
        target.write_bytes(blob)
        print(f"{name}: verified and written to {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
