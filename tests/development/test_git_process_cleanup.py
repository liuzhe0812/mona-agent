"""Exercise bounded Git cleanup with real disposable child processes, without a repository."""
import asyncio
import sys
from contextlib import asynccontextmanager

import pytest

from mona.development import git_operations


@asynccontextmanager
async def child_command(monkeypatch, source):
    original_spawn = asyncio.create_subprocess_exec
    processes = []
    started = asyncio.Event()
    existing = set(asyncio.all_tasks())

    async def executable():
        return "assessment-git"

    async def spawn(program, *args, **kwargs):
        if program != "assessment-git":
            return await original_spawn(program, *args, **kwargs)
        process = await original_spawn(sys.executable, "-u", "-c", source, **kwargs)
        processes.append(process)
        started.set()
        return process

    monkeypatch.setattr(git_operations, "require_git", executable)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    try:
        yield processes, started
    finally:
        # Failed regressions must not leave blocked pipe readers or child processes.
        pending = set(asyncio.all_tasks()) - existing
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for process in processes:
            if process.returncode is None:
                process.kill()
            await asyncio.wait_for(process.communicate(), 3)


@pytest.mark.asyncio
@pytest.mark.parametrize("descriptor", [1, 2])
async def test_git_output_limit_reaps_process_and_finishes_pipe_readers(tmp_path, monkeypatch, descriptor):
    source = f"import os, time; os.write({descriptor}, b'x' * 8_000_000); time.sleep(60)"
    async with child_command(monkeypatch, source) as (processes, _):
        task = asyncio.create_task(git_operations.git(tmp_path, "unused", timeout=1))
        done, _ = await asyncio.wait({task}, timeout=4)
        assert done, "Output-limit cleanup outlived the Git command deadline"
        with pytest.raises(git_operations.GitUncertainError):
            task.result()
        assert processes[0].returncode is not None


@pytest.mark.asyncio
async def test_git_timeout_and_cancellation_keep_the_original_outcome(tmp_path, monkeypatch):
    async with child_command(monkeypatch, "import time; time.sleep(60)") as (processes, started):
        with pytest.raises(git_operations.GitUncertainError):
            await asyncio.wait_for(git_operations.git(tmp_path, "unused", timeout=.1), 4)
        assert processes[0].returncode is not None

        started.clear()
        task = asyncio.create_task(git_operations.git(tmp_path, "unused", timeout=60))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 4)
        assert processes[1].returncode is not None
