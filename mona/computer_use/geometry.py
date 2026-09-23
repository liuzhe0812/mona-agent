"""Read target geometry without moving or activating the user's window."""

from __future__ import annotations

import sys


def window_geometry(pid: int, window_id: int) -> tuple[int, ...] | None:
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    # Python may be DPI-unaware. Read physical pixels without changing the
    # process-wide setting or leaving other work on this thread affected.
    previous = user32.SetThreadDpiAwarenessContext(-4)  # PER_MONITOR_AWARE_V2
    if not previous:
        raise OSError("Cannot read the target window in physical pixel coordinates")
    try:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window_id, ctypes.byref(owner))
        rect = wintypes.RECT()
        if owner.value != pid or not user32.GetWindowRect(window_id, ctypes.byref(rect)):
            raise ValueError("Target window no longer exists or belongs to another process")
        return rect.left, rect.top, rect.right, rect.bottom, user32.GetDpiForWindow(window_id)
    finally:
        user32.SetThreadDpiAwarenessContext(previous)
