"""Window freshness checks must use physical pixels and restore thread DPI."""

import ctypes
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from mona.computer_use import geometry


@pytest.mark.parametrize("owner_matches", [True, False])
def test_geometry_reads_physical_pixels_and_restores_context(monkeypatch, owner_matches):
    current = [-1]
    def set_context(value):
        old, current[0] = current[0], value
        return old

    def get_owner(hwnd, owner):
        owner._obj.value = 7 if owner_matches else 8

    def get_rect(hwnd, rect):
        rect._obj.left, rect._obj.top = (160, 160) if current[0] == -4 else (80, 80)
        rect._obj.right, rect._obj.bottom = (500, 672) if current[0] == -4 else (250, 336)
        return 1

    user32 = SimpleNamespace(
        SetThreadDpiAwarenessContext=Mock(side_effect=set_context),
        GetWindowThreadProcessId=Mock(side_effect=get_owner),
        GetWindowRect=Mock(side_effect=get_rect),
        GetDpiForWindow=Mock(return_value=96),
    )
    monkeypatch.setattr(geometry.sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: user32, raising=False)
    if owner_matches:
        assert geometry.window_geometry(7, 11) == (160, 160, 500, 672, 96)
    else:
        with pytest.raises(ValueError):
            geometry.window_geometry(7, 11)
    assert current[0] == -1
