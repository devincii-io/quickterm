import sys

import pytest

from quickterm import window_frame

COLORS = {"caption": "#15140F", "text": "#E9E3D5", "border": "#3A372F", "light": False}


def test_a_colour_becomes_a_colorref():
    assert window_frame.colorref("#112233") == 0x332211
    assert window_frame.colorref("#ffffff") == 0xFFFFFF
    for bad in ("112233", "#12345", "#GG0000", None, 3):
        with pytest.raises(ValueError):
            window_frame.colorref(bad)


def test_the_attributes_set_dark_mode_first_then_the_colours():
    attrs = window_frame.frame_attributes(COLORS)
    assert attrs[0] == (window_frame.DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    assert dict(attrs)[window_frame.DWMWA_CAPTION_COLOR] == window_frame.colorref("#15140F")
    assert dict(attrs)[window_frame.DWMWA_TEXT_COLOR] == window_frame.colorref("#E9E3D5")
    assert dict(attrs)[window_frame.DWMWA_BORDER_COLOR] == window_frame.colorref("#3A372F")
    light = window_frame.frame_attributes({**COLORS, "light": True})
    assert light[0] == (window_frame.DWMWA_USE_IMMERSIVE_DARK_MODE, 0)


def test_bad_input_is_refused_before_any_window_is_touched():
    for bad in (None, [], {**COLORS, "light": "yes"}, {**COLORS, "caption": "red"}):
        with pytest.raises(ValueError):
            window_frame.apply(bad, hwnds=[])


def test_only_quickterm_titles_are_ours():
    assert window_frame._title_is_ours("QuickTerm")
    assert window_frame._title_is_ours("QuickTerm - Administrator")
    assert not window_frame._title_is_ours("QuickTermX")
    assert not window_frame._title_is_ours("Notes - QuickTerm")


@pytest.mark.skipif(sys.platform != "win32", reason="DWM is Windows only")
def test_no_window_means_nothing_applied():
    assert window_frame.apply(COLORS, hwnds=[]) == 0
