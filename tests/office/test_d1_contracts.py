from __future__ import annotations

import json
from pathlib import Path

from pydantic import TypeAdapter

from mona.office.errors import OfficeErrorCode
from mona.office.schemas import (
    ChangedSinceResult,
    DocsOperation,
    OfficeApplyCommand,
    OfficeCommandResult,
    OfficeInspectRequest,
    OfficeInspectResponse,
    OfficeInspectResult,
    OfficeSessionOpenMessage,
    OfficeSocketMessage,
    SlidesOperation,
)

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "office"
FIXTURE_PATH = FIXTURE_DIR / "d0-contract.json"


def _d1_fixture() -> dict[str, object]:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    return fixture["d1"]


def test_d1_inspect_queries_and_results_cover_docs_slides_and_changed_since() -> None:
    fixture = _d1_fixture()
    requests = [OfficeInspectRequest.model_validate(item) for item in fixture["inspectRequests"]]
    results = [OfficeInspectResult.model_validate(item) for item in fixture["inspectResults"]]

    assert [request.query.mode for request in requests] == [
        "summary",
        "outline",
        "search",
        "blocks",
        "summary",
        "slides",
        "changed_since",
    ]
    assert [result.result.mode for result in results] == [
        "summary",
        "outline",
        "search",
        "blocks",
        "summary",
        "slides",
        "changed_since",
    ]
    assert {request.session_id for request in requests} == {"office_docs", "office_slides"}
    changed_since = results[-1].result
    assert isinstance(changed_since, ChangedSinceResult)
    assert changed_since.changes[0].target == "paragraph_1"


def test_d1_docs_and_slides_operations_cover_all_allowed_discriminators() -> None:
    fixture = _d1_fixture()
    commands = [OfficeApplyCommand.model_validate(item) for item in fixture["commands"]]

    docs_operations = commands[0].operations
    slides_operations = commands[1].operations
    assert all(isinstance(operation, DocsOperation) for operation in docs_operations)
    assert all(isinstance(operation, SlidesOperation) for operation in slides_operations)
    assert {operation.op for operation in docs_operations} == {
        "replace_block_text",
        "delete_block",
        "insert_paragraph",
        "insert_title",
        "insert_heading",
        "insert_list",
        "insert_table",
        "set_table_cell",
        "insert_image",
        "set_block_style",
    }
    assert {operation.op for operation in slides_operations} == {
        "slide_set_text",
        "slide_set_font",
        "slide_set_geometry",
        "slide_set_fill",
        "slide_set_stroke",
        "slide_add_text",
        "slide_add_shape",
        "slide_add_image",
        "slide_delete_element",
        "slide_add",
        "slide_duplicate",
        "slide_delete",
        "slide_move",
        "slide_apply_txn",
    }


def test_d1_slide_asset_and_compose_operations_round_trip() -> None:
    command = OfficeApplyCommand.model_validate(
        {
            "sessionId": "office_slides",
            "operationId": "op_slides_assets",
            "expectedVersion": {"editorEpoch": "epoch_slides", "modelRevision": 1},
            "operations": [
                {
                    "op": "slide_add_svg",
                    "payload": {
                        "slideId": "slide_1",
                        "svg": "<svg />",
                        "x": 0,
                        "y": 0,
                        "width": 100,
                        "height": 80,
                    },
                },
                {
                    "op": "slide_compose",
                    "payload": {
                        "slideId": "slide_1",
                        "columns": [1],
                        "rows": [1],
                        "items": [
                            {
                                "type": "image",
                                "column": 0,
                                "row": 0,
                                "assetPath": "assets/picture.png",
                            }
                        ],
                    },
                },
            ],
        }
    )

    assert [operation.op for operation in command.operations] == [
        "slide_add_svg",
        "slide_compose",
    ]


def test_docs_table_cells_are_visible_and_editable_through_the_wire_contract() -> None:
    inspect = OfficeInspectResult.model_validate(
        {
            "sessionId": "office_docs",
            "version": {"editorEpoch": "epoch_docs", "modelRevision": 2},
            "result": {
                "mode": "blocks",
                "blocks": [
                    {
                        "id": "block_table",
                        "type": "table",
                        "text": "月份金额一月100",
                        "rows": [["月份", "金额"], ["一月", "100"]],
                    }
                ],
            },
        }
    )
    command = OfficeApplyCommand.model_validate(
        {
            "sessionId": "office_docs",
            "operationId": "set_table_cell_1",
            "expectedVersion": {"editorEpoch": "epoch_docs", "modelRevision": 2},
            "operations": [
                {
                    "op": "set_table_cell",
                    "payload": {
                        "blockId": "block_table",
                        "rowIndex": 1,
                        "columnIndex": 1,
                        "text": "120",
                    },
                }
            ],
        }
    )

    assert inspect.result.blocks[0].rows == [["月份", "金额"], ["一月", "100"]]
    assert isinstance(command.operations[0], DocsOperation)
    assert command.operations[0].op == "set_table_cell"


def test_d1_resync_failure_and_command_result_are_wire_discriminated() -> None:
    fixture = _d1_fixture()
    inspect_adapter = TypeAdapter(OfficeInspectResponse)
    inspect_failures = [inspect_adapter.validate_python(item) for item in fixture["inspectFailures"]]
    assert len(inspect_failures) == 1
    inspect_failure = inspect_failures[0]
    assert not inspect_failure.ok
    assert inspect_failure.error.code == OfficeErrorCode.RESYNC_REQUIRED
    assert inspect_failure.error.retryable

    command_adapter = TypeAdapter(OfficeCommandResult)
    command_results = [command_adapter.validate_python(item) for item in fixture["commandResults"]]
    assert command_results[0].ok
    assert not command_results[1].ok
    assert command_results[1].error.code == OfficeErrorCode.RESYNC_REQUIRED


def test_d1_blank_open_messages_cover_three_real_fixture_formats() -> None:
    fixture = _d1_fixture()
    socket_adapter = TypeAdapter(OfficeSocketMessage)
    expected_files = {
        "docs": "blank.docx",
        "sheets": "blank.xlsx",
        "slides": "blank.pptx",
    }
    messages = [socket_adapter.validate_python(item) for item in fixture["blankOpenMessages"]]

    assert all(isinstance(message, OfficeSessionOpenMessage) for message in messages)
    assert {message.session.type for message in messages} == set(expected_files)
    for message in messages:
        assert (FIXTURE_DIR / expected_files[message.session.type]).is_file()
        assert message.session.version.model_revision == 0
        assert not message.session.dirty
