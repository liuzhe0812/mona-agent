#!/usr/bin/env python3
"""Detect system Edge/Chrome for Hyperframes rendering.

Returns the browser executable path if found, empty string otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def find_browser() -> str:
    """Find a usable Chromium-based browser on the system."""
    candidates: list[Path] = []

    if sys.platform == "win32":
        candidates.extend([
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        ])
    elif sys.platform == "darwin":
        candidates.extend([
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ])
    else:
        candidates.extend([
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/microsoft-edge"),
        ])

    # chrome-headless-shell exposes a very limited CDP surface that is
    # insufficient for video rendering (Page/Runtime/Emulation commands are
    # missing). Only full Chromium-based browsers (Chrome/Edge) are accepted.
    for c in candidates:
        if c.exists() and c.is_file():
            return str(c)

    return ""


def main() -> None:
    path = find_browser()
    print(json.dumps({"browser_path": path, "found": bool(path)}))


if __name__ == "__main__":
    main()
