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

from mona.cli.commands import app

if __name__ == "__main__":
    app()
