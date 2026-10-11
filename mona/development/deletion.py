"""Delete task records independently of an executor's ability to finish cleanup."""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from mona.development.contracts import ExecutorId
from mona.development.store import DevelopmentError, NotFoundError
from mona.session.manager import SessionDeletedError

if TYPE_CHECKING:
    from mona.development.runtime import DevelopmentRuntime

_CLEANUP_WAIT_SECONDS = 2.0


async def _release_native(adapter, binding) -> None:
    try:
        receipt = await asyncio.wait_for(adapter.interrupt(binding), timeout=1)
    finally:
        # SDK workers are owned per session. Codex releases only this thread,
        # never its project-wide App Server or other users' running threads.
        await adapter.close_runtime(binding, force=True)
    if adapter.id == ExecutorId.CODEX and receipt.outcome not in {"confirmed", "already_finished"}:
        raise DevelopmentError("native_stop_unconfirmed", "执行者尚未确认任务已停止。")


async def delete_session(runtime: DevelopmentRuntime, session_id: str, revision: int) -> dict:
    try:
        root = runtime.store.get_session(session_id)
    except NotFoundError:
        return {"deleted": [session_id], "warnings": []}
    sessions = runtime.store.list_sessions(root.project_id)
    targets = {session_id}
    while children := {item.id for item in sessions if item.parent_session_id in targets} - targets:
        targets.update(children)
    bindings = [binding for target in targets for binding in runtime.store.list_bindings(target)]
    runs = [run for target in targets for run in runtime.store.list_runs(target)]
    monitors = []
    for identifier, task in list(runtime.collaboration.monitors.items()):
        try:
            record = runtime.store.get_collaboration(identifier)
        except NotFoundError:
            continue
        if record.parent_session_id in targets or record.child_session_id in targets:
            monitors.append(task)
    # No await before the database deletion: queued sends cannot acquire a new
    # run between the resource snapshot and removal. Late writes are fenced too.
    rows = runtime.store.delete_session(session_id, revision)
    warnings = []
    jobs: set[asyncio.Task] = set()
    service = runtime.native.service
    for row in rows:
        try:
            runtime.sessions.delete_session(row.transcript_key, prevent_recreation=True)
        except OSError:
            warnings.append("任务已删除，但部分会话文件未能清理。")
        runtime.live.pop(row.id, None)
        # Retain an acquired lock until its pending caller unwinds; replacing it
        # could let another operation bypass the same session's lock.
        tools = runtime.tools.pop(row.id, None)
        if tools:
            jobs.add(asyncio.create_task(tools.exec_sessions.cancel_by_session(tools.session_key)))
    for run in runs:
        task = runtime.tasks.get(run.id)
        if task:
            runtime._deleted_runs.add(run.id)
            jobs.add(task)
            task.cancel()
        dispatch = service._dispatches.pop(run.id, None)
        if dispatch:
            jobs.add(dispatch)
            dispatch.cancel()
        service._sent.discard(run.id)
        signal = service._changed.pop(run.id, None)
        if signal:
            signal.set()
        runtime.native.decisions.cancel_run(run.id)
    for binding in bindings:
        consumer = service._consumers.pop(binding.id, None)
        service._current.pop(binding.id, None)
        adapter = service._adapters.pop(binding.id, None)
        loaded = runtime.native.loaded.pop(binding.id, None)
        adapter = adapter or (loaded[0] if loaded else None)
        if consumer:
            jobs.add(consumer)
            consumer.cancel()
        if adapter:
            jobs.add(asyncio.create_task(_release_native(adapter, binding)))
    for task in monitors:
        jobs.add(task)
        task.cancel()
    try:
        jobs.update(runtime.git_operations.delete_sessions(targets))
    except Exception as error:
        logger.warning("Deleted development task Git cleanup failed ({})", type(error).__name__)
        warnings.append("任务已删除，但 Git 操作记录未能清理。")

    runtime.native.model_bridge.revoke(targets)
    owned_hosts = [runtime.native.hosts.pop(key) for key in list(runtime.native.hosts)
                   if len(key) == 3 and key[2] in targets]
    if owned_hosts:
        pending_cleanup = tuple(jobs)
        async def close_owned_hosts():
            if pending_cleanup:
                await asyncio.wait(pending_cleanup, timeout=_CLEANUP_WAIT_SECONDS)
            for host in owned_hosts:
                await host.shutdown()
        jobs.add(asyncio.create_task(close_owned_hosts()))

    def finished(task: asyncio.Task) -> None:
        runtime._deletion_tasks.discard(task)
        if not task.cancelled():
            error = task.exception()
            if error and not isinstance(error, (NotFoundError, SessionDeletedError)):
                logger.warning("Deleted development task cleanup failed ({})", type(error).__name__)

    for task in jobs:
        runtime._deletion_tasks.add(task)
        task.add_done_callback(finished)
    if jobs:
        done, pending = await asyncio.wait(jobs, timeout=_CLEANUP_WAIT_SECONDS)
        if pending or any(not task.cancelled() and task.exception()
                          and not isinstance(task.exception(), (NotFoundError, SessionDeletedError)) for task in done):
            warnings.append("任务已删除，部分后台资源尚未确认结束。")
    return {"deleted": [row.id for row in rows] or [session_id], "warnings": list(dict.fromkeys(warnings))}
