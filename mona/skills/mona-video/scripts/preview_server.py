#!/usr/bin/env python3
"""Local static file server for video scene preview.

Serves files from a project's scenes/ and assets/ directories so WebView2
can load them via http://localhost:<port>/ instead of file:// protocol.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def find_free_port(start: int = 18080, end: int = 18099) -> int:
    """Find a free port in the given range."""
    import socket

    for port in range(start, end):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", port))
                return port
        except OSError:
            continue
    raise RuntimeError(f"No free port in range {start}-{end}")


def serve_project(project_path: str, port: int | None = None) -> dict:
    """Start a static file server for a video project."""
    project = Path(project_path).resolve()
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    if port is None:
        port = find_free_port()

    # Phase 3: actual server implementation
    # For now, report the configuration
    return {
        "ok": True,
        "port": port,
        "url": f"http://127.0.0.1:{port}/",
        "project": str(project),
        "scenes_url": f"http://127.0.0.1:{port}/scenes/",
        "assets_url": f"http://127.0.0.1:{port}/assets/",
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: preview_server.py <project_path> [port]"}))
        sys.exit(1)

    project_path = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else None
    result = serve_project(project_path, port)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
