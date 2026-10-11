"""Repair DPI-virtualized Win32 captures without changing the driver's pixel space.

Cua's PrintWindow buffer can contain logical-size content in a physical-size
bitmap for legacy windows. Read the visible target region instead; keep the
same DWM origin, one-pixel inset and output dimensions used by Cua's mapping.
Never activate a window or capture an obscuring application as the target.
"""
from __future__ import annotations

import base64
import ctypes
import io
import struct
import sys
from typing import Any

from mona.computer_use.geometry import window_geometry


def _bind(library, name, restype, *argtypes):
    function = getattr(library, name)
    function.restype, function.argtypes = restype, list(argtypes)
    return function


def _rect_tuple(rect):
    return rect.left, rect.top, rect.right, rect.bottom


def _intersects(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _require_visible_region(user32, dwm, hwnd, bounds):
    from ctypes import wintypes as w

    visible = _bind(user32, "IsWindowVisible", w.BOOL, w.HWND)
    iconic = _bind(user32, "IsIconic", w.BOOL, w.HWND)
    get_rect = _bind(user32, "GetWindowRect", w.BOOL, w.HWND, ctypes.POINTER(w.RECT))
    callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    enum_windows = _bind(user32, "EnumWindows", w.BOOL, callback_type, w.LPARAM)
    found, obscured = False, False

    def visit(other, _):
        nonlocal found, obscured
        if other == hwnd:
            found = True
            return False
        if not visible(other) or iconic(other):
            return True
        cloaked = w.DWORD()
        if dwm(other, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) == 0 and cloaked.value:
            return True
        rect = w.RECT()
        if get_rect(other, ctypes.byref(rect)) and _intersects(_rect_tuple(rect), bounds):
            obscured = True
            return False
        return True

    if not visible(hwnd) or iconic(hwnd):
        raise ValueError("The target window is not visible; focus it before observing.")
    enum_windows(callback_type(visit), 0)
    if not found or obscured:
        raise ValueError("The target window is covered; focus it before observing.")
    desktop = (user32.GetSystemMetrics(76), user32.GetSystemMetrics(77),
               user32.GetSystemMetrics(78), user32.GetSystemMetrics(79))
    if not (desktop[0] <= bounds[0] < bounds[2] <= desktop[0] + desktop[2]
            and desktop[1] <= bounds[1] < bounds[3] <= desktop[1] + desktop[3]):
        raise ValueError("The target window is partly off screen; move it into view before observing.")


def _capture_region(user32, bounds):
    """BitBlt only the exact physical target rectangle, not the whole desktop."""
    from ctypes import wintypes as w

    from PIL import Image

    left, top, right, bottom = bounds
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0 or width * height > 40_000_000:
        raise ValueError("Unsupported target capture dimensions")
    gdi = ctypes.WinDLL("gdi32", use_last_error=True)
    get_dc = _bind(user32, "GetDC", w.HDC, w.HWND)
    release_dc = _bind(user32, "ReleaseDC", ctypes.c_int, w.HWND, w.HDC)
    create_dc = _bind(gdi, "CreateCompatibleDC", w.HDC, w.HDC)
    create_bitmap = _bind(gdi, "CreateCompatibleBitmap", w.HBITMAP, w.HDC, ctypes.c_int, ctypes.c_int)
    select = _bind(gdi, "SelectObject", w.HANDLE, w.HDC, w.HANDLE)
    delete_object = _bind(gdi, "DeleteObject", w.BOOL, w.HANDLE)
    delete_dc = _bind(gdi, "DeleteDC", w.BOOL, w.HDC)
    blit = _bind(gdi, "BitBlt", w.BOOL, w.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                 w.HDC, ctypes.c_int, ctypes.c_int, w.DWORD)
    get_bits = _bind(gdi, "GetDIBits", ctypes.c_int, w.HDC, w.HBITMAP, w.UINT, w.UINT,
                     ctypes.c_void_p, ctypes.c_void_p, w.UINT)
    screen = get_dc(None)
    memory = bitmap = previous = None
    try:
        if not screen:
            raise OSError("Cannot acquire target capture DC")
        memory = create_dc(screen)
        bitmap = create_bitmap(screen, width, height)
        if not memory or not bitmap:
            raise OSError("Cannot allocate target capture buffer")
        previous = select(memory, bitmap)
        if not previous or not blit(memory, 0, 0, width, height, screen, left, top, 0x00CC0020):
            raise OSError("Cannot capture target pixels")
        select(memory, previous)
        previous = None
        header = ctypes.create_string_buffer(struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 32, 0, width * height * 4, 0, 0, 0, 0))
        pixels = ctypes.create_string_buffer(width * height * 4)
        if get_bits(memory, bitmap, 0, height, pixels, header, 0) != height:
            raise OSError("Cannot read target capture pixels")
        return Image.frombytes("RGB", (width, height), pixels.raw, "raw", "BGRX")
    finally:
        if previous and memory:
            select(memory, previous)
        if bitmap:
            delete_object(bitmap)
        if memory:
            delete_dc(memory)
        if screen:
            release_dc(None, screen)


def correct_scaled_window_capture(result: Any, arguments: dict) -> Any:
    if sys.platform != "win32" or getattr(result, "isError", False):
        return result
    from ctypes import wintypes as w

    from PIL import Image

    pid, hwnd = arguments.get("pid"), arguments.get("window_id")
    if not isinstance(pid, int) or not isinstance(hwnd, int):
        raise ValueError("Window capture requires an exact target")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    get_context = _bind(user32, "GetWindowDpiAwarenessContext", ctypes.c_void_p, w.HWND)
    get_awareness = _bind(user32, "GetAwarenessFromDpiAwarenessContext", ctypes.c_int, ctypes.c_void_p)
    awareness = get_awareness(get_context(hwnd))
    if awareness == 2:  # Per-monitor-aware windows have no DPI virtualization.
        return result
    if awareness not in {0, 1}:
        raise ValueError("Cannot determine target DPI awareness")
    monitor = _bind(user32, "MonitorFromWindow", w.HANDLE, w.HWND, w.DWORD)(hwnd, 2)
    scale = ctypes.c_int()
    shcore = ctypes.WinDLL("shcore", use_last_error=True)
    scale_for_monitor = _bind(shcore, "GetScaleFactorForMonitor", ctypes.c_long, w.HANDLE, ctypes.POINTER(ctypes.c_int))
    if scale_for_monitor(monitor, ctypes.byref(scale)) != 0:
        raise OSError("Cannot determine target monitor scaling")
    dpi = _bind(user32, "GetDpiForWindow", w.UINT, w.HWND)(hwnd)
    if scale.value * 96 == dpi * 100:
        return result
    image_block = next((block for block in result.content if getattr(block, "type", None) == "image"), None)
    if image_block is None:
        return result
    set_context = _bind(user32, "SetThreadDpiAwarenessContext", ctypes.c_void_p, ctypes.c_void_p)
    previous = set_context(-4)
    if not previous:
        raise OSError("Cannot read physical target geometry")
    try:
        before = window_geometry(pid, hwnd)
        dwm = _bind(ctypes.WinDLL("dwmapi"), "DwmGetWindowAttribute", ctypes.c_long,
                    w.HWND, w.DWORD, ctypes.c_void_p, w.DWORD)
        rect = w.RECT()
        if dwm(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)) == 0:
            bounds = (rect.left + 1, rect.top + 1, rect.right - 1, rect.bottom - 1)
        else:
            bounds = before[:4]
        _require_visible_region(user32, dwm, hwnd, bounds)
        with Image.open(io.BytesIO(base64.b64decode(image_block.data))) as original:
            size = original.size
        width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
        if width <= 0 or height <= 0 or abs(width * size[1] - height * size[0]) > max(width, height) * 2:
            raise ValueError("Driver screenshot does not match the target frame")
        physical = _capture_region(user32, bounds)
        if window_geometry(pid, hwnd) != before:
            raise ValueError("Window changed during capture; observe again")
        _require_visible_region(user32, dwm, hwnd, bounds)
        if physical.size != size:
            physical = physical.resize(size, Image.Resampling.LANCZOS)
        output = io.BytesIO()
        physical.save(output, format="PNG")
        replacement = image_block.model_copy(update={"data": base64.b64encode(output.getvalue()).decode("ascii"), "mimeType": "image/png"})
        return result.model_copy(update={"content": [replacement if block is image_block else block for block in result.content]})
    finally:
        set_context(previous)
