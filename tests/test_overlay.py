"""The quake-style overlay: its geometry, and the show, hide and restore steps
against a fake Win32 layer (no real window is ever touched)."""

from types import SimpleNamespace

import pytest

from quickterm import overlay

WORK = (0, 0, 1920, 1040)  # a 1080p monitor minus the taskbar


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    monkeypatch.setattr(overlay, "_saved", {})
    monkeypatch.setattr(overlay, "_previous", {})
    monkeypatch.setattr(overlay, "_hold_until", 0.0)
    monkeypatch.setattr(overlay, "_sleep_step", lambda: None)


def test_top_edge_full_width_half_height():
    assert overlay.overlay_rect(WORK, "top", 100, 50) == (0, 0, 1920, 520)


def test_bottom_edge_touches_the_bottom_of_the_work_area():
    assert overlay.overlay_rect(WORK, "bottom", 100, 50) == (0, 520, 1920, 520)


def test_a_narrower_overlay_is_centred():
    assert overlay.overlay_rect(WORK, "top", 50, 40) == (480, 0, 960, 416)


@pytest.mark.parametrize(
    ("width_pct", "height_pct", "expected"),
    [
        (10, 5, (672, 0, 576, 208)),        # below the minimum: 30 % and 20 %
        (250, 400, (0, 0, 1920, 1040)),     # above the maximum: 100 %
        ("bad", None, (0, 0, 1920, 520)),   # unreadable: the defaults
    ],
)
def test_percentages_are_clamped(width_pct, height_pct, expected):
    assert overlay.overlay_rect(WORK, "top", width_pct, height_pct) == expected


def test_odd_work_areas_round_to_whole_pixels():
    x, y, w, h = overlay.overlay_rect((0, 0, 1366, 727), "bottom", 33, 33)
    assert (w, h) == (450, 239)
    assert x == (1366 - 450) // 2
    assert y + h == 727


def test_a_monitor_left_of_and_above_the_primary():
    work = (-2560, -1440, 0, -40)
    assert overlay.overlay_rect(work, "top", 100, 50) == (-2560, -1440, 2560, 700)
    assert overlay.overlay_rect(work, "bottom", 60, 25) == (-2048, -390, 1536, 350)


def test_an_unknown_edge_means_top():
    assert overlay.overlay_rect(WORK, "left", 100, 50) == overlay.overlay_rect(WORK, "top", 100, 50)


def test_an_empty_work_area_gives_an_empty_rect():
    assert overlay.overlay_rect((10, 10, 10, 10), "top", 100, 50) == (10, 10, 0, 0)


# --- show, hide, restore -----------------------------------------------------


class FakeWin:
    def __init__(self):
        self.style = 0x14CF0000  # WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPCHILDREN
        self.is_visible = False
        self.zoomed = False
        self.calls = []
        self.placement = SimpleNamespace(showCmd=1, flags=0)
        self.foreground_pid = 4242
        self.front = 55  # another program's window
        self.windows = {55}
        self.scale = 96

    def work_area(self, monitor):
        self.calls.append(("work_area", monitor))
        return WORK

    def get_style(self, hwnd):
        return self.style

    def set_style(self, hwnd, style):
        self.style = style
        self.calls.append(("set_style", style))

    def get_placement(self, hwnd):
        return self.placement

    def set_placement(self, hwnd, placement):
        self.calls.append(("set_placement", placement))

    def set_pos(self, hwnd, after, x, y, w, h, flags):
        self.calls.append(("set_pos", after, x, y, w, h, flags))
        if flags & overlay._SWP_SHOWWINDOW:
            self.is_visible = True

    def show(self, hwnd, command):
        self.calls.append(("show", command))
        if command == overlay._SW_HIDE:
            self.is_visible = False
        else:
            self.is_visible = True
            self.zoomed = False
            self.style &= ~overlay._WS_MAXIMIZE

    def visible(self, hwnd):
        return True if hwnd in self.windows else self.is_visible

    def minimized_or_maximized(self, hwnd):
        return self.zoomed

    def set_foreground(self, hwnd):
        self.calls.append(("foreground", hwnd))

    def rect(self, hwnd):
        return 0, 0, 1920, 520

    def pid_of(self, hwnd):
        return self.foreground_pid

    def animations_on(self):
        return True

    def foreground(self):
        return self.front

    def is_window(self, hwnd):
        return hwnd in self.windows

    def shell_window(self):
        return 1

    def dpi(self, hwnd):
        return self.scale


@pytest.fixture
def win(monkeypatch):
    fake = FakeWin()
    monkeypatch.setattr(overlay, "_api", lambda: fake)
    return fake


def _cfg(**values):
    base = dict(
        enabled=True, edge="top", width_pct=100, height_pct=50, always_on_top=True,
        hide_on_blur=True, monitor="cursor", animate=False,
    )
    return SimpleNamespace(**{**base, **values})


def test_show_takes_the_foreground_first_and_strips_the_frame(win):
    overlay.show_overlay(7, _cfg())

    assert win.calls[0] == ("foreground", 7)
    assert win.style & (overlay._WS_CAPTION | overlay._WS_THICKFRAME) == 0
    final = [c for c in win.calls if c[0] == "set_pos"][-1]
    assert final[1:6] == (overlay._HWND_TOPMOST, 0, 0, 1920, 520)
    assert overlay.is_applied(7) and overlay.is_applied()


def test_show_honours_the_primary_monitor_and_not_on_top(win):
    overlay.show_overlay(7, _cfg(monitor="primary", always_on_top=False))

    assert ("work_area", "primary") in win.calls
    final = [c for c in win.calls if c[0] == "set_pos"][-1]
    assert final[1] == overlay._HWND_NOTOPMOST


def test_show_slides_in_from_the_edge_when_animated(win):
    overlay.show_overlay(7, _cfg(animate=True))

    ys = [c[3] for c in win.calls if c[0] == "set_pos"]
    assert len(ys) == overlay.SLIDE_STEPS
    assert ys[0] < 0 and ys == sorted(ys) and ys[-1] == 0


def test_a_maximized_window_is_restored_before_it_drops_down(win):
    win.zoomed = True
    overlay.show_overlay(7, _cfg())
    assert ("show", overlay._SW_RESTORE) in win.calls


def test_a_maximized_window_drops_down_without_the_maximize_flag(win):
    """The saved style was read before the restore and still carried
    WS_MAXIMIZE; writing it back made the drop-down a maximized window."""
    win.zoomed = True
    win.style |= overlay._WS_MAXIMIZE
    win.placement = SimpleNamespace(showCmd=overlay._SW_SHOWMAXIMIZED, flags=0)

    overlay.show_overlay(7, _cfg())

    assert win.style & overlay._WS_MAXIMIZE == 0
    assert overlay._saved[7].style & overlay._WS_MAXIMIZE == 0
    assert overlay._saved[7].placement.showCmd == overlay._SW_SHOWMAXIMIZED


def test_turning_off_a_maximized_drop_down_clears_the_flag_before_the_placement(win):
    win.zoomed = True
    win.style |= overlay._WS_MAXIMIZE
    win.placement = SimpleNamespace(showCmd=overlay._SW_SHOWMAXIMIZED, flags=0)
    overlay.show_overlay(7, _cfg())
    win.zoomed = True  # something maximized the drop-down meanwhile
    win.calls.clear()

    overlay.restore_normal(7)

    assert win.calls[0] == ("show", overlay._SW_RESTORE)
    style = [c for c in win.calls if c[0] == "set_style"][0][1]
    assert style & overlay._WS_MAXIMIZE == 0
    assert style & overlay._WS_CAPTION
    assert [c[0] for c in win.calls].index("set_placement") > 0


@pytest.mark.parametrize(
    ("edge", "expected"),
    [
        ("bottom", (672, 560, 576, 480)),  # 20 % would be 208 px; flush with the bottom
        ("top", (672, 0, 576, 480)),
    ],
)
def test_the_drop_down_is_never_smaller_than_the_window_minimum(edge, expected):
    assert overlay.overlay_rect(WORK, edge, 30, 20, min_size=(0, 480)) == expected


def test_the_minimum_is_centred_and_capped_at_the_work_area():
    x, y, w, h = overlay.overlay_rect((0, 0, 1366, 728), "bottom", 30, 50, min_size=(1140, 720))
    assert (w, h) == (1140, 720)
    assert x == (1366 - 1140) // 2 and y + h == 728
    assert overlay.overlay_rect((0, 0, 1000, 400), "top", 30, 20, min_size=(1140, 720)) == (
        0, 0, 1000, 400,
    )


def test_show_scales_the_minimum_to_the_monitor_dpi(win):
    win.scale = 144  # 150 %
    overlay.show_overlay(7, _cfg(edge="bottom", width_pct=30, height_pct=20))
    final = [c for c in win.calls if c[0] == "set_pos"][-1]
    width, height = (overlay.MIN_LOGICAL_SIZE[0] * 3 // 2, overlay.MIN_LOGICAL_SIZE[1] * 3 // 2)
    assert final[4:6] == (width, height)
    assert final[2] == (1920 - width) // 2 and final[3] + height == WORK[3]


def test_the_window_minimum_matches_the_app():
    from quickterm import app

    assert overlay.MIN_LOGICAL_SIZE == app.MIN_WINDOW_SIZE


def test_hiding_with_the_summon_key_hands_the_foreground_back(win):
    overlay.show_overlay(7, _cfg())
    win.calls.clear()

    overlay.hide_overlay(7, _cfg())

    assert win.calls[-2:] == [("show", overlay._SW_HIDE), ("foreground", 55)]


def test_a_closed_previous_window_hands_the_foreground_to_the_desktop(win):
    overlay.show_overlay(7, _cfg())
    win.windows.clear()
    win.calls.clear()

    overlay.hide_overlay(7, _cfg())

    assert win.calls[-1] == ("foreground", 1)


def test_a_quickterm_window_in_front_is_not_remembered(win, monkeypatch):
    win.foreground_pid = overlay.os.getpid()
    overlay.show_overlay(7, _cfg())
    assert 7 not in overlay._previous


def test_hide_slides_out_then_hides(win):
    overlay.show_overlay(7, _cfg())
    win.calls.clear()

    overlay.hide_overlay(7, _cfg(animate=True))

    moves = [c for c in win.calls if c[0] == "set_pos"]
    assert len(moves) == overlay.SLIDE_STEPS and moves[-1][3] == -520
    assert win.calls[-2] == ("show", overlay._SW_HIDE)
    # Hidden, but still in overlay style for the next summon.
    assert overlay.is_applied(7)


def test_restore_puts_the_old_style_back_and_drops_topmost(win):
    original = win.style
    overlay.show_overlay(7, _cfg())
    overlay.show_overlay(7, _cfg(edge="bottom"))  # the saved style is taken once
    win.calls.clear()

    overlay.restore_normal(7)

    assert win.style == original
    assert win.calls[1][0] == "set_placement"
    assert win.calls[2][1] == overlay._HWND_NOTOPMOST
    assert not overlay.is_applied(7)


def test_restore_of_a_normal_window_does_nothing(win):
    overlay.restore_normal(7)
    assert win.calls == []


def test_off_windows_everything_is_a_no_op(monkeypatch):
    monkeypatch.setattr(overlay, "_IS_WINDOWS", False)
    overlay.show_overlay(7, _cfg())
    overlay.hide_overlay(7, _cfg())
    overlay.restore_normal(7)
    assert overlay.install_foreground_watcher(lambda: _cfg()) is False
    assert not overlay.is_applied()


# --- hide on focus loss ---------------------------------------------------------


def _shown(win):
    overlay.show_overlay(7, _cfg())
    win.calls.clear()


def test_focus_moving_to_another_program_hides_the_overlay(win):
    _shown(win)
    overlay._on_foreground(lambda: _cfg(), 99)
    assert win.calls[-1] == ("show", overlay._SW_HIDE)


def test_focus_moving_inside_quickterm_keeps_it(win, monkeypatch):
    _shown(win)
    win.foreground_pid = overlay.os.getpid()
    overlay._on_foreground(lambda: _cfg(), 99)
    assert win.calls == []


@pytest.mark.parametrize("settings", [{"hide_on_blur": False}, {"enabled": False}])
def test_focus_loss_is_ignored_when_switched_off(win, settings):
    _shown(win)
    overlay._on_foreground(lambda: _cfg(**settings), 99)
    assert win.calls == []


def test_a_launch_by_quickterm_holds_the_overlay_open(win):
    _shown(win)
    overlay.hold_open(3.0)
    overlay._on_foreground(lambda: _cfg(), 99)
    assert win.calls == []


def test_the_hold_expires(win, monkeypatch):
    _shown(win)
    overlay.hold_open(0.0)
    overlay._on_foreground(lambda: _cfg(), 99)
    assert win.calls[-1] == ("show", overlay._SW_HIDE)
