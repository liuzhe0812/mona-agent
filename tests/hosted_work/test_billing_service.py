"""Exercise Work's billing boundary without a wallet service or model process."""

import asyncio
import copy
import itertools
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.billing import BillingError, charge_id
from mona.hosted_work.context import history_fingerprint
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError, owner_key
from mona.hosted_work.desktop_store import DesktopStore
from mona.hosted_work.desktop_wire import DesktopWire
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
        self.payloads = []
        self.result = {"status": "completed", "content": "done", "workspace_saved": True,
                       "artifacts": [], "billing_usage": copy.deepcopy(RECEIPT),
                       "usage": {"prompt_tokens": 999, "completion_tokens": 999}}

    async def execute(self, payload, _emit):
        self.events.append(("execute", payload["run_id"]))
        self.payloads.append(copy.deepcopy(payload))
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

    retry = asyncio.create_task(service.submit(OWNER, TOKEN, SID, request()))
    await asyncio.sleep(0)
    assert not retry.done()
    assert [event[0] for event in events] == ["reserve"]
    assert not executor.entered.is_set()

    billing.reserve_release.set()
    accepted = await asyncio.wait_for(first, 3)
    assert accepted["id"] == RID
    assert (await asyncio.wait_for(retry, 3))["id"] == RID
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
    assert service.store.history(OWNER, SID) == []
    assert service.active_users == service.active_engines == set()
    with pytest.raises(BillingError) as retried:
        await service.submit(OWNER, TOKEN, SID, request())
    assert retried.value.code == "insufficient_balance"
    assert len(events) == 1


@pytest.mark.asyncio
async def test_concurrent_rejected_request_is_never_accepted_or_redispatched(environment):
    service, executor, billing, events = environment
    billing.reject_reserve = True
    billing.reserve_release.clear()
    first = asyncio.create_task(service.submit(OWNER, TOKEN, SID, request()))
    await asyncio.wait_for(billing.reserve_entered.wait(), 3)
    retry = asyncio.create_task(service.submit(OWNER, TOKEN, SID, request()))
    await asyncio.sleep(0)
    assert not retry.done()
    billing.reserve_release.set()
    for attempt in (first, retry):
        with pytest.raises(BillingError) as caught:
            await asyncio.wait_for(attempt, 3)
        assert caught.value.code == "insufficient_balance"
    assert [event[0] for event in events] == ["reserve"]
    assert not executor.entered.is_set()
    assert service.store.history(OWNER, SID) == []


def legacy_rejection(store, run_id, text="same prompt"):
    turn = NewTurn(request_id=run_id, model_id="codex", text=text)
    store.create_run(OWNER, SID, turn)
    store.billing_begin(OWNER, run_id, charge_id(OWNER, run_id))
    store.billing_update(OWNER, run_id, "rejected")
    store.finish(OWNER, run_id, "failed", {"message": "账号余额不足。", "workspace_saved": False,
                                         "diagnostic": {"stop_reason": "billing_rejected"}})


@pytest.mark.asyncio
async def test_legacy_rejected_turns_are_removed_from_model_input_but_not_transcript(environment, tmp_path, monkeypatch):
    service, executor, _billing, _events = environment
    store = service.store
    clock = itertools.count(1_700_000_000)
    monkeypatch.setattr("mona.hosted_work.store.time", SimpleNamespace(time=lambda: next(clock)))
    accepted = NewTurn(request_id="d" * 32, model_id="qwen", text="same prompt")
    store.create_run(OWNER, SID, accepted)
    previous = store.history(OWNER, SID) + [
        {"role": "assistant", "content": "previous answer"},
        {"role": "tool", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}]},
    ]
    store.save_history(OWNER, accepted.request_id, previous)
    store.finish(OWNER, accepted.request_id, "completed", {})
    legacy_rejection(store, "e" * 32)
    legacy_rejection(store, "f" * 32)
    before = store.history(OWNER, SID)
    context = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": SID,
               "last_consolidated": len(previous), "history_prefix_digest": history_fingerprint(previous),
               "metadata": {"task_plan": ["keep"], "_model_user_inputs": {"snapshot": previous[-1]["content"]}}}
    store.save_context(OWNER, SID, {"state": context, "source_history_length": len(before),
                                     "source_history_digest": history_fingerprint(before)})

    workspace = tmp_path / "user" / "workspace"
    workspace.mkdir(parents=True)
    desktop = DesktopStore(service, SimpleNamespace(root=lambda _owner: workspace))
    state = SimpleNamespace(records=desktop.records, get=lambda *_args: {}, sidebar=lambda *_args: {})
    wire = SimpleNamespace(on_run_finish=AsyncMock())
    service.desktop = SimpleNamespace(state=state, wire=wire)
    try:
        await service.submit(OWNER, TOKEN, SID, request(model="qwen", text="same prompt"))
        await finish(service, executor)
        assert [entry[0]["text"] for entry in desktop.records(OWNER, SID)] == [
            m["content"] for m in before if m["role"] in {"user", "assistant"} and isinstance(m["content"], str)
        ]
        assert store._restore_media(OWNER, executor.payloads[0]["history"][:-1]) == previous
        assert store.db.execute("SELECT count(*) FROM history_media WHERE owner=?", (OWNER,)).fetchone()[0] == 1
        assert executor.payloads[0]["history"][-1]["content"] == "same prompt"
        assert store.context_state(OWNER, SID) == context
    finally:
        service.desktop = None
        desktop.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["compacted", "uncertain_journal"])
async def test_legacy_cleanup_preserves_history_if_proof_or_summary_is_unsafe(environment, problem):
    service, executor, _billing, events = environment
    store = service.store
    legacy_rejection(store, "e" * 32)
    before = store.history(OWNER, SID)
    if problem == "compacted":
        context = {"format": "mona-hosted-context-v1", "owner": OWNER, "session_id": SID,
                   "last_consolidated": len(before), "history_prefix_digest": history_fingerprint(before),
                   "metadata": {"_last_summary": {"text": "retain"}}}
        store.db.execute("INSERT INTO conversation_context VALUES(?,?,?)", (OWNER, SID, json.dumps(context)))
    else:
        store.db.execute("UPDATE billing_journal SET stage='uncertain' WHERE owner=? AND run_id=?",
                         (OWNER, "e" * 32))
        with pytest.raises(WorkError) as retry:
            await service.submit(OWNER, TOKEN, SID, NewTurn(request_id="e" * 32, model_id="codex", text="same prompt"))
        assert retry.value.code == "billing_unknown"
    with pytest.raises(WorkError) as caught:
        await service.submit(OWNER, TOKEN, SID, request(model="qwen", text="same prompt"))
    assert caught.value.code == "history_conflict"
    assert store.history(OWNER, SID) == before
    assert not executor.entered.is_set() and events == []


@pytest.mark.asyncio
async def test_ambiguous_reserve_balance_error_remains_unknown_without_dispatch(environment, monkeypatch):
    service, executor, billing, events = environment

    async def ambiguous_reserve(run_id, token, model):
        events.append(("reserve", run_id, token, model.model))
        raise BillingError("insufficient_balance", "账号余额不足。", 402, rejected=False)

    monkeypatch.setattr(billing, "reserve", ambiguous_reserve)
    with pytest.raises(WorkError) as caught:
        await service.submit(OWNER, TOKEN, SID, request())

    assert caught.value.code == "billing_unknown" and caught.value.status == 503
    run = service.store.run(OWNER, RID)
    assert run["status"] == "unknown" and run["result"]["diagnostic"]["stop_reason"] == "billing_unknown"
    assert service.store.billing_pending() == [{"owner": OWNER, "run_id": RID, "charge_id": CHARGE_ID,
                                                "stage": "reserving", "usage": None, "expected_units": None}]
    assert events == [("reserve", CHARGE_ID, TOKEN, "test-codex")]
    assert not executor.entered.is_set() and (OWNER, RID) not in service.tasks
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "unknown"
    assert events == [("reserve", CHARGE_ID, TOKEN, "test-codex")]


@pytest.mark.asyncio
async def test_unconfirmed_reservation_without_dispatch_releases_other_users_capacity(environment, monkeypatch):
    service, executor, billing, _events = environment
    store = service.store
    service.config.max_concurrent_runs = 1
    other, other_sid = owner_key("2"), "c" * 32
    store.create_session(other, NewSession(request_id=other_sid))
    async def uncertain_reserve(*_args):
        raise BillingError("billing_unknown", "待核对", 503)
    monkeypatch.setattr(billing, "reserve", uncertain_reserve)
    with pytest.raises(WorkError):
        await service.submit(OWNER, TOKEN, SID, request())
    assert not executor.entered.is_set()
    assert store.run(OWNER, RID)["status"] == "unknown"
    assert store.billing_pending() and store.unknown_count() == 0 and not store.unknown_models()
    assert not store.record_execution_ended(other, RID, "completed")
    with pytest.raises(WorkError) as same_owner:
        await service.submit(OWNER, TOKEN, SID, NewTurn(request_id="d" * 32, model_id="qwen", text="another"))
    assert same_owner.value.code == "work_result_unknown"
    engine = service._acquire(other, "codex")
    service._release(other, engine)
    other_run = NewTurn(request_id="e" * 32, model_id="qwen", text="other")
    store.create_run(other, other_sid, other_run)
    assert store.run(other, other_run.request_id)["status"] == "running"
    # A changed checkpoint invalidates the evidence; it is bound to the exact run.
    store.db.execute("UPDATE runs SET checkpoint=? WHERE owner=? AND id=?", ('{"changed":true}', OWNER, RID))
    assert store.unknown_count() == 1 and store.unknown_models() == {"codex"}
    # The proof must not prevent the existing cascading run deletion.
    store.db.execute("DELETE FROM billing_journal WHERE owner=? AND run_id=?", (OWNER, RID))
    store.db.execute("DELETE FROM runs WHERE owner=? AND id=?", (OWNER, RID))
    assert store.db.execute("SELECT 1 FROM execution_ended WHERE owner=? AND run_id=?", (OWNER, RID)).fetchone() is None


@pytest.mark.asyncio
async def test_completed_result_with_pending_billing_retains_existing_checkpoint(environment):
    service, executor, _billing, _events = environment
    executor.result.update(billing_usage=None, diagnostic={"stop_reason": "completed"})
    await service.submit(OWNER, TOKEN, SID, request())
    checkpoint = {"phase": "tools_started", "pending_tool_calls": [{"id": "call"}]}
    service.store.save_checkpoint(OWNER, RID, checkpoint)
    await finish(service, executor)
    await asyncio.sleep(0)
    assert service.store.run(OWNER, RID)["status"] == "completed"
    assert json.loads(service.store.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]) == checkpoint
    assert service.store.billing_pending()[0]["stage"] == "uncertain"
    assert not service.store.record_execution_ended(OWNER, RID, "completed")


@pytest.mark.asyncio
async def test_unconfirmed_execution_never_releases_other_users_capacity(environment):
    service, executor, _billing, _events = environment
    service.config.max_concurrent_runs = 1
    executor.failure = OSError("unknown process outcome")
    await service.submit(OWNER, TOKEN, SID, request())
    await finish(service, executor)
    await asyncio.sleep(0)
    assert service.store.unknown_count() == 1
    assert not service.store.record_execution_ended(OWNER, RID, "completed")
    with pytest.raises(WorkError) as blocked:
        service._acquire(owner_key("2"), "qwen")
    assert blocked.value.code == "capacity"


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt", [
    None,
    {"complete": False, "prompt_tokens": 2, "cached_tokens": 1, "completion_tokens": 1},
    {"complete": True, "prompt_tokens": 2, "cached_tokens": 3, "completion_tokens": 1},
    {"complete": True, "prompt_tokens": True, "cached_tokens": 0, "completion_tokens": 1},
])
async def test_unconfirmed_usage_keeps_completed_answer_and_is_never_estimated(environment, receipt):
    service, executor, billing, events = environment
    executor.result["billing_usage"] = receipt
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "completed" and result["result"]["content"] == "done"
    journal = service.store.billing_pending()[0]
    assert journal["stage"] == "uncertain" and journal["usage"] is None and journal["expected_units"] is None
    assert "settle" not in [event[0] for event in events]
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["result"]["content"] == "done"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute"]
    await asyncio.sleep(0)
    await service._recover_billing_once()
    assert events[-1] == ("uncertain", CHARGE_ID, "provider_outcome_unknown")
    assert len(executor.payloads) == 1 and billing.settlements == 0


@pytest.mark.asyncio
async def test_confirmed_cancel_keeps_billing_pending_but_does_not_block_new_work(environment):
    service, executor, billing, events = environment
    executor.result.update(status="cancelled", content="", billing_usage=None,
                           diagnostic={"stop_reason": "cancelled"})
    await service.submit(OWNER, TOKEN, SID, request())
    service.store.save_checkpoint(OWNER, RID, {"phase": "tools_completed", "pending_tool_calls": [],
                                               "completed_tool_results": []})
    stopped = await finish(service, executor)
    assert stopped["status"] == "cancelled"
    assert stopped["result"]["diagnostic"]["stop_reason"] == "cancelled"
    assert stopped["result"]["diagnostic"]["billing_status"] == "pending"
    assert service.store.billing_pending()[0]["stage"] == "uncertain"
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "cancelled"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute"]
    service.store.require_idle(OWNER)
    await service.submit(OWNER, TOKEN, SID, NewTurn(request_id="c" * 32, model_id="qwen", text="new request"))
    await service.tasks[(OWNER, "c" * 32)]
    assert service.store.billing_pending()[0]["stage"] == "uncertain"


@pytest.mark.asyncio
async def test_cancel_does_not_wait_for_settlement_and_recovers_confirmed_usage_in_background(environment):
    service, executor, billing, _events = environment
    executor.result.update(status="cancelled", content="", diagnostic={"stop_reason": "cancelled"})
    billing.settle = AsyncMock(return_value={"status": "settled", "actual_units": 3})
    await service.submit(OWNER, TOKEN, SID, request())
    await asyncio.wait_for(executor.entered.wait(), 3)
    task = service.tasks[(OWNER, RID)]
    await service.stop(OWNER, RID)
    await asyncio.wait_for(task, 3)
    assert service.store.run(OWNER, RID)["status"] == "cancelled"
    billing.settle.assert_not_awaited()
    pending = service.store.billing_pending()[0]
    assert pending["stage"] == "uncertain" and pending["usage"] == SETTLEMENT_USAGE
    await asyncio.sleep(0)
    await service._recover_billing_once()
    billing.settle.assert_awaited_once_with(CHARGE_ID, SETTLEMENT_USAGE)
    assert service.store.billing_pending() == [] and len(executor.payloads) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("checkpoint", [
    {},
    {"phase": "native_execution", "native_work": {"status": "unknown"}},
    {"phase": "tools_started", "pending_tool_calls": [{"id": "write-1"}],
     "started_tool_call_ids": ["write-1"], "completed_tool_results": []},
    {"phase": "tools_completed", "pending_tool_calls": [],
     "completed_tool_results": [{"content": "Error: TOOL_OUTCOME_UNKNOWN"}]},
    {"phase": "tools_completed", "pending_tool_calls": [],
     "completed_tool_results": [{"content": '{"status":"unknown"}'}]},
])
async def test_cancel_retains_tool_evidence_without_replaying_the_original_request(environment, checkpoint):
    service, executor, billing, _events = environment
    executor.result.update(status="cancelled", content="", billing_usage=None,
                           diagnostic={"stop_reason": "cancelled"})
    await service.submit(OWNER, TOKEN, SID, request())
    service.store.save_checkpoint(OWNER, RID, checkpoint)
    stopped = await finish(service, executor)
    assert stopped["status"] == "cancelled"
    stored_checkpoint = service.store.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]
    assert json.loads(stored_checkpoint) == checkpoint
    assert service.store.billing_pending()[0]["stage"] == "uncertain"
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "cancelled"
    assert [payload["run_id"] for payload in executor.payloads] == [RID]
    if checkpoint.get("pending_tool_calls"):
        assert any("TOOL_OUTCOME_UNKNOWN" in str(message.get("content"))
                   for message in service.store.history(OWNER, SID))
    service.store.require_idle(OWNER)
    new_id = "c" * 32
    await service.submit(OWNER, TOKEN, SID, NewTurn(request_id=new_id, model_id="qwen", text="check current results"))
    await service.tasks[(OWNER, new_id)]
    assert [payload["run_id"] for payload in executor.payloads] == [RID, new_id]


@pytest.mark.asyncio
async def test_normal_output_containing_unknown_is_not_treated_as_an_unknown_receipt(environment):
    service, executor, _billing, _events = environment
    executor.result.update(status="cancelled", content="", billing_usage=None,
                           diagnostic={"stop_reason": "cancelled"})
    await service.submit(OWNER, TOKEN, SID, request())
    service.store.save_checkpoint(OWNER, RID, {"phase": "tools_completed", "pending_tool_calls": [],
        "completed_tool_results": [{"content": "The answer includes the word unknown."}]})
    assert (await finish(service, executor))["status"] == "cancelled"


@pytest.mark.asyncio
@pytest.mark.parametrize("status,saved,reason", [
    ("cancelled", False, "cancelled"),
    ("unknown", True, "execution_unknown"),
    ("failed", True, "cancelled"),
])
async def test_billing_preserves_executor_outcome_and_workspace_evidence(environment, status, saved, reason):
    service, executor, billing, _events = environment
    executor.result.update(status=status, content="", workspace_saved=saved, billing_usage=None,
                           diagnostic={"stop_reason": reason})
    await service.submit(OWNER, TOKEN, SID, request())
    service.store.save_checkpoint(OWNER, RID, {"phase": "tools_completed", "pending_tool_calls": [],
                                               "completed_tool_results": []})
    stopped = await finish(service, executor)
    assert stopped["status"] == status
    assert stopped["result"]["workspace_saved"] is saved
    assert stopped["result"]["diagnostic"]["stop_reason"] == reason
    assert service.store.billing_pending()[0]["stage"] == "uncertain"
    assert billing.settlements == 0


@pytest.mark.asyncio
async def test_cancel_ends_only_matching_editor_wait_without_claiming_its_result(environment):
    service, executor, billing, _events = environment
    executor.result.update(status="cancelled", content="", billing_usage=None,
                           diagnostic={"stop_reason": "cancelled"})
    state = SimpleNamespace(get=lambda *_args: {}, sidebar=lambda *_args: {})
    current = asyncio.get_running_loop().create_future()
    other_chat = asyncio.get_running_loop().create_future()
    other_owner = asyncio.get_running_loop().create_future()
    wire = SimpleNamespace(_platform={(OWNER, SID, "editor-request"): current,
                                      (OWNER, "c" * 32, "other-chat"): other_chat,
                                      (owner_key("2"), SID, "other-owner"): other_owner},
                           on_run_finish=AsyncMock())
    wire.cancel_platform_requests = lambda owner, sid: DesktopWire.cancel_platform_requests(wire, owner, sid)
    service.desktop = SimpleNamespace(state=state, _wire=wire, wire=wire)
    try:
        await service.submit(OWNER, TOKEN, SID, request())
        service.store.save_checkpoint(OWNER, RID, {"phase": "tools_completed", "pending_tool_calls": [],
                                                   "completed_tool_results": []})
        await asyncio.wait_for(executor.entered.wait(), 3)
        task = service.tasks[(OWNER, RID)]
        await service.stop(OWNER, RID)
        assert current.cancelled()
        assert not other_chat.done() and not other_owner.done()
        await asyncio.wait_for(task, 3)
        assert service.store.run(OWNER, RID)["status"] == "cancelled"
        assert service.store.billing_pending()[0]["stage"] == "uncertain"
        assert billing.settlements == 0
    finally:
        other_chat.cancel()
        other_owner.cancel()
        service.desktop = None


@pytest.mark.asyncio
async def test_lost_settlement_reply_preserves_answer_and_never_redispatches(environment):
    service, executor, billing, events = environment
    billing.lost_settlement_reply = True
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "completed" and result["result"]["content"] == "done"
    journal = service.store.billing_pending()[0]
    assert journal["stage"] == "uncertain" and journal["usage"] == SETTLEMENT_USAGE
    assert billing.balance == 97 and billing.settlements == 1
    retry = await service.submit(OWNER, TOKEN, SID, request())
    assert retry["status"] == "completed" and retry["result"]["content"] == "done"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute", "settle"]
    assert billing.balance == 97 and billing.settlements == 1


@pytest.mark.asyncio
async def test_failed_model_with_missing_usage_keeps_failure_reason_and_never_redispatches(environment):
    service, executor, billing, events = environment
    message = "模型响应失败，请稍后重试。"
    executor.result.update(status="failed", content="", message=message, billing_usage=None,
                           diagnostic={"stop_reason": "native_response_error", "provider_status": 503})
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "failed" and result["result"]["message"] == message
    assert result["result"]["diagnostic"]["stop_reason"] == "native_response_error"
    assert result["result"]["diagnostic"]["provider_status"] == 503
    assert service.store.billing_pending()[0]["stage"] == "uncertain"
    assert billing.balance == 100 and billing.settlements == 0
    retry = await service.submit(OWNER, TOKEN, SID, request())
    assert retry["status"] == "failed" and retry["result"]["message"] == message
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [
    OSError("test transport failure"),
    WorkError("execution_cleanup_unknown", "清理状态无法确认。", 503),
])
async def test_unconfirmed_transport_or_cleanup_remains_unknown(environment, failure):
    service, executor, billing, events = environment
    executor.failure = failure
    await service.submit(OWNER, TOKEN, SID, request())
    result = await finish(service, executor)
    assert result["status"] == "unknown"
    assert result["result"]["diagnostic"]["stop_reason"] == "execution_unknown"
    journal = service.store.billing_pending()[0]
    assert journal["stage"] == "uncertain" and journal["usage"] is None
    assert billing.balance == 100 and billing.settlements == 0
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "unknown"
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute"]
    await asyncio.sleep(0)
    await service._recover_billing_once()
    assert events[-1] == ("uncertain", CHARGE_ID, "provider_outcome_unknown")
    assert len(executor.payloads) == 1 and billing.settlements == 0


@pytest.mark.asyncio
async def test_retried_stop_of_unknown_turn_preserves_billing_and_checkpoint_without_redispatch(environment):
    service, executor, billing, events = environment
    executor.failure = OSError("test transport failure")
    await service.submit(OWNER, TOKEN, SID, request())
    checkpoint = {"phase": "tools_started", "pending_tool_calls": [{"id": "write-1"}],
                  "started_tool_call_ids": ["write-1"], "completed_tool_results": []}
    service.store.save_checkpoint(OWNER, RID, checkpoint)
    assert (await finish(service, executor))["status"] == "unknown"
    journal = service.store.billing_pending()[0]
    history = copy.deepcopy(service.store.history(OWNER, SID))
    assert journal["stage"] == "uncertain" and journal["usage"] is None
    executor.finish_stop = AsyncMock(side_effect=[
        WorkError("execution_cleanup_unknown", "无法确认进程已停止。", 503), None,
    ])
    with pytest.raises(WorkError) as error:
        await service.stop(OWNER, RID)
    assert error.value.code == "execution_cleanup_unknown"
    assert service.store.run(OWNER, RID)["status"] == "unknown"
    stopped = await service.stop(OWNER, RID)
    assert stopped["status"] == "cancelled"
    assert stopped["result"]["diagnostic"]["previous_stop_reason"] == "execution_unknown"
    assert service.store.billing_pending()[0] == journal
    stored = service.store.db.execute("SELECT checkpoint FROM runs WHERE owner=? AND id=?", (OWNER, RID)).fetchone()[0]
    assert json.loads(stored) == checkpoint
    assert service.store.history(OWNER, SID) == history
    assert any("TOOL_OUTCOME_UNKNOWN" in str(message.get("content"))
               for message in service.store.history(OWNER, SID))
    assert (await service.submit(OWNER, TOKEN, SID, request()))["status"] == "cancelled"
    assert executor.finish_stop.await_count == 2
    executor.finish_stop.assert_awaited_with(OWNER, RID)
    assert [event[0] for event in events] == ["reserve", "dispatch", "execute"]
    assert len(executor.payloads) == 1 and billing.settlements == 0


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
