from __future__ import annotations

import pytest
from pydantic import ValidationError

from mona.agent.tools.context import RequestContext
from mona.agent.tools.office import OfficeTool
from mona.office.schemas import (
    CapabilitiesQuery,
    CapabilitiesResult,
    OfficeCommandResultMessage,
    OfficeInspectRequest,
    SlidesOperation,
)


def test_capabilities_only_expose_native_operations_not_legacy_design_queries() -> None:
    query = CapabilitiesQuery.model_validate({
        "mode": "capabilities", "operations": ["slide_add_text", "slide_add_chart"],
    })
    assert query.operations == ["slide_add_text", "slide_add_chart"]
    for field in (
        "presetContent", "presetRole", "presetRelation", "usedPresetIds", "presetLimit",
        "presetContentRef", "presetFamily", "presetTheme", "presetScenario", "templateId",
    ):
        with pytest.raises(ValidationError):
            CapabilitiesQuery.model_validate({"mode": "capabilities", field: "legacy"})
    for field in ("designs", "presets", "presetScenarios", "templates", "templateScenarios"):
        with pytest.raises(ValidationError):
            CapabilitiesResult.model_validate({
                "mode": "capabilities", "documentType": "slides", "operations": [], field: [],
            })


def test_visual_contract_keeps_explicit_native_preview_and_rejects_dashi_fields() -> None:
    request = OfficeInspectRequest.model_validate({
        "sessionId": "office_slides", "query": {
            "mode": "visual", "presetId": "light-transition-statement",
            "presetContent": {"title": "季度复盘"},
        },
    })
    assert request.model_dump(by_alias=True)["query"]["presetContent"] == {"title": "季度复盘"}
    for field in ("templateId", "templateFields", "templateAssets", "presetContentRef"):
        with pytest.raises(ValidationError):
            OfficeInspectRequest.model_validate({
                "sessionId": "office_slides", "query": {"mode": "visual", field: "legacy"},
            })


def test_removed_native_template_operation_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SlidesOperation.model_validate({
            "op": "slide_add_template",
            "payload": {"slideId": "s_1", "templateId": "theme01_page001"},
        })
    assert SlidesOperation.model_validate({
        "op": "slide_add_text", "payload": {"slideId": "s_1", "text": "原生文字"},
    }).op == "slide_add_text"


def test_command_result_message_round_trips_preset_page_metadata() -> None:
    message = OfficeCommandResultMessage.model_validate(
        {
            "event": "office_command_result",
            "result": {
                "ok": True,
                "sessionId": "office_slides",
                "operationId": "op-1",
                "version": {"editorEpoch": "epoch-1", "modelRevision": 4},
                "changedTargets": ["slide-1"],
                "summary": "created preset page",
                "presetPages": [
                    {
                        "presetId": "dark-chart-insight",
                        "slideId": "slide-1",
                        "roles": ["title", "chart"],
                        "elements": {"title": "element-1", "chart": "element-2"},
                        "pendingChartStyles": [
                            {
                                "role": "chart",
                                "elementId": "element-2",
                                "style": {
                                    "textColor": "#ffffff",
                                    "seriesColors": ["#ff0000", "#00ff00"],
                                },
                            }
                        ],
                    }
                ],
            },
        }
    )

    serialized = message.model_dump(by_alias=True, mode="json", exclude_none=True)
    restored = OfficeCommandResultMessage.model_validate(serialized)
    page = restored.result.preset_pages[0]  # type: ignore[union-attr]
    assert page.preset_id == "dark-chart-insight"
    assert page.slide_id == "slide-1"
    assert page.roles == ["title", "chart"]
    assert page.pending_chart_styles[0].style["seriesColors"] == ["#ff0000", "#00ff00"]

    with pytest.raises(ValidationError):
        OfficeCommandResultMessage.model_validate(
            {
                **serialized,
                "result": {
                    **serialized["result"],
                    "unknownResultField": True,
                },
            }
        )


def test_slide_add_preset_converts_image_and_images_asset_paths_in_scope(tmp_path) -> None:
    (tmp_path / "hero.png").write_bytes(b"hero")
    (tmp_path / "detail.png").write_bytes(b"detail")
    tool = OfficeTool(workspace=tmp_path, restrict_to_workspace=True)
    tool.set_context(RequestContext(channel="web", chat_id="1", session_key="web:chat:1"))

    prepared = tool._prepare_slide_assets(
        [
            {
                "op": "slide_add_preset",
                "payload": {
                    "slideId": "slide-1",
                    "presetId": "dark-product-hero",
                    "content": {
                        "title": "季度复盘",
                        "image": {"assetPath": "hero.png", "alt": "hero"},
                        "images": [
                            {"assetPath": "detail.png", "label": "detail"},
                            {"label": "unchanged"},
                        ],
                        "metadata": {"source": "test"},
                    },
                    "extraPayload": "preserved",
                },
            }
        ]
    )

    payload = prepared[0]["payload"]
    content = payload["content"]
    assert payload["extraPayload"] == "preserved"
    assert content["title"] == "季度复盘"
    assert content["metadata"] == {"source": "test"}
    assert content["image"] == {
        "dataUrl": "data:image/png;base64,aGVybw==",
        "alt": "hero",
    }
    assert content["images"][0] == {
        "dataUrl": "data:image/png;base64,ZGV0YWls",
        "label": "detail",
    }
    assert content["images"][1] == {"label": "unchanged"}
