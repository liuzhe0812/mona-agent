"""Exercise executor projection and the shared display contract, not vendor login."""
import pytest

from mona.development.display_content import display_content
from mona.development.executors.codex_events import normalize_codex_event
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.runtime import public_message


@pytest.mark.parametrize("executor", ["mona", "codex", "claude", "codebuddy"])
def test_complete_markdown_is_not_cut_at_preview_boundary(executor):
    text = "```python\n" + "print('keep all lines')\n" * 1200 + "```\n\n$$x^2$$"
    if executor == "codex":
        event = normalize_codex_event("item/completed", {"item": {"type": "agentMessage", "id": "item", "text": text}})
        text = event.payload["text"]
    elif executor in {"claude", "codebuddy"}:
        projector = SDKEventProjector("session")
        projector.begin("turn")
        text = projector.consume({"type": "assistant", "content": [{"type": "text", "text": text}]})[0].payload["text"]
    message = public_message({"role": "assistant", "author_id": executor, "content": text})
    assert message["content"] == text
    assert message["content"].endswith("```\n\n$$x^2$$")
    assert not message["truncated"]


def test_sdk_structured_images_survive_projection_without_private_reasoning():
    projector = SDKEventProjector("session")
    projector.begin("turn")
    events = projector.consume({"type": "assistant", "content": [
        {"type": "thinking", "thinking": "DISPLAY_REASONING", "signature": "PRIVATE_SIGNATURE"},
        {"type": "redacted_thinking", "data": "PRIVATE_REDACTED"},
        {"type": "text", "text": "图片结果"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aW1hZ2U="}},
    ]})
    assert [event.type for event in events] == ["reasoning.completed", "agent.message.completed"]
    assert events[0].payload["text"] == "DISPLAY_REASONING"
    assert "PRIVATE" not in str(events)
    message = public_message({"role": "assistant", "content": events[1].payload["content"]})
    assert "DISPLAY_REASONING" not in message["content"]
    assert message["content"] == "图片结果"
    assert message["media"] == [{"kind": "image", "url": "data:image/png;base64,aW1hZ2U=", "name": "图片"}]


def test_image_only_and_other_media_share_the_public_contract():
    text, media = display_content([
        {"type": "image_url", "image_url": {"url": "https://example.com/result.png"}},
        {"type": "audio", "url": "./result.wav", "name": "讲解"},
        {"type": "video", "url": "./result.mp4"},
        {"type": "document", "source": {"type": "url", "url": "./report.pdf"}},
        {"type": "image", "source": {"type": "unknown"}},
    ])
    assert text == ""
    assert [item["kind"] for item in media] == ["image", "audio", "video", "file", "image"]
    assert media[-1]["url"] == ""  # The UI displays an unavailable attachment.


def test_tool_log_remains_bounded():
    message = public_message({"role": "tool", "content": "log" * 10000})
    assert message["truncated"]
    assert len(message["content"]) == 24000


@pytest.mark.asyncio
async def test_native_media_persistence_and_replay(tmp_path):
    from test_native_service import setup, wait_status

    from mona.development.contracts import RunStatus
    from mona.development.executors.base import NativeEvent

    service, adapter, store, session, binding, _ = await setup(tmp_path)
    try:
        run = await service.submit(session.id, "media_request", "hold")
        run = await wait_status(store, run.id, {RunStatus.RUNNING})
        event = NativeEvent(native_event_id="media-completed", native_turn_id=run.native_turn_id,
            type="agent.message.completed", payload={"itemId": "media-item", "text": "结果", "content": [
                {"type": "text", "text": "结果"}, {"type": "image", "url": "./result.png"}]})
        service._record(run, binding, event)
        service.sessions.invalidate(session.transcript_key)
        service._record(store.get_run(run.id), binding, event)
        messages = service.sessions.get_or_create(session.transcript_key).messages
        saved = next(m for m in messages if m.get("native_item_id") == "media-item")
        assert saved["content"] == "结果"  # Handoff/collaboration still receives text.
        assert saved["_display_media"][0]["kind"] == "image"
        projected = [public_message(m) for m in messages if m.get("native_item_id") == "media-item"]
        assert len(projected) == 1
        assert projected[0]["media"][0]["url"] == "./result.png"
    finally:
        await service.close()
        await adapter.shutdown()
