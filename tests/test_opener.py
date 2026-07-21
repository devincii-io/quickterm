"""opener.open_target: scheme filtering, existence checks, executable reveal."""

import sys

import pytest

import quickterm.opener as opener


def test_refuses_empty_and_non_http_schemes():
    with pytest.raises(ValueError):
        opener.open_target("")
    with pytest.raises(ValueError):
        opener.open_target("   ")
    for bad in ("ftp://x", "file:///c:/x", "javascript://alert(1)", "ssh://host"):
        with pytest.raises(ValueError):
            opener.open_target(bad)


def test_missing_path_raises():
    with pytest.raises(FileNotFoundError):
        opener.open_target("C:/definitely/not/here.txt" if sys.platform == "win32" else "/definitely/not/here")


def test_http_url_opens_browser(monkeypatch):
    calls = []
    monkeypatch.setattr(opener.webbrowser, "open", lambda url: calls.append(url))
    assert opener.open_target("https://example.com/x") == {"action": "url"}
    assert opener.open_target('  "http://example.com"  ') == {"action": "url"}
    assert calls == ["https://example.com/x", "http://example.com"]


def test_existing_dir_opens(monkeypatch, tmp_path):
    opened = []
    if sys.platform == "win32":
        monkeypatch.setattr(opener.os, "startfile", lambda p: opened.append(p), raising=False)
    else:
        monkeypatch.setattr(opener.subprocess, "Popen", lambda argv: opened.append(argv[-1]))
    assert opener.open_target(str(tmp_path)) == {"action": "opened"}
    assert opened == [str(tmp_path)]


def test_executable_is_revealed_not_run(monkeypatch, tmp_path):
    exe = tmp_path / "installer.exe"
    exe.write_bytes(b"MZ")
    popen_calls = []
    monkeypatch.setattr(opener.subprocess, "Popen", lambda argv: popen_calls.append(argv))
    if sys.platform == "win32":
        monkeypatch.setattr(
            opener.os, "startfile",
            lambda p: (_ for _ in ()).throw(AssertionError("must not launch executables")),
            raising=False,
        )
    assert opener.open_target(str(exe)) == {"action": "revealed"}
    assert len(popen_calls) == 1  # explorer /select or xdg-open of the parent


@pytest.mark.parametrize("suffix", [".cpl", ".msc", ".chm", ".url", ".application"])
def test_other_executable_capable_files_are_revealed(monkeypatch, tmp_path, suffix):
    target = tmp_path / f"printed-by-terminal{suffix}"
    target.write_text("payload", encoding="utf-8")
    popen_calls = []
    monkeypatch.setattr(opener.subprocess, "Popen", lambda argv: popen_calls.append(argv))
    if sys.platform == "win32":
        monkeypatch.setattr(
            opener.os,
            "startfile",
            lambda p: (_ for _ in ()).throw(AssertionError("must reveal unknown file types")),
            raising=False,
        )
    assert opener.open_target(str(target)) == {"action": "revealed"}
    assert len(popen_calls) == 1
