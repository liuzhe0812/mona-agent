"""Desktop backend process lifetime supervision."""

import _thread
import logging
import os
import sys
import threading

_PARENT_MARKER = "MONA_DESKTOP_PROCESS"
_FORCE_EXIT_TIMEOUT_SECONDS = 5.0


def start_parent_stdin_watchdog() -> None:
    if os.environ.pop(_PARENT_MARKER, None) != "1":
        return

    threading.Thread(
        target=_wait_for_parent_eof,
        args=(sys.stdin.fileno(),),
        name="mona-desktop-parent-watchdog",
        daemon=True,
    ).start()


def _wait_for_parent_eof(stdin_fd: int) -> None:
    try:
        while os.read(stdin_fd, 1):
            pass
    except Exception:
        logging.getLogger(__name__).exception("Failed to monitor desktop parent stdin")
        return

    _thread.interrupt_main()
    timer = threading.Timer(_FORCE_EXIT_TIMEOUT_SECONDS, os._exit, args=(0,))
    timer.daemon = True
    timer.start()
