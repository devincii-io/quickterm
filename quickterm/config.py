"""App config: dataclasses + JSON persistence under %APPDATA%/quickterm."""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import secret_store


ENV_MAX_PAIRS = 256
ENV_MAX_KEY_CHARS = 1024
ENV_MAX_VALUE_CHARS = 64 * 1024
ENV_MAX_TOTAL_CHARS = 256 * 1024
_DPAPI_SCHEME = "dpapi-v1"


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
    # maximum simultaneously live terminals (0 disables the limit)
    max_sessions: int = 0
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
    the user. Prefer the user's home directory, then fall back to the process
    cwd. WSL profiles separately request their Linux home via ``wsl --cd ~``.
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


def _decode_environment(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise TypeError("environment must be a JSON object")
    decoded: dict[str, str] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            decoded[key] = value
            continue
        if not isinstance(value, dict) or value.get("protected") != _DPAPI_SCHEME:
            raise TypeError("environment values must be strings or supported protected values")
        payload = value.get("data")
        if not isinstance(payload, str) or not secret_store.protection_available():
            raise ValueError("protected environment value is unavailable for this OS user")
        try:
            ciphertext = base64.b64decode(payload, validate=True)
            decoded[key] = secret_store.unprotect(ciphertext).decode("utf-8")
        except (OSError, ValueError, UnicodeError) as exc:
            raise ValueError("could not decrypt a protected environment value") from exc
    return validate_environment(decoded)


def _storage_dict(cfg: AppConfig) -> dict:
    stored = dataclasses.asdict(cfg)
    if not secret_store.protection_available():
        return stored
    for profile in stored["profiles"]:
        profile["env"] = {
            key: {
                "protected": _DPAPI_SCHEME,
                "data": base64.b64encode(secret_store.protect(value.encode("utf-8"))).decode(
                    "ascii"
                ),
            }
            for key, value in profile["env"].items()
        }
    return stored


def _has_plaintext_environment(raw: dict) -> bool:
    if not secret_store.protection_available():
        return False
    profiles = raw.get("profiles")
    if not isinstance(profiles, list):
        return False
    return any(
        isinstance(profile, dict)
        and isinstance(profile.get("env"), dict)
        and any(isinstance(value, str) for value in profile["env"].values())
        for profile in profiles
    )


def _known(cls: type, data: dict) -> dict:
    names = {f.name for f in dataclasses.fields(cls)}
    return {k: v for k, v in data.items() if k in names}


def _parse(cls: type, data: dict):
    if not isinstance(data, dict):
        raise TypeError(f"{cls.__name__} must be a JSON object")
    return cls(**_known(cls, data))


def config_from_dict(raw: dict) -> AppConfig:
    if not isinstance(raw, dict):
        raise TypeError("config must be a JSON object")
    kwargs = _known(AppConfig, raw)
    if "profiles" in kwargs:
        if not isinstance(kwargs["profiles"], list):
            raise TypeError("profiles must be a list")
        profiles = []
        for profile in kwargs["profiles"]:
            if not isinstance(profile, dict):
                raise TypeError("Profile must be a JSON object")
            parsed = dict(profile)
            if "env" in parsed:
                parsed["env"] = _decode_environment(parsed["env"])
            profiles.append(_parse(Profile, parsed))
        kwargs["profiles"] = profiles
    if "snippets" in kwargs:
        if not isinstance(kwargs["snippets"], list):
            raise TypeError("snippets must be a list")
        kwargs["snippets"] = [_parse(Snippet, s) for s in kwargs["snippets"]]
    if "voice" in kwargs:
        kwargs["voice"] = _parse(VoiceConfig, kwargs["voice"])
    return AppConfig(**kwargs)


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
    if not isinstance(cfg.custom_theme, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in cfg.custom_theme.items()
    ):
        raise ValueError("Custom theme must contain string color values")
    if not isinstance(cfg.profiles, list):
        raise ValueError("Profiles must be a list")
    if not isinstance(cfg.summon_hotkey, str):
        raise ValueError("Summon hotkey must be a string")
    hotkey_owners: dict[tuple[int, int], str] = {}
    if cfg.summon_hotkey.strip():
        hotkey_owners[parse_binding(cfg.summon_hotkey)] = "QuickTerm summon shortcut"
    profile_names: set[str] = set()
    for profile in cfg.profiles:
        name = profile.name.strip() if isinstance(profile.name, str) else ""
        if not name:
            raise ValueError("Every terminal profile needs a name")
        folded = name.casefold()
        if folded in profile_names:
            raise ValueError("Terminal profile names must be unique")
        profile_names.add(folded)
        if not isinstance(profile.cmd, str):
            raise ValueError(f'Terminal profile "{name}": command must be a string')
        if profile.terminal_type == "custom" and not profile.cmd.strip():
            raise ValueError(f'Terminal profile "{name}": executable is required')
        if not isinstance(profile.args, list) or any(not isinstance(arg, str) for arg in profile.args):
            raise ValueError(f'Terminal profile "{name}": arguments must be strings')
        try:
            validate_environment(profile.env)
        except ValueError as exc:
            raise ValueError(f'Terminal profile "{name}": {exc}') from exc
        if profile.cwd is not None and not isinstance(profile.cwd, str):
            raise ValueError(f'Terminal profile "{name}": starting folder must be a string')
        if profile.keybinding:
            if not isinstance(profile.keybinding, str):
                raise ValueError(f'Terminal profile "{name}": shortcut must be a string')
            parsed = parse_binding(profile.keybinding)
            if parsed in hotkey_owners:
                raise ValueError(
                    f'Terminal profile "{name}": shortcut conflicts with {hotkey_owners[parsed]}'
                )
            hotkey_owners[parsed] = f'terminal profile "{name}"'
        cwd = (profile.cwd or "").strip()
        if not cwd or profile.terminal_type == "wsl":
            continue
        resolved = Path(os.path.expandvars(os.path.expanduser(cwd)))
        if not resolved.is_dir():
            name = profile.name.strip() or "Untitled terminal"
            raise ValueError(
                f'Terminal profile "{name}": starting folder does not exist: {cwd}'
            )
    if not isinstance(cfg.snippets, list):
        raise ValueError("Snippets must be a list")
    snippet_names: set[str] = set()
    for snippet in cfg.snippets:
        name = snippet.name.strip() if isinstance(snippet.name, str) else ""
        if not name or not isinstance(snippet.text, str) or not snippet.text.strip():
            raise ValueError("Every snippet needs a name and command")
        folded = name.casefold()
        if folded in snippet_names:
            raise ValueError("Snippet names must be unique")
        snippet_names.add(folded)


def load_config() -> AppConfig:
    path = config_dir() / "config.json"
    if not path.exists():
        cfg = AppConfig()
        save_config(cfg)
        return cfg
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        cfg = config_from_dict(raw)
        validate_config(cfg)
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
        os.replace(path, backup)
        cfg = AppConfig()
        save_config(cfg)
        return cfg


def save_config(cfg: AppConfig) -> None:
    validate_config(cfg)
    path = config_dir() / "config.json"
    _atomic_write(path, json.dumps(_storage_dict(cfg), indent=2))


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
        os.replace(temp_name, path)
        if os.name != "nt":
            path.chmod(0o600)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
