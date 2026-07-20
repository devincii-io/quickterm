"""App config: dataclasses + JSON persistence under %APPDATA%/quickterm."""

from __future__ import annotations

import dataclasses
import json
import os
import tempfile
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
    return AppConfig(**kwargs)


def validate_config(cfg: AppConfig) -> None:
    if not 1 <= cfg.port <= 65535:
        raise ValueError("Port must be between 1 and 65535")
    if not 64 * 1024 <= cfg.scrollback_bytes <= 64 * 1024 * 1024:
        raise ValueError("Scrollback must be between 64 KiB and 64 MiB")
    if not 8 <= cfg.font_size <= 32:
        raise ValueError("Font size must be between 8 and 32")
    if cfg.idle_timeout_s < 0:
        raise ValueError("Idle timeout cannot be negative")
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
    _atomic_write(path, json.dumps(dataclasses.asdict(cfg), indent=2))


def _atomic_write(path: Path, text: str) -> None:
    """Replace a JSON file only after the complete new value is durable."""
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
