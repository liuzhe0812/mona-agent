"""Opt-in, two-request verification against the official free model."""

import json
import os
import re
import secrets
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn

from notebook_relay.app import create_app
from notebook_relay.config import Settings


@pytest.mark.skipif(not os.environ.get("NOTEBOOK_RELAY_LIVE_OPENCODE"), reason="Explicit live-model opt-in required")
@pytest.mark.parametrize("streaming_first", [False, True])
def test_official_free_deepseek_external_tool_round_trip(streaming_first):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    key = secrets.token_urlsafe(32)
    settings = Settings(api_key=key, port=port, upstream_provider="opencode_native",
                        opencode_executable=os.environ["NOTEBOOK_RELAY_LIVE_OPENCODE"],
                        request_timeout_seconds=60)
    server = uvicorn.Server(uvicorn.Config(create_app(settings), host="127.0.0.1", port=port,
                                          log_level="warning", access_log=False))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    report = {"model": "deepseek-v4.1-flash-free", "scope": "official-native-public-api",
              "first_streaming": streaming_first}
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=75,
                          headers={"Authorization": "Bearer " + key}) as client:
            for _ in range(300):
                try:
                    if client.get("/health", timeout=.2).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(.1)
            else:
                pytest.fail("relay startup timed out")
            ready = client.get("/ready")
            assert ready.status_code == 200, ready.text
            messages = [
                {"role": "system", "content": "Use the supplied sum_numbers tool when asked, then answer with the remembered codeword, a colon, and the sum. Never use other tools."},
                {"role": "user", "content": "Remember the codeword BRIDGE_WORD_47."},
                {"role": "assistant", "content": "I will remember BRIDGE_WORD_47."},
                {"role": "user", "content": "Use sum_numbers with a=17 and b=25."},
            ]
            tools = [{"type": "function", "function": {
                "name": "sum_numbers", "description": "Add two integers using the client calculator.",
                "parameters": {"type": "object", "properties": {
                    "a": {"type": "integer"}, "b": {"type": "integer"},
                }, "required": ["a", "b"], "additionalProperties": False},
            }}]
            body = {"model": report["model"], "messages": messages, "tools": tools,
                    "tool_choice": "auto", "max_tokens": 256, "stream": streaming_first}
            start = time.monotonic()
            if streaming_first:
                body["stream_options"] = {"include_usage": True}
                collected, reasoning, calls_by_index, usage, finish, done = [], [], {}, None, None, False
                with client.stream("POST", "/v1/chat/completions", json=body) as first:
                    assert first.status_code == 200, first.read().decode()
                    for line in first.iter_lines():
                        if not line.startswith("data:"):
                            continue
                        value = line[5:].strip()
                        if value == "[DONE]":
                            done = True
                            continue
                        event = json.loads(value)
                        assert "error" not in event, event
                        usage = event.get("usage") or usage
                        for choice in event.get("choices", []):
                            delta = choice.get("delta", {})
                            collected.append(delta.get("content") or "")
                            reasoning.append(delta.get("reasoning_content") or "")
                            finish = choice.get("finish_reason") or finish
                            for part in delta.get("tool_calls", []):
                                call = calls_by_index.setdefault(part["index"], {
                                    "id": "", "type": "", "function": {"name": "", "arguments": ""},
                                })
                                call["id"] = part.get("id") or call["id"]
                                call["type"] = part.get("type") or call["type"]
                                for name in ("name", "arguments"):
                                    call["function"][name] += part.get("function", {}).get(name, "")
                assert done and finish == "tool_calls"
                message = {"role": "assistant", "content": "".join(collected) or None,
                           "tool_calls": [value for _, value in sorted(calls_by_index.items())]}
                if any(reasoning):
                    message["reasoning_content"] = "".join(reasoning)
                data = {"choices": [{"message": message, "finish_reason": finish}], "usage": usage}
            else:
                first = client.post("/v1/chat/completions", json=body)
                assert first.status_code == 200, first.text
                data = first.json()
            message = data["choices"][0]["message"]
            calls = message["tool_calls"]
            assert len(calls) == 1 and calls[0]["function"]["name"] == "sum_numbers"
            arguments = json.loads(calls[0]["function"]["arguments"])
            assert arguments == {"a": 17, "b": 25}
            assert data["usage"]["prompt_tokens"] > 0
            report["first"] = {"status": first.status_code, "seconds": round(time.monotonic() - start, 2),
                               "finish_reason": data["choices"][0]["finish_reason"], "usage": data["usage"]}
            messages.extend([message, {"role": "tool", "tool_call_id": calls[0]["id"],
                                       "content": str(arguments["a"] + arguments["b"])}])
            body.update(messages=messages, stream=True, stream_options={"include_usage": True})
            text, done, usage, finish = [], False, None, None
            start = time.monotonic()
            with client.stream("POST", "/v1/chat/completions", json=body) as response:
                assert response.status_code == 200, response.read().decode()
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    value = line[5:].strip()
                    if value == "[DONE]":
                        done = True
                        continue
                    event = json.loads(value)
                    assert "error" not in event, event
                    if event.get("usage"):
                        usage = event["usage"]
                    for choice in event.get("choices", []):
                        text.append(choice.get("delta", {}).get("content") or "")
                        finish = choice.get("finish_reason") or finish
            report["second"] = {"status": 200, "seconds": round(time.monotonic() - start, 2),
                                "text": "".join(text), "usage": usage, "finish_reason": finish, "done": done}
            assert done and finish == "stop"
            assert re.fullmatch(r"BRIDGE_WORD_47:\s*42", "".join(text).strip())
            assert usage and usage["prompt_tokens"] > 0
            report["passed"] = True
    finally:
        server.should_exit = True
        thread.join(timeout=20)
        report["relay_stopped"] = not thread.is_alive()
        root = Path(__file__).resolve().parents[2]
        filename = "public-api-tool-roundtrip-streaming.json" if streaming_first else "public-api-tool-roundtrip.json"
        destination = root / "output/opencode-protocol-verification-2026-10-19" / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        assert not thread.is_alive(), "relay did not shut down"
