import json
from types import SimpleNamespace
from urllib.parse import quote

import pytest

from mona.session.manager import Session, SessionLoadError, SessionManager
from mona.webui.thread_disk import webui_thread_file_path
from mona.webui.transcript import (
    append_transcript_object,
    ensure_transcript_owner,
    read_transcript_lines,
    webui_transcript_path,
)


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    sessions = SessionManager(tmp_path / "workspace")
    sessions.legacy_sessions_dir = tmp_path / "legacy-sessions"
    return sessions


def _write_legacy(manager, key, *, root=None):
    root = root or manager.sessions_dir
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{manager.legacy_safe_key(key)}.jsonl"
    path.write_text("\n".join(map(json.dumps, [
        {"_type": "metadata", "key": key, "metadata": {"title": "legacy"}},
        {"role": "user", "content": "original history"},
    ])) + "\n", encoding="utf-8")
    return path


@pytest.mark.parametrize("key", [
    "test:1", "cli:default", "websocket:short-id", "websocket:alpha_beta",
    "websocket:019c6e27-e55b-73d1-87d8-4e01f1f75043",
])
def test_unambiguous_lowercase_keys_keep_existing_filenames(key):
    assert SessionManager.safe_key(key) == key.replace(":", "_")


@pytest.mark.parametrize("first,second", [
    ("websocket:alpha:beta", "websocket:alpha_beta"),
    ("websocket:ClientID", "websocket:clientid"),
    ("channel_name:chat", "channel:name_chat"),
])
def test_distinct_keys_keep_independent_history_after_restart(manager, first, second):
    assert manager.safe_key(first).casefold() != manager.safe_key(second).casefold()
    for key in (first, second):
        session = Session(key=key)
        session.add_message("user", key)
        manager.save(session)
    restored = SessionManager(manager.workspace)
    restored.legacy_sessions_dir = manager.legacy_sessions_dir
    for key in (first, second):
        assert restored.get_or_create(key).messages[0]["content"] == key
        assert restored.read_session_file(key)["key"] == key


def test_scoped_legacy_history_and_display_files_migrate_before_stem_reuse(manager):
    scoped = "websocket:alpha:beta"
    ordinary = "websocket:alpha_beta"
    source = _write_legacy(manager, scoped)
    display_root = webui_transcript_path(scoped).parent
    display_root.mkdir(parents=True, exist_ok=True)
    legacy_stem = manager.legacy_safe_key(scoped)
    transcript = display_root / f"{legacy_stem}.jsonl"
    transcript.write_text(json.dumps({"event": "user", "text": "scoped display"}) + "\n", encoding="utf-8")
    snapshot = display_root / f"{legacy_stem}.json"
    snapshot.write_text(json.dumps({"sessionKey": scoped, "messages": []}), encoding="utf-8")

    with pytest.raises(SessionLoadError):
        manager.read_session_file(ordinary)
    with pytest.raises(SessionLoadError):
        manager.save(Session(key=ordinary))
    with pytest.raises(SessionLoadError):
        manager.delete_session(ordinary)

    assert manager.read_session_file(scoped)["messages"][0]["content"] == "original history"
    assert not source.exists()
    assert read_transcript_lines(scoped)[0]["text"] == "scoped display"
    assert json.loads(webui_thread_file_path(scoped).read_text(encoding="utf-8"))["sessionKey"] == scoped
    assert not transcript.exists()
    assert not snapshot.exists()

    manager.save(Session(key=ordinary))
    assert read_transcript_lines(ordinary) == []
    assert manager.get_or_create(scoped).messages[0]["content"] == "original history"
    assert {row["key"] for row in manager.list_sessions()} == {scoped, ordinary}


def test_global_legacy_scoped_history_migrates_only_for_its_owner(manager):
    key = "websocket:agent:mona:old-chat"
    source = _write_legacy(manager, key, root=manager.legacy_sessions_dir)
    assert manager.get_or_create(key).messages[0]["content"] == "original history"
    assert not source.exists()
    assert manager._get_session_path(key).is_file()


def test_other_legacy_owner_is_never_read_or_overwritten(manager):
    owner, requested = "websocket:alpha_beta", "websocket:alpha:beta"
    source = _write_legacy(manager, owner)
    original = source.read_bytes()
    assert manager.read_session_file(requested) is None
    assert manager.get_or_create(requested).messages == []
    manager.save(Session(key=requested))
    assert source.read_bytes() == original
    assert manager.read_session_file(owner)["key"] == owner


def test_unknown_legacy_ownership_preserves_original_and_blocks_recreation(manager):
    key = "websocket:alpha:beta"
    source = manager.sessions_dir / f"{manager.legacy_safe_key(key)}.jsonl"
    source.write_text('{"role":"user","content":"unowned history"}\n', encoding="utf-8")
    original = source.read_bytes()
    for operation in (manager.read_session_file, manager.get_or_create, manager.delete_session):
        with pytest.raises(SessionLoadError):
            operation(key)
    with pytest.raises(SessionLoadError):
        manager.save(Session(key=key))
    assert source.read_bytes() == original
    assert not (manager.sessions_dir / f"{manager.safe_key(key)}.jsonl").exists()


def test_explicit_wrong_owner_at_current_path_is_rejected_for_all_operations(manager):
    key = "websocket:alpha:beta"
    path = manager.sessions_dir / f"{manager.safe_key(key)}.jsonl"
    path.write_text(json.dumps({"_type": "metadata", "key": "websocket:someone-else"}) + "\n", encoding="utf-8")
    original = path.read_bytes()
    for operation in (manager.read_session_file, manager.get_or_create, manager.delete_session):
        with pytest.raises(SessionLoadError):
            operation(key)
    with pytest.raises(SessionLoadError):
        manager.save(Session(key=key))
    assert path.read_bytes() == original


def test_unknown_snapshot_ownership_does_not_move_any_legacy_history(manager):
    key = "websocket:alpha:beta"
    source = _write_legacy(manager, key)
    snapshot = webui_thread_file_path("websocket:alpha_beta")
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_text(json.dumps({"messages": []}), encoding="utf-8")
    original = source.read_bytes()
    with pytest.raises(SessionLoadError):
        manager.read_session_file(key)
    assert source.read_bytes() == original
    assert snapshot.exists()


def test_scoped_repair_in_list_keeps_original_key(manager):
    key = "websocket:agent:mona:legacy"
    source = _write_legacy(manager, key)
    with source.open("a", encoding="utf-8") as stream:
        stream.write("{broken-json\n")
    rows = manager.list_sessions()
    assert rows[0]["key"] == key
    assert rows[0]["preview"] == "original history"


def test_display_history_without_a_session_needs_its_own_identity(manager):
    key = "websocket:alpha_beta"
    path = webui_transcript_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    original = json.dumps({"event": "user", "text": "unowned history"}) + "\n"
    path.write_text(original, encoding="utf-8")
    with pytest.raises(SessionLoadError):
        ensure_transcript_owner(key, manager._get_session_path(key))
    append_transcript_object(key, {"event": "user", "text": "later input"})
    with pytest.raises(SessionLoadError):
        ensure_transcript_owner(key, manager._get_session_path(key))
    with pytest.raises(SessionLoadError):
        manager.save(Session(key=key))
    assert not (manager.sessions_dir / f"{manager.safe_key(key)}.jsonl").exists()
    assert path.read_text(encoding="utf-8").startswith(original)

    fresh = "websocket:fresh-chat"
    append_transcript_object(fresh, {"event": "user", "_session_key": key, "text": "fresh"})
    ensure_transcript_owner(fresh, manager._get_session_path(fresh))
    assert read_transcript_lines(fresh)[0]["_session_key"] == fresh


def test_restored_target_session_identity_takes_priority_over_source_record_key(manager):
    target = "websocket:restored-target"
    manager.save(Session(key=target))
    path = webui_transcript_path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "event": "user", "_session_key": "websocket:source-chat", "text": "restored history",
    }) + "\n", encoding="utf-8")
    ensure_transcript_owner(target, manager._get_session_path(target))
    assert read_transcript_lines(target)[0]["text"] == "restored history"


@pytest.mark.parametrize("requested,expected,legacy_session", [
    ("websocket:alpha:beta", 200, True),
    ("websocket:alpha_beta", 500, True),
    ("websocket:alpha_beta", 500, False),
])
def test_http_display_history_checks_legacy_session_ownership(manager, requested, expected, legacy_session):
    from mona.bus.queue import MessageBus
    from mona.channels.websocket import WebSocketChannel

    key = "websocket:alpha:beta"
    source = _write_legacy(manager, key) if legacy_session else None
    path = webui_transcript_path("websocket:alpha_beta")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"event": "user", "text": "private scoped history"}) + "\n", encoding="utf-8")
    channel = WebSocketChannel({"enabled": True}, MessageBus(), session_manager=manager)
    encoded = quote(requested, safe="")
    request = SimpleNamespace(
        path=f"/api/sessions/{encoded}/webui-thread",
        headers={"Authorization": f"Bearer {channel._runtime_token}"},
    )
    response = channel._handle_webui_thread_get(request, encoded)
    assert response.status_code == expected
    if expected == 200:
        payload = json.loads(response.body)
        assert payload["sessionKey"] == requested
        assert payload["messages"][0]["content"] == "private scoped history"
    else:
        assert b"private scoped history" not in response.body
        assert source is None or source.exists()
        assert path.is_file()
