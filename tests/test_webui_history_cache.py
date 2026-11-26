import asyncio
import json
import socket
import threading
from datetime import datetime, timezone
from unittest.mock import MagicMock
from urllib.parse import quote

import httpx
import pytest

from mona.webui import history_cache as cache
from mona.webui.transcript import (
    append_transcript_object,
    delete_webui_transcript,
    webui_transcript_path,
)


@pytest.fixture
def history_root(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path)
    return tmp_path


def write_history(key, turns=12, *, media=False):
    records = []
    for index in range(turns):
        records.extend([
            {"event": "user", "text": f"question {index}",
             **({"media_paths": [f"/private/image-{index}.png"]} if media else {})},
            {"event": "delta", "text": f"answer {index}", "task_id": f"task-{index}"},
            {"event": "stream_end"},
            {"event": "turn_end", "task_id": f"task-{index}"},
        ])
    path = webui_transcript_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(item) + "\n" for item in records), encoding="utf-8")
    return path


def test_pages_use_persistent_projection_and_global_branch_ordinals(history_root, monkeypatch):
    key = "websocket:long-session"
    write_history(key)
    first = cache.build_cached_thread_response(key, limit=4)
    assert [item["content"] for item in first["messages"]] == [
        "question 10", "answer 10", "question 11", "answer 11",
    ]
    assert first["pagination"]["total"] == 24
    assert [item["assistantOrdinal"] for item in first["messages"] if item["role"] == "assistant"] == [11, 12]

    def unexpected_replay(*args, **kwargs):
        raise AssertionError("Unchanged history was replayed instead of reading its disk cache")

    monkeypatch.setattr(cache, "_read_snapshot", unexpected_replay)
    page = first
    complete = first["messages"]
    while page["pagination"]["hasMore"]:
        page = cache.build_cached_thread_response(
            key, limit=4, before=page["pagination"]["before"],
            revision=page["pagination"]["revision"],
        )
        complete = page["messages"] + complete
    full = cache.build_cached_thread_response(key)
    assert complete == full["messages"]
    assert len({item["id"] for item in complete}) == 24
    assert [item["sourceTranscriptIndex"] for item in complete if item["role"] == "assistant"] == list(range(3, 48, 4))


def test_append_invalidates_cursor_and_returns_new_content(history_root):
    key = "websocket:append"
    path = write_history(key, turns=3)
    first = cache.build_cached_thread_response(key, limit=2)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": "user", "text": "new task"}) + "\n")
    with pytest.raises(cache.HistoryRevisionChangedError):
        cache.build_cached_thread_response(key, limit=2, before=4, revision=first["pagination"]["revision"])
    latest = cache.build_cached_thread_response(key, limit=2)
    assert latest["messages"][-1]["content"] == "new task"
    assert latest["pagination"]["revision"] != first["pagination"]["revision"]


def test_session_usage_covers_every_turn_across_history_pages(history_root, monkeypatch):
    key = "websocket:session-usage"
    for index, (prompt, output, read, write, duration) in enumerate([
        (100, 15, 30, 10, 1000), (300, 45, 90, 30, 5000),
    ]):
        usage = {"prompt_tokens": prompt, "completion_tokens": output, "cached_tokens": read,
                 "cache_creation_input_tokens": write, "context_model": f"model-{index}"}
        task = f"task-{index}"
        for event in (
            {"event": "user", "text": f"question {index}", "task_id": task},
            {"event": "message", "text": f"answer {index}", "task_id": task, "token_usage": usage},
            {"event": "turn_end", "task_id": task, "token_usage": usage, "latency_ms": duration},
        ):
            append_transcript_object(key, event)

    latest = cache.build_cached_thread_response(key, limit=2)
    assert latest["pagination"]["hasMore"]
    assert latest["messages"][-1]["content"] == "answer 1"
    assert latest["sessionUsage"] == {
        "promptTokens": 400, "completionTokens": 60, "cacheReadTokens": 120, "cacheWriteTokens": 40,
        "cacheHitRate": 0.3, "latencyMs": 6000, "outputTokensPerSecond": 10,
        "models": ["model-0", "model-1"],
    }

    def unexpected_replay(*args, **kwargs):
        raise AssertionError("Paging should use the saved session totals")

    monkeypatch.setattr(cache, "_read_snapshot", unexpected_replay)
    earlier = cache.build_cached_thread_response(
        key, limit=2, before=latest["pagination"]["before"], revision=latest["pagination"]["revision"],
    )
    assert earlier["messages"][-1]["content"] == "answer 0"
    assert earlier["sessionUsage"] == latest["sessionUsage"]


def test_session_usage_counts_a_terminal_turn_once_without_a_visible_reply(history_root):
    key = "websocket:terminal-usage"
    append_transcript_object(key, {"event": "user", "text": "question"})
    end = {"event": "turn_end", "turn_id": "turn-1", "latency_ms": 2000,
           "token_usage": {"prompt_tokens": 100, "completion_tokens": 10, "reported_cache_read_tokens": 0}}
    append_transcript_object(key, end)
    append_transcript_object(key, end)

    page = cache.build_cached_thread_response(key)
    assert [message["role"] for message in page["messages"]] == ["user"]
    assert page["sessionUsage"]["promptTokens"] == 100
    assert page["sessionUsage"]["latencyMs"] == 2000
    assert page["sessionUsage"]["cacheHitRate"] == 0


@pytest.mark.parametrize("write_tokens", [None, 0, 25])
def test_chat_usage_preserves_reported_cache_writes(write_tokens):
    from mona.providers.openai_compat_provider import OpenAICompatProvider
    from mona.webui.session_usage import summarize_session_usage
    from mona.webui.transcript import _ui_token_usage

    details = {"cached_tokens": 40}
    if write_tokens is not None:
        details.update(cache_write_tokens=write_tokens, cache_creation_input_tokens=write_tokens)
    response = OpenAICompatProvider._parse_chunks([
        {"choices": [], "usage": {"prompt_tokens": 100, "prompt_tokens_details": details}},
        {"choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 10}},
    ])

    usage = summarize_session_usage([(_ui_token_usage(response.usage), None)])
    assert usage is not None
    assert usage["cacheWriteTokens"] == write_tokens


def test_only_visible_media_is_signed_and_cache_never_reuses_process_urls(history_root):
    key = "websocket:media"
    write_history(key, media=True)
    calls = []

    def sign(paths):
        calls.extend(paths)
        return [{"url": "/signed/current", "name": "image.png", "kind": "image"}]

    first = cache.build_cached_thread_response(key, limit=2, augment_user_media=sign)
    assert calls == ["/private/image-11.png"]
    assert first["messages"][0]["images"][0]["url"] == "/signed/current"
    second = cache.build_cached_thread_response(
        key, limit=2,
        augment_user_media=lambda paths: [{"url": "/signed/restarted", "kind": "image"}],
    )
    assert second["messages"][0]["images"][0]["url"] == "/signed/restarted"
    assert "mona-history-media:" not in json.dumps(second)
    assert "/private/" not in json.dumps(second)


def test_corrupt_cache_rebuilds_and_deleting_session_removes_cached_content(history_root):
    key = "websocket:corrupt"
    path = write_history(key)
    first = cache.build_cached_thread_response(key, limit=2)
    database = next((history_root / "conversation-history/display").glob("*.sqlite3"))
    database.write_bytes(b"not sqlite")
    rebuilt = cache.build_cached_thread_response(key, limit=2)
    assert [m["content"] for m in first["messages"]] == [m["content"] for m in rebuilt["messages"]]
    assert delete_webui_transcript(key)
    assert not path.exists()
    assert not database.exists()


def test_recorded_url_cannot_impersonate_cached_filesystem_media(history_root):
    key = "websocket:untrusted-url"
    path = write_history(key, turns=1)
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": "message", "text": "image", "media_urls": [
            {"url": "mona-history-media:guessed-revision:%2Fprivate%2Fsecret.png"},
        ]}) + "\n")
    calls = []
    result = cache.build_cached_thread_response(key, limit=2, augment_user_media=lambda paths: calls.extend(paths) or [])
    assert calls == []
    assert "mona-history-media:" not in json.dumps(result)


@pytest.mark.parametrize("options", [{"limit": 0}, {"limit": 501}, {"before": -1, "revision": "x"}, {"before": 2}])
def test_invalid_pagination_is_rejected(history_root, options):
    with pytest.raises(ValueError):
        cache.build_cached_thread_response("websocket:any", **options)


def _context_history_channel(tmp_path, key, *, task="task-current", answer="answer", usage=None,
                             partner=False):
    from mona.channels.websocket import WebSocketChannel
    from mona.session.manager import Session, SessionManager

    manager = SessionManager(tmp_path / "workspace")
    session = Session(key=key)
    if partner:
        session.metadata["conversation"] = {
            "type": "direct", "directAgentId": "partner.example", "partnerConversation": True,
        }
    session.add_message("user", "saved model input", task_id=task)
    session.add_message(
        "assistant", answer, task_id=task,
        token_usage=usage if usage is not None else {
            "prompt_tokens": 984_805, "completion_tokens": 41_722,
            "context_tokens": 48_212, "context_window_tokens": 1_000_000,
            "context_model": "Qwen-test", "context_provider": "provider-test",
        },
        **({"author_id": "partner.example"} if partner else {}),
    )
    session.messages[-1]["timestamp"] = datetime.fromtimestamp(1_700_000_010, timezone.utc).isoformat()
    manager.save(session)
    channel = WebSocketChannel({"enabled": True}, MagicMock(), session_manager=manager)
    channel._runtime_token = "test-token"
    return channel, manager


def _context_history_request(channel, key, query=""):
    from websockets.datastructures import Headers
    from websockets.http11 import Request

    encoded = quote(key, safe="")
    request = Request(f"/api/sessions/{encoded}/webui-thread{query}", Headers([
        ("Authorization", "Bearer test-token"),
    ]))
    response = channel._handle_webui_thread_get(request, encoded)
    assert response.status_code == 200
    return json.loads(response.body.decode())


def _write_context_turn(key, *, task="task-current", answer="answer", start=1_700_000_000,
                        complete=True, projected_usage=None, author=None):
    append_transcript_object(key, {"event": "user", "text": "display input", "task_id": task,
                                   "_recorded_at": start})
    delta = {"event": "delta", "text": answer, "task_id": task, "_recorded_at": start + 5}
    if author:
        delta["author_id"] = author
    append_transcript_object(key, delta)
    if complete:
        end = {"event": "turn_end", "task_id": task, "_recorded_at": start + 11}
        if projected_usage is not None:
            end["token_usage"] = projected_usage
        append_transcript_object(key, end)


def test_context_usage_restored_on_newest_page_without_replacing_billing(history_root):
    key = "websocket:context-restore"
    channel, manager = _context_history_channel(history_root, key)
    _write_context_turn(key, projected_usage={"prompt_tokens": 12, "completion_tokens": 3})

    payload = _context_history_request(channel, key, "?limit=2")
    assert len(payload["messages"]) == payload["pagination"]["total"] == 2
    answer = payload["messages"][-1]
    assert answer["assistantOrdinal"] == 1
    assert answer["tokenUsage"] == {
        "promptTokens": 12, "completionTokens": 3, "cachedTokens": 0, "totalTokens": 15,
        "contextTokens": 48_212, "contextWindowTokens": 1_000_000,
        "contextModel": "Qwen-test", "contextProvider": "provider-test",
    }
    # Recovery annotates the response, not the reusable display-history cache.
    assert "contextTokens" not in cache.build_cached_thread_response(key, limit=2)["messages"][-1]["tokenUsage"]
    assert manager.read_session_file(key)["messages"][-1]["token_usage"]["completion_tokens"] == 41_722


def test_context_usage_recovers_legacy_mona_author_alias_in_fixed_partner_chat(history_root):
    key = "websocket:partner-context"
    channel, _ = _context_history_channel(history_root, key, partner=True, usage={
        "context_tokens": 48_212, "context_window_tokens": 1_000_000, "context_model": "Qwen-test",
    })
    _write_context_turn(key, author="mona")

    answer = _context_history_request(channel, key, "?limit=2")["messages"][-1]
    assert answer["authorId"] == "mona"
    assert answer["tokenUsage"]["contextTokens"] == 48_212
    assert "contextProvider" not in answer["tokenUsage"]


def test_context_usage_restores_recorded_billing_when_projection_has_none(history_root):
    key = "websocket:context-billing"
    channel, _ = _context_history_channel(history_root, key)
    _write_context_turn(key)

    answer = _context_history_request(channel, key, "?limit=2")["messages"][-1]
    assert answer["tokenUsage"] == {
        "promptTokens": 984_805, "completionTokens": 41_722, "cachedTokens": 0,
        "totalTokens": 1_026_527, "contextTokens": 48_212, "contextWindowTokens": 1_000_000,
        "contextModel": "Qwen-test", "contextProvider": "provider-test",
    }


def test_context_usage_rejects_an_unrelated_author(history_root):
    key = "websocket:context-author"
    channel, _ = _context_history_channel(history_root, key, partner=True)
    _write_context_turn(key, author="other-partner")

    answer = _context_history_request(channel, key, "?limit=2")["messages"][-1]
    assert "contextTokens" not in answer.get("tokenUsage", {})


def test_context_usage_keeps_history_readable_when_saved_usage_is_malformed(history_root):
    key = "websocket:context-invalid"
    channel, _ = _context_history_channel(history_root, key, usage={
        "prompt_tokens": "invalid", "context_tokens": 123,
    })
    _write_context_turn(key)

    answer = _context_history_request(channel, key, "?limit=2")["messages"][-1]
    assert answer["content"] == "answer"
    assert "contextTokens" not in answer.get("tokenUsage", {})


@pytest.mark.parametrize("case", ["other_task", "other_answer", "reused_task", "incomplete"])
def test_context_usage_recovery_rejects_a_different_or_unfinished_turn(history_root, case):
    key = f"websocket:context-{case}"
    channel, _ = _context_history_channel(history_root, key)
    if case == "other_task":
        _write_context_turn(key, task="task-other")
    elif case == "other_answer":
        _write_context_turn(key, answer="different answer")
    elif case == "reused_task":
        _write_context_turn(key, start=1_700_000_020)
    else:
        _write_context_turn(key, complete=False)

    result = _context_history_request(channel, key, "?limit=2")
    assert "contextTokens" not in result["messages"][-1].get("tokenUsage", {})


@pytest.mark.parametrize(("wire_window", "display_window"), [
    ("context_window_tokens", "contextWindowTokens"),
    ("context_budget_tokens", "contextBudgetTokens"),
])
def test_context_usage_skips_canonical_history_for_current_snapshot_and_older_pages(
    history_root, monkeypatch, wire_window, display_window,
):
    key = "websocket:context-skip"
    monkeypatch.setattr(cache, "_cache_key", lambda _key: "context-skip")
    channel, manager = _context_history_channel(history_root, key)
    _write_context_turn(key, task="task-earlier", start=1_699_999_900)
    _write_context_turn(key, projected_usage={"context_tokens": 50, wire_window: 100})
    read = MagicMock(wraps=manager.read_session_file)
    monkeypatch.setattr(manager, "read_session_file", read)

    newest = _context_history_request(channel, key, "?limit=2")
    assert newest["messages"][-1]["tokenUsage"]["contextTokens"] == 50
    assert newest["messages"][-1]["tokenUsage"][display_window] == 100
    assert not read.called
    before = newest["pagination"]["before"]
    revision = newest["pagination"]["revision"]
    older = _context_history_request(channel, key, f"?limit=2&before={before}&revision={revision}")
    assert older["messages"][-1]["content"] == "answer"
    assert not read.called


def test_context_usage_skips_a_new_turn_arriving_during_the_read(history_root, monkeypatch):
    key = "websocket:context-concurrent"
    channel, manager = _context_history_channel(history_root, key)
    _write_context_turn(key)
    read = manager.read_session_file

    def read_and_append(session_key):
        session = read(session_key)
        append_transcript_object(key, {"event": "user", "text": "new input", "task_id": "task-current",
                                       "_recorded_at": 1_700_000_020})
        return session

    monkeypatch.setattr(manager, "read_session_file", read_and_append)
    answer = _context_history_request(channel, key, "?limit=2")["messages"][-1]
    assert "contextTokens" not in answer.get("tokenUsage", {})


@pytest.mark.asyncio
async def test_history_dispatch_does_not_block_event_loop(history_root):
    from mona.channels.websocket import WebSocketChannel

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    channel = WebSocketChannel({"enabled": True, "host": "127.0.0.1", "port": port}, MagicMock())
    entered = threading.Event()
    release = threading.Event()
    original = channel._handle_webui_thread_get
    key = "websocket:async-read"
    write_history(key, turns=1)

    def delayed(request, encoded_key):
        entered.set()
        if not release.wait(3):
            raise AssertionError("History blocked the event loop")
        return original(request, encoded_key)

    channel._handle_webui_thread_get = delayed
    base_url = f"http://127.0.0.1:{port}"
    server_task = asyncio.create_task(channel.start())
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=5.0) as client:
            for _ in range(50):
                try:
                    health = await client.get(f"{base_url}/health")
                    assert health.status_code == 200
                    break
                except httpx.ConnectError:
                    await asyncio.sleep(0.02)
            else:
                pytest.fail("WebSocket HTTP bridge did not start")

            bootstrap = await client.get(f"{base_url}/webui/bootstrap")
            assert bootstrap.status_code == 200
            token = bootstrap.json()["token"]
            assert token.startswith("nbwt_")

            task = asyncio.create_task(client.get(
                f"{base_url}/api/sessions/{quote(key, safe='')}/webui-thread?limit=2",
                headers={"Authorization": f"Bearer {token}"},
            ))
            assert await asyncio.to_thread(entered.wait, 2)
            await asyncio.sleep(0)
            release.set()
            response = await task
            assert response.status_code == 200
            assert response.json()["pagination"]["total"] == 2
    finally:
        release.set()
        await channel.stop()
        await server_task
