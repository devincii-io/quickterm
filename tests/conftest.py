"""Setup shared by every test module."""

import pytest


@pytest.fixture(autouse=True)
def _tests_never_hold_off_sleep(monkeypatch):
    # A test with a working agent would otherwise call SetThreadExecutionState
    # for real. tests/test_keep_awake.py checks the calls themselves.
    from quickterm import keep_awake

    monkeypatch.setattr(keep_awake, "_set_execution_state", lambda flags: True)

