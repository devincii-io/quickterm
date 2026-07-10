import json

import pytest

from quickterm import config as cfgmod
from quickterm.config import AppConfig, Profile, load_config, save_config


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_config_dir_created(fake_appdata):
    d = cfgmod.config_dir()
    assert d == fake_appdata / "quickterm"
    assert d.is_dir()


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
