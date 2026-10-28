"""Native API-error envelopes and request-local usage stay separate from text/billing."""

import pytest

from mona.development.contracts import ExecutorId
from mona.development.executors.sdk_events import SDKEventProjector

_MODEL = "deepseek-v4.1-flash"
_ERROR = (
    "400 prompt is too long: 1226330 tokens > 1048576 maximum "
    "(0123456789abcdef0123456789abcdef/12345678-1234-1234-1234-123456789abc)"
)


def _projector(*, executor=ExecutorId.CODEBUDDY, work_tool=True):
    projector = SDKEventProjector("fixture-session", executor=executor, work_tool=work_tool)
    projector.begin("sdk:fixture")
    return projector


def _assistant(text, *, error=None):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import TextBlock

    return sdk.AssistantMessage(content=[TextBlock(text)], model=_MODEL, error=error)


def _result(*, failed=False, result="", usage=None, errors=None):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    return sdk.ResultMessage(
        subtype="error_during_execution" if failed else "success", duration_ms=1, duration_api_ms=1,
        is_error=failed, num_turns=1, session_id="fixture-session", result=result, usage=usage, errors=errors,
    )


def _stream(event_type, **kwargs):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    return sdk.StreamEvent(uuid="fixture-event", session_id="fixture-session", event={"type": event_type, **kwargs})


@pytest.mark.parametrize("error,expected", [
    ("invalid_request", "context_window_exceeded"),
    ("authentication_failed", "authentication_required"),
    ("rate_limit", "rate_limit_exceeded"),
])
def test_official_assistant_api_error_waits_for_authoritative_failed_result(error, expected):
    projector = _projector()
    text = _ERROR if error == "invalid_request" else "Private upstream error detail"

    assert projector.consume(_assistant(text, error=error)) == []
    assert not projector.finished and not projector.uncertain
    final = projector.consume(_result(failed=True, result=text))

    assert [event.type for event in final] == ["usage.updated", "run.failed"]
    assert final[-1].payload["errorCode"] == expected
    assert text not in str(final)


@pytest.mark.parametrize("normal_assistant", [False, True])
def test_native_success_discards_temporary_error_without_showing_it(normal_assistant):
    projector = _projector()
    assert projector.consume(_assistant(_ERROR, error="invalid_request")) == []
    if normal_assistant:
        events = projector.consume(_assistant("The native request recovered."))
        assert [event.type for event in events] == ["agent.message.completed"]
        assert projector.pending_api_error is None
    final = projector.consume(_result(result="Finished after recovery."))

    assert final[-1].type == "run.completed"
    assert not any(event.type == "run.failed" for event in final)
    assert _ERROR not in str(final)
    assert projector.pending_api_error is None


def test_later_failure_does_not_reuse_error_from_an_already_recovered_request():
    projector = _projector()
    projector.consume(_assistant(_ERROR, error="invalid_request"))
    projector.consume(_assistant("Recovered."))

    final = projector.consume(_result(failed=True))

    assert final[-1].payload["errorCode"] == "native_execution_failed"


def test_next_turn_does_not_inherit_the_previous_pending_api_error():
    projector = _projector()
    projector.consume(_assistant(_ERROR, error="invalid_request"))
    projector.begin("sdk:next")

    assert projector.consume(_result(failed=True))[-1].payload["errorCode"] == "native_execution_failed"


def test_failed_result_can_classify_context_overflow_without_an_assistant_envelope():
    projector = _projector()

    final = projector.consume(_result(failed=True, errors=[_ERROR]))

    assert final[-1].payload["errorCode"] == "context_window_exceeded"
    assert _ERROR not in str(final)


@pytest.mark.parametrize("text", [_ERROR, _ERROR.replace("1226330", "1,226,330").replace("1048576", "1,048,576")])
def test_codebuddy_work_classifies_only_the_complete_unflagged_native_context_error(text):
    projector = _projector()

    assert projector.consume(_assistant(text)) == []
    assert not projector.finished
    final = projector.consume(_result(failed=True))

    assert final[-1].payload["errorCode"] == "context_window_exceeded"
    assert text not in str(final)


@pytest.mark.parametrize("text,executor,work_tool", [
    ("Here is the reported error: " + _ERROR, ExecutorId.CODEBUDDY, True),
    ("```\n" + _ERROR + "\n```", ExecutorId.CODEBUDDY, True),
    (_ERROR + "\nI will investigate it.", ExecutorId.CODEBUDDY, True),
    (_ERROR.replace("1226330", "1000"), ExecutorId.CODEBUDDY, True),
    (_ERROR, ExecutorId.CODEBUDDY, False),
    (_ERROR, ExecutorId.CLAUDE, True),
])
def test_ordinary_error_discussion_and_other_routes_remain_assistant_content(text, executor, work_tool):
    projector = _projector(executor=executor, work_tool=work_tool)

    events = projector.consume(_assistant(text))

    assert [event.type for event in events] == ["agent.message.completed"]
    assert events[0].payload["text"] == text
    assert projector.pending_api_error is None


def test_error_inside_a_tool_result_is_not_treated_as_an_assistant_api_error():
    projector = _projector()
    projector.tool_ids.add("recorded-tool")

    events = projector.consume({"type": "user", "content": [{
        "type": "tool_result", "tool_use_id": "recorded-tool", "content": _ERROR,
    }]})

    assert events[0].type == "tool.completed"
    assert events[0].payload["content"] == _ERROR
    assert projector.pending_api_error is None


@pytest.mark.parametrize("executor,expected", [(ExecutorId.CLAUDE, 1_249_369), (ExecutorId.CODEBUDDY, 626_777)])
def test_request_usage_respects_the_native_executor_cache_semantics(executor, expected):
    projector = _projector(executor=executor)
    assert projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 0, "output_tokens": 0},
    })) == []
    assert projector.context_tokens is None

    measured = projector.consume(_stream("message_delta", usage={
        "input_tokens": 626_483, "cache_read_input_tokens": 622_592, "output_tokens": 294,
    }))
    assert measured[0].payload == {"contextTokens": expected}
    projector.consume(_stream("message_delta", usage={
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
    }))
    assert projector.context_tokens == expected


def test_new_request_with_zero_or_missing_usage_does_not_inherit_previous_context():
    projector = _projector()
    projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 10},
    }))
    assert projector.context_tokens == 10

    assert projector.consume(_stream("message_start", message={
        "id": "request-2", "model": _MODEL, "usage": {"input_tokens": 0, "output_tokens": 0},
    })) == []
    assert projector.consume(_stream("message_delta", usage={"output_tokens": 4})) == []
    assert projector.context_tokens is None


def test_cumulative_result_billing_does_not_replace_last_request_context():
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import Usage

    projector = _projector()
    projector.consume(_stream("message_start", message={
        "id": "request-1", "model": _MODEL, "usage": {"input_tokens": 80000},
    }))
    final = projector.consume(_result(usage=Usage(input_tokens=39_187_361, output_tokens=1000)))
    usage = next(event.payload for event in final if event.type == "usage.updated")

    assert usage["contextTokens"] == 80000
    assert usage["usage"]["input_tokens"] == 39_187_361


def test_missing_result_input_count_does_not_become_real_zero_or_a_cache_only_context():
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.types import Usage

    projector = _projector()
    final = projector.consume(_result(usage=Usage(input_tokens=0, output_tokens=0, cache_read_input_tokens=39_187_361)))
    usage = next(event.payload for event in final if event.type == "usage.updated")

    assert "contextTokens" not in usage
    assert "input_tokens" not in usage["usage"]
    assert "output_tokens" not in usage["usage"]
    assert usage["usage"]["cache_read_input_tokens"] == 39_187_361
    projector.begin("sdk:next")
    blank = projector.consume(_result(usage=Usage()))
    assert next(event.payload for event in blank if event.type == "usage.updated")["usage"] is None
