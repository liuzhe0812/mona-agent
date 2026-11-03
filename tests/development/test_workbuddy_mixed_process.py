"""Real Work runner + RPC worker + callbacks; only the vendor SDK is synthetic."""
import base64
import io
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.filesystem import WriteFileTool
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import Config
from mona.development.contracts import ExecutorId
from mona.development.executors.sdk_policy import prepare_sdk_profile
from mona.providers.native_work_provider import NativeWorkProvider


@pytest.mark.asyncio
async def test_mixed_parallel_tools_images_and_context_handoff_use_each_write_once(tmp_path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    image = io.BytesIO()
    Image.new("RGB", (2, 2)).save(image, format="PNG")
    url = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
    counts = {"fixture_image": 0, "fixture_business_save": 0}

    class Business(Tool):
        def __init__(self, name):
            self._name = name
        @property
        def name(self):
            return self._name
        @property
        def description(self):
            return "Fixture business action"
        @property
        def parameters(self):
            return {"type": "object", "properties": {}}
        async def execute(self):
            counts[self.name] += 1
            if self.name == "fixture_image":
                return [{"type": "image_url", "image_url": {"url": url}}]
            with (root / "business-once.txt").open("a", encoding="utf8") as stream:
                stream.write("once\n")
            return "saved"

    registry = ToolRegistry()
    registry.register(WriteFileTool(workspace=root, allowed_dir=root))
    registry.register(Business("fixture_image"))
    registry.register(Business("fixture_business_save"))
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    config.development.enabled_engines = ["codebuddy"]
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda _: [
        SimpleNamespace(executor=ExecutorId.CODEBUDDY, state="detected", executable=sys.executable)])
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_sdk_profile", lambda executor, exe, home, workspace, **kw:
                        prepare_sdk_profile(executor, exe, home, workspace, environment={
                            key: value for key, value in os.environ.items()
                            if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}}))
    monkeypatch.setattr("mona.development.executors.sdk.sdk_version", lambda _: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.worker_command", lambda: (
        sys.executable, "-u", str(Path(__file__).with_name("sdk_workbuddy_mixed_peer.py"))))
    provider = NativeWorkProvider(config, root, native_home=tmp_path / "native-home")
    snapshots = []
    async def checkpoint(value):
        snapshots.append(value)
    result = await AgentRunner(provider).run(AgentRunSpec(
        [{"role": "system", "content": "Stable work instructions"},
         {"role": "user", "content": "Create files and inspect screenshot once"}],
        registry, "peer-model", 8, 16000, workspace=root, checkpoint_callback=checkpoint,
        llm_timeout_s=20, enforce_llm_timeout_for_streaming=True,
    ))
    assert result.stop_reason == "completed" and result.final_content == "mixed task completed"
    assert counts == {"fixture_image": 1, "fixture_business_save": 1}
    trace = [json.loads(line) for line in (root / "sdk-peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
    assert len([row for row in trace if row["method"] == "native-write"]) == 1
    assert [row["has_image"] for row in trace if row["method"] == "query"] == [False, True]
    assert len({row["system_sha"] for row in trace if row["method"] == "connect"}) == 1
    assert len([row for row in trace if row["method"] == "disconnect"]) == 2
    for name in ["native-once.txt", "business-once.txt"]:
        assert (root / name).read_text(encoding="utf8") == "once\n"
    assert any(value.get("native_work", {}).get("calls", [{}])[0].get("status") == "completed"
               for value in snapshots if value.get("native_work", {}).get("calls"))
