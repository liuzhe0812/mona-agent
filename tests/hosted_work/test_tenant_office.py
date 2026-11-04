"""The existing Office protocol stays inside an authenticated account and chat."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path

import pytest
from aiohttp import WSMsgType, WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.tenant_office import OFFICE_PREFIX, TenantOffice, register_tenant_office
from mona.office.schemas import OFFICE_OWNER_HEADER

ALICE = "a" * 64
BOB = "b" * 64
CHAT_A = "1" * 32
CHAT_A_OTHER = "2" * 32
CHAT_B = "3" * 32


async def make_client(tmp_path):
    tokens = {"alice": ALICE, "alice-new": ALICE, "bob": BOB}
    sessions = {ALICE: {CHAT_A, CHAT_A_OTHER}, BOB: {CHAT_B}}

    async def identity(token):
        if token not in tokens:
            raise WorkError("login_required", "请重新登录。", 401)
        return tokens[token]

    def authorize(owner, chat):
        if chat not in sessions.get(owner, set()):
            raise WorkError("not_found", "会话不存在。", 404)

    @web.middleware
    async def authenticate(request, handler):
        try:
            if not TenantOffice.is_socket(request):
                token = request.headers.get("Authorization", "").removeprefix("Bearer ")
                request["owner"], request["account_token"] = await identity(token), token
            return await handler(request)
        except WorkError as exc:
            return web.json_response({"error": exc.code}, status=exc.status)

    state_root = tmp_path / "state"
    if os.name == "nt":
        state_root = Path("\\\\?\\" + str(state_root))
    config = HostedWorkConfig(state_dir=str(state_root), public_origin="https://mona-ai.cn")
    app = web.Application(middlewares=[authenticate])
    office = register_tenant_office(app, config, authorize_session=authorize, identity=identity)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, office, tokens


def headers(token="alice", chat=CHAT_A):
    return {"Authorization": "Bearer " + token, OFFICE_OWNER_HEADER: "websocket:" + chat}


async def create(client, *, token="alice", chat=CHAT_A, kind="docs", path=None):
    body = {"ownerSessionKey": "websocket:" + chat, "type": kind}
    if path is not None:
        body["path"] = path
    response = await client.post(OFFICE_PREFIX + "/sessions", json=body, headers=headers(token, chat))
    assert response.status == 201, await response.text()
    return await response.json()


async def ticket(client, state, *, token="alice", chat=CHAT_A):
    response = await client.post(OFFICE_PREFIX + "/sessions/" + state["sessionId"] + "/socket-ticket",
                                 json={}, headers=headers(token, chat))
    assert response.status == 200
    return (await response.json())["ticket"]


async def connect(client, state):
    value = await ticket(client, state)
    socket = await client.ws_connect(OFFICE_PREFIX + "/ws?ticket=" + value,
                                    headers={"Origin": "https://mona-ai.cn"})
    opened = await socket.receive_json()
    assert opened["session"]["sessionId"] == state["sessionId"]
    assert opened["session"]["workingPath"] == state["workingPath"]
    await socket.send_json({"event": "office_editor_ready", "sessionId": state["sessionId"], "version": state["version"]})
    synchronized = await socket.receive_json()
    assert synchronized["event"] == "office_session_state"
    assert synchronized["session"]["workingPath"] == state["workingPath"]
    return socket, value


async def test_account_and_chat_scopes_are_server_authorized(tmp_path):
    client, office, _ = await make_client(tmp_path)
    async with client:
        source = office.workspace(ALICE) / "input.docx"
        source.write_bytes(b"account A document")
        state = await create(client, path="/workspace/input.docx")
        assert state["workingPath"] == "/workspace/.office/" + state["sessionId"] + "/working.docx"
        session_path = OFFICE_PREFIX + "/sessions/" + state["sessionId"]
        assert (await client.get(session_path)).status == 401
        assert (await client.get(session_path, headers=headers("bob", CHAT_B))).status == 404
        assert (await client.get(session_path, headers=headers("bob", CHAT_A))).status == 404
        assert (await client.get(session_path, headers=headers("alice", CHAT_A_OTHER))).status == 404
        response = await client.get(session_path + "/file", headers=headers())
        assert await response.read() == b"account A document"
        listed = await client.get(OFFICE_PREFIX + "/sessions", headers=headers())
        assert (await listed.json())["sessions"][0]["workingPath"] == state["workingPath"]
        states = await office.list_states(ALICE, CHAT_A)
        assert len(states) == 1 and states[0]["sessionId"] == state["sessionId"]
        assert states[0]["workingPath"] == state["workingPath"]
        with pytest.raises(WorkError) as foreign:
            await office.list_states(BOB, CHAT_A)
        assert foreign.value.status == 404

        external = tmp_path / "private.docx"
        external.write_bytes(b"host file")
        denied = await client.post(OFFICE_PREFIX + "/sessions", headers=headers(), json={
            "ownerSessionKey": "websocket:" + CHAT_A, "type": "docs", "path": str(external),
        })
        assert denied.status == 422
        denied = await client.post(session_path + "/export", headers=headers(), json={"output": "../escape.docx"})
        assert denied.status == 422
        assert external.read_bytes() == b"host file"
        assert office.workspace(ALICE) != office.workspace(BOB)


async def test_live_summary_accepts_editor_quality_warnings_without_closing_socket(tmp_path):
    client, office, _ = await make_client(tmp_path)
    async with client:
        state = await create(client)
        socket, _ = await connect(client, state)
        request = asyncio.create_task(client.post(OFFICE_PREFIX + "/sessions/" + state["sessionId"] + "/inspect",
            headers=headers(), json={"sessionId": state["sessionId"], "query": {"mode": "summary"}}))
        async with asyncio.timeout(3):
            message = await socket.receive_json()
            while message.get("event") != "office_inspect_command":
                message = await socket.receive_json()
        await socket.send_json({"event": "office_inspect_result", "result": {"ok": True,
            "requestId": message["command"]["requestId"], "sessionId": state["sessionId"], "version": state["version"],
            "result": {"mode": "summary", "documentType": "docs", "blockCount": 1, "warnings": ["保留原有样式"]}}})
        response = await asyncio.wait_for(request, 3)
        assert response.status == 200
        assert (await response.json())["result"]["warnings"] == ["保留原有样式"]
        assert not socket.closed
        await socket.close()
    await office.close()


async def test_checkpoint_upload_isolated_and_shared_version_protocol(tmp_path):
    client, _, _ = await make_client(tmp_path)
    async with client:
        state = await create(client)
        socket, _ = await connect(client, state)
        version = {**state["version"], "modelRevision": 1}
        await socket.send_json({"event": "office_user_change", "sessionId": state["sessionId"],
                                "version": version, "changedTargets": ["document"]})
        assert (await socket.receive_json())["session"]["version"] == version
        content = b"checkpoint bytes"
        session_path = OFFICE_PREFIX + "/sessions/" + state["sessionId"]
        response = await client.post(session_path + "/checkpoint-uploads", headers=headers(), json={
            "version": version, "size": len(content), "sha256": hashlib.sha256(content).hexdigest(),
        })
        assert response.status == 201
        upload = (await response.json())["uploadId"]
        upload_path = OFFICE_PREFIX + "/checkpoint-uploads/" + upload
        assert (await client.put(upload_path + "?offset=0", data=content, headers=headers("bob", CHAT_B))).status == 404
        assert (await client.put(upload_path + "?offset=0", data=content, headers=headers("alice", CHAT_A_OTHER))).status == 404
        assert (await client.put(upload_path + "?offset=0", data=content, headers=headers())).status == 200
        finished = await client.post(upload_path + "/finish", headers=headers())
        assert finished.status == 200
        assert (await finished.json())["version"] == version
        saved = await client.get(session_path + "/file", headers=headers())
        assert await saved.read() == content
        exported = await client.post(session_path + "/export", headers=headers(), json={"output": "/workspace/result.docx", "version": version})
        assert exported.status == 200
        await socket.close()


@pytest.mark.parametrize("invalid", ["revoked", "other_document"])
async def test_office_socket_rechecks_identity_and_document_before_writes(tmp_path, invalid):
    client, _, tokens = await make_client(tmp_path)
    async with client:
        state = await create(client)
        socket, used = await connect(client, state)
        if invalid == "revoked":
            tokens.pop("alice")
            target = state["sessionId"]
        else:
            target = (await create(client))["sessionId"]
        await socket.send_json({"event": "office_user_change", "sessionId": target,
                                "version": {**state["version"], "modelRevision": 1}, "changedTargets": ["document"]})
        closed = await socket.receive()
        assert closed.type in {WSMsgType.CLOSE, WSMsgType.CLOSED}
        assert socket.close_code == 1008
        response = await client.get(OFFICE_PREFIX + "/sessions/" + state["sessionId"], headers=headers("alice-new"))
        assert (await response.json())["version"]["modelRevision"] == 0
        with pytest.raises(WSServerHandshakeError) as replay:
            await client.ws_connect(OFFICE_PREFIX + "/ws?ticket=" + used)
        assert replay.value.status == 401


async def test_revoked_ticket_cannot_open_websocket(tmp_path):
    client, _, tokens = await make_client(tmp_path)
    async with client:
        state = await create(client)
        value = await ticket(client, state)
        tokens.pop("alice")
        with pytest.raises(WSServerHandshakeError) as revoked:
            await client.ws_connect(OFFICE_PREFIX + "/ws?ticket=" + value)
        assert revoked.value.status == 401


async def test_hosted_xlsx_requires_explicit_isolated_engine(tmp_path):
    client, _, _ = await make_client(tmp_path)
    async with client:
        state = await create(client, kind="sheets")
        response = await client.post(OFFICE_PREFIX + "/sessions/" + state["sessionId"] + "/engine/open", headers=headers())
        assert response.status == 503
        assert (await response.json())["error"]["code"] == "EDITOR_UNAVAILABLE"


async def test_recovered_source_cannot_escape_account_documents(tmp_path):
    client, office, _ = await make_client(tmp_path)
    async with client:
        state = await create(client)
        session_dir = office.root / "users" / ALICE / "office" / CHAT_A / "sessions" / state["sessionId"]
        metadata = session_dir / "session.json"
        payload = json.loads(metadata.read_text(encoding="utf-8"))
        await office.close()
        payload["sourcePath"] = str(tmp_path / "host-private.docx")
        metadata.write_text(json.dumps(payload), encoding="utf-8")
        response = await client.get(OFFICE_PREFIX + "/sessions/" + state["sessionId"], headers=headers())
        assert response.status == 503
        assert (await response.json())["error"] == "invalid_state"


async def test_office_paths_reject_symbolic_links(tmp_path):
    client, office, _ = await make_client(tmp_path)
    async with client:
        outside = tmp_path / "host-private.docx"
        outside.write_bytes(b"private")
        link = office.workspace(ALICE) / "link.docx"
        try:
            link.symlink_to(outside)
        except OSError:
            pytest.skip("Host does not allow test symlinks; repeat on Linux")
        response = await client.post(OFFICE_PREFIX + "/sessions", headers=headers(), json={
            "ownerSessionKey": "websocket:" + CHAT_A, "type": "docs", "path": "/workspace/link.docx",
        })
        assert response.status == 503
        assert outside.read_bytes() == b"private"
