"""Work history must preserve image bytes without exhausting the JSON budget."""
import base64
import json
import sqlite3
from types import SimpleNamespace

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.context import history_fingerprint
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.history_media_rollback import restore_for_legacy
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore, encoded
from mona.hosted_work.tenant_files import TenantFiles

OWNER, OTHER = owner_key("21"), owner_key("22")
SID, RID = "a" * 32, "b" * 32


def image(seed: bytes, size: int = 30000) -> dict:
    # The media layer validates real signatures while preserving the original URL.
    raw = b"\x89PNG\r\n\x1a\n" + seed * (size - 8)
    url = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
    return {"type": "image_url", "image_url": {"url": url}}


@pytest.fixture
def state(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path), max_history_bytes=65536,
                              history_media_storage_bytes=1024 * 1024,
                              history_media_expand_bytes=1024 * 1024)
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="fixture", text="question"))
    yield store
    store.close()


def test_large_tool_images_round_trip_and_context_fingerprint(state):
    first, second = image(b"a"), image(b"b")
    history = [{"role": "user", "content": "question"},
               {"role": "tool", "name": "read_file", "tool_call_id": "one", "content": [first, second]}]
    assert len(encoded(history).encode()) > state.config.max_history_bytes
    state.save_history(OWNER, RID, history)
    raw = state.session(OWNER, SID)["history"]
    assert len(raw.encode()) < state.config.max_history_bytes and "data:image/" not in raw
    assert state.history(OWNER, SID) == history
    assert state.db.execute("SELECT count(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 2

    meta = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": SID,
            "last_consolidated": 1, "history_prefix_digest": history_fingerprint(history[:1]),
            "metadata": {"snapshot": [first]}, "compaction_retry": {}}
    value = {"state": meta, "source_history_length": len(history),
             "source_history_digest": history_fingerprint(history)}
    state.save_context(OWNER, SID, value)
    assert state.context_state(OWNER, SID) == meta
    assert "data:image/" not in state.db.execute("SELECT state FROM conversation_context").fetchone()[0]
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    state.create_run(OWNER, SID, NewTurn(request_id="c" * 32, model_id="fixture", text="next"))
    assert state.history(OWNER, SID)[:len(history)] == history
    assert state.context_state(OWNER, SID)["history_prefix_digest"] == history_fingerprint(history[:1])


def test_unknown_resolution_recovers_legacy_checkpoint_once_without_charging(state):
    first, second = image(b"a"), image(b"b")
    legacy = [{"role": "user", "content": "a" * 22000},
              {"role": "tool", "name": "office", "tool_call_id": "earlier", "content": [first]}]
    checkpoint = {"phase": "tools_completed",
                  "assistant_message": {"role": "assistant", "content": "", "tool_calls": []},
                  "completed_tool_results": [{"role": "tool", "name": "read_file",
                                              "tool_call_id": "latest", "content": [second]}],
                  "pending_tool_calls": []}
    assert len(encoded(legacy).encode()) < state.config.max_history_bytes
    assert len(encoded(legacy + checkpoint["completed_tool_results"]).encode()) > state.config.max_history_bytes
    # Legacy production state was written by the old version and could not fit
    # the checkpoint projection. This setup never invokes a model or tool.
    state.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(legacy), OWNER, SID))
    state.db.execute("UPDATE runs SET status='unknown',result=?,checkpoint=? WHERE owner=? AND id=?",
                     (encoded({"message": "结果待核对", "workspace_saved": False}), encoded(checkpoint), OWNER, RID))
    state.resolve_unknown(OWNER, "run", RID, "verified execution and sandbox stopped")
    state.resolve_unknown(OWNER, "run", RID, "verified execution and sandbox stopped")
    restored = state.history(OWNER, SID)
    assert restored[:len(legacy)] == legacy
    matching = [m for m in restored if m.get("role") == "tool" and m.get("tool_call_id") == "latest"]
    assert len(matching) == 1 and matching[0]["content"] == [second]
    assert state.run(OWNER, RID)["status"] == "interrupted"
    assert state.db.execute("SELECT count(*) FROM billing_journal").fetchone()[0] == 0


def test_unknown_resolution_does_not_duplicate_already_merged_checkpoint(state):
    pic = image(b"z")
    checkpoint = {"phase": "tools_completed",
                  "assistant_message": {"role": "assistant", "content": "", "tool_calls": []},
                  "completed_tool_results": [{"role": "tool", "name": "read_file", "tool_call_id": "one",
                                              "content": [pic]}], "pending_tool_calls": []}
    state.save_checkpoint(OWNER, RID, checkpoint)
    state.finish(OWNER, RID, "unknown", {"message": "结果待核对", "workspace_saved": False})
    before = state.history(OWNER, SID)
    assert sum(m.get("tool_call_id") == "one" for m in before) == 1
    state.resolve_unknown(OWNER, "run", RID, "verified execution and sandbox stopped")
    after = state.history(OWNER, SID)
    assert sum(m.get("tool_call_id") == "one" for m in after) == 1
    assert sum(m.get("content") == "结果待核对" for m in after) == 1
    assert next(m for m in after if m.get("tool_call_id") == "one")["content"] == [pic]


def test_failed_history_merge_retains_unknown_checkpoint_without_orphan_media(state):
    history = [{"role": "user", "content": "a" * 45000}]
    checkpoint = {"phase": "tools_completed", "assistant_message": {"role": "assistant", "content": ""},
                  "completed_tool_results": [{"role": "tool", "tool_call_id": "one", "name": "read_file",
                                              "content": [{"type": "text", "text": "b" * 25000}, image(b"c", 10000)]}],
                  "pending_tool_calls": []}
    assert len(encoded(history).encode()) < state.config.max_history_bytes
    assert len(encoded(checkpoint).encode()) < state.config.max_history_bytes
    state.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(history), OWNER, SID))
    state.db.execute("UPDATE runs SET checkpoint=? WHERE owner=? AND id=?", (encoded(checkpoint), OWNER, RID))
    state.finish(OWNER, RID, "unknown", {"message": "结果待核对", "workspace_saved": False})
    assert state.run(OWNER, RID)["status"] == "unknown"
    assert state.history(OWNER, SID) == history
    assert json.loads(state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]) == checkpoint
    assert state.db.execute("SELECT count(*) FROM history_media").fetchone()[0] == 0


def test_failed_cancelled_history_merge_cannot_be_reported_as_confirmed(state):
    history = [{"role": "user", "content": "a" * 45000}]
    checkpoint = {"phase": "tools_completed", "assistant_message": {"role": "assistant", "content": ""},
                  "completed_tool_results": [{"role": "tool", "tool_call_id": "one", "name": "read_file",
                                              "content": [{"type": "text", "text": "b" * 25000}, image(b"c", 10000)]}],
                  "pending_tool_calls": []}
    state.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(history), OWNER, SID))
    state.db.execute("UPDATE runs SET checkpoint=? WHERE owner=? AND id=?", (encoded(checkpoint), OWNER, RID))
    state.finish(OWNER, RID, "cancelled", {"message": "已停止", "workspace_saved": True})
    run = state.run(OWNER, RID)
    assert run["status"] == "unknown" and run["result"]["diagnostic"]["recovery_error_code"] == "history_limit"
    assert state.history(OWNER, SID) == history
    assert json.loads(state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]) == checkpoint
    assert state.db.execute("SELECT count(*) FROM history_media").fetchone()[0] == 0


def test_media_reference_is_not_resolved_for_other_owner(state):
    state.save_history(OWNER, RID, [{"role": "tool", "content": [image(b"a")]}])
    reference = json.loads(state.session(OWNER, SID)["history"])
    state.create_session(OTHER, NewSession(request_id=SID))
    state.db.execute("UPDATE sessions SET history=? WHERE owner=? AND id=?", (encoded(reference), OTHER, SID))
    with pytest.raises(WorkError):
        state.history(OTHER, SID)


def test_delete_reclaims_unshared_media_without_affecting_other_sessions_or_owners(state):
    unique, shared = image(b"a"), image(b"b")
    state.save_history(OWNER, RID, [{"role": "tool", "content": [unique, shared]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    second_sid, second_run = "c" * 32, "d" * 32
    state.create_session(OWNER, NewSession(request_id=second_sid))
    state.create_run(OWNER, second_sid, NewTurn(request_id=second_run, model_id="fixture", text="other"))
    second = [{"role": "tool", "content": [shared]}]
    state.save_history(OWNER, second_run, second)
    state.finish(OWNER, second_run, "completed", {"workspace_saved": True})
    state.create_session(OTHER, NewSession(request_id=SID))
    state.create_run(OTHER, SID, NewTurn(request_id=RID, model_id="fixture", text="other account"))
    state.save_history(OTHER, RID, [{"role": "tool", "content": [unique]}])
    state.finish(OTHER, RID, "completed", {"workspace_saved": True})
    desktop = DesktopStore(SimpleNamespace(config=state.config, store=state), TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.history(OWNER, second_sid) == second
        assert state.history(OTHER, SID) == [{"role": "tool", "content": [unique]}]
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OTHER,)).fetchone()[0] == 1
    finally:
        desktop.close()


def test_delete_does_not_remove_unrelated_unreferenced_media(state):
    state.save_history(OWNER, RID, [{"role": "tool", "content": [image(b"a")]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    with state.transaction():
        orphan = state._pack_media(OWNER, [{"role": "tool", "content": [image(b"z")]}])
    desktop = DesktopStore(SimpleNamespace(config=state.config, store=state), TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        assert state._restore_media(OWNER, orphan) == [{"role": "tool", "content": [image(b"z")]}]
    finally:
        desktop.close()


def test_delete_retains_media_referenced_by_other_checkpoint_and_context(state):
    first, second = image(b"a"), image(b"b")
    state.save_history(OWNER, RID, [{"role": "tool", "content": [first, second]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    sid, run = "c" * 32, "d" * 32
    state.create_session(OWNER, NewSession(request_id=sid))
    state.create_run(OWNER, sid, NewTurn(request_id=run, model_id="fixture", text="other"))
    history = [{"role": "user", "content": "other"}]
    state.save_history(OWNER, run, history)
    checkpoint = {"phase": "tools_completed", "completed_tool_results": [{"content": [first]}], "pending_tool_calls": []}
    state.save_checkpoint(OWNER, run, checkpoint)
    ctx = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": sid,
           "last_consolidated": 0, "history_prefix_digest": history_fingerprint([]),
           "metadata": {"snapshot": [second]}, "compaction_retry": {}}
    state.save_context(OWNER, sid, {"state": ctx, "source_history_length": 1,
                                   "source_history_digest": history_fingerprint(history)})
    state.finish(OWNER, run, "completed", {"workspace_saved": True})
    desktop = DesktopStore(SimpleNamespace(config=state.config, store=state), TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 2
        assert state.context_state(OWNER, sid) == ctx
        raw = state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, run)).fetchone()[0]
        assert state._restore_media(OWNER, json.loads(raw)) == checkpoint
    finally:
        desktop.close()


def test_delete_defers_media_cleanup_during_another_active_run(state):
    state.save_history(OWNER, RID, [{"role": "tool", "content": [image(b"a")]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    second_sid, second_run = "c" * 32, "d" * 32
    state.create_session(OWNER, NewSession(request_id=second_sid))
    state.create_run(OWNER, second_sid, NewTurn(request_id=second_run, model_id="fixture", text="running"))
    desktop = DesktopStore(SimpleNamespace(config=state.config, store=state), TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        state.finish(OWNER, second_run, "completed", {"workspace_saved": True})
        desktop.delete(OWNER, second_sid)
        # Without a durable deferred-deletion reference the image is kept, not guessed safe.
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
    finally:
        desktop.close()


@pytest.mark.parametrize("in_memory", ["active_user", "cleanup_task"])
def test_delete_defers_cleanup_while_owner_still_has_in_memory_work(state, in_memory):
    state.save_history(OWNER, RID, [{"role": "tool", "content": [image(b"a")]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    service = SimpleNamespace(config=state.config, store=state,
        active_users={OWNER} if in_memory == "active_user" else set(),
        tasks={(OWNER, RID): SimpleNamespace(done=lambda: False)} if in_memory == "cleanup_task" else {})
    desktop = DesktopStore(service, TenantFiles(state.config, state.session))
    try:
        desktop.delete(OWNER, SID)
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
    finally:
        desktop.close()


def test_media_cleanup_failure_rolls_back_session_delete(state):
    state.save_history(OWNER, RID, [{"role": "tool", "content": [image(b"a")]}])
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    desktop = DesktopStore(SimpleNamespace(config=state.config, store=state), TenantFiles(state.config, state.session))
    try:
        state.db.execute("CREATE TRIGGER reject_media_delete BEFORE DELETE ON history_media BEGIN SELECT RAISE(ABORT,'test'); END")
        with pytest.raises(sqlite3.IntegrityError):
            desktop.delete(OWNER, SID)
        assert state.history(OWNER, SID)[0]["content"] == [image(b"a")]
        assert state.db.execute("SELECT COUNT(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
    finally:
        desktop.close()


def test_offline_rollback_restores_exact_urls_without_deleting_media(state):
    first, second = image(b"a", 18000), image(b"b", 18000)
    history = [{"role": "user", "content": "question"}, {"role": "tool", "content": [first, second]}]
    state.save_history(OWNER, RID, history)
    checkpoint = {"phase": "tools_completed", "completed_tool_results": [{"role": "tool", "content": [second]}],
                  "pending_tool_calls": []}
    state.save_checkpoint(OWNER, RID, checkpoint)
    ctx = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": SID,
           "last_consolidated": 1, "history_prefix_digest": history_fingerprint(history[:1]),
           "metadata": {"snapshot": [first]}, "compaction_retry": {}}
    state.save_context(OWNER, SID, {"state": ctx, "source_history_length": len(history),
                                   "source_history_digest": history_fingerprint(history)})
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    count = state.db.execute("SELECT count(*) FROM history_media").fetchone()[0]
    result = restore_for_legacy(state)
    assert result == {"sessions": 1, "runs": 1, "conversation_context": 1}
    assert json.loads(state.session(OWNER, SID)["history"]) == history
    assert json.loads(state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]) == checkpoint
    assert json.loads(state.db.execute("SELECT state FROM conversation_context WHERE owner=? AND session_id=?", (OWNER, SID)).fetchone()[0]) == ctx
    assert state.db.execute("SELECT count(*) FROM history_media").fetchone()[0] == count


def test_offline_rollback_is_atomic_if_any_media_is_corrupted(state):
    first, second = image(b"a"), image(b"b")
    state.save_history(OWNER, RID, [{"role": "tool", "content": [first]}])
    state.save_checkpoint(OWNER, RID, {"completed_tool_results": [{"content": [second]}]})
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    history_before = state.session(OWNER, SID)["history"]
    checkpoint_before = state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]
    row = state.db.execute("SELECT digest FROM history_media WHERE owner=? ORDER BY digest", (OWNER,)).fetchall()[-1]
    state.db.execute("UPDATE history_media SET data=? WHERE owner=? AND digest=?", (b"corrupted", OWNER, row[0]))
    with pytest.raises(WorkError):
        restore_for_legacy(state)
    assert state.session(OWNER, SID)["history"] == history_before
    assert state.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0] == checkpoint_before


def test_offline_rollback_refuses_history_the_old_release_cannot_read(state):
    history = [{"role": "tool", "content": [image(b"a"), image(b"b")]}]
    state.save_history(OWNER, RID, history)
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    before = state.session(OWNER, SID)["history"]
    with pytest.raises(WorkError) as error:
        restore_for_legacy(state)
    assert error.value.code == "legacy_history_limit"
    assert state.session(OWNER, SID)["history"] == before
    assert state.history(OWNER, SID) == history


def test_offline_rollback_checks_legacy_ascii_json_limit(state):
    # Old child serialized with ensure_ascii=True, unlike storage's UTF-8.
    history = [{"role": "tool", "content": [{"type": "text", "text": "猫" * 12000}, image(b"a", 1000)]}]
    state.save_history(OWNER, RID, history)
    state.finish(OWNER, RID, "completed", {"workspace_saved": True})
    assert len(encoded(history).encode()) < state.config.max_history_bytes
    assert len(json.dumps(history).encode()) > state.config.max_history_bytes
    before = state.session(OWNER, SID)["history"]
    with pytest.raises(WorkError) as error:
        restore_for_legacy(state)
    assert error.value.code == "legacy_history_limit"
    assert state.session(OWNER, SID)["history"] == before


@pytest.mark.asyncio
async def test_turn_accepts_large_restored_images_without_truncating_model_input(tmp_path, monkeypatch):
    from mona.hosted_work.turn import run_turn
    from mona.providers.base import LLMProvider, LLMResponse
    from mona.providers.capabilities import ModelCapabilities

    class VisionModel(LLMProvider):
        def __init__(self):
            super().__init__()
            self.messages = None

        def get_default_model(self):
            return "fixture"

        def get_capabilities(self, _model):
            return ModelCapabilities(supports_tool_calling=True, supports_vision=True)

        async def chat(self, messages, **kwargs):
            return await self.chat_stream(messages, **kwargs)

        async def chat_stream(self, messages, **_kwargs):
            self.messages = messages
            return LLMResponse(content="completed")

    class Sandbox:
        async def file(self, _request):
            raise AssertionError("no file operation expected")

    first, second = image(b"a"), image(b"b")
    history = [{"role": "user", "content": "show images"},
               {"role": "assistant", "content": "", "tool_calls": [{"id": "one", "type": "function",
                   "function": {"name": "read_file", "arguments": "{}"}}]},
               {"role": "tool", "name": "read_file", "tool_call_id": "one", "content": [first, second]},
               {"role": "user", "content": "continue"}]
    config = HostedWorkConfig(state_dir=str(tmp_path), max_history_bytes=65536, history_media_expand_bytes=1024 * 1024,
                              models={"fixture": {"label": "fixture", "model": "fixture", "billing_mode": "free"}})
    assert len(encoded(history).encode()) > config.max_history_bytes
    model = VisionModel()
    monkeypatch.setattr("mona.hosted_work.context._scope", lambda *_: None)
    monkeypatch.setattr("mona.hosted_work.owner_memory.build_memory_tools", lambda _: [])
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="fixture", text="question"))
    store.save_history(OWNER, RID, history)
    compact, context = store.turn_state(OWNER, SID, compact=True)

    async def emit(_kind, _value):
        pass

    payload = {"model_id": "fixture", "run_id": RID, "session_id": SID, "owner": OWNER,
               "history": compact, "context_state": context,
               "history_media_database": str(tmp_path / "sessions.sqlite3")}
    try:
        result = await run_turn(config, payload, Sandbox(), model, emit)
    finally:
        store.close()
    assert result["status"] == "completed"
    serialized = json.dumps(model.messages, ensure_ascii=False)
    assert first["image_url"]["url"] in serialized and second["image_url"]["url"] in serialized
    assert "mona-history-media:" not in serialized and str(tmp_path / "sessions.sqlite3") not in serialized


@pytest.mark.asyncio
async def test_combined_history_and_context_budget_is_checked_before_new_dispatch(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path), max_history_bytes=65536,
                              history_media_storage_bytes=4 * 1024 * 1024,
                              history_media_expand_bytes=1024 * 1024,
                              models={"fixture": {"label": "fixture", "model": "fixture", "billing_mode": "free"}})
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    try:
        store.create_session(OWNER, NewSession(request_id=SID))
        store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="fixture", text="question"))
        history = [{"role": "user", "content": "question"},
                   {"role": "tool", "name": "read_file", "tool_call_id": "one", "content": [image(b"a", 450000)]}]
        store.save_history(OWNER, RID, history)
        state = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": SID,
                 "last_consolidated": 1, "history_prefix_digest": history_fingerprint(history[:1]),
                 "metadata": {"snapshot": [image(b"b", 450000)]}, "compaction_retry": {}}
        store.save_context(OWNER, SID, {"state": state, "source_history_length": len(history),
                                       "source_history_digest": history_fingerprint(history)})
        store.finish(OWNER, RID, "completed", {"workspace_saved": True})
        service = WorkService(config, store, None, None)
        with pytest.raises(WorkError) as error:
            await service.submit(OWNER, "fixture-token", SID,
                                 NewTurn(request_id="c" * 32, model_id="fixture", text="next"))
        assert error.value.code == "history_media_limit"
        assert store.db.execute("SELECT COUNT(*) FROM runs WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        assert not service.active_users and store.db.execute("SELECT COUNT(*) FROM billing_journal").fetchone()[0] == 0
    finally:
        store.close()


def test_compact_child_input_restores_owner_data_from_read_only_store(state, tmp_path):
    from mona.hosted_work.turn import _restore_turn_media

    original = [{"role": "tool", "content": [image(b"a")]}]
    state.save_history(OWNER, RID, original)
    compact, context = state.turn_state(OWNER, SID, compact=True)
    assert "mona-history-media:" in encoded(compact) and "data:image/" not in encoded(compact)
    path = state.db.execute("PRAGMA database_list").fetchone()[2]
    payload = {"owner": OWNER, "history": compact, "context_state": context, "history_media_database": path}
    restored = _restore_turn_media(state.config, payload)
    assert restored["history"] == original and payload["history"] == compact
    assert "history_media_database" not in restored and "mona-history-media:" not in encoded(restored)
    with pytest.raises(WorkError):
        _restore_turn_media(state.config, {**payload, "owner": OTHER})
    outside = tmp_path.parent / "outside-history.sqlite3"
    outside.write_bytes(b"not a database")
    with pytest.raises(WorkError):
        _restore_turn_media(state.config, {**payload, "history_media_database": str(outside)})
    wrong_database = tmp_path / "another.sqlite3"
    wrong_database.write_bytes(b"not the Work database")
    with pytest.raises(WorkError):
        _restore_turn_media(state.config, {**payload, "history_media_database": str(wrong_database)})
