"""The settings history: what save_config keeps, what the list says, restoring."""

from __future__ import annotations

import json
import os
import re

import pytest
from fastapi.testclient import TestClient

from quickterm import config as cfgmod
from quickterm.config import AppConfig, Profile, config_history, load_history_entry, save_config
from quickterm.server import create_app
from tests.test_server import FakeConfig, FakeSessionManager


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def history_files(fake_appdata):
    folder = fake_appdata / "quickterm" / "history"
    return sorted(folder.glob("*.json")) if folder.is_dir() else []


@pytest.fixture
def sealed(monkeypatch):
    """A stand-in DPAPI whose output differs on every call, like the real one."""
    counter = iter(range(1_000_000))
    monkeypatch.setattr(cfgmod.secret_store, "protection_available", lambda: True)
    monkeypatch.setattr(
        cfgmod.secret_store, "protect", lambda data: b"%d:" % next(counter) + data,
    )
    monkeypatch.setattr(
        cfgmod.secret_store, "unprotect", lambda data: data.split(b":", 1)[1],
    )


def test_each_save_that_changes_something_keeps_the_replaced_version(fake_appdata):
    save_config(AppConfig(font_size=12))
    assert history_files(fake_appdata) == []  # the first save replaced nothing
    first = (fake_appdata / "quickterm" / "config.json").read_text(encoding="utf-8")
    save_config(AppConfig(font_size=15))
    save_config(AppConfig(font_size=15))  # changes nothing: no entry
    files = history_files(fake_appdata)
    assert len(files) == 1
    assert files[0].read_text(encoding="utf-8") == first


def test_an_unchanged_save_with_secrets_adds_no_entry(fake_appdata, sealed):
    profiles = [Profile(name="work", cmd="cmd.exe", env={"TOKEN": "secret"})]
    save_config(AppConfig(profiles=profiles, font_size=12))
    save_config(AppConfig(profiles=profiles, font_size=13))
    save_config(AppConfig(profiles=profiles, font_size=13))
    files = history_files(fake_appdata)
    assert len(files) == 1
    # The entry is the stored file: its secret is still protected.
    text = files[0].read_text(encoding="utf-8")
    assert '"secret"' not in text
    assert json.loads(text)["profiles"][0]["env"]["TOKEN"]["protected"] == "dpapi-v1"


def test_only_the_newest_twenty_are_kept(fake_appdata):
    for seconds in range(cfgmod.HISTORY_KEEP + 5):
        save_config(AppConfig(idle_timeout_s=seconds))
    files = history_files(fake_appdata)
    assert len(files) == cfgmod.HISTORY_KEEP
    # The oldest versions went first.
    kept = sorted(json.loads(path.read_text(encoding="utf-8"))["idle_timeout_s"] for path in files)
    assert kept == list(range(4, cfgmod.HISTORY_KEEP + 4))


def test_the_list_is_newest_first_with_what_restoring_would_change(fake_appdata):
    save_config(AppConfig(theme="graphite"))
    saved_theme = os.stat(fake_appdata / "quickterm" / "config.json").st_mtime_ns
    save_config(AppConfig(theme="nord"))
    save_config(AppConfig(theme="nord", profiles=[Profile(name="work", cmd="cmd.exe")]))

    entries = config_history()
    assert [entry["summary"] for entry in entries] == ["profiles", "theme"]
    assert entries[0]["id"] > entries[1]["id"]
    for entry in entries:
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", entry["saved_at"])
    # saved_at is when that version was saved, not when it was replaced.
    oldest = entries[1]
    stored = os.stat(fake_appdata / "quickterm" / "history" / f"{oldest['id']}.json")
    assert stored.st_mtime_ns == saved_theme


def test_summaries_compare_decrypted_values(fake_appdata, sealed):
    profiles = [Profile(name="work", cmd="cmd.exe", env={"TOKEN": "secret"})]
    save_config(AppConfig(profiles=profiles, font_size=12))
    save_config(AppConfig(profiles=profiles, font_size=13))
    assert [entry["summary"] for entry in config_history()] == ["font_size"]


def test_a_history_entry_is_found_by_id_only(fake_appdata):
    save_config(AppConfig(font_size=12))
    save_config(AppConfig(font_size=13))
    entry_id = config_history()[0]["id"]
    assert load_history_entry(entry_id)["font_size"] == 12
    for bad in ("../config", "0" * 20, "abc", ""):
        with pytest.raises(KeyError):
            load_history_entry(bad)


def test_a_failed_history_write_never_fails_the_save(fake_appdata, monkeypatch):
    save_config(AppConfig(font_size=12))
    real = cfgmod._atomic_write

    def refuse_history(path, text):
        if path.parent.name == "history":
            raise PermissionError(13, "denied")
        real(path, text)

    monkeypatch.setattr(cfgmod, "_atomic_write", refuse_history)
    save_config(AppConfig(font_size=14))
    assert cfgmod.load_config().font_size == 14


# --- routes -------------------------------------------------------------------


@pytest.fixture
def client():
    live = FakeConfig()
    manager = FakeSessionManager()
    with TestClient(create_app(manager, live), base_url="http://127.0.0.1:8620") as c:
        c.live = live
        yield c


def test_history_route_lists_entries(client):
    save_config(AppConfig(theme="graphite"))
    save_config(AppConfig(theme="nord"))
    body = client.get("/api/config/history").json()
    assert [entry["summary"] for entry in body] == ["theme"]
    assert set(body[0]) == {"id", "saved_at", "summary"}


def test_restoring_goes_through_the_save_path_and_applies_live(client, fake_appdata):
    save_config(AppConfig(theme="graphite", font_size=12))
    save_config(AppConfig(theme="nord", font_size=16))
    entry_id = client.get("/api/config/history").json()[0]["id"]

    response = client.post(f"/api/config/history/{entry_id}/restore")
    assert response.status_code == 204
    assert cfgmod.load_config().theme == "graphite"
    assert client.live.theme == "graphite"
    assert client.live.font_size == 12
    # The version the restore replaced is itself in the history now.
    entries = client.get("/api/config/history").json()
    assert len(entries) == 2
    assert entries[0]["summary"] == "font_size, theme"


def test_restoring_an_unknown_version_is_404(client):
    assert client.post("/api/config/history/00000000000000000001/restore").status_code == 404
    assert client.post("/api/config/history/nonsense/restore").status_code == 404


def test_restoring_an_invalid_version_is_400(client, fake_appdata):
    save_config(AppConfig(font_size=12))
    save_config(AppConfig(font_size=13))
    entry_id = client.get("/api/config/history").json()[0]["id"]
    path = fake_appdata / "quickterm" / "history" / f"{entry_id}.json"
    path.write_text(json.dumps({"font_size": 99}), encoding="utf-8")
    response = client.post(f"/api/config/history/{entry_id}/restore")
    assert response.status_code == 400
    assert cfgmod.load_config().font_size == 13


def test_history_routes_are_token_gated():
    manager = FakeSessionManager()
    with TestClient(create_app(manager, FakeConfig(), "tok"), base_url="http://127.0.0.1:8620") as c:
        assert c.get("/api/config/history").status_code in (401, 403)
        assert c.post("/api/config/history/1/restore").status_code in (401, 403)
