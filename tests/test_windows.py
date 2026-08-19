"""Window registry rules: one owner per workspace, and no owner forever.

Two windows on one workspace both autosave its layout on every pane change, so
the loser's panes disappear without a word. That is the failure this module
exists to prevent, and none of it is reachable from a GUI test, so it is all
tested here.
"""

from __future__ import annotations

import pytest

from quickterm.windows import (
    KEEP,
    TooManyWindows,
    UnknownWindow,
    WindowRegistry,
    WorkspaceClaimed,
    as_payload,
    normalize_workspace,
    window_title,
)


class Clock:
    """Injected time, so expiry is tested without sleeping."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def registry(clock) -> WindowRegistry:
    return WindowRegistry(ttl_s=30.0, max_windows=4, clock=clock)


# --- claiming ---------------------------------------------------------------


def test_two_windows_cannot_claim_one_workspace(registry):
    first = registry.register(workspace="dev")
    second = registry.register()
    with pytest.raises(WorkspaceClaimed) as excinfo:
        registry.claim(second.id, "dev")
    assert excinfo.value.workspace == "dev"
    assert excinfo.value.owner.id == first.id
    # The refusal must not have half-applied: the loser still claims nothing.
    assert registry.get(second.id).workspace is None


def test_registering_into_a_claimed_workspace_fails_and_adds_nothing(registry):
    registry.register(window_id="a", workspace="dev")
    with pytest.raises(WorkspaceClaimed):
        registry.register(window_id="b", workspace="dev")
    assert [info.id for info in registry.list()] == ["a"]


def test_a_window_may_reclaim_what_it_already_holds(registry):
    info = registry.register(window_id="a", workspace="dev")
    # A reloaded page re-asserts its claim; colliding with itself would leave it
    # unable to own the workspace it is already showing.
    assert registry.claim(info.id, "dev").workspace == "dev"
    assert registry.register(window_id="a", workspace="dev").workspace == "dev"


def test_claiming_a_second_workspace_replaces_the_first(registry):
    info = registry.register(window_id="a", workspace="dev")
    registry.claim(info.id, "docs")
    assert registry.get("a").workspace == "docs"
    # ...and the vacated one is immediately claimable by somebody else.
    other = registry.register(window_id="b")
    assert registry.claim(other.id, "dev").workspace == "dev"


def test_release_frees_the_workspace(registry):
    registry.register(window_id="a", workspace="dev")
    registry.release("a")
    assert registry.owner_of("dev") is None
    registry.register(window_id="b", workspace="dev")
    assert registry.owner_of("dev").id == "b"


def test_windows_without_a_claim_never_collide(registry):
    registry.register(window_id="a")
    registry.register(window_id="b")
    assert registry.owner_of(None) is None
    assert len(registry.list()) == 2


def test_workspace_names_are_compared_exactly(registry):
    # workspace.py keeps "dev" and "Dev" in separate files, so they are separate
    # workspaces and case folding here would refuse a legitimate second window.
    registry.register(window_id="a", workspace="dev")
    assert registry.register(window_id="b", workspace="Dev").workspace == "Dev"


def test_registering_without_a_workspace_key_preserves_the_claim(registry):
    registry.register(window_id="a", workspace="dev")
    registry.register(window_id="a", title="QuickTerm", workspace=KEEP)
    assert registry.get("a").workspace == "dev"
    # An explicit null is the way to say "I hold nothing now".
    registry.register(window_id="a", workspace=None)
    assert registry.get("a").workspace is None


def test_unknown_window_cannot_claim_or_beat(registry):
    with pytest.raises(UnknownWindow):
        registry.claim("ghost", "dev")
    with pytest.raises(UnknownWindow):
        registry.heartbeat("ghost")


def test_bad_workspace_values_are_rejected(registry):
    registry.register(window_id="a")
    for bad in (5, ["dev"], "x" * 500, "de\x00v"):
        with pytest.raises(ValueError):
            registry.claim("a", bad)
    assert normalize_workspace("  dev  ") == "dev"
    assert normalize_workspace("   ") is None
    assert normalize_workspace(None) is None


# --- expiry -----------------------------------------------------------------


def test_a_window_that_stops_beating_expires_and_frees_its_workspace(registry, clock):
    registry.register(window_id="a", workspace="dev")
    clock.advance(31)
    # Without expiry one crashed window would lock its project out of the app
    # for the rest of the backend's life.
    assert registry.owner_of("dev") is None
    assert registry.list() == []
    assert registry.register(window_id="b", workspace="dev").workspace == "dev"


def test_heartbeats_keep_a_window_alive(registry, clock):
    registry.register(window_id="a", workspace="dev")
    for _ in range(5):
        clock.advance(20)
        registry.heartbeat("a")
    assert registry.owner_of("dev").id == "a"


def test_expiry_is_reported_by_prune(registry, clock):
    registry.register(window_id="a")
    registry.register(window_id="b")
    clock.advance(31)
    assert sorted(info.id for info in registry.prune()) == ["a", "b"]
    assert registry.prune() == []


def test_a_beat_after_expiry_is_a_404_not_a_silent_revival(registry, clock):
    registry.register(window_id="a", workspace="dev")
    clock.advance(31)
    registry.register(window_id="b", workspace="dev")
    # "a" must learn it lost the workspace rather than carry on autosaving it.
    with pytest.raises(UnknownWindow):
        registry.heartbeat("a")


# --- bookkeeping ------------------------------------------------------------


def test_forget_is_idempotent_and_frees_the_claim(registry):
    registry.register(window_id="a", workspace="dev")
    assert registry.forget("a") is True
    assert registry.forget("a") is False
    assert registry.owner_of("dev") is None


def test_window_limit_is_enforced_but_not_against_a_reload(registry):
    for i in range(4):
        registry.register(window_id=f"w{i}")
    with pytest.raises(TooManyWindows):
        registry.register(window_id="w4")
    assert registry.register(window_id="w0", title="again").id == "w0"


def test_one_live_window_is_always_primary(registry):
    first = registry.register(window_id="a", primary=True)
    registry.register(window_id="b")
    assert first.primary is True
    assert registry.get("b").primary is False
    # The Explorer handoff and the summon hotkey aim at the primary window, so
    # closing it must hand the role on rather than leave nothing to aim at.
    registry.forget("a")
    assert registry.get("b").primary is True


def test_expiring_the_primary_also_promotes(registry, clock):
    registry.register(window_id="a", primary=True)
    clock.advance(20)
    registry.register(window_id="b")
    clock.advance(20)
    registry.heartbeat("b")
    assert registry.get("b").primary is True


def test_registry_hands_out_copies_not_its_own_records(registry):
    info = registry.register(window_id="a", workspace="dev")
    info.workspace = "somewhere-else"
    assert registry.get("a").workspace == "dev"


def test_snapshot_reports_ages_oldest_first(registry, clock):
    registry.register(window_id="a", workspace="dev", title="QuickTerm", primary=True)
    clock.advance(5)
    registry.register(window_id="b")
    clock.advance(2)
    rows = registry.snapshot()
    assert [row["id"] for row in rows] == ["a", "b"]
    assert rows[0]["workspace"] == "dev"
    assert rows[0]["primary"] is True
    assert rows[0]["idle_seconds"] == 7.0
    assert rows[1]["age_seconds"] == 2.0


def test_payload_carries_no_timestamps(registry):
    payload = as_payload(registry.register(window_id="a", workspace="dev"))
    # Monotonic clocks mean nothing on the far side of the wire.
    assert set(payload) == {"id", "workspace", "title", "primary"}


def test_generated_ids_are_unique(registry):
    ids = {registry.register().id for _ in range(4)}
    assert len(ids) == 4


# --- titles -----------------------------------------------------------------


def test_only_the_primary_window_keeps_the_bare_title():
    # hotkeys.py matches on the exact string, so the summon hotkey must find one
    # predictable window instead of whichever secondary enumerates first.
    assert window_title("QuickTerm", "dev", primary=True) == "QuickTerm"
    assert window_title("QuickTerm", None, primary=False) == "QuickTerm"
    assert window_title("QuickTerm", "dev", primary=False) == "QuickTerm - dev"
    assert (
        window_title("QuickTerm - Administrator", "dev", primary=False)
        == "QuickTerm - Administrator - dev"
    )
