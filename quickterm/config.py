"""App config: dataclasses + JSON persistence under %APPDATA%/quickterm."""

from __future__ import annotations

import dataclasses
import json
import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Profile:
    name: str
    cmd: str
    args: list[str] = field(default_factory=list)
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    keybinding: str | None = None
    autostart: bool = False
    terminal_type: str | None = None
    wsl_distro: str | None = None
    start_command: str | None = None
    # Only terminals from a profile with mcp_access carry the QuickTerm discovery
    # env (incl. the auth token), so an AI client (quickterm-mcp) works there.
    # Off by default: the token is not sprayed into every shell you open.
    mcp_access: bool = False


@dataclass
class Snippet:
    name: str
    text: str


@dataclass
class VoiceConfig:
    enabled: bool = True
    model_size: str = "small"
    hotkey: str = "ctrl+alt+v"
    language: str | None = None


@dataclass
class McpConfig:
    """Controls the quickterm-mcp bridge (see quickterm/mcp_server.py).

    `enabled` injects discovery env (QUICKTERM_PORT/TOKEN/SESSION_ID/WORKSPACE)
    into every spawned terminal so an MCP client launched inside a pane finds
    the backend with no configuration; turning it off keeps the token out of
    child environments. `allow_input` gates the write path (typing into a
    terminal from an AI client); reads are always allowed to token holders.
    """

    enabled: bool = True
    allow_input: bool = True
    max_input_bytes: int = 4096
    # Convenience escape hatch: inject discovery env into EVERY terminal, not
    # just profiles with mcp_access. Less safe; off by default.
    inject_all: bool = False


def _default_profiles() -> list[Profile]:
    # Personal profiles are user-created only; system shells (PowerShell, cmd,
    # WSL, bash, ...) are detected live and offered by the launcher instead.
    return []


def _default_snippets() -> list[Snippet]:
    return [
        Snippet(name="git status", text="git status\r"),
        Snippet(name="uv run pytest", text="uv run pytest\r"),
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
    # probe GitHub releases and offer one-click updates in the UI
    update_check: bool = True
    summon_hotkey: str = "ctrl+alt+grave"
    default_profile: str = ""  # empty = first profile, else first system shell
    profiles: list[Profile] = field(default_factory=_default_profiles)
    snippets: list[Snippet] = field(default_factory=_default_snippets)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    mcp: McpConfig = field(default_factory=McpConfig)


def default_cwd() -> str:
    """Starting folder for terminals that don't specify one.

    A frozen exe's process cwd is the install directory — a poor place to drop
    the user. Prefer the Desktop, then the home directory, then fall back to the
    process cwd. Never let a stat error leak out of a spawn path.
    """
    try:
        home = Path.home()
    except (OSError, RuntimeError):
        return os.getcwd()
    for candidate in (home / "Desktop", home):
        try:
            if candidate.is_dir():
                return str(candidate)
        except OSError:
            continue
    return os.getcwd()


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
    return path


def _known(cls: type, data: dict) -> dict:
    names = {f.name for f in dataclasses.fields(cls)}
    return {k: v for k, v in data.items() if k in names}


def _parse(cls: type, data: dict):
    return cls(**_known(cls, data))


def config_from_dict(raw: dict) -> AppConfig:
    kwargs = _known(AppConfig, raw)
    if "profiles" in kwargs:
        kwargs["profiles"] = [_parse(Profile, p) for p in kwargs["profiles"]]
    if "snippets" in kwargs:
        kwargs["snippets"] = [_parse(Snippet, s) for s in kwargs["snippets"]]
    if "voice" in kwargs:
        kwargs["voice"] = _parse(VoiceConfig, kwargs["voice"])
    if "mcp" in kwargs:
        kwargs["mcp"] = _parse(McpConfig, kwargs["mcp"])
    return AppConfig(**kwargs)


def validate_config(cfg: AppConfig) -> None:
    for profile in cfg.profiles:
        cwd = (profile.cwd or "").strip()
        if not cwd or profile.terminal_type == "wsl":
            continue
        resolved = Path(os.path.expandvars(os.path.expanduser(cwd)))
        if not resolved.is_dir():
            name = profile.name.strip() or "Untitled terminal"
            raise ValueError(
                f'Terminal profile "{name}": starting folder does not exist: {cwd}'
            )


def load_config() -> AppConfig:
    path = config_dir() / "config.json"
    if not path.exists():
        cfg = AppConfig()
        save_config(cfg)
        return cfg
    return config_from_dict(json.loads(path.read_text(encoding="utf-8")))


def save_config(cfg: AppConfig) -> None:
    validate_config(cfg)
    path = config_dir() / "config.json"
    path.write_text(
        json.dumps(dataclasses.asdict(cfg), indent=2), encoding="utf-8"
    )
