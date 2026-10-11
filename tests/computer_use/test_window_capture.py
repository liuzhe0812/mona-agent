"""DPI capture correction preserves Cua geometry and refuses untrusted pixels."""
import base64
import ctypes
import io
from types import SimpleNamespace

import pytest
from mcp.types import CallToolResult, ImageContent, TextContent
from PIL import Image

from mona.computer_use import window_capture as capture


class NativeFunction:
    def __init__(self, function):
        self.function = function

    def __call__(self, *args):
        return self.function(*args)


def result_image(size=(200, 100)):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, format="PNG")
    return CallToolResult(content=[TextContent(type="text", text="real tree"),
                                  ImageContent(type="image", mimeType="image/png", data=base64.b64encode(output.getvalue()).decode())],
                          structuredContent={"elements": [{"element_token": "driver-token"}]})


@pytest.fixture
def native(monkeypatch):
    from ctypes import wintypes as w

    state = SimpleNamespace(awareness=0, scale=200, dpi=96, contexts=[], captured=[], checked=[])

    def scale(_, pointer):
        ctypes.cast(pointer, ctypes.POINTER(ctypes.c_int))[0] = state.scale
        return 0

    def dwm(_, attribute, pointer, size):
        rect = ctypes.cast(pointer, ctypes.POINTER(w.RECT)).contents
        rect.left, rect.top, rect.right, rect.bottom = 10, 20, 212, 122
        return 0

    def context(value):
        state.contexts.append(value)
        return 123

    libraries = {
        "user32": SimpleNamespace(
            GetWindowDpiAwarenessContext=NativeFunction(lambda _: 1),
            GetAwarenessFromDpiAwarenessContext=NativeFunction(lambda _: state.awareness),
            MonitorFromWindow=NativeFunction(lambda *args: 2),
            GetDpiForWindow=NativeFunction(lambda _: state.dpi),
            SetThreadDpiAwarenessContext=NativeFunction(context),
        ),
        "shcore": SimpleNamespace(GetScaleFactorForMonitor=NativeFunction(scale)),
        "dwmapi": SimpleNamespace(DwmGetWindowAttribute=NativeFunction(dwm)),
    }
    monkeypatch.setattr(capture.sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "WinDLL", lambda name, **kwargs: libraries[name], raising=False)
    monkeypatch.setattr(capture, "window_geometry", lambda pid, hwnd: (0, 0, 230, 140, state.dpi))
    monkeypatch.setattr(capture, "_require_visible_region", lambda *args: state.checked.append(args[-1]))

    def read_region(_, bounds):
        state.captured.append(bounds)
        return Image.new("RGB", (bounds[2] - bounds[0], bounds[3] - bounds[1]), "green")

    monkeypatch.setattr(capture, "_capture_region", read_region)
    return state


@pytest.mark.parametrize("scale", [125, 150, 175, 200, 250])
def test_legacy_dpi_capture_replaces_pixels_not_coordinates_or_driver_tokens(native, scale):
    native.scale = scale
    original = result_image()
    result = capture.correct_scaled_window_capture(original, {"pid": 7, "window_id": 11})
    assert result is not original
    assert result.structuredContent == original.structuredContent
    assert result.content[0].text == "real tree"
    with Image.open(io.BytesIO(base64.b64decode(result.content[1].data))) as image:
        assert image.size == (200, 100)
        assert image.getpixel((50, 50)) == (0, 128, 0)
    assert native.captured == [(11, 21, 211, 121)]
    assert native.checked == native.captured * 2
    assert native.contexts == [-4, 123]


def test_driver_downsample_dimensions_remain_authoritative(native):
    result = capture.correct_scaled_window_capture(result_image((100, 50)), {"pid": 7, "window_id": 11})
    with Image.open(io.BytesIO(base64.b64decode(result.content[1].data))) as image:
        assert image.size == (100, 50)
    assert native.captured == [(11, 21, 211, 121)]


@pytest.mark.parametrize("awareness,scale,dpi", [(2, 200, 192), (1, 200, 192), (0, 100, 96)])
def test_nonvirtualized_window_keeps_original_driver_capture(native, awareness, scale, dpi):
    native.awareness, native.scale, native.dpi = awareness, scale, dpi
    original = result_image()
    assert capture.correct_scaled_window_capture(original, {"pid": 7, "window_id": 11}) is original
    assert not native.captured


def test_system_aware_window_on_different_scale_monitor_is_corrected(native):
    native.awareness, native.scale, native.dpi = 1, 200, 144
    assert capture.correct_scaled_window_capture(result_image(), {"pid": 7, "window_id": 11})
    assert native.captured


def test_obscured_window_is_not_captured_as_another_app(native, monkeypatch):
    def covered(*args):
        raise ValueError("covered")
    monkeypatch.setattr(capture, "_require_visible_region", covered)
    with pytest.raises(ValueError, match="covered"):
        capture.correct_scaled_window_capture(result_image(), {"pid": 7, "window_id": 11})
    assert not native.captured
    assert native.contexts == [-4, 123]


def test_unknown_screenshot_geometry_is_not_guessed(native):
    with pytest.raises(ValueError, match="does not match"):
        capture.correct_scaled_window_capture(result_image((100, 80)), {"pid": 7, "window_id": 11})
    assert not native.captured
    assert native.contexts == [-4, 123]


def test_geometry_changed_during_capture_rejects_and_restores_context(native, monkeypatch):
    values = iter([(0, 0, 230, 140, 96), (100, 0, 330, 140, 96)])
    monkeypatch.setattr(capture, "window_geometry", lambda *args: next(values))
    with pytest.raises(ValueError, match="changed"):
        capture.correct_scaled_window_capture(result_image(), {"pid": 7, "window_id": 11})
    assert native.contexts == [-4, 123]
