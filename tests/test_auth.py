import os

from quickterm import auth


def test_token_is_created_once_and_not_put_in_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    first = auth.get_or_create_token()
    second = auth.get_or_create_token()

    assert first == second
    assert len(first) >= 32
    assert auth.token_path().read_text(encoding="utf-8") == first
    assert "QUICKTERM_TOKEN" not in os.environ


def test_existing_token_permissions_are_repaired_on_posix(tmp_path, monkeypatch):
    if os.name == "nt":
        return
    monkeypatch.setenv("APPDATA", str(tmp_path))
    path = auth.token_path()
    path.write_text("existing", encoding="utf-8")
    path.chmod(0o644)

    assert auth.get_or_create_token() == "existing"
    assert path.stat().st_mode & 0o777 == 0o600
