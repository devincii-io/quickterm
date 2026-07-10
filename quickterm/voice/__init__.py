"""Optional voice input. Deps (sounddevice, faster-whisper) may be absent;
importing this package must never raise."""
from __future__ import annotations

from importlib.util import find_spec
from typing import Any

__all__ = ["voice_available", "Recorder", "Transcriber", "VoiceInput"]


def voice_available() -> bool:
    """True if voice deps are importable. Does not load models or open devices."""
    try:
        return (find_spec("sounddevice") is not None
                and find_spec("faster_whisper") is not None)
    except (ImportError, ValueError):
        return False


def __getattr__(name: str) -> Any:
    if name == "Recorder":
        from .capture import Recorder
        return Recorder
    if name == "Transcriber":
        from .transcribe import Transcriber
        return Transcriber
    if name == "VoiceInput":
        from .input import VoiceInput
        return VoiceInput
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
