from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from urllib.parse import urlencode

import pytest
from aiohttp import WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

from mona.materials.auth import materials_auth_middleware
from mona.office.api import (
    OFFICE_MANAGER_KEY,
    office_error_middleware,
    register_office_routes,
)
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.manager import OfficeSessionManager
from mona.office.schemas import OFFICE_OWNER_HEADER, DocumentVersion
from mona.office.sidecar import XlsxEngineService


@pytest.fixture
def services_token(monkeypatch) -> str:
    token = "office-test-token"
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    return token


async def _make_client(
    tmp_path: Path,
    *,
    max_checkpoint_bytes: int = 1024 * 1024,
    engine: XlsxEngineService | None = None,
) -> tuple[TestClient, Path]:
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    app = web.Application(middlewares=[materials_auth_middleware, office_error_middleware])
    register_office_routes(
        app,
        manager=OfficeSessionManager(
            sessions_root=tmp_path / "data" / "office" / "sessions",
            max_checkpoint_bytes=max_checkpoint_bytes,
        ),
        engine=engine,
        workspace=workspace,
    )
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, workspace


async def _create_session(
    client: TestClient,
    workspace: Path,
    token: str,
) -> dict:
    source = workspace / "input.xlsx"
    source.write_bytes(b"initial workbook")
    response = await client.post(
        "/api/office/sessions",
        json={"ownerSessionKey": "chat:1", "path": str(source)},
        headers={
            "X-Mona-Token": token,
            OFFICE_OWNER_HEADER: "chat:1",
        },
    )
    assert response.status == 201
    return await response.json()


async def _import_session(
    client: TestClient,
    token: str,
    *,
    owner: str = "chat:1",
    filename: str = "input.xlsx",
    source_identity: str = "workspace/input.xlsx",
    payload: bytes = b"imported workbook",
) -> tuple[int, dict]:
    query = urlencode({"filename": filename, "sourceIdentity": source_identity})
    response = await client.post(
        f"/api/office/import?{query}",
        data=payload,
        headers={
            "X-Mona-Token": token,
            OFFICE_OWNER_HEADER: owner,
            "Content-Type": "application/octet-stream",
        },
    )
    return response.status, await response.json()


async def test_office_session_routes_require_token_and_owner(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        source = workspace / "input.xlsx"
        source.write_bytes(b"initial workbook")
        unauthorized = await client.post(
            "/api/office/sessions",
            json={"ownerSessionKey": "chat:1", "path": str(source)},
        )
        assert unauthorized.status == 401

        mismatched_owner = await client.post(
            "/api/office/sessions",
            json={"ownerSessionKey": "chat:1", "path": str(source)},
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:other",
            },
        )
        assert mismatched_owner.status == 422

        session = await _create_session(client, workspace, services_token)
        wrong_owner = await client.get(
            f"/api/office/sessions/{session['sessionId']}",
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:other",
            },
        )
        assert wrong_owner.status == 404

        response = await client.get(
            f"/api/office/sessions/{session['sessionId']}",
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )
        assert response.status == 200
        assert (await response.json())["displayName"] == "input.xlsx"

        listed = await client.get(
            "/api/office/sessions",
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )
        assert listed.status == 200
        assert [item["sessionId"] for item in (await listed.json())["sessions"]] == [
            session["sessionId"]
        ]

        other_owner = await client.get(
            "/api/office/sessions",
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:other",
            },
        )
        assert other_owner.status == 200
        assert (await other_owner.json())["sessions"] == []


async def test_import_streams_binary_and_returns_clean_private_session(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, _ = await _make_client(tmp_path)
    async with client:
        status, body = await _import_session(
            client,
            services_token,
            filename="报告.xlsx",
            source_identity=r"C:\授权\报告.xlsx",
            payload=b"binary workbook",
        )

        assert status == 201
        assert body["displayName"] == "报告.xlsx"
        assert not body["dirty"]
        assert body["saveState"] == "clean"
        assert body["savedVersion"] == body["version"]
        assert "sourceIdentity" not in body

        manager = client.server.app[OFFICE_MANAGER_KEY]
        session = manager.get_session(body["sessionId"], owner_session_key="chat:1")
        assert session.source_path is None
        assert session.source_identity == "C:/授权/报告.xlsx"
        assert session.working_path.read_bytes() == b"binary workbook"
        assert not list(manager.sessions_root.glob(".office-import-*"))


async def test_import_rejects_empty_oversized_and_unsupported_requests(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, _ = await _make_client(tmp_path, max_checkpoint_bytes=4)
    async with client:
        empty_status, empty_body = await _import_session(
            client,
            services_token,
            payload=b"",
        )
        assert empty_status == 422
        assert empty_body["error"]["code"] == OfficeErrorCode.INVALID_OPERATION

        oversized_status, oversized_body = await _import_session(
            client,
            services_token,
            payload=b"12345",
        )
        assert oversized_status == 422
        assert oversized_body["error"]["code"] == OfficeErrorCode.CHECKPOINT_FAILED

        unsupported_status, unsupported_body = await _import_session(
            client,
            services_token,
            filename="notes.txt",
            payload=b"text",
        )
        assert unsupported_status == 422
        assert unsupported_body["error"]["code"] == OfficeErrorCode.INVALID_OPERATION

        traversal_status, traversal_body = await _import_session(
            client,
            services_token,
            filename="../input.xlsx",
            payload=b"xlsx",
        )
        assert traversal_status == 422
        assert traversal_body["error"]["code"] == OfficeErrorCode.INVALID_OPERATION

        manager = client.server.app[OFFICE_MANAGER_KEY]
        assert not list(manager.sessions_root.glob(".office-import-*"))


async def test_duplicate_import_is_owner_isolated_and_preserves_revision(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, _ = await _make_client(tmp_path)
    async with client:
        first_status, first = await _import_session(
            client,
            services_token,
            source_identity="same/source.xlsx",
            payload=b"first workbook",
        )
        assert first_status == 201
        manager = client.server.app[OFFICE_MANAGER_KEY]
        session = manager.get_session(first["sessionId"], owner_session_key="chat:1")
        revision = DocumentVersion(
            editor_epoch=session.version.editor_epoch,
            model_revision=3,
        )
        manager.record_editor_version(
            session.session_id,
            revision,
            changed_targets=["Sheet1!A1"],
        )

        duplicate_status, duplicate = await _import_session(
            client,
            services_token,
            source_identity=r"same\source.xlsx",
            payload=b"second workbook must be ignored",
        )
        assert duplicate_status == 200
        assert duplicate["sessionId"] == first["sessionId"]
        assert duplicate["version"]["modelRevision"] == 3
        assert session.working_path.read_bytes() == b"first workbook"

        isolated_status, isolated = await _import_session(
            client,
            services_token,
            owner="chat:2",
            source_identity="same/source.xlsx",
            payload=b"other owner workbook",
        )
        assert isolated_status == 201
        assert isolated["sessionId"] != first["sessionId"]


async def test_concurrent_duplicate_imports_share_one_session(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, _ = await _make_client(tmp_path)
    async with client:
        results = await asyncio.gather(
            _import_session(
                client,
                services_token,
                source_identity="concurrent/source.xlsx",
                payload=b"first",
            ),
            _import_session(
                client,
                services_token,
                source_identity=r"concurrent\source.xlsx",
                payload=b"second",
            ),
        )

        assert {status for status, _ in results} == {200, 201}
        assert len({body["sessionId"] for _, body in results}) == 1
        manager = client.server.app[OFFICE_MANAGER_KEY]
        assert len(manager._sessions) == 1


async def test_imported_session_can_be_reused_by_absolute_path_open(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        source = workspace / "not-present.xlsx"
        identity = str(source).replace("\\", "/")
        _, imported = await _import_session(
            client,
            services_token,
            source_identity=identity,
            payload=b"imported copy",
        )

        opened = await client.post(
            "/api/office/sessions",
            json={"ownerSessionKey": "chat:1", "path": str(source)},
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )

        assert opened.status == 201
        reopened = await opened.json()
        assert reopened["sessionId"] == imported["sessionId"]
        manager = client.server.app[OFFICE_MANAGER_KEY]
        session = manager.get_session(imported["sessionId"], owner_session_key="chat:1")
        assert session.source_path is None
        assert session.working_path.read_bytes() == b"imported copy"


async def test_import_checks_streaming_limit_without_content_length(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, _ = await _make_client(tmp_path, max_checkpoint_bytes=4)
    async def chunks():
        yield b"123"
        yield b"45"

    async with client:
        response = await client.post(
            "/api/office/import?filename=large.xlsx&sourceIdentity=large.xlsx",
            data=chunks(),
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
                "Content-Type": "application/octet-stream",
            },
        )
        assert response.status == 422
        manager = client.server.app[OFFICE_MANAGER_KEY]
        assert not list(manager.sessions_root.glob(".office-import-*"))
        assert not list(manager.sessions_root.glob("office_*"))


@pytest.mark.parametrize("filename", ["blank.docx", "blank.xlsx", "blank.pptx"])
async def test_native_import_roundtrip_and_recovery_never_overwrites_source(
    tmp_path: Path,
    services_token: str,
    filename: str,
) -> None:
    payload = (Path(__file__).parents[1] / "fixtures" / "office" / filename).read_bytes()
    client, _ = await _make_client(tmp_path)
    async with client:
        _, imported = await _import_session(
            client, services_token, filename=filename,
            source_identity=f"external/{filename}", payload=payload,
        )
        manager = client.server.app[OFFICE_MANAGER_KEY]
        recovered_manager = OfficeSessionManager(sessions_root=manager.sessions_root)
        session = recovered_manager.get_session(imported["sessionId"], owner_session_key="chat:1")
        assert session.working_path.read_bytes() == payload
        assert session.source_identity == f"external/{filename}"
        with pytest.raises(OfficeError) as error:
            recovered_manager.save(session.session_id, overwrite_source=True)
        assert error.value.code == OfficeErrorCode.INVALID_OPERATION


async def test_socket_ticket_is_single_use_and_binds_editor_epoch(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        session = await _create_session(client, workspace, services_token)
        ticket_response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/socket-ticket",
            json={"renewEditor": False},
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )
        assert ticket_response.status == 200
        ticket = (await ticket_response.json())["ticket"]

        socket = await client.ws_connect(f"/api/office/ws?ticket={ticket}")
        opened = await socket.receive_json()
        assert opened["event"] == "office_session_open"
        await socket.send_json(
            {
                "event": "office_editor_ready",
                "sessionId": session["sessionId"],
                "version": session["version"],
            }
        )
        state = await socket.receive_json()
        assert state["event"] == "office_session_state"
        assert state["session"]["editorConnected"] is True
        await socket.close()

        with pytest.raises(WSServerHandshakeError) as error:
            await client.ws_connect(f"/api/office/ws?ticket={ticket}")
        assert error.value.status == 401


async def test_closing_session_notifies_editor_and_does_not_recover(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        session = await _create_session(client, workspace, services_token)
        headers = {
            "X-Mona-Token": services_token,
            OFFICE_OWNER_HEADER: "chat:1",
        }
        ticket_response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/socket-ticket",
            json={"renewEditor": False},
            headers=headers,
        )
        socket = await client.ws_connect(
            f"/api/office/ws?ticket={(await ticket_response.json())['ticket']}"
        )
        await socket.receive_json()
        await socket.send_json(
            {
                "event": "office_editor_ready",
                "sessionId": session["sessionId"],
                "version": session["version"],
            }
        )
        await socket.receive_json()

        closed = await client.delete(
            f"/api/office/sessions/{session['sessionId']}",
            headers=headers,
        )

        assert closed.status == 200
        assert (await socket.receive_json())["event"] == "office_session_closed"
        recovered_manager = OfficeSessionManager(
            sessions_root=workspace.parent / "data" / "office" / "sessions"
        )
        with pytest.raises(OfficeError) as error:
            recovered_manager.get_session(session["sessionId"], owner_session_key="chat:1")
        assert error.value.code == OfficeErrorCode.SESSION_NOT_FOUND

async def test_checkpoint_stream_export_and_file_read(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        session = await _create_session(client, workspace, services_token)
        common_headers = {
            "X-Mona-Token": services_token,
            OFFICE_OWNER_HEADER: "chat:1",
        }
        ticket_response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/socket-ticket",
            json={"renewEditor": False},
            headers=common_headers,
        )
        socket = await client.ws_connect(
            f"/api/office/ws?ticket={(await ticket_response.json())['ticket']}"
        )
        await socket.receive_json()
        await socket.send_json(
            {
                "event": "office_editor_ready",
                "sessionId": session["sessionId"],
                "version": session["version"],
            }
        )
        await socket.receive_json()
        checkpoint_version = {
            "editorEpoch": session["version"]["editorEpoch"],
            "modelRevision": 1,
        }
        await socket.send_json(
            {
                "event": "office_user_change",
                "sessionId": session["sessionId"],
                "version": checkpoint_version,
                "changedTargets": ["Sheet1!A1"],
            }
        )
        await socket.receive_json()
        payload = b"checkpoint workbook"
        start = await client.post(
            f"/api/office/sessions/{session['sessionId']}/checkpoint-uploads",
            json={
                "version": checkpoint_version,
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            },
            headers=common_headers,
        )
        assert start.status == 201
        upload_id = (await start.json())["uploadId"]
        first = await client.put(
            f"/api/office/checkpoint-uploads/{upload_id}?offset=0",
            data=payload[:5],
            headers=common_headers,
        )
        assert first.status == 200
        second = await client.put(
            f"/api/office/checkpoint-uploads/{upload_id}?offset=5",
            data=payload[5:],
            headers=common_headers,
        )
        assert second.status == 200
        checkpoint = await client.post(
            f"/api/office/checkpoint-uploads/{upload_id}/finish",
            headers=common_headers,
        )
        assert checkpoint.status == 200

        file_response = await client.get(
            f"/api/office/sessions/{session['sessionId']}/file",
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )
        assert file_response.status == 200
        assert await file_response.read() == payload

        exported = await client.post(
            f"/api/office/sessions/{session['sessionId']}/export",
            json={"output": "output/result.xlsx"},
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
            },
        )
        assert exported.status == 200
        assert (workspace / "output" / "result.xlsx").read_bytes() == payload
        await socket.close()


async def test_checkpoint_route_enforces_its_own_size_limit(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path, max_checkpoint_bytes=4)
    async with client:
        session = await _create_session(client, workspace, services_token)
        payload = b"12345"
        response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/checkpoint",
            data=payload,
            headers={
                "X-Mona-Token": services_token,
                OFFICE_OWNER_HEADER: "chat:1",
                "X-Office-Editor-Epoch": session["version"]["editorEpoch"],
                "X-Office-Model-Revision": "0",
                "X-Office-Content-SHA256": hashlib.sha256(payload).hexdigest(),
            },
        )

        assert response.status == 422
        assert (await response.json())["error"]["code"] == "CHECKPOINT_FAILED"


async def test_checkpoint_chunks_must_arrive_in_order(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        session = await _create_session(client, workspace, services_token)
        headers = {
            "X-Mona-Token": services_token,
            OFFICE_OWNER_HEADER: "chat:1",
        }
        payload = b"12"
        start = await client.post(
            f"/api/office/sessions/{session['sessionId']}/checkpoint-uploads",
            json={
                "version": session["version"],
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            },
            headers=headers,
        )
        upload_id = (await start.json())["uploadId"]

        out_of_order = await client.put(
            f"/api/office/checkpoint-uploads/{upload_id}?offset=1",
            data=payload,
            headers=headers,
        )

        assert out_of_order.status == 422
        assert (await out_of_order.json())["error"]["code"] == "INVALID_OPERATION"


async def test_apply_returns_before_checkpoint_and_save_requests_target_version(
    tmp_path: Path,
    services_token: str,
) -> None:
    client, workspace = await _make_client(tmp_path)
    async with client:
        session = await _create_session(client, workspace, services_token)
        common_headers = {
            "X-Mona-Token": services_token,
            OFFICE_OWNER_HEADER: "chat:1",
        }
        ticket_response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/socket-ticket",
            json={"renewEditor": False},
            headers=common_headers,
        )
        ticket = (await ticket_response.json())["ticket"]
        socket = await client.ws_connect(f"/api/office/ws?ticket={ticket}")
        await socket.receive_json()
        await socket.send_json(
            {
                "event": "office_editor_ready",
                "sessionId": session["sessionId"],
                "version": session["version"],
            }
        )
        await socket.receive_json()

        inspect_task = asyncio.create_task(
            client.post(
                f"/api/office/sessions/{session['sessionId']}/inspect",
                json={"sessionId": session["sessionId"], "query": {"mode": "summary"}},
                headers=common_headers,
            )
        )
        inspect_command = await socket.receive_json()
        assert inspect_command["event"] == "office_inspect_command"
        await socket.send_json(
            {
                "event": "office_inspect_result",
                "result": {
                    "ok": True,
                    "requestId": inspect_command["command"]["requestId"],
                    "sessionId": session["sessionId"],
                    "version": session["version"],
                        "result": {
                            "mode": "summary",
                            "documentType": "sheets",
                            "sheetCount": 1,
                        "sheets": [
                            {"id": "sheet_1", "name": "Sheet1", "rowCount": 1, "columnCount": 1}
                        ],
                    },
                },
            }
        )
        inspect_response = await inspect_task
        assert inspect_response.status == 200
        assert (await inspect_response.json())["result"]["sheetCount"] == 1

        apply_task = asyncio.create_task(
            client.post(
                f"/api/office/sessions/{session['sessionId']}/apply",
                json={
                    "sessionId": session["sessionId"],
                    "operationId": "op_api_1",
                    "expectedVersion": session["version"],
                    "operations": [
                        {
                            "op": "set_cell",
                            "payload": {"sheet": "Sheet1", "cell": "A1", "value": "updated"},
                        }
                    ],
                },
                headers=common_headers,
            )
        )
        apply_command = await socket.receive_json()
        assert apply_command["event"] == "office_command"
        committed_version = {
            "editorEpoch": session["version"]["editorEpoch"],
            "modelRevision": 1,
        }
        await socket.send_json(
            {
                "event": "office_command_result",
                "result": {
                    "ok": True,
                    "sessionId": session["sessionId"],
                    "operationId": "op_api_1",
                    "version": committed_version,
                    "changedTargets": ["Sheet1!A1"],
                    "summary": "updated",
                },
            }
        )
        apply_response = await apply_task
        assert apply_response.status == 200
        assert (await apply_response.json())["version"] == committed_version

        save_task = asyncio.create_task(
            client.post(
                f"/api/office/sessions/{session['sessionId']}/save",
                json={"overwriteSource": False, "version": committed_version},
                headers=common_headers,
            )
        )
        state_after_apply = await socket.receive_json()
        assert state_after_apply["event"] == "office_session_state"
        checkpoint_request = await socket.receive_json()
        assert checkpoint_request == {
            "event": "office_checkpoint_request",
            "sessionId": session["sessionId"],
            "version": committed_version,
        }

        payload = b"revision one workbook"
        checkpoint = await client.post(
            f"/api/office/sessions/{session['sessionId']}/checkpoint",
            data=payload,
            headers={
                **common_headers,
                "X-Office-Editor-Epoch": committed_version["editorEpoch"],
                "X-Office-Model-Revision": "1",
                "X-Office-Content-SHA256": hashlib.sha256(payload).hexdigest(),
            },
        )
        assert checkpoint.status == 200
        save_response = await save_task
        assert save_response.status == 200
        assert (await save_response.json())["version"] == committed_version
        await socket.close()


async def test_engine_routes_use_the_session_working_copy(
    tmp_path: Path,
    services_token: str,
) -> None:
    class FakeProcess:
        async def open(self, path: Path, *, locale: str = "zh"):
            assert path.name == "working.xlsx"
            assert locale == "zh"
            return {"sessionId": "engine_1", "name": "input.xlsx", "sheets": []}

        async def read_range(self, **kwargs):
            assert kwargs["session_id"] == "engine_1"
            return {"cells": [{"row": 0, "column": 0, "value": "ok"}]}

        async def close_workbook(self, _session_id: str) -> None:
            return None

        async def stop(self) -> None:
            return None

    client, workspace = await _make_client(
        tmp_path,
        engine=XlsxEngineService(FakeProcess()),  # type: ignore[arg-type]
    )
    async with client:
        session = await _create_session(client, workspace, services_token)
        headers = {
            "X-Mona-Token": services_token,
            OFFICE_OWNER_HEADER: "chat:1",
        }
        opened = await client.post(
            f"/api/office/sessions/{session['sessionId']}/engine/open",
            headers=headers,
        )
        assert opened.status == 200
        assert (await opened.json())["sessionId"] == "engine_1"

        range_response = await client.post(
            f"/api/office/sessions/{session['sessionId']}/engine/range",
            json={
                "sheetId": "sheet_1",
                "range": {"startRow": 0, "endRow": 0, "startColumn": 0, "endColumn": 0},
            },
            headers=headers,
        )
        assert range_response.status == 200
        assert (await range_response.json())["cells"][0]["value"] == "ok"
