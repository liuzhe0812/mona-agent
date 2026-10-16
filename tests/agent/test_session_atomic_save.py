import errno
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import mona.session.manager as session_module
import mona.utils.helpers as helpers_module
from mona.session.manager import Session, SessionManager, SessionSaveError


def _saved_session(tmp_path):
    manager = SessionManager(tmp_path)
    session = manager.get_or_create("websocket:video-save")
    session.add_message("user", "Continue the approved animation")
    manager.save(session)
    path = manager._get_session_path(session.key)
    session.metadata["runtime_checkpoint"] = {
        "phase": "tools_partial", "iteration": 34,
        "completed_tool_results": [{"role": "tool", "name": "read_file", "content": "source saved"}],
    }
    return manager, session, path


@pytest.mark.skipif(os.name != "nt", reason="Windows read handles can deny atomic replacement")
def test_save_waits_for_a_real_windows_reader_without_losing_checkpoint(tmp_path):
    manager, session, path = _saved_session(tmp_path)
    reader = path.open("rb")
    release = threading.Timer(0.12, reader.close)
    release.start()
    try:
        manager.save(session, fsync=True)
    finally:
        release.join()
        reader.close()

    restored = SessionManager(tmp_path).get_or_create(session.key)
    assert restored.metadata["runtime_checkpoint"] == session.metadata["runtime_checkpoint"]
    assert restored.messages == session.messages
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.parametrize("winerror", [5, 32, 33])
def test_save_retries_transient_windows_replacement_errors(tmp_path, monkeypatch, winerror):
    manager, session, path = _saved_session(tmp_path)
    replace = os.replace
    attempts = []
    waits = []

    def busy_then_replace(source, destination):
        attempts.append(Path(source))
        if len(attempts) <= 2:
            error = PermissionError(errno.EACCES, "Windows file is temporarily in use")
            error.winerror = winerror
            raise error
        replace(source, destination)

    monkeypatch.setattr(session_module.os, "replace", busy_then_replace)
    monkeypatch.setattr(helpers_module.time, "sleep", waits.append)
    manager.save(session)

    restored = SessionManager(tmp_path).get_or_create(session.key)
    assert restored.metadata["runtime_checkpoint"] == session.metadata["runtime_checkpoint"]
    assert len(attempts) == 3 and len(set(attempts)) == 1
    assert waits == list(helpers_module._REPLACE_RETRY_DELAYS[:2])
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.parametrize("winerror", [5, None])
def test_failed_save_keeps_previous_file_and_reports_persistence_error(tmp_path, monkeypatch, winerror):
    manager, session, path = _saved_session(tmp_path)
    original = path.read_bytes()
    attempts = []
    error = OSError(errno.EACCES if winerror else errno.ENOSPC, "fixture filesystem failure")
    if winerror:
        error.winerror = winerror

    def fail_replace(source, destination):
        attempts.append(source)
        raise error

    monkeypatch.setattr(session_module.os, "replace", fail_replace)
    monkeypatch.setattr(helpers_module.time, "sleep", lambda _: None)
    with pytest.raises(SessionSaveError) as caught:
        manager.save(session)

    assert caught.value.__cause__ is error
    assert len(attempts) == (len(helpers_module._REPLACE_RETRY_DELAYS) + 1 if winerror else 1)
    assert path.read_bytes() == original
    assert not list(path.parent.glob("*.tmp"))


def test_concurrent_saves_use_separate_staging_files(tmp_path, monkeypatch):
    managers = [SessionManager(tmp_path), SessionManager(tmp_path)]
    key = "websocket:concurrent"
    sessions = [Session(key=key), Session(key=key)]
    for index, session in enumerate(sessions):
        session.metadata["writer"] = index
        session.add_message("assistant", f"writer {index}: " + str(index) * 16_000)
    barrier = threading.Barrier(2)
    replace = os.replace
    staging = []
    target = managers[0]._get_session_path(key)

    def concurrent_replace(source, destination):
        if Path(destination) == target and Path(source) not in staging:
            staging.append(Path(source))
            barrier.wait(timeout=5)
        replace(source, destination)

    monkeypatch.setattr(session_module.os, "replace", concurrent_replace)
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(manager.save, session) for manager, session in zip(managers, sessions)]
        for job in jobs:
            job.result(timeout=10)

    rows = [json.loads(line) for line in target.read_text(encoding="utf-8").splitlines()]
    winner = rows[0]["metadata"]["writer"]
    assert rows[1]["content"] == sessions[winner].messages[0]["content"]
    assert len(staging) == 2 and len(set(staging)) == 2
    assert not list(target.parent.glob("*.tmp"))
