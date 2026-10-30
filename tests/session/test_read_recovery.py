import builtins
import json
from pathlib import Path

import pytest

from mona.session.manager import Session, SessionLoadError, SessionManager


@pytest.mark.parametrize("record", [[], None, 42, {"_type": "metadata", "metadata": []}])
def test_invalid_record_preserves_surrounding_history(tmp_path, record):
    manager = SessionManager(tmp_path)
    key = "test:invalid-record"
    manager._get_session_path(key).write_text("\n".join(map(json.dumps, [
        {"role": "user", "content": "before"}, record,
        {"role": "assistant", "content": "after"},
    ])) + "\n", encoding="utf-8")
    session = manager.get_or_create(key)
    session.add_message("user", "continue")
    manager.save(session)
    assert [m["content"] for m in manager.read_session_file(key)["messages"]] == [
        "before", "after", "continue",
    ]


@pytest.mark.parametrize("readonly", [False, True])
def test_unrecoverable_history_is_not_recreated(tmp_path, readonly):
    manager = SessionManager(tmp_path)
    key = "test:corrupt"
    path = manager._get_session_path(key)
    path.write_bytes(b"invalid history\n")
    with pytest.raises(SessionLoadError):
        (manager.read_session_file if readonly else manager.get_or_create)(key)
    assert path.read_bytes() == b"invalid history\n"
    assert key not in manager._cache


@pytest.mark.parametrize("readonly", [False, True])
def test_unreadable_history_is_preserved(tmp_path, monkeypatch, readonly):
    manager = SessionManager(tmp_path)
    key = "test:unreadable"
    session = Session(key=key)
    session.add_message("user", "existing history")
    manager.save(session)
    manager.invalidate(key)
    path = manager._get_session_path(key)
    original = path.read_bytes()
    real_open = builtins.open

    def locked_open(file, *args, **kwargs):
        if Path(file) == path:
            raise PermissionError("synthetic sharing violation")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", locked_open)
    with pytest.raises(SessionLoadError):
        (manager.read_session_file if readonly else manager.get_or_create)(key)
    assert path.read_bytes() == original
