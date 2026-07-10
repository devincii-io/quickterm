"""Voice toggle orchestration: hotkey press starts recording, next press stops,
transcribes off-loop, injects text into the focused session."""
from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

from . import voice_available
from .capture import Recorder
from .transcribe import Transcriber

if TYPE_CHECKING:
    from quickterm.config import AppConfig
    from quickterm.hotkeys import HotkeyManager

log = logging.getLogger(__name__)


class VoiceInput:
    """manager is duck-typed: needs .write(sid, bytes) and .focused_session_id."""

    def __init__(self, manager: Any, cfg: "AppConfig",
                 hotkey_manager: "HotkeyManager") -> None:
        self._manager = manager
        self._loop = hotkey_manager.loop
        self._recording = False
        self._recorder = Recorder()
        self._transcriber = Transcriber(cfg.voice.model_size, cfg.voice.language)
        if not cfg.voice.enabled:
            log.info("voice input disabled in config")
            return
        if not voice_available():
            log.info("voice deps not installed; voice input unavailable")
            return
        if not hotkey_manager.register(cfg.voice.hotkey, self.toggle):
            log.warning("voice hotkey %r could not be registered", cfg.voice.hotkey)

    @property
    def is_recording(self) -> bool:
        return self._recording

    def toggle(self) -> None:
        """Runs on the event loop thread (via HotkeyManager)."""
        if not self._recording:
            if self._recorder.start():
                self._recording = True
                log.info("voice recording started")
        else:
            self._recording = False
            # transcription is CPU-heavy — never on the event loop
            threading.Thread(target=self._finish, name="voice-transcribe",
                             daemon=True).start()

    def _finish(self) -> None:
        try:
            audio = self._recorder.stop()
            if audio is None or len(audio) == 0:
                return
            text = self._transcriber.transcribe(audio)
        except Exception as e:
            log.warning("voice transcription failed: %s", e)
            return
        if text:
            self._loop.call_soon_threadsafe(self._inject, text)

    def _inject(self, text: str) -> None:
        sid = getattr(self._manager, "focused_session_id", None)
        if not sid:
            return
        try:
            self._manager.write(sid, text.encode("utf-8"))
        except Exception as e:
            log.warning("voice inject failed: %s", e)
