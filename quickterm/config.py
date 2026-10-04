"""App config: dataclasses + JSON persistence under %APPDATA%/quickterm."""

from __future__ import annotations

import base64
import dataclasses
import json
import os
import re
import tempfile
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
class Profile:
    name: str
    cmd: str
    # One line saying what this terminal is for. Every configurable thing
    # carries its own explanation, so a list of profiles reads as documentation
    # of the setup rather than a column of bare names. Optional and defaulted,
    # because a config written by an older build has no such key and `_known()`
    # only drops unknown fields; a field the older file lacks must fill itself in.
    description: str = ""
    args: list[str] = field(default_factory=list)
    # No folder of any kind. A workspace IS a folder and it is the only thing
    # that places a terminal, so a profile is portable across every project.
    # `cwd` and `subpath` used to live here; `_known()` drops both from older
    # configs on load, and the next save writes them out for good.
    env: dict[str, str] = field(default_factory=dict)
    keybinding: str | None = None
    autostart: bool = False
    terminal_type: str | None = None
    wsl_distro: str | None = None
    start_command: str | None = None
    # Launch mode of an agent profile (claude-code, codex). Configs before 4.0
    # call it `claude_mode`; config_from_dict carries that over.
    agent_mode: str | None = None
    agent: dict[str, str] = field(default_factory=dict)
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    ssh_key: str | None = None
    # None means PuTTY, so every profile saved before 4.0 keeps its client.
    ssh_client: str | None = None
    ssh_proxy_jump: str | None = None
    connection: dict[str, str] = field(default_factory=dict)


@dataclass
class Snippet:
    name: str
    text: str
    # What the command does and when to reach for it. The keystrokes alone do
    # not say it: "git status" repeats the name and answers nothing about why
    # this one is kept. Defaulted for the same reason as `Profile.description`:
    # older config files simply do not have the key.
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


def _default_profiles() -> list[Profile]:
    # Discovery feeds setup; the launcher exposes saved configurations only.
    return []


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
    summon_hotkey: str = "ctrl+alt+grave"
    # Root folder for the disposable scratch workspace. Empty = a QuickTerm
    # folder under the system temp directory, created on demand.
    scratch_dir: str = ""
    # Saved profile name. Legacy shell IDs remain readable for older clients.
    default_profile: str = ""
    profiles: list[Profile] = field(default_factory=_default_profiles)
    snippets: list[Snippet] = field(default_factory=_default_snippets)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    window: WindowConfig = field(default_factory=WindowConfig)
    overlay: OverlayConfig = field(default_factory=OverlayConfig)


def default_cwd() -> str:
    """Starting folder for terminals that don't specify one.

    A frozen exe's process cwd is the install directory, a poor place to drop
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
_KEYBINDING_V4 = "keybinding_v4"


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
    for profile in stored["profiles"]:
        # A build before 4.0 reads only `claude_mode`; without it a downgrade
        # silently turns every Claude profile into "continue".
        if profile.get("terminal_type") == "claude-code":
            profile["claude_mode"] = profile.get("agent_mode")
        if not legacy_binding_ok(profile.get("keybinding")):
            profile[_KEYBINDING_V4] = profile["keybinding"]
            profile["keybinding"] = None
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
    if isinstance(raw.get(_SUMMON_V4), str) and raw[_SUMMON_V4]:
        kwargs["summon_hotkey"] = raw[_SUMMON_V4]
    if "profiles" in kwargs:
        if not isinstance(kwargs["profiles"], list):
            raise TypeError("profiles must be a list")
        profiles = []
        for profile in kwargs["profiles"]:
            if not isinstance(profile, dict):
                raise TypeError("Profile must be a JSON object")
            parsed = dict(profile)
            if parsed.get("agent_mode") is None and parsed.get("claude_mode") is not None:
                parsed["agent_mode"] = parsed["claude_mode"]
            if isinstance(parsed.get(_KEYBINDING_V4), str) and parsed[_KEYBINDING_V4]:
                parsed["keybinding"] = parsed[_KEYBINDING_V4]
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
    if "window" in kwargs:
        kwargs["window"] = _parse(WindowConfig, kwargs["window"])
    if "overlay" in kwargs:
        kwargs["overlay"] = _parse(OverlayConfig, kwargs["overlay"])
    return AppConfig(**kwargs)


_SSH_UNSAFE = re.compile(r"[\s\x00-\x1f\x7f]")
_PROXY_JUMP = re.compile(r"^[A-Za-z0-9._@:,\[\]%-]+$")


def _validate_ssh(profile: Profile) -> None:
    """Host, user and jump reach ssh as arguments, so none may pass as an option."""
    if not isinstance(profile.ssh_host, str) or not profile.ssh_host.strip():
        raise ValueError("host is required")
    if profile.ssh_port is not None and (
        isinstance(profile.ssh_port, bool)
        or not isinstance(profile.ssh_port, int)
        or not 1 <= profile.ssh_port <= 65535
    ):
        raise ValueError("port must be between 1 and 65535")
    for field_label, value in (("username", profile.ssh_user), ("private key", profile.ssh_key)):
        if value is not None and not isinstance(value, str):
            raise ValueError(f"{field_label} must be a string")
    if profile.ssh_client not in (None, "openssh", "putty"):
        raise ValueError("SSH client must be openssh or putty")
    openssh = profile.ssh_client == "openssh"
    for field_label, value in (("host", profile.ssh_host), ("username", profile.ssh_user)):
        text = (value or "").strip()
        if text.startswith("-"):
            raise ValueError(f"{field_label} must not start with -")
        # plink takes a saved-session name as its host and Windows account
        # names may hold a space, so PuTTY profiles from 3.x keep loading.
        # OpenSSH profiles are new in 4.0 and get the strict rule.
        if openssh and _SSH_UNSAFE.search(text):
            raise ValueError(f"{field_label} must not contain spaces or control characters")
    jump = (profile.ssh_proxy_jump or "").strip()
    if jump:
        if jump.startswith("-") or not _PROXY_JUMP.fullmatch(jump):
            raise ValueError("ProxyJump must be [user@]host[:port], comma separated")
        if not openssh:
            raise ValueError("ProxyJump needs the OpenSSH client")
    if openssh and (profile.ssh_key or "").strip().lower().endswith(".ppk"):
        raise ValueError("OpenSSH cannot read PuTTY .ppk keys; choose the PuTTY client or an OpenSSH key")


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
    if not isinstance(cfg.default_profile, str):
        raise ValueError("Default profile must be a string")
    if not isinstance(cfg.scratch_dir, str):
        raise ValueError("Scratch folder must be a string")
    if cfg.scratch_dir.strip():
        scratch = Path(os.path.expandvars(os.path.expanduser(cfg.scratch_dir.strip())))
        if scratch.exists() and not scratch.is_dir():
            raise ValueError(f"Scratch folder is not a folder: {cfg.scratch_dir}")
    if not isinstance(cfg.update_check, bool):
        raise ValueError("Update check must be true or false")
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
    _validate_window(cfg)
    profile_names: set[str] = set()
    for profile in cfg.profiles:
        from .agents import AGENT_TYPES as validate_agent_types
        from .agents import validate as validate_agent
        from .connections import validate as validate_connection

        name = profile.name.strip() if isinstance(profile.name, str) else ""
        if not name:
            raise ValueError("Every terminal profile needs a name")
        folded = name.casefold()
        if folded in profile_names:
            raise ValueError("Terminal profile names must be unique")
        profile_names.add(folded)
        if not isinstance(profile.cmd, str):
            raise ValueError(f'Terminal profile "{name}": command must be a string')
        if not isinstance(profile.description, str):
            raise ValueError(f'Terminal profile "{name}": description must be a string')
        for field_label, value in (
            ("terminal type", profile.terminal_type),
            ("WSL distribution", profile.wsl_distro),
            ("startup command", profile.start_command),
            ("launch mode", profile.agent_mode),
            ("SSH client", profile.ssh_client),
            ("ProxyJump", profile.ssh_proxy_jump),
        ):
            if value is not None and not isinstance(value, str):
                raise ValueError(
                    f'Terminal profile "{name}": {field_label} must be a string'
                )
        if not isinstance(profile.agent, dict):
            raise ValueError(f'Terminal profile "{name}": agent options must be an object')
        if not isinstance(profile.autostart, bool):
            raise ValueError(f'Terminal profile "{name}": autostart must be true or false')
        try:
            validate_connection(profile)
            if profile.terminal_type in validate_agent_types:
                # Agents need a project folder, and the workspace root is the
                # only source of one: the spawn refuses when none resolves.
                validate_agent(profile)
            if profile.terminal_type in ("ssh", "sftp"):
                _validate_ssh(profile)
        except ValueError as exc:
            raise ValueError(f'Terminal profile "{name}": {exc}') from exc
        if profile.terminal_type == "custom" and not profile.cmd.strip():
            raise ValueError(f'Terminal profile "{name}": executable is required')
        if not isinstance(profile.args, list) or any(not isinstance(arg, str) for arg in profile.args):
            raise ValueError(f'Terminal profile "{name}": arguments must be strings')
        try:
            validate_environment(profile.env)
        except ValueError as exc:
            raise ValueError(f'Terminal profile "{name}": {exc}') from exc
        if profile.keybinding is not None and not isinstance(profile.keybinding, str):
            raise ValueError(f'Terminal profile "{name}": shortcut must be a string')
        if profile.keybinding:
            parsed = parse_binding(profile.keybinding)
            if parsed in hotkey_owners:
                raise ValueError(
                    f'Terminal profile "{name}": shortcut conflicts with {hotkey_owners[parsed]}'
                )
            hotkey_owners[parsed] = f'terminal profile "{name}"'
        # No folder to validate: a profile has none, and the workspace root is
        # checked when a session actually spawns.
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
    rows += [
        (f'Terminal profile "{profile.name}": shortcut', profile.keybinding)
        for profile in cfg.profiles
    ]
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


def load_config() -> AppConfig:
    path = config_dir() / "config.json"
    if not path.exists():
        cfg = AppConfig()
        save_config(cfg)
        return cfg
    try:
        raw = json.loads(read_text(path))
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

    A PUT that drops fields (an older or buggy client) replaced every profile
    and snippet with nothing to go back to. The copy is the stored file as it
    was, so DPAPI-protected values stay protected in it. A save that changes
    nothing leaves the backup alone, or saving twice would erase the only
    older state. "Nothing" is decided on the decrypted settings: DPAPI output
    differs on every call, so with any profile secret the file text never
    repeats.

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
