import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from queue import Queue

REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class _Child:
    process: subprocess.Popen
    output: Queue[str]
    output_reader: threading.Thread


def _start_child(code: str, *, desktop_process: bool) -> _Child:
    env = os.environ.copy()
    env.pop("MONA_DESKTOP_PROCESS", None)
    if desktop_process:
        env["MONA_DESKTOP_PROCESS"] = "1"
    process = subprocess.Popen(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    output: Queue[str] = Queue()

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output.put(line.rstrip("\r\n"))

    output_reader = threading.Thread(target=read_output, daemon=True)
    output_reader.start()
    return _Child(process, output, output_reader)


def _wait_for_line(child: _Child) -> str:
    return child.output.get(timeout=3)


def _close_parent_pipe(child: _Child) -> None:
    if child.process.stdin is not None and not child.process.stdin.closed:
        child.process.stdin.close()


def _cleanup_child(child: _Child) -> None:
    _close_parent_pipe(child)
    if child.process.poll() is None:
        child.process.kill()
        child.process.wait(timeout=2)
    child.output_reader.join(timeout=2)
    if child.process.stdout is not None and not child.process.stdout.closed:
        child.process.stdout.close()
    if child.process.stderr is not None and not child.process.stderr.closed:
        child.process.stderr.close()


def test_desktop_child_exits_with_system_exit_while_parent_keeps_stdin_open() -> None:
    child = _start_child(
        """
import time
from mona.runtime.desktop_process import start_parent_stdin_watchdog
start_parent_stdin_watchdog()
time.sleep(0.2)
print("READY", flush=True)
raise SystemExit(23)
""",
        desktop_process=True,
    )
    try:
        assert _wait_for_line(child) == "READY"
        child.process.wait(timeout=3)
        assert child.process.returncode == 23
        assert child.process.stderr is not None
        assert "_enter_buffered_busy" not in child.process.stderr.read()
    finally:
        _cleanup_child(child)


def test_desktop_child_stays_alive_until_parent_closes_stdin() -> None:
    child = _start_child(
        """
import os
import time
from mona.runtime.desktop_process import start_parent_stdin_watchdog
start_parent_stdin_watchdog()
assert "MONA_DESKTOP_PROCESS" not in os.environ
print("READY", flush=True)
while True:
    time.sleep(0.1)
""",
        desktop_process=True,
    )
    try:
        assert _wait_for_line(child) == "READY"
        assert child.process.poll() is None
        _close_parent_pipe(child)
        child.process.wait(timeout=3)
        assert child.process.returncode is not None
    finally:
        _cleanup_child(child)


def test_unmarked_child_does_not_monitor_stdin() -> None:
    child = _start_child(
        """
import time
from mona.runtime.desktop_process import start_parent_stdin_watchdog
start_parent_stdin_watchdog()
print("READY", flush=True)
while True:
    time.sleep(0.1)
""",
        desktop_process=False,
    )
    try:
        assert _wait_for_line(child) == "READY"
        _close_parent_pipe(child)
        time.sleep(0.3)
        assert child.process.poll() is None
    finally:
        _cleanup_child(child)


def test_desktop_child_force_exits_if_main_ignores_interrupt() -> None:
    child = _start_child(
        """
import time
from mona.runtime import desktop_process
desktop_process._FORCE_EXIT_TIMEOUT_SECONDS = 1.5
desktop_process.start_parent_stdin_watchdog()
try:
    time.sleep(0.05)
    print("READY", flush=True)
    while True:
        time.sleep(0.05)
except KeyboardInterrupt:
    print("SWALLOWED", flush=True)
    while True:
        time.sleep(0.05)
""",
        desktop_process=True,
    )
    try:
        assert _wait_for_line(child) == "READY"
        _close_parent_pipe(child)
        assert _wait_for_line(child) == "SWALLOWED"
        child.process.wait(timeout=3)
        assert child.process.returncode == 0
    finally:
        _cleanup_child(child)
