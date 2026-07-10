"""Mic capture: mono 16 kHz float32 via sounddevice. Import-safe without deps."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000


class Recorder:
    def __init__(self) -> None:
        self._stream = None
        self._chunks: list = []

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def start(self) -> bool:
        """Begin capturing. Returns False if deps/device unavailable."""
        if self._stream is not None:
            return True
        try:
            import sounddevice as sd
        except Exception:
            log.warning("sounddevice not available; voice capture disabled")
            return False
        self._chunks = []

        def _cb(indata, _frames, _time, status) -> None:
            if status:
                log.debug("capture status: %s", status)
            self._chunks.append(indata.copy())

        try:
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32", callback=_cb)
            self._stream.start()
        except Exception as e:
            log.warning("could not open input device: %s", e)
            self._stream = None
            return False
        return True

    def stop(self) -> "np.ndarray | None":
        """Stop capture; return 1-D float32 audio, or None if nothing captured."""
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception as e:
                log.debug("stream close failed: %s", e)
        chunks, self._chunks = self._chunks, []
        if not chunks:
            return None
        import numpy as np
        return np.concatenate(chunks).reshape(-1)
