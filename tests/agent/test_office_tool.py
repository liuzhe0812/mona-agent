from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from mona.agent.context import ContextBuilder
from mona.agent.tools.context import RequestContext, ToolContext
from mona.agent.tools.office import OfficeTool
from mona.bus.events import OUTBOUND_META_AGENT_UI
from mona.config.schema import ToolsConfig
from mona.office.capabilities import get_capabilities
from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.schemas import (
    CapabilitiesQuery,
    DocumentVersion,
    OfficeCommandSuccess,
    OfficeInspectSuccess,
    OfficeSessionState,
)


class _FakeOfficeClient:
    def __init__(self) -> None:
        self.owner: str | None = None
        self.export_output: str | None = None
        self.open_kwargs: dict[str, object] = {}
        self.applied_session_id: str | None = None
        self.applied_operations: list[object] = []
        self.inspected_session_id: str | None = None
        self.inspect_queries: list[object] = []

    async def open(self, *, owner_session_key: str, **kwargs) -> OfficeSessionState:
        self.owner = owner_session_key
        self.open_kwargs = kwargs
        return OfficeSessionState(
            session_id="office_1",
            display_name="input.xlsx",
            type="sheets",
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=0),
        )

    async def get(self, _session_id: str, *, owner_session_key: str) -> OfficeSessionState:
        return await self.open(owner_session_key=owner_session_key)

    async def list(self, *, owner_session_key: str) -> list[OfficeSessionState]:
        return [await self.open(owner_session_key=owner_session_key)]

    async def inspect(self, request, *, owner_session_key: str):
        self.owner = owner_session_key
        self.inspected_session_id = request.session_id
        self.inspect_queries.append(request.query)
        if request.query.mode == "review":
            return OfficeInspectSuccess(
                ok=True,
                request_id="inspect_review",
                session_id=request.session_id,
                version=DocumentVersion(editor_epoch="epoch_1", model_revision=0),
                result={"mode": "review", "documentType": "sheets", "pendingTargets": [], "warnings": []},
            )
        return OfficeInspectSuccess(
            ok=True,
            request_id="inspect_1",
            session_id=request.session_id,
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=0),
            result={
                "mode": "summary",
                "documentType": "slides",
                "slideCount": 1,
                "elementCount": 0,
            },
        )

    async def apply(self, command, *, owner_session_key: str):
        self.owner = owner_session_key
        self.applied_session_id = command.session_id
        self.applied_operations = command.operations
        return OfficeCommandSuccess(
            ok=True,
            session_id=command.session_id,
            operation_id=command.operation_id,
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=1),
            changed_targets=["Sheet1!A1"],
            summary="updated",
        )

    async def export(
        self,
        _session_id,
        *,
        owner_session_key: str,
        output: str,
        version=None,
    ):
        self.owner = owner_session_key
        self.export_output = output
        Path(output).write_bytes(b"office")
        return {
            "ok": True,
            "fileName": Path(output).name,
            "version": {"editorEpoch": "epoch_1", "modelRevision": 1},
        }


class _ConnectedOfficeClient(_FakeOfficeClient):
    async def open(self, *, owner_session_key: str, **kwargs) -> OfficeSessionState:
        state = await super().open(owner_session_key=owner_session_key, **kwargs)
        return state.model_copy(update={"editor_connected": True})

    async def get(self, session_id: str, *, owner_session_key: str) -> OfficeSessionState:
        state = await super().get(session_id, owner_session_key=owner_session_key)
        return state.model_copy(update={"editor_connected": True})

    async def inspect(self, request, *, owner_session_key: str):
        self.owner = owner_session_key
        self.inspected_session_id = request.session_id
        self.inspect_queries.append(request.query)
        return OfficeInspectSuccess(
            ok=True,
            request_id="inspect_selection",
            session_id=request.session_id,
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=3),
            result={
                "mode": "selection",
                "documentType": "sheets",
                "sheet": "Data",
                "range": "B2:C4",
            },
        )


class _BlankSlidesOfficeClient(_FakeOfficeClient):
    async def get(self, _session_id: str, *, owner_session_key: str) -> OfficeSessionState:
        self.owner = owner_session_key
        return OfficeSessionState(
            session_id="office_slides",
            display_name="blank.pptx",
            type="slides",
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=0),
            editor_connected=True,
        )

    async def inspect(self, request, *, owner_session_key: str):
        if request.query.mode != "slides":
            return await super().inspect(request, owner_session_key=owner_session_key)
        return OfficeInspectSuccess(
            ok=True,
            request_id="inspect_blank_slides",
            session_id=request.session_id,
            version=DocumentVersion(editor_epoch="epoch_1", model_revision=0),
            result={
                "mode": "slides",
                "slides": [{
                    "id": "s_1", "index": 0, "title": "", "width": 1280,
                    "height": 720, "elements": [],
                }],
            },
        )


def _tool(tmp_path: Path) -> OfficeTool:
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True)
    tool.set_context(RequestContext(channel="web", chat_id="1", session_key="web:chat:1"))
    return tool


def test_create_uses_services_port_from_tool_context(tmp_path: Path) -> None:
    tool = OfficeTool.create(
        ToolContext(
            config=ToolsConfig(),
            workspace=str(tmp_path),
            services_port=18174,
        )
    )

    assert isinstance(tool, OfficeTool)
    assert tool._services_port == 18174


def test_model_visible_actions_only_expose_live_editor_workflow(tmp_path: Path) -> None:
    action = _tool(tmp_path).parameters["properties"]["action"]

    assert action["enum"] == ["list", "open", "inspect", "apply", "save", "export", "close"]
    assert "current in-memory document" in OfficeTool.description
    assert "legacy" not in OfficeTool.description.lower()


def test_capabilities_query_defaults_and_limits_operations() -> None:
    assert CapabilitiesQuery(mode="capabilities").operations == []

    with pytest.raises(ValidationError):
        CapabilitiesQuery(
            mode="capabilities",
            operations=[f"operation_{index}" for index in range(21)],
        )


def test_runtime_context_identifies_the_active_office_document() -> None:
    context = ContextBuilder._build_runtime_context(
        "websocket",
        "chat-1",
        office_session_id="office_123",
        office_document_type="slides",
        office_display_name="季度汇报.pptx",
    )

    assert "Active Office Document: 季度汇报.pptx (PowerPoint)" in context
    assert "Session ID: office_123" in context


async def test_open_uses_live_office_session_and_request_owner(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "input.xlsx"
    source.write_bytes(b"xlsx")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="open", path="input.xlsx"))

    assert payload["sessionId"] == "office_1"
    assert fake.owner == "web:chat:1"


async def test_open_returns_connected_selection_and_latest_version(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source = tmp_path / "input.xlsx"
    source.write_bytes(b"xlsx")
    fake = _ConnectedOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="open", path="input.xlsx"))

    assert payload["version"] == {"editorEpoch": "epoch_1", "modelRevision": 3}
    assert payload["selection"]["mode"] == "selection"
    assert payload["selection"]["documentType"] == "sheets"
    assert payload["selection"]["sheet"] == "Data"
    assert payload["selection"]["range"] == "B2:C4"
    assert fake.inspect_queries[0].mode == "selection"
    assert "checkpointVersion" not in payload
    assert "savedVersion" not in payload
    assert "lastError" not in payload


async def test_list_returns_sessions_owned_by_current_chat(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="list"))

    assert [session["sessionId"] for session in payload["sessions"]] == ["office_1"]
    assert fake.owner == "web:chat:1"


async def test_new_document_open_forwards_the_visible_name(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    await tool.execute(
        action="open",
        document_type="sheets",
        display_name="年度销售表",
    )

    assert fake.open_kwargs["document_type"] == "sheets"
    assert fake.open_kwargs["display_name"] == "年度销售表"


async def test_open_with_session_id_republishes_recovered_session(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="open", session_id="office_1"))

    assert payload["sessionId"] == "office_1"
    assert fake.owner == "web:chat:1"


async def test_open_with_session_id_returns_connected_selection(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _ConnectedOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="open", session_id="office_1"))

    assert payload["sessionId"] == "office_1"
    assert payload["selection"]["range"] == "B2:C4"
    assert payload["version"]["modelRevision"] == 3
    assert fake.inspect_queries[0].mode == "selection"


async def test_editor_unavailable_returns_session_recovery_action(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class UnavailableClient(_FakeOfficeClient):
        async def get(self, _session_id: str, *, owner_session_key: str) -> OfficeSessionState:
            raise OfficeError(
                OfficeErrorCode.EDITOR_UNAVAILABLE,
                "Office 编辑器尚未连接。",
                retryable=True,
            )

    fake = UnavailableClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(action="open", session_id="office_1"))

    assert payload["ok"] is False
    assert payload["error"]["code"] == "EDITOR_UNAVAILABLE"
    assert payload["recovery"] == {"action": "open", "session_id": "office_1"}


async def test_open_publishes_structured_office_session_event(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "input.xlsx"
    source.write_bytes(b"xlsx")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )

    class Bus:
        def __init__(self) -> None:
            self.messages = []

        async def publish_outbound(self, message) -> None:
            self.messages.append(message)

    bus = Bus()
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True, bus=bus)
    tool.set_context(RequestContext(channel="web", chat_id="1", session_key="web:chat:1"))

    await tool.execute(action="open", path="input.xlsx")

    assert len(bus.messages) == 1
    event = bus.messages[0].metadata[OUTBOUND_META_AGENT_UI]
    assert event["kind"] == "office_session"
    assert event["data"]["version"] == 1
    assert event["data"]["action"] == "open"
    assert event["data"]["session"]["sessionId"] == "office_1"
    assert event["data"]["session"]["editorConnected"] is False


async def test_open_waits_for_the_launched_editor_without_extra_model_rounds(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source = tmp_path / "input.xlsx"
    source.write_bytes(b"xlsx")

    class ConnectingClient(_FakeOfficeClient):
        def __init__(self) -> None:
            super().__init__()
            self.get_calls = 0

        async def get(self, session_id: str, *, owner_session_key: str) -> OfficeSessionState:
            self.get_calls += 1
            state = await super().get(session_id, owner_session_key=owner_session_key)
            return state.model_copy(update={"editor_connected": True})

        async def inspect(self, request, *, owner_session_key: str):
            return await _ConnectedOfficeClient.inspect(self, request, owner_session_key=owner_session_key)

    class Bus:
        def __init__(self) -> None:
            self.messages = []

        async def publish_outbound(self, message) -> None:
            self.messages.append(message)

    fake = ConnectingClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    bus = Bus()
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True, bus=bus)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="1",
            session_key="websocket:chat:1",
        )
    )

    payload = json.loads(await tool.execute(action="open", path="input.xlsx"))

    assert payload["editorConnected"] is True
    assert fake.get_calls == 1
    assert payload["selection"]["mode"] == "selection"
    assert bus.messages[0].metadata[OUTBOUND_META_AGENT_UI]["data"]["session"][
        "editorConnected"
    ] is False


async def test_apply_returns_editor_authoritative_version(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(
        await tool.execute(
            action="apply",
            session_id="office_1",
            expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
            operations=[
                {
                    "op": "set_cell",
                    "payload": {"sheet": "Sheet1", "cell": "A1", "value": "updated"},
                }
            ],
        )
    )

    assert payload["ok"] is True
    assert payload["version"] == {"editorEpoch": "epoch_1", "modelRevision": 1}


async def test_apply_defaults_to_the_active_office_session(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="1",
            session_key="websocket:chat:1",
            metadata={"office_session_id": "office_active"},
        )
    )

    payload = json.loads(
        await tool.execute(
            action="apply",
            expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
            operations=[
                {
                    "op": "slide_add",
                    "payload": {"layout": "blank"},
                }
            ],
        )
    )

    assert payload["ok"] is True
    assert fake.applied_session_id == "office_active"


async def test_blank_slides_allow_direct_native_creation(tmp_path: Path, monkeypatch) -> None:
    fake = _BlankSlidesOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(await tool.execute(
        action="apply",
        session_id="office_slides",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[{"op": "slide_add_text", "payload": {
            "slideId": "s_1", "text": "原生设计", "x": 10, "y": 10,
            "width": 300, "height": 60,
        }}],
    ))

    assert payload["ok"] is True
    assert payload["version"] == {"editorEpoch": "epoch_1", "modelRevision": 1}
    assert fake.applied_session_id == "office_slides"
    assert fake.owner == "web:chat:1"
    assert fake.applied_operations[0].op == "slide_add_text"
    assert fake.applied_operations[0].payload["text"] == "原生设计"
    assert fake.inspect_queries == []


async def test_inspect_defaults_to_the_active_office_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="1",
            session_key="websocket:chat:1",
            metadata={"office_session_id": "office_active"},
        )
    )

    payload = json.loads(await tool.execute(action="inspect", query={"mode": "summary"}))

    assert payload["result"]["documentType"] == "slides"
    assert fake.inspected_session_id == "office_active"


async def test_capabilities_for_sheets_are_served_from_python_contract(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(
        await tool.execute(
            action="inspect",
            session_id="office_1",
            query={"mode": "capabilities", "elementType": "cell"},
        )
    )

    assert payload["result"]["mode"] == "capabilities"
    assert payload["result"]["documentType"] == "sheets"
    assert [item["op"] for item in payload["result"]["operations"]] == [
        "set_cell",
        "set_formula",
        "set_style",
    ]
    assert payload["result"]["operations"][0]["payloadSchema"]["type"] == "object"
    assert fake.inspected_session_id is None


async def test_capabilities_for_sheets_filters_requested_operations(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    payload = json.loads(
        await tool.execute(
            action="inspect",
            session_id="office_1",
            query={
                "mode": "capabilities",
                "operations": ["set_style", "set_formula"],
            },
        )
    )

    assert [item["op"] for item in payload["result"]["operations"]] == [
        "set_formula",
        "set_style",
    ]


def test_capabilities_reject_unknown_requested_operation() -> None:
    with pytest.raises(ValueError, match="unknown operation"):
        get_capabilities("sheets", operations=["not_a_sheet_operation"])


async def test_tool_reports_unknown_capability_operation(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    result = await tool.execute(
        action="inspect",
        session_id="office_1",
        query={"mode": "capabilities", "operations": ["not_a_sheet_operation"]},
    )

    assert result.startswith("Error: unknown operation")


async def test_capabilities_for_slides_are_forwarded_to_editor(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class SlidesClient(_FakeOfficeClient):
        async def get(self, _session_id: str, *, owner_session_key: str) -> OfficeSessionState:
            return OfficeSessionState(
                session_id="office_slides",
                display_name="slides.pptx",
                type="slides",
                version=DocumentVersion(editor_epoch="epoch_slides", model_revision=3),
            )

    fake = SlidesClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    await tool.execute(
        action="inspect",
        session_id="office_slides",
        query={"mode": "capabilities", "elementType": "shape"},
    )

    assert fake.inspected_session_id == "office_slides"


async def test_slide_add_image_asset_path_is_scoped_and_converted(
    tmp_path: Path,
    monkeypatch,
) -> None:
    asset = tmp_path / "picture.png"
    asset.write_bytes(b"png-bytes")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    await tool.execute(
        action="apply",
        session_id="office_1",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[
            {
                "op": "slide_add_image",
                "payload": {"slideId": "slide_1", "assetPath": "picture.png"},
            }
        ],
    )

    payload = fake.applied_operations[0].payload
    assert "assetPath" not in payload
    assert payload["dataUrl"] == (
        "data:image/png;base64," + base64.b64encode(b"png-bytes").decode("ascii")
    )


async def test_slide_compose_converts_only_image_asset_paths(
    tmp_path: Path,
    monkeypatch,
) -> None:
    asset = tmp_path / "picture.svg"
    asset.write_bytes(b"<svg />")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    await tool.execute(
        action="apply",
        session_id="office_1",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[
            {
                "op": "slide_compose",
                "payload": {
                    "slideId": "slide_1",
                    "columns": [1],
                    "rows": [1],
                    "items": [
                        {"type": "image", "column": 0, "row": 0, "assetPath": "picture.svg"},
                        {"type": "text", "column": 0, "row": 0, "assetPath": "keep"},
                    ],
                },
            }
        ],
    )

    items = fake.applied_operations[0].payload["items"]
    assert "assetPath" not in items[0]
    assert items[0]["dataUrl"].startswith("data:image/svg+xml;base64,")
    assert items[1]["assetPath"] == "keep"


async def test_slide_add_preset_converts_only_the_required_image_asset_path(
    tmp_path: Path,
    monkeypatch,
) -> None:
    asset = tmp_path / "product.png"
    asset.write_bytes(b"png-bytes")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    result = await tool.execute(
        action="apply",
        session_id="office_1",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[
            {
                "op": "slide_add_preset",
                "payload": {
                    "slideId": "slide_1",
                    "presetId": "dark-product-hero",
                    "content": {"title": "产品发布", "image": {"assetPath": "product.png"}},
                },
            },
            {
                "op": "slide_add_preset",
                "payload": {
                    "slideId": "slide_1",
                    "presetId": "light-process-map",
                    "content": {"title": "实施路径"},
                },
            },
        ],
    )

    assert fake.applied_operations, result
    content = fake.applied_operations[0].payload["content"]
    assert "assetPath" not in content["image"]
    assert content["image"]["dataUrl"] == (
        "data:image/png;base64," + base64.b64encode(b"png-bytes").decode("ascii")
    )
    assert fake.applied_operations[1].payload["content"] == {"title": "实施路径"}


async def test_slide_add_preset_rejects_an_asset_path_outside_the_workspace(
    tmp_path: Path,
    monkeypatch,
) -> None:
    outside = tmp_path.parent / "outside.png"
    outside.write_bytes(b"png-bytes")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    result = await tool.execute(
        action="apply",
        session_id="office_1",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[
            {
                "op": "slide_add_preset",
                "payload": {
                    "slideId": "slide_1",
                    "presetId": "dark-product-hero",
                    "content": {"title": "产品发布", "image": {"assetPath": str(outside)}},
                },
            }
        ],
    )

    assert result.startswith("Error:")
    assert fake.applied_operations == []


async def test_preset_preview_resolves_asset_and_preserves_read_only_contract(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "product.png").write_bytes(b"png-bytes")
    fake = _FakeOfficeClient()
    monkeypatch.setattr("mona.agent.tools.office.OfficeServiceClient.from_port", lambda _port: fake)
    result = await _tool(tmp_path).execute(action="inspect", session_id="office_1", query={
        "mode": "visual", "presetId": "dark-product-hero",
        "presetContent": {"title": "产品", "image": {"assetPath": "product.png"}},
    })
    assert fake.inspect_queries, result
    query = fake.inspect_queries[0]
    assert query.preset_id == "dark-product-hero"
    assert query.preset_content["image"] == {"dataUrl": "data:image/png;base64,cG5nLWJ5dGVz"}
    assert fake.applied_operations == []


def test_preset_candidate_query_and_result_cross_process_schema() -> None:
    query = CapabilitiesQuery.model_validate({"mode": "capabilities", "presetContent": {"title": "季度复盘"}, "presetTheme": "light-editorial"})
    assert query.model_dump(by_alias=True)["presetContent"]["title"] == "季度复盘"
    result = OfficeInspectSuccess.model_validate({
        "ok": True, "requestId": "q", "sessionId": "s",
        "version": {"editorEpoch": "e", "modelRevision": 0},
        "result": {"mode": "capabilities", "documentType": "slides", "operations": [],
                   "presets": [{"id": "light-metric", "family": "spotlight"}]},
    })
    assert result.result.model_dump(by_alias=True)["presets"][0]["id"] == "light-metric"


@pytest.mark.parametrize(
    ("extension", "mime"),
    [
        (".jpg", "image/jpeg"),
        (".png", "image/png"),
        (".webp", "image/webp"),
        (".gif", "image/gif"),
        (".bmp", "image/bmp"),
        (".svg", "image/svg+xml"),
    ],
)
async def test_slide_image_asset_path_accepts_supported_image_types(
    tmp_path: Path,
    monkeypatch,
    extension: str,
    mime: str,
) -> None:
    asset = tmp_path / f"picture{extension}"
    asset.write_bytes(b"image")
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    await tool.execute(
        action="apply",
        session_id="office_1",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[
            {
                "op": "slide_add_image",
                "payload": {"assetPath": asset.name},
            }
        ],
    )

    assert fake.applied_operations[0].payload["dataUrl"].startswith(f"data:{mime};base64,")


async def test_slide_image_asset_path_rejects_escape_unsupported_type_and_oversize(
    tmp_path: Path,
    monkeypatch,
) -> None:
    outside = tmp_path.parent / "outside.png"
    outside.write_bytes(b"outside")
    unsupported = tmp_path / "picture.txt"
    unsupported.write_bytes(b"text")
    oversized = tmp_path / "large.png"
    oversized.write_bytes(b"x" * (10 * 1024 * 1024 + 1))
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)
    command = {
        "action": "apply",
        "session_id": "office_1",
        "expected_version": {"editorEpoch": "epoch_1", "modelRevision": 0},
    }

    for asset_path in (str(outside), unsupported.name, oversized.name):
        result = await tool.execute(
            **command,
            operations=[
                {"op": "slide_add_image", "payload": {"assetPath": asset_path}}
            ],
        )
        assert result.startswith("Error:")

    assert fake.applied_operations == []


async def test_explicit_office_session_overrides_the_active_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True)
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="1",
            session_key="websocket:chat:1",
            metadata={"office_session_id": "office_active"},
        )
    )

    await tool.execute(
        action="apply",
        session_id="office_explicit",
        expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
        operations=[{"op": "slide_add", "payload": {"layout": "blank"}}],
    )

    assert fake.applied_session_id == "office_explicit"


async def test_export_stays_in_active_workspace_and_publishes_artifact(
    tmp_path: Path,
    monkeypatch,
) -> None:
    class Bus:
        def __init__(self) -> None:
            self.messages = []

        async def publish_outbound(self, message) -> None:
            self.messages.append(message)

    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    bus = Bus()
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True, bus=bus)
    tool.set_context(RequestContext(channel="web", chat_id="1", session_key="web:chat:1"))

    payload = json.loads(
        await tool.execute(
            action="export",
            session_id="office_1",
            output="result.xlsx",
        )
    )

    assert payload["ok"] is True
    assert fake.export_output == str((tmp_path / "result.xlsx").resolve())
    assert bus.messages[0].metadata["_deliver_files"][0]["artifact_ref"]["relative_path"] == (
        "result.xlsx"
    )


async def test_export_rejects_path_outside_active_workspace(tmp_path: Path, monkeypatch) -> None:
    fake = _FakeOfficeClient()
    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: fake,
    )
    tool = _tool(tmp_path)

    result = await tool.execute(
        action="export",
        session_id="office_1",
        output=str(tmp_path.parent / "outside.xlsx"),
    )

    assert result.startswith("Error: path not allowed:")
    assert fake.export_output is None


async def test_session_error_is_returned_as_stable_json(tmp_path: Path, monkeypatch) -> None:
    class _FailingClient(_FakeOfficeClient):
        async def apply(self, command, *, owner_session_key: str):
            raise OfficeError(
                OfficeErrorCode.VERSION_CONFLICT,
                "文档已变化",
                retryable=True,
            )

    monkeypatch.setattr(
        "mona.agent.tools.office.OfficeServiceClient.from_port",
        lambda _port: _FailingClient(),
    )
    tool = _tool(tmp_path)

    payload = json.loads(
        await tool.execute(
            action="apply",
            session_id="office_1",
            expected_version={"editorEpoch": "epoch_1", "modelRevision": 0},
            operations=[
                {
                    "op": "clear_range",
                    "payload": {"sheet": "Sheet1", "range": "A1:A2"},
                }
            ],
        )
    )

    assert payload == {
        "ok": False,
        "error": {
            "code": "VERSION_CONFLICT",
            "message": "文档已变化",
            "retryable": True,
        },
    }
