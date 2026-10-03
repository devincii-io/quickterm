"""Launch arguments and option schema for the agent CLIs: Claude Code and Codex.

Built like connections.py: typed string options in `Profile.agent`, checked by
`validate` on save and again by `resolve` at launch, argv built without a
shell. `OPTIONS` is the one source for that validation and for the Settings
editor (`GET /api/system/agents`), so the frontend hardcodes no option list.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

AGENT_TYPES = frozenset({"claude-code", "codex"})
MODES = {
    "claude-code": ("new", "continue", "resume", "agents"),
    "codex": ("new", "continue", "resume", "fork", "agents"),
}
DEFAULT_MODE = {"claude-code": "continue", "codex": "new"}
LABELS = {"claude-code": "Claude Code", "codex": "Codex CLI"}
MODE_LABELS = {
    "new": "new conversation",
    "continue": "continue latest",
    "resume": "choose session",
    "fork": "fork a session",
    "agents": "agent manager",
}
_MODE_DETAILS = {
    "claude-code": {
        "new": "claude", "continue": "claude --continue", "resume": "claude --resume",
        "agents": "claude agents --cwd <workspace>",
    },
    "codex": {
        "new": "codex", "continue": "codex resume --last", "resume": "codex resume",
        "fork": "codex fork", "agents": "codex agents",
    },
}
FOLDER_ERRORS = {
    "claude-code": "Claude Code profile requires a project folder",
    "codex": "Codex profile requires a project folder",
}
SESSION_ID = re.compile(r"^[0-9a-fA-F-]{36}$")
_MODEL = r"^[A-Za-z0-9._:\[\]-]{1,100}$"
_NAME = r"^[A-Za-z0-9._-]{1,64}$"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# cmd.exe re-parses the command line of a .cmd or .bat file (BatBadBut), so
# these never reach a batch shim as part of an argument.
_CMD_UNSAFE = re.compile(r'["&|<>^%!\r\n]')
_VENDORED = (
    ("x64", "codex-win32-x64", "x86_64-pc-windows-msvc"),
    ("arm64", "codex-win32-arm64", "aarch64-pc-windows-msvc"),
)


@dataclass(frozen=True)
class Option:
    key: str
    label: str
    kind: str  # choice | combo | text | lines | toggle
    flag: str
    hint: str
    advanced: bool = False
    choices: tuple[tuple[str, str], ...] = ()
    pattern: str | None = None
    max_chars: int = 1024
    max_lines: int = 16
    placeholder: str | None = None
    # Codex takes the value as one `--config key=value` argument.
    template: str = "{}"

    def schema(self) -> dict:
        out: dict[str, Any] = {
            "key": self.key, "label": self.label, "kind": self.kind,
            "hint": self.hint, "advanced": self.advanced,
        }
        if self.kind in ("choice", "combo"):
            out["choices"] = [{"value": value, "label": label} for value, label in self.choices]
        if self.placeholder:
            out["placeholder"] = self.placeholder
        return out


def _efforts() -> tuple[tuple[str, str], ...]:
    return tuple((value, value) for value in EFFORTS)


OPTIONS: dict[str, tuple[Option, ...]] = {
    "claude-code": (
        Option(
            "model", "Model", "combo", "--model", "Alias or full model id; empty uses Claude's default.",
            choices=tuple((v, v) for v in (
                "opus", "sonnet", "haiku", "best", "fable", "opusplan", "sonnet[1m]", "opus[1m]",
            )),
            pattern=_MODEL, placeholder="default",
        ),
        Option(
            "permission_mode", "Permissions", "choice", "--permission-mode",
            "How Claude asks before it edits files or runs commands.",
            choices=(
                ("manual", "Manual: asks first"), ("acceptEdits", "Accept edits"), ("plan", "Plan only"),
                ("auto", "Auto"), ("dontAsk", "Don't ask"), ("bypassPermissions", "Bypass permissions"),
            ),
        ),
        Option("effort", "Effort", "choice", "--effort", "Reasoning effort for the session.",
               choices=_efforts()),
        Option("session_name", "Session name", "text", "--name",
               "Display name of the conversation; it can be resumed by this name.", max_chars=100),
        Option("add_dirs", "Extra folders", "lines", "--add-dir",
               "More folders Claude may read and edit, one per line."),
        Option("append_system_prompt", "Extra system prompt", "text", "--append-system-prompt",
               "Text appended to Claude's system prompt.", advanced=True, max_chars=4096),
        Option("agent", "Agent", "text", "--agent", "Name of a configured subagent to run as.",
               advanced=True, pattern=_NAME),
        Option("mcp_config", "MCP config", "text", "--mcp-config",
               "MCP server config file or JSON.", advanced=True),
        Option("settings", "Settings file", "text", "--settings",
               "Extra settings file or JSON.", advanced=True),
        Option("fork_session", "Fork when resuming", "toggle", "--fork-session",
               "Continue or resume into a new session id instead of the old one.", advanced=True),
        Option("verbose", "Verbose", "toggle", "--verbose", "Show full turn-by-turn output.",
               advanced=True),
        Option("ide", "Connect IDE", "toggle", "--ide",
               "Connect to an IDE at startup when exactly one is available.", advanced=True),
    ),
    "codex": (
        Option("model", "Model", "combo", "--model", "Model slug; empty uses Codex's default.",
               pattern=_MODEL, placeholder="default"),
        Option("approval", "Approval", "choice", "--ask-for-approval",
               "When Codex asks before it runs a command.",
               choices=(("on-request", "On request"), ("never", "Never"))),
        Option("sandbox", "Sandbox", "choice", "--sandbox", "What commands Codex runs may touch.",
               choices=(
                   ("read-only", "Read only"), ("workspace-write", "Workspace write"),
                   ("danger-full-access", "Full access"),
               )),
        Option("approve_for_me", "Approve for me", "toggle", "--approve-for-me",
               "Route approvals through automatic review inside the workspace sandbox."),
        Option("bypass", "Bypass approvals and sandbox", "toggle",
               "--dangerously-bypass-approvals-and-sandbox",
               "Run every command without asking and without a sandbox."),
        Option("effort", "Reasoning effort", "choice", "--config", "Reasoning effort for the model.",
               choices=_efforts(), pattern=r"^[a-z]{2,16}$", template="model_reasoning_effort={}"),
        Option("search", "Web search", "toggle", "--search", "Allow live web search."),
        Option("config_profile", "Config profile", "combo", "--profile",
               "A profile file from the Codex home folder (<name>.config.toml).", pattern=_NAME),
        Option("add_dirs", "Extra folders", "lines", "--add-dir",
               "More writable folders, one per line."),
        Option("worktree", "Worktree", "toggle", "--worktree",
               "Start in a new git worktree.", advanced=True),
        Option("no_alt_screen", "Inline mode", "toggle", "--no-alt-screen",
               "Keep the terminal's scrollback instead of the full-screen view.", advanced=True),
        Option("oss", "Local model", "toggle", "--oss", "Use a local open-source model provider.",
               advanced=True),
        Option("local_provider", "Local provider", "choice", "--local-provider",
               "Which local provider --oss uses.", advanced=True,
               choices=(("lmstudio", "LM Studio"), ("ollama", "Ollama"))),
    ),
}
# In agents mode Claude takes these as defaults for the sessions it dispatches.
_CLAUDE_AGENTS_KEYS = frozenset({"model", "permission_mode", "effort", "agent"})


def _options(kind: str) -> dict[str, Option]:
    return {option.key: option for option in OPTIONS[kind]}


def _mode_of(profile: Any) -> str | None:
    return getattr(profile, "agent_mode", None) or getattr(profile, "claude_mode", None)


def validate(profile: Any) -> None:
    """Raise ValueError for an agent profile that cannot be saved."""
    kind = getattr(profile, "terminal_type", None)
    if kind not in AGENT_TYPES:
        raise ValueError(f"not an agent type: {kind}")
    mode = _mode_of(profile)
    if mode is not None and mode not in MODES[kind]:
        raise ValueError(_mode_error(kind))
    values = getattr(profile, "agent", None) or {}
    if not isinstance(values, dict):
        raise ValueError("agent options must be an object")
    schema = _options(kind)
    for key, value in values.items():
        if key not in schema:
            raise ValueError(f"unknown agent option: {key}")
        if not isinstance(value, str) or "\0" in value:
            raise ValueError(f"{key} must be text")
        if value == "":
            continue
        option = schema[key]
        if option.kind != "lines" and ("\n" in value or "\r" in value):
            raise ValueError(f"{key} must be one line")
        if option.kind == "toggle":
            if value not in ("true", "false"):
                raise ValueError(f"{key} must be true or false")
            continue
        if option.kind == "lines":
            lines = _lines(value)
            if len(lines) > option.max_lines:
                raise ValueError(f"{key} takes at most {option.max_lines} lines")
            if any(len(line) > option.max_chars for line in lines):
                raise ValueError(f"{key} lines cannot exceed {option.max_chars} characters")
            if kind == "codex" and any(line.startswith("-") for line in lines):
                raise ValueError(f"{key} lines must not start with -")
            continue
        if option.kind == "choice" and option.pattern is None:
            if value not in {choice for choice, _label in option.choices}:
                raise ValueError(f"{key} must be {_one_of([c for c, _l in option.choices])}")
        if option.pattern is not None and not re.fullmatch(option.pattern, value):
            raise ValueError(f"{key} is not valid: {value}")
        if len(value) > option.max_chars:
            raise ValueError(f"{key} cannot exceed {option.max_chars} characters")
        # Codex takes each value as its own argument, so a leading dash would
        # read as another flag. Claude gets --flag=value and is safe.
        if kind == "codex" and value.startswith("-"):
            raise ValueError(f"{key} must not start with -")
    if kind == "codex":
        if _on(values, "bypass") and (
            values.get("approval") or values.get("sandbox") or _on(values, "approve_for_me")
        ):
            raise ValueError("bypass replaces approval and sandbox; clear them first")
        if values.get("local_provider") and not _on(values, "oss"):
            raise ValueError("local_provider needs oss")


def _mode_error(kind: str) -> str:
    name = "Claude" if kind == "claude-code" else "Codex"
    return f"{name} launch mode must be {_one_of(MODES[kind])}"


def _one_of(values: Any) -> str:
    items = list(values)
    if len(items) < 3:
        return " or ".join(items)
    return ", ".join(items[:-1]) + f", or {items[-1]}"


def _on(values: dict, key: str) -> bool:
    return values.get(key) == "true"


def _lines(value: str) -> list[str]:
    return [line.strip() for line in value.replace("\r", "").split("\n") if line.strip()]


def resolve(
    profile: Any, cwd: str | None, *, mode: str | None = None, session: str | None = None
) -> tuple[str, list[str], str]:
    """Command, arguments and process folder for one agent profile.

    `mode` overrides the profile's launch mode for this launch; `session`
    resumes (or, for Codex, forks) that session id and implies resume.
    """
    validate(profile)
    kind = profile.terminal_type
    if not isinstance(cwd, str) or not cwd.strip():
        raise ValueError(FOLDER_ERRORS[kind])
    if mode is None:
        mode = "resume" if session else (_mode_of(profile) or DEFAULT_MODE[kind])
    if mode not in MODES[kind]:
        raise ValueError(_mode_error(kind))
    if session is not None:
        if not isinstance(session, str) or not SESSION_ID.fullmatch(session):
            raise ValueError("agent_session must be a session id")
        if mode != "resume" and not (kind == "codex" and mode == "fork"):
            raise ValueError("agent_session needs resume or fork")
    values = {key: value for key, value in (getattr(profile, "agent", None) or {}).items() if value}
    extra = list(getattr(profile, "args", None) or [])
    configured = (getattr(profile, "cmd", None) or "").strip()
    if kind == "claude-code":
        executable = configured or shutil.which("claude") or ("claude.exe" if os.name == "nt" else "claude")
        args = _claude_args(mode, session, cwd, values) + extra
    else:
        executable = _codex_command(configured)
        args = _codex_args(mode, session, cwd, values) + extra
    _guard_batch(executable, args)
    return executable, args, cwd


def _claude_args(mode: str, session: str | None, cwd: str, values: dict) -> list[str]:
    # Every value travels as --flag=value: --add-dir and --mcp-config are
    # variadic and would swallow a following separate argument.
    if mode == "agents":
        args = ["agents", "--cwd", cwd]
    else:
        args = {"new": [], "continue": ["--continue"], "resume": ["--resume"]}[mode]
        if session:
            args = args + [session]
    for option in OPTIONS["claude-code"]:
        value = values.get(option.key)
        if not value or (mode == "agents" and option.key not in _CLAUDE_AGENTS_KEYS):
            continue
        if option.kind == "toggle":
            if value != "true":
                continue
            if option.key == "fork_session" and mode not in ("continue", "resume"):
                continue
            args.append(option.flag)
        elif option.kind == "lines":
            args += [f"{option.flag}={line}" for line in _lines(value)]
        else:
            args.append(f"{option.flag}={value}")
    return args


def _codex_args(mode: str, session: str | None, cwd: str, values: dict) -> list[str]:
    if mode == "agents":
        return ["agents"]
    args = {
        "new": [], "continue": ["resume", "--last"], "resume": ["resume"], "fork": ["fork"],
    }[mode]
    if session:
        args = args + [session]
    args = args + ["--cd", cwd]
    for option in OPTIONS["codex"]:
        value = values.get(option.key)
        if not value:
            continue
        if option.kind == "toggle":
            if value == "true":
                args.append(option.flag)
        elif option.kind == "lines":
            for line in _lines(value):
                args += [option.flag, line]
        else:
            args += [option.flag, option.template.format(value)]
    return args


def _guard_batch(executable: str, args: list[str]) -> None:
    resolved = executable
    if not os.path.dirname(executable):
        resolved = shutil.which(executable) or executable
    if not resolved.lower().endswith((".cmd", ".bat")):
        return
    for arg in args:
        if _CMD_UNSAFE.search(arg):
            raise ValueError(f"{arg} contains characters cmd.exe would reinterpret")


def _vendored_codex(shim: str) -> str | None:
    """The native codex.exe that npm installs next to its codex.cmd shim."""
    base = Path(shim).parent / "node_modules" / "@openai" / "codex" / "node_modules" / "@openai"
    order = list(_VENDORED)
    if platform.machine().lower() in ("arm64", "aarch64"):
        order.reverse()
    for _arch, package, triple in order:
        candidate = base / package / "vendor" / triple / "bin" / "codex.exe"
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def _prefer_native(path: str) -> str:
    if os.name == "nt" and path.lower().endswith(".cmd"):
        return _vendored_codex(path) or path
    return path


def codex_executable() -> str | None:
    """The Codex program to start, or None when it is not installed.

    On Windows npm installs a codex.cmd shim; the native exe it wraps is
    preferred, so no argument passes through cmd.exe's re-parse.
    """
    found = shutil.which("codex")
    return _prefer_native(found) if found else None


def _codex_command(configured: str) -> str:
    if not configured:
        return codex_executable() or "codex"
    if os.path.dirname(configured):
        return _prefer_native(configured)
    # A bare name (Settings stores "codex") resolves to the npm shim on
    # Windows; take the native exe behind it when there is one.
    found = shutil.which(configured)
    if found:
        native = _prefer_native(found)
        if native != found:
            return native
    return configured


def claude_executable() -> str | None:
    return shutil.which("claude")


def codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured) if configured else Path.home() / ".codex"


def _codex_models() -> list[dict]:
    """Listed models from Codex's own cache, best effort."""
    try:
        raw = json.loads((codex_home() / "models_cache.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return []
    models = raw.get("models") if isinstance(raw, dict) else None
    out = []
    for model in models if isinstance(models, list) else []:
        if not isinstance(model, dict) or model.get("visibility") != "list":
            continue
        slug = model.get("slug")
        if not isinstance(slug, str) or not re.fullmatch(_MODEL, slug):
            continue
        levels = []
        for level in model.get("supported_reasoning_levels") or []:
            effort = level.get("effort") if isinstance(level, dict) else level
            if isinstance(effort, str) and re.fullmatch(r"[a-z]{2,16}", effort):
                levels.append(effort)
        default = model.get("default_reasoning_level")
        out.append({
            "slug": slug,
            "label": model.get("display_name") if isinstance(model.get("display_name"), str) else slug,
            "default_effort": default if isinstance(default, str) else None,
            "efforts": levels,
        })
    return out


def _codex_profiles() -> list[str]:
    try:
        names = [path.name for path in codex_home().glob("*.config.toml")]
    except OSError:
        return []
    stems = (name[: -len(".config.toml")] for name in names)
    return sorted(stem for stem in stems if re.fullmatch(_NAME, stem))


def catalog() -> dict:
    """The schema behind GET /api/system/agents. Blocking: PATH and file reads."""
    types = []
    for kind in ("claude-code", "codex"):
        executable = claude_executable() if kind == "claude-code" else codex_executable()
        options = [option.schema() for option in OPTIONS[kind]]
        if kind == "codex":
            models = _codex_models()
            efforts = list(EFFORTS) + sorted(
                {e for model in models for e in model["efforts"]} - set(EFFORTS)
            )
            profiles = _codex_profiles()
            for entry in options:
                if entry["key"] == "model":
                    entry["choices"] = [
                        {"value": m["slug"], "label": m["label"]}
                        | ({"detail": f"default effort {m['default_effort']}"} if m["default_effort"] else {})
                        for m in models
                    ]
                elif entry["key"] == "effort":
                    entry["choices"] = [{"value": e, "label": e} for e in efforts]
                elif entry["key"] == "config_profile":
                    entry["choices"] = [{"value": p, "label": p} for p in profiles]
        types.append({
            "id": kind,
            "label": LABELS[kind],
            "executable": executable,
            "available": executable is not None,
            "modes": [
                {"value": mode, "label": MODE_LABELS[mode], "detail": _MODE_DETAILS[kind][mode]}
                for mode in MODES[kind]
            ],
            "default_mode": DEFAULT_MODE[kind],
            "options": options,
        })
    return {"types": types}
