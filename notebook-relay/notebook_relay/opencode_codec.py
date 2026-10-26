"""Translate the supported OpenAI surface to the official OpenCode context API."""

# ruff: noqa: TRY004 -- Request validation has a single ValueError contract.

import codecs
import hashlib
import json
import math
import re
from collections.abc import AsyncIterator
from copy import deepcopy

FREE_MODEL = "deepseek-v4.1-flash-free"
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")
_NAME = re.compile(r"[a-zA-Z0-9_-]{1,64}\Z")
_TOP_FIELDS = {
    "model", "messages", "tools", "tool_choice", "stream", "stream_options",
    "temperature", "max_tokens", "max_completion_tokens", "top_p", "n",
    "reasoning_effort", "frequency_penalty", "presence_penalty", "seed", "stop", "user",
}


def _keys(value: object, allowed: set[str], field: str) -> dict:
    if not isinstance(value, dict) or value.keys() - allowed:
        raise ValueError(field)
    return value


def _name(value: object) -> str:
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise ValueError("tools.function.name")
    return value


def _alias(name: str) -> str:
    return "nr_" + hashlib.sha256(name.encode()).hexdigest()[:24]


def _json(value: str, field: str) -> object:
    def invalid_constant(_: str) -> None:
        raise ValueError(field)

    try:
        return json.loads(value, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError):
        raise ValueError(field) from None


def prepare_request(payload: dict) -> dict:
    """Validate without echoing caller content, preserving system and message roles."""
    _keys(payload, _TOP_FIELDS, "request.fields")
    if payload.get("model") != FREE_MODEL:
        raise ValueError("model")
    if payload.get("user") is not None and not isinstance(payload["user"], str):
        raise ValueError("user")
    if "stream" in payload and not isinstance(payload["stream"], bool):
        raise ValueError("stream")
    if "stream_options" in payload:
        opts = _keys(payload["stream_options"], {"include_usage"}, "stream_options")
        if "include_usage" in opts and not isinstance(opts["include_usage"], bool):
            raise ValueError("stream_options.include_usage")
    if "n" in payload and (type(payload["n"]) is not int or payload["n"] != 1):
        raise ValueError("n")
    if payload.get("tool_choice") not in (None, "auto"):
        raise ValueError("tool_choice")
    if "max_tokens" in payload and "max_completion_tokens" in payload:
        raise ValueError("max_tokens.max_completion_tokens")
    options = {}
    for source, target, lower, upper in (
        ("temperature", "temperature", 0, 2),
        ("top_p", "topP", 0, 1),
        ("frequency_penalty", "frequencyPenalty", -2, 2),
        ("presence_penalty", "presencePenalty", -2, 2),
    ):
        if source in payload:
            value = payload[source]
            if (type(value) not in (int, float) or not math.isfinite(value)
                    or not lower <= value <= upper):
                raise ValueError(source)
            options[target] = value
    for source in ("max_tokens", "max_completion_tokens"):
        if source in payload:
            if type(payload[source]) is not int or payload[source] <= 0:
                raise ValueError(source)
            options["maxTokens"] = payload[source]
    if "reasoning_effort" in payload:
        effort = payload["reasoning_effort"]
        if effort not in REASONING_EFFORTS:
            raise ValueError("reasoning_effort")
        options["reasoningEffort"] = effort
    if "seed" in payload:
        if type(payload["seed"]) is not int:
            raise ValueError("seed")
        options["seed"] = payload["seed"]
    if "stop" in payload:
        stops = payload["stop"]
        if isinstance(stops, str):
            stops = [stops]
        if not isinstance(stops, list) or not all(isinstance(stop, str) for stop in stops):
            raise ValueError("stop")
        options["stop"] = list(stops)

    tools, aliases = [], {}
    if not isinstance(payload.get("tools", []), list):
        raise ValueError("tools")
    for item in payload.get("tools", []):
        item = _keys(item, {"type", "function"}, "tools.fields")
        if item.get("type") != "function":
            raise ValueError("tools.type")
        function = _keys(item.get("function"), {
            "name", "description", "parameters", "strict",
        }, "tools.function.fields")
        name = _name(function.get("name"))
        if name in aliases:
            raise ValueError("tools.function.name.duplicate")
        if "strict" in function and function["strict"] is not False:
            raise ValueError("tools.function.strict")
        description = function.get("description", "")
        if not isinstance(description, str):
            raise ValueError("tools.function.description")
        parameters = function.get("parameters")
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            raise ValueError("tools.function.parameters")
        try:
            json.dumps(parameters, allow_nan=False)
        except (ValueError, TypeError, RecursionError):
            raise ValueError("tools.function.parameters") from None
        aliases[name] = _alias(name)
        tools.append({
            "name": name, "alias": aliases[name], "description": description,
            "parameters": deepcopy(parameters),
        })

    incoming = payload.get("messages")
    if not isinstance(incoming, list) or not incoming:
        raise ValueError("messages")
    system, messages, pending, seen = [], [], {}, set()
    for item in incoming:
        if not isinstance(item, dict):
            raise ValueError("messages.fields")
        role = item.get("role")
        fields = {"role", "content"}
        if role == "assistant":
            fields |= {"tool_calls", "reasoning_content"}
        elif role == "tool":
            fields |= {"tool_call_id", "name"}
        elif role not in ("system", "user"):
            raise ValueError("messages.role")
        _keys(item, fields, "messages.fields")
        content = item.get("content")
        if role == "system":
            if messages:
                raise ValueError("messages.system_order")
            if not isinstance(content, str):
                raise ValueError("messages.content")
            system.append({"type": "text", "text": content})
            continue
        if pending and role != "tool":
            raise ValueError("messages.tool_results")
        parts = []
        if role == "tool":
            call_id = item.get("tool_call_id")
            if not isinstance(call_id, str) or call_id not in pending:
                raise ValueError("messages.tool_call_id")
            name = pending.pop(call_id)
            if "name" in item and item["name"] != name:
                raise ValueError("messages.name")
            if not isinstance(content, str):
                raise ValueError("messages.content")
            parts.append({"type": "tool-result", "id": call_id, "name": _alias(name),
                          "result": {"type": "text", "value": content}})
        else:
            if "reasoning_content" in item:
                reasoning = item["reasoning_content"]
                if not isinstance(reasoning, str):
                    raise ValueError("messages.reasoning_content")
                parts.append({"type": "reasoning", "text": reasoning})
            if isinstance(content, str):
                parts.append({"type": "text", "text": content})
            elif role != "assistant" or content is not None:
                raise ValueError("messages.content")
            if "tool_calls" in item:
                calls = item["tool_calls"]
                if not isinstance(calls, list) or not calls:
                    raise ValueError("messages.tool_calls")
                for call in calls:
                    call = _keys(call, {"id", "type", "function"}, "messages.tool_calls.fields")
                    call_id = call.get("id")
                    if not isinstance(call_id, str) or not call_id or call_id in seen:
                        raise ValueError("messages.tool_calls.id")
                    if call.get("type") != "function":
                        raise ValueError("messages.tool_calls.type")
                    function = _keys(call.get("function"), {"name", "arguments"},
                                     "messages.tool_calls.function.fields")
                    name = _name(function.get("name"))
                    arguments = function.get("arguments")
                    if not isinstance(arguments, str):
                        raise ValueError("messages.tool_calls.function.arguments")
                    parsed = _json(arguments, "messages.tool_calls.function.arguments")
                    parts.append({"type": "tool-call", "id": call_id,
                                  "name": _alias(name), "input": parsed})
                    pending[call_id] = name
                    seen.add(call_id)
            if not parts:
                raise ValueError("messages.content")
        messages.append({"role": role, "content": parts})
    if pending or not messages:
        raise ValueError("messages.tool_results" if pending else "messages")
    mapping = json.dumps(aliases, separators=(",", ":"))
    system.append({"type": "text", "text": (
        "External tool names are mapped from original names to registered native names: "
        f"{mapping}. Use only these mapped external tools; do not use other tools."
    )})
    return {"aliases": aliases, "tools": tools, "system": system,
            "messages": messages, "options": options}


class CompletionDecoder:
    """Map genuine upstream deltas and collect a non-streaming completion."""

    def __init__(self, model: str, aliases: dict[str, str]):
        self.model = model
        self._names = {alias: name for name, alias in aliases.items()}
        self._meta = {}
        self._text = {}
        self._tools = {}
        self._finish = None
        self._usage = None

    def feed(self, chunk: dict) -> dict:
        if not isinstance(chunk, dict) or "error" in chunk:
            raise ValueError("upstream.chunk")
        result = deepcopy(chunk)
        result["model"] = self.model
        for key in ("id", "created", "system_fingerprint", "service_tier"):
            if key in chunk:
                self._meta[key] = chunk[key]
        if chunk.get("usage") is not None:
            if not isinstance(chunk["usage"], dict):
                raise ValueError("upstream.usage")
            self._usage = deepcopy(chunk["usage"])
        choices = result.get("choices")
        if not isinstance(choices, list):
            raise ValueError("upstream.choices")
        for choice in choices:
            if not isinstance(choice, dict) or choice.get("index") != 0:
                raise ValueError("upstream.choices.index")
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                raise ValueError("upstream.delta")
            for key in ("content", "reasoning_content", "refusal"):
                if delta.get(key) is not None:
                    if not isinstance(delta[key], str):
                        raise ValueError("upstream.delta.text")
                    self._text[key] = self._text.get(key, "") + delta[key]
            if delta.get("tool_calls") is None:
                delta.pop("tool_calls", None)
            if "tool_calls" in delta:
                if not isinstance(delta["tool_calls"], list):
                    raise ValueError("upstream.tool_calls")
                calls = []
                for call in delta["tool_calls"]:
                    if not isinstance(call, dict) or type(call.get("index")) is not int or call["index"] < 0:
                        raise ValueError("upstream.tool_calls.index")
                    for key in ("id", "type", "function"):
                        if call.get(key) is None:
                            call.pop(key, None)
                    function = call.get("function", {})
                    if not isinstance(function, dict):
                        raise ValueError("upstream.tool_calls.function")
                    for key in ("name", "arguments"):
                        if function.get(key) is None:
                            function.pop(key, None)
                    if function.get("name") == "":
                        function.pop("name")
                    if not function:
                        call.pop("function", None)
                    if call.keys() == {"index"}:
                        continue
                    calls.append(call)
                    state = self._tools.setdefault(call["index"], {
                        "id": "", "native": "", "name": None, "arguments": "",
                    })
                    if "id" in call:
                        if not isinstance(call["id"], str) or not call["id"]:
                            raise ValueError("upstream.tool_calls.id")
                        if state["id"] and state["id"] != call["id"]:
                            raise ValueError("upstream.tool_calls.id")
                        state["id"] = call["id"]
                    if "type" in call and call["type"] != "function":
                        raise ValueError("upstream.tool_calls.type")
                    if "name" in function:
                        if not isinstance(function["name"], str):
                            raise ValueError("upstream.tool_calls.function.name")
                        state["native"] += function["name"]
                        if not any(name.startswith(state["native"]) for name in self._names):
                            raise ValueError("upstream.external_tool_only")
                        if state["native"] in self._names:
                            state["name"] = self._names[state["native"]]
                            function["name"] = state["name"]
                        else:
                            del function["name"]
                    if "arguments" in function:
                        if not isinstance(function["arguments"], str):
                            raise ValueError("upstream.tool_calls.function.arguments")
                        state["arguments"] += function["arguments"]
                delta["tool_calls"] = calls
            if self._finish is not None and any(value for key, value in delta.items() if key != "role"):
                raise ValueError("upstream.finished")
            finish = choice.get("finish_reason")
            if finish is not None:
                if finish not in ("stop", "length", "tool_calls", "content_filter"):
                    raise ValueError("upstream.finish_reason")
                if any(not tool["name"] or not tool["id"] for tool in self._tools.values()):
                    raise ValueError("upstream.tool_calls.incomplete")
                if self._finish is not None and self._finish != finish:
                    raise ValueError("upstream.finish_reason")
                self._finish = finish
        return result

    def completion(self) -> dict:
        if self._finish is None:
            raise ValueError("upstream.finish_reason.missing")
        message = {"role": "assistant", "content": self._text.get("content")}
        message.update({key: value for key, value in self._text.items() if key != "content"})
        if self._tools:
            message["tool_calls"] = [
                {"id": tool["id"], "type": "function", "function": {
                    "name": tool["name"], "arguments": tool["arguments"],
                }} for _, tool in sorted(self._tools.items())
            ]
        result = {**self._meta, "object": "chat.completion", "model": self.model,
                  "choices": [{"index": 0, "message": message, "finish_reason": self._finish}]}
        if self._usage is not None:
            result["usage"] = deepcopy(self._usage)
        return result


async def iter_sse_data(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Yield complete SSE data events; an unfinished final frame is an error."""
    decoder = codecs.getincrementaldecoder("utf-8")()
    buffer, data = "", []
    async for chunk in chunks:
        buffer += decoder.decode(chunk)
        while True:
            match = re.search(r"\r\n|\r|\n", buffer)
            if match is None or (match.group() == "\r" and match.end() == len(buffer)):
                break
            line, buffer = buffer[:match.start()], buffer[match.end():]
            if line == "":
                if data:
                    yield "\n".join(data)
                    data = []
            elif line.startswith("data:") or line == "data":
                value = line[5:] if line.startswith("data:") else ""
                data.append(value.removeprefix(" "))
    buffer += decoder.decode(b"", final=True)
    if buffer == "\r":
        if data:
            yield "\n".join(data)
            data = []
        buffer = ""
    if buffer or data:
        raise ValueError("upstream.sse.incomplete")
