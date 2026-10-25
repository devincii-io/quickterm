"""App config: dataclasses + JSON persistence under %APPDATA%/quickterm."""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import re
import tempfile
import shlex
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TypeVar

from . import secret_store

_T = TypeVar("_T")


ENV_MAX_PAIRS = 256
ENV_MAX_KEY_CHARS = 1024
ENV_MAX_VALUE_CHARS = 64 * 1024
ENV_MAX_TOTAL_CHARS = 256 * 1024
_DPAPI_SCHEME = "dpapi-v1"


@dataclass
class AgentProfile:
    """One agent's settings as the launch code takes them. `name` is the
    kind ("claude-code" or "codex"), which is also how a request names it."""

    name: str
    cmd: str
    terminal_type: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    agent_mode: str | None = None
    agent: dict[str, str] = field(default_factory=dict)


@dataclass
class AgentSettings:
    """How Claude Code or Codex starts: what an agent profile held for the
    launch before 4.3. An empty `cmd` finds the CLI on PATH."""

    cmd: str = ""
    args: list[str] = field(default_factory=list)
    agent_mode: str | None = None
    agent: dict[str, str] = field(default_factory=dict)
    env: dict[str, str] = field(default_factory=dict)


AGENT_KINDS = ("claude-code", "codex")
AGENT_LABELS = {"claude-code": "Claude Code", "codex": "Codex"}


def _default_agents() -> dict[str, AgentSettings]:
    return {kind: AgentSettings() for kind in AGENT_KINDS}


@dataclass
class Snippet:
    name: str
    text: str
    # What the command does and when to reach for it. The keystrokes alone do
    # not say it: "git status" repeats the name and answers nothing about why
    # this one is kept. Defaulted because older config files do not have the
    # key, and `_known()` only drops unknown fields.
    description: str = ""


@dataclass
class VoiceConfig:
    enabled: bool = True
    model_size: str = "small"
    hotkey: str = "ctrl+alt+v"
    language: str | None = None


@dataclass
class WindowConfig:
    width: int = 1280
    height: int = 800
    remember_bounds: bool = True


@dataclass
class OverlayConfig:
    enabled: bool = False
    edge: str = "top"
    width_pct: int = 100
    height_pct: int = 50
    always_on_top: bool = True
    hide_on_blur: bool = True
    monitor: str = "cursor"
    animate: bool = True


NOTIFY_MODES = ("off", "flash", "notify")


@dataclass
class NotificationsConfig:
    """How a terminal the user is not looking at gets their attention:
    "off", "flash" (the taskbar button) or "notify" (also a Windows
    notification), per kind; ``sound`` plays the notification sound too."""

    needs_you: str = "notify"
    finished: str = "flash"
    sound: bool = False


def _default_snippets() -> list[Snippet]:
    # The shipped snippets double as the worked example of a good one: a name
    # you would search for, and a description that says when you reach for it.
    return [
        Snippet(
            name="git status",
            text="git status\r",
            description="What has changed in this repository since the last commit.",
        ),
        Snippet(
            name="uv run pytest",
            text="uv run pytest\r",
            description="Run the Python test suite of the project this terminal is in.",
        ),
    ]


@dataclass
class AppConfig:
    host: str = "127.0.0.1"
    port: int = 8620
    scrollback_bytes: int = 512 * 1024
    font_family: str = "JetBrains Mono"
    font_size: int = 14
    theme: str = "graphite"
    # colors for the "custom" theme id; empty until the user defines one
    custom_theme: dict[str, str] = field(default_factory=dict)
    # global brand logo shown top-left (asset id, or empty for the built-in mark)
    logo: str | None = None
    # reap detached, silent sessions after this many seconds (0 disables)
    idle_timeout_s: int = 300
    # maximum simultaneously live terminals (0 disables the limit)
    max_sessions: int = 0
    # probe GitHub releases and offer one-click updates in the UI
    update_check: bool = True
    # download a found update in the background (update.py); off offers a button
    update_auto_download: bool = True
    summon_hotkey: str = "ctrl+alt+grave"
    # Root folder for the disposable scratch workspace. Empty = a QuickTerm
    # folder under the system temp directory, created on demand.
    scratch_dir: str = ""
    # The shell every new terminal starts in, and the one Claude Code and
    # Codex run inside (shells.py). Replaced `default_profile` in 4.3.
    shell: str = "powershell"
    agents: dict[str, AgentSettings] = field(default_factory=_default_agents)
    snippets: list[Snippet] = field(default_factory=_default_snippets)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    window: WindowConfig = field(default_factory=WindowConfig)
    overlay: OverlayConfig = field(default_factory=OverlayConfig)
    notifications: NotificationsConfig = field(default_factory=NotificationsConfig)
    # Hold off system sleep: "agents" while an agent works, "always", "off".
    keep_awake: str = "agents"


def default_cwd() -> str:
    """Starting folder for terminals that don't specify one.

    A frozen exe's process cwd is the install directory, a poor place to drop
    the user. Prefer the user's home directory, then fall back to the process
    cwd. A WSL terminal asks for its Linux folder itself (``wsl --cd``).
    Never let a stat error leak out of a spawn path.
    """
    try:
        home = Path.home()
    except (OSError, RuntimeError):
        return os.getcwd()
    try:
        if home.is_dir():
            return str(home)
    except OSError:
        pass
    return os.getcwd()


def scratch_root(configured: str = "") -> str:
    """Root folder for the disposable scratch workspace.

    Scratch is throwaway by design, so its terminals start in a throwaway
    folder rather than the user's home, so nothing typed there lands somewhere
    that matters by accident. The directory is created on demand and reused
    across runs; QuickTerm never deletes its contents.
    """
    text = (configured or "").strip()
    if text:
        candidate = Path(os.path.expandvars(os.path.expanduser(text)))
    else:
        candidate = Path(tempfile.gettempdir()) / "QuickTerm" / "scratch"
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        if candidate.is_dir():
            return str(candidate)
    except OSError:
        pass
    return default_cwd()


def config_dir() -> Path:
    base = os.environ.get("APPDATA")
    if not base:
        base = (
            str(Path.home() / "AppData" / "Roaming")
            if os.name == "nt"
            else os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
        )
    path = Path(base) / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.chmod(0o700)
    return path


def validate_environment(env: object) -> dict[str, str]:
    """Validate a portable, structurally safe environment override mapping."""
    if not isinstance(env, dict) or len(env) > ENV_MAX_PAIRS:
        raise ValueError(f"environment must contain at most {ENV_MAX_PAIRS} string pairs")
    seen: set[str] = set()
    total = 0
    for key, value in env.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("environment must contain string pairs")
        if not key or "=" in key or any(ord(char) < 32 for char in key):
            raise ValueError(
                "environment variable names must be non-empty and contain no '=' or control characters"
            )
        if "\0" in value:
            raise ValueError("environment variable values cannot contain NUL characters")
        if len(key) > ENV_MAX_KEY_CHARS:
            raise ValueError(
                f"environment variable names cannot exceed {ENV_MAX_KEY_CHARS} characters"
            )
        if len(value) > ENV_MAX_VALUE_CHARS:
            raise ValueError(
                f"environment variable values cannot exceed {ENV_MAX_VALUE_CHARS} characters"
            )
        folded = key.casefold()
        if folded in seen:
            raise ValueError("environment variable names must be unique ignoring case")
        seen.add(folded)
        total += len(key) + len(value) + 2
    if total > ENV_MAX_TOTAL_CHARS:
        raise ValueError(
            f"environment overrides cannot exceed {ENV_MAX_TOTAL_CHARS} characters"
        )
    return env


def protect_environment(env: dict[str, str]) -> dict[str, object]:
    """`env` as stored at rest: each value sealed with DPAPI for this user on
    Windows, plaintext elsewhere (the files there are user-private)."""
    if not secret_store.protection_available():
        return dict(env)
    return {
        key: {
            "protected": _DPAPI_SCHEME,
            "data": base64.b64encode(secret_store.protect(value.encode("utf-8"))).decode("ascii"),
        }
        for key, value in env.items()
    }


def unprotect_value(value: object) -> str:
    """One stored environment value as text. TypeError for a shape that is
    not a value, ValueError when it cannot be decrypted for this user."""
    if isinstance(value, str):
        return value
    if not isinstance(value, dict) or value.get("protected") != _DPAPI_SCHEME:
        raise TypeError("environment values must be strings or supported protected values")
    payload = value.get("data")
    if not isinstance(payload, str) or not secret_store.protection_available():
        raise ValueError("protected environment value is unavailable for this OS user")
    try:
        ciphertext = base64.b64decode(payload, validate=True)
        return secret_store.unprotect(ciphertext).decode("utf-8")
    except (OSError, ValueError, UnicodeError) as exc:
        raise ValueError("could not decrypt a protected environment value") from exc


def _decode_environment(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise TypeError("environment must be a JSON object")
    decoded = {key: unprotect_value(value) for key, value in raw.items()}
    return validate_environment(decoded)


# Key names a build before 4.0 can parse. 4.0 captures shortcuts by name
# ("minus", "left", "numpad1", ...); 3.x raised on those, moved config.json
# aside as invalid and started from the defaults. Such a binding is stored
# under a 4.0-only key, with the legacy field left empty, so a downgrade only
# loses that shortcut.
_LEGACY_MODIFIERS = frozenset({"ctrl", "control", "alt", "shift", "win"})
_LEGACY_NAMED_KEYS = frozenset(
    {"grave", "backtick", "space", "tab", "esc", "escape", "enter", "return"}
)
_LEGACY_F_KEY = re.compile(r"^f([1-9]|1[0-9]|2[0-4])$")
_SUMMON_V4 = "summon_hotkey_v4"


def legacy_binding_ok(binding: str | None) -> bool:
    """Whether a 3.x build's `parse_binding` accepts `binding` (empty counts:
    3.x treats it as no shortcut)."""
    if not binding or not binding.strip():
        return True
    tokens = [token.strip().lower() for token in binding.split("+")]
    if any(not token for token in tokens):
        return False
    *modifiers, key = tokens
    if any(token not in _LEGACY_MODIFIERS for token in modifiers) or key in _LEGACY_MODIFIERS:
        return False
    # A single printable character: 3.x maps it through the keyboard layout.
    return key in _LEGACY_NAMED_KEYS or bool(_LEGACY_F_KEY.match(key)) or len(key) == 1


def _storage_dict(cfg: AppConfig) -> dict:
    stored = dataclasses.asdict(cfg)
    if not legacy_binding_ok(stored.get("summon_hotkey")):
        stored[_SUMMON_V4] = stored["summon_hotkey"]
        stored["summon_hotkey"] = ""
    if not secret_store.protection_available():
        return stored
    for settings in stored["agents"].values():
        settings["env"] = protect_environment(settings["env"])
    return stored


def _has_plaintext_environment(raw: dict) -> bool:
    if not secret_store.protection_available():
        return False
    agents = raw.get("agents")
    return any(
        isinstance(settings, dict)
        and isinstance(settings.get("env"), dict)
        and any(isinstance(value, str) for value in settings["env"].values())
        for settings in (agents.values() if isinstance(agents, dict) else [])
    )


def _known(cls: type, data: dict) -> dict:
    names = {f.name for f in dataclasses.fields(cls)}
    return {k: v for k, v in data.items() if k in names}


def _parse(cls: type, data: dict):
    if not isinstance(data, dict):
        raise TypeError(f"{cls.__name__} must be a JSON object")
    return cls(**_known(cls, data))


SHELL_TYPES = frozenset({
    "powershell-core", "windows-powershell", "command-prompt", "cmd", "git-bash", "wsl",
    "bash", "zsh", "fish", "nushell",
})
_SHELL_PROGRAMS = frozenset({
    "pwsh", "powershell", "cmd", "bash", "zsh", "fish", "nu", "wsl", "sh",
})
_AGENT_PROGRAMS = frozenset({"claude", "claude.exe", "codex", "codex.exe"})


def _program_name(command: str) -> str:
    name = command.strip().strip('"').replace("/", "\\").rsplit("\\", 1)[-1].casefold()
    return name[:-4] if name.endswith(".exe") else name


def is_shell_profile(profile: dict) -> bool:
    """A stored profile that only starts a shell: a shell type, or no type and
    a shell program as its command (configs from before terminal types)."""
    kind = profile.get("terminal_type")
    if kind in SHELL_TYPES:
        return True
    command = profile.get("cmd")
    return kind is None and isinstance(command, str) and _program_name(command) in _SHELL_PROGRAMS


def migrate_agents(raw: dict, notes: list[str] | None = None) -> dict:
    """A pre-4.3 config with agents and shells taken out of its profiles.

    The first claude-code and the first codex profile become `agents`; every
    agent profile goes, every plain shell profile goes (the "+" menu has the
    shells), and so does a shell whose start command only runs an agent. Such
    a shell becomes the agent's settings, with the start command's arguments
    and the profile's env, when no agent profile of that kind exists.
    `default_profile` is dropped; `shell` takes its place. Pure: the stored
    env values move as they are, protected or not. `notes`, when given,
    receives one sentence per profile that went or lost something.
    """
    notes = notes if notes is not None else []
    out = {key: value for key, value in raw.items() if key != "default_profile"}
    profiles = raw.get("profiles")
    listed = [p for p in profiles if isinstance(p, dict)] if isinstance(profiles, list) else []
    agents: dict[str, dict] = {}
    for profile in listed:
        kind = profile.get("terminal_type")
        if kind in AGENT_KINDS and kind not in agents:
            mode = profile.get("agent_mode")
            if mode is None:
                mode = profile.get("claude_mode")
            agents[kind] = {
                "cmd": profile.get("cmd") or "",
                "args": profile.get("args") or [],
                "agent_mode": mode,
                "agent": profile.get("agent") or {},
                "env": profile.get("env") or {},
            }
            _note_became(notes, profile, kind)
    from_profiles = set(agents)
    kept = []
    for profile in profiles if isinstance(profiles, list) else []:
        if not isinstance(profile, dict):
            kept.append(profile)
            continue
        name = profile.get("name")
        kind = profile.get("terminal_type")
        if kind in AGENT_KINDS:
            if not any(n.startswith(f'Terminal "{name}" became') for n in notes):
                notes.append(
                    f'Terminal "{name}" was removed: only the first '
                    f"{AGENT_LABELS[kind]} terminal became its settings."
                )
            continue
        if is_shell_profile(profile):
            start = profile.get("start_command")
            if not isinstance(start, str) or not start.strip():
                notes.append(
                    f'Terminal "{name}" was removed: the shell is in the + menu'
                    + _lost_suffix(profile)
                )
                continue
            launch = _agent_start(start)
            if launch is not None:
                kind, program, words = launch
                if kind in from_profiles or kind in agents:
                    notes.append(
                        f'Terminal "{name}" was removed: {AGENT_LABELS[kind]} starts '
                        "from Settings > Agents" + _lost_suffix(profile)
                    )
                else:
                    agents[kind] = {
                        "cmd": program,
                        "args": words,
                        "agent_mode": "new",
                        "agent": {},
                        "env": profile.get("env") or {},
                    }
                    _note_became(notes, profile, kind)
                continue
        kept.append(profile)
    if isinstance(profiles, list):
        out["profiles"] = kept
    out["agents"] = agents
    return out


def _lost_suffix(profile: dict) -> str:
    lost = []
    if profile.get("keybinding"):
        lost.append(f"its shortcut {profile['keybinding']}")
    if profile.get("autostart"):
        lost.append("its autostart")
    return f" ({' and '.join(lost)} not kept)." if lost else "."


def _note_became(notes: list[str], profile: dict, kind: str) -> None:
    notes.append(
        f'Terminal "{profile.get("name")}" became the {AGENT_LABELS[kind]} settings'
        + _lost_suffix(profile)
    )


def _agent_start(start: str) -> tuple[str, str, list[str]] | None:
    """(kind, executable or "", arguments) when a start command only runs an agent."""
    try:
        words = shlex.split(start, posix=True)
    except ValueError:
        words = start.split()
    if not words:
        return None
    first = words[0]
    name = first.replace("/", "\\").rsplit("\\", 1)[-1].casefold()
    if name not in _AGENT_PROGRAMS:
        return None
    kind = "codex" if name.startswith("codex") else "claude-code"
    program = first if ("\\" in first or "/" in first) else ""
    return kind, program, words[1:]


def _parse_agents(raw: object) -> dict[str, AgentSettings]:
    if not isinstance(raw, dict):
        raise TypeError("agents must be a JSON object")
    agents = _default_agents()
    for kind in AGENT_KINDS:
        value = raw.get(kind)
        if value is None:
            continue
        if isinstance(value, AgentSettings):
            agents[kind] = value
            continue
        if not isinstance(value, dict):
            raise TypeError(f"agents.{kind} must be a JSON object")
        parsed = dict(value)
        if "env" in parsed:
            parsed["env"] = _decode_environment(parsed["env"])
        agents[kind] = _parse(AgentSettings, parsed)
    return agents


def agent_profile(cfg: AppConfig, kind: str) -> AgentProfile:
    """The agent's settings as the launch code takes them."""
    settings = cfg.agents.get(kind) or AgentSettings()
    return AgentProfile(
        name=kind,
        cmd=settings.cmd,
        terminal_type=kind,
        args=list(settings.args),
        env=dict(settings.env),
        agent_mode=settings.agent_mode,
        agent=dict(settings.agent),
    )


def ssh_destination(profile: dict) -> str | None:
    """A stored SSH profile's target as an OpenSSH destination:
    `ssh://user@host:port` when it had a port, else `[user@]host`."""
    host = profile.get("ssh_host")
    user = profile.get("ssh_user")
    port = profile.get("ssh_port")
    host = host.strip() if isinstance(host, str) else ""
    user = user.strip() if isinstance(user, str) else ""
    if not host:
        return None
    target = f"{user}@" if user else ""
    if isinstance(port, int) and not isinstance(port, bool) and 1 <= port <= 65535:
        bracketed = f"[{host}]" if ":" in host and not host.startswith("[") else host
        return f"ssh://{target}{bracketed}:{port}"
    return f"{target}{host}"


def migrate_profiles(raw: dict) -> tuple[dict, dict[str, str], dict[str, list[str]], int]:
    """A 4.4 config without its saved terminals (4.5 has none).

    Returns the config, the location each profile becomes as a workspace
    host ({profile name: destination}: an SSH destination, `wsl:<distro>`
    for a WSL terminal, "" for This PC), what of each could not be carried
    ({profile name: ["its private key", ...]}), and how many profiles went.
    Pure; the workspace files are changed by load_config.
    """
    out = {key: value for key, value in raw.items() if key != "profiles"}
    profiles = raw.get("profiles")
    listed = [p for p in profiles if isinstance(p, dict)] if isinstance(profiles, list) else []
    hosts: dict[str, str] = {}
    lost: dict[str, list[str]] = {}
    for profile in listed:
        name = profile.get("name")
        if not isinstance(name, str):
            continue
        destination = ssh_destination(profile) if profile.get("terminal_type") == "ssh" else None
        distro = profile.get("wsl_distro")
        if destination is None and profile.get("terminal_type") == "wsl" and isinstance(distro, str) and distro:
            destination = f"wsl:{distro}"
        # Any other terminal named as a workspace host leaves it on this PC.
        hosts[name] = destination or ""
        dropped = [
            label for key, label in (
                ("ssh_key", "private key"), ("ssh_proxy_jump", "ProxyJump"), ("args", "extra arguments"),
                ("env", "environment variables"), ("start_command", "start command"),
            )
            if profile.get(key)
        ]
        port = profile.get("ssh_port")
        if destination and port is not None and not (isinstance(port, int) and 1 <= port <= 65535):
            dropped.append(f"port {str(port)[:12]}")
        if dropped:
            lost[name] = dropped
    return out, hosts, lost, len(listed)


def config_from_dict(raw: dict) -> AppConfig:
    if not isinstance(raw, dict):
        raise TypeError("config must be a JSON object")
    if "agents" not in raw:
        raw = migrate_agents(raw)
    kwargs = _known(AppConfig, raw)
    kwargs["agents"] = _parse_agents(raw.get("agents"))
    if isinstance(raw.get(_SUMMON_V4), str) and raw[_SUMMON_V4]:
        kwargs["summon_hotkey"] = raw[_SUMMON_V4]
    if "snippets" in kwargs:
        if not isinstance(kwargs["snippets"], list):
            raise TypeError("snippets must be a list")
        kwargs["snippets"] = [_parse(Snippet, s) for s in kwargs["snippets"]]
    if "voice" in kwargs:
        kwargs["voice"] = _parse(VoiceConfig, kwargs["voice"])
    if "window" in kwargs:
        kwargs["window"] = _parse(WindowConfig, kwargs["window"])
    if "overlay" in kwargs:
        kwargs["overlay"] = _parse(OverlayConfig, kwargs["overlay"])
    if "notifications" in kwargs:
        kwargs["notifications"] = _parse(NotificationsConfig, kwargs["notifications"])
    return AppConfig(**kwargs)


def _validate_window(cfg: AppConfig) -> None:
    window = getattr(cfg, "window", None) or WindowConfig()
    overlay = getattr(cfg, "overlay", None) or OverlayConfig()
    for label, value, low, high in (
        ("Window width", window.width, 760, 16384),
        ("Window height", window.height, 480, 16384),
        ("Overlay width", overlay.width_pct, 30, 100),
        ("Overlay height", overlay.height_pct, 20, 100),
    ):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{label} must be an integer")
        if not low <= value <= high:
            raise ValueError(f"{label} must be between {low} and {high}")
    for label, value in (
        ("Remember window size", window.remember_bounds),
        ("Overlay mode", overlay.enabled),
        ("Overlay always on top", overlay.always_on_top),
        ("Overlay hide on blur", overlay.hide_on_blur),
        ("Overlay animation", overlay.animate),
    ):
        if not isinstance(value, bool):
            raise ValueError(f"{label} must be true or false")
    if overlay.edge not in ("top", "bottom"):
        raise ValueError("Overlay edge must be top or bottom")
    if overlay.monitor not in ("cursor", "primary"):
        raise ValueError("Overlay monitor must be cursor or primary")


def _validate_attention(cfg: AppConfig) -> None:
    notifications = getattr(cfg, "notifications", None) or NotificationsConfig()
    if not isinstance(notifications, NotificationsConfig):
        raise ValueError("Notifications must be an object")
    for label, value in (
        ("When an agent needs you", notifications.needs_you),
        ("When an agent finishes", notifications.finished),
    ):
        if value not in NOTIFY_MODES:
            raise ValueError(f"{label} must be off, flash or notify")
    if not isinstance(notifications.sound, bool):
        raise ValueError("Notification sound must be true or false")
    if getattr(cfg, "keep_awake", "agents") not in ("agents", "always", "off"):
        raise ValueError("Keep awake must be agents, always or off")


def _validate_agents(cfg: AppConfig) -> None:
    from .agents import validate as validate_agent

    if not isinstance(cfg.agents, dict) or set(cfg.agents) != set(AGENT_KINDS):
        raise ValueError("agents must hold claude-code and codex")
    for kind in AGENT_KINDS:
        settings = cfg.agents[kind]
        label = AGENT_LABELS[kind]
        if not isinstance(settings, AgentSettings):
            raise ValueError(f"{label}: settings must be an object")
        if not isinstance(settings.cmd, str):
            raise ValueError(f"{label}: command must be a string")
        if not isinstance(settings.args, list) or any(not isinstance(a, str) for a in settings.args):
            raise ValueError(f"{label}: arguments must be strings")
        if settings.agent_mode is not None and not isinstance(settings.agent_mode, str):
            raise ValueError(f"{label}: launch mode must be a string")
        if not isinstance(settings.agent, dict):
            raise ValueError(f"{label}: agent options must be an object")
        try:
            validate_agent(agent_profile(cfg, kind))
            validate_environment(settings.env)
        except ValueError as exc:
            raise ValueError(f"{label}: {exc}") from exc


def validate_config(cfg: AppConfig) -> None:
    from .hotkeys import parse_binding

    if cfg.host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Host must be loopback (127.0.0.1, localhost, or ::1)")
    for label, value in (
        ("Port", cfg.port),
        ("Scrollback", cfg.scrollback_bytes),
        ("Font size", cfg.font_size),
        ("Idle timeout", cfg.idle_timeout_s),
        ("Terminal limit", cfg.max_sessions),
    ):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{label} must be an integer")
    if not 1 <= cfg.port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    if not 64 * 1024 <= cfg.scrollback_bytes <= 64 * 1024 * 1024:
        raise ValueError("Scrollback must be between 64 KiB and 64 MiB")
    if not 9 <= cfg.font_size <= 30:
        raise ValueError("Font size must be between 9 and 30")
    if cfg.idle_timeout_s < 0:
        raise ValueError("Idle timeout cannot be negative")
    if not 0 <= cfg.max_sessions <= 100:
        raise ValueError("Terminal limit must be between 0 and 100")
    if not isinstance(cfg.theme, str) or not cfg.theme.strip():
        raise ValueError("Theme must be a non-empty string")
    if not isinstance(cfg.font_family, str) or not cfg.font_family.strip():
        raise ValueError("Font family must be a non-empty string")
    if cfg.logo is not None and not isinstance(cfg.logo, str):
        raise ValueError("Logo must be a string or null")
    from .shells import validate as validate_shell

    validate_shell(cfg.shell)
    _validate_agents(cfg)
    if not isinstance(cfg.scratch_dir, str):
        raise ValueError("Scratch folder must be a string")
    if cfg.scratch_dir.strip():
        scratch = Path(os.path.expandvars(os.path.expanduser(cfg.scratch_dir.strip())))
        if scratch.exists() and not scratch.is_dir():
            raise ValueError(f"Scratch folder is not a folder: {cfg.scratch_dir}")
    if not isinstance(cfg.update_check, bool):
        raise ValueError("Update check must be true or false")
    if not isinstance(cfg.update_auto_download, bool):
        raise ValueError("Automatic update download must be true or false")
    _validate_attention(cfg)
    if not isinstance(cfg.custom_theme, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in cfg.custom_theme.items()
    ):
        raise ValueError("Custom theme must contain string color values")
    if not isinstance(cfg.summon_hotkey, str):
        raise ValueError("Summon hotkey must be a string")
    if cfg.summon_hotkey.strip():
        parse_binding(cfg.summon_hotkey)
    _validate_window(cfg)
    if not isinstance(cfg.snippets, list):
        raise ValueError("Snippets must be a list")
    snippet_names: set[str] = set()
    for snippet in cfg.snippets:
        name = snippet.name.strip() if isinstance(snippet.name, str) else ""
        if not name or not isinstance(snippet.text, str) or not snippet.text.strip():
            raise ValueError("Every snippet needs a name and command")
        if not isinstance(snippet.description, str):
            raise ValueError(f'Snippet "{name}": description must be a string')
        folded = name.casefold()
        if folded in snippet_names:
            raise ValueError("Snippet names must be unique")
        snippet_names.add(folded)


def _global_bindings(cfg: AppConfig) -> list[tuple[str, str]]:
    rows = [("Summon shortcut", cfg.summon_hotkey)]
    return [(label, binding) for label, binding in rows if isinstance(binding, str) and binding.strip()]


def validate_new_bindings(cfg: AppConfig, previous: AppConfig | None = None) -> None:
    """Refuse a new global binding without Ctrl, Alt or Win.

    RegisterHotKey on a plain key (Enter, F5, a letter) takes that key from
    every program on the desktop. Settings only records pressed keys, and the
    capture commits any plain key at once. 3.x took free text, so a binding
    already in `previous` stays accepted: load_config must never discard a
    config over it, and saving an unrelated setting must still work.
    """
    from .hotkeys import MOD_ALT, MOD_CONTROL, MOD_WIN, parse_binding

    kept: set[tuple[int, int]] = set()
    for _label, binding in _global_bindings(previous) if previous is not None else []:
        try:
            kept.add(parse_binding(binding))
        except ValueError:
            continue
    for label, binding in _global_bindings(cfg):
        parsed = parse_binding(binding)
        if parsed[0] & (MOD_CONTROL | MOD_ALT | MOD_WIN) or parsed in kept:
            continue
        raise ValueError(f"{label} needs Ctrl, Alt or Win")


PRE_43_BACKUP = "config.pre-4.3.json"
PRE_45_BACKUP = "config.pre-4.5.json"
# What a migration dropped, kept for the backend: on Windows the launcher
# process loads (and migrates) the config before the backend starts, and
# neither has logging set up yet when it does.
MIGRATION_NOTES = "migration-notice.txt"
MIGRATION_PREFIX_43 = "Settings moved to QuickTerm 4.3: "
MIGRATION_PREFIX_45 = "Saved terminals were removed in QuickTerm 4.5: "


def take_migration_notice() -> str | None:
    """The migration's notes, once: the file is deleted as it is read.

    Best effort; a file that cannot be read or deleted says nothing.
    """
    path = config_dir() / MIGRATION_NOTES
    try:
        text = read_text(path).strip()
        path.unlink()
    except (OSError, UnicodeError):
        return None
    return " ".join(text.split("\n")) if text else None


def _workspace_files() -> list[Path]:
    """Every stored workspace file, the elevated instance's included."""
    folder = config_dir() / "workspaces"
    try:
        return sorted([*folder.glob("*.json"), *folder.glob("*/*.json")])
    except OSError:
        return []


def _retarget_workspaces(hosts: dict[str, str], lost: dict[str, list[str]]) -> list[str]:
    """Point every workspace whose host named an SSH profile at that profile's
    destination. Returns one sentence per such host that lost something or
    could not be carried. Best effort per file."""
    from .workspace import normalize_host

    used: dict[str, str] = {}
    refused: dict[str, str] = {}
    for path in _workspace_files():
        try:
            document = json.loads(read_text(path))
        except (OSError, UnicodeError, ValueError):
            continue
        name = document.get("host") if isinstance(document, dict) else None
        if not isinstance(name, str) or name not in hosts:
            continue
        try:
            destination = normalize_host(hosts[name]) if hosts[name] else None
        except ValueError as exc:
            refused[name] = str(exc)
            continue
        document["host"] = destination
        try:
            _atomic_write(path, json.dumps(document, indent=2))
        except OSError:
            continue
        used[name] = hosts[name]
    notes = []
    for name, destination in used.items():
        if not destination:
            notes.append(f'Workspaces on "{name}" were not on an SSH host or in WSL and now open on this PC.')
        elif name in lost:
            where = "now open in" if destination.startswith("wsl:") else "now connect to"
            fix = (
                "set them in Workspace settings" if destination.startswith("wsl:")
                else "put them in ~/.ssh/config or Workspace settings"
            )
            notes.append(
                f'Workspaces on "{name}" {where} {destination}; its '
                f"{', '.join(lost[name])} could not be kept, so {fix}."
            )
    for name, reason in refused.items():
        notes.append(f'Workspaces on "{name}" could not keep their host ({reason}).')
    return notes


def load_config() -> AppConfig:
    path = config_dir() / "config.json"
    if not path.exists():
        cfg = AppConfig()
        save_config(cfg)
        return cfg
    try:
        raw = json.loads(read_text(path))
        migrating_agents = isinstance(raw, dict) and "agents" not in raw
        notes_43: list[str] = []
        if migrating_agents:
            raw = migrate_agents(raw, notes_43)
        migrating_profiles = isinstance(raw, dict) and "profiles" in raw
        if migrating_profiles:
            raw, hosts, lost, removed = migrate_profiles(raw)
        cfg = config_from_dict(raw)
        validate_config(cfg)
        if migrating_agents or migrating_profiles:
            # 4.3 moved agents out of the profiles, 4.5 drops the profiles.
            # The file as it was stays next to the new one, written before
            # the first save that changes it.
            original = read_text(path)
            for wanted, name in ((migrating_agents, PRE_43_BACKUP), (migrating_profiles, PRE_45_BACKUP)):
                backup = path.with_name(name)
                if wanted and not backup.exists():
                    _atomic_write(backup, original)
            notes = [MIGRATION_PREFIX_43 + " ".join(notes_43)] if notes_43 else []
            if migrating_profiles:
                notes_45 = _retarget_workspaces(hosts, lost)
                if removed:
                    notes_45.append(f"{removed} saved terminal(s) are kept in {PRE_45_BACKUP} only.")
                if notes_45:
                    notes.append(MIGRATION_PREFIX_45 + " ".join(notes_45))
            save_config(cfg)
            if notes:
                try:
                    _atomic_write(path.with_name(MIGRATION_NOTES), "\n".join(notes) + "\n")
                except OSError:
                    pass  # the notice is an extra; the migrated config is saved
            return cfg
        if _has_plaintext_environment(raw):
            try:
                save_config(cfg)
            except OSError:
                pass  # keep a valid legacy config usable if DPAPI is unavailable
        return cfg
    except (OSError, json.JSONDecodeError, TypeError, ValueError, AttributeError):
        # Keep the exact broken file recoverable instead of trapping the app in
        # a startup crash loop or silently overwriting the user's settings.
        backup = path.with_name(f"config.invalid-{time.time_ns()}.json")
        replace_file(path, backup)
        cfg = AppConfig()
        save_config(cfg)
        return cfg


def save_config(cfg: AppConfig) -> None:
    validate_config(cfg)
    path = config_dir() / "config.json"
    text = json.dumps(_storage_dict(cfg), indent=2)
    replaced = _keep_previous(path, text, cfg)
    _atomic_write(path, text)
    if replaced is not None:
        _record_history(*replaced)


def _keep_previous(path: Path, text: str, cfg: AppConfig) -> tuple[str, int] | None:
    """Copy the config about to be replaced to config.prev.json, best effort.

    A PUT that drops fields (an older or buggy client) replaced every saved
    setting and snippet with nothing to go back to. The copy is the stored
    file as it was, so DPAPI-protected values stay protected in it. A save
    that changes nothing leaves the backup alone, or saving twice would erase
    the only older state. "Nothing" is decided on the decrypted settings:
    DPAPI output differs on every call, so with any agent secret the file
    text never repeats.

    Returns ``(previous file text, its mtime in ns)`` when the replaced
    version belongs in the settings history, which save_config records once
    the new file is in place. The same rules decide both copies; the history
    also skips a file that does not parse, since it could never be restored.
    """
    try:
        saved_ns = path.stat().st_mtime_ns
        previous = read_text(path)
    except (OSError, UnicodeError):
        return None
    if previous == text:
        return None
    parsed = True
    try:
        raw = json.loads(previous)
        legacy_plaintext = _has_plaintext_environment(raw)
        unchanged = config_from_dict(raw) == cfg
    except (ValueError, TypeError, AttributeError, OSError):
        # Unparseable or undecryptable: nothing in it can be compared, and
        # nothing in it is plaintext this save would be encrypting either.
        legacy_plaintext = unchanged = parsed = False
    if unchanged:
        return None
    if legacy_plaintext:
        # This save is the one that encrypts a legacy config's secrets; a copy
        # of the old file would keep them on disk in the clear.
        return None
    try:
        _atomic_write(path.with_name("config.prev.json"), previous)
    except OSError:
        pass  # a backup must never be the reason a save fails
    return (previous, saved_ns) if parsed else None


# The settings history: the versions a save replaced, newest last by id. Each
# file is the stored config.json text as it was, so DPAPI-protected values
# stay protected; its mtime is when that version was saved.
HISTORY_KEEP = 20
_HISTORY_ID = re.compile(r"^\d{20}$")


def history_dir() -> Path:
    return config_dir() / "history"


def _record_history(previous: str, saved_ns: int) -> None:
    """Add one replaced version and drop all but the newest HISTORY_KEEP.

    Best effort, like config.prev.json: the new config is already saved.
    """
    try:
        folder = history_dir()
        folder.mkdir(exist_ok=True)
        if os.name != "nt":
            folder.chmod(0o700)
        entry_id = f"{time.time_ns():020d}"
        target = folder / f"{entry_id}.json"
        while target.exists():  # two saves within one clock tick
            entry_id = f"{int(entry_id) + 1:020d}"
            target = folder / f"{entry_id}.json"
        _atomic_write(target, previous)
        os.utime(target, ns=(saved_ns, saved_ns))
        for old in _history_ids()[HISTORY_KEEP:]:
            (folder / f"{old}.json").unlink(missing_ok=True)
    except OSError:
        pass


def _history_ids() -> list[str]:
    """Entry ids, newest first."""
    try:
        names = [p.stem for p in history_dir().glob("*.json")]
    except OSError:
        return []
    return sorted((name for name in names if _HISTORY_ID.match(name)), reverse=True)


def _comparable(text: str) -> dict:
    """A stored config as plain values for comparison: decrypted when
    possible, else the raw JSON (every protected value then differs)."""
    raw = json.loads(text)
    try:
        return dataclasses.asdict(config_from_dict(raw))
    except (ValueError, TypeError, AttributeError, OSError):
        return raw if isinstance(raw, dict) else {}


def _changed_settings(older: dict, newer: dict) -> str:
    order = [f.name for f in dataclasses.fields(AppConfig)]
    names = [name for name in order if older.get(name) != newer.get(name)]
    return ", ".join(names)


def config_history() -> list[dict]:
    """``[{id, saved_at, summary}]``, newest first.

    ``summary`` names the top-level settings in which that version differs
    from the next newer one (the current config for the newest entry): what
    restoring it would change. ``saved_at`` is UTC, ISO 8601 with a Z.
    """
    folder = history_dir()
    try:
        newer = _comparable(read_text(config_dir() / "config.json"))
    except (OSError, UnicodeError, ValueError):
        newer = {}
    entries = []
    for entry_id in _history_ids():
        path = folder / f"{entry_id}.json"
        try:
            saved_ns = path.stat().st_mtime_ns
            values = _comparable(read_text(path))
        except (OSError, UnicodeError, ValueError):
            continue
        saved_at = datetime.fromtimestamp(saved_ns / 1e9, tz=timezone.utc)
        entries.append({
            "id": entry_id,
            "saved_at": saved_at.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "summary": _changed_settings(values, newer),
        })
        newer = values
    return entries


def load_history_entry(entry_id: str) -> dict:
    """The stored config of one history entry, as saved (protected values
    still protected). KeyError for an id that is malformed or not there."""
    if not isinstance(entry_id, str) or not _HISTORY_ID.match(entry_id):
        raise KeyError(entry_id)
    path = history_dir() / f"{entry_id}.json"
    try:
        raw = json.loads(read_text(path))
    except FileNotFoundError:
        raise KeyError(entry_id) from None
    if not isinstance(raw, dict):
        raise ValueError("history entry is not a JSON object")
    return raw


# Windows refuses to replace or open a file while another handle on it lacks
# FILE_SHARE_DELETE, which Python's own open() never passes. A reader and an
# atomic writer of the same file therefore collide for a few milliseconds; a
# short retry absorbs that instead of failing an autosave or a Settings save.
# A module flag rather than an os.name check at the call, so tests can
# exercise the retry on every platform.
_RETRY_SHARING_VIOLATIONS = os.name == "nt"
_RETRY_ATTEMPTS = 5
_RETRY_DELAY_S = 0.02


def _retrying(action: Callable[[], _T]) -> _T:
    attempt = 1
    while True:
        try:
            return action()
        except PermissionError:
            if not _RETRY_SHARING_VIOLATIONS or attempt >= _RETRY_ATTEMPTS:
                raise
        attempt += 1
        time.sleep(_RETRY_DELAY_S)


def replace_file(source: str | Path, target: Path) -> None:
    """os.replace that rides out a concurrent reader on Windows."""
    _retrying(lambda: os.replace(source, target))


def read_text(path: Path) -> str:
    """UTF-8 read that rides out a concurrent atomic replace on Windows."""
    return _retrying(lambda: path.read_text(encoding="utf-8"))


def _atomic_write(path: Path, text: str) -> None:
    """Replace a JSON file only after the complete new value is durable."""
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            if os.name != "nt":
                os.fchmod(handle.fileno(), 0o600)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        replace_file(temp_name, path)
        if os.name != "nt":
            path.chmod(0o600)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
