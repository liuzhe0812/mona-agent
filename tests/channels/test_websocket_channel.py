"""Unit and lightweight integration tests for the WebSocket channel."""

import asyncio
import functools
import json
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import websockets
from websockets.exceptions import ConnectionClosed
from websockets.frames import Close

from mona.bus.events import OUTBOUND_META_AGENT_UI, OutboundMessage
from mona.bus.queue import MessageBus
from mona.channels.websocket import (
    WebSocketChannel,
    WebSocketConfig,
    _is_valid_chat_id,
    _issue_route_secret_matches,
    _normalize_config_path,
    _parse_envelope,
    _parse_inbound_payload,
    _parse_query,
    _parse_request_path,
    publish_runtime_model_update,
)
from mona.config.loader import load_config, save_config
from mona.config.schema import Config, ModelPresetConfig
from mona.webui.settings_api import settings_payload

# -- Shared helpers (aligned with test_websocket_integration.py) ---------------

_PORT = 29876


def _ch(bus: Any, **kw: Any) -> WebSocketChannel:
    cfg: dict[str, Any] = {
        "enabled": True,
        "allowFrom": ["*"],
        "host": "127.0.0.1",
        "port": _PORT,
        "path": "/ws",
        "websocketRequiresToken": False,
    }
    cfg.update(kw)
    return WebSocketChannel(cfg, bus)


@pytest.fixture()
def bus() -> MagicMock:
    b = MagicMock()
    b.publish_inbound = AsyncMock()
    return b


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/", "/index.html", "/favicon.svg", "/sessions/abc"])
async def test_channel_does_not_serve_frontend(bus: MagicMock, path: str) -> None:
    from websockets.datastructures import Headers
    from websockets.http11 import Request

    channel = _ch(bus, path="/")
    response = await channel._dispatch_http(MagicMock(), Request(path, Headers()))
    assert response.status_code == 404
    assert response.body == b"Not Found"


async def _http_get(url: str, headers: dict[str, str] | None = None) -> httpx.Response:
    """Run GET in a thread to avoid blocking the asyncio loop shared with websockets."""
    return await asyncio.to_thread(
        functools.partial(httpx.get, url, headers=headers or {}, timeout=5.0)
    )


def test_parse_request_path_strips_trailing_slash_except_root() -> None:
    assert _parse_request_path("/chat/")[0] == "/chat"
    assert _parse_request_path("/chat?x=1")[0] == "/chat"
    assert _parse_request_path("/")[0] == "/"


def test_parse_request_path_splits_path_and_query() -> None:
    path, query = _parse_request_path("/ws/?token=secret&client_id=u1")
    assert path == "/ws"
    assert query == {"token": ["secret"], "client_id": ["u1"]}


def test_normalize_config_path_matches_request() -> None:
    assert _normalize_config_path("/ws/") == "/ws"
    assert _normalize_config_path("/") == "/"


def test_agent_artifact_scan_is_complete_and_projections_stay_owned(
    bus: MagicMock, tmp_path, monkeypatch
) -> None:
    from types import SimpleNamespace
    from urllib.parse import urlencode

    from mona.agent.artifacts import ArtifactRef
    from mona.agent.partners import ConversationMetadata
    from mona.config.paths import get_agent_output_dir
    from mona.session.manager import SessionManager

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path / "webui")
    sessions = SessionManager(tmp_path / "sessions")

    def create_session(chat_id: str, agent_id: str) -> str:
        key = f"websocket:{chat_id}"
        session = sessions.get_or_create(key)
        session.metadata.pop("workspace", None)
        session.metadata["conversation"] = ConversationMetadata.direct(agent_id).to_session_metadata()
        sessions.save(session)
        assert "workspace" not in session.metadata
        return key

    key = create_session("chat-musician", "com.mona.musician")
    other_session = create_session("chat-musician-other", "com.mona.musician")
    other_agent_session = create_session("chat-other-agent", "com.mona.other")
    channel = _ch(bus)
    channel._session_manager = sessions
    channel.workspace = tmp_path
    channel._api_tokens["live"] = 1e20
    channel._start_artifact_task("chat-musician", "task-abc")

    musician_output = get_agent_output_dir(tmp_path, "com.mona.musician")
    delivered = musician_output / "delivered.abc"
    task_file = musician_output / "task.abc"
    delivered.write_text("delivered", encoding="utf-8")
    task_file.write_text("task", encoding="utf-8")
    (musician_output / "empty").mkdir()
    delivered_ref = ArtifactRef.for_path(
        owner_kind="agent",
        owner_id="com.mona.musician",
        root=musician_output,
        path=delivered,
        created_by_agent_id="com.mona.musician",
        session_id=key,
    )
    channel._try_append_webui_transcript(
        "chat-musician",
        {
            "event": "deliver_files",
            "files": [
                {
                    "path": "delivered.abc",
                    "absolute_path": str(delivered),
                    "artifact_ref": delivered_ref.model_dump(mode="json"),
                }
            ],
        },
    )
    task_ref = ArtifactRef.for_path(
        owner_kind="agent",
        owner_id="com.mona.musician",
        root=musician_output,
        path=task_file,
        created_by_agent_id="com.mona.musician",
        session_id=key,
    )
    channel._try_append_webui_transcript(
        "chat-musician",
        {
            "event": "file_edit",
            "chat_id": "chat-musician",
            "task_id": "task-abc",
            "edits": [
                {
                    "status": "done",
                    "path": "task.abc",
                    "absolute_path": str(task_file),
                    "artifact_ref": task_ref.model_dump(mode="json"),
                }
            ],
        },
    )

    other_output = get_agent_output_dir(tmp_path, "com.mona.other")
    (other_output / "other.abc").write_text("other", encoding="utf-8")

    def list_artifacts(session_key: str, task_id: str | None = None) -> dict[str, Any]:
        query = {"session_key": session_key}
        if task_id is not None:
            query["task_id"] = task_id
        request = SimpleNamespace(
            headers={"Authorization": "Bearer live"},
            path=f"/api/artifacts?{urlencode(query)}",
        )
        response = channel._handle_artifacts_list(request)
        assert response.status_code == 200
        return json.loads(response.body)

    payload = list_artifacts(key, "task-abc")
    assert {item["path"] for item in payload["files"]} == {
        "delivered.abc",
        "empty",
        "task.abc",
    }
    assert next(item for item in payload["files"] if item["path"] == "empty")["is_dir"] is True
    assert [item["path"] for item in payload["session_files"]] == ["delivered.abc"]
    assert [item["path"] for item in payload["task_files"]] == ["task.abc"]

    shared_payload = list_artifacts(other_session)
    assert {item["path"] for item in shared_payload["files"]} == {
        "delivered.abc",
        "empty",
        "task.abc",
    }
    assert shared_payload["session_files"] == []
    assert shared_payload["task_files"] == []

    other_payload = list_artifacts(other_agent_session)
    assert [item["path"] for item in other_payload["files"]] == ["other.abc"]


def test_artifact_listing_includes_all_entries_and_project_directories(tmp_path) -> None:
    from mona.utils.artifact_listing import list_artifacts, list_project_files

    root = tmp_path / "workspace"
    root.mkdir()
    (root / ".env").write_text("secret", encoding="utf-8")
    (root / "draft.tmp").write_text("temporary", encoding="utf-8")
    (root / "draft.part").write_text("partial", encoding="utf-8")
    (root / "backup~").write_text("backup", encoding="utf-8")
    (root / "img_preview_0123456789ab.json").write_text("{}", encoding="utf-8")
    (root / "visible.txt").write_text("visible", encoding="utf-8")
    for directory_name in (".cache", "empty", "node_modules", "dist", "build", "target"):
        (root / directory_name).mkdir()
    (root / ".cache" / "entry").write_text("hidden", encoding="utf-8")
    (root / "node_modules" / "package.json").write_text("{}", encoding="utf-8")
    (root / "dist" / "bundle.js").write_text("dist", encoding="utf-8")
    (root / "build" / "bundle.js").write_text("build", encoding="utf-8")
    (root / "target" / "binary").write_text("target", encoding="utf-8")

    expected = {
        ".cache",
        ".cache/entry",
        ".env",
        "backup~",
        "build",
        "build/bundle.js",
        "dist",
        "dist/bundle.js",
        "draft.part",
        "draft.tmp",
        "empty",
        "img_preview_0123456789ab.json",
        "node_modules",
        "node_modules/package.json",
        "target",
        "target/binary",
        "visible.txt",
    }
    for result in (list_artifacts(root), list_project_files(root)):
        assert {item.path for item in result.files} == expected
        assert result.truncated is False
        assert next(item for item in result.files if item.path == "empty").is_dir is True
        assert next(item for item in result.files if item.path == "visible.txt").is_dir is False


def test_artifact_listing_shows_symlink_without_following_target(tmp_path) -> None:
    from mona.utils.artifact_listing import list_artifacts, list_project_files

    root = tmp_path / "workspace"
    target = root / "target"
    target.mkdir(parents=True)
    (target / "nested.txt").write_text("nested", encoding="utf-8")
    link = root / "linked-target"
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks are unavailable")

    for result in (list_artifacts(root), list_project_files(root)):
        entries = {item.path: item for item in result.files}
        assert entries["linked-target"].is_dir is True
        assert entries["linked-target"].is_symlink is True
        assert "linked-target/nested.txt" not in entries


def test_artifact_signature_tracks_directory_and_symlink_entries(tmp_path) -> None:
    from mona.utils.artifact_listing import artifact_signature

    root = tmp_path / "workspace"
    root.mkdir()
    before = artifact_signature(root)
    (root / "empty").mkdir()
    after_directory = artifact_signature(root)
    assert after_directory != before

    target = root / "target.txt"
    target.write_text("target", encoding="utf-8")
    link = root / "linked-target"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("file symlinks are unavailable")
    assert artifact_signature(root) != after_directory


def test_artifact_listing_raises_when_root_cannot_be_enumerated(tmp_path) -> None:
    from mona.utils.artifact_listing import list_artifacts, list_project_files

    missing = tmp_path / "missing"
    with pytest.raises(FileNotFoundError):
        list_artifacts(missing)
    with pytest.raises(FileNotFoundError):
        list_project_files(missing)


def test_artifact_listing_marks_total_entry_truncation(monkeypatch, tmp_path) -> None:
    import mona.utils.artifact_listing as artifact_listing

    root = tmp_path / "workspace"
    root.mkdir()
    for name in ("one.txt", "two.txt", "three.txt"):
        (root / name).write_text(name, encoding="utf-8")
    monkeypatch.setattr(artifact_listing, "MAX_ARTIFACT_FILES", 2)

    result = artifact_listing.list_artifacts(root)

    assert len(result.files) == 2
    assert result.truncated is True


def test_artifact_listing_cap_keeps_shallow_entries(monkeypatch, tmp_path) -> None:
    import mona.utils.artifact_listing as artifact_listing

    root = tmp_path / "workspace"
    root.mkdir()
    (root / "root.txt").write_text("root", encoding="utf-8")
    deep = root / "node_modules" / "package" / "dist"
    deep.mkdir(parents=True)
    for index in range(10):
        (deep / f"nested-{index}.js").write_text("nested", encoding="utf-8")
    monkeypatch.setattr(artifact_listing, "MAX_ARTIFACT_FILES", 3)

    result = artifact_listing.list_artifacts(root)

    assert result.truncated is True
    assert "root.txt" in {item.path for item in result.files}


def test_artifact_listing_stops_before_enumerating_deeper_directories(
    monkeypatch, tmp_path
) -> None:
    from pathlib import Path

    import mona.utils.artifact_listing as artifact_listing

    root = tmp_path / "workspace"
    root.mkdir()
    (root / "root.txt").write_text("root", encoding="utf-8")
    shallow = root / "dir-0"
    shallow.mkdir()
    for index in range(10):
        directory = shallow / f"dir-{index}"
        directory.mkdir()
        (directory / "nested.txt").write_text("nested", encoding="utf-8")
    monkeypatch.setattr(artifact_listing, "MAX_ARTIFACT_FILES", 2)

    original_iterdir = Path.iterdir
    enumerated: list[Path] = []

    def counting_iterdir(path: Path):
        enumerated.append(path)
        return original_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", counting_iterdir)
    for scanner in (artifact_listing.list_artifacts, artifact_listing.list_project_files):
        enumerated.clear()
        result = scanner(root)
        assert result.truncated is True
        assert "root.txt" in {item.path for item in result.files}
        assert enumerated == [root.resolve(), shallow.resolve()]


def test_parse_query_extracts_token_and_client_id() -> None:
    query = _parse_query("/?token=secret&client_id=u1")
    assert query.get("token") == ["secret"]
    assert query.get("client_id") == ["u1"]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("plain", "plain"),
        ('{"content": "hi"}', "hi"),
        ('{"text": "there"}', "there"),
        ('{"message": "x"}', "x"),
        ("  ", None),
        ("{}", None),
    ],
)
def test_parse_inbound_payload(raw: str, expected: str | None) -> None:
    assert _parse_inbound_payload(raw) == expected


def test_parse_inbound_invalid_json_falls_back_to_raw_string() -> None:
    assert _parse_inbound_payload("{not json") == "{not json"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('{"content": ""}', None),           # empty string content
        ('{"content": 123}', None),          # non-string content
        ('{"content": "  "}', None),         # whitespace-only content
        ('["hello"]', '["hello"]'),           # JSON array: not a dict, treated as plain text
        ('{"unknown_key": "val"}', None),    # unrecognized key
        ('{"content": null}', None),         # null content
    ],
)
def test_parse_inbound_payload_edge_cases(raw: str, expected: str | None) -> None:
    assert _parse_inbound_payload(raw) == expected


def test_web_socket_config_path_must_start_with_slash() -> None:
    with pytest.raises(ValueError, match='path must start with "/"'):
        WebSocketConfig(path="bad")


def test_ssl_context_requires_both_cert_and_key_files() -> None:
    bus = MagicMock()
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"], "sslCertfile": "/tmp/c.pem", "sslKeyfile": ""},
        bus,
    )
    with pytest.raises(ValueError, match="ssl_certfile and ssl_keyfile"):
        channel._build_ssl_context()


def test_default_config_includes_safe_bind_and_streaming() -> None:
    defaults = WebSocketChannel.default_config()
    assert defaults["enabled"] is False
    assert defaults["host"] == "127.0.0.1"
    assert defaults["streaming"] is True
    assert defaults["allowFrom"] == ["*"]
    assert defaults.get("tokenIssuePath", "") == ""


def test_token_issue_path_must_differ_from_websocket_path() -> None:
    with pytest.raises(ValueError, match="token_issue_path must differ"):
        WebSocketConfig(path="/ws", token_issue_path="/ws")


def test_issue_route_secret_matches_bearer_and_header() -> None:
    from websockets.datastructures import Headers

    secret = "my-secret"
    bearer_headers = Headers([("Authorization", "Bearer my-secret")])
    assert _issue_route_secret_matches(bearer_headers, secret) is True
    x_headers = Headers([("X-mona-Auth", "my-secret")])
    assert _issue_route_secret_matches(x_headers, secret) is True
    wrong = Headers([("Authorization", "Bearer other")])
    assert _issue_route_secret_matches(wrong, secret) is False


def test_issue_route_secret_matches_empty_secret() -> None:
    from websockets.datastructures import Headers

    # Empty secret always returns True regardless of headers
    assert _issue_route_secret_matches(Headers([]), "") is True
    assert _issue_route_secret_matches(Headers([("Authorization", "Bearer anything")]), "") is True


@pytest.mark.asyncio
async def test_webui_message_envelope_marks_inbound_metadata(bus: MagicMock) -> None:
    channel = _ch(bus)
    conn = MagicMock()
    conn.send = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {"type": "message", "chat_id": "chat-1", "content": "hello", "webui": True},
    )

    msg = bus.publish_inbound.await_args.args[0]
    assert msg.channel == "websocket"
    assert msg.chat_id == "chat-1"
    assert msg.metadata["webui"] is True
    assert msg.metadata["_wants_stream"] is True


@pytest.mark.asyncio
async def test_webui_message_envelope_forwards_a_bounded_quote_preview(bus: MagicMock) -> None:
    channel = _ch(bus)
    conn = MagicMock()
    conn.send = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "message",
            "chat_id": "chat-quote",
            "content": "引用 Mona 的消息：\n原消息\n\n请解释",
            "quote": {"author": " Mona  ", "content": " 原消息 "},
            "webui": True,
        },
    )

    msg = bus.publish_inbound.await_args.args[0]
    assert msg.metadata["quote"] == {"author": "Mona", "content": "原消息"}


@pytest.mark.asyncio
async def test_branch_chat_copies_history_through_selected_assistant_turn(
    bus: MagicMock,
    tmp_path,
    monkeypatch,
) -> None:
    from mona.session.manager import SessionManager
    from mona.webui.transcript import read_transcript_lines, write_transcript_objects

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path / "webui")
    sessions = SessionManager(tmp_path / "workspace")
    source = sessions.get_or_create("websocket:source-chat")
    source.metadata.update({"webui": True, "workspace": "D:/work", "title": "原任务"})
    source.messages = [
        {"role": "user", "content": "问题一", "task_id": "task-1"},
        {"role": "assistant", "content": "回答一", "task_id": "task-1"},
        {"role": "user", "content": "问题二", "task_id": "task-2"},
        {"role": "assistant", "content": "回答二", "task_id": "task-2"},
    ]
    sessions.save(source)
    write_transcript_objects("websocket:source-chat", [
        {"event": "user", "chat_id": "source-chat", "text": "问题一", "task_id": "task-1"},
        {"event": "delta", "chat_id": "source-chat", "text": "回答一", "task_id": "task-1"},
        {"event": "stream_end", "chat_id": "source-chat", "task_id": "task-1"},
        {"event": "turn_end", "chat_id": "source-chat", "task_id": "task-1"},
        {"event": "user", "chat_id": "source-chat", "text": "问题二", "task_id": "task-2"},
        {"event": "message", "chat_id": "source-chat", "text": "回答二", "task_id": "task-2"},
    ])
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"], "websocketRequiresToken": False},
        bus,
        session_manager=sessions,
    )
    conn = MagicMock()
    conn.send = AsyncMock()

    await channel._dispatch_envelope(conn, "client", {
        "type": "branch_chat",
        "source_chat_id": "source-chat",
        "source_task_id": "task-1",
        "assistant_ordinal": 1,
    })

    sent = [json.loads(call.args[0]) for call in conn.send.await_args_list]
    attached = next(item for item in sent if item.get("event") == "attached")
    branch_id = attached["chat_id"]
    branched = sessions.get_or_create(f"websocket:{branch_id}")
    assert [message["content"] for message in branched.messages] == ["问题一", "回答一"]
    assert source.messages[-1]["content"] == "回答二"
    assert branched.metadata["title"] == "原任务 · 分支"
    copied = read_transcript_lines(f"websocket:{branch_id}")
    assert [record["event"] for record in copied] == ["user", "delta", "stream_end", "turn_end"]
    assert {record["chat_id"] for record in copied} == {branch_id}


@pytest.mark.asyncio
async def test_profile_advice_origin_is_validated_and_forwarded(bus: MagicMock) -> None:
    channel = _ch(bus)
    conn = MagicMock()
    conn.send = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "message",
            "chat_id": "chat-1",
            "content": "开始这条建议",
            "origin": "profile_advice",
            "profile_advice_id": "advice-1",
            "webui": True,
        },
    )

    msg = bus.publish_inbound.await_args.args[0]
    assert msg.metadata["origin"] == "profile_advice"
    assert msg.metadata["profile_advice_id"] == "advice-1"


@pytest.mark.asyncio
async def test_webui_message_envelope_preserves_active_canvas_id(bus: MagicMock) -> None:
    channel = _ch(bus)
    conn = MagicMock()
    conn.send = AsyncMock()
    conn.remote_address = ("127.0.0.1", 50123)

    await channel._dispatch_envelope(
        conn,
        "webui-client",
        {
            "type": "message",
            "chat_id": "chat-1",
            "content": "修改当前架构图",
            "canvas_id": "canvas-123",
            "webui": True,
        },
    )

    msg = bus.publish_inbound.await_args.args[0]
    assert msg.metadata["canvas_id"] == "canvas-123"


@pytest.mark.asyncio
async def test_plain_websocket_message_does_not_mark_webui(bus: MagicMock) -> None:
    channel = _ch(bus)
    conn = MagicMock()

    await channel._dispatch_envelope(
        conn,
        "custom-client",
        {"type": "message", "chat_id": "chat-1", "content": "hello"},
    )

    msg = bus.publish_inbound.await_args.args[0]
    assert "webui" not in msg.metadata


@pytest.mark.asyncio
async def test_send_delivers_json_message_with_media_and_reply() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    msg = OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="hello",
        reply_to="m1",
        media=["/tmp/a.png"],
        buttons=[["Yes", "No"]],
    )
    await channel.send(msg)

    mock_ws.send.assert_awaited_once()
    payload = json.loads(mock_ws.send.call_args[0][0])
    assert payload["event"] == "message"
    assert payload["chat_id"] == "chat-1"
    assert payload["text"] == "hello"
    assert payload["reply_to"] == "m1"
    assert payload["media"] == ["/tmp/a.png"]


@pytest.mark.asyncio
async def test_send_broadcasts_runtime_model_updates() -> None:
    bus = MessageBus()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    publish_runtime_model_update(bus, "openai/gpt-4.1", "fast")
    await channel.send(bus.outbound.get_nowait())

    payload = json.loads(mock_ws.send.call_args[0][0])
    assert payload["event"] == "runtime_model_updated"
    assert payload["model_name"] == "openai/gpt-4.1"
    assert payload["model_preset"] == "fast"


@pytest.mark.asyncio
async def test_runtime_model_update_publisher_uses_websocket_outbound_event() -> None:
    bus = MessageBus()

    publish_runtime_model_update(
        bus,
        "openai/gpt-4.1",
        "fast",
    )

    event = bus.outbound.get_nowait()
    assert event.channel == "websocket"
    assert event.chat_id == "*"
    assert event.content == ""
    assert event.metadata == {
        "_runtime_model_updated": True,
        "model": "openai/gpt-4.1",
        "model_preset": "fast",
    }


@pytest.mark.asyncio
async def test_send_stages_external_media_as_signed_url(monkeypatch, tmp_path) -> None:
    bus = MagicMock()
    media_root = tmp_path / "media"
    ws_media = media_root / "websocket"
    ws_media.mkdir(parents=True)
    external = tmp_path / "clip.mp4"
    external.write_bytes(b"video")

    def fake_media_dir(channel: str | None = None):
        return ws_media if channel == "websocket" else media_root

    monkeypatch.setattr("mona.channels.websocket.get_media_dir", fake_media_dir)
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(
        OutboundMessage(
            channel="websocket",
            chat_id="chat-1",
            content="video",
            media=[str(external)],
        )
    )

    payload = json.loads(mock_ws.send.call_args[0][0])
    assert payload["media"] == [str(external)]
    assert payload["media_urls"][0]["name"] == "clip.mp4"
    assert payload["media_urls"][0]["url"].startswith("/api/media/")
    assert any(p.name.endswith("-clip.mp4") for p in ws_media.iterdir())


@pytest.mark.asyncio
async def test_send_missing_connection_is_noop_without_error() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    msg = OutboundMessage(channel="websocket", chat_id="missing", content="x")
    await channel.send(msg)


@pytest.mark.asyncio
async def test_send_removes_connection_on_connection_closed() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    mock_ws.send.side_effect = ConnectionClosed(Close(1006, ""), Close(1006, ""), True)
    channel._attach(mock_ws, "chat-1")

    msg = OutboundMessage(channel="websocket", chat_id="chat-1", content="hello")
    await channel.send(msg)

    assert "chat-1" not in channel._subs
    assert mock_ws not in channel._conn_chats


@pytest.mark.asyncio
async def test_send_progress_includes_structured_tool_events() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content='search "hermes"',
        metadata={
            "_progress": True,
            "_tool_hint": True,
            "_tool_events": [
                {
                    "version": 1,
                    "phase": "start",
                    "call_id": "call-1",
                    "name": "web_search",
                    "arguments": {"query": "hermes", "count": 8},
                    "result": None,
                    "error": None,
                    "files": [],
                    "embeds": [],
                }
            ],
        },
    ))

    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload["event"] == "message"
    assert payload["kind"] == "tool_hint"
    assert payload["tool_events"] == [
        {
            "version": 1,
            "phase": "start",
            "call_id": "call-1",
            "name": "web_search",
            "arguments": {"query": "hermes", "count": 8},
            "result": None,
            "error": None,
            "files": [],
            "embeds": [],
        }
    ]


@pytest.mark.asyncio
async def test_send_progress_includes_context_compaction_state() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="正在整理上下文",
        metadata={"_progress": True, "_context_compacting": True},
    ))

    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload["kind"] == "progress"
    assert payload["context_compacting"] is True


@pytest.mark.asyncio
async def test_send_file_edit_progress_uses_file_edit_event() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={
            "_progress": True,
            "_file_edit_events": [
                {
                    "version": 1,
                    "phase": "start",
                    "call_id": "call-1",
                    "tool": "write_file",
                    "path": "src/app.py",
                    "added": 12,
                    "deleted": 2,
                    "approximate": True,
                    "status": "editing",
                }
            ],
        },
    ))

    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload == {
        "event": "file_edit",
        "chat_id": "chat-1",
        "edits": [
            {
                "version": 1,
                "phase": "start",
                "call_id": "call-1",
                "tool": "write_file",
                "path": "src/app.py",
                "added": 12,
                "deleted": 2,
                "approximate": True,
                "status": "editing",
            }
        ],
    }


@pytest.mark.asyncio
async def test_send_progress_includes_agent_ui_blob() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    blob = {
        "kind": "panel",
        "data": {"version": 1, "event": "tick", "id": "r1"},
    }
    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="progress · panel",
        metadata={"_progress": True, OUTBOUND_META_AGENT_UI: blob},
    ))

    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload["event"] == "message"
    assert payload["kind"] == "progress"
    assert payload["agent_ui"] == blob


@pytest.mark.asyncio
async def test_send_delta_removes_connection_on_connection_closed() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"], "streaming": True}, bus)
    mock_ws = AsyncMock()
    mock_ws.send.side_effect = ConnectionClosed(Close(1006, ""), Close(1006, ""), True)
    channel._attach(mock_ws, "chat-1")

    await channel.send_delta("chat-1", "chunk", {"_stream_delta": True, "_stream_id": "s1"})

    assert "chat-1" not in channel._subs
    assert mock_ws not in channel._conn_chats


@pytest.mark.asyncio
async def test_send_delta_emits_delta_and_stream_end() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"], "streaming": True}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send_delta("chat-1", "part", {"_stream_delta": True, "_stream_id": "sid"})
    await channel.send_delta("chat-1", "", {"_stream_end": True, "_stream_id": "sid"})

    assert mock_ws.send.await_count == 2
    first = json.loads(mock_ws.send.call_args_list[0][0][0])
    second = json.loads(mock_ws.send.call_args_list[1][0][0])
    assert first["event"] == "delta"
    assert first["chat_id"] == "chat-1"
    assert first["text"] == "part"
    assert first["stream_id"] == "sid"
    assert second["event"] == "stream_end"
    assert second["chat_id"] == "chat-1"
    assert second["stream_id"] == "sid"


@pytest.mark.asyncio
async def test_send_reasoning_delta_emits_streaming_frame() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send_reasoning_delta(
        "chat-1",
        "step-by-step thinking",
        {"_reasoning_delta": True, "_stream_id": "r1"},
    )

    mock_ws.send.assert_awaited_once()
    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload["event"] == "reasoning_delta"
    assert payload["chat_id"] == "chat-1"
    assert payload["text"] == "step-by-step thinking"
    assert payload["stream_id"] == "r1"


@pytest.mark.asyncio
async def test_send_reasoning_end_emits_close_frame() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send_reasoning_end("chat-1", {"_reasoning_end": True, "_stream_id": "r1"})

    payload = json.loads(mock_ws.send.await_args.args[0])
    assert payload == {"event": "reasoning_end", "chat_id": "chat-1", "stream_id": "r1"}


@pytest.mark.asyncio
async def test_send_reasoning_one_shot_expands_to_delta_plus_end() -> None:
    """``send_reasoning`` is back-compat for hooks that haven't migrated:
    the base implementation must produce one delta and one end so the
    WebUI sees the same shape either way."""
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send_reasoning(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="thinking",
        metadata={"_reasoning": True},
    ))

    assert mock_ws.send.await_count == 2
    first = json.loads(mock_ws.send.call_args_list[0][0][0])
    second = json.loads(mock_ws.send.call_args_list[1][0][0])
    assert first["event"] == "reasoning_delta"
    assert first["text"] == "thinking"
    assert second["event"] == "reasoning_end"


@pytest.mark.asyncio
async def test_send_reasoning_delta_drops_empty_chunks() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send_reasoning_delta("chat-1", "", {"_reasoning_delta": True})

    mock_ws.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_reasoning_without_subscribers_is_noop() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)

    await channel.send_reasoning_delta("unattached", "thinking", None)
    await channel.send_reasoning_end("unattached", None)
    # No subscribers, no exception, no send.


@pytest.mark.asyncio
async def test_send_turn_end_emits_turn_end_event() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_turn_end": True},
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "turn_end", "chat_id": "chat-1"}


@pytest.mark.asyncio
async def test_send_turn_end_includes_latency_ms_when_present() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_turn_end": True, "latency_ms": 1500},
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "turn_end", "chat_id": "chat-1", "latency_ms": 1500}


@pytest.mark.asyncio
async def test_send_turn_end_includes_task_and_token_usage() -> None:
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, MagicMock())
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    usage = {"prompt_tokens": 100, "completion_tokens": 25, "total_tokens": 125}

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_turn_end": True, "task_id": "task-1", "token_usage": usage},
    ))

    body = json.loads(mock_ws.send.await_args.args[0])
    assert body["task_id"] == "task-1"
    assert body["token_usage"] == usage


@pytest.mark.asyncio
async def test_send_turn_end_includes_goal_state_when_present() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    blob = {"active": True, "ui_summary": "Explore codebase"}
    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_turn_end": True, "goal_state": blob},
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "turn_end", "chat_id": "chat-1", "goal_state": blob}


@pytest.mark.asyncio
async def test_send_goal_status_running_emits_event_with_started_at() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={
            "_goal_status": True,
            "goal_status": "running",
            "started_at": 1_700_000_000.5,
        },
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {
        "event": "goal_status",
        "chat_id": "chat-1",
        "status": "running",
        "started_at": 1_700_000_000.5,
    }


@pytest.mark.asyncio
async def test_send_goal_status_idle_omits_started_at() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={
            "_goal_status": True,
            "goal_status": "idle",
            "goal_started_at": 99.0,
        },
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "goal_status", "chat_id": "chat-1", "status": "idle"}


@pytest.mark.asyncio
async def test_send_goal_state_emits_blob_per_chat() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_a = AsyncMock()
    mock_b = AsyncMock()
    channel._attach(mock_a, "chat-a")
    channel._attach(mock_b, "chat-b")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-a",
        content="",
        metadata={
            "_goal_state_sync": True,
            "goal_state": {"active": True, "ui_summary": "A"},
        },
    ))

    mock_a.send.assert_awaited_once()
    mock_b.send.assert_not_called()
    body = json.loads(mock_a.send.await_args.args[0])
    assert body == {
        "event": "goal_state",
        "chat_id": "chat-a",
        "goal_state": {"active": True, "ui_summary": "A"},
    }


@pytest.mark.asyncio
async def test_maybe_push_active_goal_state_noop_without_session_manager() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    channel._session_manager = None
    await channel._maybe_push_active_goal_state("chat-1")
    mock_ws.send.assert_not_called()


@pytest.mark.asyncio
async def test_maybe_push_active_goal_state_clears_when_no_goal_on_disk() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    sm = MagicMock()
    sm.read_session_file.return_value = None
    channel._session_manager = sm
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    await channel._maybe_push_active_goal_state("chat-1")
    mock_ws.send.assert_awaited_once()
    assert json.loads(mock_ws.send.await_args.args[0])["goal_state"] == {"active": False}


@pytest.mark.asyncio
async def test_maybe_push_active_goal_state_notifies_when_goal_active_on_disk() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    sm = MagicMock()
    sm.read_session_file.return_value = {
        "metadata": {
            "goal_state": {
                "status": "active",
                "source": "/goal",
                "objective": "finish docs",
                "ui_summary": "Docs",
            },
        },
        "messages": [],
    }
    channel._session_manager = sm
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    await channel._maybe_push_active_goal_state("chat-1")
    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body["event"] == "goal_state"
    assert body["chat_id"] == "chat-1"
    assert body["goal_state"]["active"] is True
    assert body["goal_state"]["objective"] == "finish docs"
    assert body["goal_state"]["ui_summary"] == "Docs"


@pytest.mark.asyncio
async def test_maybe_push_active_goal_state_clears_legacy_unsourced_goal() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    sm = MagicMock()
    sm.read_session_file.return_value = {
        "metadata": {
            "goal_state": {
                "status": "active",
                "objective": "stale automatic goal",
            },
        },
        "messages": [],
    }
    channel._session_manager = sm
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel._maybe_push_active_goal_state("chat-1")

    assert json.loads(mock_ws.send.await_args.args[0])["goal_state"] == {"active": False}


@pytest.mark.asyncio
async def test_maybe_push_turn_run_wall_clock_skips_when_no_active_turn() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    from mona.session import webui_turns as wth

    wth._WEBSOCKET_TURN_WALL_STARTED_AT.clear()
    await channel._maybe_push_turn_run_wall_clock("chat-1")
    mock_ws.send.assert_not_called()


@pytest.mark.asyncio
async def test_maybe_push_turn_run_wall_clock_replays_running() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")
    from mona.session import webui_turns as wth

    wth._WEBSOCKET_TURN_WALL_STARTED_AT.clear()
    try:
        wth._WEBSOCKET_TURN_WALL_STARTED_AT["chat-1"] = 1_700_000_000.0
        await channel._maybe_push_turn_run_wall_clock("chat-1")
    finally:
        wth._WEBSOCKET_TURN_WALL_STARTED_AT.pop("chat-1", None)

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {
        "event": "goal_status",
        "chat_id": "chat-1",
        "status": "running",
        "started_at": 1_700_000_000.0,
    }


@pytest.mark.asyncio
async def test_send_session_updated_emits_session_updated_event() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_session_updated": True},
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "session_updated", "chat_id": "chat-1"}


@pytest.mark.asyncio
async def test_send_session_updated_includes_scope_when_present() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    channel._attach(mock_ws, "chat-1")

    await channel.send(OutboundMessage(
        channel="websocket",
        chat_id="chat-1",
        content="",
        metadata={"_session_updated": True, "_session_update_scope": "metadata"},
    ))

    mock_ws.send.assert_awaited_once()
    body = json.loads(mock_ws.send.await_args.args[0])
    assert body == {"event": "session_updated", "chat_id": "chat-1", "scope": "metadata"}


@pytest.mark.asyncio
async def test_send_non_connection_closed_exception_is_raised() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    mock_ws = AsyncMock()
    mock_ws.send.side_effect = RuntimeError("unexpected")
    channel._attach(mock_ws, "chat-1")

    msg = OutboundMessage(channel="websocket", chat_id="chat-1", content="hello")
    with pytest.raises(RuntimeError, match="unexpected"):
        await channel.send(msg)


@pytest.mark.asyncio
async def test_send_delta_missing_connection_is_noop() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"], "streaming": True}, bus)
    # No exception, no error — just a no-op
    await channel.send_delta("nonexistent", "chunk", {"_stream_delta": True, "_stream_id": "s1"})


@pytest.mark.asyncio
async def test_stop_is_idempotent() -> None:
    bus = MagicMock()
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, bus)
    # stop() before start() should not raise
    await channel.stop()
    await channel.stop()


@pytest.mark.asyncio
async def test_end_to_end_client_receives_ready_and_agent_sees_inbound(bus: MagicMock) -> None:
    port = 29876
    channel = _ch(bus, port=port)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=tester") as client:
            ready_raw = await client.recv()
            ready = json.loads(ready_raw)
            assert ready["event"] == "ready"
            assert ready["client_id"] == "tester"
            chat_id = ready["chat_id"]

            await client.send(json.dumps({"content": "ping from client"}))
            await asyncio.sleep(0.08)

            bus.publish_inbound.assert_awaited()
            inbound = bus.publish_inbound.call_args[0][0]
            assert inbound.channel == "websocket"
            assert inbound.sender_id == "tester"
            assert inbound.chat_id == chat_id
            assert inbound.content == "ping from client"

            await client.send("plain text frame")
            await asyncio.sleep(0.08)
            assert bus.publish_inbound.await_count >= 2
            second = [c[0][0] for c in bus.publish_inbound.call_args_list][-1]
            assert second.content == "plain text frame"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_token_rejects_handshake_when_mismatch(bus: MagicMock) -> None:
    port = 29877
    channel = _ch(bus, port=port, path="/", token="secret")

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        with pytest.raises(websockets.exceptions.InvalidStatus) as excinfo:
            async with websockets.connect(f"ws://127.0.0.1:{port}/?token=wrong"):
                pass
        assert excinfo.value.response.status_code == 401
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_wrong_path_returns_404(bus: MagicMock) -> None:
    port = 29878
    channel = _ch(bus, port=port)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        with pytest.raises(websockets.exceptions.InvalidStatus) as excinfo:
            async with websockets.connect(f"ws://127.0.0.1:{port}/other"):
                pass
        assert excinfo.value.response.status_code == 404
    finally:
        await channel.stop()
        await server_task


def test_registry_discovers_websocket_channel() -> None:
    from mona.channels.registry import load_channel_class

    cls = load_channel_class("websocket")
    assert cls.name == "websocket"


@pytest.mark.asyncio
async def test_http_route_issues_token_then_websocket_requires_it(bus: MagicMock) -> None:
    port = 29879
    channel = _ch(
        bus, port=port,
        tokenIssuePath="/auth/token",
        tokenIssueSecret="route-secret",
        websocketRequiresToken=True,
    )

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        deny = await _http_get(f"http://127.0.0.1:{port}/auth/token")
        assert deny.status_code == 401

        issue = await _http_get(
            f"http://127.0.0.1:{port}/auth/token",
            headers={"Authorization": "Bearer route-secret"},
        )
        assert issue.status_code == 200
        token = issue.json()["token"]
        assert token.startswith("nbwt_")

        with pytest.raises(websockets.exceptions.InvalidStatus) as missing_token:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=x"):
                pass
        assert missing_token.value.response.status_code == 401

        uri = f"ws://127.0.0.1:{port}/ws?token={token}&client_id=caller"
        async with websockets.connect(uri) as client:
            ready = json.loads(await client.recv())
            assert ready["event"] == "ready"
            assert ready["client_id"] == "caller"

        with pytest.raises(websockets.exceptions.InvalidStatus) as reuse:
            async with websockets.connect(uri):
                pass
        assert reuse.value.response.status_code == 401
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_settings_api_returns_safe_subset_and_updates_whitelist(
    bus: MagicMock,
    monkeypatch,
    tmp_path,
) -> None:
    port = 29891
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.model = "openai/gpt-4o"
    config.providers.openai.api_key = "secret-key"
    config.model_presets["deep"] = ModelPresetConfig(
        model="anthropic/claude-opus-4-5",
        provider="anthropic",
        reasoning_effort="high",
    )
    config.tools.web.search.provider = "brave"
    config.tools.web.search.api_key = "brave-secret"
    save_config(config, config_path)
    monkeypatch.setattr("mona.config.loader._current_config_path", config_path)

    channel = _ch(bus, port=port)
    channel._api_tokens["tok"] = time.monotonic() + 300

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        settings = await _http_get(
            f"http://127.0.0.1:{port}/api/settings",
            headers={"Authorization": "Bearer tok"},
        )
        assert settings.status_code == 200
        body = settings.json()
        assert body["agent"]["model"] == "openai/gpt-4o"
        assert body["agent"]["provider"] == "openai"
        assert body["agent"]["model_preset"] == "default"
        assert body["agent"]["max_tokens"] == 8192
        assert body["agent"]["timezone"] == "UTC"
        assert body["agent"]["tool_hint_max_length"] == 40
        presets = {preset["name"]: preset for preset in body["model_presets"]}
        assert presets["default"]["active"] is True
        assert presets["deep"]["reasoning_effort"] == "high"
        providers = {provider["name"]: provider for provider in body["providers"]}
        assert providers["openai"]["configured"] is True
        assert providers["openai"]["api_key_hint"] == "secr••••-key"
        assert providers["azure_openai"]["api_key_required"] is True
        assert providers["openrouter"]["configured"] is False
        assert providers["openrouter"]["api_key_required"] is True
        assert providers["skywork"]["label"] == "Skywork"
        assert providers["skywork"]["default_api_base"] == "https://api.apifree.ai/agent/v1"
        assert providers["ant_ling"]["label"] == "Ant Ling"
        assert providers["ant_ling"]["default_api_base"] == "https://api.ant-ling.com/v1"
        assert providers["atomic_chat"]["configured"] is False
        assert providers["atomic_chat"]["api_key_required"] is False
        assert providers["atomic_chat"]["default_api_base"] == "http://localhost:1337/v1"
        assert body["agent"]["has_api_key"] is True
        assert body["web_search"]["provider"] == "brave"
        assert body["web_search"]["api_key_hint"] == "brav••••cret"
        assert body["web_search"]["max_results"] == 5
        assert body["web"]["fetch"]["use_jina_reader"] is True
        search_providers = {provider["name"]: provider for provider in body["web_search"]["providers"]}
        assert search_providers["duckduckgo"]["credential"] == "none"
        assert search_providers["searxng"]["credential"] == "base_url"
        assert body["image_generation"]["enabled"] is False
        assert body["image_generation"]["provider"] == "openrouter"
        assert body["image_generation"]["provider_configured"] is False
        assert body["image_generation"]["default_aspect_ratio"] == "1:1"
        image_providers = {
            provider["name"]: provider
            for provider in body["image_generation"]["providers"]
        }
        assert image_providers["openrouter"]["label"] == "OpenRouter"
        assert image_providers["openrouter"]["configured"] is False
        assert image_providers["openai_codex"]["configured"] is True
        assert image_providers["gemini"]["label"] == "Gemini"
        assert body["runtime"]["config_path"] == str(config_path)
        workspace_path = body["runtime"]["workspace_path"].replace("\\", "/")
        assert workspace_path.endswith("/.mona/workspace")
        assert body["runtime"]["gateway_port"] == 18790
        assert body["advanced"]["exec_enabled"] is True
        assert body["advanced"]["mcp_server_count"] == 0
        assert body["restart_required_sections"] == []
        assert "secret-key" not in settings.text
        assert "brave-secret" not in settings.text

        provider_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/provider/update?provider=openrouter"
            "&api_key=sk-or-test&api_base=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1",
            headers={"Authorization": "Bearer tok"},
        )
        assert provider_updated.status_code == 200
        provider_body = provider_updated.json()
        assert provider_body["requires_restart"] is False
        provider_rows = {provider["name"]: provider for provider in provider_body["providers"]}
        assert provider_rows["openrouter"]["configured"] is True
        assert provider_body["image_generation"]["provider_configured"] is True
        assert "sk-or-test" not in provider_updated.text

        local_provider_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/provider/update?provider=atomic_chat"
            "&api_base=http%3A%2F%2Flocalhost%3A1337%2Fv1",
            headers={"Authorization": "Bearer tok"},
        )
        assert local_provider_updated.status_code == 200
        local_provider_body = local_provider_updated.json()
        local_provider_rows = {
            provider["name"]: provider for provider in local_provider_body["providers"]
        }
        assert local_provider_rows["atomic_chat"]["configured"] is True
        assert "localhost:1337" in local_provider_updated.text

        updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/update?model=atomic_chat/test"
            "&provider=atomic_chat&timezone=Asia%2FShanghai"
            "&bot_name=Nano&bot_icon=N&tool_hint_max_length=120",
            headers={"Authorization": "Bearer tok"},
        )
        assert updated.status_code == 200
        updated_body = updated.json()
        assert updated_body["requires_restart"] is True
        assert updated_body["restart_required_sections"] == ["runtime"]

        preset_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/update?model_preset=deep",
            headers={"Authorization": "Bearer tok"},
        )
        assert preset_updated.status_code == 200
        assert preset_updated.json()["agent"]["model"] == "anthropic/claude-opus-4-5"

        bad_preset = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/update?model_preset=missing",
            headers={"Authorization": "Bearer tok"},
        )
        assert bad_preset.status_code == 400

        search_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/web-search/update?provider=searxng"
            "&base_url=https%3A%2F%2Fsearch.example.com"
            "&max_results=8&timeout=45&use_jina_reader=false",
            headers={"Authorization": "Bearer tok"},
        )
        assert search_updated.status_code == 200
        search_body = search_updated.json()
        assert search_body["requires_restart"] is True
        assert search_body["restart_required_sections"] == ["runtime", "web"]
        assert search_body["web_search"]["provider"] == "searxng"
        assert search_body["web_search"]["api_key_hint"] is None
        assert search_body["web_search"]["base_url"] == "https://search.example.com"
        assert search_body["web_search"]["max_results"] == 8
        assert search_body["web"]["fetch"]["use_jina_reader"] is False

        image_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/image-generation/update?enabled=true"
            "&provider=openrouter&model=openai%2Fgpt-image-1"
            "&default_aspect_ratio=16%3A9&default_image_size=2K"
            "&max_images_per_turn=3",
            headers={"Authorization": "Bearer tok"},
        )
        assert image_updated.status_code == 200
        image_body = image_updated.json()
        assert image_body["requires_restart"] is True
        assert image_body["restart_required_sections"] == ["image", "runtime", "web"]
        assert image_body["image_generation"]["enabled"] is True
        assert image_body["image_generation"]["model"] == "openai/gpt-image-1"
        assert image_body["image_generation"]["default_aspect_ratio"] == "16:9"
        assert image_body["image_generation"]["default_image_size"] == "2K"
        assert image_body["image_generation"]["max_images_per_turn"] == 3

        image_provider_updated = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/provider/update?provider=openrouter"
            "&api_key=sk-or-next&api_base=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1",
            headers={"Authorization": "Bearer tok"},
        )
        assert image_provider_updated.status_code == 200
        assert image_provider_updated.json()["requires_restart"] is True
        assert image_provider_updated.json()["restart_required_sections"] == [
            "image",
            "runtime",
            "web",
        ]
        assert "sk-or-next" not in image_provider_updated.text

        bad_web = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/web-search/update?provider=duckduckgo&max_results=99",
            headers={"Authorization": "Bearer tok"},
        )
        assert bad_web.status_code == 400

        bad_image = await _http_get(
            "http://127.0.0.1:"
            f"{port}/api/settings/image-generation/update?provider=missing",
            headers={"Authorization": "Bearer tok"},
        )
        assert bad_image.status_code == 400

        saved = load_config(config_path)
        assert saved.agents.defaults.model == "atomic_chat/test"
        assert saved.agents.defaults.provider == "atomic_chat"
        assert saved.agents.defaults.model_preset == "deep"
        assert saved.agents.defaults.timezone == "Asia/Shanghai"
        assert saved.agents.defaults.bot_name == "Nano"
        assert saved.agents.defaults.bot_icon == "N"
        assert saved.agents.defaults.tool_hint_max_length == 120
        assert saved.providers.openrouter.api_key == "sk-or-next"
        assert saved.providers.openrouter.api_base == "https://openrouter.ai/api/v1"
        assert saved.providers.atomic_chat.api_base == "http://localhost:1337/v1"
        assert saved.tools.web.search.provider == "searxng"
        assert saved.tools.web.search.api_key == ""
        assert saved.tools.web.search.base_url == "https://search.example.com"
        assert saved.tools.web.search.max_results == 8
        assert saved.tools.web.search.timeout == 45
        assert saved.tools.web.fetch.use_jina_reader is False
        assert saved.tools.image_generation.enabled is True
        assert saved.tools.image_generation.provider == "openrouter"
        assert saved.tools.image_generation.model == "openai/gpt-image-1"
        assert saved.tools.image_generation.default_aspect_ratio == "16:9"
        assert saved.tools.image_generation.default_image_size == "2K"
        assert saved.tools.image_generation.max_images_per_turn == 3
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_commands_api_returns_slash_command_metadata(bus: MagicMock) -> None:
    port = 29892
    channel = _ch(bus, port=port)
    channel._api_tokens["tok"] = time.monotonic() + 300

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        denied = await _http_get(f"http://127.0.0.1:{port}/api/commands")
        assert denied.status_code == 401

        response = await _http_get(
            f"http://127.0.0.1:{port}/api/commands",
            headers={"Authorization": "Bearer tok"},
        )
        assert response.status_code == 200
        body = response.json()
        commands = {row["command"]: row for row in body["commands"]}
        assert commands["/stop"]["title"] == "Stop current task"
        assert commands["/history"]["arg_hint"] == "[n]"
        assert all("description" in row for row in body["commands"])
    finally:
        await channel.stop()
        await server_task


def test_settings_payload_normalizes_camel_case_provider(
    bus: MagicMock,
    monkeypatch,
    tmp_path,
) -> None:
    config_path = tmp_path / "config.json"
    config = Config()
    config.agents.defaults.provider = "minimaxAnthropic"
    save_config(config, config_path)
    monkeypatch.setattr("mona.config.loader._current_config_path", config_path)

    body = settings_payload()

    assert body["agent"]["provider"] == "minimax_anthropic"


@pytest.mark.asyncio
async def test_end_to_end_server_pushes_streaming_deltas_to_client(bus: MagicMock) -> None:
    port = 29880
    channel = _ch(bus, port=port, streaming=True)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=stream-tester") as client:
            ready_raw = await client.recv()
            ready = json.loads(ready_raw)
            chat_id = ready["chat_id"]

            # Server pushes deltas directly
            await channel.send_delta(
                chat_id, "Hello ", {"_stream_delta": True, "_stream_id": "s1"}
            )
            await channel.send_delta(
                chat_id, "world", {"_stream_delta": True, "_stream_id": "s1"}
            )
            await channel.send_delta(
                chat_id, "", {"_stream_end": True, "_stream_id": "s1"}
            )

            delta1 = json.loads(await client.recv())
            assert delta1["event"] == "delta"
            assert delta1["text"] == "Hello "
            assert delta1["stream_id"] == "s1"

            delta2 = json.loads(await client.recv())
            assert delta2["event"] == "delta"
            assert delta2["text"] == "world"
            assert delta2["stream_id"] == "s1"

            end = json.loads(await client.recv())
            assert end["event"] == "stream_end"
            assert end["stream_id"] == "s1"

            await channel.send(OutboundMessage(
                channel="websocket",
                chat_id=chat_id,
                content="",
                metadata={"_turn_end": True},
            ))

            turn_end = json.loads(await client.recv())
            assert turn_end == {"event": "turn_end", "chat_id": chat_id}
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_token_issue_rejects_when_at_capacity(bus: MagicMock) -> None:
    port = 29881
    channel = _ch(bus, port=port, tokenIssuePath="/auth/token", tokenIssueSecret="s")

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        # Fill issued tokens to capacity
        channel._issued_tokens = {
            f"nbwt_fill_{i}": time.monotonic() + 300 for i in range(channel._MAX_ISSUED_TOKENS)
        }

        resp = await _http_get(
            f"http://127.0.0.1:{port}/auth/token",
            headers={"Authorization": "Bearer s"},
        )
        assert resp.status_code == 429
        data = resp.json()
        assert "error" in data
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_allow_from_rejects_unauthorized_client_id(bus: MagicMock) -> None:
    port = 29882
    channel = _ch(bus, port=port, allowFrom=["alice", "bob"])

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        with pytest.raises(websockets.exceptions.InvalidStatus) as exc_info:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=eve"):
                pass
        assert exc_info.value.response.status_code == 403
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_client_id_truncation(bus: MagicMock) -> None:
    port = 29883
    channel = _ch(bus, port=port)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        long_id = "x" * 200
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id={long_id}") as client:
            ready = json.loads(await client.recv())
            assert ready["client_id"] == "x" * 128
            assert len(ready["client_id"]) == 128
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_non_utf8_binary_frame_ignored(bus: MagicMock) -> None:
    port = 29884
    channel = _ch(bus, port=port)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=bin-test") as client:
            await client.recv()  # consume ready
            # Send non-UTF-8 bytes
            await client.send(b"\xff\xfe\xfd")
            await asyncio.sleep(0.05)
            # publish_inbound should NOT have been called
            bus.publish_inbound.assert_not_awaited()
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_static_token_accepts_issued_token_as_fallback(bus: MagicMock) -> None:
    port = 29885
    channel = _ch(
        bus, port=port,
        token="static-secret",
        tokenIssuePath="/auth/token",
        tokenIssueSecret="route-secret",
    )

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        # Get an issued token
        resp = await _http_get(
            f"http://127.0.0.1:{port}/auth/token",
            headers={"Authorization": "Bearer route-secret"},
        )
        assert resp.status_code == 200
        issued_token = resp.json()["token"]

        # Connect using issued token (not the static one)
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?token={issued_token}&client_id=caller") as client:
            ready = json.loads(await client.recv())
            assert ready["event"] == "ready"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_allow_from_empty_list_denies_all(bus: MagicMock) -> None:
    port = 29886
    channel = _ch(bus, port=port, allowFrom=[])

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        with pytest.raises(websockets.exceptions.InvalidStatus) as exc_info:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=anyone"):
                pass
        assert exc_info.value.response.status_code == 403
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_websocket_requires_token_without_issue_path(bus: MagicMock) -> None:
    """When websocket_requires_token is True but no token or issue path configured, all connections are rejected."""
    port = 29887
    channel = _ch(bus, port=port, websocketRequiresToken=True)

    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        # No token at all → 401
        with pytest.raises(websockets.exceptions.InvalidStatus) as exc_info:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=u"):
                pass
        assert exc_info.value.response.status_code == 401

        # Wrong token → 401
        with pytest.raises(websockets.exceptions.InvalidStatus) as exc_info:
            async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=u&token=wrong"):
                pass
        assert exc_info.value.response.status_code == 401
    finally:
        await channel.stop()
        await server_task


# -- Multi-chat multiplexing -------------------------------------------------
#
# The multiplex protocol lets one WS connection route N logical chats over
# typed envelopes (`new_chat` / `attach` / `message`). Legacy frames must keep
# working on the connection's default chat_id.


@pytest.mark.asyncio
async def test_multiplex_legacy_still_works(bus: MagicMock) -> None:
    port = 29930
    channel = _ch(bus, port=port)
    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=legacy") as client:
            ready = json.loads(await client.recv())
            default_chat = ready["chat_id"]

            # Plain text frame routes to default chat_id
            await client.send("hello from legacy")
            await asyncio.sleep(0.1)
            inbound = bus.publish_inbound.call_args[0][0]
            assert inbound.chat_id == default_chat
            assert inbound.content == "hello from legacy"

            # {"content": ...} frame routes to default chat_id
            await client.send(json.dumps({"content": "structured legacy"}))
            await asyncio.sleep(0.1)
            assert bus.publish_inbound.call_args[0][0].chat_id == default_chat
            assert bus.publish_inbound.call_args[0][0].content == "structured legacy"

            # Outbound still reaches the legacy client, with chat_id annotated
            await channel.send(
                OutboundMessage(channel="websocket", chat_id=default_chat, content="reply")
            )
            reply = json.loads(await client.recv())
            assert reply["event"] == "message"
            assert reply["chat_id"] == default_chat
            assert reply["text"] == "reply"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_multiplex_new_chat_roundtrip(bus: MagicMock) -> None:
    port = 29931
    channel = _ch(bus, port=port)
    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=mp") as client:
            ready = json.loads(await client.recv())
            default_chat = ready["chat_id"]

            await client.send(json.dumps({"type": "new_chat"}))
            attached = json.loads(await client.recv())
            assert attached["event"] == "attached"
            new_chat = attached["chat_id"]
            assert new_chat and new_chat != default_chat

            # Send on the new chat via typed envelope
            await client.send(
                json.dumps({"type": "message", "chat_id": new_chat, "content": "hi on new"})
            )
            await asyncio.sleep(0.1)
            inbound = bus.publish_inbound.call_args[0][0]
            assert inbound.chat_id == new_chat
            assert inbound.content == "hi on new"

            # Server pushes a message back; chat_id must match
            await channel.send(
                OutboundMessage(channel="websocket", chat_id=new_chat, content="ok")
            )
            reply = json.loads(await client.recv())
            assert reply["event"] == "message"
            assert reply["chat_id"] == new_chat
            assert reply["text"] == "ok"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_multiplex_two_chats_isolated(bus: MagicMock) -> None:
    port = 29932
    channel = _ch(bus, port=port)
    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=two") as client:
            await client.recv()  # ready

            await client.send(json.dumps({"type": "new_chat"}))
            chat_a = json.loads(await client.recv())["chat_id"]
            await client.send(json.dumps({"type": "new_chat"}))
            chat_b = json.loads(await client.recv())["chat_id"]
            assert chat_a != chat_b

            # Push A → client sees A only (FIFO over the single WS).
            await channel.send(
                OutboundMessage(channel="websocket", chat_id=chat_a, content="for-A")
            )
            msg_a = json.loads(await client.recv())
            assert msg_a["chat_id"] == chat_a
            assert msg_a["text"] == "for-A"

            # Push B → client sees B only.
            await channel.send(
                OutboundMessage(channel="websocket", chat_id=chat_b, content="for-B")
            )
            msg_b = json.loads(await client.recv())
            assert msg_b["chat_id"] == chat_b
            assert msg_b["text"] == "for-B"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_multiplex_invalid_frames_return_error(bus: MagicMock) -> None:
    port = 29933
    channel = _ch(bus, port=port)
    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=bad") as client:
            await client.recv()  # ready

            # attach with bad chat_id
            await client.send(json.dumps({"type": "attach", "chat_id": "has space"}))
            err1 = json.loads(await client.recv())
            assert err1["event"] == "error"

            # message with missing content
            await client.send(json.dumps({"type": "message", "chat_id": "abc", "content": ""}))
            err2 = json.loads(await client.recv())
            assert err2["event"] == "error"

            # unknown type
            await client.send(json.dumps({"type": "nope"}))
            err3 = json.loads(await client.recv())
            assert err3["event"] == "error"

            # Connection survives: legacy frame still works.
            await client.send("still-alive")
            await asyncio.sleep(0.1)
            bus.publish_inbound.assert_awaited()
            assert bus.publish_inbound.call_args[0][0].content == "still-alive"
    finally:
        await channel.stop()
        await server_task


@pytest.mark.asyncio
async def test_multiplex_cleanup_on_disconnect(bus: MagicMock) -> None:
    port = 29934
    channel = _ch(bus, port=port)
    server_task = asyncio.create_task(channel.start())
    await asyncio.sleep(0.3)

    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/ws?client_id=dc") as client:
            ready = json.loads(await client.recv())
            default_chat = ready["chat_id"]
            await client.send(json.dumps({"type": "new_chat"}))
            extra_chat = json.loads(await client.recv())["chat_id"]
            assert default_chat in channel._subs
            assert extra_chat in channel._subs
        # Client gone. Server-side tracking must be empty.
        await asyncio.sleep(0.2)
        assert default_chat not in channel._subs
        assert extra_chat not in channel._subs
        assert not channel._conn_chats
        assert not channel._conn_default
    finally:
        await channel.stop()
        await server_task


def test_parse_envelope_detects_typed_frames() -> None:
    assert _parse_envelope('{"type":"new_chat"}') == {"type": "new_chat"}
    env = _parse_envelope('{"type":"message","chat_id":"abc","content":"hi"}')
    assert env == {"type": "message", "chat_id": "abc", "content": "hi"}


def test_parse_envelope_rejects_legacy_and_garbage() -> None:
    # No `type` field → legacy, caller falls back to _parse_inbound_payload.
    assert _parse_envelope('{"content":"hi"}') is None
    assert _parse_envelope("plain text") is None
    assert _parse_envelope("{broken") is None
    assert _parse_envelope("[1,2,3]") is None
    # Non-string `type` is not a valid envelope.
    assert _parse_envelope('{"type":123}') is None


def test_sessions_list_includes_active_run_started_at() -> None:
    from websockets.datastructures import Headers
    from websockets.http11 import Request

    from mona.session import webui_turns as wth

    bus = MagicMock()
    channel = _ch(bus)
    channel._api_tokens["tok"] = time.monotonic() + 300.0
    channel._session_manager = MagicMock()
    channel._session_manager.list_sessions.return_value = [
        {
            "key": "websocket:chat-1",
            "created_at": "2026-05-19T10:00:00Z",
            "updated_at": "2026-05-19T10:01:00Z",
            "title": "Running",
            "preview": "work",
            "path": "/private/path",
        },
        {
            "key": "cli:chat-2",
            "created_at": "2026-05-19T10:00:00Z",
            "updated_at": "2026-05-19T10:01:00Z",
        },
    ]

    wth._WEBSOCKET_TURN_WALL_STARTED_AT.clear()
    try:
        wth._WEBSOCKET_TURN_WALL_STARTED_AT["chat-1"] = 1_700_000_000.0
        req = Request("/api/sessions", Headers([("Authorization", "Bearer tok")]))
        resp = channel._handle_sessions_list(req)
    finally:
        wth._WEBSOCKET_TURN_WALL_STARTED_AT.clear()

    assert resp.status_code == 200
    body = json.loads(resp.body.decode())
    assert body["sessions"] == [
        {
            "key": "websocket:chat-1",
            "created_at": "2026-05-19T10:00:00Z",
            "updated_at": "2026-05-19T10:01:00Z",
            "title": "Running",
            "preview": "work",
            "run_started_at": 1_700_000_000.0,
            # IM list attention fields (IM plan 12.1): non-room sessions carry
            # empty workflow state.
            "workflow_run_status": None,
            "waiting_approval": False,
            "scheduled": False,
        }
    ]


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("abc", True),
        ("a1b2_c:d-e", True),
        ("x" * 64, True),
        ("unified:default", True),
        ("", False),
        ("x" * 65, False),
        ("has space", False),
        ("a/b", False),
        ("a.b", False),
        (None, False),
        (123, False),
    ],
)
def test_is_valid_chat_id(value: Any, expected: bool) -> None:
    assert _is_valid_chat_id(value) is expected


def test_handle_webui_thread_get_returns_json(tmp_path, monkeypatch) -> None:
    from urllib.parse import quote

    from websockets.datastructures import Headers
    from websockets.http11 import Request

    from mona.webui.transcript import append_transcript_object

    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path)
    key = "websocket:c1"
    append_transcript_object(key, {"event": "user", "chat_id": "c1", "text": "hi"})
    bus = MagicMock()
    channel = _ch(bus)
    channel._api_tokens["tok"] = time.monotonic() + 300.0
    enc = quote(key, safe="")
    req = Request(f"/api/sessions/{enc}/webui-thread", Headers([("Authorization", "Bearer tok")]))
    resp = channel._handle_webui_thread_get(req, enc)
    assert resp.status_code == 200
    body = json.loads(resp.body.decode())
    assert body["sessionKey"] == key
    assert len(body["messages"]) == 1
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][0]["content"] == "hi"


def test_tool_progress_persistence_omits_inline_media_without_mutating_live_payload(
    monkeypatch,
    tmp_path,
) -> None:
    from mona.webui.transcript import (
        append_transcript_object,
        read_transcript_lines,
        replay_transcript_to_ui_messages,
        webui_transcript_path,
    )

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path)
    data_url = "data:image/png;base64," + ("A" * 200_000)
    payload = {
        "event": "message",
        "kind": "progress",
        "tool_events": [{
            "version": 1,
            "phase": "end",
            "call_id": "call-1",
            "name": "computer_observe",
            "arguments": {"detail": "high"},
            "result": [
                {"type": "image", "image_url": {"url": data_url}},
                {"type": "text", "text": "Observed the active window"},
            ],
            "embeds": [{"image_url": data_url}],
        }],
    }

    append_transcript_object("websocket:compact", payload)

    assert payload["tool_events"][0]["result"][0]["image_url"]["url"] == data_url
    persisted = read_transcript_lines("websocket:compact")
    event = persisted[0]["tool_events"][0]
    assert "embeds" not in event
    assert event["result"][0]["image_url"]["url"] == "[inline media omitted]"
    assert event["result"][1]["text"] == "Observed the active window"
    assert webui_transcript_path("websocket:compact").stat().st_size < 2_000
    replayed = replay_transcript_to_ui_messages(persisted)
    assert replayed[0]["traces"] == ['computer_observe({"detail": "high"})']


def test_tool_progress_persistence_bounds_event_count_and_total_size() -> None:
    from mona.webui.transcript import compact_transcript_object

    payload = {
        "event": "message",
        "kind": "progress",
        "tool_events": [
            {
                "phase": "end",
                "call_id": f"call-{index}",
                "name": "web_fetch",
                "arguments": {"url": f"https://example.com/{index}"},
                "result": "x" * 2_000,
            }
            for index in range(510)
        ],
    }

    events = compact_transcript_object(payload)["tool_events"]

    assert len(events) <= 500
    assert events[-1]["call_id"] == "call-509"
    assert len(json.dumps(events).encode("utf-8")) <= 256 * 1024


def test_webui_replay_compacts_inline_media_from_legacy_records(
    monkeypatch,
    tmp_path,
) -> None:
    from mona.webui.transcript import build_webui_thread_response, webui_transcript_path

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path)
    data_url = "data:image/png;base64," + ("A" * 200_000)
    path = webui_transcript_path("websocket:legacy-inline")
    path.write_text(
        json.dumps({
            "event": "message",
            "kind": "progress",
            "tool_events": [{
                "phase": "end",
                "call_id": "legacy-call",
                "name": "computer_observe",
                "result": [{"type": "image", "image_url": {"url": data_url}}],
            }],
        }) + "\n",
        encoding="utf-8",
    )

    response = build_webui_thread_response("websocket:legacy-inline")

    assert response is not None
    event = response["messages"][0]["toolEvents"][0]
    assert event["result"][0]["image_url"]["url"] == "[inline media omitted]"


def test_transcript_reader_does_not_reject_history_by_total_file_size(
    monkeypatch,
    tmp_path,
) -> None:
    from mona.webui.transcript import read_transcript_lines, webui_transcript_path

    monkeypatch.setattr("mona.webui.transcript.get_webui_dir", lambda: tmp_path)
    path = webui_transcript_path("websocket:large")
    record = json.dumps({"event": "user", "text": "x" * 1_024}) + "\n"
    path.write_text(record * 8_100, encoding="utf-8")
    assert path.stat().st_size > 8 * 1024 * 1024

    persisted = read_transcript_lines("websocket:large")

    assert len(persisted) == 8_100
    assert persisted[-1]["text"] == "x" * 1_024
