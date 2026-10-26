import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from test_relay import relay_client


class ToolHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        index = len(self.server.requests)
        self.server.requests.append((self.path, body))
        exchanges = self.server.exchanges
        if index >= len(exchanges) or body != exchanges[index]["body"] or self.path != "/v1/chat/completions":
            self.send_response(409)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        response = b"".join(exchanges[index]["frames"])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        for offset in range(0, len(response), 11):
            self.wfile.write(response[offset:offset + 11])
            self.wfile.flush()


@pytest.fixture
def tool_upstream():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ToolHandler)
    server.daemon_threads = True
    server.base_url = f"http://127.0.0.1:{server.server_port}/v1"
    server.requests = []
    server.exchanges = []
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def sse_frame(delta=None, finish_reason=None, usage=None):
    event = {
        "id": "tool-contract-completion",
        "object": "chat.completion.chunk",
        "model": "example-model",
        "choices": [] if usage else [{"index": 0, "delta": delta or {}, "finish_reason": finish_reason}],
    }
    if usage:
        event["usage"] = usage
    return ("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode()


async def receive_events(client, body):
    events = []
    done = False
    async with client.stream(
        "POST", "/v1/chat/completions", content=body, headers={"Content-Type": "application/json"},
    ) as response:
        assert response.status_code == 200
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                if line == "data: [DONE]":
                    done = True
                else:
                    assert not done
                    events.append(json.loads(line[6:]))
    assert done
    return events


async def test_external_tool_round_trip_preserves_history_reasoning_usage_and_extensions(tool_upstream):
    tool_name = "client_sum_" + secrets.token_hex(6)
    tool_id = "call_" + secrets.token_hex(6)
    history = [
        {"role": "system", "content": "工具由调用方执行；请保留会话约定。"},
        {"role": "user", "content": "上一轮的标签是合计。"},
        {"role": "assistant", "content": "已记住标签：合计。"},
        {"role": "user", "content": "请用工具计算 7 加 5，并给出结果。"},
    ]
    request = {
        "model": "example-model",
        "messages": history,
        "tools": [{"type": "function", "function": {
            "name": tool_name,
            "description": "A safe sum executed in caller memory.",
            "parameters": {
                "type": "object", "properties": {"left": {"type": "integer"}, "right": {"type": "integer"}},
                "required": ["left", "right"], "additionalProperties": False,
            },
        }}],
        "tool_choice": {"type": "function", "function": {"name": tool_name}},
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": 0.125,
        "vendor_extension": {"nested": {"preserve": [True, None, "原样"]}},
    }
    first_body = json.dumps(request, ensure_ascii=False, indent=2).encode()
    first_usage = {"prompt_tokens": 40, "completion_tokens": 18, "total_tokens": 58,
                   "completion_tokens_details": {"reasoning_tokens": 3}}
    tool_upstream.exchanges.append({"body": first_body, "frames": [
        sse_frame({"role": "assistant", "reasoning_content": "需要使用"}),
        sse_frame({"reasoning_content": "客户端工具。", "tool_calls": [{
            "index": 0, "id": tool_id, "type": "function",
            "function": {"name": tool_name, "arguments": '{"left":'},
        }]}),
        sse_frame({"tool_calls": [{"index": 0, "function": {"arguments": '7,"right":'}}]}),
        sse_frame({"tool_calls": [{"index": 0, "function": {"arguments": "5}"}}]}),
        sse_frame(finish_reason="tool_calls"),
        sse_frame(usage=first_usage),
        b"data: [DONE]\n\n",
    ]})
    client_executions = []

    def execute_in_client(left, right):
        client_executions.append({"left": left, "right": right})
        return {"sum": left + right}

    async with relay_client(tool_upstream) as (client, _):
        events = await receive_events(client, first_body)
        calls = {}
        reasoning = ""
        finish_reasons = []
        usages = []
        for event in events:
            if "usage" in event:
                usages.append(event["usage"])
            for choice in event["choices"]:
                reasoning += choice["delta"].get("reasoning_content", "")
                if choice["finish_reason"]:
                    finish_reasons.append(choice["finish_reason"])
                for fragment in choice["delta"].get("tool_calls", []):
                    call = calls.setdefault(fragment["index"], {
                        "id": "", "type": "function", "function": {"name": "", "arguments": ""},
                    })
                    call["id"] += fragment.get("id", "")
                    for field in ("name", "arguments"):
                        call["function"][field] += fragment.get("function", {}).get(field, "")
        assert reasoning == "需要使用客户端工具。"
        assert finish_reasons == ["tool_calls"]
        assert usages == [first_usage]
        assert len(tool_upstream.requests) == 1
        assert client_executions == []
        assert list(calls) == [0]
        call = calls[0]
        assert call["id"] == tool_id
        assert call["function"]["name"] == tool_name
        arguments = json.loads(call["function"]["arguments"])
        assert arguments == {"left": 7, "right": 5}
        result = execute_in_client(**arguments)
        assert client_executions == [{"left": 7, "right": 5}]
        second_request = {
            **request,
            "messages": [*history, {
                "role": "assistant", "content": None, "reasoning_content": reasoning, "tool_calls": [call],
            }, {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)}],
            "tool_choice": "auto",
        }
        second_body = json.dumps(second_request, ensure_ascii=False, indent=2).encode()
        final_usage = {"prompt_tokens": 72, "completion_tokens": 9, "total_tokens": 81}
        tool_upstream.exchanges.append({"body": second_body, "frames": [
            sse_frame({"role": "assistant", "content": "合计："}),
            sse_frame({"content": "12。"}),
            sse_frame(finish_reason="stop"),
            sse_frame(usage=final_usage),
            b"data: [DONE]\n\n",
        ]})
        final_events = await receive_events(client, second_body)
        assert "".join(choice["delta"].get("content", "")
                       for event in final_events for choice in event["choices"]) == "合计：12。"
        assert [choice["finish_reason"] for event in final_events for choice in event["choices"]
                if choice["finish_reason"]] == ["stop"]
        assert [event["usage"] for event in final_events if "usage" in event] == [final_usage]
        assert tool_upstream.requests == [
            ("/v1/chat/completions", first_body), ("/v1/chat/completions", second_body),
        ]
