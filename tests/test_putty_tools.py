"""Bundled PuTTY tool resolution and the fetch script's hash check."""

import hashlib
import sys
from pathlib import Path

from quickterm import putty_tools

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from fetch_putty import PUTTY_SHA256, verify_sha256  # noqa: E402


def _fake_frozen(monkeypatch, base):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(base), raising=False)


def test_tools_dir_frozen_with_all_exes(monkeypatch, tmp_path):
    putty = tmp_path / "putty"
    putty.mkdir()
    for name in ("plink.exe", "pscp.exe", "psftp.exe"):
        (putty / name).write_bytes(b"")
    _fake_frozen(monkeypatch, tmp_path)
    assert putty_tools.tools_dir() == putty
    assert putty_tools.plink_path() == putty / "plink.exe"
    assert putty_tools.pscp_path() == putty / "pscp.exe"
    assert putty_tools.psftp_path() == putty / "psftp.exe"


def test_tools_dir_none_when_an_exe_is_missing(monkeypatch, tmp_path):
    putty = tmp_path / "putty"
    putty.mkdir()
    (putty / "plink.exe").write_bytes(b"")
    _fake_frozen(monkeypatch, tmp_path)
    assert putty_tools.tools_dir() is None
    assert putty_tools.plink_path() is None


def test_fetch_manifest_shape():
    assert set(PUTTY_SHA256) == {"plink.exe", "pscp.exe", "psftp.exe"}
    assert all(len(digest) == 64 for digest in PUTTY_SHA256.values())


def test_verify_sha256():
    blob = b"quickterm"
    assert verify_sha256(blob, hashlib.sha256(blob).hexdigest())
    assert verify_sha256(blob, hashlib.sha256(blob).hexdigest().upper())
    assert not verify_sha256(blob, "0" * 64)
