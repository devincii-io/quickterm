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


# --- shell integration ---------------------------------------------------------
#
# A terminal QuickTerm starts in its configured Windows shell reports its
# folder at every prompt as OSC 9;9 with a plain Windows path (pane.js and
# signals.py read it), so the sidebar knows where a `cd` went. In PowerShell
# the user's own `claude` and `codex` also get QuickTerm's hooks. WSL, POSIX
# shells and SSH terminals are left as they are.

INTEGRATED = ("powershell", "cmd", "git-bash")
# The integration script travels in this variable rather than on the command
# line: an agent prompt already takes up to 16000 characters of it, and an
# inline script is not subject to the execution policy, as a file would be.
# The script removes the variable before anything else runs. Constrained
# Language Mode (AppLocker, WDAC) refuses ScriptBlock.Create with an error at
# the top of every terminal, so there the script is skipped and only the
# variable removed: no folder reports, no agent functions.
PS_INIT_VAR = "QUICKTERM_PS_INIT"
PS_BOOT = (
    "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') "
    f"{{ & ([ScriptBlock]::Create($env:{PS_INIT_VAR})) }} "
    f"else {{ Remove-Item -LiteralPath Env:{PS_INIT_VAR} -ErrorAction Ignore }}"
)
# cmd.exe expands $E to ESC and $P to the current folder in PROMPT.
CMD_PROMPT_PREFIX = "$E]9;9;$P$E\\"
CMD_PROMPT_DEFAULT = "$P$G"
# A drive folder (/c/Users) becomes C:\Users without starting a process;
# anything else (the msys root) asks `pwd -W`, a builtin, in a subshell.
GIT_BASH_PROMPT_COMMAND = (
    "__qt_d=$PWD; __qt_b='\\'; "
    "if [[ $__qt_d =~ ^/([A-Za-z])(/.*)?$ ]]; "
    "then __qt_d=${BASH_REMATCH[1]^^}:${BASH_REMATCH[2]:-/}; "
    "else __qt_d=$(pwd -W 2>/dev/null); fi; "
    "[[ -n $__qt_d ]] && printf '\\033]9;9;%s\\033\\\\' \"${__qt_d//\\//$__qt_b}\"; "
    "unset __qt_d __qt_b"
)
# First arguments after which the user's own command goes through untouched:
# subcommands that take no --settings (Claude) or have nothing to report.
CLAUDE_PLAIN = (
    "agents", "mcp", "config", "update", "doctor", "install", "setup-token",
    "migrate-installer", "plugin", "plugins", "login", "logout",
)
CODEX_PLAIN = (
    "login", "logout", "mcp", "mcp-server", "completion", "apply", "app-server",
    "proto", "debug", "help",
)


@dataclass(frozen=True)
class AgentHook:
    """What QuickTerm adds to the user's own `claude` or `codex` in PowerShell:
    `args` (Claude's go after the user's, Codex's before), and whether a
    .cmd/.bat program may be given them (cmd.exe would re-parse some)."""

    args: tuple[str, ...]
    batch_ok: bool


@dataclass(frozen=True)
class Integration:
    """Shell integration for one terminal. The agent hooks are None when the
    launch has none (elevated instance, no usable curl, an unsafe folder)."""

    claude: AgentHook | None = None
    codex: AgentHook | None = None


def _ps_array(words: tuple[str, ...] | list[str]) -> str:
    return "@(" + ",".join(ps_quote(word) for word in words) + ")"


def _ps_agent_function(name: str, hook: AgentHook, plain: tuple[str, ...], *, after: bool) -> str:
    """A global function `name` that runs the real program with `hook.args`.

    The program is resolved on each call, so a later install or PATH change
    counts. Not found: the function steps aside and PowerShell runs `name`
    itself, which reports the usual error (or runs an alias or script). A
    function of that name the user's profile defined (a wrapper for a second
    account, a default model) is theirs: it stays, and gets no hooks."""
    settings = (
        " -or ($a | Where-Object { $s = [string]$_; $s -ceq '--settings' -or "
        "$s.StartsWith('--settings=') })"
        if name == "claude" else ""
    )
    call = "$a + $h" if after else "$h + $a"
    batch = "" if hook.batch_ok else (
        " -or @('.cmd','.bat') -contains [IO.Path]::GetExtension($p.Source).ToLowerInvariant()"
    )
    return (
        f"if (-not (Get-Command -Name {name} -CommandType Function -ErrorAction Ignore)) {{\n"
        f"function global:{name} {{\n"
        f"  $a = @($args)\n"
        f"  $p = Get-Command -Name {name} -CommandType Application -ErrorAction Ignore"
        " | Select-Object -First 1\n"
        "  if (-not $p) {\n"
        f"    $f = ${{function:global:{name}}}\n"
        f"    Remove-Item -LiteralPath Function:\\{name}\n"
        "    try { if ($MyInvocation.ExpectingInput) { $input | & "
        f"{ps_quote(name)} @a }} else {{ & {ps_quote(name)} @a }} }}\n"
        f"    finally {{ ${{function:global:{name}}} = $f }}\n"
        "    return\n"
        "  }\n"
        f"  $h = {_ps_array(hook.args)}\n"
        f"  $plain = ($a.Count -gt 0 -and {_ps_array(plain)} -ccontains [string]$a[0])"
        f"{settings}{batch}\n"
        f"  $c = @(if ($plain) {{ $a }} else {{ {call} }})\n"
        "  if ($MyInvocation.ExpectingInput) { $input | & $p.Source @c } else { & $p.Source @c }\n"
        "}\n"
        "}\n"
    )


# Runs once the profile has loaded. The original prompt runs first, so $?
# and $LASTEXITCODE are still the user's when a prompt framework reads them;
# nothing here starts a program.
_PS_PROMPT = (
    "$global:__QuickTermPrompt = $function:prompt\n"
    "if (-not $global:__QuickTermPrompt) {\n"
    "  $global:__QuickTermPrompt = { \"PS $($executionContext.SessionState.Path.CurrentLocation)"
    "$('>' * ($nestedPromptLevel + 1)) \" }\n"
    "}\n"
    "function global:prompt {\n"
    "  $out = & $global:__QuickTermPrompt\n"
    "  $loc = $executionContext.SessionState.Path.CurrentLocation\n"
    "  if ($loc.Provider.Name -eq 'FileSystem') {\n"
    "    [Console]::Write([string][char]27 + ']9;9;' + $loc.ProviderPath + [char]27 + '\\')\n"
    "  }\n"
    "  $out\n"
    "}\n"
)


def ps_integration(integration: Integration) -> str:
    """The PowerShell integration script (the value of PS_INIT_VAR)."""
    parts = [f"Remove-Item -LiteralPath Env:{PS_INIT_VAR} -ErrorAction Ignore\n", _PS_PROMPT]
    if integration.claude is not None:
        parts.append(_ps_agent_function("claude", integration.claude, CLAUDE_PLAIN, after=True))
    if integration.codex is not None:
        parts.append(_ps_agent_function("codex", integration.codex, CODEX_PLAIN, after=False))
    return "".join(parts)


def _env_get(env: dict[str, str], name: str) -> tuple[str | None, str | None]:
    """(key, value) of `name` in `env`, matched case-insensitively."""
    for key, value in env.items():
        if key.casefold() == name.casefold():
            return key, value
    return None, None


def integration_env(value: str, integration: Integration | None, env: dict[str, str]) -> dict[str, str]:
    """`env` with what the shell integration of `value` needs. `env` is the
    launch's own environment; QuickTerm's environment (os.environ) is only
    read for cmd's PROMPT."""
    if integration is None or value not in INTEGRATED:
        return env
    out = dict(env)
    if value == "powershell":
        out[PS_INIT_VAR] = ps_integration(integration)
    elif value == "cmd":
        key, current = _env_get(out, "PROMPT")
        if key is not None:
            del out[key]
        if current is None:
            current = _env_get(dict(os.environ), "PROMPT")[1]
        out["PROMPT"] = cmd_prompt(current)
    elif value == "git-bash":
        key, current = _env_get(out, "PROMPT_COMMAND")
        if key is not None:
            del out[key]
        if current is None:
            current = _env_get(dict(os.environ), "PROMPT_COMMAND")[1]
        out["PROMPT_COMMAND"] = bash_prompt_command(current)
    return out


def cmd_prompt(current: str | None) -> str:
    """cmd's PROMPT: the folder report, then the user's own prompt."""
    own = current or CMD_PROMPT_DEFAULT
    while own.startswith(CMD_PROMPT_PREFIX):
        own = own[len(CMD_PROMPT_PREFIX):]
    return CMD_PROMPT_PREFIX + (own or CMD_PROMPT_DEFAULT)


def bash_prompt_command(current: str | None) -> str:
    """Git Bash's PROMPT_COMMAND: the user's own (from the environment), then
    the folder report. A bashrc that sets its own replaces both."""
    own = (current or "").strip().rstrip(";").rstrip()
    if not own or GIT_BASH_PROMPT_COMMAND in own:
        return own or GIT_BASH_PROMPT_COMMAND
    return f"{own}; {GIT_BASH_PROMPT_COMMAND}"


def check_cmd_command(command: str) -> None:
    """ValueError when cmd.exe would read more into `command` than one plain
    command line (the rule the agent wrap applies to its arguments)."""
    if _CMD_UNSAFE.search(command):
        raise ValueError("the command contains characters cmd.exe would reinterpret")


def posix_then_shell(command: str, shell: str) -> str:
    """POSIX text that runs `command` once and then becomes `shell` as a login
    shell. `eval` reads the command as typed, so a trailing `&` or a comment
    in it cannot swallow the part that keeps the terminal open."""
    return f"eval {shlex.quote(command)}; exec {shell} -l"


def wsl_login_shell() -> str:
    """The distribution's login shell, which bash set from the user's entry."""
    return '"${SHELL:-bash}"'


def interactive(
    value: str, prog: str, cwd: str | None, integration: Integration | None = None,
    command: str | None = None,
) -> tuple[str, list[str], str | None]:
    """The plain shell: command, arguments, process folder.

    With `integration`, PowerShell runs QuickTerm's integration script
    (`integration_env` carries it) and stays interactive. `command` (one
    line, see workspace.validate_command) runs once before the prompt.
    ValueError when cmd.exe would re-parse it."""
    if value == "powershell":
        if command is not None:
            text = f"{PS_BOOT}\n{command}" if integration is not None else command
            return prog, ["-NoLogo", "-NoExit", "-Command", text], cwd
        if integration is not None:
            return prog, ["-NoLogo", "-NoExit", "-Command", PS_BOOT], cwd
        return prog, ["-NoLogo"], cwd
    if value == "cmd":
        if command is not None:
            check_cmd_command(command)
            # Verbatim after /k (conpty.command_line); cmd strips these quotes.
            return prog, ["/k", f'"{command}"'], cwd
        return prog, [], cwd
    if is_wsl(value):
        # wsl.exe opens under /mnt/c otherwise; --cd also takes a Windows path.
        name = distro(value)
        head = [*(["-d", name] if name else []), "--cd", cwd or "~"]
        if command is not None:
            # --exec: no shell reads the line before bash does.
            text = posix_then_shell(command, wsl_login_shell())
            return prog, [*head, "--exec", "bash", "-lc", text], None
        return prog, head, None
    if command is not None:
        shell = "bash" if value == "git-bash" else posix_word(prog)
        return prog, ["-lc", posix_then_shell(command, shell)], cwd
    return prog, ["-l"], cwd


def with_wslenv(env: dict[str, str], names: list[str] | tuple[str, ...]) -> dict[str, str]:
    """`env` with `names` added to WSLENV, so wsl.exe hands them to Linux.
    The WSLENV in `env` (else this process's) keeps its own entries."""
    out = dict(env)
    key = next((name for name in out if name.casefold() == "wslenv"), None)
    current = out.pop(key) if key is not None else os.environ.get("WSLENV", "")
    entries = [entry for entry in current.split(":") if entry]
    have = {entry.split("/")[0].upper() for entry in entries}
    for name in names:
        if name.upper() not in have:
            entries.append(name)
            have.add(name.upper())
    if entries:
        out["WSLENV"] = ":".join(entries)
    return out


@dataclass(frozen=True)
class Wrap:
    """How an agent command runs inside the shell: the effective shell value,
    its program, and the agent's own CLI name ("claude" or "codex"), which is
    what WSL runs from the distribution's PATH."""

    value: str
    program: str
    cli: str


def wrap(
    spec: Wrap, exe: str, args: list[str], cwd: str | None,
    integration: Integration | None = None,
) -> tuple[str, list[str], str | None]:
    """Command, arguments and process folder of the shell that runs `exe args`
    once and then stays interactive. ValueError when cmd.exe would re-parse
    an argument. With `integration`, PowerShell runs QuickTerm's integration
    script first; cmd and Git Bash take theirs from the environment alone."""
    value, prog = spec.value, spec.program
    if value == "powershell":
        command = ps_command(exe, args)
        if integration is not None:
            command = f"{PS_BOOT}\n{command}"
        return prog, ["-NoLogo", "-NoExit", "-Command", command], cwd
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
