"""The one configured shell: its values, its program, and how an agent runs in it.

A new terminal without a profile starts `AppConfig.shell` in the workspace
folder, and Claude Code and Codex run inside that shell, so the user is left
at a prompt when the agent exits. The argv builders are pure; only `program`
and the inventory look at the disk.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

DEFAULT = "powershell"
WINDOWS_VALUES = ("powershell", "cmd", "git-bash", "wsl")
LABELS = {"powershell": "PowerShell", "cmd": "Command Prompt", "git-bash": "Git Bash", "wsl": "WSL"}
# WSL takes the name after -d; a leading dash would read as another option.
_DISTRO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
VALUE_ERROR = "shell must be one of powershell, cmd, git-bash, wsl, wsl:<distro>"
# cmd.exe parses the whole line after /k itself, so these never reach it as
# part of an agent argument (the batch-shim rule in agents.py, applied to all).
_CMD_UNSAFE = re.compile(r'["&|<>^%!\r\n]')
# PowerShell reads all four as a single quote, so each is doubled inside a
# single-quoted word.
_PS_QUOTES = "'\u2018\u2019\u201a\u201b"


def validate(value: object) -> None:
    """Raise ValueError unless `value` is a shell value the config may hold.

    "" is the POSIX login shell; it is accepted everywhere so one config file
    can move between machines.
    """
    if not isinstance(value, str):
        raise ValueError(VALUE_ERROR)
    if value in ("", *WINDOWS_VALUES):
        return
    if value.startswith("wsl:") and _DISTRO.fullmatch(value[4:]):
        return
    raise ValueError(VALUE_ERROR)


def effective(value: str, *, windows: bool | None = None) -> str:
    """The value a launch uses: POSIX always takes the login shell, Windows
    reads an empty value as PowerShell."""
    windows = os.name == "nt" if windows is None else windows
    if not windows:
        return ""
    return value or DEFAULT


def is_wsl(value: str | None) -> bool:
    return bool(value) and (value == "wsl" or str(value).startswith("wsl:"))


def distro(value: str) -> str | None:
    return value[4:] if value.startswith("wsl:") else None


def terminal_type(value: str) -> str:
    """The pane terminal type a shell value behaves like (paths, splits)."""
    if is_wsl(value):
        return "wsl"
    return {
        "powershell": "powershell-core", "cmd": "command-prompt", "git-bash": "git-bash",
    }.get(value, "bash")


def label(value: str) -> str:
    if value.startswith("wsl:"):
        return f"WSL: {value[4:]}"
    if not value:
        login = os.environ.get("SHELL") or ""
        return Path(login).name if login else "Shell"
    return LABELS.get(value, value)


# --- programs -----------------------------------------------------------------


def _system_root() -> Path:
    return Path(os.environ.get("SystemRoot") or r"C:\Windows")


def _first(command: str | None, *candidates: Path) -> str | None:
    if command:
        found = shutil.which(command)
        if found:
            return str(Path(found))
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def pwsh_program() -> str | None:
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    candidates = [program_files / "PowerShell" / "7" / "pwsh.exe"]
    try:
        candidates += sorted((program_files / "PowerShell").glob("*/pwsh.exe"), reverse=True)
    except OSError:
        pass
    return _first("pwsh.exe", *candidates)


def git_bash_program() -> str | None:
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    return _first(
        None,
        program_files / "Git" / "bin" / "bash.exe",
        program_files_x86 / "Git" / "bin" / "bash.exe",
    )


def wsl_program() -> str | None:
    return _first("wsl.exe", _system_root() / "System32" / "wsl.exe")


def posix_program() -> str:
    return os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"


def program(value: str) -> str:
    """The executable for an effective shell value. Blocking: PATH and disk.

    ValueError when the shell is not installed.
    """
    if value == "":
        return posix_program()
    if value == "powershell":
        return pwsh_program() or _first(
            "powershell.exe",
            _system_root() / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe",
        ) or "powershell.exe"
    if value == "cmd":
        return _first("cmd.exe", _system_root() / "System32" / "cmd.exe") or "cmd.exe"
    if value == "git-bash":
        found = git_bash_program()
        if found is None:
            raise ValueError("Git Bash is not installed; choose another shell in Settings")
        return found
    if is_wsl(value):
        found = wsl_program()
        if found is None:
            raise ValueError("WSL is not installed; choose another shell in Settings")
        return found
    raise ValueError(VALUE_ERROR)


# --- argv -------------------------------------------------------------------


def posix_word(word: str) -> str:
    """`word` as one word of a POSIX command line. A Windows path gets forward
    slashes, which msys and Cygwin read, because bash would eat backslashes."""
    if "\\" in word or re.match(r"[A-Za-z]:", word):
        word = word.replace("\\", "/")
    return shlex.quote(word)


def ps_quote(word: str) -> str:
    """One single-quoted PowerShell word."""
    for quote in _PS_QUOTES:
        word = word.replace(quote, quote * 2)
    return f"'{word}'"


# Windows PowerShell 5.1 and pwsh before 7.3 build a native command line
# without escaping: an embedded double quote is lost, an empty argument
# disappears, and an argument escaped beforehand is quoted a second time. For
# such a word the command line is built here (C runtime rules, as the agent
# reads it) and handed over untouched: stop-parsing (--%) passes the rest of
# its line as it is, after putting an environment variable in. Every
# PowerShell version does the same with it.
PS_ARGS_VAR = "QUICKTERM_AGENT_ARGS"
# An OSC the pane swallows (pane.js), printed when a WSL agent has exited.
AGENT_EXIT_OSC = 7770
AGENT_EXIT_PRINTF = f"printf '\\033]{AGENT_EXIT_OSC};quickterm-agent-exit\\007'"


def _ps_needs_escape(word: str) -> bool:
    return word == "" or '"' in word or (bool(re.search(r"\s", word)) and word.endswith("\\"))


def ps_command(exe: str, args: list[str]) -> str:
    """The -Command text that runs `exe args` once, as the arguments are."""
    if not any(_ps_needs_escape(arg) for arg in args):
        return "& " + " ".join(ps_quote(word) for word in [exe, *args])
    line = subprocess.list2cmdline(args)
    array = "@(" + ",".join(ps_quote(arg) for arg in args) + ")"
    # 7.3 and later pass an array as it is but quote a --% expansion again,
    # so each path gets the form that survives it. --% ends at the line's
    # end, hence the line breaks. Only the variable is expanded, once: a % in
    # its value stays as it is.
    return (
        "if(-not(Test-Path variable:PSNativeCommandArgumentPassing) -or "
        "$PSNativeCommandArgumentPassing -eq 'Legacy'){"
        f"$env:{PS_ARGS_VAR}={ps_quote(line)}\n"
        f"& {ps_quote(exe)} --% %{PS_ARGS_VAR}%\n"
        f"Remove-Item Env:{PS_ARGS_VAR}}}else{{& {ps_quote(exe)} {array}}}"
    )


def interactive(value: str, prog: str, cwd: str | None) -> tuple[str, list[str], str | None]:
    """The plain shell: command, arguments, process folder."""
    if value == "powershell":
        return prog, ["-NoLogo"], cwd
    if value == "cmd":
        return prog, [], cwd
    if is_wsl(value):
        # wsl.exe opens under /mnt/c otherwise; --cd also takes a Windows path.
        name = distro(value)
        return prog, [*(["-d", name] if name else []), "--cd", cwd or "~"], None
    return prog, ["-l"], cwd


@dataclass(frozen=True)
class Wrap:
    """How an agent command runs inside the shell: the effective shell value,
    its program, and the agent's own CLI name ("claude" or "codex"), which is
    what WSL runs from the distribution's PATH."""

    value: str
    program: str
    cli: str


def wrap(spec: Wrap, exe: str, args: list[str], cwd: str | None) -> tuple[str, list[str], str | None]:
    """Command, arguments and process folder of the shell that runs `exe args`
    once and then stays interactive. ValueError when cmd.exe would re-parse
    an argument."""
    value, prog = spec.value, spec.program
    if value == "powershell":
        return prog, ["-NoLogo", "-NoExit", "-Command", ps_command(exe, args)], cwd
    if value == "cmd":
        for word in [exe, *args]:
            if _CMD_UNSAFE.search(word):
                raise ValueError(f"{word} contains characters cmd.exe would reinterpret")
        # The outer quotes are the ones cmd strips from the text after /k, so
        # a quoted program path survives (conpty passes this text verbatim).
        return prog, ["/k", f'"{subprocess.list2cmdline([exe, *args])}"'], cwd
    if value == "git-bash":
        command = " ".join([posix_word(exe), *(shlex.quote(arg) for arg in args)])
        return prog, ["-lc", f"{command}; exec bash -l"], cwd
    if is_wsl(value):
        # The Linux CLI from the distribution's PATH, never the Windows exe;
        # --cd puts it in the workspace folder, so the folder arguments the
        # agents take become ".".
        inner = [spec.cli, *("." if cwd and arg == cwd else arg for arg in args)]
        # The marker tells the pane the agent is gone: WSL reports no state
        # and its processes are out of sight.
        command = " ".join(shlex.quote(word) for word in inner) + f"; {AGENT_EXIT_PRINTF}"
        name = distro(value)
        # --exec, not --: with -- the distribution's default shell reads the
        # line again, and $(...), backticks and $VAR in an argument (a prompt
        # that quotes a CI log) would run. --exec hands bash its argv as is.
        return prog, [
            *(["-d", name] if name else []), "--cd", cwd or "~",
            "--exec", "bash", "-lc", f"{command}; exec bash -l",
        ], None
    command = " ".join([posix_word(exe), *(shlex.quote(arg) for arg in args)])
    return prog, ["-lc", f"{command}; exec {posix_word(prog)} -l"], cwd


# --- inventory --------------------------------------------------------------


def entries(
    *, windows: bool, git_bash: bool = False, distributions: list[str] | tuple[str, ...] = (),
) -> list[dict]:
    """The `shells` list of the terminal inventory. Git Bash and WSL appear only
    when installed; PowerShell and cmd are part of Windows."""
    if not windows:
        return [{"value": "", "label": label(""), "available": True}]
    out = [
        {"value": "powershell", "label": LABELS["powershell"], "available": True},
        {"value": "cmd", "label": LABELS["cmd"], "available": True},
    ]
    if git_bash:
        out.append({"value": "git-bash", "label": LABELS["git-bash"], "available": True})
    for name in distributions:
        if _DISTRO.fullmatch(name):
            out.append({"value": f"wsl:{name}", "label": f"WSL: {name}", "available": True})
    return out
