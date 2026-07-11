import os
import types

import pytest

import quickterm.elevation as elevation
from quickterm.elevation import decode_spec, encode_spec


def test_elevated_spec_roundtrip_marks_terminal_name_once():
    token = encode_spec(
        {
            "cmd": r"C:\Windows\System32\cmd.exe",
            "args": ["/K", "echo ready"],
            "cwd": r"C:\work",
            "env": {"QUICKTERM_TEST": "1"},
            "name": "Command Prompt",
        }
    )
    decoded = decode_spec(token)
    assert decoded == {
        "cmd": r"C:\Windows\System32\cmd.exe",
        "args": ["/K", "echo ready"],
        "cwd": r"C:\work",
        "env": {"QUICKTERM_TEST": "1"},
        "name": "Administrator - Command Prompt",
    }


@pytest.mark.parametrize(
    "spec",
    [
        {},
        {"cmd": "cmd.exe", "args": "not-a-list"},
        {"cmd": "cmd.exe", "env": {"NUMBER": 1}},
    ],
)
def test_elevated_spec_rejects_invalid_commands(spec):
    with pytest.raises(ValueError):
        encode_spec(spec)


def test_launch_uses_windows_runas_and_reenters_quickterm(monkeypatch):
    calls = []

    class Shell32:
        def ShellExecuteW(self, *args):
            calls.append(args)
            return 42

    monkeypatch.setattr(
        elevation,
        "os",
        types.SimpleNamespace(name="nt", getcwd=lambda: r"C:\work", path=os.path),
    )
    monkeypatch.setattr(
        elevation.ctypes,
        "windll",
        types.SimpleNamespace(shell32=Shell32()),
        raising=False,
    )
    elevation.launch({"cmd": "cmd.exe", "name": "Command Prompt"})
    assert len(calls) == 1
    _parent, verb, executable, params, cwd, show = calls[0]
    assert verb == "runas"
    assert executable == elevation.sys.executable
    assert "-m quickterm.app --elevated-spec" in params
    assert cwd == r"C:\work"
    assert show == 1
