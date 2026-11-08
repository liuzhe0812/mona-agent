"""Hosted image identity must survive a native model's turn-scoped runner."""
import base64
import hashlib
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.agent.runner import AgentRunSpec
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import (
    Config,
    HostedWorkConfig,
    HostedWorkImageSettings,
    _resolve_tool_config_refs,
)
from mona.hosted_work.image_runtime import HostedImageRunner, ImageRuntime
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.providers.native_work_provider import NativeWorkProvider


class _Sandbox:
    def __init__(self):
        self.files = {}

    async def file(self, request):
        path = request["path"]
        if request["action"] == "upload":
            self.files[path] = base64.b64decode(request["data"], validate=True)
        raw = self.files[path]
        return {"path": path, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "data": base64.b64encode(raw).decode()}


class _NativeFixture(NativeWorkProvider):
    """Supply one native dynamic tool request without launching an external model."""

    def __init__(self, workspace, ratio):
        _resolve_tool_config_refs()
        super().__init__(Config(), workspace)
        self.ratio = ratio
        self.receipt = None
        self.bound = False
        self.closed = False
        self.child = None

    def for_turn(self, workspace):
        self.child = _NativeFixture(workspace, self.ratio)
        return self.child

    def bind_runtime(self, _tools, _checkpoint=None):
        self.bound = True

    def native_work_snapshot(self):
        return {}

    async def aclose(self):
        self.closed = True

    async def chat_stream(self, messages, *_args, **_kwargs):
        reply = next((m for m in reversed(messages) if m.get("role") == "tool"), None)
        if reply is None:
            return LLMResponse(content=None, finish_reason="tool_calls", tool_calls=[
                ToolCallRequest("native-tool-call-1", "generate_image", {"prompt": "red cat", "aspect_ratio": self.ratio})])
        self.receipt = json.loads(reply["content"])
        return LLMResponse(content="finished")


@pytest.mark.parametrize("ratio", ["1:1", "16:9"])
@pytest.mark.asyncio
async def test_native_dynamic_image_call_has_identity_and_checks_size_before_billing(monkeypatch, ratio):
    with tempfile.TemporaryDirectory(prefix="mona-image-native-") as temporary:
        root = Path(temporary).resolve()
        settings = HostedWorkImageSettings(enabled=True, model="fixture")
        config = HostedWorkConfig(state_dir=str(root), auth_origin="https://auth.example.test",
                                  public_origin="https://example.test", image_generation=settings)
        sandbox, delivered, requests = _Sandbox(), [], []

        async def deliver(path):
            delivered.append(path)

        runtime = ImageRuntime(config, {"owner": "a" * 64, "session_id": "1" * 32, "run_id": "2" * 32,
            "hosted_image": {"settings": settings.model_dump(), "capability": "c" * 43}},
            sandbox, SimpleNamespace(deliver_file=deliver))
        buffer = io.BytesIO()
        Image.new("RGB", (2, 2), "red").save(buffer, format="PNG")
        png = buffer.getvalue()

        async def rpc(command, args):
            requests.append((command, args["operation"]))
            if command == "image_begin":
                return {"status": "reserved"}
            if command == "image_dispatch":
                return {"status": "running"}
            if command == "image_generate":
                return {"status": "settled", "image": {"mime": "image/png", "size": len(png),
                    "sha256": hashlib.sha256(png).hexdigest(), "data": base64.b64encode(png).decode()}}
            raise AssertionError(command)

        monkeypatch.setattr(runtime, "_post", rpc)
        registry = ToolRegistry()
        image_tool = runtime.tool()
        assert "1K square (1:1)" in image_tool.description
        registry.register(image_tool)
        provider = _NativeFixture(root, ratio)
        spec = AgentRunSpec(initial_messages=[{"role": "user", "content": "draw"}], tools=registry,
                            model="fixture", max_iterations=3, max_tool_result_chars=10000,
                            workspace=root, concurrent_tools=True)
        result = await HostedImageRunner(provider, runtime).run(spec)
        child = provider.child
        assert child and child.bound and child.closed and result.stop_reason == "completed", result.error
        if ratio == "1:1":
            assert child.receipt["ok"] is True
            assert [name for name, _ in requests] == ["image_begin", "image_dispatch", "image_generate"]
            assert len({operation for _, operation in requests}) == 1
            assert len(delivered) == 1
        else:
            assert child.receipt["ok"] is False and child.receipt["code"] == "INVALID_IMAGE_SIZE"
            assert "1K" in child.receipt["message"] and "1:1" in child.receipt["message"]
            assert child.receipt["retry_safe"] is True
            assert requests == [] and delivered == []
