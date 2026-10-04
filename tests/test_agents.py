"""Claude Code and Codex launch arguments, option validation and the catalog."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import pytest

from quickterm import agents
from quickterm.config import Profile

CWD = os.path.join(os.sep, "work", "project")
SESSION = "0199a3b2-7c41-7d10-9e55-2f1a3c4b5d6e"


def claude(mode=None, agent=None, args=None, cmd="C:/bin/claude.exe") -> Profile:
    return Profile(name="c", cmd=cmd, terminal_type="claude-code", agent_mode=mode,
                   agent=agent or {}, args=args or [])


def codex(mode=None, agent=None, args=None, cmd="C:/bin/codex.exe") -> Profile:
    return Profile(name="x", cmd=cmd, terminal_type="codex", agent_mode=mode,
                   agent=agent or {}, args=args or [])


# --- Claude Code argv ---------------------------------------------------------


@pytest.mark.parametrize(("mode", "expected"), [
    ("new", []),
    ("continue", ["--continue"]),
    (None, ["--continue"]),
    ("resume", ["--resume"]),
    ("agents", ["agents", "--cwd", CWD]),
])
def test_claude_modes(mode, expected):
    assert agents.resolve(claude(mode), CWD) == ("C:/bin/claude.exe", expected, CWD)


def test_claude_options_follow_the_mode_and_precede_the_profile_args():
    prof = claude("continue", {
        "model": "opus[1m]", "permission_mode": "manual", "effort": "xhigh",
        "session_name": "auth refactor", "add_dirs": "C:/libs\n\n  C:/docs  \n",
        "append_system_prompt": "Answer in German.", "agent": "reviewer",
        "mcp_config": "C:/mcp.json", "settings": "C:/s.json",
        "fork_session": "true", "verbose": "true", "ide": "false",
    }, args=["--debug"])
    assert agents.resolve(prof, CWD)[1] == [
        "--continue",
        "--model=opus[1m]", "--permission-mode=manual", "--effort=xhigh", "--name=auth refactor",
        "--add-dir=C:/libs", "--add-dir=C:/docs",
        "--append-system-prompt=Answer in German.", "--agent=reviewer",
        "--mcp-config=C:/mcp.json", "--settings=C:/s.json",
        "--fork-session", "--verbose",
        "--debug",
    ]


def test_claude_agents_mode_passes_only_the_dispatch_defaults():
    prof = claude("agents", {
        "model": "sonnet", "permission_mode": "plan", "effort": "low", "agent": "a",
        "session_name": "n", "verbose": "true", "add_dirs": "C:/x",
    })
    assert agents.resolve(prof, CWD)[1] == [
        "agents", "--cwd", CWD, "--model=sonnet", "--permission-mode=plan", "--effort=low", "--agent=a",
    ]


def test_claude_fork_session_only_applies_when_resuming():
    values = {"fork_session": "true"}
    assert agents.resolve(claude("new", values), CWD)[1] == []
    assert agents.resolve(claude("resume", values), CWD)[1] == ["--resume", "--fork-session"]


def test_claude_resumes_a_session_by_id():
    assert agents.resolve(claude("agents"), CWD, session=SESSION)[1] == ["--resume", SESSION]
    assert agents.resolve(claude(), CWD, mode="resume", session=SESSION)[1] == ["--resume", SESSION]
    with pytest.raises(ValueError, match="needs resume or fork"):
        agents.resolve(claude(), CWD, mode="continue", session=SESSION)


def test_a_legacy_claude_mode_field_is_read():
    @dataclass
    class Legacy:
        name: str = "old"
        cmd: str = "claude"
        terminal_type: str = "claude-code"
        claude_mode: str | None = "new"
        args: list = field(default_factory=list)

    assert agents.resolve(Legacy(), CWD, mode=None)[1] == []
    assert agents.resolve(Legacy(), CWD, mode="agents")[1] == ["agents", "--cwd", CWD]


# --- Codex argv ---------------------------------------------------------------


@pytest.mark.parametrize(("mode", "expected"), [
    ("new", ["--cd", CWD]),
    (None, ["--cd", CWD]),
    ("continue", ["resume", "--last", "--cd", CWD]),
    ("resume", ["resume", "--cd", CWD]),
    ("fork", ["fork", "--cd", CWD]),
    ("agents", ["agents"]),
])
def test_codex_modes(mode, expected):
    assert agents.resolve(codex(mode), CWD) == ("C:/bin/codex.exe", expected, CWD)


def test_codex_options_in_table_order_then_profile_args():
    prof = codex("resume", {
        "model": "gpt-6.1-sol", "approval": "on-request", "sandbox": "workspace-write",
        "approve_for_me": "true", "effort": "ultra", "search": "true", "config_profile": "work",
        "add_dirs": "C:/a\nC:/b", "worktree": "true", "no_alt_screen": "true", "oss": "true",
        "local_provider": "ollama",
    }, args=["--strict-config"])
    assert agents.resolve(prof, CWD, session=SESSION)[1] == [
        "resume", SESSION, "--cd", CWD,
        "--model", "gpt-6.1-sol", "--ask-for-approval", "on-request", "--sandbox", "workspace-write",
        "--approve-for-me", "--config", "model_reasoning_effort=ultra", "--search", "--profile", "work",
        "--add-dir", "C:/a", "--add-dir", "C:/b", "--worktree", "--no-alt-screen", "--oss",
        "--local-provider", "ollama",
        "--strict-config",
    ]


def test_codex_agents_mode_takes_no_options_and_no_folder_flag():
    prof = codex("agents", {"model": "m", "search": "true"}, args=["--x"])
    assert agents.resolve(prof, CWD)[1] == ["agents", "--x"]


def test_codex_forks_a_session_by_id():
    assert agents.resolve(codex(), CWD, mode="fork", session=SESSION)[1] == ["fork", SESSION, "--cd", CWD]
    assert agents.resolve(codex("fork"), CWD, session=SESSION)[1][:2] == ["resume", SESSION]


def test_codex_bypass_replaces_approval_and_sandbox():
    assert agents.resolve(codex(None, {"bypass": "true"}), CWD)[1] == [
        "--cd", CWD, "--dangerously-bypass-approvals-and-sandbox",
    ]
    for other in ({"approval": "never"}, {"sandbox": "read-only"}, {"approve_for_me": "true"}):
        with pytest.raises(ValueError, match="bypass replaces approval and sandbox; clear them first"):
            agents.validate(codex(None, {"bypass": "true", **other}))
    agents.validate(codex(None, {"bypass": "true", "approve_for_me": "false", "sandbox": ""}))


def test_a_folder_is_required():
    with pytest.raises(ValueError, match="^Claude Code profile requires a project folder$"):
        agents.resolve(claude(), None)
    with pytest.raises(ValueError, match="^Codex profile requires a project folder$"):
        agents.resolve(codex(), "  ")


# --- validation -------------------------------------------------------------------


@pytest.mark.parametrize(("prof", "message"), [
    (claude(None, {"unknown": "1"}), "unknown agent option: unknown"),
    (codex(None, {"permission_mode": "plan"}), "unknown agent option: permission_mode"),
    (claude(None, {"permission_mode": "default"}), "permission_mode must be"),
    (claude(None, {"effort": "ultracode"}), "effort must be"),
    (codex(None, {"approval": "untrusted"}), "approval must be"),
    (codex(None, {"sandbox": "full"}), "sandbox must be"),
    (codex(None, {"local_provider": "vllm", "oss": "true"}), "local_provider must be"),
    (codex(None, {"local_provider": "ollama"}), "local_provider needs oss"),
    (codex(None, {"effort": "High"}), "effort is not valid"),
    (claude(None, {"model": "opus; rm"}), "model is not valid"),
    (codex(None, {"model": "-c"}), "model must not start with -"),
    (codex(None, {"add_dirs": "C:/ok\n--yolo"}), "add_dirs lines must not start with -"),
    (claude(None, {"agent": "a b"}), "agent is not valid"),
    (codex(None, {"config_profile": "../x"}), "config_profile is not valid"),
    (claude(None, {"verbose": "yes"}), "verbose must be true or false"),
    (claude(None, {"session_name": "x" * 101}), "session_name cannot exceed 100"),
    (claude(None, {"session_name": "two\nlines"}), "session_name must be one line"),
    (claude(None, {"append_system_prompt": "x" * 4097}), "cannot exceed 4096"),
    (claude(None, {"add_dirs": "\n".join(f"C:/{i}" for i in range(17))}), "at most 16 lines"),
    (claude(None, {"add_dirs": "C:/" + "x" * 1024}), "cannot exceed 1024"),
    (claude(None, {"model": "a\0b"}), "model must be text"),
    (claude(None, {"model": 4}), "model must be text"),
    (claude("fork"), "Claude launch mode must be new, continue, resume, or agents"),
    (codex("later"), "Codex launch mode must be new, continue, resume, fork, or agents"),
])
def test_invalid_options_are_refused(prof, message):
    with pytest.raises(ValueError, match=message):
        agents.validate(prof)
    with pytest.raises(ValueError):
        agents.resolve(prof, CWD)


def test_empty_values_mean_unset():
    prof = claude("new", {key: "" for key in ("model", "permission_mode", "effort", "verbose", "add_dirs")})
    agents.validate(prof)
    assert agents.resolve(prof, CWD)[1] == []


def test_every_choice_is_accepted():
    for kind, make in (("claude-code", claude), ("codex", codex)):
        for option in agents.OPTIONS[kind]:
            for value, _label in option.choices:
                values = {option.key: value}
                if option.key == "local_provider":
                    values["oss"] = "true"
                agents.validate(make(None, values))


# --- the cmd.exe shim guard ------------------------------------------------------


@pytest.mark.parametrize("value", ['say "hi"', "a & b", "a|b", "<x>", "^", "100%", "wow!"])
def test_a_batch_shim_refuses_arguments_cmd_would_reinterpret(value):
    prof = claude("new", {"session_name": value}, cmd="C:/npm/claude.cmd")
    with pytest.raises(ValueError, match="contains characters cmd.exe would reinterpret"):
        agents.resolve(prof, CWD)
    # A native executable takes the same value untouched.
    assert agents.resolve(claude("new", {"session_name": value}), CWD)[1] == [f"--name={value}"]


def test_the_guard_covers_profile_args_and_the_folder(monkeypatch):
    with pytest.raises(ValueError, match="cmd.exe"):
        agents.resolve(codex("new", args=["a&b"], cmd="C:/npm/run.BAT"), CWD)
    with pytest.raises(ValueError, match="cmd.exe"):
        agents.resolve(codex("new", cmd="C:/npm/codex.cmd"), "C:/R&D")
    # A bare name is checked as what PATH resolves it to.
    monkeypatch.setattr(agents.shutil, "which", lambda name: "C:/npm/claude.CMD")
    with pytest.raises(ValueError, match="cmd.exe"):
        agents.resolve(claude("new", {"agent": "x"}, args=["%PATH%"], cmd="claude"), CWD)


# --- executables -----------------------------------------------------------------


def _npm_tree(tmp_path, arch_dir="codex-win32-x64", triple="x86_64-pc-windows-msvc"):
    shim = tmp_path / "npm" / "codex.cmd"
    shim.parent.mkdir(parents=True)
    shim.write_text("@echo off")
    native = (tmp_path / "npm" / "node_modules" / "@openai" / "codex" / "node_modules" / "@openai"
              / arch_dir / "vendor" / triple / "bin" / "codex.exe")
    native.parent.mkdir(parents=True)
    native.write_bytes(b"")
    return shim, native


@pytest.mark.skipif(os.name != "nt", reason="npm shims are a Windows install layout")
@pytest.mark.parametrize(("arch_dir", "triple"), [
    ("codex-win32-x64", "x86_64-pc-windows-msvc"),
    ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
])
def test_codex_prefers_the_native_exe_behind_the_npm_shim(tmp_path, monkeypatch, arch_dir, triple):
    shim, native = _npm_tree(tmp_path, arch_dir, triple)
    monkeypatch.setattr(agents.shutil, "which", lambda name: str(shim) if name == "codex" else None)
    assert agents.codex_executable() == str(native)
    # Settings stores the bare name; it resolves the same way.
    assert agents.resolve(codex("new", cmd="codex"), CWD)[0] == str(native)
    assert agents.resolve(codex("new", cmd=""), CWD)[0] == str(native)
    assert agents.resolve(codex("new", cmd=str(shim)), CWD)[0] == str(native)


def test_the_vendored_exe_gets_what_the_npm_shim_would_set(tmp_path):
    shim, native = _npm_tree(tmp_path, "codex-win32-x64", "x86_64-pc-windows-msvc")
    assert agents.codex_launch_env(str(native)) == {
        "CODEX_MANAGED_BY_NPM": "1",
        "CODEX_MANAGED_PACKAGE_ROOT": str(tmp_path / "npm" / "node_modules" / "@openai" / "codex"),
    }
    assert agents.codex_launch_env(str(shim)) == {}
    assert agents.codex_launch_env("codex") == {}
    assert agents.codex_launch_env(str(tmp_path / "bin" / "codex.exe")) == {}


def test_a_broken_models_cache_lists_no_models(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "models_cache.json").write_text(json.dumps({"models": [
        {"slug": "gpt-6", "visibility": "list", "supported_reasoning_levels": 3},
    ]}), encoding="utf-8")
    assert agents._codex_models()[0]["efforts"] == []
    (tmp_path / "models_cache.json").write_text("[" * 100_000, encoding="utf-8")
    assert agents._codex_models() == []


@pytest.mark.skipif(os.name != "nt", reason="npm shims are a Windows install layout")
def test_codex_falls_back_to_the_shim_then_the_bare_name(tmp_path, monkeypatch):
    shim = tmp_path / "codex.cmd"
    shim.write_text("@echo off")
    monkeypatch.setattr(agents.shutil, "which", lambda name: str(shim))
    assert agents.codex_executable() == str(shim)
    assert agents.resolve(codex("new", cmd=""), CWD)[0] == str(shim)
    monkeypatch.setattr(agents.shutil, "which", lambda name: None)
    assert agents.codex_executable() is None
    assert agents.resolve(codex("new", cmd=""), CWD)[0] == "codex"


def test_claude_uses_the_profile_command_then_path(monkeypatch):
    monkeypatch.setattr(agents.shutil, "which", lambda name: "/usr/bin/claude" if name == "claude" else None)
    assert agents.resolve(claude("new", cmd=""), CWD)[0] == "/usr/bin/claude"
    assert agents.resolve(claude("new", cmd="claude.exe"), CWD)[0] == "claude.exe"


# --- catalog -------------------------------------------------------------------


def test_catalog_lists_both_types_with_modes_and_options(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    monkeypatch.setattr(agents.shutil, "which", lambda name: f"/bin/{name}" if name == "claude" else None)
    (tmp_path / "models_cache.json").write_text(json.dumps({"models": [
        {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list",
         "default_reasoning_level": "high",
         "supported_reasoning_levels": [{"effort": "low"}, {"effort": "ultra"}]},
        {"slug": "hidden", "visibility": "hide"},
        {"slug": "bad slug", "visibility": "list"},
    ]}), encoding="utf-8")
    (tmp_path / "work.config.toml").write_text("")
    (tmp_path / "config.toml").write_text("")
    types = {entry["id"]: entry for entry in agents.catalog()["types"]}
    assert set(types) == {"claude-code", "codex"}
    claude_type, codex_type = types["claude-code"], types["codex"]
    assert (claude_type["executable"], claude_type["available"]) == ("/bin/claude", True)
    assert (codex_type["executable"], codex_type["available"]) == (None, False)
    assert claude_type["default_mode"] == "continue" and codex_type["default_mode"] == "new"
    assert [m["value"] for m in codex_type["modes"]] == ["new", "continue", "resume", "fork", "agents"]
    assert codex_type["modes"][2]["label"] == "choose session"
    options = {o["key"]: o for o in codex_type["options"]}
    assert options["model"]["choices"] == [
        {"value": "gpt-6.1-sol", "label": "GPT-6.1 Sol", "detail": "default effort high"},
    ]
    assert [c["value"] for c in options["effort"]["choices"]] == ["low", "medium", "high", "xhigh", "max", "ultra"]
    assert options["config_profile"]["choices"] == [{"value": "work", "label": "work"}]
    assert options["no_alt_screen"]["advanced"] is True
    claude_options = {o["key"]: o for o in claude_type["options"]}
    assert claude_options["permission_mode"]["choices"][0] == {"value": "manual", "label": "Manual: asks first"}
    assert "default" not in {c["value"] for c in claude_options["permission_mode"]["choices"]}
    assert all({"key", "label", "kind", "hint", "advanced"} <= set(o) for o in claude_type["options"])
    assert {o["kind"] for t in types.values() for o in t["options"]} <= {"choice", "combo", "text", "lines", "toggle"}


def test_catalog_survives_a_broken_codex_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing"))
    codex_type = next(t for t in agents.catalog()["types"] if t["id"] == "codex")
    options = {o["key"]: o for o in codex_type["options"]}
    assert options["model"]["choices"] == []
    (tmp_path / "models_cache.json").write_text("{not json")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert agents.catalog()["types"][1]["options"][0]["choices"] == []
