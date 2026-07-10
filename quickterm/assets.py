"""User-uploaded branding assets (logos) under %APPDATA%/quickterm/assets.

Assets are content-addressed by a short random id plus a type-derived
extension. Only a small allowlist of image types is accepted so the store can
never hold an executable or an oversized blob.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from .config import config_dir

MAX_ASSET_BYTES = 1024 * 1024  # 1 MB is plenty for a logo

# content-type -> extension. SVG is text/xml but treated as an image here.
_TYPES: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
}

_EXT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def assets_dir() -> Path:
    path = config_dir() / "assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def accepts(content_type: str) -> bool:
    return content_type.split(";")[0].strip().lower() in _TYPES


def save_asset(data: bytes, content_type: str) -> str:
    """Persist bytes, returning the asset id (filename). Raises ValueError."""
    ctype = content_type.split(";")[0].strip().lower()
    ext = _TYPES.get(ctype)
    if ext is None:
        raise ValueError(f"unsupported image type: {content_type}")
    if not data:
        raise ValueError("empty upload")
    if len(data) > MAX_ASSET_BYTES:
        raise ValueError("image too large (max 1 MB)")
    asset_id = uuid.uuid4().hex[:12] + ext
    (assets_dir() / asset_id).write_bytes(data)
    return asset_id


def asset_path(asset_id: str) -> Path | None:
    """Resolve an id to a file, guarding against path traversal."""
    name = Path(asset_id).name  # strip any directory components
    if name != asset_id or not name:
        return None
    path = assets_dir() / name
    return path if path.is_file() else None


def content_type_for(asset_id: str) -> str:
    return _EXT_TYPES.get(Path(asset_id).suffix.lower(), "application/octet-stream")


def delete_asset(asset_id: str) -> bool:
    path = asset_path(asset_id)
    if path is None:
        return False
    path.unlink()
    return True
