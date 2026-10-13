"""Real local cleanup boundary; cloud control I/O only is substituted."""
import copy
import json
import time

import pytest
from test_cloud_coordinator import desktops as desktops
from test_cloud_coordinator import initial_pair
from test_cloud_local_api import local_api as local_api

from mona.cloud.transfer import CloudTransferError


@pytest.fixture
def prepared(desktops):
    server, create = desktops
    coordinator, boundary = create("cleanup-client")
    server.space = {"vault_id": "a" * 32, "key_check": "opaque", "quota_bytes": 10_000_000_000,
        "used_bytes": 128, "reserved_bytes": 0, "object_count": 2}
    calls = []
    plan = {"receipt": "SERVER-ONLY-PRIVATE-OBJECT-SELECTION", "expires_at": int(time.time()) + 600,
        "count": 2, "bytes": 128, "has_more": False, "minimum_age_seconds": 86400}
    result = {"complete": True, "removed": 2, "already_removed": 0, "retained": 0,
        "failed": 0, "pending": 0, "released_bytes": 128}
    original = server.control
    def control(method, path, body=None):
        if path != "/cleanup":
            return original(method, path, body)
        calls.append((method, copy.deepcopy(body)))
        return copy.deepcopy(plan if method == "GET" else result)
    server.control = control
    return coordinator, boundary, calls, plan, result


@pytest.mark.asyncio
async def test_preview_hides_receipt_and_cancel_is_read_only(prepared):
    coordinator, boundary, calls, plan, _ = prepared
    preview = await coordinator.cleanup_preview()
    assert len(preview["draft_id"]) == 32 and preview["bytes"] == 128
    assert plan["receipt"] not in json.dumps(preview) and boundary.binding not in json.dumps(preview)
    assert calls == [("GET", None)]
    with pytest.raises(CloudTransferError):
        await coordinator.cleanup_uploads(preview["draft_id"], False)
    assert len(calls) == 1 and coordinator.preferences.read().enabled is False


@pytest.mark.asyncio
async def test_confirm_is_exact_and_repeating_completed_action_never_deletes_again(prepared):
    coordinator, _, calls, plan, _ = prepared
    coordinator.cancelled.set()  # Paused automatic sync does not forbid explicit cleanup.
    preview = await coordinator.cleanup_preview()
    result = await coordinator.cleanup_uploads(preview["draft_id"], True)
    assert result["complete"] and result["released_bytes"] == 128
    assert calls[-1] == ("POST", {"receipt": plan["receipt"], "confirmed": True})
    assert await coordinator.cleanup_uploads(preview["draft_id"], True) == result
    assert len(calls) == 2 and coordinator.preferences.read().enabled is False


@pytest.mark.asyncio
async def test_account_switch_invalidates_prior_confirmation(prepared):
    coordinator, boundary, calls, _, _ = prepared
    preview = await coordinator.cleanup_preview()
    boundary.binding = "b" * 64
    with pytest.raises(CloudTransferError) as error:
        await coordinator.cleanup_uploads(preview["draft_id"], True)
    assert error.value.code == "account_changed" and len(calls) == 1


@pytest.mark.asyncio
async def test_expired_or_superseded_local_preview_is_not_submitted(prepared):
    coordinator, _, calls, _, _ = prepared
    previous = await coordinator.cleanup_preview()
    latest = await coordinator.cleanup_preview()
    for draft in (previous["draft_id"], "b" * 32):
        with pytest.raises(CloudTransferError):
            await coordinator.cleanup_uploads(draft, True)
    coordinator.cleanup_draft["expires"] = time.monotonic() - 1
    with pytest.raises(CloudTransferError):
        await coordinator.cleanup_uploads(latest["draft_id"], True)
    assert all(method == "GET" for method, _ in calls)


@pytest.mark.asyncio
async def test_partial_result_keeps_same_receipt_for_explicit_retry(prepared):
    coordinator, _, calls, plan, result = prepared
    result.update(complete=False, removed=1, failed=1, released_bytes=64)
    preview = await coordinator.cleanup_preview()
    assert not (await coordinator.cleanup_uploads(preview["draft_id"], True))["complete"]
    result.update(complete=True, removed=1, failed=0, already_removed=1, released_bytes=64)
    assert (await coordinator.cleanup_uploads(preview["draft_id"], True))["complete"]
    assert [body for method, body in calls if method == "POST"] == [{"receipt": plan["receipt"], "confirmed": True}] * 2


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"count": True}, {"count": 11}, {"bytes": -1},
    {"count": 0, "bytes": 5}, {"expires_at": 0}, {"receipt": None}, {"has_more": True}])
async def test_invalid_preview_is_not_used(prepared, changes):
    coordinator, _, calls, plan, _ = prepared
    plan.update(changes)
    with pytest.raises(CloudTransferError):
        await coordinator.cleanup_preview()
    assert coordinator.cleanup_draft is None and calls == [("GET", None)]


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [{"complete": True, "failed": 1}, {"removed": 5},
    {"released_bytes": 129}, {"pending": -1}, {"removed": 0, "already_removed": 2}])
async def test_invalid_result_is_never_cached_as_success(prepared, changes):
    coordinator, _, _, _, result = prepared
    preview = await coordinator.cleanup_preview()
    result.update(changes)
    with pytest.raises(CloudTransferError):
        await coordinator.cleanup_uploads(preview["draft_id"], True)
    assert coordinator.cleanup_draft["result"] is None


@pytest.mark.asyncio
async def test_cleanup_never_changes_work_history_selection_or_local_files(desktops):
    server, _, coordinator, _, _, _, key = await initial_pair(desktops)
    before = coordinator.manager.read_session_file(key)
    config = coordinator.preferences.path.read_bytes()
    versions = copy.deepcopy(server.versions)
    original = server.control
    def control(method, path, payload=None):
        if path == "/cleanup":
            return {"receipt": None, "expires_at": int(time.time()) + 600,
                "count": 0, "bytes": 0, "has_more": False, "minimum_age_seconds": 86400}
        return original(method, path, payload)
    server.control = control
    preview = await coordinator.cleanup_preview()
    assert preview["count"] == 0 and preview["draft_id"] is None
    assert coordinator.manager.read_session_file(key) == before
    assert coordinator.preferences.path.read_bytes() == config and server.versions == versions


@pytest.mark.asyncio
async def test_local_cleanup_requires_local_token_and_cannot_accept_cloud_receipt(local_api):
    client, coordinator, boundary, headers = local_api
    for path in ("cleanup-preview", "cleanup"):
        assert (await client.post("/api/cloud-sync/" + path, json={})).status == 401
    response = await client.post("/api/cloud-sync/cleanup", headers=headers,
        json={"receipt": "do-not-accept-server-receipt", "confirmed": True})
    assert response.status == 400
    response = await client.post("/api/cloud-sync/cleanup", headers=headers,
        json={"draft_id": "a" * 32, "confirmed": False})
    assert response.status == 409 and boundary.calls == []
    assert coordinator.cleanup_draft is None
