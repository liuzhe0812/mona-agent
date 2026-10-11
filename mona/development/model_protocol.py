"""Native engine wire formats around Mona's existing provider contract."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from mona.providers.base import LLMResponse


class ModelProtocolError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid_request_error", status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def _text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _content(value: Any, *, anthropic: bool = False) -> str | list[dict]:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        raise ModelProtocolError("模型输入格式不受支持")
    blocks = []
    for block in value:
        kind = block.get("type") if isinstance(block, dict) else None
        if kind in {"text", "input_text", "output_text"}:
            blocks.append({"type": "text", "text": block.get("text", "")})
        elif kind == "input_image":
            url = block.get("image_url")
            if not isinstance(url, str):
                raise ModelProtocolError("图片输入缺少可用内容")
            blocks.append({"type": "image_url", "image_url": {"url": url, "detail": block.get("detail", "auto")}})
        elif kind == "image" and anthropic:
            source = block.get("source", {})
            if source.get("type") == "base64":
                url = f"data:{source['media_type']};base64,{source['data']}"
            elif source.get("type") == "url":
                url = source["url"]
            else:
                raise ModelProtocolError("图片输入格式不受支持")
            blocks.append({"type": "image_url", "image_url": {"url": url}})
        else:
            raise ModelProtocolError("当前引擎包含尚不支持的输入内容")
    return blocks


@dataclass
class ModelInput:
    messages: list[dict] = field(default_factory=list)
    tools: list[dict] = field(default_factory=list)
    tool_names: dict[str, dict] = field(default_factory=dict)
    tool_choice: str | dict | None = None
    attachments: list[dict] = field(default_factory=list)

    def flush_attachments(self) -> None:
        if self.attachments:
            self.messages.append({"role": "user", "content": self.attachments})
            self.attachments = []

    def tool_result(self, identifier: str, content: str | list[dict]) -> None:
        if isinstance(content, list) and any(block["type"] == "image_url" for block in content):
            images = [block for block in content if block["type"] == "image_url"]
            content = [block for block in content if block["type"] == "text"] or "工具返回了图片，见后续内容。"
            self.attachments.extend([{"type": "text", "text": f"工具 {identifier} 返回的图片："}, *images])
        self.messages.append({"role": "tool", "tool_call_id": identifier, "content": content})

    def message(self, role: str, content: str | list) -> None:
        self.flush_attachments()
        if role == "assistant" and self.messages and self.messages[-1]["role"] == role:
            target = self.messages[-1]
            previous = target.get("content") or []
            target["content"] = (previous if isinstance(previous, list) else [{"type": "text", "text": previous}]) + (
                content if isinstance(content, list) else [{"type": "text", "text": content}])
        else:
            self.messages.append({"role": role, "content": content})

    def reasoning(self, text: str, blocks: list[dict] | None = None) -> None:
        self.flush_attachments()
        if not self.messages or self.messages[-1]["role"] != "assistant":
            self.messages.append({"role": "assistant", "content": None})
        target = self.messages[-1]
        target["reasoning_content"] = target.get("reasoning_content", "") + text
        if blocks:
            target.setdefault("thinking_blocks", []).extend(blocks)

    def alias(self, name: str, namespace: str | None = None) -> str:
        full = f"{namespace}.{name}" if namespace else name
        return full if re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", full) else "tool_" + hashlib.sha256(full.encode()).hexdigest()[:32]

    def add_tools(self, tools: list[dict], namespace: str | None = None, *, anthropic: bool = False) -> None:
        for tool in tools:
            kind = tool.get("type", "function")
            if anthropic and kind == "custom":
                kind = "function"
            if kind == "namespace":
                self.add_tools(tool.get("tools", []), tool["name"])
                continue
            if kind not in {"function", "custom"}:
                raise ModelProtocolError("当前引擎请求了尚不支持的托管工具")
            name = tool["name"]
            alias = self.alias(name, namespace)
            if alias in self.tool_names:
                raise ModelProtocolError("模型工具名称重复")
            self.tool_names[alias] = {"name": name, "namespace": namespace, "custom": kind == "custom"}
            schema = ({"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"],
                       "additionalProperties": False} if kind == "custom" else
                      tool.get("input_schema" if anthropic else "parameters", {"type": "object", "properties": {}}))
            self.tools.append({"type": "function", "function": {"name": alias,
                "description": tool.get("description", ""), "parameters": schema}})

    def call(self, identifier: str, name: str, arguments: str, namespace: str | None = None) -> None:
        self.flush_attachments()
        if not self.messages or self.messages[-1]["role"] != "assistant":
            self.messages.append({"role": "assistant", "content": None})
        self.messages[-1].setdefault("tool_calls", []).append({"id": identifier, "type": "function",
            "function": {"name": self.alias(name, namespace), "arguments": arguments}})


def responses_input(body: dict) -> ModelInput:
    if body.get("previous_response_id"):
        raise ModelProtocolError("该模型来源需要完整会话内容")
    if body.get("text", {}).get("format", {}).get("type", "text") != "text":
        raise ModelProtocolError("当前兼容模式暂不支持指定输出格式")
    result = ModelInput()
    result.add_tools(body.get("tools") or [])
    system = [body["instructions"]] if body.get("instructions") else []
    inputs = body.get("input", [])
    if isinstance(inputs, str):
        inputs = [{"role": "user", "content": inputs}]
    for item in inputs:
        kind = item.get("type", "message")
        if kind == "message":
            role = item.get("role", "user")
            content = _content(item.get("content", ""))
            if role in {"system", "developer"}:
                system.append(content if isinstance(content, str) else "\n".join(block["text"] for block in content if block["type"] == "text"))
            elif role in {"user", "assistant"}:
                result.message(role, content)
            else:
                raise ModelProtocolError("模型消息角色无效")
        elif kind in {"function_call", "custom_tool_call"}:
            arguments = item.get("arguments", "{}") if kind == "function_call" else json.dumps({"input": item.get("input", "")})
            result.call(item["call_id"], item["name"], arguments, item.get("namespace"))
        elif kind in {"function_call_output", "custom_tool_call_output"}:
            output = item.get("output", "")
            result.tool_result(item["call_id"], _content(output) if isinstance(output, list) else _text(output))
        elif kind == "reasoning":
            summary = "\n".join(part.get("text", "") for part in item.get("summary", []))
            opaque = item.get("encrypted_content", "")
            blocks = None
            if isinstance(opaque, str) and opaque.startswith("mona-thinking-v1:"):
                try:
                    blocks = json.loads(base64.urlsafe_b64decode(opaque.removeprefix("mona-thinking-v1:")))
                    if not isinstance(blocks, list) or any(not isinstance(block, dict) or block.get("type") != "thinking"
                            or not isinstance(block.get("signature"), str) for block in blocks):
                        raise ValueError
                except (ValueError, TypeError):
                    raise ModelProtocolError("模型思考记录格式无效") from None
            if summary or blocks:
                result.reasoning(summary, blocks)
        else:
            raise ModelProtocolError("当前会话包含无法转换的模型历史")
    result.flush_attachments()
    if system:
        result.messages.insert(0, {"role": "system", "content": "\n\n".join(system)})
    choice = body.get("tool_choice")
    if choice in ("auto", "none", "required"):
        result.tool_choice = choice
    elif isinstance(choice, dict) and choice.get("name"):
        result.tool_choice = {"type": "function", "function": {"name": result.alias(choice["name"], choice.get("namespace"))}}
    return result


def messages_input(body: dict) -> ModelInput:
    if body.get("output_config", {}).get("format"):
        raise ModelProtocolError("当前兼容模式暂不支持指定输出格式")
    result = ModelInput()
    result.add_tools(body.get("tools") or [], anthropic=True)
    system = body.get("system")
    if system:
        content = _content(system, anthropic=True)
        result.messages.append({"role": "system", "content": content if isinstance(content, str) else "\n".join(part["text"] for part in content)})
    for message in body.get("messages", []):
        role = message["role"]
        if role not in {"user", "assistant"}:
            raise ModelProtocolError("模型消息角色无效")
        content = message.get("content", "")
        if isinstance(content, str):
            result.message(role, content)
            continue
        for block in content:
            kind = block.get("type")
            if kind == "tool_use":
                result.call(block["id"], block["name"], json.dumps(block.get("input", {}), ensure_ascii=False))
            elif kind == "tool_result":
                output = block.get("content", "")
                result.tool_result(block["tool_use_id"], _content(output, anthropic=True))
            elif kind == "thinking":
                result.reasoning(block.get("thinking", ""), [block] if block.get("signature") else None)
            elif kind == "redacted_thinking":
                continue
            else:
                result.message(role, _content([block], anthropic=True))
    result.flush_attachments()
    choice = body.get("tool_choice", {})
    if isinstance(choice, dict):
        if choice.get("type") in {"auto", "none", "any"}:
            result.tool_choice = "required" if choice["type"] == "any" else choice["type"]
        elif choice.get("type") == "tool":
            result.tool_choice = {"type": "function", "function": {"name": result.alias(choice["name"])}}
    return result


class ModelOutput:
    def __init__(self, protocol: str, model: str, names: dict[str, dict], emit: Callable[[str, dict], Awaitable[None]]):
        self.protocol, self.model, self.names, self.emit = protocol, model, names, emit
        self.identifier = "resp_" + uuid4().hex
        self.output: list[dict] = []
        self.text = ""
        self.reasoning = ""
        self.text_index: int | None = None
        self.sequence = 0

    def response(self, status: str, usage: dict | None = None) -> dict:
        return {"id": self.identifier, "object": "response", "created_at": int(time.time()), "status": status,
                "model": self.model, "output": self.output, "usage": usage, "error": None}

    async def event(self, kind: str, **data) -> None:
        self.sequence += 1
        await self.emit(kind, {"type": kind, **data, **({"sequence_number": self.sequence} if self.protocol == "responses" else {})})

    async def start(self) -> None:
        if self.protocol == "responses":
            await self.event("response.created", response=self.response("in_progress"))
        else:
            await self.event("message_start", message={"id": self.identifier, "type": "message", "role": "assistant",
                "model": self.model, "content": [], "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0}})

    async def delta(self, text: str) -> None:
        if not text:
            return
        if self.protocol == "messages":
            self.text += text
            return
        if self.text_index is None:
            self.text_index = len(self.output)
            item = {"id": "msg_" + uuid4().hex, "type": "message", "role": "assistant", "status": "in_progress", "content": []}
            self.output.append(item)
            await self.event("response.output_item.added", output_index=self.text_index, item=item)
            await self.event("response.content_part.added", output_index=self.text_index, item_id=item["id"], content_index=0,
                             part={"type": "output_text", "text": "", "annotations": []})
        self.text += text
        await self.event("response.output_text.delta", output_index=self.text_index, item_id=self.output[self.text_index]["id"], content_index=0, delta=text)

    async def thinking_delta(self, text: str) -> None:
        self.reasoning += text

    async def finish(self, response: LLMResponse) -> dict:
        for call in response.tool_calls if response.should_execute_tools else []:
            name = self.names.get(call.name)
            if name is None or name["custom"] and not isinstance(call.arguments.get("input"), str):
                raise ModelProtocolError("模型返回的工具或参数无效，未执行")
        thoughts = response.thinking_blocks or []
        reasoning = response.reasoning_content or self.reasoning or "\n".join(block.get("thinking", "") for block in thoughts)
        if reasoning or thoughts:
            index = len(self.output)
            if self.protocol == "responses":
                item = {"id": "rs_" + uuid4().hex, "type": "reasoning", "summary": [{"type": "summary_text", "text": reasoning}]}
                if thoughts:
                    # Responses preserves this opaque field in native history. It
                    # carries the upstream signed blocks, not newly invented signatures.
                    item["encrypted_content"] = "mona-thinking-v1:" + base64.urlsafe_b64encode(json.dumps(thoughts, ensure_ascii=False).encode()).decode()
                self.output.append(item)
                await self.event("response.output_item.added", output_index=index, item={**item, "summary": []})
                await self.event("response.reasoning_summary_text.delta", output_index=index, item_id=item["id"], summary_index=0, delta=reasoning)
                await self.event("response.reasoning_summary_text.done", output_index=index, item_id=item["id"], summary_index=0, text=reasoning)
                await self.event("response.output_item.done", output_index=index, item=item)
            else:
                for block in thoughts or [{"type": "thinking", "thinking": reasoning, "signature": ""}]:
                    index = len(self.output)
                    self.output.append(block)
                    await self.event("content_block_start", index=index, content_block={"type": "thinking", "thinking": "", "signature": ""})
                    await self.event("content_block_delta", index=index, delta={"type": "thinking_delta", "thinking": block.get("thinking", "")})
                    if block.get("signature"):
                        await self.event("content_block_delta", index=index, delta={"type": "signature_delta", "signature": block["signature"]})
                    await self.event("content_block_stop", index=index)
        if not self.text and response.content:
            await self.delta(response.content)
        if self.protocol == "messages" and self.text:
            self.text_index = len(self.output)
            self.output.append({"type": "text", "text": self.text})
            await self.event("content_block_start", index=self.text_index, content_block={"type": "text", "text": ""})
            await self.event("content_block_delta", index=self.text_index, delta={"type": "text_delta", "text": self.text})
        if self.text_index is not None:
            item = self.output[self.text_index]
            if self.protocol == "responses":
                part = {"type": "output_text", "text": self.text, "annotations": []}
                item.update(status="completed", content=[part])
                await self.event("response.output_text.done", output_index=self.text_index, item_id=item["id"], content_index=0, text=self.text)
                await self.event("response.content_part.done", output_index=self.text_index, item_id=item["id"], content_index=0, part=part)
                await self.event("response.output_item.done", output_index=self.text_index, item=item)
            else:
                item["text"] = self.text
                await self.event("content_block_stop", index=self.text_index)
        for call in response.tool_calls if response.should_execute_tools else []:
            name = self.names.get(call.name)
            if name is None:
                raise ModelProtocolError("模型返回了未声明的工具，未执行")
            index = len(self.output)
            arguments = json.dumps(call.arguments, ensure_ascii=False)
            if self.protocol == "responses":
                custom = name["custom"]
                value = call.arguments.get("input") if custom else arguments
                if not isinstance(value, str):
                    raise ModelProtocolError("模型返回的工具参数无效，未执行")
                field = "input" if custom else "arguments"
                kind = "custom_tool_call" if custom else "function_call"
                item = {"id": "fc_" + uuid4().hex, "type": kind, "call_id": call.id,
                        "name": name["name"], field: "", "status": "in_progress"}
                if name["namespace"]:
                    item["namespace"] = name["namespace"]
                await self.event("response.output_item.added", output_index=index, item=item.copy())
                prefix = "response.custom_tool_call_input" if custom else "response.function_call_arguments"
                await self.event(prefix + ".delta", output_index=index, item_id=item["id"], delta=value)
                await self.event(prefix + ".done", output_index=index, item_id=item["id"], **{field: value})
                item.update({field: value, "status": "completed"})
                self.output.append(item)
                await self.event("response.output_item.done", output_index=index, item=item)
            else:
                item = {"type": "tool_use", "id": call.id, "name": name["name"], "input": call.arguments}
                self.output.append(item)
                await self.event("content_block_start", index=index, content_block={**item, "input": {}})
                await self.event("content_block_delta", index=index, delta={"type": "input_json_delta", "partial_json": arguments})
                await self.event("content_block_stop", index=index)
        usage = {"input_tokens": response.usage.get("prompt_tokens", 0), "output_tokens": response.usage.get("completion_tokens", 0)}
        if self.protocol == "responses":
            usage["total_tokens"] = usage["input_tokens"] + usage["output_tokens"]
            result = self.response("incomplete" if response.finish_reason == "length" else "completed", usage)
            if response.finish_reason == "length":
                result["incomplete_details"] = {"reason": "max_output_tokens"}
            await self.event("response.incomplete" if response.finish_reason == "length" else "response.completed", response=result)
        else:
            stop = "tool_use" if response.should_execute_tools else "max_tokens" if response.finish_reason == "length" else "end_turn"
            result = {"id": self.identifier, "type": "message", "role": "assistant", "model": self.model,
                      "content": self.output, "stop_reason": stop, "stop_sequence": None, "usage": usage}
            await self.event("message_delta", delta={"stop_reason": stop, "stop_sequence": None}, usage=usage)
            await self.event("message_stop")
        return result
