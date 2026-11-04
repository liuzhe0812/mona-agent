"""Editor DI and account/transport contracts; no real renderer or model is simulated as production."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from mona.agent.tools import canvas as canvas_module
from mona.agent.tools.canvas import CanvasTool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.office import OfficeTool
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.config.schema import HostedWorkConfig
from mona.hosted_work import editor_tools
from mona.hosted_work.contracts import WorkError, owner_key
from mona.office.client import OfficeServiceClient
from mona.office.errors import OfficeError

OWNER, OTHER = owner_key("101"), owner_key("102")
SESSION, RUN = "a" * 32, "b" * 32
TOKEN = "synthetic-website-session-not-a-real-token"


@pytest.fixture
def editors(tmp_path, monkeypatch):
    config = HostedWorkConfig(state_dir=str(tmp_path / "state"), bind_host="127.0.0.1", port=17175,
                              public_origin="https://mona-ai.cn", auth_origin="https://mona-ai.cn")
    events, requests = [], []
    payload = {"owner": OWNER, "session_id": SESSION, "run_id": RUN, "account_token": TOKEN,
               "metadata": {"canvas_id": "canvas_one"}}
    state = {"error": False}

    async def emit(kind, data):
        events.append((kind, data))

    async def response(request):
        requests.append(request)
        if state["error"]:
            return httpx.Response(401, json={"error": "login_required", "message": TOKEN})
        if request.url.path.endswith("/internal/tool"):
            body = json.loads(request.content)
            value = {"ok": True}
            if body["command"] == "canvas_agent_request" and body["args"]["action"] == "export":
                value["data"] = "<svg xmlns='http://www.w3.org/2000/svg'/>"
            return httpx.Response(200, json={"result": value})
        info = {"sessionId": "office_one", "displayName": "Document", "type": "docs",
                "version": {"editorEpoch": "epoch", "modelRevision": 0},
                "workingPath": str(Path(config.state_dir) / "users" / OWNER / "office" / SESSION
                                   / "sessions" / "office_one" / "working.docx")}
        if request.method == "GET" and request.url.path.endswith("/sessions"):
            return httpx.Response(200, json={"sessions": [info]})
        return httpx.Response(200, json=info)

    transport = httpx.MockTransport(response)
    original_client = httpx.AsyncClient

    def client(**kwargs):
        kwargs.setdefault("transport", transport)
        return original_client(**kwargs)

    monkeypatch.setattr(editor_tools.httpx, "AsyncClient", client)
    monkeypatch.setattr(editor_tools.httpx, "AsyncHTTPTransport", lambda **_: transport)
    canvas, office = editor_tools.build_editor_tools(config, payload, emit)
    return config, payload, canvas, office, events, requests, state


@pytest.mark.asyncio
async def test_canvas_optional_di_and_default_tauri_route_are_preserved(tmp_path, monkeypatch):
    default = CanvasTool(workspace=tmp_path)
    native = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(canvas_module, "tauri_invoke_async", native)
    context = RequestContext(channel="websocket", chat_id=SESSION, session_key="websocket:" + SESSION,
                             metadata={"canvas_id": "canvas_one"})
    default.set_context(context)
    assert json.loads(await default.execute("open"))["ok"]
    assert [call.args[0] for call in native.await_args_list] == ["canvas_activate_sidebar", "canvas_agent_request"]

    injected = AsyncMock(return_value={"ok": True})
    tool = CanvasTool(workspace=tmp_path, invoke=injected)
    tool.set_context(context)
    assert json.loads(await tool.execute("open"))["ok"]
    assert injected.await_count == 2 and native.await_count == 2


@pytest.mark.asyncio
async def test_office_optional_client_defaults_to_the_existing_factory(tmp_path, monkeypatch):
    client = Mock()
    client.list = AsyncMock(return_value=[])
    default_factory = Mock(return_value=client)
    monkeypatch.setattr(OfficeServiceClient, "from_port", default_factory)

    default = OfficeTool(workspace=tmp_path, services_port=19222)
    assert json.loads(await default.execute("list")) == {"sessions": []}
    default_factory.assert_called_once_with(19222)

    injected = Mock()
    injected.list = AsyncMock(return_value=[])
    tool = OfficeTool(workspace=tmp_path, service_client=injected)
    assert json.loads(await tool.execute("list")) == {"sessions": []}
    assert default_factory.call_count == 1
    injected.list.assert_awaited_once_with(owner_session_key="cli:direct")


@pytest.mark.asyncio
async def test_renderer_rpc_keeps_identity_only_in_headers_and_binds_run_and_session(editors):
    config, _, canvas, _, _, requests, _ = editors
    canvas_path = canvas.scope.root / "canvases" / "one.mona-canvas"
    result = json.loads(await canvas.execute("open", path="/workspace/canvases/one.mona-canvas"))

    assert result["ok"]
    assert len(requests) == 2
    for request in requests:
        assert str(request.url) == "http://127.0.0.1:17175/api/work/desktop/internal/tool"
        assert request.headers["Authorization"] == "Bearer " + TOKEN
        assert request.headers["Host"] == "mona-ai.cn"
        assert request.headers["Origin"] == config.public_origin
        body = json.loads(request.content)
        assert body["run_id"] == RUN and body["session_id"] == SESSION
        assert TOKEN not in request.content.decode()
        assert str(canvas_path) not in request.content.decode()
        assert body["args"]["path"] == "/workspace/canvases/one.mona-canvas"


@pytest.mark.asyncio
async def test_office_transport_drops_desktop_token_and_translates_owned_paths(editors):
    _, _, _, office, _, requests, _ = editors
    path = office.scope.root / "report.docx"
    path.write_bytes(b"document fixture")
    state = await office._service_client.open(owner_session_key="websocket:" + SESSION, path=path)

    request = requests[0]
    assert request.url.path == "/api/work/desktop/api/office/sessions"
    assert request.headers["Authorization"] == "Bearer " + TOKEN
    assert "X-Mona-Token" not in request.headers
    body = json.loads(request.content)
    assert body["path"] == "/workspace/report.docx" and TOKEN not in request.content.decode()
    assert state.working_path is None


def test_office_projected_working_paths_are_metadata_and_never_file_access(editors):
    _, _, _, office, _, _, _ = editors
    projected = "/workspace/.office/office_one/working.docx"
    assert office.scope.public_value({"workingPath": projected}) == {"workingPath": None}
    with pytest.raises(OfficeError):
        office.scope.host_path(projected)
    with pytest.raises(OfficeError):
        office.scope.public_value({"workingPath": "/workspace/.office/../working.docx"})


@pytest.mark.asyncio
async def test_original_office_ui_and_delivery_events_are_bound_and_logicalized(editors):
    _, _, _, office, events, _, _ = editors
    session = {"sessionId": "office_one", "type": "docs", "displayName": "Document",
               "version": {"editorEpoch": "epoch", "modelRevision": 0}}
    await office._publish_session_open(session)
    exported = office.scope.root / "result.docx"
    exported.write_bytes(b"local fixture")
    await office._publish_export(exported)

    assert events[0] == ("desktop", {"event": "message", "chat_id": SESSION, "task_id": RUN,
                                    "text": "", "kind": "progress",
                                    "agent_ui": {"kind": "office_session", "data": {
                                        "version": 1, "action": "open", "session": session}}})
    assert events[1][0] == "desktop" and events[1][1]["event"] == "deliver_files"
    assert events[1][1]["files"][0]["absolute_path"] == "/workspace/result.docx"
    assert str(office.scope.root) not in json.dumps(events) and TOKEN not in json.dumps(events)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["batch", "query", "get", "validate"])
async def test_hosted_office_refuses_legacy_cli_actions_before_any_client_call(editors, action, monkeypatch):
    _, _, _, office, _, requests, _ = editors
    import mona.api.office_cli as cli
    constructor = Mock(side_effect=AssertionError("host program must not be constructed"))
    monkeypatch.setattr(cli, "OfficeCliClient", constructor)

    result = json.loads(await office.execute(action, path="/workspace/report.docx"))

    assert result["error"]["code"] == "INVALID_OPERATION"
    assert not requests and not constructor.called


@pytest.mark.asyncio
async def test_foreign_host_paths_and_ambient_workspace_never_change_export_scope(editors):
    _, _, canvas, office, _, requests, _ = editors
    foreign = office.scope.root.parents[1] / OTHER / "documents" / "secret.docx"
    blocked = json.loads(await office.execute("export", session_id="office_one", output=str(foreign)))
    assert blocked["error"]["code"] == "INVALID_OPERATION" and not requests
    workspace_token = set_current_workspace(foreign.parent)
    try:
        result = json.loads(await canvas.execute("export", format="svg", output="/workspace/exports/result.svg"))
    finally:
        reset_current_workspace(workspace_token)

    assert result["ok"] and result["output"] == "/workspace/exports/result.svg"
    assert (canvas.scope.root / "exports/result.svg").is_file()
    assert not (foreign.parent / "exports/result.svg").exists()


@pytest.mark.asyncio
async def test_office_transport_rejects_another_host_or_session_and_does_not_echo_auth_failure(editors):
    _, _, _, office, _, requests, control = editors
    transport = office._service_client._transport
    for url, key in (("http://other.invalid/api/work/desktop/api/office/sessions", "websocket:" + SESSION),
                     (office.scope.endpoint + "/api/work/desktop/api/office/sessions", "websocket:" + "c" * 32)):
        with pytest.raises(OfficeError):
            await transport.handle_async_request(httpx.Request("GET", url, headers={"X-Mona-Session-Key": key}))
    assert not requests
    control["error"] = True
    result = await office.execute("list")
    assert json.loads(result)["error"]["code"] == "EDITOR_UNAVAILABLE"
    assert TOKEN not in result


def test_editor_context_cannot_switch_to_a_different_conversation(editors):
    _, _, canvas, office, _, requests, _ = editors
    foreign = RequestContext(channel="websocket", chat_id="c" * 32, session_key="websocket:" + "c" * 32)
    for tool in (canvas, office):
        with pytest.raises(OfficeError):
            tool.set_context(foreign)
    assert not requests


def test_builder_rejects_invalid_owner_before_creating_workspaces(tmp_path):
    config = HostedWorkConfig(state_dir=str(tmp_path))
    with pytest.raises(WorkError):
        editor_tools.build_editor_tools(config, {"owner": "../foreign"}, AsyncMock())
    assert list(tmp_path.iterdir()) == []
