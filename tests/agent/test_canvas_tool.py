from __future__ import annotations

import base64
import json

import pytest

from mona.agent.partners import MONA_AGENT_ID, AgentRegistry
from mona.agent.tools.canvas import CanvasTool
from mona.agent.tools.context import RequestContext
from mona.agent.user_config import AgentUserConfig, resolve_effective_agent_config


def test_canvas_stays_available_to_mona_when_an_older_tool_selection_is_saved():
    effective = resolve_effective_agent_config(
        AgentRegistry().require(MONA_AGENT_ID),
        AgentUserConfig(granted_tools=["exec", "skill_read"]),
    )

    assert effective.allowed_tools is not None
    assert "canvas" in effective.allowed_tools


def test_canvas_context_survives_follow_up_in_the_same_session_and_clears_on_switch(tmp_path):
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        session_key="websocket:chat-1",
        metadata={"canvas_id": "canvas-1", "canvas_path": "saved.mona-canvas"},
    ))

    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        session_key="websocket:chat-1",
        metadata={},
    ))
    assert tool.is_available is True
    assert tool._active_canvas_id == "canvas-1"
    assert tool._active_canvas_path == "saved.mona-canvas"

    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-2",
        session_key="websocket:chat-2",
        metadata={},
    ))
    assert tool.is_available is False
    assert tool._active_canvas_id is None
    assert tool._active_canvas_path is None


def test_canvas_context_recovers_from_the_chat_workspace_after_process_restart(tmp_path):
    canvas_dir = tmp_path / "canvases"
    canvas_dir.mkdir()
    canvas_file = canvas_dir / "saved.mona-canvas"
    canvas_file.write_text(json.dumps({
        "id": "canvas-restored",
        "originChatId": "chat-1",
    }), encoding="utf-8")

    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        session_key="websocket:chat-1",
        metadata={},
    ))

    assert tool.is_available is True
    assert tool._active_canvas_id == "canvas-restored"
    assert tool._active_canvas_path == str(canvas_file.resolve())


@pytest.mark.asyncio
async def test_canvas_inspect_uses_active_canvas_and_returns_visual(monkeypatch, tmp_path):
    captured = {}

    async def fake_invoke(command, request):
        captured["command"] = command
        captured["request"] = request
        return {
            "ok": True,
            "canvasId": "canvas-1",
            "documentHash": "d1",
            "renderedQuality": {"status": "ready", "issues": []},
            "visualData": "data:image/png;base64,AA==",
        }

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    assert tool.is_available is False
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="chat-1",
            metadata={"canvas_id": "canvas-1"},
        )
    )
    assert tool.is_available is True

    result = await tool.execute(action="inspect", include_visual=True)

    assert isinstance(result, list)
    assert captured["command"] == "canvas_agent_request"
    assert captured["request"]["canvasId"] == "canvas-1"
    assert captured["request"]["includeVisual"] is True
    assert result[1]["type"] == "image_url"
    assert "visualData" not in result[0]["text"]


@pytest.mark.asyncio
async def test_canvas_visual_inspect_fails_when_editor_cannot_capture_a_real_image(monkeypatch, tmp_path):
    async def fake_invoke(_command, _request):
        return {
            "ok": True,
            "status": "ready",
            "canvasId": "canvas-1",
            "renderedQuality": {
                "status": "unavailable",
                "issues": [],
                "message": "画布当前不可见",
            },
            "visualData": "data:,",
        }

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        metadata={"canvas_id": "canvas-1"},
    ))

    result = json.loads(await tool.execute(action="inspect", include_visual=True))

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["message"].startswith("画布当前不可见")
    assert "不要向用户声称" in result["message"]


@pytest.mark.asyncio
async def test_canvas_visual_inspect_reactivates_a_hidden_saved_canvas(monkeypatch, tmp_path):
    canvas_file = tmp_path / "saved.mona-canvas"
    canvas_file.write_text("{}", encoding="utf-8")
    calls = []

    async def fake_invoke(command, request):
        calls.append((command, dict(request)))
        if command == "canvas_activate_sidebar":
            return {"activated": True}
        if request.get("action") == "open":
            return {"ok": True, "status": "ready", "canvasId": "canvas-1"}
        return {
            "ok": True,
            "status": "ready",
            "renderedQuality": {"status": "ready", "issues": []},
            "visualData": "data:image/png;base64,AA==",
        }

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        metadata={"canvas_id": "canvas-1", "canvas_path": "saved.mona-canvas"},
    ))

    result = await tool.execute(action="inspect", include_visual=True)

    assert isinstance(result, list)
    assert [command for command, _ in calls] == [
        "canvas_activate_sidebar",
        "canvas_agent_request",
        "canvas_agent_request",
    ]


@pytest.mark.asyncio
async def test_canvas_open_reactivates_saved_canvas_after_editor_unmount(monkeypatch, tmp_path):
    canvas_file = tmp_path / "saved.mona-canvas"
    canvas_file.write_text("{}", encoding="utf-8")
    calls = []

    async def fake_invoke(command, request):
        calls.append((command, request))
        if command == "canvas_activate_sidebar":
            return {"activated": True}
        return {"ok": True, "status": "ready", "canvasId": "canvas-1"}

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        metadata={"canvas_id": "canvas-1", "canvas_path": "saved.mona-canvas"},
    ))

    result = json.loads(await tool.execute(action="open"))

    assert result["status"] == "ready"
    assert [command for command, _ in calls] == [
        "canvas_activate_sidebar",
        "canvas_agent_request",
    ]
    assert calls[1][1]["path"] == str(canvas_file.resolve())


@pytest.mark.asyncio
async def test_canvas_apply_reactivates_saved_canvas_and_retries_with_hash_protection(monkeypatch, tmp_path):
    canvas_file = tmp_path / "saved.mona-canvas"
    canvas_file.write_text("{}", encoding="utf-8")
    calls = []

    async def fake_invoke(command, request):
        calls.append((command, dict(request)))
        if command == "canvas_activate_sidebar":
            return {"activated": True}
        if request.get("action") == "open":
            return {"ok": True, "status": "ready", "canvasId": "canvas-1"}
        return {"ok": True, "status": "applied", "canvasId": "canvas-1"}

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        metadata={"canvas_id": "canvas-1", "canvas_path": "saved.mona-canvas"},
    ))
    patch = {"baseHash": "h-current", "baseDocumentHash": "d-current", "ops": []}

    result = json.loads(await tool.execute(action="apply", patch=patch))

    assert result["status"] == "applied"
    assert calls[2][1]["patch"] == patch
    assert [command for command, _ in calls] == [
        "canvas_activate_sidebar",
        "canvas_agent_request",
        "canvas_agent_request",
    ]


@pytest.mark.asyncio
async def test_canvas_apply_requires_patch(tmp_path):
    tool = CanvasTool(workspace=tmp_path)
    assert await tool.execute(action="apply") == "Error: 'patch' or 'patch_path' is required for apply"


@pytest.mark.asyncio
async def test_canvas_apply_loads_workspace_patch_file_and_injects_hashes(monkeypatch, tmp_path):
    captured = {}

    async def fake_invoke(_command, request):
        captured.update(request)
        return {"ok": True, "status": "applied"}

    patch_file = tmp_path / "template.json"
    patch_file.write_text(
        json.dumps({"baseHash": "<open>", "baseDocumentHash": "<open>", "ops": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(RequestContext(
        channel="websocket",
        chat_id="chat-1",
        metadata={"canvas_id": "canvas-1"},
    ))

    result = json.loads(await tool.execute(
        action="apply",
        patch_path="template.json",
        base_hash="h-current",
        base_document_hash="d-current",
    ))

    assert result["status"] == "applied"
    assert captured["patch"]["baseHash"] == "h-current"
    assert captured["patch"]["baseDocumentHash"] == "d-current"


@pytest.mark.asyncio
async def test_canvas_does_not_impose_a_fixed_number_of_repairs(monkeypatch, tmp_path):
    calls = 0

    async def fake_invoke(_command, _request):
        nonlocal calls
        calls += 1
        if _command == "canvas_activate_sidebar":
            return {"activated": True}
        if _request.get("action") == "open":
            return {"ok": True, "status": "ready"}
        return {"ok": True, "status": "applied"}

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    tool = CanvasTool(workspace=tmp_path)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="chat-1",
            metadata={"canvas_id": "canvas-1", "task_id": "task-1"},
        )
    )
    for _ in range(4):
        result = json.loads(await tool.execute(action="apply", patch={
            "baseHash": "h",
            "baseDocumentHash": "d",
            "ops": [],
        }))
        assert result["status"] == "applied"
    assert calls == 12


@pytest.mark.asyncio
async def test_canvas_export_writes_inside_workspace(monkeypatch, tmp_path):
    payload = base64.b64encode(b"png-bytes").decode("ascii")

    async def fake_invoke(_command, _request):
        return {
            "ok": True,
            "status": "exported",
            "canvasId": "canvas-1",
            "data": f"data:image/png;base64,{payload}",
        }

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)

    result = await tool.execute(
        action="export",
        canvas_id="canvas-1",
        format="png",
        output="output/final.png",
    )

    parsed = json.loads(result)
    assert parsed["status"] == "exported"
    assert parsed["bytes"] == len(b"png-bytes")
    assert (tmp_path / "output" / "final.png").read_bytes() == b"png-bytes"


@pytest.mark.asyncio
async def test_canvas_export_decodes_svg_data_url(monkeypatch, tmp_path):
    async def fake_invoke(_command, _request):
        return {
            "ok": True,
            "status": "exported",
            "canvasId": "canvas-1",
            "data": "data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%2010%2010%22%2F%3E",
        }

    monkeypatch.setattr("mona.agent.tools.canvas.tauri_invoke_async", fake_invoke)
    monkeypatch.setattr("mona.agent.tools.canvas.get_current_workspace", lambda _path: None)
    tool = CanvasTool(workspace=tmp_path)
    result = await tool.execute(
        action="export",
        canvas_id="canvas-1",
        format="svg",
        output="output/final.svg",
    )

    assert json.loads(result)["status"] == "exported"
    assert (tmp_path / "output" / "final.svg").read_text(encoding="utf-8") == '<svg viewBox="0 0 10 10"/>'
