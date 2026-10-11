"""Conversation file attachments do not require a supported decoder."""

import base64

import pytest

from mona.channels.websocket import WebSocketChannel
from mona.utils.document import extract_documents


@pytest.mark.asyncio
@pytest.mark.parametrize("source_kind", ["local_path", "data_url"])
async def test_upload_preserves_arbitrary_files_before_chat_creation(tmp_path, source_kind):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    channel = object.__new__(WebSocketChannel)
    channel.workspace = workspace
    events = []

    async def send_event(_connection, _event, **payload):
        events.append(payload)

    channel._send_event = send_event
    payloads = []
    for name, mime in [
        ("drawing.svg", "image/svg+xml"),
        ("photo.heic", "image/heic"),
        ("data.zip", "application/zip"),
        ("custom", "application/octet-stream"),
    ]:
        source = tmp_path / name
        source.write_bytes(b"original file bytes")
        value = str(source) if source_kind == "local_path" else (
            f"data:{mime};base64," + base64.b64encode(source.read_bytes()).decode()
        )
        payloads.append({"name": name, source_kind: value})

    await channel._handle_doc_upload_envelope(object(), {
        "type": "doc_upload",
        "chat_id": "ephemeral:attachment-test",
        "files": payloads,
    })

    result = events[-1]
    assert result["ok"] is True
    assert result["chat_id"] == "ephemeral:attachment-test"
    assert [file["name"] for file in result["files"]] == [file["name"] for file in payloads]
    for file in result["files"]:
        uploaded = workspace / file["path"]
        assert uploaded.read_bytes() == b"original file bytes"
    unknown = workspace / result["files"][-1]["path"]
    text, _ = extract_documents("inspect this file", [str(unknown)])
    assert f"Path: {unknown}" in text
