"""Exercise crash recovery against a local journal and an offline Auth double."""

import pytest

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.billing import BillingError
from mona.hosted_work.contracts import NewSession, NewTurn, owner_key
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore

OWNER, SID, RID, CHARGE = owner_key("1"), "a" * 32, "b" * 32, "c" * 32
USAGE = {"input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 300}


class BillingDouble:
    def __init__(self):
        self.status = "reserved"
        self.actual_units = 4100
        self.calls = []
        self.failure = None
        self.uncertain_failure = None
        self.lose_release_reply = False
        self.lose_settle_reply = False
        self.settled_usage = None
        self.debits = 0

    def response(self):
        return {"run_id": CHARGE, "status": self.status, "reserved_units": 5000,
                "actual_units": self.actual_units if self.status == "settled" else None}

    async def get(self, charge):
        self.calls.append(("get", charge))
        if self.failure:
            raise self.failure
        return self.response()

    async def release(self, charge):
        self.calls.append(("release", charge))
        assert self.status == "reserved"
        self.status = "released"
        if self.lose_release_reply:
            self.lose_release_reply = False
            raise BillingError("billing_unknown", "unknown", 503)
        return self.response()

    async def uncertain(self, charge, reason):
        self.calls.append(("uncertain", charge, reason))
        if self.uncertain_failure:
            raise self.uncertain_failure
        self.status = "uncertain"
        return self.response()

    async def settle(self, charge, usage):
        self.calls.append(("settle", charge, usage.copy()))
        if self.settled_usage is None:
            self.settled_usage = usage.copy()
            self.debits += 1
            self.status = "settled"
        else:
            assert self.settled_usage == usage
        if self.lose_settle_reply:
            self.lose_settle_reply = False
            raise BillingError("billing_unknown", "unknown", 503)
        return self.response()

    async def dispatch(self, charge):
        raise AssertionError("recovery must not dispatch the model again")


class NoExecutor:
    async def execute(self, *_args, **_kwargs):
        raise AssertionError("recovery must not execute a model task")


@pytest.fixture
def environment(tmp_path, monkeypatch):
    config = HostedWorkConfig()
    store = WorkStore(tmp_path / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="test", text="hello"))
    store.billing_begin(OWNER, RID, CHARGE)
    billing = BillingDouble()
    monkeypatch.setattr("mona.hosted_work.service.HostedBilling", lambda _config: billing)
    service = WorkService(config, store, None, NoExecutor())
    yield service, store, billing
    store.close()


def advance(store, stage):
    if stage == "reserving":
        return
    for name in ("reserved", "dispatching", "running", "usage_ready"):
        if name == "usage_ready":
            store.billing_update(OWNER, RID, name, usage=USAGE, expected_units=4100)
        else:
            store.billing_update(OWNER, RID, name)
        if name == stage:
            return
    assert stage == "uncertain"
    store.billing_update(OWNER, RID, "uncertain")


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["reserving", "reserved"])
async def test_only_confirmed_undispatched_reservation_is_released(environment, stage):
    service, store, billing = environment
    advance(store, stage)
    await service._recover_billing_once()
    assert billing.calls == [("get", CHARGE), ("release", CHARGE)]
    assert store.billing_pending() == []
    await service._recover_billing_once()
    assert len(billing.calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("remote_status", ["running", "uncertain", "settled"])
async def test_other_remote_states_are_never_released(environment, remote_status):
    service, store, billing = environment
    billing.status = remote_status
    await service._recover_billing_once()
    assert billing.calls == [("get", CHARGE)]
    assert store.billing_pending()[0]["stage"] == "reserving"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [404, 503])
async def test_missing_or_unreachable_remote_record_remains_pending(environment, status):
    service, store, billing = environment
    billing.failure = BillingError("billing_unknown", "unknown", status)
    await service._recover_billing_once()
    assert billing.calls == [("get", CHARGE)]
    assert store.billing_pending()[0]["stage"] == "reserving"


@pytest.mark.asyncio
async def test_lost_release_response_is_reconciled_without_second_release(environment):
    service, store, billing = environment
    billing.lose_release_reply = True
    await service._recover_billing_once()
    assert store.billing_pending()[0]["stage"] == "reserving"
    await service._recover_billing_once()
    assert store.billing_pending() == []
    assert billing.calls == [("get", CHARGE), ("release", CHARGE), ("get", CHARGE)]


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["dispatching", "running"])
async def test_dispatched_or_ambiguous_execution_is_marked_unknown_without_replay(environment, stage):
    service, store, billing = environment
    advance(store, stage)
    await service._recover_billing_once()
    assert billing.calls == [("uncertain", CHARGE, "provider_outcome_unknown")]
    assert store.billing_pending()[0]["stage"] == "uncertain"
    await service._recover_billing_once()
    assert len(billing.calls) == 1


@pytest.mark.asyncio
async def test_unknown_notification_failure_preserves_dispatching_for_retry(environment):
    service, store, billing = environment
    advance(store, "dispatching")
    billing.uncertain_failure = BillingError("billing_unknown", "unknown", 503)
    await service._recover_billing_once()
    assert billing.calls == [("uncertain", CHARGE, "provider_outcome_unknown")]
    assert store.billing_pending()[0]["stage"] == "dispatching"


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["usage_ready", "uncertain"])
async def test_saved_usage_can_settle_after_lost_response_without_double_debit(environment, stage):
    service, store, billing = environment
    advance(store, stage)
    billing.lose_settle_reply = True
    await service._recover_billing_once()
    assert store.billing_pending()[0]["stage"] == stage
    assert billing.debits == 1
    await service._recover_billing_once()
    assert store.billing_pending() == []
    assert billing.debits == 1
    assert billing.calls == [("settle", CHARGE, USAGE), ("settle", CHARGE, USAGE)]


@pytest.mark.asyncio
async def test_mismatched_settled_amount_stays_pending(environment):
    service, store, billing = environment
    advance(store, "usage_ready")
    billing.actual_units = 4101
    await service._recover_billing_once()
    await service._recover_billing_once()
    assert store.billing_pending()[0]["stage"] == "usage_ready"
    assert store.billing_pending()[0]["expected_units"] == 4100
    assert billing.debits == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("active", ["user", "task"])
async def test_active_owner_or_task_is_skipped(environment, active):
    service, store, billing = environment
    if active == "user":
        service.active_users.add(OWNER)
    else:
        service.tasks[(OWNER, RID)] = None
    await service._recover_billing_once()
    assert billing.calls == []
    assert store.billing_pending()[0]["stage"] == "reserving"
