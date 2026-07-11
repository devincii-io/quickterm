"""The hide-to-tray decision: closing the window only stays resident when a
live, actually-used session would be lost. Fresh/untouched shells -> quit."""

from dataclasses import dataclass

from quickterm.app import _sessions_worth_keeping


@dataclass
class _Info:
    alive: bool
    touched: bool


class _Manager:
    def __init__(self, infos):
        self._infos = infos

    def list(self):
        return self._infos


class _Broken:
    def list(self):
        raise RuntimeError("boom")


def test_touched_live_session_keeps_app_resident():
    assert _sessions_worth_keeping(_Manager([_Info(alive=True, touched=True)])) is True


def test_untouched_scratch_shell_quits():
    assert _sessions_worth_keeping(_Manager([_Info(alive=True, touched=False)])) is False


def test_dead_sessions_do_not_keep_app_alive():
    assert _sessions_worth_keeping(_Manager([_Info(alive=False, touched=True)])) is False


def test_no_sessions_quits():
    assert _sessions_worth_keeping(_Manager([])) is False


def test_mixed_sessions_keep_if_any_touched_alive():
    infos = [
        _Info(alive=True, touched=False),
        _Info(alive=False, touched=True),
        _Info(alive=True, touched=True),
    ]
    assert _sessions_worth_keeping(_Manager(infos)) is True


def test_manager_error_defaults_to_quit():
    assert _sessions_worth_keeping(_Broken()) is False


def test_missing_manager_defaults_to_quit():
    assert _sessions_worth_keeping(None) is False
