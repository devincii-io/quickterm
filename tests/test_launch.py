"""The one launch resolver, and the app-side launches that now go through it."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import types
from dataclasses import dataclass, field

import pytest

from quickterm import launch, putty_tools
from quickterm import server as server_mod
from quickterm import workspace as real_workspace


@dataclass
class Prof:
    name: str
    cmd: str = ""
    args: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    terminal_type: str | None = None
    wsl_distro: str | None = None
    start_command: str | None = None
    claude_mode: str | None = None
    ssh_host: str | None = None
    ssh_port: int | None = None
    ssh_user: str | None = None
    ssh_key: str | None = None
    autostart: bool = False
    keybinding: str | None = None


@dataclass
class Cfg:
    profiles: list = field(default_factory=list)
    host: str = "127.0.0.1"
    port: int = 8620


@pytest.fixture(autouse=True)
def no_putty_tools(monkeypatch):
    monkeypatch.setattr(putty_tools, "tools_dir", lambda: None)
    monkeypatch.setattr(putty_tools, "plink_path", lambda: None)
    monkeypatch.setattr(putty_tools, "psftp_path", lambda: None)


@pytest.fixture
def putty_dir(monkeypatch, tmp_path):
    base = tmp_path / "putty"
    base.mkdir()
    for name in ("plink.exe", "pscp.exe", "psftp.exe"):
        (base / name).write_bytes(b"")
    monkeypatch.setattr(putty_tools, "tools_dir", lambda: base)
    monkeypatch.setattr(putty_tools, "plink_path", lambda: base / "plink.exe")
    monkeypatch.setattr(putty_tools, "psftp_path", lambda: base / "psftp.exe")
    return base


# --- every terminal type honours the start command it offers ----------------


def _inventory_type_ids() -> list[str]:
    windows = [
        "claude-code", "powershell-core", "windows-powershell", "command-prompt",
        "wsl", "git-bash", "nushell", "ssh", "sftp", "custom",
    ]
    # The POSIX inventory also lists the login shell under its own name; that
    # one depends on $SHELL, so only the fixed ids are pinned here.
    posix = ["claude-code", "zsh", "bash", "fish", "custom"]
    return sorted(set(windows) | set(posix))


@pytest.mark.skipif(os.name != "nt", reason="the Windows inventory probes Windows paths")
def test_the_pinned_ids_cover_the_windows_inventory(monkeypatch):
    def no_wsl(*_args, **_kwargs):
        raise OSError("not asked in tests")

    monkeypatch.setattr(server_mod.subprocess, "run", no_wsl)
    ids = {t["id"] for t in server_mod._terminal_inventory()["types"]}
    assert ids <= set(_inventory_type_ids())


# Settings hides the start-command field for exactly these kinds.
_NO_START_COMMAND = {"custom", "sftp", "claude-code"}


@pytest.mark.parametrize("type_id", _inventory_type_ids())
def test_every_inventory_type_resolves_and_runs_its_start_command(type_id, putty_dir, tmp_path):
    prof = Prof(
        name="t", cmd="shell-binary", terminal_type=type_id,
        start_command="echo marker", ssh_host="box",
    )
    cmd, args, _cwd = launch.resolve_profile(prof, str(tmp_path))
    assert cmd
    # Settings shows "<exe> then <start>" for every other kind; it must run.
    runs = any("echo marker" in arg for arg in args)
    assert runs is (type_id not in _NO_START_COMMAND), (type_id, args)


def test_git_bash_gets_the_bash_start_command_treatment():
    prof = Prof(
        name="git", cmd=r"C:\Program Files\Git\bin\bash.exe", terminal_type="git-bash",
        args=["-l"], start_command="uv run dev",
    )
    cmd, args, cwd = launch.resolve_profile(prof, "/tmp/x")
    assert cmd == r"C:\Program Files\Git\bin\bash.exe"
    # `exec bash`, not the Windows path, which has a space bash would split.
    assert args == ["-lc", "uv run dev; exec bash -l"]
    assert cwd == "/tmp/x"
    prof.start_command = None
    assert launch.resolve_profile(prof)[1] == ["-l"]
    # Arguments set in Advanced survive, ahead of the command bash runs.
    prof.args = ["--norc", "-l"]
    prof.start_command = "make"
    assert launch.resolve_profile(prof)[1] == ["--norc", "-lc", "make; exec bash -l"]


def test_nushell_runs_the_start_command_and_stays_interactive():
    prof = Prof(name="nu", cmd="C:/nu/nu.exe", terminal_type="nushell", start_command="ls")
    assert launch.resolve_profile(prof) == ("C:/nu/nu.exe", ["-e", "ls"], None)
    prof.start_command = None
    assert launch.resolve_profile(prof) == ("C:/nu/nu.exe", [], None)
    assert launch.resolve_profile(Prof(name="nu", terminal_type="nushell"))[0] == "nu"


@pytest.mark.parametrize("type_id,default", [
    ("powershell-core", "pwsh.exe"),
    ("windows-powershell", "powershell.exe"),
    ("command-prompt", "cmd.exe"),
])
def test_system_shell_profiles_use_the_resolved_executable(type_id, default):
    # The inventory stores an absolute path on purpose (PATH is stale in a
    # tray-resident app); the bare name is only the fallback.
    absolute = r"C:\Program Files\PowerShell\7\pwsh.exe"
    assert launch.resolve_profile(Prof(name="p", cmd=absolute, terminal_type=type_id))[0] == absolute
    assert launch.resolve_profile(Prof(name="p", cmd="  ", terminal_type=type_id))[0] == default


def test_powershell_keeps_profile_args_without_a_second_nologo():
    prof = Prof(
        name="p", cmd="pwsh.exe", terminal_type="powershell-core",
        args=["-NoLogo", "-NoProfile"], start_command="uv run dev",
    )
    _cmd, args, _cwd = launch.resolve_profile(prof)
    # The profile's args sit before -Command: PowerShell reads everything
    # after -Command as the command text.
    assert args == ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "uv run dev"]
    prof.start_command = None
    assert launch.resolve_profile(prof)[1] == ["-NoLogo", "-NoProfile"]


def test_command_prompt_keeps_profile_args_before_the_start_command():
    prof = Prof(name="c", cmd="cmd.exe", terminal_type="command-prompt", args=["/Q"], start_command="dir")
    assert launch.resolve_profile(prof)[1] == ["/Q", "/K", "dir"]


def test_claude_code_needs_a_folder():
    with pytest.raises(ValueError, match="project folder"):
        launch.resolve_profile(Prof(name="c", cmd="claude", terminal_type="claude-code"))


# --- resolve(): the whole request ------------------------------------------


def test_request_folder_beats_the_workspace_root_beats_nothing(tmp_path):
    request_dir = tmp_path / "request"
    root = tmp_path / "root"
    request_dir.mkdir()
    root.mkdir()
    cfg = Cfg()
    spec = launch.resolve(cfg, cmd="sh", request_cwd=str(request_dir), workspace_root=str(root))
    assert spec.cwd == str(request_dir)
    assert launch.resolve(cfg, cmd="sh", workspace_root=str(root)).cwd == str(root)
    assert launch.resolve(cfg, cmd="sh").cwd is None


def test_a_missing_request_folder_names_the_terminal(tmp_path):
    cfg = Cfg(profiles=[Prof(name="api", cmd="cmd.exe")])
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(cfg, profile="api", request_cwd=str(tmp_path / "gone"))
    assert str(caught.value).startswith('Terminal "api": starting folder does not exist')
    assert caught.value.status == 400


def test_unknown_profile_is_a_404():
    with pytest.raises(launch.LaunchError) as caught:
        launch.resolve(Cfg(), profile="nope")
    assert caught.value.status == 404


def test_profile_env_is_validated_and_request_env_overrides_it():
    cfg = Cfg(profiles=[Prof(name="p", cmd="sh", env={"A": "1"})])
    assert launch.resolve(cfg, profile="p").env == {"A": "1"}
    assert launch.resolve(cfg, profile="p", env={"B": "2"}).env == {"B": "2"}
    with pytest.raises(launch.LaunchError, match="invalid env"):
        launch.resolve(cfg, cmd="sh", env={"BAD=NAME": "x"})


def test_putty_tools_are_appended_to_the_path_key_whatever_its_case(putty_dir, monkeypatch):
    monkeypatch.setenv("PATH", "base")
    spec = launch.resolve(Cfg(), cmd="sh", env={"Path": "profile"})
    # One entry, the profile's spelling kept, the tools last.
    assert spec.env == {"Path": f"profile{os.pathsep}{putty_dir}"}
    assert launch.resolve(Cfg(), cmd="sh").env == {"PATH": f"base{os.pathsep}{putty_dir}"}
    assert launch.resolve(Cfg(), cmd="sh", append_tools=False).env == {}


def test_label_is_profile_then_name_then_command():
    cfg = Cfg(profiles=[Prof(name="prof", cmd="sh")])
    assert launch.resolve(cfg, profile="prof", name="given").label == "prof"
    assert launch.resolve(cfg, cmd="sh", name="given").label == "given"
    assert launch.resolve(cfg, cmd=" sh ").label == "sh"


@pytest.mark.skipif(os.name != "nt", reason="the current-folder lookup is Windows behaviour")
def test_hardened_process_no_longer_finds_programs_in_the_launch_folder(monkeypatch, tmp_path):
    from quickterm import app as app_mod

    launch_dir = tmp_path / "Downloads"
    launch_dir.mkdir()
    (launch_dir / "claude.exe").write_bytes(b"")
    home = tmp_path / "home"
    home.mkdir()
    empty_path = tmp_path / "bin"
    empty_path.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("PATH", str(empty_path))
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
    monkeypatch.chdir(launch_dir)
    # The hazard: an Explorer launch leaves the process in that folder, and a
    # planted claude.exe there wins over PATH.
    assert shutil.which("claude") is not None
    environment = dict(os.environ)

    app_mod._harden_program_lookup()

    assert os.path.samefile(os.getcwd(), home)
    assert shutil.which("claude") is None
    # Nothing leaks into what the app starts: an environment variable would
    # reach every terminal and the relaunched app after an update.
    assert dict(os.environ) == environment


# --- app launches: autostart, hotkeys, the elevated first terminal ----------


class _Manager:
    def __init__(self, fail: Exception | None = None) -> None:
        self.spawned: list[dict] = []
        self.fail = fail

    async def spawn_async(self, **kwargs):
        if self.fail is not None:
            raise self.fail
        self.spawned.append(kwargs)
        return types.SimpleNamespace(id="s1", **kwargs)


async def test_autostart_failure_is_reported_not_swallowed():
    from quickterm import app as app_mod

    cfg = Cfg(profiles=[Prof(name="Claude", cmd="claude", terminal_type="claude-code", autostart=True)])
    manager = _Manager()
    await app_mod._spawn_autostart(manager, cfg)
    assert manager.spawned == []
    assert cfg.launch_error == 'Terminal "Claude": Claude Code profile requires a project folder'


async def test_autostart_spawn_error_names_the_terminal():
    from quickterm import app as app_mod
    from quickterm.session_manager import SpawnError

    cfg = Cfg(profiles=[Prof(name="Tools", cmd="missing-xyz", autostart=True)])
    await app_mod._spawn_autostart(_Manager(SpawnError("command not found: missing-xyz")), cfg)
    assert cfg.launch_error == 'Terminal "Tools": command not found: missing-xyz'


async def test_autostart_launch_matches_a_ui_launch(putty_dir, monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setenv("PATH", "base")
    cfg = Cfg(profiles=[Prof(
        name="dev", cmd="pwsh.exe", terminal_type="powershell-core", start_command="uv run dev",
        autostart=True,
    )])
    manager = _Manager()
    await app_mod._spawn_autostart(manager, cfg)
    assert manager.spawned == [{
        "name": "dev", "profile": "dev", "cmd": "pwsh.exe",
        "args": ["-NoLogo", "-NoExit", "-Command", "uv run dev"], "cwd": None,
        # The bundled tools are on PATH here too, as for every other launch.
        "env": {"PATH": f"base{os.pathsep}{putty_dir}"},
    }]
    assert getattr(cfg, "launch_error", None) is None


async def test_a_hotkey_schedules_the_launch_off_the_hotkey_callback():
    from quickterm import app as app_mod

    prof = Prof(name="sh", cmd="sh")
    cfg = Cfg(profiles=[prof])
    manager = _Manager()
    fire = app_mod._profile_callback(asyncio.get_running_loop(), manager, prof, cfg)
    fire()
    assert manager.spawned == []  # the callback itself never blocks the loop
    for _ in range(100):
        if manager.spawned:
            break
        await asyncio.sleep(0.01)
    assert manager.spawned[0]["cmd"] == "sh"


async def test_the_elevated_first_terminal_is_resolved_and_checked(putty_dir, tmp_path, monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setenv("PATH", "base")
    server = types.SimpleNamespace(started=True)
    manager = _Manager()
    cfg = Cfg()
    spec = {"cmd": "cmd.exe", "args": ["/K"], "cwd": str(tmp_path), "env": {}, "name": "Administrator - cmd"}
    await app_mod._after_ready(server, manager, cfg, launch_window=False, initial_launch=spec)
    assert manager.spawned[0]["cwd"] == str(tmp_path)
    assert manager.spawned[0]["name"] == "Administrator - cmd"
    assert manager.spawned[0]["env"]["PATH"].endswith(str(putty_dir))

    gone = dict(spec, cwd=str(tmp_path / "gone"))
    await app_mod._after_ready(server, _Manager(), cfg, launch_window=False, initial_launch=gone)
    assert "starting folder does not exist" in cfg.launch_error


def test_an_elevated_instance_uses_its_own_workspace_folder_before_touching_scratch(monkeypatch):
    from quickterm import app as app_mod

    calls: list[tuple] = []
    monkeypatch.setattr(real_workspace, "set_namespace", lambda name: calls.append(("ns", name)))
    monkeypatch.setattr(real_workspace, "delete_workspace", lambda name: calls.append(("del", name)))
    monkeypatch.setitem(sys.modules, "quickterm.workspace", real_workspace)

    app_mod._prepare_workspaces(elevated=True)
    assert calls == [("ns", "elevated"), ("del", "scratch")]

    calls.clear()
    app_mod._prepare_workspaces(elevated=False)
    assert calls == [("del", "scratch")]


def test_the_reaper_protects_every_referenced_session(monkeypatch):
    from quickterm import app as app_mod

    monkeypatch.setattr(real_workspace, "referenced_session_ids", lambda: {"a", ".b"})
    seen = {}

    class Manager:
        def reap_idle(self, timeout, protected):
            seen.update(timeout=timeout, protected=protected)
            return []

    app_mod._reap_pass(Manager(), 300)
    assert seen == {"timeout": 300, "protected": {"a", ".b"}}
