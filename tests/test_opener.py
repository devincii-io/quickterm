"""opener.open_target: scheme filtering, existence checks, executable reveal."""

import os
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


def test_http_url_scheme_is_case_insensitive(monkeypatch):
    calls = []
    monkeypatch.setattr(opener.webbrowser, "open", lambda url: calls.append(url))

    assert opener.open_target("HTTPS://example.com/Release") == {"action": "url"}
    assert calls == ["HTTPS://example.com/Release"]


def test_existing_dir_opens(monkeypatch, tmp_path):
    opened = []
    if sys.platform == "win32":
        monkeypatch.setattr(opener.os, "startfile", lambda p: opened.append(p), raising=False)
    else:
        monkeypatch.setattr(opener.subprocess, "Popen", lambda argv, **kw: opened.append(argv[-1]))
    assert opener.open_target(str(tmp_path)) == {"action": "opened"}
    assert opened == [str(tmp_path)]


def test_executable_is_revealed_not_run(monkeypatch, tmp_path):
    exe = tmp_path / "installer.exe"
    exe.write_bytes(b"MZ")
    popen_calls = []
    monkeypatch.setattr(opener.subprocess, "Popen", lambda argv, **kw: popen_calls.append(argv))
    if sys.platform == "win32":
        monkeypatch.setattr(
            opener.os, "startfile",
            lambda p: (_ for _ in ()).throw(AssertionError("must not launch executables")),
            raising=False,
        )
    assert opener.open_target(str(exe)) == {"action": "revealed"}
    assert len(popen_calls) == 1  # explorer /select or xdg-open of the parent
    if sys.platform == "win32":
        # Absolute image path: a bare "explorer" resolves through the current
        # directory before System32, which an elevated instance inherits from
        # the Explorer "Open QuickTerm here" verb.
        image = popen_calls[0][0]
        assert image.lower().endswith("\\explorer.exe")
        assert os.path.isabs(image)


@pytest.mark.parametrize("suffix", [".cpl", ".msc", ".chm", ".url", ".application"])
def test_other_executable_capable_files_are_revealed(monkeypatch, tmp_path, suffix):
    target = tmp_path / f"printed-by-terminal{suffix}"
    target.write_text("payload", encoding="utf-8")
    popen_calls = []
    monkeypatch.setattr(opener.subprocess, "Popen", lambda argv, **kw: popen_calls.append(argv))
    if sys.platform == "win32":
        monkeypatch.setattr(
            opener.os,
            "startfile",
            lambda p: (_ for _ in ()).throw(AssertionError("must reveal unknown file types")),
            raising=False,
        )
    assert opener.open_target(str(target)) == {"action": "revealed"}
    assert len(popen_calls) == 1


# --- folders (sidebar buttons, Alt+Shift+E / Alt+Shift+C) ---------------------


def test_open_folder_refuses_bad_input(tmp_path):
    with pytest.raises(ValueError):
        opener.open_folder(str(tmp_path), "notepad")
    with pytest.raises(ValueError):
        opener.open_folder("   ", "explorer")
    with pytest.raises(FileNotFoundError):
        opener.open_folder(str(tmp_path / "gone"), "explorer")
    a_file = tmp_path / "notes.txt"
    a_file.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError):
        opener.open_folder(str(a_file), "explorer")


def test_open_folder_in_explorer(monkeypatch, tmp_path):
    shown = []
    if sys.platform == "win32":
        monkeypatch.setattr(opener.os, "startfile", lambda p: shown.append(p), raising=False)
    else:
        monkeypatch.setattr(opener.subprocess, "Popen", lambda argv, **kw: shown.append(argv[-1]))
    # Quotes around a pasted path are stripped like open_target does.
    assert opener.open_folder(f'"{tmp_path}"', "explorer") == {"action": "explorer"}
    assert shown == [str(tmp_path)]


def test_open_folder_in_vscode_runs_the_editor_with_the_folder(monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(opener, "find_vscode", lambda: "/apps/code")
    monkeypatch.setattr(
        opener.subprocess, "Popen", lambda argv, **kw: calls.append((argv, kw.get("cwd")))
    )
    assert opener.open_folder(str(tmp_path), "vscode") == {"action": "vscode"}
    assert calls == [(["/apps/code", str(tmp_path)], str(tmp_path))]


def test_open_folder_without_vscode_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(opener, "find_vscode", lambda: None)
    monkeypatch.setattr(
        opener.subprocess, "Popen",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("nothing may run")),
    )
    with pytest.raises(LookupError):
        opener.open_folder(str(tmp_path), "vscode")


@pytest.mark.skipif(sys.platform != "win32", reason="code.cmd is the Windows install layout")
def test_find_vscode_runs_code_exe_never_the_batch_shim(monkeypatch, tmp_path):
    # cmd.exe re-parses a batch file's arguments, and the folder comes from an
    # OSC 7 report any program in the terminal can forge.
    install = tmp_path / "Microsoft VS Code"
    (install / "bin").mkdir(parents=True)
    shim = install / "bin" / "code.cmd"
    shim.write_text("@echo off", encoding="utf-8")
    exe = install / "Code.exe"
    exe.write_bytes(b"MZ")
    monkeypatch.setattr(opener.shutil, "which", lambda name: str(shim) if name == "code" else None)
    assert opener.find_vscode() == str(exe)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows install locations")
def test_find_vscode_falls_back_to_the_per_user_install(monkeypatch, tmp_path):
    monkeypatch.setattr(opener.shutil, "which", lambda name: None)
    monkeypatch.setenv("LocalAppData", str(tmp_path))
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "pf"))
    assert opener.find_vscode() is None
    exe = tmp_path / "Programs" / "Microsoft VS Code" / "Code.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    assert opener.find_vscode() == str(exe)
