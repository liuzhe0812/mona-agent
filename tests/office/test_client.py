from __future__ import annotations

import json

import httpx
import pytest

from mona.office.client import OfficeServiceClient
from mona.office.errors import OfficeError, OfficeErrorCode


async def test_client_sends_services_token_and_owner_header() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Mona-Token"] == "token"
        assert request.headers["X-Mona-Session-Key"] == "chat:1"
        body = json.loads(request.content)
        assert body["ownerSessionKey"] == "chat:1"
        return httpx.Response(
            201,
            json={
                "sessionId": "office_1",
                "displayName": "input.xlsx",
                "type": "sheets",
                "version": {"editorEpoch": "epoch_1", "modelRevision": 0},
                "checkpointVersion": None,
                "savedVersion": None,
                "dirty": False,
                "editorConnected": False,
                "saveState": "clean",
                "lastError": None,
            },
        )

    client = OfficeServiceClient(
        "http://127.0.0.1:17174",
        token="token",
        transport=httpx.MockTransport(handler),
    )

    session = await client.open(
        owner_session_key="chat:1",
        path="input.xlsx",
        document_type="sheets",
    )

    assert session.session_id == "office_1"


async def test_client_maps_structured_service_error() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={
                "error": {
                    "code": "SAVE_CONFLICT",
                    "message": "source changed",
                    "retryable": False,
                }
            },
        )

    client = OfficeServiceClient(
        "http://127.0.0.1:17174",
        token="token",
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(OfficeError) as error:
        await client.save("office_1", owner_session_key="chat:1", overwrite_source=True)

    assert error.value.code == OfficeErrorCode.SAVE_CONFLICT


async def test_client_lists_sessions_for_the_request_owner() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == "/api/office/sessions"
        assert request.headers["X-Mona-Session-Key"] == "chat:1"
        return httpx.Response(
            200,
            json={
                "sessions": [
                    {
                        "sessionId": "office_1",
                        "displayName": "input.xlsx",
                        "type": "sheets",
                        "version": {"editorEpoch": "epoch_1", "modelRevision": 0},
                        "checkpointVersion": None,
                        "savedVersion": None,
                        "dirty": False,
                        "editorConnected": True,
                        "saveState": "clean",
                        "lastError": None,
                    }
                ]
            },
        )

    client = OfficeServiceClient(
        "http://127.0.0.1:17174",
        token="token",
        transport=httpx.MockTransport(handler),
    )

    sessions = await client.list(owner_session_key="chat:1")

    assert [session.session_id for session in sessions] == ["office_1"]
