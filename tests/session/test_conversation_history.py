from __future__ import annotations

from mona.agent.partners import ConversationMetadata
from mona.session.conversation_history import ConversationHistoryStore
from mona.session.manager import Session, SessionManager
from mona.webui.thread_disk import delete_webui_thread
from mona.webui.transcript import write_transcript_objects


def _save_direct_session(
    manager: SessionManager,
    key: str,
    *,
    agent_id: str = "mona",
    title: str = "",
) -> Session:
    session = Session(
        key=key,
        metadata={
            "title": title,
            "conversation": ConversationMetadata.direct(
                agent_id, title=title
            ).to_session_metadata(),
        },
    )
    manager.save(session)
    return session


def _store(tmp_path, manager: SessionManager, agent_id: str = "mona"):
    return ConversationHistoryStore(
        tmp_path / "workspace",
        agent_id,
        manager,
        index_path=tmp_path / "indexes" / f"{agent_id}.sqlite3",
    )


def test_search_reads_original_exchange_and_keeps_stable_ref(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    key = "websocket:one"
    _save_direct_session(manager, key, title="部署约束")
    write_transcript_objects(
        key,
        [
            {
                "event": "user",
                "text": "端口必须使用 17173，并且禁止自动部署。",
                "_event_id": "user-one",
                "_recorded_at": 1_700_000_000,
            },
            {"event": "reasoning_delta", "text": "internal reasoning"},
            {"event": "delta", "text": "收到，保留人工发布。", "_event_id": "answer-one"},
            {"event": "stream_end"},
            {"event": "message", "text": "收到，保留人工发布。"},
            {"event": "turn_end"},
        ],
    )
    current_key = "websocket:current"
    _save_direct_session(manager, current_key, title="当前新会话")
    write_transcript_objects(
        current_key, [{"event": "user", "text": "这是另一段当前聊天。"}]
    )

    store = _store(tmp_path, manager)
    found = store.search("17173")
    assert found["status"] == "ok"
    assert found["coverage"]["eligible_sessions"] == 2
    assert len(found["results"]) == 1
    ref = found["results"][0]["ref"]

    read = store.read(ref)
    assert read["status"] == "ok"
    assert "禁止自动部署" in read["text"]
    assert "收到，保留人工发布" in read["text"]
    assert "internal reasoning" not in read["text"]
    assert read["text"].count("收到，保留人工发布") == 1

    # Appending a later event does not change a persisted message reference.
    from mona.webui.transcript import append_transcript_object

    append_transcript_object(key, {"event": "user", "text": "后续问题"})
    assert store.search("17173")["results"][0]["ref"] == ref


def test_short_chinese_special_query_and_read_pagination(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    key = "websocket:long"
    _save_direct_session(manager, key)
    long_text = "前文" + ("甲" * 1_300) + "尾部版本 v1.2.3 路径 C:\\work\\Mona"
    write_transcript_objects(key, [{"event": "user", "text": long_text}])
    store = _store(tmp_path, manager)

    assert store.search("版本")["results"]
    result = store.search("C:\\work\\Mona")["results"][0]
    assert "C:\\work\\Mona" in result["preview"]
    assert store.search("' OR 1=1 --")["results"] == []

    first = store.read(result["ref"], before=0, after=0, max_chars=1_000)
    second = store.read(
        result["ref"],
        before=0,
        after=0,
        max_chars=1_000,
        cursor=first["next_cursor"],
    )
    assert first["truncated"] is True
    assert "尾部版本 v1.2.3" in first["text"] + second["text"]


def test_agent_isolation_and_source_deletion_invalidate_results(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    mona_key = "websocket:mona-chat"
    partner_key = "websocket:partner-chat"
    _save_direct_session(manager, mona_key)
    _save_direct_session(manager, partner_key, agent_id="com.mona.partner")
    write_transcript_objects(mona_key, [{"event": "user", "text": "Mona 私有暗号 314159"}])
    write_transcript_objects(partner_key, [{"event": "user", "text": "伙伴私有暗号 271828"}])

    mona_store = _store(tmp_path, manager)
    partner_store = _store(tmp_path, manager, "com.mona.partner")
    mona_ref = mona_store.search("314159")["results"][0]["ref"]
    assert mona_store.search("271828")["results"] == []
    assert partner_store.search("271828")["results"]
    assert partner_store.search("314159")["results"] == []

    assert manager.delete_session(mona_key) is True
    assert delete_webui_thread(mona_key) is True
    assert mona_store.search("314159")["results"] == []
    assert mona_store.read(mona_ref)["status"] == "stale_reference"


def test_rooms_ephemeral_and_invalid_ownership_are_excluded(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    cases = {
        "websocket:room": {
            "conversation": ConversationMetadata.room(["mona"]).to_session_metadata()
        },
        "websocket:ephemeral:temp": {
            "conversation": ConversationMetadata.direct("mona").to_session_metadata()
        },
        "websocket:invalid": {
            "conversation": {"type": "direct", "directAgentId": "../mona"}
        },
    }
    for index, (key, metadata) in enumerate(cases.items()):
        manager.save(Session(key=key, metadata=metadata))
        write_transcript_objects(
            key, [{"event": "user", "text": f"不应召回 55500{index}"}]
        )

    store = _store(tmp_path, manager)
    assert store.search("不应召回")["results"] == []
    assert store.sync()["eligible_sessions"] == 0


def test_session_file_cap_does_not_remove_transcript_source(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    key = "websocket:capped"
    session = _save_direct_session(manager, key)
    for index in range(2_010):
        session.add_message("user" if index % 2 == 0 else "assistant", str(index))
    session.enforce_file_cap(limit=2_000)
    manager.save(session)
    assert len(session.messages) <= 2_000
    assert all(message["content"] != "0" for message in session.messages)

    write_transcript_objects(
        key,
        [{"event": "user", "text": "最早约束：不得删除原始正文，编号 808080"}],
    )
    result = _store(tmp_path, manager).search("808080")
    assert result["results"][0]["preview"].startswith("最早约束")


def test_bad_transcript_line_reports_partial_coverage(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    key = "websocket:partial"
    _save_direct_session(manager, key)
    write_transcript_objects(key, [{"event": "user", "text": "可恢复内容 909090"}])
    from mona.webui.transcript import webui_transcript_path

    with webui_transcript_path(key).open("a", encoding="utf-8") as handle:
        handle.write("{broken json\n")

    result = _store(tmp_path, manager).search("909090")
    assert result["status"] == "partial"
    assert result["coverage"]["partial_sessions"] == 1
    assert result["results"]


def test_corrupt_derived_index_is_rebuilt_from_transcript(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    manager = SessionManager(tmp_path / "workspace")
    key = "websocket:rebuild"
    _save_direct_session(manager, key)
    write_transcript_objects(key, [{"event": "user", "text": "重建标记 606060"}])
    store = _store(tmp_path, manager)
    store.index_path.parent.mkdir(parents=True, exist_ok=True)
    store.index_path.write_bytes(b"this is not sqlite")

    result = store.search("606060")
    assert result["status"] == "ok"
    assert result["results"]


def test_transcript_writer_adds_persistent_event_identity(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    key = "websocket:identity"
    write_transcript_objects(key, [{"event": "user", "text": "hello"}])
    from mona.webui.transcript import read_transcript_lines

    first = read_transcript_lines(key)[0]
    assert first["_event_id"]
    assert isinstance(first["_recorded_at"], float)

    # An explicitly persisted identity survives branch/copy writes.
    write_transcript_objects(key, [first])
    second = read_transcript_lines(key)[0]
    assert second["_event_id"] == first["_event_id"]
    assert second["_recorded_at"] == first["_recorded_at"]
