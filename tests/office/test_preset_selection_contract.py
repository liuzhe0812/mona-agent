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
)


def test_candidate_rejection_diagnostics_survive_wire_contract() -> None:
    result = CapabilitiesResult.model_validate({
        "mode": "capabilities", "documentType": "slides", "operations": [],
        "presets": [], "contentRef": "preset-content:example",
        "presetDiagnostics": [{"id": "auto-content", "reasons": ["内容过量，请拆成两页"]}],
    })
    assert result.model_dump(by_alias=True)["presetDiagnostics"] == [
        {"id": "auto-content", "reasons": ["内容过量，请拆成两页"]},
    ]


def test_preset_selection_query_reference_round_trips_with_aliases() -> None:
    request = OfficeInspectRequest.model_validate(
        {
            "sessionId": "office_slides",
            "query": {
                "mode": "capabilities",
                "presetRole": "hero",
                "presetRelation": "sequence",
                "usedPresetIds": ["dark-product-hero"],
                "presetLimit": 5,
                "presetContentRef": "preset-content-1",
            },
        }
    )

    query = request.query
    assert isinstance(query, CapabilitiesQuery)
    assert query.preset_role == "hero"
    assert query.preset_relation == "sequence"
    assert query.used_preset_ids == ["dark-product-hero"]
    assert query.preset_limit == 5
    assert query.preset_content_ref == "preset-content-1"
    assert request.model_dump(by_alias=True, mode="json")["query"] == {
        "mode": "capabilities",
        "documentType": None,
        "elementType": None,
        "operations": [],
        "presetContent": None,
        "presetRole": "hero",
        "presetRelation": "sequence",
        "usedPresetIds": ["dark-product-hero"],
        "presetLimit": 5,
        "presetContentRef": "preset-content-1",
        "presetFamily": None,
        "presetTheme": None,
    }

    visual = OfficeInspectRequest.model_validate(
        {
            "sessionId": "office_slides",
            "query": {
                "mode": "visual",
                "presetContent": {"title": "季度复盘"},
                "presetContentRef": "preset-content-1",
            },
        }
    )
    visual_payload = visual.model_dump(by_alias=True, mode="json")["query"]
    assert visual_payload["presetContent"] == {"title": "季度复盘"}
    assert visual_payload["presetContentRef"] == "preset-content-1"


def test_preset_selection_query_bounds_and_unknown_fields_remain_strict() -> None:
    assert CapabilitiesQuery(mode="capabilities").preset_limit == 3

    with pytest.raises(ValidationError):
        CapabilitiesQuery.model_validate({"mode": "capabilities", "presetLimit": 0})
    with pytest.raises(ValidationError):
        CapabilitiesQuery.model_validate({"mode": "capabilities", "presetLimit": 6})
    with pytest.raises(ValidationError):
        CapabilitiesQuery.model_validate(
            {"mode": "capabilities", "presetRelation": "branch"}
        )
    with pytest.raises(ValidationError):
        CapabilitiesQuery.model_validate(
            {
                "mode": "capabilities",
                "usedPresetIds": [f"preset-{index}" for index in range(101)],
            }
        )
    with pytest.raises(ValidationError):
        CapabilitiesQuery.model_validate(
            {"mode": "capabilities", "unknownSelectionField": True}
        )


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
