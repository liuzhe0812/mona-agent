"""Local recycle boundaries, including account isolation and durable Work deletion markers."""
import copy
import time

import pytest
from test_cloud_coordinator import desktops as desktop_fixture
from test_cloud_local_api import local_api as api_fixture

from mona.cloud.crypto import VaultCipher
from mona.cloud.transfer import CloudTransferError

desktops = desktop_fixture
local_api = api_fixture

RID = "d" * 32


@pytest.mark.asyncio
async def test_local_recycle_routes_reject_untrusted_requests_before_account_access(local_api):
    client, owner, native, headers = local_api
    for route in ("trash", "trash-preview", "trash-apply"):
        denied = await client.post(f"/api/cloud-sync/{route}", json={})
        assert denied.status == 401
    for route, payload in (("trash", {"before": 0}),
                           ("trash", {"user_id": "other"}),
                           ("trash-preview", {"resource_id": "development:one", "version": 1, "action": "trash"}),
                           ("trash-apply", {"receipt": "server-receipt", "confirmed": True})):
        denied = await client.post(f"/api/cloud-sync/{route}", json=payload, headers=headers)
        assert denied.status == 400
    assert native.calls == [] and owner.recycle.draft is None


def response(action="trash", version=1):
    return {"resource_id": RID, "version": version, "action": action, "kind": "work_conversation",
            "receipt": "private-server-confirmation", "expires_at": int(time.time()) + 600}


@pytest.mark.asyncio
async def test_preview_never_sends_a_write_and_apply_keeps_one_receipt(desktops):
    _, create = desktops
    owner, native = create("one")
    native.server.space = {"vault_id": "e" * 32}
    calls = []
    def control(method, path, body=None):
        calls.append((method, path, body))
        if path == "/trash/preview":
            return response()
        return {"complete": True, "action": "trash", "resource_id": RID, "kind": "work_conversation",
            "version": 2, "reused": False, "released_bytes": 0,
            "head": {"resource_id": RID, "kind": "work_conversation", "version": 2, "deleted": True, "manifest_id": None, "object_ids": []}}
    native.server.control = control
    plan = await owner.recycle.preview(RID, 1, "trash")
    assert "receipt" not in plan and len(calls) == 1
    with pytest.raises(CloudTransferError):
        await owner.recycle.apply(plan["draft_id"], False)
    first = await owner.recycle.apply(plan["draft_id"], True)
    again = await owner.recycle.apply(plan["draft_id"], True)
    assert first == again and len(calls) == 2
    assert "head" not in first
    assert owner.recycle.deleted_version("e" * 32, RID) == 2
    owner.recycle.forget("e" * 32, RID, 1)
    assert owner.recycle.deleted_version("e" * 32, RID) == 2
    owner.recycle.forget("e" * 32, RID, 3)
    assert owner.recycle.deleted_version("e" * 32, RID) == 0


@pytest.mark.asyncio
async def test_unknown_write_is_retried_only_by_explicit_caller_with_same_confirmation(desktops):
    _, create = desktops
    owner, native = create("one")
    native.server.space = {"vault_id": "e" * 32}
    calls = []
    def control(method, path, body=None):
        calls.append((path, copy.deepcopy(body)))
        if path == "/trash/preview":
            return response()
        raise CloudTransferError("transport", "结果未知")
    native.server.control = control
    plan = await owner.recycle.preview(RID, 1, "trash")
    for _ in range(2):
        with pytest.raises(CloudTransferError):
            await owner.recycle.apply(plan["draft_id"], True)
    assert len(calls) == 3 and calls[1] == calls[2]


@pytest.mark.asyncio
async def test_account_change_invalidates_draft_before_any_mutation(desktops):
    _, create = desktops
    owner, native = create("one")
    native.server.space = {"vault_id": "e" * 32}
    calls = []
    def control(method, path, body=None):
        calls.append(path)
        return response()
    native.server.control = control
    plan = await owner.recycle.preview(RID, 1, "trash")
    native.binding = "f" * 64
    with pytest.raises(CloudTransferError):
        await owner.recycle.apply(plan["draft_id"], True)
    assert calls == ["/trash/preview"]


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{}, {"items": [], "has_more": True, "next_before": 1},
    {"items": [{"kind": "development"}], "has_more": False, "next_before": 1}])
async def test_invalid_trash_lists_never_become_an_empty_success(desktops, payload):
    _, create = desktops
    owner, native = create("one")
    native.server.space = {"vault_id": "e" * 32}
    native.server.control = lambda *_: payload
    with pytest.raises(CloudTransferError):
        await owner.recycle.list()


@pytest.mark.asyncio
@pytest.mark.parametrize("code", ["cloud_download_expired", "download_unavailable"])
async def test_trash_remains_manageable_when_only_content_download_has_expired(desktops, code):
    _, create = desktops
    owner, native = create("expired")
    cipher = VaultCipher.generate()
    native.recovery = cipher.recovery_text()
    native.plan = "free"
    native.server.space = {"vault_id": cipher.vault_id, "key_check": cipher.key_check()}
    manifest = "b" * 64
    content = {"resource_id": RID, "kind": "work_conversation", "version": 1,
               "manifest_id": manifest, "object_ids": [manifest], "deleted": False}

    def control(method, path, body=None):
        if path.startswith("/trash"):
            return {"items": [{"resource_id": RID, "kind": "work_conversation", "version": 2,
                               "sequence": 2, "deleted_at": "2026-10-13T00:00:00Z", "content": content}],
                    "has_more": False, "next_before": 2}
        if path.endswith("/download"):
            raise CloudTransferError(code, "Content cannot be downloaded")
        raise AssertionError(path)

    native.server.control = control
    if code == "cloud_download_expired":
        page = await owner.recycle.list()
        assert page["items"][0]["title"] == "工作会话（下载期已结束）"
        assert page["items"][0]["recoverable"] is True
    else:
        with pytest.raises(CloudTransferError) as error:
            await owner.recycle.list()
        assert error.value.code == code
