"""Reuse the desktop image tool with run-scoped billing and hosted delivery."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
from contextvars import ContextVar
from urllib.parse import urlsplit

import httpx

from mona.agent.runner import AgentRunner
from mona.agent.tools.image_generation import ImageGenerationToolConfig
from mona.config.schema import HostedWorkImageSettings, ProviderConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.image_generation import HostedImageGenerationTool
from mona.hosted_work.sandbox_files import relative_path
from mona.providers.image_generation import (
    GeneratedImageResponse,
    ImageGenerationError,
    OpenAIImageGenerationClient,
)
from mona.utils.helpers import detect_image_mime

_CALL_ID: ContextVar[str | None] = ContextVar("hosted_image_call_id", default=None)
_IMAGE_CALL: ContextVar[object | None] = ContextVar("hosted_image_call", default=None)


class _RemoteCodexImage(OpenAIImageGenerationClient):
    """The real provider runs in the parent, where its credentials remain."""

    def __init__(self, runtime):
        super().__init__(api_key=None)
        self.runtime = runtime

    async def generate(self, *, prompt, model, reference_images=None, aspect_ratio=None, image_size=None):
        call = _IMAGE_CALL.get()
        if call is None or reference_images:
            raise ImageGenerationError("图片编辑暂不可用。", code="IMAGE_GENERATION_UNAVAILABLE")
        result = await self.runtime._post("image_generate", {
            "capability": self.runtime.capability, "operation": call.operation_id,
            "fingerprint": call.request_fingerprint, "prompt": prompt, "model": model,
            "aspect_ratio": aspect_ratio, "image_size": image_size,
        })
        image = result.get("image")
        if (not isinstance(image, dict) or image.get("mime") not in {"image/png", "image/jpeg", "image/webp"}
                or not isinstance(image.get("data"), str)
                or len(image["data"]) > 4 * ((self.runtime.config.max_file_bytes + 2) // 3)):
            raise ImageGenerationError("图片结果待核对。", code="result_unknown")
        try:
            raw = base64.b64decode(image["data"], validate=True)
        except ValueError:
            raise ImageGenerationError("图片结果待核对。", code="result_unknown") from None
        if (not 0 < len(raw) <= self.runtime.config.max_file_bytes or len(raw) != image.get("size")
                or hashlib.sha256(raw).hexdigest() != image.get("sha256") or detect_image_mime(raw) != image["mime"]):
            raise ImageGenerationError("图片结果待核对。", code="result_unknown")
        data_url = "data:" + image["mime"] + ";base64," + image["data"]
        return GeneratedImageResponse(images=[data_url], content="", raw={"status": result.get("status")})


class ImageRuntime:
    def __init__(self, config, payload: dict, sandbox, tools, *, operation_scope: str | None = None):
        self.config, self.payload, self.sandbox, self.tools = config, payload, sandbox, tools
        self.owner, self.session, self.run = payload["owner"], identifier(payload["session_id"]), identifier(payload["run_id"])
        if operation_scope is not None and (not isinstance(operation_scope, str)
                                            or not re.fullmatch(r"[a-f0-9]{32}", operation_scope)):
            raise ValueError("invalid image operation scope")
        self.operation_scope = operation_scope
        image = payload.get("hosted_image")
        if not isinstance(image, dict) or set(image) != {"settings", "capability"}:
            raise WorkError("image_unavailable", "图片服务暂不可用。", 503)
        self.settings = HostedWorkImageSettings.model_validate(image["settings"])
        self.capability = image["capability"]
        if not isinstance(self.capability, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", self.capability):
            raise WorkError("image_unavailable", "图片服务暂不可用。", 503)
        host, origin = private_listener(config.bind_host), website_origin(config)
        authority = f"[{host}]" if ":" in host else host
        self.rpc_url = f"http://{authority}:{config.port}/api/work/internal/image"
        self.headers = {"Host": urlsplit(origin).netloc, "Origin": origin}

    async def close(self):
        pass

    def _operation(self, index: int) -> str:
        call_id = _CALL_ID.get()
        if not isinstance(call_id, str) or not call_id or type(index) is not int or index < 0:
            raise ValueError("image tool identity is unavailable")
        if self.operation_scope is None:
            # Preserve existing parent operation IDs for billing/recovery.
            identity = ["hosted-image-v1", self.owner, self.run, call_id, index]
        else:
            # A provider may reuse the same tool-call ID in concurrent children.
            identity = ["hosted-image-child-v1", self.owner, self.session, self.run,
                        self.operation_scope, call_id, index]
        value = json.dumps(identity, separators=(",", ":"))
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]

    async def _post(self, command: str, arguments: dict) -> dict:
        body = {"owner": self.owner, "run_id": self.run, "session_id": self.session, "command": command, "args": arguments}
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                         timeout=self.config.tool_timeout_seconds + 60) as client:
                async with client.stream("POST", self.rpc_url, headers=self.headers, json=body) as response:
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        limit = 4 * ((self.config.max_file_bytes + 2) // 3) + 65536 if command == "image_generate" else 16384
                        if len(data) > limit:
                            raise ValueError("invalid image reply")
                    if response.status_code == 402:
                        raise ImageGenerationError("账号余额不足，请充值后继续。", code="insufficient_credits")
                    if response.status_code != 200:
                        raise ValueError("image operation unavailable")
            value = json.loads(data)
            if not isinstance(value, dict) or not isinstance(value.get("result"), dict):
                raise ValueError("invalid image reply")
            return value["result"]
        except ImageGenerationError:
            raise
        except (httpx.HTTPError, ValueError, TypeError):
            raise ImageGenerationError("图片操作状态待核对，请勿重复生成。", code="result_unknown") from None

    async def _unknown(self, operation: str, *, usage_missing: bool = False):
        try:
            await self._post("image_uncertain", {"capability": self.capability, "operation": operation,
                                                  "usage_missing": usage_missing})
        except (ImageGenerationError, asyncio.CancelledError):
            pass

    async def wrap(self, call, invoke):
        if ((call.image_size and call.image_size.strip().upper() != "1K")
                or (call.aspect_ratio and call.aspect_ratio != "1:1")):
            raise ImageGenerationError("当前图片来源仅支持 1K 方图。", code="UNSUPPORTED_IMAGE_SIZE", retry_safe=True)
        common = {"capability": self.capability, "operation": call.operation_id}
        reserved = await self._post("image_begin", {**common, "fingerprint": call.request_fingerprint})
        if reserved.get("status") != "reserved":
            raise ImageGenerationError("图片计费状态待核对。", code="result_unknown")
        try:
            dispatched = await self._post("image_dispatch", common)
            if dispatched.get("status") != "running":
                raise ImageGenerationError("图片计费状态待核对。", code="result_unknown")
        except BaseException:
            await asyncio.shield(self._unknown(call.operation_id))
            raise
        active = _IMAGE_CALL.set(call)
        try:
            response = await invoke()
            if response.raw.get("status") not in {"settled", "free_completed"}:
                raise ImageGenerationError("图片计费待核对。", code="result_unknown")
        except BaseException:
            await asyncio.shield(self._unknown(call.operation_id))
            raise
        finally:
            _IMAGE_CALL.reset(active)
        return response

    def tool(self) -> HostedImageGenerationTool:
        cfg = ImageGenerationToolConfig(enabled=True, provider="openai_codex", model=self.settings.model)
        def provider_factory(_config, _providers):
            return _RemoteCodexImage(self)
        return HostedImageGenerationTool(sandbox=self.sandbox, config=cfg, provider_configs={"openai_codex": ProviderConfig()},
            call_wrapper=self.wrap, max_file_bytes=self.config.max_file_bytes, workspace_bytes=self.config.workspace_bytes,
            max_reference_images=8, timeout_seconds=self.config.tool_timeout_seconds,
            operation_id_factory=self._operation, provider_factory=provider_factory,
            state_dir=self.config.state_dir, owner=self.owner, run_id=self.run)

    async def deliver(self, _tool_call_id: str, outputs: list[dict]):
        for output in outputs:
            path = relative_path(output.get("path"))
            reply = await self.sandbox.file({"action": "download", "path": path})
            raw = base64.b64decode(reply["data"], validate=True)
            digest, mime = hashlib.sha256(raw).hexdigest(), detect_image_mime(raw)
            if (reply.get("path") != path or reply.get("size") != len(raw) or reply.get("sha256") != digest
                    or output.get("size") != len(raw) or output.get("sha256") != digest or output.get("mime") != mime
                    or not 0 < len(raw) <= self.config.max_file_bytes or mime not in {"image/png", "image/jpeg", "image/webp"}):
                raise WorkError("invalid_file", "生成的图片未通过保存校验。", 503)
            await self.tools.deliver_file(path)


class HostedImageRunner(AgentRunner):
    """Only Hosted adds tool-call identity and sandbox image delivery."""

    def __init__(self, provider, image: ImageRuntime):
        super().__init__(provider)
        self.image = image

    async def run(self, spec):
        from mona.providers.native_work_provider import NativeWorkProvider

        if not isinstance(self.provider, NativeWorkProvider):
            return await super().run(spec)
        provider = self.provider.for_turn(spec.workspace)
        provider.bind_runtime(spec.tools, spec.checkpoint_callback)
        spec.context_usage_fallback = False
        try:
            # Keep the hosted tool-call identity and image delivery hooks when
            # the shared native provider creates its isolated turn instance.
            result = await HostedImageRunner(provider, self.image)._run(spec)
            native_work = provider.native_work_snapshot()
            if native_work.get("native_session_id"):
                for message in reversed(result.messages):
                    if message.get("role") == "assistant":
                        message["native_work"] = native_work
                        break
            return result
        finally:
            await provider.aclose()

    async def _run_tool(self, spec, tool_call, *args, **kwargs):
        token = _CALL_ID.set(tool_call.id)
        try:
            result = await super()._run_tool(spec, tool_call, *args, **kwargs)
            if tool_call.name == "generate_image" and self._generated_media_outputs(result[0]):
                try:
                    receipt = json.loads(result[0]) if isinstance(result[0], str) else result[0]
                except ValueError:
                    receipt = None
                if isinstance(receipt, dict) and receipt.get("ok") is False:
                    await self._register_generated_media(spec, tool_call.name, tool_call.id, result[0])
            return result
        finally:
            _CALL_ID.reset(token)

    async def _register_generated_media(self, spec, tool_name, tool_call_id, result):
        if tool_name != "generate_image":
            return await super()._register_generated_media(spec, tool_name, tool_call_id, result)
        outputs = self._generated_media_outputs(result)
        if outputs:
            try:
                await self.image.deliver(tool_call_id, outputs)
            except Exception:
                self.image.tools.fault = "图片暂时无法展示，请核对已有交付文件。"
