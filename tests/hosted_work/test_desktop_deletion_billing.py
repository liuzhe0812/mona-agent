"""Deleting a chat must not discard pending billing or leave false tombstones."""
import sqlite3
from types import SimpleNamespace

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.store import WorkStore
from mona.hosted_work.tenant_files import TenantFiles

ALICE, BOB = "a" * 64, "b" * 64
SID, RID, CHARGE, OTHER_CHARGE = "1" * 32, "2" * 32, "3" * 32, "4" * 32
USAGE = {"input_tokens": 10, "cached_input_tokens": 2, "output_tokens": 3}


@pytest.fixture
def state(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path), max_concurrent_runs=4)
    store = WorkStore(tmp_path / "work.sqlite3", config)
    state = DesktopStore(SimpleNamespace(config=config, store=store), TenantFiles(config, store.session))
    try:
        yield state
    finally:
        state.close()
        store.close()


def make_chat(state, owner, charge, stage):
    store = state.service.store
    store.create_session(owner, NewSession(request_id=SID))
    state.append(owner, SID, {"event": "user", "text": "test"}, "message")
    store.create_run(owner, SID, NewTurn(request_id=RID, model_id="model", text="test"))
    store.billing_begin(owner, RID, charge)
    if stage in {"released", "rejected", "uncertain"}:
        store.billing_update(owner, RID, stage)
    else:
        for next_stage in ("reserved", "dispatching", "running", "usage_ready", "settled"):
            if stage == "reserving":
                break
            if next_stage == "usage_ready":
                store.billing_update(owner, RID, next_stage, usage=USAGE, expected_units=7)
            else:
                store.billing_update(owner, RID, next_stage)
            if next_stage == stage:
                break
    store.finish(owner, RID, "completed", {"content": "done"})


@pytest.mark.parametrize("stage", ["settled", "released", "rejected"])
def test_deletes_only_terminal_local_billing_and_preserves_other_account(state, stage):
    make_chat(state, ALICE, CHARGE, stage)
    make_chat(state, BOB, OTHER_CHARGE, "settled")
    other = state.service.store.db.execute(
        "SELECT stage,charge_id,usage,expected_units FROM billing_journal WHERE owner=? AND run_id=?", (BOB, RID)
    ).fetchone()

    state.delete(ALICE, SID)

    with pytest.raises(WorkError) as missing:
        state.session(ALICE, SID)
    assert missing.value.status == 404
    assert state.service.store.db.execute("SELECT 1 FROM billing_journal WHERE owner=?", (ALICE,)).fetchone() is None
    assert state.db(ALICE).execute("SELECT 1 FROM deleted_chats WHERE chat_id=?", (SID,)).fetchone()
    assert state.db(ALICE).execute("SELECT 1 FROM transcript WHERE chat_id=?", (SID,)).fetchone() is None
    assert state.service.store.run(BOB, RID)["status"] == "completed"
    retained = state.service.store.db.execute(
        "SELECT stage,charge_id,usage,expected_units FROM billing_journal WHERE owner=? AND run_id=?", (BOB, RID)
    ).fetchone()
    assert tuple(retained) == tuple(other)
    assert state.records(BOB, SID)


@pytest.mark.parametrize("stage", ["reserving", "reserved", "dispatching", "running", "usage_ready", "uncertain"])
def test_unfinished_billing_blocks_deletion_even_after_run_ends(state, stage):
    make_chat(state, ALICE, CHARGE, stage)
    before = state.service.store.billing_pending()

    with pytest.raises(WorkError) as blocked:
        state.delete(ALICE, SID)

    assert blocked.value.code == "billing_pending" and blocked.value.status == 409
    assert state.service.store.billing_pending() == before
    assert state.service.store.run(ALICE, RID)["status"] == "completed"
    assert state.session(ALICE, SID)
    assert state.records(ALICE, SID)
    assert state.db(ALICE).execute("SELECT 1 FROM deleted_chats WHERE chat_id=?", (SID,)).fetchone() is None


@pytest.mark.parametrize("failure_site", ["run_delete", "tombstone_insert"])
def test_failed_delete_rolls_back_both_stores_and_can_be_retried(state, failure_site):
    make_chat(state, ALICE, CHARGE, "settled")
    work, desktop = state.service.store.db, state.db(ALICE)
    if failure_site == "run_delete":
        work.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON runs BEGIN SELECT RAISE(ABORT,'test'); END")
    else:
        desktop.execute("CREATE TRIGGER reject_delete BEFORE INSERT ON deleted_chats BEGIN SELECT RAISE(ABORT,'test'); END")

    with pytest.raises(sqlite3.IntegrityError):
        state.delete(ALICE, SID)

    assert state.session(ALICE, SID)
    assert state.service.store.run(ALICE, RID)["status"] == "completed"
    assert work.execute("SELECT stage FROM billing_journal WHERE owner=? AND run_id=?", (ALICE, RID)).fetchone()[0] == "settled"
    assert desktop.execute("SELECT 1 FROM deleted_chats WHERE chat_id=?", (SID,)).fetchone() is None
    assert state.records(ALICE, SID)
    (work if failure_site == "run_delete" else desktop).execute("DROP TRIGGER reject_delete")
    state.delete(ALICE, SID)
    with pytest.raises(WorkError) as missing:
        state.session(ALICE, SID)
    assert missing.value.status == 404
