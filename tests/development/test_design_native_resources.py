"""Real project/runtime/pipe readers; upstream responses are protocol peers, not live models."""
import base64
import json
from io import BytesIO

import pytest
from PIL import Image
from test_native_collaboration_flow import NATIVE, setup
from test_native_host_tools import enable_bridge
from test_native_workbench import settle, wait_run

from mona.development.design_resources import DESIGN_TOOL
from mona.development.executors.host_tools import DESIGN_ENVELOPE

SAMPLE = "assets/style-specimens/web/19-swiss-monochrome.jpg"


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", NATIVE)
@pytest.mark.parametrize("readonly", [False, True])
async def test_all_native_executors_read_shared_design_text_and_actual_image(tmp_path, monkeypatch, executor, readonly):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    session = runtime.store.create_session(project.id, executor, readonly=readonly)
    try:
        sent = await runtime.submit(session.id, "read_design", "design_resource:" + json.dumps(["SKILL.md", SAMPLE]))
        run = await wait_run(runtime, session.id)
        await settle(runtime)
        binding = runtime.store.get_binding(run.binding_id)
        assert run.id == sent["run"]["id"] and not model_calls
        assert not (root / ".agents").exists() and (root / "manual.txt").read_text() == "MANUAL_CONTENT"
        if executor.value == "codex":
            rows = [json.loads(line) for line in (root / "peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
            start = next(row["params"] for row in rows if row.get("method") == "thread/start")
            assert DESIGN_TOOL in {tool["name"] for tool in start["dynamicTools"]}
            results = [row["result"] for row in rows if str(row.get("id", "")).startswith("host-") and "result" in row]
            assert len(results) == 2 and all(result["success"] for result in results)
            assert json.loads(results[0]["contentItems"][0]["text"])["path"] == "SKILL.md"
            image = next(item["imageUrl"] for item in results[1]["contentItems"] if item["type"] == "inputImage")
            raw = base64.b64decode(image.partition(",")[2])
        else:
            rows = [json.loads(line) for line in (root / "sdk-peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
            results = [row["result"] for row in rows if row.get("method") == "design-resource-result"]
            assert len(results) == 2 and not any(result["isError"] for result in results)
            assert json.loads(results[0]["content"][0]["text"])["path"] == "SKILL.md"
            image = next(item for item in results[1]["content"] if item["type"] == "image")
            assert image["mimeType"] == "image/jpeg"
            raw = base64.b64decode(image["data"])
        with Image.open(BytesIO(raw)) as image:
            assert image.width > 100 and image.height > 100
            image.verify()
        rejected = await runtime.native_collaboration(binding, run.native_turn_id, {DESIGN_ENVELOPE: {"path": "SKILL.md"}})
        assert rejected["isError"]  # A completed turn cannot keep using the resource host.
        assert len(runtime.store.list_runs(session.id)) == 1
    finally:
        await client.close()
        await runtime.close()
