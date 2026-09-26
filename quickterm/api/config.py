"""Configuration routes: the live view, the saved file, saving it, its history."""

from __future__ import annotations

import asyncio
import importlib
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request, Response

from quickterm.api.common import asdict, read_json

if TYPE_CHECKING:
    from quickterm.api.context import ApiContext


def _voice_available() -> bool:
    try:
        import quickterm.voice as voice

        return bool(voice.voice_available())
    except Exception:
        return False


def _scratch_dir(cfg: Any) -> str:
    """Resolved scratch root, or "" if the folder cannot be created."""
    config_mod = importlib.import_module("quickterm.config")  # stubbable in tests
    try:
        return config_mod.scratch_root(getattr(cfg, "scratch_dir", "") or "")
    except (OSError, AttributeError):
        return ""


def register(app: FastAPI, ctx: ApiContext) -> None:
    manager = ctx.manager
    cfg = ctx.cfg
    elevated = ctx.elevated

    @app.get("/api/config")
    def get_config() -> dict:
        from quickterm import __version__

        return {
            "font_family": cfg.font_family,
            "font_size": cfg.font_size,
            "theme": cfg.theme,
            "custom_theme": dict(cfg.custom_theme),
            "logo": cfg.logo,
            "default_profile": cfg.default_profile,
            "profiles": [asdict(p) for p in cfg.profiles],
            "snippets": [asdict(s) for s in cfg.snippets],
            "voice_available": _voice_available(),
            # Resolved root for the disposable scratch workspace, so the UI can
            # show it and open scratch terminals there.
            "scratch_dir": _scratch_dir(cfg),
            "elevated": elevated,
            "version": __version__,
            "update_check": cfg.update_check,
            "idle_timeout_s": cfg.idle_timeout_s,
            "max_sessions": cfg.max_sessions,
            # Startup hotkey registration failure (another program owns the
            # combination). Settings shows it next to the shortcut field
            # instead of leaving the user with a silently dead shortcut.
            "hotkey_error": getattr(cfg, "hotkey_error", None),
            # Latest autostart, hotkey or elevated first-terminal failure. Those
            # launches have no request to answer, so this is how they are heard.
            "launch_error": getattr(cfg, "launch_error", None),
        }

    @app.get("/api/config/full")
    def get_full_config() -> dict:
        # Serve the PERSISTED config, not the live one. app.py overwrites
        # cfg.port at startup (--port 0, and unconditionally for an elevated
        # instance), and Settings PUTs this whole object straight back, which
        # wrote the ephemeral port into config.json and destroyed the
        # configured one for every later launch. For the same reason a read
        # failure is a 500, never the live config as a fallback.
        config_mod = importlib.import_module("quickterm.config")
        try:
            return asdict(config_mod.load_config())
        except Exception as exc:
            raise HTTPException(500, "could not read the saved configuration") from exc

    @app.put("/api/config")
    async def put_config(request: Request) -> Response:
        body = await read_json(request)
        if not isinstance(body, dict):
            raise HTTPException(400, "invalid config: config must be a JSON object")
        await save_and_apply(body)
        return Response(status_code=204)

    @app.get("/api/config/history")
    async def get_config_history() -> list[dict]:
        config_mod = importlib.import_module("quickterm.config")
        # Reads and decrypts up to twenty stored files to compare them.
        try:
            return await asyncio.to_thread(config_mod.config_history)
        except Exception as exc:
            raise HTTPException(500, "could not read the settings history") from exc

    @app.post("/api/config/history/{entry_id}/restore")
    async def restore_config_history(entry_id: str) -> Response:
        config_mod = importlib.import_module("quickterm.config")
        try:
            stored = await asyncio.to_thread(config_mod.load_history_entry, entry_id)
        except KeyError:
            raise HTTPException(404, "no such settings version") from None
        except (OSError, ValueError) as exc:
            raise HTTPException(500, "could not read that settings version") from exc
        # The same path as a Settings save: validation, a new history entry
        # for the version this replaces, and the live apply.
        await save_and_apply(stored)
        return Response(status_code=204)

    async def save_and_apply(body: dict[str, Any]) -> None:
        config_mod = importlib.import_module("quickterm.config")
        # load_config and save_config fsync, and DPAPI runs once per protected
        # env value: all of it off the loop.
        try:
            on_disk = await asyncio.to_thread(config_mod.load_config)
        except Exception as exc:
            raise HTTPException(500, "could not read the saved configuration") from exc
        # Settings sends the whole object, but config_from_dict fills every
        # omitted key with its default, so a partial body from any other
        # client wiped the profiles (and their protected env) and snippets.
        # Omitted top-level keys keep their saved value instead.
        merged = {**asdict(on_disk), **body}
        try:
            # Off the loop too: a restored history entry carries its profile
            # secrets DPAPI-protected, and decoding them calls into DPAPI.
            new_cfg = await asyncio.to_thread(config_mod.config_from_dict, merged)
            # A client holding a page rendered from the LIVE config (an older
            # build, or a window opened before /api/config/full served the
            # saved one) would write a runtime-only value back to disk. Only
            # the names app.py really overrode at runtime are guarded, and only
            # when the submitted value is that runtime value; everything else
            # is the user's edit, including a revert to the running port.
            for name in sorted(getattr(cfg, "runtime_overrides", None) or ()):
                if getattr(new_cfg, name, None) == getattr(cfg, name, None):
                    setattr(new_cfg, name, getattr(on_disk, name))
            await asyncio.to_thread(config_mod.save_config, new_cfg)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, f"invalid config: {exc}") from exc
        # Apply live-updatable fields in place; port and global hotkeys need a restart.
        for name in (
            "font_family", "font_size", "theme", "custom_theme", "logo", "idle_timeout_s",
            "max_sessions", "scrollback_bytes", "default_profile", "profiles", "snippets", "voice",
            "update_check", "scratch_dir",
        ):
            if hasattr(new_cfg, name):
                setattr(cfg, name, getattr(new_cfg, name))
        set_limit = getattr(manager, "set_max_sessions", None)
        if set_limit:
            set_limit(cfg.max_sessions)
        set_scrollback = getattr(manager, "set_scrollback_bytes", None)
        if set_scrollback:
            set_scrollback(cfg.scrollback_bytes)
