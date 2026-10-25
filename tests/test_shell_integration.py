"""Shell integration: folder reports at the prompt, and the user's own agents
with QuickTerm's hooks in PowerShell."""

import asyncio
import os
import shutil
import subprocess
import time
from types import SimpleNamespace

import pytest

from quickterm import agent_hooks, launch, shells
from quickterm.session_manager import SessionManager

CWD = r"C:\work\proj"
CLAUDE = shells.AgentHook(("--settings=C:/q/hooks/claude-settings.json",), True)
CODEX = shells.AgentHook(("-c", "notify=['C:/curl.exe','-K','it''s']"), False)
WINDOWS = pytest.mark.skipif(os.name != "nt", reason="Windows shells")


def _powershell():
    for name in ("pwsh.exe", "powershell.exe"):
        found = shutil.which(name)
        if found:
            return found
    pytest.skip("no PowerShell installed")


# --- argv -----------------------------------------------------------------------


def test_the_plain_powershell_runs_the_integration_and_stays():
    plain = shells.interactive("powershell", "pwsh.exe", CWD)
    assert plain == ("pwsh.exe", ["-NoLogo"], CWD)
    cmd, args, cwd = shells.interactive("powershell", "pwsh.exe", CWD, shells.Integration())
    assert (cmd, cwd) == ("pwsh.exe", CWD)
    # No -NoProfile: the integration wraps the prompt the profile defined.
    assert args == ["-NoLogo", "-NoExit", "-Command", shells.PS_BOOT]
    assert "& ([ScriptBlock]::Create($env:QUICKTERM_PS_INIT))" in shells.PS_BOOT
    assert '"' not in shells.PS_BOOT


def test_the_agent_wrap_runs_the_integration_first():
    spec = shells.Wrap("powershell", "pwsh.exe", "claude")
    _, args, _ = shells.wrap(spec, "C:/claude.exe", ["--continue"], CWD, shells.Integration())
    assert args[:3] == ["-NoLogo", "-NoExit", "-Command"]
    assert args[3] == shells.PS_BOOT + "\n& 'C:/claude.exe' '--continue'"
    assert shells.wrap(spec, "C:/claude.exe", ["--continue"], CWD)[1][3] == "& 'C:/claude.exe' '--continue'"


def test_cmd_and_git_bash_keep_their_argv():
    integration = shells.Integration()
    assert shells.interactive("cmd", "cmd.exe", CWD, integration) == ("cmd.exe", [], CWD)
    assert shells.interactive("git-bash", "bash.exe", CWD, integration) == ("bash.exe", ["-l"], CWD)
    spec = shells.Wrap("cmd", "cmd.exe", "claude")
    assert shells.wrap(spec, "claude.exe", ["-c"], CWD, integration) == shells.wrap(spec, "claude.exe", ["-c"], CWD)


# --- the script -------------------------------------------------------------------


def test_the_script_wraps_the_prompt_without_running_a_program():
    script = shells.ps_integration(shells.Integration())
    assert script.startswith("Remove-Item -LiteralPath Env:QUICKTERM_PS_INIT")
    assert "function global:prompt" in script
    # The original prompt runs before anything else in the wrapper.
    body = script.split("function global:prompt {\n", 1)[1]
    assert body.startswith("  $out = & $global:__QuickTermPrompt\n")
    assert "[Console]::Write([string][char]27 + ']9;9;' + $loc.ProviderPath + [char]27 + '\\')" in body
    assert "`e" not in script, "Windows PowerShell 5.1 has no `e"
    assert "function global:claude" not in script and "function global:codex" not in script


def test_the_agent_functions_carry_the_hook_arguments():
    script = shells.ps_integration(shells.Integration(claude=CLAUDE, codex=CODEX))
    claude = script.split("function global:claude {", 1)[1].split("\n}\n", 1)[0]
    codex = script.split("function global:codex {", 1)[1].split("\n}\n", 1)[0]
    assert "$h = @('--settings=C:/q/hooks/claude-settings.json')" in claude
    assert "$a + $h" in claude and "'--settings='" in claude
    assert "'setup-token'" in claude and "'agents'" in claude
    assert ".cmd" not in claude, "a safe settings path may go to claude.cmd"
    assert "$h = @('-c','notify=[''C:/curl.exe'',''-K'',''it''''s'']')" in codex
    assert "$h + $a" in codex and "'app-server'" in codex
    assert "@('.cmd','.bat')" in codex
    assert "--settings" not in codex


# --- cmd and Git Bash ---------------------------------------------------------------


def test_cmd_prompt_reports_the_folder_before_the_users_prompt():
    assert shells.cmd_prompt(None) == "$E]9;9;$P$E\\$P$G"
    assert shells.cmd_prompt("$T $P$G") == "$E]9;9;$P$E\\$T $P$G"
    assert shells.cmd_prompt(shells.cmd_prompt("$N$G")) == "$E]9;9;$P$E\\$N$G"


def test_cmd_prompt_replaces_the_launch_spelling_and_reads_quickterms(monkeypatch):
    monkeypatch.setenv("PROMPT", "[$P]")
    env = shells.integration_env("cmd", shells.Integration(), {"X": "1"})
    assert env == {"X": "1", "PROMPT": "$E]9;9;$P$E\\[$P]"}
    env = shells.integration_env("cmd", shells.Integration(), {"Prompt": "$G"})
    assert env == {"PROMPT": "$E]9;9;$P$E\\$G"}


def test_git_bash_prompt_command_follows_the_users_own(monkeypatch):
    monkeypatch.delenv("PROMPT_COMMAND", raising=False)
    env = shells.integration_env("git-bash", shells.Integration(), {})
    assert env == {"PROMPT_COMMAND": shells.GIT_BASH_PROMPT_COMMAND}
    assert shells.bash_prompt_command("history -a;") == f"history -a; {shells.GIT_BASH_PROMPT_COMMAND}"
    twice = shells.bash_prompt_command(shells.bash_prompt_command("x"))
    assert twice.count(shells.GIT_BASH_PROMPT_COMMAND) == 1


def test_powershell_gets_the_script_and_other_shells_nothing():
    integration = shells.Integration(claude=CLAUDE)
    env = shells.integration_env("powershell", integration, {"A": "b"})
    assert env == {"A": "b", "QUICKTERM_PS_INIT": shells.ps_integration(integration)}
    for value in ("wsl", "wsl:Ubuntu", ""):
        assert shells.integration_env(value, integration, {"A": "b"}) == {"A": "b"}
    assert shells.integration_env("cmd", None, {"A": "b"}) == {"A": "b"}


@WINDOWS
def test_git_bash_reports_a_windows_folder(tmp_path):
    bash = shells.git_bash_program()
    if bash is None:
        pytest.skip("Git Bash is not installed")
    folder = tmp_path / "a b"
    folder.mkdir()
    env = dict(os.environ, PROMPT_COMMAND=shells.bash_prompt_command(None))
    code = f'cd {shells.posix_word(str(folder))} && eval "$PROMPT_COMMAND"; cd /usr/bin && eval "$PROMPT_COMMAND"'
    done = subprocess.run([bash, "-c", code], env=env, capture_output=True, timeout=30)
    reports = done.stdout.split(b"\x1b\\")
    assert reports[0] == b"\x1b]9;9;" + str(folder).encode()
    assert reports[1].startswith(b"\x1b]9;9;") and reports[1].endswith(b"\\usr\\bin")


# --- the agent functions in a real PowerShell ---------------------------------------


@WINDOWS
def test_the_users_own_agents_get_the_hooks_unless_they_should_not(tmp_path):
    for name in ("claude", "codex"):
        (tmp_path / f"{name}.cmd").write_text(f"@echo {name.upper()}: %*\r\n", encoding="ascii")
    script = shells.ps_integration(shells.Integration(claude=CLAUDE, codex=CODEX))
    lines = [
        shells.PS_BOOT,
        f"$env:PATH = {shells.ps_quote(str(tmp_path))} + ';' + $env:PATH",
        "claude -p hi",
        "claude mcp list",
        "claude --settings x.json",
        "claude --settings=x.json -p",
        "codex exec hi",
        "Write-Output ('INIT=' + [string]$env:QUICKTERM_PS_INIT)",
        "$env:PATH = $env:SystemRoot + '\\System32'",
        "try { claude go } catch { Write-Output ('ERR=' + $_.FullyQualifiedErrorId) }",
        "Write-Output ('KEPT=' + (Get-Command claude -CommandType Function).Name)",
    ]
    done = subprocess.run(
        [_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "\n".join(lines)],
        env=dict(os.environ, QUICKTERM_PS_INIT=script), capture_output=True, timeout=60,
    )
    out = done.stdout.decode("utf-8", "replace").splitlines()
    assert out == [
        "CLAUDE: -p hi --settings=C:/q/hooks/claude-settings.json",
        "CLAUDE: mcp list",
        "CLAUDE: --settings x.json",
        "CLAUDE: --settings=x.json -p",
        # A .cmd Codex never gets its notify (cmd.exe would re-read the quotes).
        "CODEX: exec hi",
        "INIT=",
        "ERR=CommandNotFoundException",
        "KEPT=claude",
    ], done.stderr.decode("utf-8", "replace")


@WINDOWS
def test_a_profile_function_of_the_same_name_is_left_alone(tmp_path):
    (tmp_path / "claude.cmd").write_text("@echo CLAUDE: %*\r\n", encoding="ascii")
    script = shells.ps_integration(shells.Integration(claude=CLAUDE, codex=CODEX))
    lines = [
        # What a profile might hold: a wrapper for a second account.
        "function global:claude { Write-Output ('MINE: ' + ($args -join ' ')) }",
        shells.PS_BOOT,
        f"$env:PATH = {shells.ps_quote(str(tmp_path))} + ';' + $env:PATH",
        "claude -p hi",
    ]
    done = subprocess.run(
        [_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "\n".join(lines)],
        env=dict(os.environ, QUICKTERM_PS_INIT=script), capture_output=True, timeout=60,
    )
    assert done.stdout.decode("utf-8", "replace").splitlines() == ["MINE: -p hi"], done.stderr


@WINDOWS
def test_constrained_language_skips_the_script_quietly():
    lines = [
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
        shells.PS_BOOT,
        "Write-Output ('INIT=' + [string]$env:QUICKTERM_PS_INIT)",
        "Write-Output ('PROMPT=' + [bool](Get-Command claude -CommandType Function -ErrorAction Ignore))",
    ]
    done = subprocess.run(
        [_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "\n".join(lines)],
        env=dict(os.environ, QUICKTERM_PS_INIT=shells.ps_integration(shells.Integration(claude=CLAUDE))),
        capture_output=True, timeout=60,
    )
    assert done.stdout.decode("utf-8", "replace").splitlines() == ["INIT=", "PROMPT=False"]
    assert not done.stderr.strip(), done.stderr


@WINDOWS
def test_the_prompt_keeps_the_exit_status_and_reports_the_folder(tmp_path):
    lines = [
        shells.PS_BOOT,
        f"Set-Location -LiteralPath {shells.ps_quote(str(tmp_path))}",
        "cmd /c exit 3",
        "$shown = prompt",
        "Write-Output ('|LEC=' + $LASTEXITCODE)",
        "Set-Location Env:",
        "$null = prompt",
        "Write-Output '|END'",
    ]
    done = subprocess.run(
        [_powershell(), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "\n".join(lines)],
        env=dict(os.environ, QUICKTERM_PS_INIT=shells.ps_integration(shells.Integration())),
        capture_output=True, timeout=60,
    )
    text = done.stdout.decode("utf-8", "replace")
    assert text.startswith(f"\x1b]9;9;{tmp_path}\x1b\\|LEC=3"), text + done.stderr.decode("utf-8", "replace")
    # Env: is no folder: nothing is reported there.
    assert text.count("\x1b]9;9;") == 1


# --- the hook arguments -------------------------------------------------------------


def test_shell_hooks_build_both_agents(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    hooks = agent_hooks.shell_hooks(tmp_path / "hooks")
    settings = (tmp_path / "hooks" / "claude-settings.json").as_posix()
    assert hooks["claude"] == ((f"--settings={settings}",), True)
    assert (tmp_path / "hooks" / "claude-settings.json").is_file()
    args, batch_ok = hooks["codex"]
    assert args[0] == "-c" and args[1].startswith("notify=[") and batch_ok is False


def test_shell_hooks_stay_out_when_they_cannot_work(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)
    assert agent_hooks.shell_hooks(tmp_path / "50%") == {}
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: False)
    assert agent_hooks.shell_hooks(tmp_path / "hooks") == {}
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)
    codex = tmp_path / "codex"
    codex.mkdir()
    (codex / "config.toml").write_text("notify = 5\n", encoding="utf-8")
    monkeypatch.setenv("CODEX_HOME", str(codex))
    assert set(agent_hooks.shell_hooks(tmp_path / "hooks")) == {"claude"}


def test_a_batch_claude_gets_no_unsafe_settings_path(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_hooks, "curl_usable", lambda: True)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    hooks = agent_hooks.shell_hooks(tmp_path / "a&b")
    assert hooks["claude"][1] is False


async def test_the_agent_functions_need_the_hook_environment(monkeypatch):
    manager = SessionManager(asyncio.get_running_loop())
    monkeypatch.setattr(agent_hooks, "shell_hooks", lambda: {"claude": (("--settings=x",), True)})
    # The elevated instance never gets a hook environment.
    assert manager._integration("powershell") == shells.Integration()
    manager.set_agent_hooks(8642, "tok")
    assert manager._integration("powershell") == shells.Integration(
        claude=shells.AgentHook(("--settings=x",), True)
    )
    assert manager._integration("cmd") == shells.Integration()


@WINDOWS
def test_a_plain_shell_launch_names_its_shell(monkeypatch):
    monkeypatch.setattr(shells, "program", lambda value: f"{value}.exe")
    cfg = SimpleNamespace(shell="powershell")
    for value, expected in (("powershell", "powershell"), ("cmd", "cmd"), ("wsl", None)):
        spec = launch.resolve(cfg, shell=value)
        assert spec.shell == expected
        assert spec.spawn_kwargs().get("shell") == expected


# --- a real terminal ----------------------------------------------------------------


@WINDOWS
async def test_a_cd_in_powershell_reaches_the_session(tmp_path):
    # The one real-PTY test: ConPTY must pass the prompt's OSC 9;9 through,
    # with the user's profile loaded, for the session to know the folder.
    target = tmp_path / "proj ä"
    target.mkdir()
    manager = SessionManager(asyncio.get_running_loop())
    try:
        info = manager.spawn(
            cmd=shells.program("powershell"), args=["-NoLogo"], cwd=str(tmp_path), shell="powershell",
        )
        deadline = time.monotonic() + 20
        while info.current_cwd != str(tmp_path):
            assert time.monotonic() < deadline, f"no first report: {info.current_cwd!r}"
            await asyncio.sleep(0.05)
        manager.write(info.id, f"Set-Location -LiteralPath {shells.ps_quote(str(target))}\r".encode())
        while info.current_cwd != str(target):
            assert time.monotonic() < deadline, f"cd not reported: {info.current_cwd!r}"
            await asyncio.sleep(0.05)
    finally:
        manager.shutdown()


