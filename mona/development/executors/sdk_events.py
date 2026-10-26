"""Normalize SDK display blocks; signatures and redacted payloads stay private."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, is_dataclass
from typing import Any

from mona.development.display_content import display_content
from mona.development.executors.base import NativeEvent
from mona.development.executors.host_tools import (
    HOST_SERVER,
    SDK_DESIGN_TOOL,
    SDK_HOST_TOOL,
    SDK_WORK_TOOL,
    WORK_SERVER,
    host_servers_valid,
)
from mona.development.executors.rpc import RpcError


def plain(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return value
    return vars(value) if hasattr(value, "__dict__") else {}


_REQUEST_USAGE_FIELDS = {
    "input_tokens": ("input_tokens", "inputTokens"),
    "cache_read_input_tokens": ("cache_read_input_tokens", "cacheReadInputTokens"),
    "cache_creation_input_tokens": ("cache_creation_input_tokens", "cacheCreationInputTokens"),
    "output_tokens": ("output_tokens", "outputTokens"),
}
_REQUEST_INPUT_FIELDS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _positive_int(value: Any) -> int | None:
    result = _nonnegative_int(value)
    return result if result else None


def _field(value: Any, *names: str) -> Any:
    record = plain(value)
    return next((record[name] for name in names if name in record), None)


class SDKEventProjector:
    def __init__(self, native_session_id: str, *, host_collaboration: bool = False,
                 work_tool: bool = False, resuming: bool = False, design_resources: bool = False):
        self.native_session_id = native_session_id
        self.resuming = resuming
        self.host_collaboration = host_collaboration
        self.design_resources = design_resources and not work_tool
        self.work_tool = work_tool
        self.host_tool = SDK_WORK_TOOL if work_tool else SDK_HOST_TOOL if host_collaboration else None
        self.allowed_host_tools = {name for name in (self.host_tool, SDK_DESIGN_TOOL if self.design_resources else None) if name}
        self.host_server = WORK_SERVER if work_tool else HOST_SERVER
        self.turn_id: str | None = None
        self.ordinal = 0
        self.item_id = ""
        self.streamed = False
        self.text_seen = False
        self.confirmed = False
        self.tool_ids: set[str] = set()
        self.tool_blocks: dict[int, dict[str, Any]] = {}
        # SDKs can split one streamed message into separate authoritative envelopes.
        self.streamed_tool_ids: set[str] = set()
        self.reasoning_blocks: dict[int, tuple[str, float]] = {}
        self.display_reasoning_blocks: set[int] = set()
        self.text_blocks: dict[int, str] = {}
        self.block_kinds: dict[int, str] = {}
        self.completed_blocks: set[int] = set()
        self.request_usage: dict[str, int] = {}
        self.context_tokens: int | None = None
        self.context_window: int | None = None
        self.primary_model: str | None = None
        self.finished = False
        self.uncertain = False

    def begin(self, turn_id: str) -> None:
        self.turn_id, self.ordinal, self.item_id = turn_id, 0, ""
        self.streamed, self.text_seen, self.finished = False, False, False
        self.uncertain = False
        self.tool_ids.clear()
        self.tool_blocks.clear()
        self.streamed_tool_ids.clear()
        self.reasoning_blocks.clear()
        self.display_reasoning_blocks.clear()
        self.text_blocks.clear()
        self.block_kinds.clear()
        self.completed_blocks.clear()
        self.request_usage.clear()
        self.context_tokens = self.context_window = None
        self.primary_model = None

    def _merge_request_usage(self, usage: Any, *, replace: bool = False) -> None:
        if replace:
            self.request_usage.clear()
            self.context_tokens = None
        values = plain(usage)
        if not isinstance(values, dict):
            return
        for field, aliases in _REQUEST_USAGE_FIELDS.items():
            value = next((values[name] for name in aliases if name in values), None)
            token_count = _nonnegative_int(value)
            if token_count is not None:
                self.request_usage[field] = token_count
        if any(field in self.request_usage for field in _REQUEST_INPUT_FIELDS):
            self.context_tokens = sum(self.request_usage.values())

    def _usage_event(self, identity: Any = None) -> list[NativeEvent]:
        payload = {}
        if self.context_tokens is not None:
            payload["contextTokens"] = self.context_tokens
        if self.context_window is not None:
            payload["contextWindow"] = self.context_window
        if not payload:
            return []
        event_id = f"usage:{identity}" if isinstance(identity, str) and identity else None
        return [self._event("usage.updated", payload, event_id)]

    def _update_context_window(self, data: dict[str, Any]) -> None:
        model_usage = _field(data, "modelUsage", "model_usage")
        usage_by_model = plain(model_usage)
        if not isinstance(usage_by_model, dict) or not self.primary_model:
            return
        model_usage_entry = plain(usage_by_model.get(self.primary_model))
        if not isinstance(model_usage_entry, dict):
            return
        context_window = _positive_int(_field(model_usage_entry, "contextWindow", "context_window"))
        if context_window is not None:
            self.context_window = context_window

    def _event(self, kind: str, data: dict, identity: str | None = None) -> NativeEvent:
        return NativeEvent(type=kind, payload=data, native_turn_id=self.turn_id,
                           native_event_id=identity)

    def consume(self, message: Any) -> list[NativeEvent]:
        data = plain(message)
        name = type(message).__name__
        kind = data.get("type") or {"SystemMessage": "system", "StreamEvent": "stream_event",
            "AssistantMessage": "assistant", "UserMessage": "user", "ResultMessage": "result",
            "ErrorMessage": "error"}.get(name)
        parent = data.get("parent_tool_use_id")
        if parent or kind == "system" and str(data.get("subtype", "")).startswith("task_"):
            # SDK background activity has its own lineage. It must not become the
            # next main turn's text or completion just because it arrived later.
            return []
        native_id = data.get("session_id") or (data.get("data", {}).get("session_id") if isinstance(data.get("data"), dict) else None)
        if native_id and native_id != self.native_session_id:
            raise RpcError("native_session_mismatch", "原生消息不属于当前会话。", outcome_unknown=True)
        if kind in {"assistant", "user", "stream_event", "result"} or kind == "system" and data.get("subtype") == "init":
            self.resuming = False
        if kind == "system" and data.get("subtype") == "init":
            details = data.get("data", data)
            servers = details.get("mcp_servers", [])
            if not host_servers_valid(servers, bool(self.allowed_host_tools), server=self.host_server):
                raise RpcError("native_policy_violation", "原生执行者加载了项目白名单之外的 MCP。", outcome_unknown=True)
            if not native_id:
                raise RpcError("native_identity_unconfirmed", "原生初始化消息缺少会话标识。", outcome_unknown=True)
            self.confirmed = True
            return [self._event("session.confirmed", {"nativeSessionId": native_id})]
        if not self.turn_id or self.finished:
            return []
        if kind == "error":
            if (self.resuming and not self.uncertain
                    and data.get("error") == f"No conversation found with session ID: {self.native_session_id}"):
                # Exact native pre-execution rejection, not a timeout or missing output.
                self.finished, self.resuming = True, False
                return [self._event("run.failed", {"status": "resume_rejected",
                    "errorCode": "native_session_not_found", "turnIdentitySource": "host_dispatch"}, "result:terminal")]
            # A transport/CLI error is not proof that work stopped. Keep reading
            # for the same turn's actual result, but do not authorize more tools.
            self.uncertain = True
            return [self._event("run.unknown", {"reason": "sdk_error_reported",
                "requiresReconciliation": True}, "error:reported")]
        if kind == "stream_event":
            event = data.get("event", {})
            if event.get("type") == "message_start":
                self.ordinal += 1
                message = plain(event.get("message", {}))
                self.item_id = str(message.get("id") or f"message-{self.ordinal}")
                self.streamed = True
                self.tool_blocks.clear()
                self.reasoning_blocks.clear()
                self.display_reasoning_blocks.clear()
                self.text_blocks.clear()
                self.block_kinds.clear()
                self.completed_blocks.clear()
                model = message.get("model")
                self.primary_model = model if isinstance(model, str) and model else None
                self._merge_request_usage(message.get("usage"), replace=True)
                return self._usage_event(data.get("uuid"))
            event_type = event.get("type")
            if event_type == "message_delta":
                self._merge_request_usage(event.get("usage"))
                return self._usage_event(data.get("uuid"))
            index = event.get("index")
            valid_index = isinstance(index, int) and not isinstance(index, bool) and index >= 0
            if event_type == "content_block_start" and valid_index and self.item_id and self.streamed:
                block = plain(event.get("content_block", {}))
                self.block_kinds[index] = str(block.get("type", ""))
                if block.get("type") == "text":
                    self.text_blocks[index] = f"{self.item_id}:text:{index}"
                    return []
                if block.get("type") in {"thinking", "redacted_thinking"}:
                    item_id = f"{self.item_id}:block:{index}"
                    self.reasoning_blocks[index] = (item_id, time.monotonic())
                    payload = {"itemId": item_id}
                    if block.get("type") == "thinking":
                        self.display_reasoning_blocks.add(index)
                        if isinstance(block.get("thinking"), str):
                            payload["text"] = block["thinking"]
                    return [self._event("reasoning.started", payload,
                                        str(data["uuid"]) if data.get("uuid") else None)]
                if block.get("type") == "tool_use":
                    tool_id, tool = block.get("id"), block.get("name", "")
                    if not isinstance(tool_id, str):
                        raise RpcError("native_tool_identity", "原生工具调用缺少标识。", outcome_unknown=True)
                    if (self.work_tool and tool != SDK_WORK_TOOL
                            or tool.startswith("mcp__") and tool not in self.allowed_host_tools):
                        raise RpcError("native_policy_violation", "检测到未授权的外部工具调用。", outcome_unknown=True)
                    arguments = block.get("input", {})
                    if not isinstance(arguments, dict):
                        arguments = {}
                    existing = self.tool_blocks.get(index)
                    if existing is None or existing["itemId"] != tool_id:
                        self.tool_blocks[index] = {"itemId": tool_id, "name": tool,
                            "arguments": arguments, "partial": "", "seenDeltaIds": set()}
                    self.tool_ids.add(tool_id)
                    self.streamed_tool_ids.add(tool_id)
                    return [self._event("tool.started", {"itemId": tool_id, "name": tool,
                        "arguments": arguments, "inputStreaming": True}, tool_id + ":started")]
            if event_type == "content_block_stop" and valid_index:
                started = self.reasoning_blocks.pop(index, None)
                if started is not None:
                    item_id, started_at = started
                    duration = max(0, round((time.monotonic() - started_at) * 1000))
                    return [self._event("reasoning.completed", {"itemId": item_id, "durationMs": duration},
                                        str(data["uuid"]) if data.get("uuid") else None)]
            delta = event.get("delta", {})
            if event_type == "content_block_delta" and delta.get("type") == "thinking_delta" and valid_index:
                started = self.reasoning_blocks.get(index)
                if started is not None and index in self.display_reasoning_blocks and isinstance(delta.get("thinking"), str):
                    return [self._event("reasoning.delta", {"itemId": started[0], "delta": delta["thinking"]},
                                        str(data["uuid"]) if data.get("uuid") else None)]
                return []
            if event_type == "content_block_delta" and delta.get("type") == "input_json_delta" and valid_index:
                block = self.tool_blocks.get(index)
                partial = delta.get("partial_json")
                if block is not None and isinstance(partial, str):
                    identity = data.get("uuid")
                    seen = block["seenDeltaIds"]
                    if not identity or identity not in seen:
                        if identity:
                            seen.add(identity)
                        block["partial"] += partial
                        return [self._event("tool.input.delta", {"itemId": block["itemId"],
                            "delta": partial}, str(identity) if identity else None)]
                return []
            if event_type == "content_block_stop" and valid_index:
                block = self.tool_blocks.get(index)
                if block is not None and block["partial"]:
                    try:
                        arguments = json.loads(block["partial"])
                    except json.JSONDecodeError:
                        arguments = None
                    if isinstance(arguments, dict) and arguments != block["arguments"]:
                        block["arguments"] = arguments
                        tool_id = block["itemId"]
                        return [self._event("tool.started", {"itemId": tool_id,
                            "name": block["name"], "arguments": arguments, "inputStreaming": False},
                            tool_id + ":input-completed")]
            if event.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                if not self.item_id or not self.streamed:
                    raise RpcError("native_stream_order", "原生文本片段缺少消息边界。", outcome_unknown=True)
                text_id = self.text_blocks.setdefault(index, f"{self.item_id}:text:{index}") if valid_index else self.item_id
                if valid_index:
                    self.block_kinds.setdefault(index, "text")
                return [self._event("agent.message.delta", {"itemId": text_id, "delta": delta.get("text", "")},
                                    str(data["uuid"]) if data.get("uuid") else None)]
            return []
        if kind == "assistant":
            if not self.streamed:
                self.ordinal += 1
                self.item_id = f"message-{self.ordinal}"
            model = data.get("model")
            if isinstance(model, str) and model:
                self.primary_model = model
            blocks = [plain(b) for b in data.get("content", [])]
            public_blocks = [dict(b, type="text") if not b.get("type") and "text" in b and "thinking" not in b else b for b in blocks]
            indices = {}
            for index, block in enumerate(public_blocks):
                kind = block.get("type") or ("thinking" if "thinking" in block else
                        "tool_use" if {"id", "name", "input"}.issubset(block) else "")
                candidates = [i for i, value in self.block_kinds.items()
                              if value == kind and i not in self.completed_blocks and i not in indices.values()]
                if kind == "tool_use":
                    matched = next((i for i, value in self.tool_blocks.items() if value["itemId"] == block.get("id")), None)
                elif len(blocks) >= len(self.block_kinds) and self.block_kinds.get(index) == kind:
                    matched = index
                else:
                    matched = min(candidates) if candidates else next((i for i, value in self.block_kinds.items() if value == kind), None)
                indices[index] = matched if matched is not None else index
            self.completed_blocks.update(indices.values())
            text, media = display_content(public_blocks)
            result = []
            for index, block in enumerate(blocks) if not self.text_blocks else []:
                if isinstance(block.get("thinking"), str) and block.get("type", "thinking") == "thinking":
                    reasoning_id = f"{self.item_id}:block:{indices[index]}"
                    result.append(self._event("reasoning.completed", {"itemId": reasoning_id,
                        "text": block["thinking"]}, reasoning_id + ":authoritative"))
            if (text or media) and not self.text_blocks:
                self.text_seen = True
                payload = {"itemId": self.item_id, "text": text}
                if media:
                    payload["content"] = [b for b in public_blocks if b.get("type") in {"text", "output_text", "input_text", "image", "image_url", "input_image", "audio", "video", "document", "file"}]
                result.append(self._event("agent.message.completed", payload, self.item_id + ":completed"))
            for index, block in enumerate(blocks):
                if self.text_blocks:
                    # Preserve the SDK content-block order. Text before and after
                    # a tool call must not collapse into one row before that tool.
                    if isinstance(block.get("thinking"), str) and block.get("type", "thinking") == "thinking":
                        reasoning_id = f"{self.item_id}:block:{indices[index]}"
                        result.append(self._event("reasoning.completed", {"itemId": reasoning_id,
                            "text": block["thinking"]}, reasoning_id + ":authoritative"))
                    block_text, block_media = display_content([public_blocks[index]])
                    if block_text or block_media:
                        self.text_seen = True
                        source_index = indices[index]
                        text_id = self.text_blocks.get(source_index, f"{self.item_id}:text:{source_index}")
                        payload = {"itemId": text_id, "text": block_text}
                        if block_media:
                            payload["content"] = [public_blocks[index]]
                        result.append(self._event("agent.message.completed", payload, text_id + ":completed"))
                if not (block.get("type") == "tool_use" or {"id", "name", "input"}.issubset(block)):
                    continue
                tool_id, tool = block.get("id"), block.get("name", "")
                if not isinstance(tool_id, str):
                    raise RpcError("native_tool_identity", "原生工具调用缺少标识。", outcome_unknown=True)
                if (self.work_tool and tool != SDK_WORK_TOOL
                        or tool.startswith("mcp__") and tool not in self.allowed_host_tools):
                    raise RpcError("native_policy_violation", "检测到未授权的外部工具调用。", outcome_unknown=True)
                self.tool_ids.add(tool_id)
                streamed = tool_id in self.streamed_tool_ids
                result.append(self._event("tool.started", {"itemId": tool_id, "name": tool,
                    "arguments": block.get("input", {}), "inputStreaming": False}, tool_id + (":authoritative" if streamed else ":started")))
            if not self.block_kinds:
                self.streamed = False
            return result
        if kind == "user":
            blocks = data.get("content", [])
            if not isinstance(blocks, list):
                return []
            result = []
            for value in blocks:
                block = plain(value)
                tool_id = block.get("tool_use_id")
                if tool_id not in self.tool_ids:
                    continue
                content = block.get("content", "")
                if not isinstance(content, str):
                    content = "\n".join(str(plain(b).get("text", "")) for b in content) if isinstance(content, list) else ""
                result.append(self._event("tool.completed", {"itemId": tool_id, "content": content,
                    "isError": bool(block.get("is_error"))}, str(tool_id) + ":completed"))
            if result and self.completed_blocks.issuperset(self.block_kinds):
                self.streamed = False
                self.tool_blocks.clear()
                self.reasoning_blocks.clear()
                self.display_reasoning_blocks.clear()
                self.text_blocks.clear()
                self.block_kinds.clear()
                self.completed_blocks.clear()
            return result
        if kind == "result":
            if not native_id:
                raise RpcError("native_identity_unconfirmed", "执行结果未确认原生会话身份。", outcome_unknown=True)
            self.confirmed = True
            self._update_context_window(data)
            result = []
            if not self.text_seen and isinstance(data.get("result"), str) and data["result"]:
                result.append(self._event("agent.message.completed", {"itemId": "result", "text": data["result"]}, "result:message"))
            usage_payload = {"usage": data.get("usage"), "durationMs": data.get("duration_ms")}
            if self.context_tokens is not None:
                usage_payload["contextTokens"] = self.context_tokens
            if self.context_window is not None:
                usage_payload["contextWindow"] = self.context_window
            result.append(self._event("usage.updated", usage_payload, "result:usage"))
            subtype = data.get("subtype", "")
            if subtype in {"interrupted", "cancelled"}:
                terminal = "run.interrupted"
            elif data.get("is_error") is True:
                terminal = "run.failed"
            elif subtype == "success" and data.get("is_error") is False:
                terminal = "run.completed"
            else:
                terminal = "run.unknown"
            result.append(self._event(terminal, {"status": subtype,
                "errorCode": "native_execution_failed" if data.get("is_error") else None,
                "turnIdentitySource": "host_dispatch"}, "result:terminal"))
            self.uncertain = terminal == "run.unknown"
            self.finished = True
            return result
        return []
