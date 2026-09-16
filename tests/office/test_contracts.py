from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from mona.office.capabilities import get_capabilities
from mona.office.schemas import (
    CapabilitiesResult,
    DocumentVersion,
    OfficeApplyCommand,
    OfficeCheckpointMetadata,
    OfficeCommandResult,
    OfficeInspectRequest,
    OfficeInspectResponse,
    OfficeInspectResult,
    OfficeSessionState,
    OfficeSocketMessage,
    SelectionResult,
    SlidesQuery,
    VisualQuery,
)

FIXTURE_PATH = Path(__file__).parents[1] / "fixtures" / "office" / "d0-contract.json"


def test_python_capabilities_keep_docs_and_sheets_operations() -> None:
    docs = get_capabilities("docs")
    sheets = get_capabilities("sheets")

    assert {item["op"] for item in docs} >= {
        "replace_block_text",
        "insert_title",
        "insert_table",
        "set_table_style",
        "set_page_style",
        "set_header_footer",
    }
    assert {item["op"] for item in sheets} >= {
        "set_cell",
        "set_range",
        "set_formula",
        "set_style",
        "set_conditional_format",
    }
    table_style = next(item for item in docs if item["op"] == "set_table_style")
    assert set(table_style["payloadSchema"]["properties"]) >= {
        "headerBold",
        "headerAlign",
        "verticalAlign",
        "allowRowBreakAcrossPages",
    }
    assert all(set(item) == {"op", "payloadSchema", "description"} for item in docs + sheets)


def test_direct_slide_chart_and_visual_review_reason_roundtrip() -> None:
    command = OfficeApplyCommand.model_validate({
        "sessionId": "office_1", "operationId": "chart_1",
        "expectedVersion": {"editorEpoch": "epoch", "modelRevision": 1},
        "operations": [{"op": "slide_add_chart", "payload": {
            "slideId": "s_1", "x": 48, "y": 180, "width": 900, "height": 450,
            "kind": "bar", "categories": ["A", "B"], "series": [{"name": "分数", "values": [80, 90]}],
        }}],
    })
    assert command.model_dump(by_alias=True)["operations"][0]["payload"]["series"][0]["values"] == [80, 90]
    result = OfficeInspectResult.model_validate({
        "sessionId": "office_1",
        "version": {"editorEpoch": "epoch", "modelRevision": 1},
        "result": {"mode": "visual", "dataUrl": "data:image/png;base64,AA==", "width": 1280,
                   "height": 720, "target": "s_1", "reviewReason": "保留原文引用", "warnings": []},
    })
    assert result.model_dump(by_alias=True)["result"]["reviewReason"] == "保留原文引用"


def test_python_contract_accepts_shared_d0_fixture() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    DocumentVersion.model_validate(fixture["documentVersion"])
    OfficeSessionState.model_validate(fixture["session"])
    for request in fixture["inspectRequests"]:
        OfficeInspectRequest.model_validate(request)
    for result in fixture["inspectResults"]:
        OfficeInspectResult.model_validate(result)
    OfficeApplyCommand.model_validate(fixture["command"])
    result_adapter = TypeAdapter(OfficeCommandResult)
    for result in fixture["commandResults"]:
        result_adapter.validate_python(result)
    OfficeCheckpointMetadata.model_validate(fixture["checkpoint"])
    socket_adapter = TypeAdapter(OfficeSocketMessage)
    for message in fixture["socketMessages"]:
        socket_adapter.validate_python(message)

    d1 = fixture["d1"]
    for request in d1["inspectRequests"]:
        OfficeInspectRequest.model_validate(request)
    for result in d1["inspectResults"]:
        OfficeInspectResult.model_validate(result)
    for failure in d1["inspectFailures"]:
        TypeAdapter(OfficeInspectResponse).validate_python(failure)
    for command in d1["commands"]:
        OfficeApplyCommand.model_validate(command)
    for result in d1["commandResults"]:
        result_adapter.validate_python(result)
    for message in d1["blankOpenMessages"]:
        socket_adapter.validate_python(message)


def test_python_contract_serializes_wire_fields_as_camel_case() -> None:
    version = DocumentVersion(editor_epoch="epoch_1", model_revision=2)

    assert version.model_dump(by_alias=True) == {
        "editorEpoch": "epoch_1",
        "modelRevision": 2,
    }


def test_python_contract_accepts_capabilities_selection_and_visual_extensions() -> None:
    slides_request = OfficeInspectRequest.model_validate(
        {
            "sessionId": "office_slides",
            "query": {
                "mode": "slides",
                "slideIds": ["slide_1"],
                "elementIds": ["element_1"],
            },
        }
    )
    assert isinstance(slides_request.query, SlidesQuery)
    assert slides_request.query.element_ids == ["element_1"]

    capabilities_request = OfficeInspectRequest.model_validate(
        {
            "sessionId": "office_docs",
            "query": {
                "mode": "capabilities",
                "documentType": "docs",
                "elementType": "table",
            },
        }
    )
    assert capabilities_request.query.document_type == "docs"
    capabilities = OfficeInspectResult.model_validate(
        {
            "sessionId": "office_docs",
            "version": {"editorEpoch": "epoch_docs", "modelRevision": 1},
            "result": {
                "mode": "capabilities",
                "documentType": "docs",
                "operations": [{"op": "set_table_cell", "payload": {"blockId": "table_1"}}],
            },
        }
    ).result
    assert isinstance(capabilities, CapabilitiesResult)
    assert capabilities.operations[0]["op"] == "set_table_cell"

    visual = OfficeInspectRequest.model_validate(
        {
            "sessionId": "office_slides",
            "query": {
                "mode": "visual",
                "elementIds": ["element_1"],
                "region": {"x": 10, "y": 20, "width": 300, "height": 180},
                "padding": 24,
                "acceptWarnings": True,
                "reviewReason": "已确认文字位于图片留白区。",
            },
        }
    ).query
    assert isinstance(visual, VisualQuery)
    assert visual.region is not None
    assert visual.region.width == 300
    assert visual.padding == 24
    assert visual.accept_warnings is True
    assert visual.review_reason == "已确认文字位于图片留白区。"

    selection = SelectionResult.model_validate(
        {
            "mode": "selection",
            "documentType": "slides",
            "slideId": "slide_1",
            "elementIds": ["element_1"],
            "elements": [
                {
                    "id": "element_1",
                    "type": "text",
                    "x": 10,
                    "y": 20,
                    "width": 100,
                    "height": 30,
                    "text": "标题",
                }
            ],
            "slideWidth": 1280,
            "slideHeight": 720,
        }
    )
    assert selection.elements[0].id == "element_1"
    assert selection.model_dump(by_alias=True)["slideWidth"] == 1280
    assert selection.model_dump(by_alias=True)["slideHeight"] == 720


def test_python_contract_serializes_command_metadata_with_wire_names() -> None:
    result = TypeAdapter(OfficeCommandResult).validate_python(
        {
            "ok": True,
            "sessionId": "office_slides",
            "operationId": "op_1",
            "version": {"editorEpoch": "epoch_slides", "modelRevision": 2},
            "changedTargets": ["slide_1"],
            "createdElements": [
                {
                    "id": "element_new",
                    "type": "image",
                    "x": 0,
                    "y": 0,
                    "width": 100,
                    "height": 80,
                }
            ],
            "updatedElements": [],
            "warnings": ["图片使用了默认裁剪比例"],
        }
    )

    wire = result.model_dump(by_alias=True, exclude_none=True)
    assert wire["createdElements"][0]["id"] == "element_new"
    assert wire["updatedElements"] == []
    assert wire["warnings"] == ["图片使用了默认裁剪比例"]
    assert "created_elements" not in wire


def test_python_contract_rejects_visual_and_selection_bounds() -> None:
    with pytest.raises(ValidationError):
        OfficeInspectRequest.model_validate(
            {
                "sessionId": "office_slides",
                "query": {
                    "mode": "visual",
                    "region": {"x": -1, "y": 0, "width": 10, "height": 10},
                },
            }
        )
    with pytest.raises(ValidationError):
        OfficeInspectRequest.model_validate(
            {
                "sessionId": "office_slides",
                "query": {
                    "mode": "visual",
                    "region": {"x": 0, "y": 0, "width": 0, "height": 10},
                    "padding": 101,
                },
            }
        )
    with pytest.raises(ValidationError):
        OfficeInspectRequest.model_validate(
            {
                "sessionId": "office_slides",
                "query": {"mode": "slides", "elementIds": [str(i) for i in range(51)]},
            }
        )
