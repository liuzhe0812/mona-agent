"""
Entry point for running mona as a module: python -m mona
"""

import os
import sys

# Fix for PyInstaller + CREATE_NO_WINDOW: stdout/stderr may be None.
# Must be done BEFORE any other imports, because loguru/rich access sys.stderr
# at module load time and will crash with "Cannot log to objects of type 'NoneType'".
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")

from mona.runtime.desktop_process import start_parent_stdin_watchdog

start_parent_stdin_watchdog()

# The private SDK owner starts before desktop backend configuration.
if __name__ == "__main__" and sys.argv[1:] == ["--development-sdk-worker"]:
    from mona.development.executors.sdk_worker import main

    main()
    raise SystemExit(0)

from mona.cli.commands import app  # noqa: E402

if __name__ == "__main__":
    app()
