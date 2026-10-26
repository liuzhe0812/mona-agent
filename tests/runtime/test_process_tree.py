from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from mona.runtime.process_tree import OwnedProcess


def _wait_for_file(path: Path, timeout: float = 5.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.is_file():
            return path.read_text(encoding="utf-8").strip()
        time.sleep(0.02)
    raise TimeoutError(f"child did not write its PID file: {path}")


def _pid_is_running(pid: int) -> bool:
    if os.name == "nt":
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        open_process.restype = wintypes.HANDLE
        wait_for_single_object = kernel32.WaitForSingleObject
        wait_for_single_object.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        wait_for_single_object.restype = wintypes.DWORD
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = (wintypes.HANDLE,)
        close_handle.restype = wintypes.BOOL
        handle = open_process(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() not in (5, 87, 1168)
        try:
            state = wait_for_single_object(handle, 0)
            if state == 0x00000102:  # WAIT_TIMEOUT
                return True
            if state == 0x00000000:  # WAIT_OBJECT_0
                return False
            raise ctypes.WinError(ctypes.get_last_error())
        finally:
            close_handle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def test_close_terminates_owned_parent_and_child_tree() -> None:
    with tempfile.TemporaryDirectory(prefix="mona-process-tree-") as temporary:
        parent_pid_file = Path(temporary) / "parent.pid"
        pid_file = Path(temporary) / "child.pid"
        child_code = (
            "import os, pathlib, sys, time; "
            "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8'); "
            "time.sleep(60)"
        )
        parent_code = (
            "import os, pathlib, subprocess, sys, time; "
            "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8'); "
            "subprocess.Popen([sys.executable, '-c', sys.argv[2], sys.argv[3]], "
            "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); "
            "time.sleep(60)"
        )
        owned = OwnedProcess(
            [
                sys.executable,
                "-c",
                parent_code,
                str(parent_pid_file),
                child_code,
                str(pid_file),
            ],
            cwd=temporary,
            env=os.environ.copy(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_timeout=5.0,
        )
        child_pid = 0
        parent_pid = 0
        try:
            parent_pid = int(_wait_for_file(parent_pid_file))
            child_pid = int(_wait_for_file(pid_file))
            assert owned.process.poll() is None
            assert owned.owns_pid(parent_pid)
            assert owned.owns_pid(child_pid)
            if os.name == "nt":
                assert owned.process_count() >= 2
            assert not owned.owns_pid(os.getpid())
            assert owned.pid == owned.process.pid

            owned.close()
            owned.process.wait(timeout=1.0)
            deadline = time.monotonic() + 3.0
            while _pid_is_running(child_pid) and time.monotonic() < deadline:
                time.sleep(0.02)
            assert not _pid_is_running(parent_pid), f"owned process {parent_pid} survived close()"
            assert not _pid_is_running(child_pid), f"owned child {child_pid} survived close()"
            assert owned.poll() is not None
            assert owned.process_count() == 0
        finally:
            owned.close()
