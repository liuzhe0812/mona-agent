import asyncio
import json
import threading
import time
from unittest.mock import MagicMock
from urllib.parse import quote

import pytest

from mona.webui import history_cache as cache
from mona.webui.transcript import delete_webui_transcript, webui_transcript_path


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


@pytest.mark.asyncio
async def test_history_dispatch_does_not_block_event_loop(history_root):
    from websockets.datastructures import Headers
    from websockets.http11 import Request

    from mona.channels.websocket import WebSocketChannel, WebSocketConfig

    channel = WebSocketChannel(WebSocketConfig(enabled=True, token="test"), MagicMock())
    channel._api_tokens["test"] = time.monotonic() + 300
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
    request = Request(f"/api/sessions/{quote(key, safe='')}/webui-thread?limit=2", Headers([("Authorization", "Bearer test")]))
    task = asyncio.create_task(channel._dispatch_http(MagicMock(), request))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        await asyncio.sleep(0)
        release.set()
        response = await task
        assert response.status_code == 200
        assert json.loads(response.body)["pagination"]["total"] == 2
    finally:
        release.set()
