from __future__ import annotations

import base64
import hashlib
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
    assert json.loads(result[0]["text"])["frames"] == frames
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


async def test_preview_forwards_selected_timestamps_and_returns_each_native_image(
    tool_workspace: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace, project = tool_workspace
    preview_dir = project / "renders" / "previews" / "scene_01"
    pngs = [(preview_dir / f"sample_{i}.png").read_bytes() for i in range(2)]
    timestamps = [0.375, 2.125]
    frames = [
        {"timestamp": timestamp, "seconds": timestamp, "path": str(preview_dir / f"sample_{i}.png")}
        for i, timestamp in enumerate(timestamps)
    ]
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={
            "ok": True, "frames": frames, "observationScope": "selected-timestamps",
            "motionReviewUpdated": False,
        })

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "runtime-token")
    tool = VideoTool(workspace, services_port=17374, restrict_to_workspace=False)
    tool.set_context(RequestContext(channel="web", chat_id="bound-chat"))

    result = await tool.execute("preview", "demo", scene_index=1, timestamps=timestamps)

    assert isinstance(result, list)
    payload = json.loads(result[0]["text"])
    assert payload["observationScope"] == "selected-timestamps"
    assert payload["motionReviewUpdated"] is False
    assert [frame["timestamp"] for frame in payload["frames"]] == timestamps
    image_blocks = [block for block in result if block.get("type") == "image_url"]
    assert [base64.b64decode(block["image_url"]["url"].split(",", 1)[1]) for block in image_blocks] == pngs
    assert json.loads(requests[0].content)["timestamps"] == timestamps


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
        request_id="forged-request", source_content="forged HTML",
        execution_mode="automatic", source_paths=["inside.md"],
    )

    assert isinstance(result, str)
    assert json.loads(result)["ok"] is False
    assert requests == []


async def test_video_create_uses_message_identity_and_validated_active_workspace_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    workspace = tmp_path / "agent-workspaces" / "mona" / "output"
    workspace.mkdir(parents=True)
    source = workspace / "brief.md"
    source.write_text("approved source", encoding="utf-8")
    attachment = tmp_path / "attachments" / "attachment.md"
    attachment.parent.mkdir()
    attachment.write_text("attached source", encoding="utf-8")
    project_root = tmp_path / "shared"
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "name": "automatic-demo"})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "runtime-token")
    tool = VideoTool(workspace, services_port=17374, project_workspace=project_root)
    tool.set_context(RequestContext(
        channel="websocket", chat_id="bound-chat", message_id="message-42",
        session_key="websocket:bound-chat", metadata={"_attachment_paths": [str(attachment)]},
    ))

    result = await tool.execute(
        "create", "automatic-demo", execution_mode="automatic",
        instruction="按这条请求无人值守完成视频",
        source_paths=["brief.md", str(attachment)],
    )

    assert json.loads(result)["ok"] is True
    assert len(requests) == 1
    request = requests[0]
    payload = json.loads(request.content)
    assert payload == {
        "action": "create",
        "name": "automatic-demo",
        "execution_mode": "automatic",
        "instruction": "按这条请求无人值守完成视频",
        "source_paths": [str(source.resolve()), str(attachment.resolve())],
        "request_id": hashlib.sha256(
            b"websocket:bound-chat:message-42:automatic-demo"
        ).hexdigest(),
    }
    assert request.headers["x-mona-video-chat-id"] == "bound-chat"
    assert request.headers["x-mona-token"] == "runtime-token"

    repeated_create = await tool.execute(
        "create", "automatic-demo", execution_mode="automatic",
        instruction="按这条请求无人值守完成视频",
        source_paths=["brief.md", str(attachment)],
    )
    assert json.loads(repeated_create)["ok"] is True
    assert json.loads(requests[1].content)["request_id"] == payload["request_id"]

    execution_instruction = "请根据我刚才的要求自动完成，不必等待确认"
    execution = await tool.execute(
        "execution", "automatic-demo", execution_mode="automatic",
        plan_revision=2, instruction=execution_instruction,
    )
    assert json.loads(execution)["ok"] is True
    assert json.loads(requests[2].content) == {
        "action": "execution", "name": "automatic-demo",
        "execution_mode": "automatic", "plan_revision": 2,
        "instruction": execution_instruction,
    }

    draft_content = "<!doctype html><html><body>approved film</body></html>"
    draft = workspace / "drafts" / "film.html"
    draft.parent.mkdir(parents=True)
    draft.write_text(draft_content, encoding="utf-8")
    synced = await tool.execute(
        "sync", "automatic-demo", plan_revision=2, source_file="drafts/film.html",
    )
    assert json.loads(synced)["ok"] is True
    assert len(requests) == 4
    sync_payload = json.loads(requests[3].content)
    assert sync_payload["source_file"] == "drafts/film.html"
    assert sync_payload["source_content"] == draft_content

    outside = tmp_path / "untrusted.md"
    outside.write_text("untrusted", encoding="utf-8")
    outside_result = json.loads(await tool.execute(
        "create", "outside-source", source_paths=[str(outside)],
    ))
    too_many_result = json.loads(await tool.execute(
        "create", "too-many-sources", source_paths=["brief.md"] * 11,
    ))
    assert outside_result["ok"] is False
    assert too_many_result["ok"] is False
    assert len(requests) == 4


async def test_cron_video_create_identity_is_stable_per_context_but_changes_between_turns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "name": "same-name"})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "runtime-token")
    tool = VideoTool(tmp_path, restrict_to_workspace=False)
    first_turn = RequestContext(
        channel="cron", chat_id="scheduled-job", session_key="cron:scheduled-job",
    )
    tool.set_context(first_turn)
    await tool.execute("create", "same-name", instruction="制作一段测试动画并交付视频")
    tool.set_context(first_turn)
    await tool.execute("create", "same-name", instruction="制作一段测试动画并交付视频")

    second_turn = RequestContext(
        channel="cron", chat_id="scheduled-job", session_key="cron:scheduled-job",
    )
    tool.set_context(second_turn)
    await tool.execute("create", "same-name", instruction="制作一段测试动画并交付视频")

    request_ids = [json.loads(request.content)["request_id"] for request in requests]
    assert request_ids[0] == request_ids[1]
    assert request_ids[2] != request_ids[0]

    forged = json.loads(await tool.execute("create", "same-name", request_id="model-chosen"))
    assert forged["ok"] is False
    assert len(requests) == 3


@pytest.mark.parametrize(("kind", "requested_mode", "expected_mode"), [
    (None, None, "automatic"),
    ("video", None, "interactive"),
    (None, "interactive", "interactive"),
])
async def test_video_create_mode_follows_entry_without_changing_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind, requested_mode, expected_mode,
) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    from mona.api import server
    from mona.api.video_director import handle_video_agent

    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "runtime-token")
    app = web.Application()
    app.router.add_post("/api/video/agent", handle_video_agent)
    context = RequestContext(channel="websocket", chat_id="mode-source", metadata={"agent_kind": kind} if kind else {})
    async with TestServer(app) as service:
        tool = VideoTool(tmp_path, services_port=service.port)
        tool.set_context(context)
        args = {"instruction": "制作一个简短的决策模型科普动画", "settings": {"narrationEnabled": False}}
        if requested_mode is not None:
            args["execution_mode"] = requested_mode
        created = json.loads(await tool.execute("create", "entry-mode", **args))
        assert created["ok"] is True
        assert created["executionMode"] == expected_mode
        planned = json.loads(await tool.execute("plan", "entry-mode", plan_revision=0, scenes=[{
            "title": "决策模型", "duration": 3, "visual": "比较候选方案", "animation": "依次出现评分条", "narration": "",
        }]))
        assert planned["ok"] is True
        assert planned["awaitingConfirmation"] is (expected_mode == "interactive")
    saved = server._load_video_meta(tmp_path / "video_projects" / "entry-mode")
    assert saved["requirePlanApproval"] is True
    if expected_mode == "automatic":
        assert saved["approvedPlanRevision"] == saved["planRevision"]
    assert context.metadata.get("agent_kind") == kind


async def test_preview_uses_global_video_project_root_when_active_workspace_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace

    active_workspace = tmp_path / "agent-workspaces" / "mona" / "output"
    active_workspace.mkdir(parents=True)
    project = tmp_path / "shared" / "video_projects" / "demo"
    preview_dir = project / "renders" / "previews" / "scene_01"
    preview_dir.mkdir(parents=True)
    frames = []
    for index, color in enumerate(((255, 0, 0), (0, 255, 0), (0, 0, 255))):
        path = preview_dir / f"sample_{index}.png"
        path.write_bytes(_png(color))
        frames.append({"seconds": index + 0.5, "path": str(path)})
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True, "frames": frames})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    tool = VideoTool(active_workspace, project_workspace=tmp_path / "shared")
    tool.set_context(RequestContext(channel="websocket", chat_id="bound-chat"))
    token = set_current_workspace(active_workspace)
    try:
        result = await tool.execute("preview", "demo", scene_index=1)
    finally:
        reset_current_workspace(token)

    assert isinstance(result, list)
    assert len([block for block in result if block.get("type") == "image_url"]) == 3
    assert json.loads(requests[0].content) == {
        "action": "preview", "name": "demo", "scene_index": 1,
    }


async def test_video_tool_bridges_real_service_project_to_active_workspace_and_delivery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    import mona.api.server as server
    from mona.agent.tools.context import ToolContext
    from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
    from mona.api.video_director import handle_video_agent
    from mona.config.schema import ToolsConfig
    from mona.video_assets import register_project_asset

    base = tmp_path / "base"
    active_workspace = base / "agent-workspaces" / "mona" / "output"
    active_workspace.mkdir(parents=True)
    project_root = base / "video_projects"
    monkeypatch.setattr(server, "_video_projects_dir", lambda: project_root)
    monkeypatch.setattr("mona.agent.tools.video.get_workspace_path", lambda: base)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "bridge-runtime-token")

    app = web.Application()
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)

    async with TestServer(app) as service:
        async with httpx.AsyncClient(trust_env=False) as client:
            created = await client.post(str(service.make_url("/api/video/project/create")), json={
                "name": "workspace-bridge", "templateId": "auto",
            })
            assert created.status_code == 200
            bound = await client.post(str(service.make_url("/api/video/project-save-chat-id")), json={
                "name": "workspace-bridge", "chatId": "bridge-chat",
            })
            assert bound.status_code == 200

        project = project_root / "workspace-bridge"
        source = project / "sources" / "source-brief.md"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("project source", encoding="utf-8")
        style_path = project / "style" / "design-system.json"
        style = json.loads(style_path.read_text(encoding="utf-8"))
        style["authoring"] = {"rules": "use the sample's visual language"}
        style_path.write_text(json.dumps(style), encoding="utf-8")
        style_example = project / "style" / "authoring" / "scene_sources" / "sample.html"
        style_example.parent.mkdir(parents=True)
        style_example.write_text("<html>style example</html>", encoding="utf-8")
        asset = project / "assets" / "bridge.png"
        asset.parent.mkdir(parents=True, exist_ok=True)
        asset.write_bytes(_png((30, 60, 90)))
        register_project_asset(project, {
            "id": "bridge-image", "kind": "image", "path": "assets/bridge.png",
            "originalName": "bridge.png",
        })
        film = project / "scene_sources" / "film.html"
        film.parent.mkdir(parents=True, exist_ok=True)
        film.write_text("<html>canonical film</html>", encoding="utf-8")

        tool = VideoTool.create(ToolContext(
            config=ToolsConfig(restrict_to_workspace=True),
            workspace=str(active_workspace), services_port=service.port,
        ))
        tool.set_context(RequestContext(channel="websocket", chat_id="bridge-chat"))
        assert tool.workspace == active_workspace
        assert tool.project_workspace == base.resolve()

        workspace_token = set_current_workspace(active_workspace)
        try:
            inspected = await tool.execute("inspect", "workspace-bridge")
        finally:
            reset_current_workspace(workspace_token)
        view = json.loads(inspected)
        assert view["ok"] is True
        assert view["projectPath"] == str(project)
        assert Path(view["draftDirectory"]).is_relative_to(active_workspace)
        assert Path(view["sources"][0]).read_text(encoding="utf-8") == "project source"
        assert Path(view["styleExamples"][0]).read_text(encoding="utf-8") == "<html>style example</html>"
        assert Path(view["assets"][0]["workspacePath"]).read_bytes() == asset.read_bytes()
        assert Path(view["filmSourcePath"]).read_text(encoding="utf-8") == "<html>canonical film</html>"

        output = project / "renders" / "output.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"real temporary video output")
        (project / ".render_status.json").write_text(json.dumps({
            "stage": "done", "progress": 100, "output": "renders/output.mp4",
        }), encoding="utf-8")

        delivered = json.loads(await tool.execute("status", "workspace-bridge"))
        delivery_path = Path(delivered["deliveryPath"])
        assert delivery_path.is_relative_to(active_workspace / "generated" / "videos" / "workspace-bridge")
        assert delivery_path.read_bytes() == b"real temporary video output"
        repeated = json.loads(await tool.execute("status", "workspace-bridge"))
        assert repeated["deliveryPath"] == str(delivery_path)
        assert delivery_path.read_bytes() == b"real temporary video output"

        outside = project_root / "outside.mp4"
        outside.write_bytes(b"must not deliver")
        (project / ".render_status.json").write_text(json.dumps({
            "stage": "done", "progress": 100, "output": "../outside.mp4",
        }), encoding="utf-8")
        escaped = json.loads(await tool.execute("status", "workspace-bridge"))
        assert escaped["ok"] is False
        assert escaped["code"] == "VIDEO_DELIVERY_FAILED"
        assert outside.read_bytes() == b"must not deliver"


async def test_status_does_not_deliver_a_stale_existing_video_from_real_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    import mona.api.server as server
    from mona.api.video_director import handle_video_agent

    base = tmp_path / "base"
    active_workspace = base / "agent-workspaces" / "mona" / "output"
    active_workspace.mkdir(parents=True)
    project_root = base / "video_projects"
    monkeypatch.setattr(server, "_video_projects_dir", lambda: project_root)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "stale-output-runtime-token")

    app = web.Application()
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)

    async with TestServer(app) as service:
        async with httpx.AsyncClient(trust_env=False) as client:
            created = await client.post(str(service.make_url("/api/video/project/create")), json={
                "name": "stale-output", "templateId": "auto",
            })
            assert created.status_code == 200
            bound = await client.post(str(service.make_url("/api/video/project-save-chat-id")), json={
                "name": "stale-output", "chatId": "stale-chat",
            })
            assert bound.status_code == 200

        project = project_root / "stale-output"
        old_output = project / "renders" / "output.mp4"
        old_output.parent.mkdir(parents=True, exist_ok=True)
        old_output.write_bytes(b"old video from prior plan")
        (project / ".render_status.json").write_text(json.dumps({
            "stage": "done", "progress": 100, "output": "renders/output.mp4",
        }), encoding="utf-8")
        metadata = server._load_video_meta(project)
        metadata["outputStale"] = True
        server._save_video_meta(project, metadata)

        tool = VideoTool(
            active_workspace, services_port=service.port,
            project_workspace=base, restrict_to_workspace=True,
        )
        tool.set_context(RequestContext(channel="cron", chat_id="stale-chat"))
        result = json.loads(await tool.execute("status", "stale-output"))

    delivery_dir = active_workspace / "generated" / "videos" / "stale-output"
    assert result["outputStale"] is True
    assert result["ok"] is False
    assert result["code"] == "VIDEO_OUTPUT_STALE"
    assert "deliveryPath" not in result
    assert not delivery_dir.exists()
    assert old_output.read_bytes() == b"old video from prior plan"


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
    context = RequestContext(channel="websocket", chat_id="bound-chat", metadata={"agent_kind": "video"})
    bind_capability_context(context)
    registry.get("video").set_context(context)
    assert registry.is_visible("video")


def test_video_tool_loads_for_work_only_after_capability_and_still_requires_permission(tool_workspace):
    import asyncio

    from mona.agent.tools.capabilities import LoadCapabilityTool, bind_capability_context
    from mona.agent.tools.context import RequestContext
    from mona.agent.tools.registry import ToolRegistry

    workspace, _project = tool_workspace
    registry = ToolRegistry()
    loader = LoadCapabilityTool(workspace=workspace, agent_id="mona", registry=registry)
    registry.register(loader)
    tool = VideoTool(workspace)
    registry.register(tool)
    registry.set_allowed_tool_names({"load_capability", "video"})
    context = RequestContext(channel="websocket", chat_id="other-chat", metadata={})
    bind_capability_context(context)
    tool.set_context(context)
    assert not registry.is_visible("video")

    asyncio.run(loader.execute(["video"]))
    assert registry.is_visible("video")

    registry.set_allowed_tool_names({"load_capability"})
    asyncio.run(loader.execute(["video"]))
    assert not registry.is_visible("video")
    _tool, _params, error = registry.prepare_call("video", {"action": "inspect", "name": "demo"})
    assert error is not None
    assert "not permitted" in error


def test_video_tool_exposes_planning_and_timed_audio_without_user_confirmation_action(tool_workspace):
    workspace, _project = tool_workspace
    schema = VideoTool(workspace).parameters["properties"]
    assert {"create", "execution"} <= set(schema["action"]["enum"])
    assert schema["execution_mode"]["enum"] == ["interactive", "automatic"]
    assert schema["source_paths"]["maxItems"] == 10
    assert not {"owner", "url", "token", "request_id", "source_content"} & set(schema)
    assert {"style", "plan", "edit", "audio", "sync", "preview"} <= set(schema["action"]["enum"])
    assert "confirm" not in schema["action"]["enum"]
    assert "animation" in schema["scenes"]["items"]["properties"]
    assert schema["plan_revision"]["type"] == "integer"
    assert schema["style_id"]["type"] == "string"
    assert schema["instruction"]["minLength"] == 1
    assert schema["timestamps"]["maxItems"] == 8
    assert schema["timestamps"]["items"]["type"] == "number"
    assert schema["instruction"]["maxLength"] == 8000


async def test_auto_video_workbench_inspects_and_selects_an_available_style(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    import mona.api.server as server
    from mona.api.video_director import handle_video_agent

    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "auto-style-runtime-token")
    app = web.Application()
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)

    async with TestServer(app) as service:
        async with httpx.AsyncClient(trust_env=False) as client:
            created = await client.post(str(service.make_url("/api/video/project/create")), json={
                "name": "automatic-style", "templateId": "auto",
            })
            assert created.status_code == 200
            bound = await client.post(str(service.make_url("/api/video/project-save-chat-id")), json={
                "name": "automatic-style", "chatId": "style-chat",
            })
            assert bound.status_code == 200

        tool = VideoTool(tmp_path, services_port=service.port, restrict_to_workspace=False)
        tool.set_context(RequestContext(channel="websocket", chat_id="style-chat"))
        inspected = await tool.execute("inspect", "automatic-style")
        assert isinstance(inspected, str)
        current = json.loads(inspected)
        assert current["stylePreference"] == "auto"
        huashu_style = next(style for style in current["availableStyles"] if style["id"] == "huashu-whiteboard")
        assert {"id", "name", "description", "mode"} <= set(huashu_style)

        selected = await tool.execute(
            "style", "automatic-style", plan_revision=current["planRevision"],
            style_id=huashu_style["id"],
        )

    assert isinstance(selected, str)
    result = json.loads(selected)
    assert result["ok"] is True
    assert result["style"]["id"] == "huashu-whiteboard"
    assert result["planRevision"] == current["planRevision"] + 1
    saved = server._load_video_meta(tmp_path / "video_projects" / "automatic-style")
    assert saved["stylePreference"] == "auto"
    assert saved["templateId"] == "huashu-whiteboard"
    assert saved["approvedPlanRevision"] is None


@pytest.mark.parametrize("timestamps", [[], [0] * 9, [float("nan")], [float("inf")], [10**400], [-0.1], [True]])
async def test_video_tool_rejects_invalid_selected_timestamps_before_service_call(
    tool_workspace, monkeypatch: pytest.MonkeyPatch, timestamps,
) -> None:
    workspace, _project = tool_workspace
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True})

    original_client = httpx.AsyncClient

    def make_client(*args, **kwargs):
        return original_client(*args, transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("mona.agent.tools.video.httpx.AsyncClient", make_client)
    tool = VideoTool(workspace, restrict_to_workspace=False)
    tool.set_context(RequestContext(channel="web", chat_id="bound-chat"))

    result = await tool.execute("preview", "demo", scene_index=1, timestamps=timestamps)

    assert isinstance(result, str)
    assert json.loads(result)["code"] == "VIDEO_ARGUMENTS_INVALID"
    assert requests == []


async def test_video_tool_edit_reaches_real_services_with_user_instruction_and_scene_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestServer

    import mona.api.server as server
    from mona.api.video_director import handle_video_agent

    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "video-edit-runtime-token")
    app = web.Application()
    app.router.add_post("/api/video/project/create", server.handle_video_project_create)
    app.router.add_post("/api/video/project-save-chat-id", server.handle_video_project_save_chat_id)
    app.router.add_post("/api/video/agent", handle_video_agent)
    app.router.add_post("/api/video/project/confirm", server.handle_video_project_confirm)

    async with TestServer(app) as service:
        async with httpx.AsyncClient(trust_env=False) as client:
            created = await client.post(str(service.make_url("/api/video/project/create")), json={"name": "edit-contract"})
            assert created.status_code == 200
            bound = await client.post(str(service.make_url("/api/video/project-save-chat-id")), json={
                "name": "edit-contract", "chatId": "edit-chat",
            })
            assert bound.status_code == 200
            headers = {
                "x-mona-token": "video-edit-runtime-token",
                "X-Mona-Video-Chat-Id": "edit-chat",
            }
            planned = await client.post(str(service.make_url("/api/video/agent")), headers=headers, json={
                "action": "plan", "name": "edit-contract", "scenes": [{
                    "title": "第一段", "duration": 3, "visual": "先展示两个方案",
                    "animation": "两个方案依次出现", "narration": "这里展示两个方案。", "assets": [],
                }],
            })
            assert planned.status_code == 200
            plan_revision = planned.json()["planRevision"]
            confirmed = await client.post(str(service.make_url("/api/video/project/confirm")), json={
                "name": "edit-contract", "expectedPlanRevision": plan_revision,
            })
            assert confirmed.status_code == 200

        tool = VideoTool(tmp_path, services_port=service.port, restrict_to_workspace=False)
        tool.set_context(RequestContext(channel="websocket", chat_id="edit-chat"))
        instruction = "把两个方案改成并排卡片，并在讲解优势时点亮对应卡片。"
        change = {"visual": "并排卡片呈现两个方案", "animation": "讲到优势时对应卡片逐步点亮"}
        result = await tool.execute(
            "edit", "edit-contract", scene_index=1, plan_revision=plan_revision,
            instruction=instruction, scene=change,
        )

    assert isinstance(result, str)
    payload = json.loads(result)
    assert payload["ok"] is True
    assert payload["changedFields"] == ["animation", "visual"]
    assert payload["planRevision"] == plan_revision + 1
    saved = server._load_video_meta(tmp_path / "video_projects" / "edit-contract")
    assert saved["approvedPlanRevision"] == saved["planRevision"]
    assert saved["lastEdit"]["instruction"] == instruction
    assert saved["scenes"][0]["visual"] == change["visual"]
    assert saved["scenes"][0]["animation"] == change["animation"]


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
    monkeypatch.setattr("mona.agent.tools.video.get_workspace_path", lambda: tmp_path)
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
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="draft", name="write_file", arguments={"path": "video_projects/automatic/drafts/film.html", "content": '<!doctype html><html><head></head><body><div data-composition-id="film" data-width="1920" data-height="1080"><div id="subject">Prepared by the Agent</div></div><script>const tl=gsap.timeline({paused:true});tl.to("#subject",{x:200,duration:3});window.__timelines={film:tl};</script></body></html>'})]),
            LLMResponse(content="", finish_reason="tool_calls", tool_calls=[ToolCallRequest(id="sync", name="video", arguments={"action": "sync", "name": "automatic", "plan_revision": 1, "source_file": "drafts/film.html"})]),
            LLMResponse(content="画面已准备", finish_reason="stop"),
        ])
        loop = DocumentAgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path, model="test", agent_kind="video", services_port=service.port)
        effective = resolve_effective_agent_config(AgentDefinition(id="mona", display_name="Mona"), AgentUserConfig(granted_tools=["read_file", "write_file", "exec"]))
        loop.tools.set_allowed_tool_names(set(effective.allowed_tools or []))
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
