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
    return [
        Profile(
            name="powershell",
            cmd="powershell.exe",
            args=["-NoLogo"],
            terminal_type="windows-powershell",
        ),
        Profile(name="cmd", cmd="cmd.exe", terminal_type="command-prompt"),
    ]


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
    summon_hotkey: str = "ctrl+alt+grave"
    default_profile: str = "powershell"
    profiles: list[Profile] = field(default_factory=_default_profiles)
    snippets: list[Snippet] = field(default_factory=_default_snippets)
    voice: VoiceConfig = field(default_factory=VoiceConfig)


def config_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
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


def load_config() -> AppConfig:
    path = config_dir() / "config.json"
    if not path.exists():
        cfg = AppConfig()
        save_config(cfg)
        return cfg
    return config_from_dict(json.loads(path.read_text(encoding="utf-8")))


def save_config(cfg: AppConfig) -> None:
    path = config_dir() / "config.json"
    path.write_text(
        json.dumps(dataclasses.asdict(cfg), indent=2), encoding="utf-8"
    )
