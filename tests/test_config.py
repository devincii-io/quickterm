import json

import pytest

from quickterm import config as cfgmod
from quickterm.config import AppConfig, Profile, load_config, save_config, validate_environment


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
    # personal profiles are user-created only; system shells come from the
    # live inventory, so a fresh config starts empty
    assert cfg.profiles == []
    assert cfg.default_profile == ""
    assert cfg.theme == "graphite"
    assert cfg.custom_theme == {}
    assert cfg.logo is None
    assert cfg.idle_timeout_s == 300
    assert cfg.max_sessions == 0
    assert cfg.scrollback_bytes == 512 * 1024
    assert len(cfg.snippets) >= 1


def test_save_load_roundtrip(fake_appdata):
    cfg = AppConfig(port=9999, default_profile="cmd")
    cfg.profiles.append(Profile(
        name="ubuntu",
        cmd="wsl.exe",
        cwd="~/dev",
        autostart=True,
        terminal_type="wsl",
        wsl_distro="Ubuntu",
        start_command="source .venv/bin/activate",
    ))
    save_config(cfg)
    loaded = load_config()
    assert loaded.port == 9999
    assert loaded.default_profile == "cmd"
    ubuntu = next(p for p in loaded.profiles if p.name == "ubuntu")
    assert ubuntu.cwd == "~/dev"
    assert ubuntu.autostart is True
    assert ubuntu.terminal_type == "wsl"
    assert ubuntu.wsl_distro == "Ubuntu"
    assert ubuntu.start_command == "source .venv/bin/activate"


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
    legacy = {
        "profiles": [{"name": "secure", "cmd": "cmd.exe", "env": {"API_TOKEN": "secret"}}]
    }
    (path / "config.json").write_text(json.dumps(legacy), encoding="utf-8")

    loaded = load_config()

    assert loaded.profiles[0].env == {"API_TOKEN": "secret"}
    stored = json.loads((path / "config.json").read_text(encoding="utf-8"))
    protected = stored["profiles"][0]["env"]["API_TOKEN"]
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


def test_save_rejects_missing_local_profile_folder(fake_appdata):
    missing = fake_appdata / "does-not-exist"
    cfg = AppConfig(profiles=[
        Profile(
            name="Standard",
            cmd="powershell.exe",
            cwd=str(missing),
            terminal_type="windows-powershell",
        )
    ])
    with pytest.raises(ValueError, match="starting folder does not exist"):
        save_config(cfg)
    assert not (fake_appdata / "quickterm" / "config.json").exists()


def test_save_allows_wsl_folder_without_local_match(fake_appdata):
    cfg = AppConfig(profiles=[
        Profile(name="Ubuntu", cmd="wsl.exe", cwd="~/missing", terminal_type="wsl")
    ])
    save_config(cfg)
    assert (fake_appdata / "quickterm" / "config.json").exists()


def test_ssh_profile_roundtrip(fake_appdata):
    cfg = AppConfig()
    cfg.profiles.append(Profile(
        name="server",
        cmd="",
        terminal_type="ssh",
        ssh_host="host.example.com",
        ssh_port=2222,
        ssh_user="deploy",
        ssh_key="C:\\keys\\id.ppk",
    ))
    save_config(cfg)
    loaded = load_config()
    server = next(p for p in loaded.profiles if p.name == "server")
    assert server.terminal_type == "ssh"
    assert server.ssh_host == "host.example.com"
    assert server.ssh_port == 2222
    assert server.ssh_user == "deploy"
    assert server.ssh_key == "C:\\keys\\id.ppk"


def test_save_rejects_ssh_profile_without_host(fake_appdata):
    cfg = AppConfig(profiles=[
        Profile(name="server", cmd="", terminal_type="ssh")
    ])
    with pytest.raises(ValueError, match="host is required"):
        save_config(cfg)


@pytest.mark.parametrize("port", [0, 65536, True, "22"])
def test_save_rejects_ssh_profile_with_bad_port(fake_appdata, port):
    cfg = AppConfig(profiles=[
        Profile(name="server", cmd="", terminal_type="sftp", ssh_host="h", ssh_port=port)
    ])
    with pytest.raises(ValueError, match="port must be between"):
        save_config(cfg)


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
        "profiles": [{"name": "x", "cmd": "cmd.exe", "mystery_key": True}],
        "voice": {"model_size": "base", "bogus": "yes"},
    }
    (path / "config.json").write_text(json.dumps(data), encoding="utf-8")
    cfg = load_config()
    assert cfg.port == 7000
    assert cfg.profiles[0].name == "x"
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


def test_load_quarantines_structurally_invalid_config(fake_appdata):
    path = fake_appdata / "quickterm"
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text(json.dumps({"profiles": "bad"}), encoding="utf-8")
    assert load_config().profiles == []
    assert len(list(path.glob("config.invalid-*.json"))) == 1


def test_save_rejects_duplicate_snippets(fake_appdata):
    cfg = AppConfig()
    cfg.snippets[1].name = cfg.snippets[0].name.upper()
    with pytest.raises(ValueError, match="Snippet names must be unique"):
        save_config(cfg)


def test_save_rejects_conflicting_global_shortcuts(fake_appdata):
    cfg = AppConfig(profiles=[
        Profile(name="Conflict", cmd="cmd.exe", keybinding=cfgmod.AppConfig().summon_hotkey),
    ])
    with pytest.raises(ValueError, match="conflicts"):
        save_config(cfg)
