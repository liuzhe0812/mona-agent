"""Durable charge records for recovery; no wallet service or model is contacted."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.store import WorkStore

OWNER = owner_key("1")
OTHER = owner_key("2")
SESSION = "a" * 32
RUN = "b" * 32
CHARGE = "c" * 32
USAGE = {"input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 300}


@pytest.fixture
def store(tmp_path):
    store = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
    for owner in (OWNER, OTHER):
        store.create_session(owner, NewSession(request_id=SESSION))
        store.create_run(owner, SESSION, NewTurn(request_id=RUN, model_id="test", text="hello"))
    yield store
    store.close()


def advance(store, stage):
    store.billing_begin(OWNER, RUN, CHARGE)
    for name in ("reserved", "dispatching", "running", "usage_ready"):
        if name == "usage_ready":
            store.billing_update(OWNER, RUN, name, usage=USAGE, expected_units=4100)
        else:
            store.billing_update(OWNER, RUN, name)
        if name == stage:
            return


def test_pending_survives_restart_with_frozen_usage_and_run_recovery(store, tmp_path):
    advance(store, "usage_ready")
    before = store.billing_pending()
    assert before == [{"owner": OWNER, "run_id": RUN, "charge_id": CHARGE, "stage": "usage_ready",
                       "usage": USAGE, "expected_units": 4100}]
    store.close()
    reopened = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
    try:
        assert reopened.billing_pending() == before
        reopened.recover()
        assert reopened.run(OWNER, RUN)["status"] == "unknown"
        assert reopened.billing_pending() == before
        assert reopened.billing_update(OWNER, RUN, "settled")["stage"] == "settled"
        assert reopened.billing_pending() == []
    finally:
        reopened.close()


def test_existing_store_gains_journal_without_losing_run(store, tmp_path):
    store.db.execute("DROP TABLE billing_journal")
    store.close()
    reopened = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
    try:
        assert reopened.run(OWNER, RUN)["status"] == "running"
        assert reopened.billing_begin(OWNER, RUN, CHARGE)["stage"] == "reserving"
    finally:
        reopened.close()


def test_begin_is_owner_bound_and_same_charge_id_cannot_bind_two_runs(store):
    first = store.billing_begin(OWNER, RUN, CHARGE)
    assert first["stage"] == "reserving" and first["usage"] is None
    assert store.billing_begin(OWNER, RUN, CHARGE) == first
    with pytest.raises(WorkError) as changed:
        store.billing_begin(OWNER, RUN, "d" * 32)
    assert changed.value.status == 409
    with pytest.raises(WorkError) as collision:
        store.billing_begin(OTHER, RUN, CHARGE)
    assert collision.value.status == 409
    assert store.billing_begin(OTHER, RUN, "d" * 32)["owner"] == OTHER
    with pytest.raises(WorkError) as missing:
        store.billing_begin(OWNER, "e" * 32, "f" * 32)
    assert missing.value.status == 404
    assert len(store.billing_pending()) == 2


def test_stage_transitions_reject_replay_and_changed_usage(store):
    advance(store, "usage_ready")
    assert store.billing_update(OWNER, RUN, "usage_ready", usage=dict(reversed(list(USAGE.items()))),
                                expected_units=4100)["usage"] == USAGE
    for stage, usage, expected in (
        ("running", None, None),
        ("released", None, None),
        ("usage_ready", {**USAGE, "output_tokens": 301}, 4100),
        ("usage_ready", USAGE, 4101),
    ):
        with pytest.raises(WorkError) as conflict:
            store.billing_update(OWNER, RUN, stage, usage=usage, expected_units=expected)
        assert conflict.value.status == 409
    assert store.billing_pending()[0]["usage"] == USAGE
    assert store.billing_update(OWNER, RUN, "uncertain")["usage"] == USAGE
    assert store.billing_update(OWNER, RUN, "settled")["stage"] == "settled"
    assert store.billing_update(OWNER, RUN, "settled", usage=USAGE, expected_units=4100)["stage"] == "settled"
    with pytest.raises(WorkError):
        store.billing_update(OWNER, RUN, "usage_ready", usage=USAGE, expected_units=4100)


@pytest.mark.parametrize("usage,expected", [
    (None, 0), (USAGE, None), ({}, 0),
    ({**USAGE, "cached_input_tokens": 1001}, 0),
    ({**USAGE, "output_tokens": True}, 0),
    ({**USAGE, "input_tokens": -1}, 0),
    (USAGE, True), (USAGE, -1),
])
def test_usage_and_expected_must_be_complete_nonnegative_integers(store, usage, expected):
    advance(store, "running")
    with pytest.raises(WorkError):
        store.billing_update(OWNER, RUN, "usage_ready", usage=usage, expected_units=expected)
    assert store.billing_pending()[0]["stage"] == "running"
    assert store.billing_pending()[0]["usage"] is None


def test_unknown_without_usage_stays_pending_and_cannot_settle_as_zero(store):
    advance(store, "running")
    store.billing_update(OWNER, RUN, "uncertain")
    with pytest.raises(WorkError):
        store.billing_update(OWNER, RUN, "settled")
    with pytest.raises(WorkError):
        store.billing_update(OWNER, RUN, "settled", usage=USAGE, expected_units=4100)
    assert store.billing_pending()[0]["stage"] == "uncertain"


def test_only_known_pre_dispatch_outcomes_leave_pending(store):
    store.billing_begin(OWNER, RUN, CHARGE)
    assert store.billing_update(OWNER, RUN, "released")["stage"] == "released"
    assert store.billing_update(OWNER, RUN, "released")["stage"] == "released"
    with pytest.raises(WorkError):
        store.billing_update(OWNER, RUN, "reserved")
    store.billing_begin(OTHER, RUN, "d" * 32)
    assert store.billing_update(OTHER, RUN, "rejected")["stage"] == "rejected"
    assert store.billing_pending() == []


def test_competing_charge_bindings_commit_only_one_identity(store, tmp_path):
    barrier = Barrier(2)

    def begin(charge_id):
        local = WorkStore(tmp_path / "work.sqlite3", HostedWorkConfig())
        try:
            barrier.wait(timeout=5)
            try:
                local.billing_begin(OWNER, RUN, charge_id)
                return "created"
            except WorkError as exc:
                assert exc.status == 409
                return "conflict"
        finally:
            local.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(begin, (CHARGE, "d" * 32))) == ["conflict", "created"]
    assert len(store.billing_pending()) == 1
