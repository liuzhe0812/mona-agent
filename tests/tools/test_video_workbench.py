from __future__ import annotations

import base64
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image

from mona.agent.tools.context import RequestContext
from mona.agent.tools.video import VideoTool


def _png(color: tuple[int, int, int]) -> bytes:
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), color).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def tool_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    project = workspace / "video_projects" / "demo"
    preview_dir = project / "renders" / "previews" / "scene_01"
    preview_dir.mkdir(parents=True)
    for index, color in enumerate(((255, 0, 0), (0, 255, 0), (0, 0, 255))):
        (preview_dir / f"sample_{index}.png").write_bytes(_png(color))
    return workspace, project


async def test_preview_http_contract_uses_context_owner_fixed_local_endpoint_and_native_images(
    tool_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, project = tool_workspace
    pngs = [(project / "renders" / "previews" / "scene_01" / f"sample_{i}.png").read_bytes() for i in range(3)]
    frames = [
        {"seconds": seconds, "path": str(project / "renders" / "previews" / "scene_01" / f"sample_{i}.png")}
        for i, seconds in enumerate((0.2, 1.5, 2.8))
    ]
    requests: list[httpx.Request] = []
    client_options: list[dict] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "frames": frames, "diagnostics": []})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        client_options.append(dict(kwargs))
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "runtime-token")
    tool = VideoTool(workspace, services_port=17374, restrict_to_workspace=False)
    tool.set_context(RequestContext(channel="web", chat_id="bound-chat", session_key="web:chat:bound-chat"))

    result = await tool.execute("preview", "demo", scene_index=1)

    assert isinstance(result, list)
    image_blocks = [block for block in result if block.get("type") == "image_url"]
    assert len(image_blocks) == 3
    assert [base64.b64decode(block["image_url"]["url"].split(",", 1)[1]) for block in image_blocks] == pngs
    assert client_options and client_options[0]["trust_env"] is False
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "http://127.0.0.1:17374/api/video/agent"
    assert request.headers["x-mona-video-chat-id"] == "bound-chat"
    assert request.headers["x-mona-token"] == "runtime-token"
    assert json.loads(request.content) == {"action": "preview", "name": "demo", "scene_index": 1}


async def test_video_tool_rejects_model_supplied_owner_url_and_token(
    tool_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, _project = tool_workspace
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "frames": []})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    tool = VideoTool(workspace, restrict_to_workspace=False)
    tool.set_context(RequestContext(channel="web", chat_id="bound-chat"))

    result = await tool.execute(
        "preview", "demo", scene_index=1,
        owner="forged-chat", url="https://attacker.invalid", token="forged-token",
    )

    assert isinstance(result, str)
    assert json.loads(result)["ok"] is False
    assert requests == []


def test_video_tool_loads_in_director_with_legacy_permissions_without_subscription(tool_workspace):
    from mona.agent.partners import AgentDefinition
    from mona.agent.tools.capabilities import bind_capability_context
    from mona.agent.tools.context import ToolContext
    from mona.agent.tools.loader import ToolLoader
    from mona.agent.tools.registry import ToolRegistry
    from mona.agent.user_config import AgentUserConfig, resolve_effective_agent_config
    from mona.config.schema import ToolsConfig

    workspace, _project = tool_workspace
    effective = resolve_effective_agent_config(AgentDefinition(id="mona", display_name="Mona"), AgentUserConfig(granted_tools=["read_file", "write_file", "exec"]))
    registry = ToolRegistry()
    discovered = [cls for cls in ToolLoader().discover() if cls is VideoTool]
    assert discovered == [VideoTool]
    registered = ToolLoader(test_classes=discovered).load(ToolContext(config=ToolsConfig(), workspace=str(workspace), agent_kind="video"), registry)
    assert registered == ["video"]
    registry.set_allowed_tool_names(set(effective.allowed_tools or []))
    registry.set_subscription_access(False)
    context = RequestContext(channel="websocket", chat_id="bound-chat", metadata={"agent_kind": "video"})
    bind_capability_context(context)
    registry.get("video").set_context(context)
    assert registry.is_visible("video")
    assert not registry.requires_subscription_check


def test_video_tool_stays_hidden_outside_director_context(tool_workspace):
    from mona.agent.tools.capabilities import bind_capability_context
    from mona.agent.tools.registry import ToolRegistry

    workspace, _project = tool_workspace
    registry = ToolRegistry()
    tool = VideoTool(workspace)
    registry.register(tool)
    context = RequestContext(channel="websocket", chat_id="other-chat", metadata={})
    bind_capability_context(context)
    tool.set_context(context)
    assert not registry.is_visible("video")


def test_video_tool_exposes_planning_and_timed_audio_without_user_confirmation_action(tool_workspace):
    workspace, _project = tool_workspace
    schema = VideoTool(workspace).parameters["properties"]
    assert {"plan", "audio", "sync", "preview"} <= set(schema["action"]["enum"])
    assert "confirm" not in schema["action"]["enum"]
    assert "animation" in schema["scenes"]["items"]["properties"]
    assert schema["plan_revision"]["type"] == "integer"


async def test_director_agent_plans_then_waits_for_frontend_confirmation_through_real_service(
    tmp_path, monkeypatch,
):
    from unittest.mock import AsyncMock, MagicMock

    from aiohttp import web
    from aiohttp.test_utils import TestServer

    import mona.agent  # noqa: F401
    import mona.api.server as server
    from mona.agent.document_loop import DocumentAgentLoop
    from mona.agent.partners import AgentDefinition
    from mona.agent.runner import AgentRunner, AgentRunSpec
    from mona.agent.user_config import AgentUserConfig, resolve_effective_agent_config
    from mona.api.video_director import handle_video_agent
    from mona.bus.queue import MessageBus
    from mona.providers.base import LLMResponse, ToolCallRequest

    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "test-runtime-token")
    app = web.Application()
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)
    app.router.add_post("/api/video/project/confirm", server.handle_video_project_confirm)
    async with TestServer(app) as service:
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.post(str(service.make_url("/api/video/project/create")), json={"name": "automatic"})
            assert response.status_code == 200
            response = await client.post(str(service.make_url("/api/video/project-save-chat-id")), json={"name": "automatic", "chatId": "director"})
            assert response.status_code == 200

        provider = MagicMock()
        provider.chat_with_retry = AsyncMock(side_effect=[
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="inspect", name="video", arguments={"action": "inspect", "name": "automatic"})]),
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="plan", name="video", arguments={"action": "plan", "name": "automatic", "scenes": [{"title": "Agent scene", "duration": 3, "visual": "Show two choices", "animation": "Choices move into view as they are introduced", "narration": "", "assets": []}]})]),
            LLMResponse(content="请在导演台确认方案", finish_reason="stop"),
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="draft", name="write_file", arguments={"path": "video_projects/automatic/drafts/scene_01.tsx", "content": 'export default function Scene() { return <div>Prepared by the Agent</div>; }'})]),
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="sync", name="video", arguments={"action": "sync", "name": "automatic", "scene_index": 1, "plan_revision": 1, "source_file": "drafts/scene_01.tsx"})]),
            LLMResponse(content="画面已准备", finish_reason="stop"),
        ])
        loop = DocumentAgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path, model="test", agent_kind="video", services_port=service.port)
        effective = resolve_effective_agent_config(AgentDefinition(id="mona", display_name="Mona"), AgentUserConfig(granted_tools=["read_file", "write_file", "exec"]))
        loop.tools.set_allowed_tool_names(set(effective.allowed_tools or []))
        loop.tools.set_subscription_access(False)
        session = loop.sessions.get_or_create("websocket:director")
        session.metadata["agent_kind"] = "video"
        loop._set_tool_context("websocket", "director", session=session)
        result = await AgentRunner(provider).run(AgentRunSpec(
            initial_messages=[{"role": "system", "content": "Create the video."}, {"role": "user", "content": "Create one scene."}],
            tools=loop.tools, model="test", max_iterations=5, max_tool_result_chars=12000, workspace=tmp_path,
        ))
        assert result.tools_used == ["video", "video"]
        project = tmp_path / "video_projects" / "automatic"
        planned = server._load_video_meta(project)
        assert planned["phase"] == "storyboard"
        assert not list((project / "scenes").glob("*"))
        assert not list((project / "scene_sources").glob("*"))
        async with httpx.AsyncClient(trust_env=False) as client:
            confirmed = await client.post(str(service.make_url("/api/video/project/confirm")), json={"name": "automatic", "expectedPlanRevision": planned["planRevision"]})
        assert confirmed.status_code == 200
        result = await AgentRunner(provider).run(AgentRunSpec(
            initial_messages=[{"role": "system", "content": "Create the confirmed video."}, {"role": "user", "content": "The plan is confirmed. Start production."}],
            tools=loop.tools, model="test", max_iterations=5, max_tool_result_chars=12000, workspace=tmp_path,
        ))
        assert result.tools_used == ["write_file", "video"]
        meta = server._load_video_meta(tmp_path / "video_projects" / "automatic")
        assert len(meta.get("scenes") or []) == 1, [call.kwargs["messages"][-2:] for call in provider.chat_with_retry.await_args_list]
        assert meta["scenes"][0]["title"] == "Agent scene"
        assert server._video_scene_ready(tmp_path / "video_projects" / "automatic", meta["scenes"][0])
        assert 'Prepared by the Agent' in (tmp_path / "video_projects/automatic/scenes/scene_01.html").read_text(encoding="utf-8")
