import hashlib
import json

import pytest

from notebook_relay.opencode_codec import (
    FREE_MODEL,
    CompletionDecoder,
    iter_sse_data,
    prepare_request,
)


def request(**extra):
    return {"model": FREE_MODEL, "messages": [{"role": "user", "content": "hello"}], **extra}


def tool(name="sum"):
    return {"type": "function", "function": {
        "name": name, "description": "Add values", "strict": False,
        "parameters": {"type": "object", "properties": {"a": {"type": "integer"}},
                       "required": ["a"], "additionalProperties": False},
    }}


def alias(name="sum"):
    return "nr_" + hashlib.sha256(name.encode()).hexdigest()[:24]


def test_prepare_preserves_system_and_complete_tool_history():
    messages = [
        {"role": "system", "content": "Exact system\n原文"},
        {"role": "system", "content": "Second system"},
        {"role": "user", "content": "Compute"},
        {"role": "assistant", "content": None, "reasoning_content": "Think",
         "tool_calls": [{"id": "call_1", "type": "function",
                         "function": {"name": "sum", "arguments": '{"a":42}'}}]},
        {"role": "tool", "tool_call_id": "call_1", "name": "sum", "content": "42"},
        {"role": "assistant", "content": "42"},
        {"role": "user", "content": "Again"},
    ]
    source = tool()
    prepared = prepare_request(request(messages=messages, tools=[source]))
    assert prepared["aliases"] == {"sum": alias()}
    assert prepared["system"][:2] == [
        {"type": "text", "text": "Exact system\n原文"},
        {"type": "text", "text": "Second system"},
    ]
    assert alias() in prepared["system"][2]["text"]
    assert [message["role"] for message in prepared["messages"]] == [
        "user", "assistant", "tool", "assistant", "user",
    ]
    assert prepared["messages"][1]["content"] == [
        {"type": "reasoning", "text": "Think"},
        {"type": "tool-call", "id": "call_1", "name": alias(), "input": {"a": 42}},
    ]
    assert prepared["messages"][2]["content"] == [{
        "type": "tool-result", "id": "call_1", "name": alias(),
        "result": {"type": "text", "value": "42"},
    }]
    assert prepared["tools"][0]["parameters"] == source["function"]["parameters"]
    prepared["tools"][0]["parameters"]["required"].append("x")
    assert source["function"]["parameters"]["required"] == ["a"]


def test_historical_tool_does_not_authorize_new_calls():
    prepared = prepare_request(request(messages=[
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "old", "type": "function", "function": {"name": "old", "arguments": "{}"},
        }]},
        {"role": "tool", "tool_call_id": "old", "content": "done"},
    ]))
    assert prepared["aliases"] == {}
    assert prepared["messages"][0]["content"][0]["name"] == alias("old")


def test_generation_options_use_verified_sdk_fields():
    prepared = prepare_request(request(
        temperature=0.4, top_p=0.9, max_completion_tokens=500, n=1,
        reasoning_effort="high", frequency_penalty=0.5, presence_penalty=-0.5,
        seed=7, stop="END", stream=True, stream_options={"include_usage": True},
        tool_choice="auto",
    ))
    assert prepared["options"] == {
        "temperature": 0.4, "topP": 0.9, "maxTokens": 500, "reasoningEffort": "high",
        "frequencyPenalty": 0.5, "presencePenalty": -0.5, "seed": 7, "stop": ["END"],
    }
    assert prepare_request(request(max_tokens=12))["options"]["maxTokens"] == 12


@pytest.mark.parametrize("user", [None, "mona-test"])
def test_prepare_ignores_caller_attribution(user):
    prepared = prepare_request(request(max_tokens=128, stream=False, n=1, user=user))
    baseline = prepare_request(request(max_tokens=128, stream=False))
    assert prepared["system"] == baseline["system"]
    assert prepared["messages"] == baseline["messages"]
    assert prepared["options"] == baseline["options"]


@pytest.mark.parametrize("user", [1, True, [], {}])
def test_prepare_rejects_non_string_caller_attribution(user):
    with pytest.raises(ValueError, match="^user$"):
        prepare_request(request(user=user))


@pytest.mark.parametrize("extra", [
    {"response_format": {"type": "json_object"}}, {"reasoning_effort": "secret-private"},
    {"tool_choice": "required"}, {"tool_choice": "none"}, {"n": 2}, {"n": True},
    {"temperature": float("nan")}, {"top_p": 1.1}, {"max_tokens": True},
    {"max_tokens": 1, "max_completion_tokens": 2},
    {"stream_options": {"include_usage": "yes"}}, {"stream": "yes"},
    {"stop": [3]}, {"seed": 1.5},
])
def test_unsupported_or_invalid_options_fail_without_echoing_values(extra):
    with pytest.raises(ValueError) as error:
        prepare_request(request(**extra))
    assert "secret-private" not in str(error.value)


@pytest.mark.parametrize("message", [
    {"role": "developer", "content": "secret-private"},
    {"role": "user", "content": [{"type": "text", "text": "secret-private"}]},
    {"role": "user", "content": "secret-private", "name": "bob"},
    {"role": "assistant", "content": "secret-private", "audio": {}},
    {"role": "tool", "content": "secret-private", "tool_call_id": "unknown"},
])
def test_unsupported_message_surface_is_explicit(message):
    with pytest.raises(ValueError) as error:
        prepare_request(request(messages=[message]))
    assert "secret-private" not in str(error.value)


def test_system_cannot_be_downgraded_to_a_user_message():
    with pytest.raises(ValueError, match="system_order"):
        prepare_request(request(messages=[
            {"role": "user", "content": "hello"}, {"role": "system", "content": "later"},
        ]))


@pytest.mark.parametrize("change", [
    {"strict": True}, {"name": "invalid.dot"}, {"parameters": {"type": "array"}},
    {"parameters": {"type": "object", "x": float("nan")}}, {"unknown": "secret-private"},
])
def test_tools_preserve_schema_or_reject_unsupported_contract(change):
    definition = tool()
    definition["function"].update(change)
    with pytest.raises(ValueError) as error:
        prepare_request(request(tools=[definition]))
    assert "secret-private" not in str(error.value)


def chunk(delta, finish=None):
    return {"id": "real-id", "created": 123, "object": "chat.completion.chunk",
            "model": "upstream-model", "choices": [{"index": 0, "delta": delta,
                                                       "finish_reason": finish}]}


def test_decoder_keeps_reasoning_and_tool_argument_deltas_and_last_usage():
    decoder = CompletionDecoder(FREE_MODEL, {"sum": alias()})
    decoder.feed(chunk({"role": "assistant", "reasoning_content": "thinking"}))
    first = decoder.feed(chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                                "function": {"name": alias()[:8], "arguments": "{"}}]}))
    assert "name" not in first["choices"][0]["delta"]["tool_calls"][0]["function"]
    second = decoder.feed(chunk({"tool_calls": [{"index": 0, "function": {
        "name": alias()[8:], "arguments": '"a":42}',
    }}]}))
    assert second["choices"][0]["delta"]["tool_calls"][0]["function"] == {
        "name": "sum", "arguments": '"a":42}',
    }
    decoder.feed({"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 2}})
    decoder.feed(chunk({}, "tool_calls"))
    usage = {"prompt_tokens": 9, "completion_tokens": 5, "total_tokens": 14,
             "completion_tokens_details": {"reasoning_tokens": 3}}
    decoder.feed({"choices": [], "usage": usage})
    result = decoder.completion()
    assert result["id"] == "real-id"
    assert result["usage"] == usage
    assert result["model"] == FREE_MODEL
    assert result["choices"][0] == {"index": 0, "finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": None, "reasoning_content": "thinking",
        "tool_calls": [{"id": "call_1", "type": "function", "function": {
            "name": "sum", "arguments": '{"a":42}',
        }}],
    }}


def test_decoder_does_not_invent_usage_or_success_for_unfinished_stream():
    decoder = CompletionDecoder(FREE_MODEL, {})
    decoder.feed(chunk({"content": "Hi"}))
    with pytest.raises(ValueError, match="finish_reason.missing"):
        decoder.completion()
    decoder.feed(chunk({"content": "!"}, "stop"))
    result = decoder.completion()
    assert result["choices"][0]["message"]["content"] == "Hi!"
    assert "usage" not in result


def test_decoder_accepts_nullable_tool_deltas_without_repeating_names():
    decoder = CompletionDecoder(FREE_MODEL, {"sum": alias()})
    emitted_names = []
    deltas = [
        {"role": "assistant", "content": None, "tool_calls": None},
        {"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {
            "name": alias(), "arguments": "{",
        }}]},
        {"tool_calls": [{"index": 0, "id": None, "type": None, "function": {
            "name": None, "arguments": '"a":',
        }}]},
        {"tool_calls": [{"index": 0, "id": None, "type": None, "function": None}]},
        {"tool_calls": [{"index": 0, "function": {"name": "", "arguments": None}}]},
        {"tool_calls": [{"index": 0, "function": {"name": None, "arguments": "42}"}}]},
    ]
    for delta in deltas:
        mapped = decoder.feed(chunk(delta))["choices"][0]["delta"]
        for call in mapped.get("tool_calls", []):
            function = call.get("function", {})
            if "name" in function:
                emitted_names.append(function["name"])
    decoder.feed(chunk({"content": None, "tool_calls": None}, "tool_calls"))
    decoder.feed(chunk({"content": None, "tool_calls": None}, "tool_calls"))
    assert emitted_names == ["sum"]
    assert decoder.completion()["choices"][0]["message"]["tool_calls"] == [{
        "id": "call_1", "type": "function", "function": {"name": "sum", "arguments": '{"a":42}'},
    }]


@pytest.mark.parametrize("native_name", ["bash", "unregistered", "nr_unknown"])
def test_decoder_rejects_native_or_unknown_tools(native_name):
    decoder = CompletionDecoder(FREE_MODEL, {"sum": alias()})
    with pytest.raises(ValueError, match="external_tool_only"):
        decoder.feed(chunk({"tool_calls": [{"index": 0, "id": "c", "function": {
            "name": native_name, "arguments": "{}",
        }}]}))


def test_decoder_rejects_incomplete_alias_at_finish():
    decoder = CompletionDecoder(FREE_MODEL, {"sum": alias()})
    decoder.feed(chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "nr_"}}]}))
    with pytest.raises(ValueError, match="incomplete"):
        decoder.feed(chunk({}, "tool_calls"))


async def byte_chunks(data, size=1):
    for start in range(0, len(data), size):
        yield data[start:start + size]


@pytest.mark.asyncio
async def test_sse_handles_split_utf8_crlf_multiline_data_and_comments():
    data = ': comment\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\ndata: [DONE]\n\n'.encode()
    frames = [frame async for frame in iter_sse_data(byte_chunks(data))]
    assert json.loads(frames[0]) == {"text": "中文"}
    assert frames[1] == "[DONE]"


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [b'data: {"x":1}', b'data: {"x":1}\n', b'data: \xe4'])
async def test_sse_rejects_incomplete_frames(data):
    with pytest.raises((ValueError, UnicodeDecodeError)):
        [frame async for frame in iter_sse_data(byte_chunks(data))]


@pytest.mark.asyncio
async def test_sse_preserves_done_and_leaves_missing_done_to_caller():
    assert [frame async for frame in iter_sse_data(byte_chunks(b"data: {}\n\n"))] == ["{}"]
