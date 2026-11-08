"""An abnormal hosted run may clean only its own pinned Linux process group."""
from __future__ import annotations

import asyncio
import os
import secrets
import select
import signal
import sys
from pathlib import Path

import pytest

from mona.hosted_work.contracts import WorkError
from mona.hosted_work.executor import _owned_group_handle, _stop_remaining_group


def _unsupported_or_failed():
    release = os.uname().release.split(".")
    if len(release) >= 2 and release[0].isdigit() and release[1].isdigit():
        if (int(release[0]), int(release[1])) >= (6, 9):
            pytest.fail("pidfd group identity was not verified on a supported Linux kernel")
    pytest.skip("pidfd process-group signaling is unavailable")


@pytest.mark.asyncio
async def test_unverified_group_is_never_signalled(monkeypatch):
    from mona.hosted_work import executor

    monkeypatch.setattr(executor, "_group_present", lambda _process, _fd: True)
    with pytest.raises(WorkError) as error:
        await _stop_remaining_group(object(), None)
    assert error.value.code == "execution_cleanup_unknown"


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Linux pidfd process-group semantics")
async def test_normal_exit_without_descendants_is_not_reported_unknown(monkeypatch):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        pytest.skip("pidfd is unavailable")
    nonce = secrets.token_hex(24)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import sys;sys.stdin.read(1)",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
        env={**os.environ, "MONA_HOSTED_PROCESS_NONCE": nonce},
    )
    original_read = Path.read_bytes
    transient = True

    def temporarily_missing(path):
        nonlocal transient
        if transient and path == Path("/proc") / str(process.pid) / "environ":
            transient = False
            raise FileNotFoundError
        return original_read(path)

    monkeypatch.setattr(Path, "read_bytes", temporarily_missing)
    handle = _owned_group_handle(process, nonce)
    try:
        if handle is None:
            process.stdin.close()
            await process.wait()
            _unsupported_or_failed()
        assert transient is False
        process.stdin.write(b"x")
        await process.stdin.drain()
        process.stdin.close()
        await asyncio.wait_for(process.wait(), 5)
        assert await _stop_remaining_group(process, handle) is False
    finally:
        if process.returncode is None:
            process.stdin.close()
            await process.wait()
        if handle is not None:
            os.close(handle)


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Linux pidfd process-group semantics")
async def test_pinned_group_stops_orphan_after_leader_exit_without_touching_other_process(tmp_path):
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        pytest.skip("pidfd is unavailable")
    nonce = secrets.token_hex(24)
    env = {**os.environ, "MONA_HOSTED_PROCESS_NONCE": nonce}
    code = (
        "import subprocess,sys; "
        "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],"
        "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
        "print(p.pid,flush=True); sys.stdin.read(1)"
    )
    leader = await asyncio.create_subprocess_exec(
        sys.executable, "-u", "-c", code, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=env, start_new_session=True,
    )
    handle = _owned_group_handle(leader, nonce)
    child_fd = other_fd = None
    other = None
    try:
        child_pid = int(await asyncio.wait_for(leader.stdout.readline(), 5))
        child_fd = os.pidfd_open(child_pid)
        if handle is None:
            leader.stdin.write(b"x")
            await leader.stdin.drain()
            await leader.wait()
            _unsupported_or_failed()
        assert os.getpgid(child_pid) == leader.pid
        other = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "import time;time.sleep(30)",
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
        )
        other_fd = os.pidfd_open(other.pid)
        leader.stdin.write(b"x")
        await leader.stdin.drain()
        leader.stdin.close()
        await asyncio.wait_for(leader.wait(), 5)

        assert await _stop_remaining_group(leader, handle) is True
        assert select.select([child_fd], [], [], 2)[0]
        assert not select.select([other_fd], [], [], 0)[0]
    finally:
        if child_fd is not None:
            try:
                signal.pidfd_send_signal(child_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(child_fd)
        if other_fd is not None:
            try:
                signal.pidfd_send_signal(other_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(other_fd)
        if other is not None:
            await other.wait()
        if leader.returncode is None:
            leader.stdin.close()
            await leader.wait()
        if handle is not None:
            os.close(handle)
