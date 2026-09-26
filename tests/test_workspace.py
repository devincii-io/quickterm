import json
import os
from pathlib import Path

import pytest

from quickterm import config as config_mod
from quickterm import workspace as workspace_mod
from quickterm.workspace import (
    Workspace,
    delete_workspace,
    layout_session_ids,
    list_workspaces,
    load_workspace,
    normalize_root,
    referenced_session_ids,
    resolve_start_dir,
    root_exists,
    save_workspace,
    set_namespace,
)

LAYOUT = {
    "type": "split",
    "dir": "h",
    "ratio": 0.5,
    "children": [
        {"type": "pane", "profile": "powershell", "cwd": "C:/dev"},
        {"type": "pane", "profile": "cmd", "cwd": None},
    ],
}


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    # The namespace is process state; a test that sets it must not leak it.
    monkeypatch.setattr(workspace_mod, "_NAMESPACE", None)
    return tmp_path


def workspace_files(root: Path) -> list[str]:
    return sorted(path.name for path in (root / "quickterm" / "workspaces").glob("*.json"))


def test_save_load_roundtrip():
    save_workspace(Workspace(name="main", layout=LAYOUT, logo="brand.svg", session_ids=["deadbeef"]))
    ws = load_workspace("main")
    assert ws is not None
    assert ws.name == "main"
    assert ws.layout == LAYOUT
    assert ws.logo == "brand.svg"
    assert ws.session_ids == ["deadbeef"]


def test_old_workspace_infers_session_ownership_from_layout(fake_appdata):
    path = fake_appdata / "quickterm" / "workspaces"
    path.mkdir(parents=True)
    legacy = {"name": "legacy", "layout": {"type": "pane", "session_id": "abc12345"}}
    (path / "legacy.json").write_text(json.dumps(legacy), encoding="utf-8")
    ws = load_workspace("legacy")
    assert ws is not None
    assert ws.session_ids == ["abc12345"]


def test_workspace_owned_detached_sessions_are_protected_from_reaping():
    save_workspace(Workspace(name="dev", layout={"type": "pane"}, session_ids=["detached1"]))
    assert "detached1" in referenced_session_ids()


def test_list_and_delete():
    save_workspace(Workspace(name="alpha", layout=LAYOUT))
    save_workspace(Workspace(name="beta", layout=LAYOUT))
    assert list_workspaces() == ["alpha", "beta"]
    delete_workspace("alpha")
    assert list_workspaces() == ["beta"]
    delete_workspace("nonexistent")  # no error


def test_load_missing_returns_none():
    assert load_workspace("nope") is None


def test_corrupt_workspace_does_not_break_other_workspaces(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "broken.json").write_text('{"layout":', encoding="utf-8")
    save_workspace(Workspace(name="healthy", layout=LAYOUT, session_ids=["live1"]))

    assert load_workspace("broken") is None
    assert load_workspace("healthy").session_ids == ["live1"]


def test_non_utf8_workspace_does_not_break_listing_or_loading(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "broken.json").write_bytes(b"\xff\xfe")
    save_workspace(Workspace(name="healthy", layout=LAYOUT))

    assert list_workspaces() == ["healthy"]
    assert load_workspace("broken") is None
    quarantined = list(folder.glob("broken.invalid-*.json"))
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == b"\xff\xfe"


def test_name_sanitized_to_safe_filename(fake_appdata):
    weird = 'my/ws:with*bad"chars?'
    save_workspace(Workspace(name=weird, layout=LAYOUT))
    files = list((fake_appdata / "quickterm" / "workspaces").glob("*.json"))
    assert len(files) == 1
    for ch in '/\\:*?"<>|':
        assert ch not in files[0].name
    ws = load_workspace(weird)
    assert ws is not None
    assert ws.name == weird  # original name preserved inside the file


def test_unsafe_names_cannot_overwrite_each_other(fake_appdata):
    first = "project:one"
    second = "project*one"
    save_workspace(Workspace(name=first, layout={"id": 1}))
    save_workspace(Workspace(name=second, layout={"id": 2}))

    assert list_workspaces() == sorted([first, second])
    assert load_workspace(first).layout == {"id": 1}
    assert load_workspace(second).layout == {"id": 2}
    assert len(list((fake_appdata / "quickterm" / "workspaces").glob("*.json"))) == 2


def test_legacy_sanitized_workspace_remains_readable_and_migrates(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    legacy = folder / "project_one.json"
    legacy.write_text(
        json.dumps({"name": "project:one", "layout": {"old": True}}), encoding="utf-8",
    )

    assert load_workspace("project:one").layout == {"old": True}
    save_workspace(Workspace(name="project:one", layout={"new": True}))

    assert not legacy.exists()
    assert load_workspace("project:one").layout == {"new": True}


def test_case_differing_names_do_not_share_a_file():
    """NTFS filenames are case-insensitive.

    "dev" and "Dev" resolved to the same path, so saving one silently
    destroyed the other's layout and its session-ownership list.
    """
    save_workspace(
        Workspace(name="dev", layout={"type": "pane", "profile": "a"}, session_ids=["a1"])
    )
    save_workspace(
        Workspace(name="Dev", layout={"type": "pane", "profile": "b"}, session_ids=["b1"])
    )

    lower = load_workspace("dev")
    upper = load_workspace("Dev")

    assert lower is not None and upper is not None
    assert lower.layout["profile"] == "a"
    assert upper.layout["profile"] == "b"
    assert lower.session_ids == ["a1"]
    assert upper.session_ids == ["b1"]
    assert sorted(list_workspaces()) == ["Dev", "dev"]


# --- workspaces are folders -------------------------------------------------


def test_workspace_path_roundtrips_and_normalizes(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    monkeypatch.setenv("QT_TEST_ROOT", str(project))
    variable = "%QT_TEST_ROOT%" if os.name == "nt" else "$QT_TEST_ROOT"
    save_workspace(Workspace(name="dev", layout=LAYOUT, path=variable))
    loaded = load_workspace("dev")
    assert loaded is not None
    assert loaded.path == str(project)
    assert json.loads((tmp_path / "quickterm" / "workspaces" / "dev.json").read_text())["path"] == str(project)


def test_workspace_without_path_stays_none():
    save_workspace(Workspace(name="plain", layout=LAYOUT))
    assert load_workspace("plain").path is None


def test_normalize_root_rejects_bad_values():
    assert normalize_root(None) is None
    assert normalize_root("   ") is None
    with pytest.raises(ValueError):
        normalize_root(5)
    with pytest.raises(ValueError):
        normalize_root("a" * 5000)
    with pytest.raises(ValueError):
        normalize_root("C:/dev\nrm")


def test_normalize_root_is_absolute():
    assert Path(normalize_root("relative/folder")).is_absolute()


def test_resolve_start_dir_is_the_workspace_root_or_nothing(tmp_path):
    # Profiles carry no folder, so the root is the whole answer: there is no
    # subfolder left to prefer and nothing to fall back to but the caller.
    root = tmp_path / "repo"
    root.mkdir(parents=True)
    assert resolve_start_dir(str(root)) == str(root)
    assert resolve_start_dir(None) is None
    assert resolve_start_dir("") is None
    assert resolve_start_dir(str(tmp_path / "missing")) is None


def test_root_exists(tmp_path):
    assert root_exists(str(tmp_path)) is True
    assert root_exists(str(tmp_path / "nope")) is False
    assert root_exists(None) is False


def test_hand_edited_bad_path_still_loads(tmp_path):
    save_workspace(Workspace(name="broken", layout=LAYOUT, path=str(tmp_path)))
    file = tmp_path / "quickterm" / "workspaces" / "broken.json"
    raw = json.loads(file.read_text())
    raw["path"] = 12
    file.write_text(json.dumps(raw))
    loaded = load_workspace("broken")
    assert loaded is not None and loaded.path is None


# --- corrupt files are set aside, never listed as ghosts (#47) ---------------


def test_a_corrupt_mixed_case_workspace_is_quarantined_not_listed(fake_appdata):
    save_workspace(Workspace(name="MyProject", layout=LAYOUT))
    folder = fake_appdata / "quickterm" / "workspaces"
    [stored] = folder.glob("*.json")
    stored.write_text('{"name": "MyPro', encoding="utf-8")

    # The stem already carries a digest, so listing it by filename produced a
    # name that load and delete hashed again and never found.
    assert list_workspaces() == []
    [quarantined] = folder.glob("*.invalid-*.json")
    assert quarantined.name.startswith(f"{stored.stem}.invalid-")
    assert quarantined.read_text(encoding="utf-8") == '{"name": "MyPro'
    # A second listing neither lists the quarantined copy nor renames it again.
    assert list_workspaces() == []
    assert list(folder.glob("*.json")) == [quarantined]

    save_workspace(Workspace(name="MyProject", layout={"fresh": True}))
    assert list_workspaces() == ["MyProject"]
    assert load_workspace("MyProject").layout == {"fresh": True}


def test_a_corrupt_workspace_survives_the_next_save_as_a_backup(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "dev.json").write_text("[1, 2", encoding="utf-8")

    assert load_workspace("dev") is None
    save_workspace(Workspace(name="dev", layout={"fresh": True}))

    assert load_workspace("dev").layout == {"fresh": True}
    [backup] = folder.glob("dev.invalid-*.json")
    assert backup.read_text(encoding="utf-8") == "[1, 2"


def test_a_valid_file_is_never_quarantined(fake_appdata):
    # A listing that read a corrupt file re-checks under the save lock before
    # renaming, so a document a save just put in place stays where it is.
    save_workspace(Workspace(name="dev", layout=LAYOUT))
    path = fake_appdata / "quickterm" / "workspaces" / "dev.json"
    workspace_mod._quarantine(path)
    assert workspace_files(fake_appdata) == ["dev.json"]


def test_a_document_its_own_name_does_not_lead_to_is_not_listed(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    stray = {"name": "Other", "layout": {}, "session_ids": ["kept-alive"]}
    (folder / "copied by hand.json").write_text(json.dumps(stray), encoding="utf-8")

    # Listed, it could be neither opened nor deleted under "Other".
    assert list_workspaces() == []
    # The reaper still errs towards protecting what it references.
    assert "kept-alive" in referenced_session_ids()


def test_a_nameless_document_is_listed_only_where_its_stem_leads(fake_appdata):
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    (folder / "plain.json").write_text(json.dumps({"layout": {"id": 1}}), encoding="utf-8")
    (folder / "Project.json").write_text(json.dumps({"layout": {"id": 2}}), encoding="utf-8")

    # "plain" opens plain.json; "Project" would look for its digest-suffixed
    # file and miss, so listing it would be a ghost.
    assert list_workspaces() == ["plain"]
    assert load_workspace("plain").layout == {"id": 1}
    assert load_workspace("Project") is None


# --- reserved device names (#52) --------------------------------------------


RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


@pytest.mark.parametrize("name", ["con", "con.txt", "aux.tools", "COM1.backup", "nul .x", "Lpt9"])
def test_a_reserved_device_name_never_leads_the_filename(fake_appdata, name):
    save_workspace(Workspace(name=name, layout={"name": name}))

    [filename] = workspace_files(fake_appdata)
    # Windows 10 resolves everything before the first dot, trailing spaces
    # ignored, to the device, so "con.txt--<digest>.json" still meant CON.
    assert filename.split(".", 1)[0].rstrip(" ").upper() not in RESERVED
    assert load_workspace(name).layout == {"name": name}
    assert list_workspaces() == [name]
    delete_workspace(name)
    assert workspace_files(fake_appdata) == []


def test_a_typed_underscore_name_does_not_collide_with_a_reserved_one():
    save_workspace(Workspace(name="con.txt", layout={"id": "device"}))
    save_workspace(Workspace(name="_con.txt", layout={"id": "typed"}))
    assert load_workspace("con.txt").layout == {"id": "device"}
    assert load_workspace("_con.txt").layout == {"id": "typed"}
    assert list_workspaces() == ["_con.txt", "con.txt"]


def test_windows_10_never_opens_a_legacy_name_that_is_a_device(fake_appdata, monkeypatch):
    # On Windows 10 "con.json" and "con.txt--<digest>.json" ARE the console:
    # reading one blocks, with the workspace lock held.
    monkeypatch.setattr(workspace_mod, "_DEVICE_NAMES_TAKE_EXTENSIONS", True)
    # "con--<digest>.json" (the old shape of a bare "con") is an ordinary file.
    digest = workspace_mod._digest("con")
    assert [p.name for p in workspace_mod._legacy_paths_for("con")] == [f"con--{digest}.json"]
    assert workspace_mod._legacy_paths_for("con.txt") == []
    assert load_workspace("con") is None
    save_workspace(Workspace(name="con", layout={"a": 1}))
    assert load_workspace("con").layout == {"a": 1}

    monkeypatch.setattr(workspace_mod, "_DEVICE_NAMES_TAKE_EXTENSIONS", False)
    assert [p.name for p in workspace_mod._legacy_paths_for("con")] == [
        "con.json", f"con--{digest}.json",
    ]


def test_the_old_reserved_file_shape_still_reads_and_migrates(fake_appdata, monkeypatch):
    # Windows 11 and POSIX, where such a file can exist.
    monkeypatch.setattr(workspace_mod, "_DEVICE_NAMES_TAKE_EXTENSIONS", False)
    folder = fake_appdata / "quickterm" / "workspaces"
    folder.mkdir(parents=True)
    old = folder / f"aux.tools--{workspace_mod._digest('aux.tools')}.json"
    old.write_text(json.dumps({"name": "aux.tools", "layout": {"old": True}}), encoding="utf-8")

    assert list_workspaces() == ["aux.tools"]
    assert load_workspace("aux.tools").layout == {"old": True}
    save_workspace(Workspace(name="aux.tools", layout={"new": True}))

    assert not old.exists()
    assert load_workspace("aux.tools").layout == {"new": True}
    assert len(workspace_files(fake_appdata)) == 1


# --- the shared helpers (K7) ------------------------------------------------


def test_layout_session_ids_walks_nested_splits():
    tree = {
        "type": "split",
        "children": [
            {"type": "pane", "session_id": "a"},
            {"type": "split", "children": [
                {"type": "pane", "session_id": "b"},
                {"type": "pane"},
                {"type": "pane", "session_id": ""},
                "junk",
            ]},
        ],
    }
    assert layout_session_ids(tree) == {"a", "b"}
    assert layout_session_ids(None) == set()
    assert layout_session_ids({"type": "split", "children": "nope"}) == set()


def test_referenced_session_ids_covers_layouts_lists_and_dot_names():
    # The reaper used to skip dot-prefixed names, a leftover of a ".scratch"
    # that no longer exists, which stripped protection from any such workspace.
    save_workspace(Workspace(name=".hand-made", layout={"type": "pane", "session_id": "p1"}))
    save_workspace(Workspace(name="scratch", layout={}, session_ids=["s1"]))
    assert referenced_session_ids() == {"p1", "s1"}


def test_referenced_session_ids_refuses_to_guess_past_an_unreadable_file(monkeypatch):
    save_workspace(Workspace(name="dev", layout={}, session_ids=["owned"]))

    def locked(path):
        raise PermissionError(13, "locked", str(path))

    monkeypatch.setattr(workspace_mod, "read_text", locked)
    # Dropping the file's sessions from the list would let the reaper kill
    # them; raising makes it skip the pass instead.
    with pytest.raises(OSError):
        referenced_session_ids()


# --- elevated namespace (#30) -----------------------------------------------


def test_the_elevated_namespace_keeps_its_own_files(fake_appdata):
    save_workspace(Workspace(name="scratch", layout={}, session_ids=["normal"]))
    save_workspace(Workspace(name="dev", layout={}))

    set_namespace("elevated")
    assert list_workspaces() == []
    assert load_workspace("dev") is None
    save_workspace(Workspace(name="scratch", layout={}, session_ids=["admin"]))
    assert referenced_session_ids() == {"admin"}
    # The elevated instance discards its own scratch at start and exit; that
    # used to delete the normal instance's live scratch.json.
    delete_workspace("scratch")
    assert list_workspaces() == []

    set_namespace(None)
    assert list_workspaces() == ["dev", "scratch"]
    assert load_workspace("scratch").session_ids == ["normal"]
    assert (fake_appdata / "quickterm" / "workspaces" / "elevated").is_dir()


@pytest.mark.parametrize("bad", ["../escape", "a/b", "a\\b", "..", "x y"])
def test_a_namespace_is_a_plain_folder_name(bad):
    with pytest.raises(ValueError):
        set_namespace(bad)


# --- sharing violations on Windows (#55) ------------------------------------


@pytest.fixture
def retrying(monkeypatch):
    # The retry is Windows behaviour behind a module flag, so it runs on every
    # platform here; the sleep is recorded instead of waited.
    monkeypatch.setattr(config_mod, "_RETRY_SHARING_VIOLATIONS", True)
    delays = []
    monkeypatch.setattr(config_mod.time, "sleep", delays.append)
    return delays


def flaky(real, failures):
    calls = []

    def wrapper(*args, **kwargs):
        calls.append(args)
        if len(calls) <= failures:
            raise PermissionError(13, "sharing violation")
        return real(*args, **kwargs)

    return wrapper, calls


def test_save_retries_a_replace_a_concurrent_reader_refused(retrying, monkeypatch):
    replace, calls = flaky(os.replace, failures=2)
    monkeypatch.setattr(os, "replace", replace)

    save_workspace(Workspace(name="dev", layout={"saved": True}))

    assert len(calls) == 3
    assert retrying == [0.02, 0.02]
    assert load_workspace("dev").layout == {"saved": True}


def test_save_gives_up_after_five_refusals_and_leaves_no_temp_file(
    fake_appdata, retrying, monkeypatch
):
    replace, calls = flaky(os.replace, failures=99)
    monkeypatch.setattr(os, "replace", replace)

    with pytest.raises(PermissionError):
        save_workspace(Workspace(name="dev", layout={}))

    assert len(calls) == 5
    assert list((fake_appdata / "quickterm" / "workspaces").iterdir()) == []


def test_without_the_windows_flag_a_refusal_is_not_retried(monkeypatch):
    monkeypatch.setattr(config_mod, "_RETRY_SHARING_VIOLATIONS", False)
    replace, calls = flaky(os.replace, failures=1)
    monkeypatch.setattr(os, "replace", replace)

    with pytest.raises(PermissionError):
        save_workspace(Workspace(name="dev", layout={}))
    assert len(calls) == 1


def test_a_read_that_races_a_replace_is_retried(retrying, monkeypatch):
    save_workspace(Workspace(name="dev", layout={"saved": True}))
    read, calls = flaky(Path.read_text, failures=2)
    monkeypatch.setattr(Path, "read_text", read)

    # Without the retry this answered "no such workspace", or the workspace
    # dropped out of the listing for one refresh.
    assert load_workspace("dev").layout == {"saved": True}
    assert len(calls) == 3
