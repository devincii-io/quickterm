"""Connection arguments, validation and separation of desktop windows from PTYs."""

from dataclasses import replace

import pytest

from quickterm import connections, launch
from quickterm.config import AppConfig, Profile, config_from_dict, validate_config


@pytest.mark.parametrize("kind", ["docker", "podman"])
def test_container_arguments_keep_names_and_executable_paths_as_single_arguments(kind):
    profile = Profile("Container", "C:/tools/client.exe", terminal_type=kind,
                      connection={"target": "service container", "shell": "/bin/bash", "user": "1000"})
    assert connections.resolve(profile, "C:/project") == (
        "C:/tools/client.exe", ["exec", "-it", "--user", "1000", "service container", "/bin/bash"], "C:/project",
    )


def test_kubernetes_context_namespace_and_container_are_explicit():
    profile = Profile("Pod", "", terminal_type="kubernetes", connection={
        "target": "api-1", "context": "development", "namespace": "services", "container": "app",
    })
    assert connections.resolve(profile, None) == (
        "kubectl", ["--context", "development", "--namespace", "services", "exec", "-it", "-c", "app", "api-1", "--", "/bin/sh"], None,
    )


def test_serial_and_telnet_use_the_bundled_client(monkeypatch):
    monkeypatch.setattr(connections.putty_tools, "plink_path", lambda: "C:/PuTTY/plink.exe")
    serial = Profile("Device", "", terminal_type="serial", connection={"device": "COM4", "baud": "115200"})
    assert connections.resolve(serial, None)[1] == ["-serial", "COM4", "-sercfg", "115200,8,n,1,N"]
    telnet = Profile("Console", "", terminal_type="telnet", connection={"host": "switch.local", "port": "2323"})
    assert connections.resolve(telnet, None)[1] == ["-telnet", "-P", "2323", "switch.local"]


@pytest.mark.parametrize("kind, options", [
    ("serial", {"device": "COM4", "baud": "zero"}), ("serial", {"device": "COM4", "parity": "invalid"}),
    ("docker", {}), ("telnet", {"host": "host", "port": "65536"}), ("rdp", {}),
])
def test_invalid_connection_fields_are_rejected_before_saving(kind, options):
    with pytest.raises(ValueError):
        validate_config(AppConfig(profiles=[Profile("Broken", "", terminal_type=kind, connection=options)]))


def test_connection_settings_round_trip_and_legacy_profiles_still_load():
    cfg = config_from_dict({"profiles": [{"name": "Pod", "cmd": "kubectl", "terminal_type": "kubernetes", "connection": {"target": "api"}}, {"name": "Legacy", "cmd": "cmd.exe"}]})
    assert cfg.profiles[0].connection == {"target": "api"}
    assert cfg.profiles[1].connection == {}


def test_desktop_connections_never_start_as_terminal_profiles(monkeypatch):
    profile = Profile("Desktop", "viewer.exe", terminal_type="vnc", connection={"host": "server", "port": "5901"})
    with pytest.raises(ValueError, match="separate client window"):
        launch.resolve_profile(profile)
    calls = []
    monkeypatch.setattr(connections.shutil, "which", lambda executable: executable)
    monkeypatch.setattr(connections.subprocess, "Popen", lambda argv, **kwargs: calls.append((argv, kwargs)) or type("Process", (), {"pid": 42})())
    assert connections.open_desktop(profile)["external"] is True
    assert calls[0][0] == ["viewer.exe", "server::5901"]
    with pytest.raises(ValueError, match="terminal"):
        connections.open_desktop(replace(profile, terminal_type="ssh"))
