import json

import pytest

from quickterm import config as cfgmod
from quickterm.config import (
    AppConfig, Snippet, load_config, save_config, validate_environment,
)


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_config_dir_created(fake_appdata):
    d = cfgmod.config_dir()
    assert d == fake_appdata / "quickterm"
    assert d.is_dir()


def test_default_cwd_uses_home_even_when_desktop_exists(monkeypatch, tmp_path):
    (tmp_path / "Desktop").mkdir()
    monkeypatch.setattr(cfgmod.Path, "home", staticmethod(lambda: tmp_path))
    assert cfgmod.default_cwd() == str(tmp_path)


def test_default_cwd_falls_back_to_home_without_desktop(monkeypatch, tmp_path):
    monkeypatch.setattr(cfgmod.Path, "home", staticmethod(lambda: tmp_path))
    assert cfgmod.default_cwd() == str(tmp_path)


def test_load_config_writes_default_file(fake_appdata):
    cfg = load_config()
    path = fake_appdata / "quickterm" / "config.json"
    assert path.exists()
    # Saved terminals are gone (4.5).
    assert not hasattr(cfg, "profiles")
    assert cfg.shell == "powershell"
    assert cfg.agents == {"claude-code": cfgmod.AgentSettings(), "codex": cfgmod.AgentSettings()}
    assert not hasattr(cfg, "default_profile")
    # A fresh config is not a migration: no pre-4.3 copy.
    assert not (fake_appdata / "quickterm" / cfgmod.PRE_43_BACKUP).exists()
    assert cfg.theme == "graphite"
    assert cfg.custom_theme == {}
    assert cfg.logo is None
    assert cfg.idle_timeout_s == 300
    assert cfg.max_sessions == 0
    assert cfg.scrollback_bytes == 512 * 1024
    assert len(cfg.snippets) >= 1


def test_save_load_roundtrip(fake_appdata):
    cfg = AppConfig(port=9999, shell="wsl:Ubuntu")
    save_config(cfg)
    loaded = load_config()
    assert loaded.port == 9999
    assert loaded.shell == "wsl:Ubuntu"


def test_agent_settings_round_trip_and_launch_mode_validation(fake_appdata):
    cfg = AppConfig()
    cfg.agents["claude-code"] = cfgmod.AgentSettings(
        cmd="claude.exe", agent_mode="resume", agent={"model": "opus", "permission_mode": "plan"},
    )
    save_config(cfg)

    loaded = load_config().agents["claude-code"]
    assert loaded.agent_mode == "resume"
    assert loaded.agent == {"model": "opus", "permission_mode": "plan"}
    assert load_config().agents["codex"] == cfgmod.AgentSettings()

    for mode in ("guess", "fork"):  # fork is a Codex mode
        cfg.agents["claude-code"].agent_mode = mode
        with pytest.raises(ValueError, match="Claude Code: Claude launch mode"):
            save_config(cfg)


def _write_raw(fake_appdata, raw):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text(json.dumps(raw), encoding="utf-8")
    return path


def test_the_real_4_2_shape_migrates_to_agents_and_no_saved_terminals(fake_appdata):
    ssh = [
        {"name": f"server {n}", "cmd": "", "terminal_type": "ssh", "ssh_host": f"h{n}"}
        for n in range(3)
    ]
    raw = {
        "default_profile": "Claude New",
        "profiles": [
            {"name": "Claude New", "cmd": "", "terminal_type": "claude-code", "agent_mode": "new",
             "claude_mode": "new", "agent": {}},
            {"name": "codex", "cmd": "powershell.exe", "terminal_type": "windows-powershell",
             "start_command": "codex"},
            {"name": "Windows PowerShell", "cmd": "powershell.exe",
             "terminal_type": "windows-powershell"},
            *ssh,
        ],
    }
    path = _write_raw(fake_appdata, raw)
    before = (path / "config.json").read_text(encoding="utf-8")

    cfg = load_config()

    assert not hasattr(cfg, "profiles")
    assert cfg.agents["claude-code"].agent_mode == "new"
    # The "codex" shell that only ran codex becomes the Codex settings.
    assert cfg.agents["codex"] == cfgmod.AgentSettings(agent_mode="new")
    assert cfg.shell == "powershell"
    # The file as it was, next to the migrated one, which is saved at once.
    assert (path / cfgmod.PRE_43_BACKUP).read_text(encoding="utf-8") == before
    assert (path / cfgmod.PRE_45_BACKUP).read_text(encoding="utf-8") == before
    stored = json.loads((path / "config.json").read_text(encoding="utf-8"))
    assert "default_profile" not in stored and "agents" in stored and "profiles" not in stored
    # Once: the next load changes nothing and keeps the first copy.
    (path / cfgmod.PRE_43_BACKUP).write_text("first", encoding="utf-8")
    assert load_config() == cfg
    assert (path / cfgmod.PRE_43_BACKUP).read_text(encoding="utf-8") == "first"


def test_migration_names_what_it_dropped_and_keeps_start_arguments(fake_appdata):
    raw = {"profiles": [
        {"name": "Claude New", "cmd": "", "terminal_type": "claude-code", "agent_mode": "new",
         "keybinding": "ctrl+alt+c", "autostart": True},
        {"name": "yolo", "cmd": "pwsh.exe", "terminal_type": "powershell-core",
         "start_command": "codex --yolo --model o3", "env": {"K": "v"}},
        {"name": "again", "cmd": "bash", "terminal_type": "git-bash", "start_command": "claude -c"},
        {"name": "Windows PowerShell", "cmd": "powershell.exe", "terminal_type": "windows-powershell",
         "keybinding": "ctrl+alt+p"},
    ]}
    notes = []
    out = cfgmod.migrate_agents(raw, notes)
    assert out["profiles"] == []
    assert out["agents"]["codex"] == {
        "cmd": "", "args": ["--yolo", "--model", "o3"], "agent_mode": "new", "agent": {}, "env": {"K": "v"},
    }
    assert out["agents"]["claude-code"]["agent_mode"] == "new"
    assert notes == [
        'Terminal "Claude New" became the Claude Code settings (its shortcut ctrl+alt+c and its '
        "autostart not kept).",
        'Terminal "yolo" became the Codex settings.',
        'Terminal "again" was removed: Claude Code starts from Settings > Agents.',
        'Terminal "Windows PowerShell" was removed: the shell is in the + menu (its shortcut '
        "ctrl+alt+p not kept).",
    ]
    path = _write_raw(fake_appdata, raw)
    cfg = load_config()
    assert cfg.agents["codex"].args == ["--yolo", "--model", "o3"]
    assert (path / cfgmod.PRE_43_BACKUP).exists()
    # The notes wait in a file for whichever process shows the window.
    load_config()
    notice = cfgmod.take_migration_notice()
    assert notice.startswith("Settings moved to QuickTerm 4.3: ")
    assert 'Terminal "yolo" became the Codex settings.' in notice
    assert not (path / cfgmod.MIGRATION_NOTES).exists()
    assert cfgmod.take_migration_notice() is None, "once"


def test_the_backend_shows_what_the_launcher_migrated(fake_appdata, monkeypatch):
    import sys

    from quickterm import app

    _write_raw(fake_appdata, {"profiles": [
        {"name": "Windows PowerShell", "cmd": "powershell.exe", "terminal_type": "windows-powershell"},
    ]})
    seen = {}
    monkeypatch.setattr(app, "_harden_program_lookup", lambda: None)
    monkeypatch.setattr(app, "_check_windows_build", lambda: None)
    monkeypatch.setattr(app, "_setup_logging", lambda *a: None)
    monkeypatch.setattr(app, "_run_launcher", lambda cfg, **kw: seen.setdefault("launcher", cfg.launch_error) and 0)
    monkeypatch.setattr(app, "_run_backend", lambda cfg, **kw: seen.setdefault("backend", cfg.launch_error) and 0)
    monkeypatch.setattr(sys, "platform", "win32")

    # Plain QuickTerm.exe: the launcher loads, and so migrates, the config.
    monkeypatch.setattr(sys, "argv", ["QuickTerm"])
    app.main()
    assert seen["launcher"] is None, "the launcher shows no window and leaves the notice"
    assert (fake_appdata / "quickterm" / cfgmod.MIGRATION_NOTES).exists()

    # The backend it starts loads a config that is already migrated.
    monkeypatch.setattr(sys, "argv", ["QuickTerm", "--serve"])
    app.main()
    assert seen["backend"] == (
        "Settings moved to QuickTerm 4.3: Terminal \"Windows PowerShell\" was removed: "
        "the shell is in the + menu."
    )
    assert not (fake_appdata / "quickterm" / cfgmod.MIGRATION_NOTES).exists()


def test_migration_keeps_the_first_agent_of_each_kind_and_special_profiles():
    raw = {"profiles": [
        {"name": "c1", "cmd": "", "terminal_type": "claude-code", "claude_mode": "agents",
         "agent": {"model": "opus"}, "args": ["--verbose"], "env": {"A": "1"}},
        {"name": "c2", "cmd": "", "terminal_type": "claude-code", "agent_mode": "resume"},
        {"name": "x1", "cmd": "codex", "terminal_type": "codex"},
        {"name": "dev", "cmd": "pwsh.exe", "terminal_type": "powershell-core",
         "start_command": "npm run dev"},
        {"name": "agent shell", "cmd": "bash", "terminal_type": "git-bash",
         "start_command": "claude.exe --continue"},
        {"name": "untyped shell", "cmd": r"C:\Windows\System32\cmd.exe"},
        {"name": "tool", "cmd": "htop"},
        {"name": "db", "cmd": "", "terminal_type": "docker", "connection": {"container": "db"}},
    ]}
    assert [p["name"] for p in cfgmod.migrate_agents(raw)["profiles"]] == ["dev", "tool", "db"]
    cfg = cfgmod.config_from_dict(raw)
    claude = cfg.agents["claude-code"]
    assert (claude.agent_mode, claude.agent, claude.args, claude.env) == (
        "agents", {"model": "opus"}, ["--verbose"], {"A": "1"}
    )
    assert cfg.agents["codex"].cmd == "codex"


@pytest.mark.parametrize("value", ["powershell", "cmd", "git-bash", "wsl", "wsl:Ubuntu-22.04", ""])
def test_shell_values_that_save(fake_appdata, value):
    save_config(AppConfig(shell=value))
    assert load_config().shell == value


@pytest.mark.parametrize("value", ["bash", "pwsh", "wsl:", "wsl:-d", "wsl:a b", None, 3])
def test_shell_values_that_are_refused(fake_appdata, value):
    with pytest.raises(ValueError, match="shell must be one of powershell, cmd, git-bash, wsl"):
        save_config(AppConfig(shell=value))


def _parse_3x(binding):
    """3.13's hotkeys.parse_binding grammar, frozen here: a downgrade runs it
    on every stored shortcut and discards the whole config on a ValueError."""
    tokens = [t.strip().lower() for t in binding.split("+")]
    if not tokens or any(not t for t in tokens):
        raise ValueError(binding)
    *mods, key = tokens
    modifiers = {"ctrl", "control", "alt", "shift", "win"}
    if any(m not in modifiers for m in mods) or key in modifiers:
        raise ValueError(binding)
    named = {"grave", "backtick", "space", "tab", "esc", "escape", "enter", "return"}
    if key in named or (key[0] == "f" and key[1:].isdigit() and 1 <= int(key[1:]) <= 24):
        return
    if len(key) == 1:
        return
    raise ValueError(f"unknown key: {key!r}")


_V4_ONLY_KEYS = [
    "minus", "equal", "comma", "period", "slash", "semicolon", "quote", "bracketleft",
    "bracketright", "backslash", "left", "up", "right", "down", "home", "end", "pageup",
    "pagedown", "insert", "delete", "numpad0", "numpad9",
]


@pytest.mark.parametrize("key", _V4_ONLY_KEYS)
def test_a_4_0_shortcut_never_makes_the_config_unreadable_for_3_x(fake_appdata, key):
    with pytest.raises(ValueError):
        _parse_3x(f"ctrl+alt+{key}")
    save_config(AppConfig(summon_hotkey=f"ctrl+alt+{key}"))
    stored = json.loads((fake_appdata / "quickterm" / "config.json").read_text(encoding="utf-8"))

    # What 3.x reads parses: the legacy field is empty.
    assert stored["summon_hotkey"] == "" and stored["summon_hotkey_v4"] == f"ctrl+alt+{key}"

    # 4.0 reads its own key back.
    assert load_config().summon_hotkey == f"ctrl+alt+{key}"


def test_a_legacy_shortcut_is_stored_where_3_x_reads_it(fake_appdata):
    save_config(AppConfig(summon_hotkey="ctrl+alt+grave"))
    stored = json.loads((fake_appdata / "quickterm" / "config.json").read_text(encoding="utf-8"))
    assert stored["summon_hotkey"] == "ctrl+alt+grave"
    assert "summon_hotkey_v4" not in stored


@pytest.mark.parametrize(("agent", "message"), [
    ({"colour": "blue"}, "unknown agent option: colour"),
    ({"model": "x y"}, "model"),
    ({"effort": "huge"}, "effort"),
    ({"bypass": "true", "sandbox": "read-only"}, "bypass replaces approval and sandbox"),
])
def test_agent_options_are_checked_on_save(fake_appdata, agent, message):
    kind = "codex" if "bypass" in agent else "claude-code"
    cfg = AppConfig()
    cfg.agents[kind] = cfgmod.AgentSettings(agent=agent)
    label = cfgmod.AGENT_LABELS[kind]
    with pytest.raises(ValueError, match=f"{label}: .*{message}"):
        save_config(cfg)


def test_agent_env_is_protected_at_rest(fake_appdata, monkeypatch):
    monkeypatch.setattr(cfgmod.secret_store, "protection_available", lambda: True)
    monkeypatch.setattr(cfgmod.secret_store, "protect", lambda data: b"sealed:" + data)
    monkeypatch.setattr(cfgmod.secret_store, "unprotect", lambda data: data.removeprefix(b"sealed:"))
    cfg = AppConfig()
    cfg.agents["codex"].env = {"OPENAI_API_KEY": "secret"}
    save_config(cfg)
    stored = (fake_appdata / "quickterm" / "config.json").read_text(encoding="utf-8")
    assert "secret" not in stored
    assert load_config().agents["codex"].env == {"OPENAI_API_KEY": "secret"}


def test_window_and_overlay_default_and_round_trip(fake_appdata):
    cfg = load_config()
    assert cfg.window == cfgmod.WindowConfig(width=1280, height=800, remember_bounds=True)
    assert cfg.overlay == cfgmod.OverlayConfig(
        enabled=False, edge="top", width_pct=100, height_pct=50, always_on_top=True,
        hide_on_blur=True, monitor="cursor", animate=True,
    )
    cfg.window.width = 1600
    cfg.overlay.enabled = True
    cfg.overlay.edge = "bottom"
    cfg.overlay.monitor = "primary"
    save_config(cfg)
    loaded = load_config()
    assert loaded.window.width == 1600
    assert (loaded.overlay.enabled, loaded.overlay.edge, loaded.overlay.monitor) == (True, "bottom", "primary")


def test_update_auto_download_defaults_on_and_round_trips(fake_appdata):
    cfg = load_config()
    assert cfg.update_auto_download is True
    cfg.update_auto_download = False
    save_config(cfg)
    assert load_config().update_auto_download is False


def test_a_config_from_before_window_settings_loads_with_defaults(fake_appdata):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text(json.dumps({"port": 7001, "voice": {"enabled": False}}), encoding="utf-8")
    cfg = load_config()
    assert cfg.port == 7001  # loaded, not quarantined
    assert cfg.window == cfgmod.WindowConfig()
    assert cfg.overlay == cfgmod.OverlayConfig()


@pytest.mark.parametrize(("section", "field", "value", "message"), [
    ("window", "width", 759, "Window width must be between 760 and 16384"),
    ("window", "height", 16385, "Window height must be between 480 and 16384"),
    ("window", "width", True, "Window width must be an integer"),
    ("window", "remember_bounds", "yes", "Remember window size must be true or false"),
    ("overlay", "width_pct", 29, "Overlay width must be between 30 and 100"),
    ("overlay", "height_pct", 101, "Overlay height must be between 20 and 100"),
    ("overlay", "edge", "left", "Overlay edge must be top or bottom"),
    ("overlay", "monitor", "second", "Overlay monitor must be cursor or primary"),
    ("overlay", "animate", 1, "Overlay animation must be true or false"),
])
def test_window_and_overlay_ranges(fake_appdata, section, field, value, message):
    cfg = AppConfig()
    setattr(getattr(cfg, section), field, value)
    with pytest.raises(ValueError, match=message):
        save_config(cfg)


def test_window_bounds_are_inclusive(fake_appdata):
    cfg = AppConfig()
    cfg.window.width, cfg.window.height = 760, 16384
    cfg.overlay.width_pct, cfg.overlay.height_pct = 30, 20
    save_config(cfg)


def test_environment_values_are_protected_at_rest_and_plaintext_configs_migrate(
    fake_appdata, monkeypatch
):
    monkeypatch.setattr(cfgmod.secret_store, "protection_available", lambda: True)
    monkeypatch.setattr(cfgmod.secret_store, "protect", lambda data: b"sealed:" + data)
    monkeypatch.setattr(
        cfgmod.secret_store,
        "unprotect",
        lambda data: data.removeprefix(b"sealed:"),
    )
    path = fake_appdata / "quickterm"
    path.mkdir()
    legacy = {"agents": {"codex": {"env": {"API_TOKEN": "secret"}}}}
    (path / "config.json").write_text(json.dumps(legacy), encoding="utf-8")

    loaded = load_config()

    assert loaded.agents["codex"].env == {"API_TOKEN": "secret"}
    stored = json.loads((path / "config.json").read_text(encoding="utf-8"))
    protected = stored["agents"]["codex"]["env"]["API_TOKEN"]
    assert protected["protected"] == "dpapi-v1"
    assert "secret" not in json.dumps(stored)


@pytest.mark.parametrize(
    "env",
    [
        {"": "value"},
        {"BAD=NAME": "value"},
        {"BAD\nNAME": "value"},
        {"KEY": "bad\0value"},
        {"Path": "one", "PATH": "two"},
        {"KEY": "x" * (cfgmod.ENV_MAX_VALUE_CHARS + 1)},
    ],
)
def test_environment_validation_rejects_unsafe_values(env):
    with pytest.raises(ValueError):
        validate_environment(env)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("port", 0, "Port"),
        ("scrollback_bytes", 1024, "Scrollback"),
        ("font_size", 40, "Font size"),
        ("idle_timeout_s", -1, "Idle timeout"),
        ("max_sessions", 101, "Terminal limit"),
    ],
)
def test_save_rejects_unsafe_bounds(fake_appdata, field, value, message):
    cfg = AppConfig()
    setattr(cfg, field, value)
    with pytest.raises(ValueError, match=message):
        save_config(cfg)


def test_unknown_keys_ignored(fake_appdata):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    data = {
        "port": 7000,
        "totally_unknown": {"nested": 1},
        "agents": {"codex": {"cmd": "codex", "mystery_key": True}},
        "voice": {"model_size": "base", "bogus": "yes"},
    }
    (path / "config.json").write_text(json.dumps(data), encoding="utf-8")
    cfg = load_config()
    assert cfg.port == 7000
    assert cfg.agents["codex"].cmd == "codex"
    assert cfg.voice.model_size == "base"


def test_corrupt_config_is_quarantined_and_defaults_restore(fake_appdata):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text('{"profiles": [', encoding="utf-8")

    loaded = load_config()

    assert loaded.theme == "graphite"
    assert json.loads((path / "config.json").read_text(encoding="utf-8"))["theme"] == "graphite"
    backups = list(path.glob("config.invalid-*.json"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == '{"profiles": ['


def test_save_rejects_non_loopback_host(fake_appdata):
    with pytest.raises(ValueError, match="loopback"):
        save_config(AppConfig(host="0.0.0.0"))


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_every_loopback_host_is_accepted(fake_appdata, host):
    save_config(AppConfig(host=host))
    assert load_config().host == host


def config_text(fake_appdata, name="config.json"):
    return (fake_appdata / "quickterm" / name).read_text(encoding="utf-8")


def test_save_keeps_the_previous_config_as_a_backup(fake_appdata):
    # A partial PUT used to replace every setting and snippet with nothing to
    # go back to.
    save_config(AppConfig(snippets=[Snippet(name="work", text="w\r")]))
    before = config_text(fake_appdata)
    save_config(AppConfig())

    assert config_text(fake_appdata, "config.prev.json") == before
    assert json.loads(config_text(fake_appdata, "config.prev.json"))["snippets"][0]["name"] == "work"


def test_an_identical_save_does_not_overwrite_the_backup(fake_appdata):
    save_config(AppConfig(font_size=12))
    save_config(AppConfig(font_size=15))
    save_config(AppConfig(font_size=15))
    assert json.loads(config_text(fake_appdata, "config.prev.json"))["font_size"] == 12


def test_a_save_that_changes_nothing_keeps_the_backup_even_with_secrets(
    fake_appdata, monkeypatch
):
    # DPAPI output differs on every call, so the file text of a config with a
    # profile secret never repeats; comparing text replaced the backup with a
    # copy of the current state on every such save.
    counter = iter(range(1_000_000))
    monkeypatch.setattr(cfgmod.secret_store, "protection_available", lambda: True)
    monkeypatch.setattr(
        cfgmod.secret_store, "protect", lambda data: b"%d:" % next(counter) + data,
    )
    monkeypatch.setattr(
        cfgmod.secret_store, "unprotect", lambda data: data.split(b":", 1)[1],
    )
    def with_secret(font_size):
        cfg = AppConfig(font_size=font_size)
        cfg.agents["codex"].env = {"API_TOKEN": "secret"}
        return cfg

    save_config(with_secret(12))
    save_config(with_secret(15))
    save_config(with_secret(15))

    assert json.loads(config_text(fake_appdata, "config.prev.json"))["font_size"] == 12


def test_the_first_save_has_no_backup_and_a_failed_backup_does_not_fail_the_save(
    fake_appdata, monkeypatch
):
    save_config(AppConfig())
    assert not (fake_appdata / "quickterm" / "config.prev.json").exists()

    real = cfgmod._atomic_write

    def no_backup(path, text):
        if path.name == "config.prev.json":
            raise PermissionError(13, "denied")
        real(path, text)

    monkeypatch.setattr(cfgmod, "_atomic_write", no_backup)
    save_config(AppConfig(font_size=20))
    assert load_config().font_size == 20


def test_the_backup_never_keeps_secrets_the_save_is_encrypting(fake_appdata, monkeypatch):
    monkeypatch.setattr(cfgmod.secret_store, "protection_available", lambda: True)
    monkeypatch.setattr(cfgmod.secret_store, "protect", lambda data: b"sealed:" + data)
    monkeypatch.setattr(
        cfgmod.secret_store, "unprotect", lambda data: data.removeprefix(b"sealed:"),
    )
    path = fake_appdata / "quickterm"
    path.mkdir()
    legacy = {"agents": {"codex": {"env": {"API_TOKEN": "secret"}}}}
    (path / "config.json").write_text(json.dumps(legacy), encoding="utf-8")

    load_config()  # migrates the plaintext value to a protected one

    assert "secret" not in config_text(fake_appdata)
    backup = path / "config.prev.json"
    assert not backup.exists() or "secret" not in backup.read_text(encoding="utf-8")

    # Once protected, later backups are protected copies too.
    again = load_config()
    again.font_size = 16
    save_config(again)
    backup_env = json.loads(config_text(fake_appdata, "config.prev.json"))["agents"]["codex"]["env"]
    assert backup_env["API_TOKEN"]["protected"] == "dpapi-v1"


def test_a_config_replace_refused_by_a_reader_is_retried(fake_appdata, monkeypatch):
    import os

    monkeypatch.setattr(cfgmod, "_RETRY_SHARING_VIOLATIONS", True)
    monkeypatch.setattr(cfgmod.time, "sleep", lambda _: None)
    real = os.replace
    calls = []

    def replace(src, dst):
        calls.append(dst)
        if len(calls) == 1:
            raise PermissionError(13, "sharing violation")
        real(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    save_config(AppConfig(font_size=18))
    assert load_config().font_size == 18
    assert len(calls) == 2


def test_load_quarantines_structurally_invalid_config(fake_appdata):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text(json.dumps({"agents": {}, "snippets": "bad"}), encoding="utf-8")
    assert load_config().snippets == AppConfig().snippets
    assert len(list(path.glob("config.invalid-*.json"))) == 1


def test_save_rejects_duplicate_snippets(fake_appdata):
    cfg = AppConfig()
    cfg.snippets[1].name = cfg.snippets[0].name.upper()
    with pytest.raises(ValueError, match="Snippet names must be unique"):
        save_config(cfg)


def test_shipped_snippets_describe_themselves(fake_appdata):
    """A snippet with no description is the thing this field exists to prevent.

    The two defaults are the worked example every user starts from, so they
    have to be examples of a described snippet, not of a bare one.
    """
    for snippet in AppConfig().snippets:
        assert snippet.description.strip()


def test_a_config_without_descriptions_still_loads(fake_appdata):
    """Descriptions are newer than the config files people already have.

    `_known()` only drops keys the dataclass no longer has. A key it gained
    has to fill itself in from the field default instead, or opening the app
    once after an update would cost the user every profile and snippet.
    """
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    legacy = {"agents": {}, "snippets": [{"name": "git status", "text": "git status\r"}]}
    (path / "config.json").write_text(json.dumps(legacy), encoding="utf-8")

    loaded = load_config()

    assert loaded.snippets[0].description == ""
    # An older config must still be a valid one, not a quarantined one.
    assert not list(path.glob("config.invalid-*.json"))


def test_descriptions_survive_save_and_reload(fake_appdata):
    cfg = AppConfig()
    cfg.snippets.append(Snippet(
        name="tail logs",
        text="Get-Content -Wait app.log\r",
        description="Follow the running app's log until you stop it.",
    ))
    save_config(cfg)

    loaded = load_config()

    assert loaded.snippets[-1].description == "Follow the running app's log until you stop it."
    # The shipped defaults keep their own descriptions through the round trip.
    assert loaded.snippets[0].description == AppConfig().snippets[0].description
    stored = json.loads((fake_appdata / "quickterm" / "config.json").read_text(encoding="utf-8"))
    assert stored["snippets"][0]["description"]


@pytest.mark.parametrize("payload, message", [
    ({"snippets": [{"name": "x", "text": "x\r", "description": []}]}, "description must be a string"),
])
def test_save_rejects_non_string_descriptions(fake_appdata, payload, message):
    cfg = cfgmod.config_from_dict(payload)
    with pytest.raises(ValueError, match=message):
        save_config(cfg)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("font_family", 123, "Font family"),
        ("logo", {"id": "logo.png"}, "Logo"),
        ("shell", [], "shell must be one of"),
        ("update_check", "false", "Update check"),
        ("update_auto_download", 1, "Automatic update download"),
    ],
)
def test_save_rejects_wrong_global_field_types(fake_appdata, field, value, message):
    cfg = AppConfig()
    setattr(cfg, field, value)
    with pytest.raises(ValueError, match=message):
        save_config(cfg)


# --- 4.5: saved terminals go, SSH workspace hosts become destinations ----------


def _write_workspace(fake_appdata, name, document, folder=""):
    path = fake_appdata / "quickterm" / "workspaces" / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / f"{name}.json").write_text(json.dumps({"name": name, "layout": {}, **document}), encoding="utf-8")
    return path / f"{name}.json"


def _a_4_4_config():
    return {
        "agents": {},
        "profiles": [
            {"name": "prod", "cmd": "", "terminal_type": "ssh", "ssh_host": "prod.example",
             "ssh_user": "deploy", "ssh_port": 2222, "ssh_key": r"C:\keys\id", "ssh_client": "openssh"},
            {"name": "devbox", "cmd": "", "terminal_type": "ssh", "ssh_host": "devbox", "ssh_client": "openssh"},
            {"name": "jumpy", "cmd": "", "terminal_type": "ssh", "ssh_host": "10.0.0.5", "ssh_user": "me",
             "ssh_proxy_jump": "bastion", "ssh_client": "openssh"},
            {"name": "db", "cmd": "", "terminal_type": "docker", "connection": {"container": "db"}},
        ],
    }


def test_ssh_destination_of_a_stored_profile():
    assert cfgmod.ssh_destination({"ssh_host": "h"}) == "h"
    assert cfgmod.ssh_destination({"ssh_host": "h", "ssh_user": "u"}) == "u@h"
    assert cfgmod.ssh_destination({"ssh_host": "h", "ssh_user": "u", "ssh_port": 2222}) == "ssh://u@h:2222"
    assert cfgmod.ssh_destination({"ssh_host": "fe80::1", "ssh_port": 22}) == "ssh://[fe80::1]:22"
    assert cfgmod.ssh_destination({"ssh_host": " "}) is None
    assert cfgmod.ssh_destination({"ssh_host": "h", "ssh_port": True}) == "h"


def test_a_4_4_config_loses_its_profiles_and_ssh_workspaces_keep_their_host(fake_appdata):
    path = _write_raw(fake_appdata, _a_4_4_config())
    before = (path / "config.json").read_text(encoding="utf-8")
    prod = _write_workspace(fake_appdata, "api", {"path": "/srv/api", "host": "prod"})
    dev = _write_workspace(fake_appdata, "dev", {"path": "~/x", "host": "devbox"})
    jumpy = _write_workspace(fake_appdata, "j", {"path": "/x", "host": "jumpy"})
    elevated = _write_workspace(fake_appdata, "e", {"path": "/x", "host": "prod"}, folder="elevated")
    local = _write_workspace(fake_appdata, "local", {"path": str(fake_appdata)})
    unknown = _write_workspace(fake_appdata, "other", {"path": "/y", "host": "alias-in-ssh-config"})

    cfg = load_config()

    assert not hasattr(cfg, "profiles")
    stored = json.loads((path / "config.json").read_text(encoding="utf-8"))
    assert "profiles" not in stored
    assert (path / cfgmod.PRE_45_BACKUP).read_text(encoding="utf-8") == before
    host = lambda file: json.loads(file.read_text(encoding="utf-8")).get("host")  # noqa: E731
    assert host(prod) == "ssh://deploy@prod.example:2222"
    assert host(dev) == "devbox"
    assert host(jumpy) == "me@10.0.0.5"
    assert host(elevated) == "ssh://deploy@prod.example:2222"
    assert host(local) is None
    assert host(unknown) == "alias-in-ssh-config"  # a name no profile had stays
    notice = cfgmod.take_migration_notice()
    assert notice.startswith(cfgmod.MIGRATION_PREFIX_45)
    assert 'Workspaces on "prod" now connect to ssh://deploy@prod.example:2222' in notice
    assert "private key could not be kept, so put them in ~/.ssh/config" in notice
    assert 'Workspaces on "jumpy"' in notice and "ProxyJump" in notice
    assert '"devbox"' not in notice
    assert "4 saved terminal(s) are kept in config.pre-4.5.json only." in notice
    assert cfgmod.take_migration_notice() is None


def test_the_4_5_migration_runs_once_and_keeps_the_first_backup(fake_appdata):
    path = _write_raw(fake_appdata, _a_4_4_config())
    load_config()
    (path / cfgmod.PRE_45_BACKUP).write_text("first", encoding="utf-8")
    cfgmod.take_migration_notice()
    load_config()
    assert (path / cfgmod.PRE_45_BACKUP).read_text(encoding="utf-8") == "first"
    assert cfgmod.take_migration_notice() is None


def test_a_profile_host_that_cannot_be_a_destination_is_named(fake_appdata):
    _write_raw(fake_appdata, {"agents": {}, "profiles": [
        {"name": "Prod Server", "cmd": "", "terminal_type": "ssh", "ssh_host": "Prod Server"},
    ]})
    ws = _write_workspace(fake_appdata, "p", {"path": "/x", "host": "Prod Server"})
    load_config()
    assert json.loads(ws.read_text(encoding="utf-8"))["host"] == "Prod Server"
    assert 'Workspaces on "Prod Server" could not keep their host' in cfgmod.take_migration_notice()


def test_wsl_and_other_terminals_as_hosts_and_what_they_lose_are_named(fake_appdata):
    _write_raw(fake_appdata, {"agents": {}, "profiles": [
        {"name": "ubuntu", "cmd": "wsl.exe", "terminal_type": "wsl", "wsl_distro": "Ubuntu",
         "start_command": "cd ~/app"},
        {"name": "notes", "cmd": "notepad.exe", "terminal_type": "custom"},
        {"name": "box", "cmd": "", "terminal_type": "ssh", "ssh_host": "box", "ssh_port": 99999,
         "env": {"TOKEN": "x"}},
    ]})
    in_wsl = _write_workspace(fake_appdata, "w", {"path": "/home/me", "host": "ubuntu"})
    custom = _write_workspace(fake_appdata, "n", {"path": "/x", "host": "notes"})
    on_box = _write_workspace(fake_appdata, "b", {"path": "/srv", "host": "box"})
    load_config()
    host = lambda file: json.loads(file.read_text(encoding="utf-8")).get("host")  # noqa: E731
    assert host(in_wsl) == "wsl:Ubuntu"
    assert host(custom) is None
    assert host(on_box) == "box"
    notice = cfgmod.take_migration_notice()
    assert 'Workspaces on "ubuntu" now open in wsl:Ubuntu; its start command could not be kept' in notice
    assert 'Workspaces on "notes" were not on an SSH host or in WSL and now open on this PC.' in notice
    assert 'Workspaces on "box" now connect to box; its environment variables, port 99999 could not be kept' in notice


def test_a_4_2_config_gets_both_backups_and_both_notices(fake_appdata):
    path = _write_raw(fake_appdata, {"profiles": [
        {"name": "Windows PowerShell", "cmd": "powershell.exe", "terminal_type": "windows-powershell"},
        {"name": "box", "cmd": "", "terminal_type": "ssh", "ssh_host": "box"},
    ]})
    load_config()
    assert (path / cfgmod.PRE_43_BACKUP).exists() and (path / cfgmod.PRE_45_BACKUP).exists()
    notice = cfgmod.take_migration_notice()
    assert notice.startswith(cfgmod.MIGRATION_PREFIX_43)
    assert cfgmod.MIGRATION_PREFIX_45 + "1 saved terminal(s)" in notice


def test_a_config_put_with_profiles_ignores_them(fake_appdata):
    cfg = cfgmod.config_from_dict({"agents": {}, "profiles": [{"name": "x", "cmd": "y"}], "font_size": 15})
    assert cfg.font_size == 15 and not hasattr(cfg, "profiles")
