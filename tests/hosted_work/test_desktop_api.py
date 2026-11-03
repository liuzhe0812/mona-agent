"""Real account-scoped HTTP state with external model/container execution isolated."""
from __future__ import annotations

import hashlib
import os
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import NewSession, WorkError
from mona.hosted_work.desktop_api import PREFIX, DesktopAPI
from mona.hosted_work.store import WorkStore

A, B = "a" * 64, "b" * 64
SID_A, SID_B = "1" * 32, "2" * 32


class Auth:
    def __init__(self):
        self.accounts = {"account-A": A, "account-B": B}

    async def identity(self, token):
        if token not in self.accounts:
            raise WorkError("login_required", "登录已失效。", 401)
        return self.accounts[token]


@pytest.fixture
async def environment(tmp_path):
    config = HostedWorkConfig(enabled=True, state_dir=str(tmp_path), auth_origin="https://mona.example",
        public_origin="https://mona.example", models={
            "first": HostedWorkModel(label="First", model="server-only-first", api_key_env="MONA_WORK_MODEL_FIRST_KEY"),
            "second": HostedWorkModel(label="Second", model="server-only-second", api_key_env="MONA_WORK_MODEL_SECOND_KEY"),
        })
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    auth = Auth()
    store.create_session(A, NewSession(request_id=SID_A, title="A私有会话"))
    store.create_session(B, NewSession(request_id=SID_B, title="B私有会话"))
    uploads = []
    downloads = []
    sandbox_bytes = {}

    async def upload(owner, sid, fid, name, data):
        uploads.append((owner, sid, fid, name, data))
        sandbox_bytes[owner, sid, fid] = data
        return store.add_file(owner, sid, fid, {"path": f"uploads/{fid}/{name}", "name": name,
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    async def download(owner, sid, fid):
        info = store.file(owner, sid, fid)
        downloads.append((owner, sid, fid))
        return info["name"], sandbox_bytes[owner, sid, fid]

    service = SimpleNamespace(config=config, store=store, auth=auth, upload=upload, download=download,
                              executor=SimpleNamespace(cancel=lambda *_args: None))
    api = DesktopAPI(service)

    @web.middleware
    async def authenticate(request, handler):
        try:
            if request.headers.get("Origin") not in (None, config.public_origin):
                raise WorkError("origin_denied", "网页来源无权访问。", 403)
            if api.is_file_ticket(request):
                return await api.file_ticket(request)
            token = request.headers.get("Authorization", "").removeprefix("Bearer ")
            request["owner"] = await auth.identity(token)
            request["account_token"] = token
            return await handler(request)
        except WorkError as error:
            return web.json_response({"error": error.code}, status=error.status)

    app = web.Application(middlewares=[authenticate])
    app.router.add_route("*", PREFIX + "/{tail:.*}", api.handle)
    client = TestClient(TestServer(app))
    await client.start_server()
    yield SimpleNamespace(api=api, service=service, client=client, uploads=uploads, downloads=downloads,
                          sandbox_bytes=sandbox_bytes, auth=auth)
    await client.close()
    await api.close()
    store.close()


def headers(account="A"):
    return {"Authorization": "Bearer account-" + account}


async def test_settings_use_real_open_models_and_selection_is_per_account(environment):
    e = environment
    response = await e.client.get(PREFIX + "/api/settings", headers=headers())
    value = await response.json()
    assert [item["id"] for item in value["chat_providers"][0]["models"]] == ["first", "second"]
    assert all(item["enabled"] for item in value["chat_providers"][0]["models"])
    assert "server-only" not in await response.text()
    assert str(Path(e.service.config.state_dir)) not in await response.text()
    response = await e.client.put(PREFIX + "/api/development/work-model-source", headers=headers(),
        json={"executor": "mona", "provider": "mona_managed", "model": "second", "effort": None})
    assert response.status == 200
    assert (await response.json())["agent"]["model"] == "second"
    other = await e.client.get(PREFIX + "/api/settings", headers=headers("B"))
    assert (await other.json())["agent"]["model"] == "first"
    assert list(e.service.config.models) == ["first", "second"]
    denied = await e.client.put(PREFIX + "/api/development/work-model-source", headers=headers(),
        json={"executor": "mona", "model": "not-open", "api_key": "synthetic-not-accepted"})
    assert denied.status == 400


async def test_history_sidebar_and_files_reject_other_accounts(environment):
    e = environment
    e.api.state.append(A, SID_A, {"event": "user", "text": "A私密正文"}, "first-input")
    response = await e.client.get(PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread?limit=1", headers=headers())
    payload = await response.json()
    assert response.status == 200
    assert payload["messages"][0]["content"] == "A私密正文"
    denied = await e.client.get(PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread", headers=headers("B"))
    assert denied.status == 404
    response = await e.client.post(PREFIX + "/api/webui/sidebar-state/update", headers=headers(),
        json={"title_overrides": {"websocket:" + SID_A: "A标题"}})
    assert response.status == 200
    other = await e.client.get(PREFIX + "/api/webui/sidebar-state", headers=headers("B"))
    assert (await other.json())["title_overrides"] == {}
    root = e.api.files.root(A)
    (root / "private.html").write_text("<script>private</script>", encoding="utf-8")
    response = await e.client.get(PREFIX + "/api/file-preview", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "private.html", "scope": "shared"})
    assert response.status == 200
    assert response.content_type == "text/plain"
    assert await response.text() == "<script>private</script>"
    assert "sandbox" in response.headers["Content-Security-Policy"]
    denied = await e.client.get(PREFIX + "/api/file-preview", headers=headers("B"),
        params={"session_key": "websocket:" + SID_A, "path": "private.html"})
    assert denied.status == 404
    denied = await e.client.get(PREFIX + "/api/file-preview", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "/workspace/../private.html"})
    assert denied.status == 400
    assert e.api.files.root(A) != e.api.files.root(B)


async def test_bare_media_ticket_is_scoped_expiring_and_revocable(environment):
    e = environment
    path = e.api.files.root(A) / "image.png"
    path.write_bytes(b"local-test-image")
    ticket_url = e.api.media_url(A, "account-A", SID_A, "/workspace/image.png")
    assert "account-A" not in ticket_url
    route = urlsplit(ticket_url).path
    response = await e.client.get(route)
    assert response.status == 200 and await response.read() == b"local-test-image"
    denied = await e.client.get(route, headers=headers("B"))
    assert denied.status == 404
    path.write_bytes(b"changed-image")
    changed = await e.client.get(route)
    assert changed.status == 409
    ticket = route.rsplit("/", 1)[1]
    e.api._file_tickets[ticket] = replace(e.api._file_tickets[ticket], expires=0)
    expired = await e.client.get(route)
    assert expired.status == 401
    fresh = urlsplit(e.api.media_url(A, "account-A", SID_A, "/workspace/image.png")).path
    del e.auth.accounts["account-A"]
    revoked = await e.client.get(fresh)
    assert revoked.status == 401


async def test_attachments_are_verified_and_retries_do_not_copy_again(environment):
    e = environment
    folder = e.api.files.root(A) / "uploads" / ("3" * 32)
    folder.mkdir(parents=True)
    path = folder / "input.txt"
    data = b"private attachment"
    path.write_bytes(data)
    logical = "/workspace/uploads/" + "3" * 32 + "/input.txt"
    e.api.state.set(A, "upload:" + logical, {"path": logical, "name": "input.txt", "size": len(data),
                                           "sha256": hashlib.sha256(data).hexdigest(), "scope": "shared"})
    frame = {"input_id": "input-stable", "doc_paths": [logical]}
    first = await e.api.prepared_attachments(A, SID_A, frame)
    assert len(first) == 1 and len(e.uploads) == 1
    assert await e.api.prepared_attachments(A, SID_A, frame) == first
    assert len(e.uploads) == 1
    second = await e.api.prepared_attachments(A, SID_A, {**frame, "input_id": "different-input"})
    assert second != first and len(e.uploads) == 2
    with pytest.raises(WorkError) as denied:
        await e.api.prepared_attachments(B, SID_B, frame)
    assert denied.value.status == 404
    path.write_bytes(b"modified later")
    with pytest.raises(WorkError) as changed:
        await e.api.prepared_attachments(A, SID_A, frame)
    assert changed.value.status == 409


async def test_artifact_groups_follow_recorded_delivery_and_exact_task(environment):
    e = environment
    root = e.api.files.root(A)
    for name in ("delivered.txt", "working.txt", "other-task.txt", "unclassified.txt"):
        (root / name).write_text(name, encoding="utf-8")
    await e.service.upload(A, SID_A, "5" * 32, "attachment.txt", b"uploaded input")
    e.api.state.set(A, "artifact_index:" + SID_A, [
        {"path": "delivered.txt", "task_id": "current", "delivered": True},
        {"path": "working.txt", "task_id": "current", "delivered": False},
        {"path": "other-task.txt", "task_id": "other", "delivered": False},
        {"path": "gone.txt", "task_id": "current", "delivered": True},
    ])
    route = PREFIX + "/api/artifacts"
    response = await e.client.get(route, headers=headers(),
        params={"session_key": "websocket:" + SID_A, "task_id": "current"})
    assert response.status == 200
    value = await response.json()
    assert [row["name"] for row in value["session_files"]] == ["delivered.txt"]
    assert [row["name"] for row in value["task_files"]] == ["working.txt"]
    assert {row["name"] for row in value["files"]} == {
        "delivered.txt", "working.txt", "other-task.txt", "unclassified.txt", "attachment.txt"}
    for row in value["files"]:
        data = b"uploaded input" if row["name"] == "attachment.txt" else row["name"].encode()
        assert row["sha256"] == hashlib.sha256(data).hexdigest()
    no_task = await e.client.get(route, headers=headers(), params={"session_key": "websocket:" + SID_A})
    assert (await no_task.json())["task_files"] == []
    foreign = await e.client.get(route, headers=headers("B"), params={"session_key": "websocket:" + SID_A})
    assert foreign.status == 404


async def test_rename_updates_only_this_accounts_real_artifact_and_upload_paths(environment):
    e = environment
    another = "6" * 32
    e.service.store.create_session(A, NewSession(request_id=another, title="另一会话"))
    for owner in (A, B):
        (e.api.files.root(owner) / "old.txt").write_bytes(b"private result")
    (e.api.files.root(A) / "existing.txt").write_bytes(b"keep me")
    digest = hashlib.sha256(b"private result").hexdigest()
    file = {"path": "/workspace/old.txt", "absolute_path": "/workspace/old.txt", "name": "old.txt",
            "size": 14, "sha256": digest, "mime": "text/plain"}
    delivered = {"path": "old.txt", "name": "old.txt", "task_id": "delivery-task", "delivered": True, "file": file}
    working = {"path": "/workspace/old.txt", "task_id": "working-task", "delivered": False, "file": file}
    unrelated = {"path": "existing.txt", "task_id": "unrelated", "delivered": True}
    e.api.state.set(A, "artifact_index:" + SID_A, [delivered, unrelated])
    e.api.state.set(A, "artifact_index:" + another, [working])
    e.api.state.set(B, "artifact_index:" + SID_B, [delivered])
    uploaded = {"path": "/workspace/old.txt", "name": "old.txt", "sha256": digest, "size": 14, "scope": "shared"}
    e.api.state.set(A, "upload:/workspace/old.txt", uploaded)
    route = PREFIX + "/api/artifact-rename"
    query = {"session_key": "websocket:" + SID_A, "path": "old.txt", "new_name": "existing.txt"}
    denied = await e.client.get(route, headers=headers(), params=query)
    assert denied.status == 409
    assert e.api.state.get(A, "artifact_index:" + SID_A) == [delivered, unrelated]
    response = await e.client.get(route, headers=headers(), params={**query, "new_name": "renamed.txt"})
    assert response.status == 200 and await response.json() == {"path": "renamed.txt", "name": "renamed.txt"}
    renamed_file = {**file, "path": "/workspace/renamed.txt", "absolute_path": "/workspace/renamed.txt", "name": "renamed.txt"}
    assert e.api.state.get(A, "artifact_index:" + SID_A) == [
        {**delivered, "path": "renamed.txt", "name": "renamed.txt", "file": renamed_file}, unrelated]
    assert e.api.state.get(A, "artifact_index:" + another) == [{**working, "path": "renamed.txt", "file": renamed_file}]
    assert e.api.state.get(B, "artifact_index:" + SID_B) == [delivered]
    assert (e.api.files.root(B) / "old.txt").read_bytes() == b"private result"
    assert e.api.state.get(A, "upload:/workspace/old.txt") is None
    assert e.api.state.get(A, "upload:/workspace/renamed.txt") == {**uploaded, "path": "/workspace/renamed.txt", "name": "renamed.txt"}
    inventory = await e.client.get(PREFIX + "/api/artifacts", headers=headers(),
        params={"session_key": "websocket:" + another, "task_id": "working-task"})
    assert [row["name"] for row in (await inventory.json())["task_files"]] == ["renamed.txt"]


async def test_trash_compares_the_observed_inventory_digest_before_moving_real_bytes(environment):
    e = environment
    path = e.api.files.root(A) / "mutable.txt"
    path.write_bytes(b"seen version")
    inventory = await e.client.get(PREFIX + "/api/artifacts", headers=headers(), params={"session_key": "websocket:" + SID_A})
    observed = (await inventory.json())["files"][0]["sha256"]
    path.write_bytes(b"newer version")
    missing = await e.client.post(PREFIX + "/platform/invoke", headers=headers(),
        json={"command": "move_to_trash", "args": {"path": "/workspace/mutable.txt"}})
    assert missing.status == 409 and path.read_bytes() == b"newer version"
    command = {"command": "move_to_trash", "args": {"path": "/workspace/mutable.txt", "expectedSha256": observed}}
    denied = await e.client.post(PREFIX + "/platform/invoke", headers=headers(), json=command)
    assert denied.status == 409 and path.read_bytes() == b"newer version"
    command["args"]["expectedSha256"] = hashlib.sha256(b"newer version").hexdigest()
    moved = await e.client.post(PREFIX + "/platform/invoke", headers=headers(), json=command)
    assert moved.status == 200 and not path.exists()
    slots = list((e.api.files.root(A).parent / "trash").iterdir())
    assert len(slots) == 1 and (slots[0] / "file").read_bytes() == b"newer version"


async def test_legacy_files_use_executor_download_and_documents_rename_without_overwrite(environment):
    e = environment
    fid = "4" * 32
    data = b"legacy sandbox bytes"
    e.service.store.add_file(A, SID_A, fid, {"path": "legacy.txt", "name": "legacy.txt", "size": len(data),
                                          "sha256": hashlib.sha256(data).hexdigest()})
    e.sandbox_bytes[A, SID_A, fid] = data
    response = await e.client.get(PREFIX + "/api/file-preview", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "legacy.txt"})
    assert response.status == 200 and await response.read() == data
    assert e.downloads == [(A, SID_A, fid)]
    root = e.api.files.root(A)
    (root / "old.txt").write_bytes(b"rename me")
    response = await e.client.get(PREFIX + "/api/artifact-rename", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "old.txt", "new_name": "new.txt"})
    assert response.status == 200
    assert (root / "new.txt").read_bytes() == b"rename me" and not (root / "old.txt").exists()
    (root / "existing.txt").write_bytes(b"keep me")
    denied = await e.client.get(PREFIX + "/api/artifact-rename", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "new.txt", "new_name": "existing.txt"})
    assert denied.status == 409 and (root / "existing.txt").read_bytes() == b"keep me"
    os.link(root / "new.txt", root / "link.txt")
    denied = await e.client.get(PREFIX + "/api/file-preview", headers=headers(),
        params={"session_key": "websocket:" + SID_A, "path": "link.txt"})
    assert denied.status == 400


async def test_unsupported_modules_and_unconfigured_tool_bridge_do_not_claim_success(environment):
    e = environment
    with pytest.raises(WorkError, match="图片输入"):
        await e.api.prepared_attachments(A, SID_A, {"input_id": "test", "media": [{"url": "unavailable"}]})
    unsupported = await e.client.get(PREFIX + "/cloud/v1/space", headers=headers())
    assert unsupported.status == 501
    unknown = await e.client.post(PREFIX + "/platform/invoke", headers=headers(),
        json={"command": "read_system_credentials", "args": {}})
    assert unknown.status == 400
    unconfigured = await e.client.post(PREFIX + "/internal/tool", headers=headers(), json={})
    assert unconfigured.status == 501
    received = []

    async def platform(owner, command, args):
        received.append((owner, command, args))
        return {"accepted": True}

    async def tool(_request):
        return web.json_response({"result": {"ok": True}})

    e.api.platform_handler, e.api.tool_handler = platform, tool
    response = await e.client.post(PREFIX + "/platform/invoke", headers=headers(),
        json={"command": "canvas_agent_respond", "args": {"requestId": "valid"}})
    assert await response.json() == {"accepted": True}
    assert received == [(A, "canvas_agent_respond", {"requestId": "valid"})]
    response = await e.client.post(PREFIX + "/internal/tool", headers=headers(), json={})
    assert await response.json() == {"result": {"ok": True}}
