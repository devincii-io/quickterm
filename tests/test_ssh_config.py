"""~/.ssh/config parsing, `ssh -G` resolution and the OpenSSH client lookup."""

from __future__ import annotations

import os
import subprocess
import types
from pathlib import Path

import pytest

from quickterm import ssh_config


def _entries(text: str, base: Path, **kwargs) -> dict[str, dict]:
    return {e.alias: vars(e) for e in ssh_config.parse(text, base_dir=base, **kwargs)}


def test_comments_equals_quotes_and_case_insensitive_keywords(tmp_path):
    entries = _entries(
        "# my hosts\n"
        "\n"
        "HOST devbox   # trailing comment\n"
        "  hostname=10.0.0.5\n"
        "  User = deploy\n"
        "\tPORT 2222\n"
        '  IdentityFile "~/.ssh/my key"\n'
        "  ProxyJump admin@bastion:22,jump2\n",
        tmp_path,
    )
    assert entries == {"devbox": {
        "alias": "devbox", "hostname": "10.0.0.5", "user": "deploy", "port": 2222,
        "identity_file": os.path.expanduser("~/.ssh/my key"), "proxy_jump": "admin@bastion:22,jump2",
    }}


def test_first_value_wins_across_matching_blocks(tmp_path):
    entries = _entries(
        "User everyone\n"
        "Host web\n"
        "  HostName web.example.com\n"
        "  HostName ignored.example.com\n"
        "  IdentityFile ~/.ssh/first\n"
        "  IdentityFile ~/.ssh/second\n"
        "Host *\n"
        "  Port 2200\n"
        "  User late\n",
        tmp_path,
    )
    web = entries["web"]
    assert web["hostname"] == "web.example.com"
    assert web["user"] == "everyone"  # set before any Host line, so it came first
    assert web["port"] == 2200  # from the wildcard block, which still applies
    assert web["identity_file"] == os.path.expanduser("~/.ssh/first")


def test_wildcards_negations_and_duplicates_are_not_aliases(tmp_path):
    entries = _entries(
        "Host a b *.corp ?x !c\n"
        "  User u\n"
        "Host b\n"
        "  User other\n"
        "Host !a *\n"
        "  Port 23\n",
        tmp_path,
    )
    assert list(entries) == ["a", "b"]
    assert entries["b"]["user"] == "u"
    # `!a` excludes a from the last block, b still gets its port.
    assert entries["a"]["port"] is None
    assert entries["b"]["port"] == 23


def test_match_blocks_are_skipped_until_the_next_host(tmp_path):
    entries = _entries(
        "Host first\n"
        "  User one\n"
        "Match host first exec \"true\"\n"
        "  User fromMatch\n"
        "  Port 99\n"
        "Host first\n"
        "  Port 22\n",
        tmp_path,
    )
    assert entries["first"]["user"] == "one"
    assert entries["first"]["port"] == 22


def test_proxyjump_none_and_hostname_token(tmp_path):
    entries = _entries("Host direct\n  ProxyJump none\n  HostName %h.lan\n", tmp_path)
    assert entries["direct"]["proxy_jump"] is None
    assert entries["direct"]["hostname"] == "direct.lan"


def test_include_follows_globs_relative_to_the_ssh_folder(tmp_path):
    (tmp_path / "conf.d").mkdir()
    (tmp_path / "conf.d" / "10-work.conf").write_text("Host work\n  User w\n")
    (tmp_path / "conf.d" / "20-home.conf").write_text("Host home\n  User h\n")
    (tmp_path / "extra").write_text("Host extra\n  Port 2022\n")
    entries = _entries(f"Include conf.d/*.conf {tmp_path / 'extra'} missing\nHost last\n", tmp_path)
    assert list(entries) == ["work", "home", "extra", "last"]
    assert entries["home"]["user"] == "h"
    assert entries["extra"]["port"] == 2022


def test_include_loops_and_depth_are_bounded(tmp_path):
    (tmp_path / "a").write_text("Include b\nHost from-a\n")
    (tmp_path / "b").write_text("Include a\nHost from-b\n")
    reads = []

    def read(path):
        reads.append(path.name)
        return path.read_text()

    entries = _entries("Include a\n", tmp_path, read=read)
    assert list(entries) == ["from-b", "from-a"]
    assert reads == ["a", "b"]  # a is not read again from b
    # A chain deeper than the cap stops quietly instead of recursing.
    for i in range(12):
        (tmp_path / f"d{i}").write_text(f"Include d{i + 1}\nHost deep{i}\n")
    deep = _entries("Include d0\n", tmp_path)
    assert len(deep) == ssh_config.MAX_INCLUDE_DEPTH


def test_the_host_state_before_an_include_comes_back_after_it(tmp_path):
    # OpenSSH's readconf restores the active flag after an included file, so
    # a top-level line after the Include applies to every host, not only to
    # the Host block the included file ended in.
    (tmp_path / "conf.d").mkdir()
    (tmp_path / "conf.d" / "work").write_text("Host jump\n  Port 2200\n")
    entries = _entries("Include conf.d/*\nUser alice\nHost box\n  HostName box.example\n", tmp_path)
    assert entries["jump"]["user"] == "alice"
    assert entries["box"]["user"] == "alice"
    assert entries["box"]["port"] is None


def test_an_include_in_another_hosts_block_never_matches_inside(tmp_path):
    # ssh reads such a file with SSHCONF_NEVERMATCH: its Host lines select
    # nothing, so "hidden" is no alias and its Port never reaches "box".
    (tmp_path / "inner").write_text("Host hidden\n  User nobody\nHost box\n  Port 2022\n")
    entries = _entries("Host gate\n  Include inner\n  User g\nHost box\n  User b\n", tmp_path)
    assert list(entries) == ["gate", "box"]
    assert entries["gate"]["user"] == "g"
    assert (entries["box"]["user"], entries["box"]["port"]) == ("b", None)


def test_hosts_reads_the_file_and_tolerates_its_absence(tmp_path):
    path = tmp_path / "config"
    assert ssh_config.hosts(path) == []
    path.write_text("Host devbox\n  HostName 10.1.1.1\n", encoding="utf-8")
    assert ssh_config.hosts(path) == [{
        "alias": "devbox", "hostname": "10.1.1.1", "user": None, "port": None,
        "identity_file": None, "proxy_jump": None,
    }]


@pytest.mark.parametrize(("alias", "ok"), [
    ("devbox", True), ("user@host:22", True), ("a.b-c_d%1", True),
    ("-oProxyCommand=x", False), ("two words", False), ("", False), ("x" * 256, False), (None, False),
])
def test_valid_alias(alias, ok):
    assert ssh_config.valid_alias(alias) is ok


def test_ssh_dump_output_is_parsed():
    dump = ssh_config.parse_dump(
        "host devbox\nuser deploy\nhostname 10.0.0.5\nport 2222\n"
        "identityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\nproxyjump none\nforwardagent no\n"
    )
    assert dump == {
        "hostname": "10.0.0.5", "user": "deploy", "port": 2222,
        "identity_files": [os.path.expanduser("~/.ssh/id_ed25519"), os.path.expanduser("~/.ssh/id_rsa")],
        "proxy_jump": None,
    }
    assert ssh_config.parse_dump("proxyjump a@b,c\n")["proxy_jump"] == "a@b,c"


def test_resolve_asks_ssh_without_a_console_window(monkeypatch, tmp_path):
    calls = []

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return types.SimpleNamespace(returncode=0, stdout=b"user me\nhostname 1.2.3.4\nport 22\n")

    config = tmp_path / "config"
    config.write_text("Host devbox\n  HostName 10.0.0.5\n")
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / "ssh.exe")
    monkeypatch.setattr(ssh_config.subprocess, "run", run)
    assert ssh_config.resolve("devbox") == {
        "alias": "devbox", "hostname": "1.2.3.4", "user": "me", "port": 22,
        "identity_files": [], "proxy_jump": None,
    }
    argv, kwargs = calls[0]
    assert argv == [str(tmp_path / "ssh.exe"), "-G", "devbox"]
    assert kwargs["timeout"] == 3.0
    assert kwargs["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)


@pytest.mark.parametrize("failure", ["missing", "exit", "timeout"])
def test_resolve_falls_back_to_the_parser(monkeypatch, tmp_path, failure):
    config = tmp_path / "config"
    config.write_text("Host devbox\n  HostName 10.0.0.5\n  IdentityFile ~/.ssh/k\n")
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)

    def run(argv, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(argv, 3)
        return types.SimpleNamespace(returncode=255, stdout=b"")

    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: None if failure == "missing" else tmp_path / "ssh")
    monkeypatch.setattr(ssh_config.subprocess, "run", run)
    assert ssh_config.resolve("devbox") == {
        "alias": "devbox", "hostname": "10.0.0.5", "user": None, "port": None,
        "identity_files": [os.path.expanduser("~/.ssh/k")], "proxy_jump": None,
    }
    with pytest.raises(KeyError):
        ssh_config.resolve("unknown")


def test_a_typo_is_unknown_although_ssh_would_print_defaults(monkeypatch, tmp_path):
    """`ssh -G` exits 0 for any name; a typo must not fill the Host fields
    with ssh's defaults."""
    config = tmp_path / "config"
    config.write_text("Host devbox\n  HostName 10.0.0.5\n")
    monkeypatch.setattr(ssh_config, "config_path", lambda: config)
    monkeypatch.setattr(ssh_config, "openssh_path", lambda kind: tmp_path / "ssh.exe")
    monkeypatch.setattr(ssh_config.subprocess, "run", lambda *a, **k: pytest.fail("ssh must not run"))
    with pytest.raises(KeyError):
        ssh_config.resolve("devbxo")


def test_resolve_refuses_an_alias_that_reads_as_an_option(monkeypatch):
    monkeypatch.setattr(ssh_config.subprocess, "run", lambda *a, **k: pytest.fail("ssh must not run"))
    with pytest.raises(ValueError):
        ssh_config.resolve("-oProxyCommand=calc")


@pytest.mark.skipif(os.name != "nt", reason="the OpenSSH optional feature lives in System32")
def test_openssh_prefers_the_windows_feature_then_path(monkeypatch, tmp_path):
    feature = tmp_path / "System32" / "OpenSSH"
    feature.mkdir(parents=True)
    (feature / "sftp.exe").write_bytes(b"")
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    monkeypatch.setattr(ssh_config.shutil, "which", lambda name: f"C:/git/usr/bin/{name}.exe")
    assert ssh_config.openssh_path("sftp") == feature / "sftp.exe"
    assert ssh_config.openssh_path("ssh") == Path("C:/git/usr/bin/ssh.exe")
    monkeypatch.setattr(ssh_config.shutil, "which", lambda name: None)
    assert ssh_config.openssh_path("ssh") is None


def test_openssh_on_path(monkeypatch, tmp_path):
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    monkeypatch.setattr(ssh_config.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert ssh_config.openssh_path("ssh") == Path("/usr/bin/ssh")
    with pytest.raises(ValueError):
        ssh_config.openssh_path("scp")
