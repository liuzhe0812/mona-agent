"""Unknown executions are closed as tracking, never replayed or promoted to success."""
import json

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.store import WorkStore

OWNER, SID, RID = owner_key("1"), "a" * 32, "b" * 32


@pytest.fixture
def store(tmp_path):
    value = WorkStore(tmp_path / "state.sqlite3", HostedWorkConfig())
    value.create_session(OWNER, NewSession(request_id=SID))
    yield value
    value.close()


def test_reconciliation_preserves_request_checkpoint_and_unknown_fact(store):
    request = NewTurn(request_id=RID, model_id="official", text="original")
    store.create_run(OWNER, SID, request)
    store.save_checkpoint(OWNER, RID, {"started_tool_call_ids": ["original-call"]})
    store.recover()
    store.resolve_unknown(OWNER, "run", RID, "核对独立测试环境，执行进程已结束。")
    run = store.run(OWNER, RID)
    assert run["status"] == "interrupted"
    assert "仍不确定" in run["result"]["message"]
    assert store.create_run(OWNER, SID, request)[1] is False
    assert json.loads(store.db.execute("SELECT checkpoint FROM runs").fetchone()[0]) == {"started_tool_call_ids": ["original-call"]}
    store.resolve_unknown(OWNER, "run", RID, "再次核对不重复改变状态。")
    assert store.db.execute("SELECT COUNT(*) FROM resolutions").fetchone()[0] == 1
    store.require_idle(OWNER)


def test_active_execution_cannot_be_unlocked_by_reconciliation(store):
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="official", text="original"))
    with pytest.raises(WorkError):
        store.resolve_unknown(OWNER, "run", RID, "not unknown")
    assert store.run(OWNER, RID)["status"] == "running"
    assert store.db.execute("SELECT COUNT(*) FROM resolutions").fetchone()[0] == 0


def test_file_unknown_requires_exact_identity_and_keeps_resolution_record(store):
    store.begin_file_operation(OWNER, RID, "upload")
    store.recover()
    assert store.unknown_records() == [{"kind": "file", "owner": OWNER, "id": RID}]
    with pytest.raises(WorkError):
        store.resolve_unknown(owner_key("2"), "file", RID, "wrong owner")
    with pytest.raises(WorkError):
        store.resolve_unknown(OWNER, "file", RID, "")
    store.resolve_unknown(OWNER, "file", RID, "原文件操作结果待用户确认，进程已经结束。")
    assert store.unknown_count() == 0
    assert store.db.execute("SELECT note FROM resolutions").fetchone()[0].startswith("原文件操作")
