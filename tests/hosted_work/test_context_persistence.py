"""Owned context metadata stays tied to canonical history and session lifetime."""
import copy
import json

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.context import history_fingerprint
from mona.hosted_work.contracts import NewSession, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles


def test_context_cannot_cross_owner_or_history_and_is_deleted_with_session(tmp_path):
    owner, sid = owner_key("21"), "a" * 32
    config = HostedWorkConfig(state_dir=str(tmp_path))
    store = WorkStore(tmp_path / "work.sqlite3", config)
    service = WorkService(config, store, None, None)
    desktop = DesktopStore(service, TenantFiles(config, store.session))
    try:
        store.create_session(owner, NewSession(request_id=sid))
        state = {"format": "mona-hosted-context-v1", "owner": owner, "session_id": sid,
                 "last_consolidated": 0, "history_prefix_digest": history_fingerprint([]),
                 "metadata": {"summary": "owned"}, "compaction_retry": {}}
        value = {"state": state, "source_history_length": 0, "source_history_digest": history_fingerprint([])}
        store.save_context(owner, sid, value)
        for altered in ({**value, "source_history_digest": "0" * 64},
                        {**value, "state": {**copy.deepcopy(state), "owner": owner_key("22")}}):
            with pytest.raises(WorkError):
                store.save_context(owner, sid, altered)
            assert store.context_state(owner, sid) == state
        desktop.delete(owner, sid)
        assert store.db.execute("SELECT count(*) FROM conversation_context").fetchone()[0] == 0
    finally:
        desktop.close()
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("rename_during_run", [False, True])
async def test_generated_title_cannot_overwrite_explicit_title(tmp_path, rename_during_run):
    owner, sid, rid = owner_key("21"), "a" * 32, "b" * 32
    from mona.hosted_work.contracts import NewTurn

    config = HostedWorkConfig(state_dir=str(tmp_path), models={"qwen": {"label": "Qwen", "model": "fixture"}})
    store = WorkStore(tmp_path / "work.sqlite3", config)

    class TitleExecutor:
        async def execute(self, payload, event):
            assert payload["title_user_edited"] is rename_during_run
            if rename_during_run:
                store.db.execute("UPDATE sessions SET title=? WHERE owner=? AND id=?", ("用户改名", owner, sid))
            await event("title", {"title": "生成的标题"})
            return {"status": "completed", "content": "完成", "workspace_saved": True, "artifacts": []}

    service = WorkService(config, store, None, TitleExecutor())
    try:
        store.create_session(owner, NewSession(request_id=sid, title="自定标题" if rename_during_run else "新任务"))
        await service.submit(owner, "test-only", sid, NewTurn(request_id=rid, model_id="qwen", text="普通问题"))
        import asyncio

        await asyncio.gather(*list(service.tasks.values()))
        assert store.session(owner, sid)["title"] == ("用户改名" if rename_during_run else "生成的标题")
        assert json.loads(store.session(owner, sid)["history"])[0]["content"] == "普通问题"
    finally:
        store.close()
