"""Update module: version comparison, checksum parsing, release-probe parsing."""

import json

import pytest

import quickterm.update as update
from quickterm import __version__
from quickterm.update import _expected_hash, is_newer


def test_is_newer_basic():
    assert is_newer("0.2.1", "0.2.0")
    assert is_newer("0.10.0", "0.9.9")
    assert is_newer("1.0.0", "0.99.99")
    assert not is_newer("0.2.0", "0.2.0")
    assert not is_newer("0.1.9", "0.2.0")


def test_is_newer_handles_v_prefix_and_ragged_lengths():
    assert is_newer("v0.3", "0.2.5")
    assert not is_newer("0.2", "0.2.0")
    assert is_newer("0.2.0.1", "0.2.0")


def test_expected_hash_parses_sha256sums():
    sums = "abc123  QuickTerm-v0.2.0-Setup.exe\ndef456  QuickTerm-v0.2.0-windows-x64.zip\n"
    assert _expected_hash(sums, "QuickTerm-v0.2.0-Setup.exe") == "abc123"
    assert _expected_hash(sums, "QuickTerm-v0.2.0-windows-x64.zip") == "def456"
    assert _expected_hash(sums, "missing.exe") is None
    # binary-mode marker ("*name") also matches
    assert _expected_hash("fff *QuickTerm-v9-Setup.exe", "QuickTerm-v9-Setup.exe") == "fff"


def _release_payload(tag: str, with_setup: bool = True) -> bytes:
    assets = []
    if with_setup:
        assets.append({
            "name": f"QuickTerm-{tag}-Setup.exe",
            "browser_download_url": f"https://example.invalid/{tag}/setup.exe",
            "size": 1000,
        })
    return json.dumps({
        "tag_name": tag,
        "html_url": f"https://github.com/devincii-io/quickterm/releases/tag/{tag}",
        "body": "notes",
        "assets": assets,
    }).encode()


def test_check_reports_newer_release(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    monkeypatch.setattr(update, "_get", lambda url, timeout=15: _release_payload("v99.0.0"))
    result = update.check(force=True)
    assert result["update_available"] is True
    assert result["latest"] == "99.0.0"
    assert result["current"] == __version__
    assert result["url"].startswith("https://github.com/")


def test_check_current_release_is_not_an_update(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    monkeypatch.setattr(
        update, "_get", lambda url, timeout=15: _release_payload(f"v{__version__}")
    )
    result = update.check(force=True)
    assert result["update_available"] is False


def test_check_caches_probe(monkeypatch):
    monkeypatch.setattr(update, "_cache", None)
    calls = []

    def fake_get(url, timeout=15):
        calls.append(url)
        return _release_payload("v99.0.0")

    monkeypatch.setattr(update, "_get", fake_get)
    update.check(force=True)
    update.check()  # served from cache
    assert len(calls) == 1


def test_get_refuses_plain_http():
    try:
        update._get("http://example.com")
    except ValueError as exc:
        assert "https" in str(exc)
    else:
        raise AssertionError("plain http must be refused")


def test_download_url_is_pinned_to_github_hosts():
    update._validate_download_url("https://github.com/devincii-io/quickterm/releases/download/v2/a.exe")
    update._validate_download_url("https://release-assets.githubusercontent.com/object")
    with pytest.raises(ValueError, match="non-GitHub"):
        update._validate_download_url("https://example.invalid/QuickTerm-Setup.exe")


def test_install_refuses_release_without_checksums(monkeypatch):
    monkeypatch.setattr(update.os, "name", "nt")
    payload = _release_payload("v99.0.0")

    def fake_get(url, timeout=15, max_bytes=update._MAX_METADATA_BYTES):
        if url == update.API_LATEST:
            return payload
        return b"installer"

    monkeypatch.setattr(update, "_get", fake_get)
    with pytest.raises(ValueError, match="refusing unverified install"):
        update.download_and_run()
