"""faster-whisper wrapper: lazy CPU int8 model, VAD on, DE/EN auto-detect."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

log = logging.getLogger(__name__)


class Transcriber:
    def __init__(self, model_size: str = "small", language: str | None = None) -> None:
        self.model_size = model_size
        self.language = language  # None = auto-detect
        self._model = None

    def transcribe(self, audio: "np.ndarray") -> str:
        if self._model is None:
            from faster_whisper import WhisperModel
            log.info("loading whisper model %r (downloading model on first use)...",
                     self.model_size)
            self._model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
        segments, _info = self._model.transcribe(
            audio, language=self.language, vad_filter=True)
        return " ".join(seg.text.strip() for seg in segments).strip()
