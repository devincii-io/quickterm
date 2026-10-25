import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
import tomllib

import pytest

from quickterm import agent_hooks, shells
from quickterm.agent_hooks import AgentState
from quickterm.session_manager import Session, SessionInfo, SessionManager

# conpty loads kernel32 at import, so on POSIX the module cannot load and
# the tests of its command line skip instead of stopping collection.
if os.name == "nt":
    from quickterm import conpty
WINDOWS_ONLY = pytest.mark.skipif(os.name != "nt", reason="ConPTY is Windows only")

EXE = r"C:\Users\me\AppData\Roaming\npm\claude.exe"
CWD = r"C:\work\proj"


def wrap(value, program="prog", cli="claude"):
    return shells.Wrap(value, program, cli)


def test_powershell_runs_the_agent_once_and_stays():
    cmd, args, cwd = shells.wrap(wrap("powershell", "pwsh.exe"), EXE, ["--model=haiku"], CWD)
    assert cmd == "pwsh.exe" and cwd == CWD
    assert args == [
        "-NoLogo", "-NoExit", "-Command",
        "& 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe' '--model=haiku'",
    ]


def test_powershell_doubles_every_kind_of_single_quote():
    _, args, _ = shells.wrap(wrap("powershell"), "claude", ["it's", "\u2019x\u2018"], CWD)
    assert args[-1] == "& 'claude' 'it''s' '\u2019\u2019x\u2018\u2018'"


def test_cmd_quotes_the_whole_line_after_k():
    cmd, args, cwd = shells.wrap(
        wrap("cmd", "cmd.exe"), r"C:\Program Files\claude.exe", ["--model=haiku"], CWD
    )
    assert (cmd, cwd) == ("cmd.exe", CWD)
    assert args == ["/k", '""C:\\Program Files\\claude.exe" --model=haiku"']
    if os.name != "nt":
        return
    # conpty passes the text after /k verbatim; cmd strips the outer pair.
    assert conpty.command_line("C:\\Windows\\System32\\cmd.exe", args) == (
        'C:\\Windows\\System32\\cmd.exe /k ""C:\\Program Files\\claude.exe" --model=haiku"'
    )


@pytest.mark.parametrize("arg", ["a&b", "50%", 'say "hi"', "a|b", "x^y", "wow!"])
def test_cmd_refuses_what_it_would_reinterpret(arg):
    with pytest.raises(ValueError, match="cmd.exe would reinterpret"):
        shells.wrap(wrap("cmd"), "claude.exe", [arg], CWD)


def test_git_bash_execs_a_login_shell_after_the_agent():
    cmd, args, cwd = shells.wrap(
        wrap("git-bash", r"C:\Program Files\Git\bin\bash.exe"), EXE, ["--settings=C:/h/s.json", "it's"],
        CWD,
    )
    assert cmd.endswith("bash.exe") and cwd == CWD
    assert args[0] == "-lc"
    assert args[1] == (
        "C:/Users/me/AppData/Roaming/npm/claude.exe --settings=C:/h/s.json 'it'\"'\"'s'; exec bash -l"
    )


def test_wsl_runs_the_linux_cli_in_the_folder_and_maps_the_folder_arguments():
    cmd, args, cwd = shells.wrap(
        wrap("wsl:Ubuntu", "wsl.exe", "codex"), r"C:\npm\codex.exe", ["--cd", CWD, "--model", "o3"], CWD
    )
    assert (cmd, cwd) == ("wsl.exe", None)
    assert args == [
        "-d", "Ubuntu", "--cd", CWD, "--exec", "bash", "-lc",
        "codex --cd . --model o3; printf '\\033]7770;quickterm-agent-exit\\007'; exec bash -l",
    ]
    _, args, _ = shells.wrap(wrap("wsl", "wsl.exe"), EXE, [], CWD)
    assert args[:2] == ["--cd", CWD]


def test_wsl_hands_bash_the_words_without_another_shell_reading_them():
    hostile = ["$(id)", "`id`", "$HOME", "a'b", "x; id"]
    _, args, _ = shells.wrap(wrap("wsl:Ubuntu", "wsl.exe", "printf"), "printf.exe", ["%s|", *hostile], CWD)
    assert args[4:7] == ["--exec", "bash", "-lc"], "no default shell between wsl.exe and bash"
    assert "--" not in args
    script = args[7].removesuffix("; exec bash -l")
    marker = "\x1b]7770;quickterm-agent-exit\x07"
    bash = shells.git_bash_program() if os.name == "nt" else shutil.which("bash")
    if bash is None:
        pytest.skip("no bash to run the line with")
    done = subprocess.run([bash, "-c", script], capture_output=True, text=True, timeout=30)
    assert done.stdout == "".join(f"{word}|" for word in hostile) + marker, done.stderr


def test_the_pane_knows_the_wsl_exit_marker():
    from pathlib import Path

    js = Path(__file__).parents[1] / "quickterm" / "frontend" / "js"
    profile = (js / "agent_profile.js").read_text(encoding="utf-8")
    pane = (js / "pane.js").read_text(encoding="utf-8")
    assert f"AGENT_EXIT_OSC = {shells.AGENT_EXIT_OSC};" in profile
    assert 'AGENT_EXIT_MARK = "quickterm-agent-exit";' in profile
    assert "registerOscHandler(AGENT_EXIT_OSC" in pane


def test_posix_execs_the_same_login_shell():
    cmd, args, cwd = shells.wrap(wrap("", "/bin/zsh"), "/usr/bin/claude", ["--continue"], "/p")
    assert (cmd, cwd) == ("/bin/zsh", "/p")
    assert args == ["-lc", "/usr/bin/claude --continue; exec /bin/zsh -l"]
    assert shlex.split(args[1].split(";")[0]) == ["/usr/bin/claude", "--continue"]


@pytest.mark.parametrize(("value", "expected"), [
    ("powershell", ["-NoLogo"]),
    ("cmd", []),
    ("git-bash", ["-l"]),
    ("", ["-l"]),
])
def test_the_plain_shell(value, expected):
    assert shells.interactive(value, "prog", CWD) == ("prog", expected, CWD)


def test_the_plain_wsl_shell_opens_in_the_folder_through_cd():
    assert shells.interactive("wsl:Debian", "wsl.exe", CWD) == (
        "wsl.exe", ["-d", "Debian", "--cd", CWD], None
    )
    assert shells.interactive("wsl", "wsl.exe", None) == ("wsl.exe", ["--cd", "~"], None)


def test_values_and_their_meaning():
    for value in ("powershell", "cmd", "git-bash", "wsl", "wsl:Ubuntu", ""):
        shells.validate(value)
    for value in ("bash", "wsl:", "wsl:-x", None):
        with pytest.raises(ValueError, match="shell must be one of"):
            shells.validate(value)
    assert shells.effective("cmd", windows=False) == ""
    assert shells.effective("", windows=True) == "powershell"
    assert shells.effective("wsl:Ubuntu", windows=True) == "wsl:Ubuntu"
    assert shells.terminal_type("wsl:Ubuntu") == "wsl"
    assert shells.label("wsl:Ubuntu") == "WSL: Ubuntu"


def test_inventory_lists_git_bash_and_wsl_only_when_installed():
    assert [e["value"] for e in shells.entries(windows=True)] == ["powershell", "cmd"]
    listed = shells.entries(windows=True, git_bash=True, distributions=["Ubuntu", "-bad"])
    assert [(e["value"], e["label"]) for e in listed] == [
        ("powershell", "PowerShell"), ("cmd", "Command Prompt"), ("git-bash", "Git Bash"),
        ("wsl:Ubuntu", "WSL: Ubuntu"),
    ]
    assert all(e["available"] for e in listed)
    assert [e["value"] for e in shells.entries(windows=False)] == [""]


def test_a_missing_git_bash_is_a_clear_error(monkeypatch):
    monkeypatch.setattr(shells, "git_bash_program", lambda: None)
    with pytest.raises(ValueError, match="Git Bash is not installed"):
        shells.program("git-bash")


def test_powershell_falls_back_to_windows_powershell(monkeypatch):
    monkeypatch.setattr(shells, "pwsh_program", lambda: None)
    monkeypatch.setattr(shells, "_first", lambda command, *c: f"found:{command}")
    assert shells.program("powershell") == "found:powershell.exe"


@WINDOWS_ONLY
def test_conpty_quotes_ordinary_arguments_as_before():
    assert conpty.command_line("pwsh.exe", ["-Command", "a b"]) == 'pwsh.exe -Command "a b"'
    assert conpty.command_line("cmd.exe", ["/c", "echo", "hi"]) == "cmd.exe /c echo hi"
    # A custom cmd profile keeps list2cmdline: a path with a space stays one word.
    assert conpty.command_line("cmd.exe", ["/c", r"C:\x y\a.bat"]) == r'cmd.exe /c "C:\x y\a.bat"'
    assert conpty.command_line("cmd.exe", ["/K", "echo a b"]) == 'cmd.exe /K "echo a b"'
    # Only the agent wrap's one pre-quoted text goes in verbatim.
    assert conpty.command_line("cmd.exe", ["/k", '""C:\\a b\\c.exe" -x"']) == 'cmd.exe /k ""C:\\a b\\c.exe" -x"'


@pytest.mark.skipif(os.name != "nt", reason="cmd.exe")
def test_a_custom_cmd_profile_with_a_spaced_batch_path_still_runs(tmp_path):
    folder = tmp_path / "x y"
    folder.mkdir()
    script = folder / "a.bat"
    script.write_text("@echo ran %~nx0\r\n", encoding="utf-8")
    cmd = shutil.which("cmd.exe")
    if cmd is None:
        pytest.skip("cmd.exe is not installed")
    done = subprocess.run(conpty.command_line(cmd, ["/c", str(script)]), capture_output=True, text=True, timeout=30)
    assert "ran a.bat" in done.stdout


_PRINTER = "import json, sys\nprint('ARGV=' + json.dumps(sys.argv[1:]))\n"
_NOTIFY = "notify=" + agent_hooks.toml_strings(
    ["C:/Windows/System32/curl.exe", "-K", "C:/Users/a b/AppData/hooks/codex-notify.curl", "--data-binary"]
)


def _run_wrapped(value, prog, words, tmp_path):
    printer = tmp_path / "argv printer.py"
    printer.write_text(_PRINTER, encoding="utf-8")
    cmd, args, _ = shells.wrap(shells.Wrap(value, prog, "codex"), sys.executable, [str(printer), *words], None)
    # Run once and exit: the wrap's keep-open flag swapped for its run-once twin.
    args = [{"-NoExit": "-NonInteractive", "/k": "/c"}.get(arg, arg) for arg in args]
    done = subprocess.run(conpty.command_line(cmd, args), capture_output=True, text=True, timeout=60)
    line = next((item for item in done.stdout.splitlines() if item.startswith("ARGV=")), None)
    assert line is not None, done.stdout + done.stderr
    return json.loads(line[5:])


@pytest.mark.skipif(os.name != "nt", reason="Windows shells")
@pytest.mark.parametrize("program", ["powershell.exe", "pwsh.exe"])
def test_the_powershell_wrap_hands_every_word_over_intact(program, tmp_path):
    found = shutil.which(program)
    if found is None:
        pytest.skip(f"{program} is not installed")
    words = [
        _NOTIFY, "--model=haiku", "", 'say "hi"', "it's", "x y\\", "end\\\"", "%PATH%", "$(id)",
        'say "hello world" now', '"The whole sentence is quoted."', "a;b | c & d", "50% off",
        "%QUICKTERM_AGENT_ARGS%",
    ]
    assert _run_wrapped("powershell", found, words, tmp_path) == words
    # The words a launch needs no escaping for keep the contract's plain form.
    plain = shells.ps_command("claude.exe", [_NOTIFY, "--model=haiku"])
    assert plain.startswith("& 'claude.exe' 'notify=[")


@pytest.mark.skipif(os.name != "nt", reason="Windows shells")
def test_the_cmd_wrap_hands_a_hooked_codex_launch_over_intact(tmp_path):
    found = shutil.which("cmd.exe")
    if found is None:
        pytest.skip("cmd.exe is not installed")
    words = [_NOTIFY, "resume", "--last", "--cd", r"C:\work\my proj"]
    assert _run_wrapped("cmd", found, words, tmp_path) == words


def test_notify_is_literal_toml_without_double_quotes():
    items = ["C:/curl.exe", "-K", "C:/a b/x.curl", "--data-binary"]
    text = agent_hooks.toml_strings(items)
    assert '"' not in text
    assert tomllib.loads("v=" + text)["v"] == items
    tricky = ["it's", "sh -c 'exit 0'", "ends'", "a'''b", ""]
    assert tomllib.loads("v=" + agent_hooks.toml_strings(tricky))["v"] == tricky


def test_the_git_bash_launcher_and_msys_stubs_are_looked_through():
    from quickterm.process_usage import shell_at_prompt

    names = {1: "bash.exe", 2: "bash.exe", 3: "bash.exe", 4: "claude.exe", 9: "pwsh.exe", 10: "x.exe"}
    # The launcher, the real bash, the fork that runs the agent, the agent.
    running = [(2, 1), (3, 2), (4, 3)]
    assert shell_at_prompt(running, names, 1) == 3
    # The agent exited and `exec bash -l` left a stub: the prompt is the last bash.
    assert shell_at_prompt([(2, 1), (3, 2)], names, 1) == 3
    # Two children: the work starts there.
    assert shell_at_prompt([(2, 1), (10, 1)], names, 1) == 1
    # Not an MSYS shell: itself.
    assert shell_at_prompt([(10, 9)], names, 9) == 9


async def test_a_git_bash_session_at_its_prompt_is_not_busy(monkeypatch):
    import quickterm.session_manager as sm

    tree = {"links": [(2, 1), (3, 2), (4, 3)]}
    names = {1: "bash.exe", 2: "bash.exe", 3: "bash.exe", 4: "codex.exe"}
    monkeypatch.setattr(sm, "process_names", lambda: names)
    manager = SessionManager(asyncio.get_running_loop())
    session = Session(SessionInfo("gb", "gb", None, True, None, 80, 24), 1024)
    session.pty = _FakePty(1)
    session.msys_root = True
    session.agent_shell = True
    session.agent = AgentState("codex", "done", 0.0)
    manager._sessions["gb"] = session
    assert manager._busy_from(tree["links"]) == {"gb"}, "codex runs under the bash fork"
    assert session.agent is not None
    assert manager._busy_from([(2, 1), (3, 2)]) == set(), "only the launcher and stubs are left"
    await asyncio.sleep(0)
    assert session.agent is None, "Codex's state clears once it has exited"


class _FakePty:
    def __init__(self, pid):
        self.pid = pid


async def test_an_agent_that_left_its_shell_loses_its_state(monkeypatch):
    import quickterm.session_manager as sm

    # Only pid 20 still has a child (its agent).
    monkeypatch.setattr(sm, "pids_with_children", lambda identities: {20})
    manager = SessionManager(asyncio.get_running_loop())
    sessions = {}
    for sid, pid, in_shell in (("gone", 10, True), ("running", 20, True), ("direct", 30, False)):
        session = Session(SessionInfo(sid, sid, None, True, None, 80, 24), 1024)
        session.pty = _FakePty(pid)
        session.agent_shell = in_shell
        session.agent = AgentState("codex", "done", 0.0)
        manager._sessions[sid] = session
        sessions[sid] = session
    busy = manager._busy_from([])
    await asyncio.sleep(0)
    assert busy == {"running"}
    assert sessions["gone"].agent is None
    assert sessions["running"].agent is not None
    # A process-root agent without a shell keeps its hook state.
    assert sessions["direct"].agent is not None
