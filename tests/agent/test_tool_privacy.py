import json
from types import SimpleNamespace

from mona.agent.tool_privacy import redact_persisted_tool_call
from mona.utils.progress_events import build_tool_event_start_payload


def _call(name: str, arguments: dict) -> dict:
    return {
        "id": "call-1",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def test_redacts_browser_and_computer_typed_text_without_mutating_source() -> None:
    source = _call("browser_act", {"kind": "fill", "target": "ref=e1", "text": "secret"})

    redacted = redact_persisted_tool_call(source)

    assert json.loads(redacted["function"]["arguments"])["text"] == "<redacted>"
    assert json.loads(source["function"]["arguments"])["text"] == "secret"
    computer = redact_persisted_tool_call(
        _call("computer_type_text", {"pid": 42, "text": "private"})
    )
    assert json.loads(computer["function"]["arguments"])["text"] == "<redacted>"


def test_keeps_non_sensitive_tool_arguments() -> None:
    source = _call("computer_click", {"pid": 42, "x": 1, "y": 2})

    assert redact_persisted_tool_call(source) == source


def test_progress_event_redacts_typed_text() -> None:
    event = build_tool_event_start_payload(
        SimpleNamespace(
            id="call-1",
            name="computer_type_text",
            arguments={"pid": 42, "text": "private"},
        )
    )

    assert event["arguments"] == {"pid": 42, "text": "<redacted>"}
