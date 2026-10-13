"""Local history confirmation uses the same account binding across each request."""
import asyncio
import copy
import time
from types import SimpleNamespace

import pytest
from test_cloud_coordinator import desktops as desktops
from test_cloud_local_api import local_api as local_api

from mona.cloud.history_retention import HistoryRetention
from mona.cloud.transfer import CloudTransferError


@pytest.fixture
def broker():
    context = {"binding": "a" * 64, "cloud_status": 200}
    replies = {"GET": {"count": 2, "retention_days": 30, "has_more": False,
        "expires_at": int(time.time()) + 600, "referenced_bytes": 64, "receipt": "synthetic-history-receipt"},
        "POST": {"complete": True, "retired": 2, "already_retired": 0, "retained": 0, "released_bytes": 0}}
    calls = []
    async def current():
        return copy.deepcopy(context)
    def control(method, path, payload=None):
        calls.append((method, path, payload))
        reply = replies[method]
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)
    owner = SimpleNamespace(lock=asyncio.Lock(), _context=current, _cloud_ready=lambda _: None,
                           transport_factory=lambda _: SimpleNamespace(control=control))
    return HistoryRetention(owner), context, replies, calls


@pytest.mark.asyncio
async def test_preview_hides_receipt_and_only_confirmed_request_is_mutated(broker):
    api, _, _, calls = broker
    draft = await api.preview()
    assert "receipt" not in draft and draft["count"] == 2
    assert [item[0] for item in calls] == ["GET"]
    with pytest.raises(CloudTransferError):
        await api.apply(draft["draft_id"], False)
    result = await api.apply(draft["draft_id"], True)
    assert result["retired"] == 2 and result["released_bytes"] == 0
    assert calls[-1][2] == {"receipt": "synthetic-history-receipt", "confirmed": True}
    count = len(calls)
    assert await api.apply(draft["draft_id"], True) == result and len(calls) == count


@pytest.mark.asyncio
async def test_local_routes_require_auth_and_use_validated_confirmation(local_api):
    client, coordinator, _, headers = local_api
    for route in ("retention-preview", "retention"):
        assert (await client.post(f"/api/cloud-sync/{route}", json={})).status == 401
    invalid = await client.post("/api/cloud-sync/retention", headers=headers,
                               json={"receipt": "forged", "confirmed": True})
    assert invalid.status == 400
    calls = []
    def control(method, path, payload=None):
        calls.append((method, path, payload))
        if method == "GET":
            return {"count": 1, "retention_days": 30, "has_more": False, "expires_at": int(time.time()) + 600,
                    "referenced_bytes": 64, "receipt": "synthetic-history-receipt"}
        return {"complete": True, "retired": 1, "already_retired": 0, "retained": 0, "released_bytes": 0}
    coordinator.transport_factory = lambda _: SimpleNamespace(control=control)
    response = await client.post("/api/cloud-sync/retention-preview", headers=headers, json={})
    assert response.status == 200
    draft = await response.json()
    result = await client.post("/api/cloud-sync/retention", headers=headers,
                              json={"draft_id": draft["draft_id"], "confirmed": True})
    assert result.status == 200 and (await result.json())["retired"] == 1
    assert [entry[0] for entry in calls] == ["GET", "POST"]


@pytest.mark.asyncio
async def test_account_change_invalidates_old_confirmation(broker):
    api, context, _, calls = broker
    draft = await api.preview()
    context["binding"] = "b" * 64
    with pytest.raises(CloudTransferError) as caught:
        await api.apply(draft["draft_id"], True)
    assert caught.value.code == "account_changed"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_unknown_outcome_retains_the_same_receipt_for_explicit_retry(broker):
    api, _, replies, calls = broker
    draft = await api.preview()
    replies["POST"] = CloudTransferError("network", "No confirmed result")
    with pytest.raises(CloudTransferError):
        await api.apply(draft["draft_id"], True)
    replies["POST"] = {"complete": True, "retired": 0, "already_retired": 2, "retained": 0, "released_bytes": 0}
    assert (await api.apply(draft["draft_id"], True))["already_retired"] == 2
    assert calls[-1][2] == calls[-2][2]


@pytest.mark.asyncio
async def test_invalid_success_is_never_cached_or_reported_as_space_released(broker):
    api, _, replies, _ = broker
    draft = await api.preview()
    replies["POST"]["released_bytes"] = 64
    with pytest.raises(CloudTransferError) as caught:
        await api.apply(draft["draft_id"], True)
    assert caught.value.code == "retention_unconfirmed" and api.draft["result"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("count", 51), ("retention_days", 0), ("has_more", True), ("expires_at", 1)])
async def test_malformed_preview_never_becomes_authority_to_clean(broker, field, value):
    api, _, replies, _ = broker
    replies["GET"][field] = value
    with pytest.raises(CloudTransferError):
        await api.preview()
    assert api.draft is None
