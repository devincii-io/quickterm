import pytest

from quickterm import assets


@pytest.fixture(autouse=True)
def fake_appdata(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    return tmp_path


def test_save_and_resolve_asset():
    asset_id = assets.save_asset(b"image-bytes", "image/png")
    assert asset_id.endswith(".png")
    assert assets.asset_path(asset_id).read_bytes() == b"image-bytes"
    assert assets.content_type_for(asset_id) == "image/png"


@pytest.mark.parametrize("content_type", ["text/html", "application/javascript", ""])
def test_rejects_unsafe_asset_types(content_type):
    with pytest.raises(ValueError, match="unsupported image type"):
        assets.save_asset(b"nope", content_type)


def test_rejects_oversized_and_traversal():
    with pytest.raises(ValueError, match="too large"):
        assets.save_asset(b"x" * (assets.MAX_ASSET_BYTES + 1), "image/webp")
    assert assets.asset_path("../secret.png") is None


def test_packaged_brand_assets_exist_and_are_wired_into_frontend():
    from pathlib import Path

    frontend = Path("quickterm/frontend")
    assert (frontend / "assets/icon-16.png").read_bytes().startswith(b"\x89PNG")
    assert (frontend / "assets/icon-32.png").read_bytes().startswith(b"\x89PNG")
    assert Path("quickterm/resources/quickterm.ico").read_bytes().startswith(b"\x00\x00\x01\x00")
    html = (frontend / "index.html").read_text(encoding="utf-8")
    assert 'href="/assets/icon-32.png"' in html
