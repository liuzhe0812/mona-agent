"""Exercise Work's billing boundary without a wallet service or model process."""

import asyncio
import copy
import json

import pytest
import pytest_asyncio

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.billing import BillingError, charge_id
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore

OWNER, SID, RID = owner_key("1"), "a" * 32, "b" * 32
CHARGE_ID = charge_id(OWNER, RID)
TOKEN = "test-account-token"
RECEIPT = {"complete": True, "prompt_tokens": 2, "cached_tokens": 1, "completion_tokens": 1}
SETTLEMENT_USAGE = {"input_tokens": 2, "cached_input_tokens": 1, "output_tokens": 1}


class BillingDouble:
    def __init__(self, events):
        self.events = events
        self.reserve_entered = asyncio.Event()
        self.reserve_release = asyncio.Event()
        self.reserve_release.set()
        self.reject_reserve = False
        self.lost_settlement_reply = False
        self.balance = 100
        self.settlements = 0

    async def reserve(self, run_id, token, model):
        self.events.append(("reserve", run_id, token, model.model))
        self.reserve_entered.set()
        await self.reserve_release.wait()
        if self.reject_reserve:
            raise BillingError("insufficient_balance", "账号余额不足。", 402, rejected=True)
        return {"status": "reserved"}

    async def dispatch(self, run_id):
        self.events.append(("dispatch", run_id))
        return {"status": "running"}

    async def settle(self, run_id, usage):
        self.events.append(("settle", run_id, copy.deepcopy(usage)))
        # At CNY 0.1/million for each tier, the three components each
        # independently round up to one micro-unit.
        self.balance -= 3
        self.settlements += 1
        if self.lost_settlement_reply:
            raise BillingError("billing_unknown", "结算状态待核对。", 503)
        return {"status": "settled", "actual_units": 3}

    async def uncertain(self, run_id, reason):
        self.events.append(("uncertain", run_id, reason))
        return {"status": "uncertain"}


class ExecutorDouble:
    def __init__(self, events):
        self.events = events
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.failure = None
        self.result = {"status": "completed", "content": "done", "workspace_saved": True,
                       "artifacts": [], "billing_usage": copy.deepcopy(RECEIPT),
                       "usage": {"prompt_tokens": 999, "completion_tokens": 999}}

    async def execute(self, payload, _emit):
        self.events.append(("execute", payload["run_id"]))
        self.entered.set()
        await self.release.wait()
        if self.failure:
            raise self.failure
        return copy.deepcopy(self.result)

    def cancel(self, _owner, _run_id):
        self.release.set()


@pytest_asyncio.fixture
async def environment(tmp_path, monkeypatch):
    operator = tmp_path / "operator.json"
    operator.write_text(json.dumps({"hosted_work": {"codex": {"cli_path": str(tmp_path / "codex")}}}),
                        encoding="utf-8")
    config = HostedWorkConfig(operator_config_path=str(operator), max_concurrent_runs=4, models={
        "codex": {"label": "Codex", "source": "codex", "model": "test-codex", "billing_mode": "wallet",
                  "price": {"input_amount_per_million": "0.1", "cached_input_amount_per_million": "0.1",
                            "output_amount_per_million": "0.1"}},
        "qwen": {"label": "Qwen", "source": "mona", "model": "test-qwen", "billing_mode": "free"},
    })
    events = []
    billing = BillingDouble(events)
    executor = ExecutorDouble(events)
    monkeypatch.setattr("mona.hosted_work.service.HostedBilling", lambda _config: billing)
    # Admission is covered separately from the billing lifecycle.
    monkeypatch.setattr("mona.hosted_work.service.require_model_available",
                        lambda _model, _config, *, billing_authorized=False: None)
    store = WorkStore(tmp_path / "work.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    service = WorkService(config, store, None, executor)
    try:
        yield service, executor, billing, events
    finally:
        billing.reserve_release.set()
        executor.release.set()
        await service.close()
        store.close()


def request(model="codex", text="hello"):
    return NewTurn(request_id=RID, model_id=model, text=text)


async def finish(service, executor):
    await asyncio.wait_for(executor.entered.wait(), 3)
    task = service.tasks[(OWNER, RID)]
    executor.release.set()
    await asyncio.wait_for(task, 3)
    return service.store.run(OWNER, RID)


@pytest.mark.asyncio
async def test_reserve_dispatch_and_settle_once_using_confirmed_usage(environment):
    service, executor, billing, events = environment
    billing.reserve_release.clear()
    first = asyncio.create_task(service.submit(OWNER, TOKEN, SID, request()))
    await asyncio.wait_for(billing.reserve_entered.wait(), 3)

    retry = await service.submit(OWNER, TOKEN, SID, request())
    assert retry["status"] == "running"
    assert [event[0] for event in events] == ["reserve"]
    assert not executor.entered.is_set()

    billing.reserve_release.set()
    accepted = await asyncio.wait_for(first, 3)
    assert accepted["id"] == RID
    await asyncio.wait_for(executor.entered.wait(), 3)
    # A live configuration edit cannot change an accepted turn's price snapshot.
    service.config.models["codex"].price.input_amount_per_million = "10"
    completed = await finish(service, executor)
    assert completed["status"] == "completed"
    assert events == [("reserve", CHARGE_ID, TOKEN, "test-codex"), ("dispatch", CHARGE_ID), ("execute", RID),
                      ("settle", CHARGE_ID, SETTLEMENT_USAGE)]
    assert billing.balance == 97 and billing.settlements == 1
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "completed"
    assert billing.balance == 97 and billing.settlements == 1 and len(events) == 4
    with pytest.raises(WorkError) as conflict:
        await service.submit(OWNER, TOKEN, SID, request(text="different"))
    assert conflict.value.code == "request_conflict"


@pytest.mark.asyncio
async def test_insufficient_balance_rejects_without_dispatch(environment):
    service, executor, billing, events = environment
    billing.reject_reserve = True
    with pytest.raises(BillingError) as caught:
        await service.submit(OWNER, TOKEN, SID, request())
    assert caught.value.code == "insufficient_balance" and caught.value.status == 402
    assert [event[0] for event in events] == ["reserve"]
    assert not executor.entered.is_set() and billing.balance == 100
    assert service.store.run(OWNER, RID)["status"] == "failed"
    assert service.active_users == service.active_engines == set()
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "failed"
    assert len(events) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt", [
    None,
    {"complete": False, "prompt_tokens": 2, "cached_tokens": 1, "completion_tokens": 1},
    {"complete": True, "prompt_tokens": 2, "cached_tokens": 3, "completion_tokens": 1},
    {"complete": True, "prompt_tokens": True, "cached_tokens": 0, "completion_tokens": 1},
])
async def test_unconfirmed_usage_is_unknown_and_never_settled(environment, receipt):
    service, executor, billing, events = environment
    executor.result["billing_usage"] = receipt
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "unknown"
    assert events[-1] == ("uncertain", CHARGE_ID, "usage_unavailable")
    assert "settle" not in [event[0] for event in events]
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "unknown"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute", "uncertain"]


@pytest.mark.asyncio
async def test_lost_settlement_reply_never_dispatches_or_charges_again(environment):
    service, executor, billing, events = environment
    billing.lost_settlement_reply = True
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "unknown"
    assert billing.balance == 97 and billing.settlements == 1
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "unknown"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute", "settle"]
    assert billing.balance == 97 and billing.settlements == 1


@pytest.mark.asyncio
async def test_execution_transport_failure_marks_billing_unknown(environment):
    service, executor, billing, events = environment
    executor.failure = OSError("test transport failure")
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "unknown"
    assert events[-1] == ("uncertain", CHARGE_ID, "provider_outcome_unknown")
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "unknown"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute", "uncertain"]


@pytest.mark.asyncio
async def test_free_qwen_does_not_enter_billing_path(environment):
    service, executor, billing, events = environment
    executor.result.pop("billing_usage")
    await service.submit(OWNER, TOKEN, SID, request(model="qwen"))
    result = await finish(service, executor)
    assert result["status"] == "completed"
    assert events == [("execute", RID)]
    assert billing.balance == 100 and billing.settlements == 0


@pytest.mark.asyncio
async def test_same_request_id_has_a_distinct_charge_for_each_owner(environment):
    service, executor, billing, events = environment
    second_owner = owner_key("2")
    service.store.create_session(second_owner, NewSession(request_id=SID))
    await service.submit(OWNER, TOKEN, SID, request())
    assert (await finish(service, executor))["status"] == "completed"

    await service.submit(second_owner, "second-account-token", SID, request())
    await asyncio.wait_for(service.tasks[(second_owner, RID)], 3)
    assert service.store.run(second_owner, RID)["status"] == "completed"
    first_charge, second_charge = charge_id(OWNER, RID), charge_id(second_owner, RID)
    assert first_charge != second_charge
    assert [event[1] for event in events if event[0] == "reserve"] == [first_charge, second_charge]
    assert [event[1] for event in events if event[0] == "settle"] == [first_charge, second_charge]
    assert [event[1] for event in events if event[0] == "execute"] == [RID, RID]
    assert billing.balance == 94 and billing.settlements == 2
