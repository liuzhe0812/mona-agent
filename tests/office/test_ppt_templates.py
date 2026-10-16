from __future__ import annotations

import json

import pytest

from mona.agent.tools.office import OfficeTool
from mona.office.ppt_assets import ASSET_ROOT, PptAssetError
from mona.office.ppt_templates import prepare_ppt_template_assets
from mona.office.schemas import CapabilitiesQuery, OfficeInspectRequest, SlidesOperation


def test_real_template_assets_are_prepared_from_fixed_ids(tmp_path):
    catalog = json.loads((ASSET_ROOT / "template-assets.json").read_text(encoding="utf-8"))
    page = catalog["pages"][0]
    op = {
        "op": "slide_add_template",
        "payload": {
            "slideId": "s_1",
            "templateId": page["id"],
            "fields": {"titleTop": "验证"},
            "templateAssets": {"../../file": "untrusted"},
        },
    }
    prepared = OfficeTool(workspace=tmp_path)._prepare_slide_assets([op])[0]
    assert set(prepared["payload"]["templateAssets"]) == set(page["assetIds"])
    assert all(url.startswith("data:image/png;base64,") for url in prepared["payload"]["templateAssets"].values())
    assert prepared["payload"]["fields"] == op["payload"]["fields"]
    assert op["payload"]["templateAssets"] == {"../../file": "untrusted"}


def test_unknown_or_arbitrary_template_path_is_rejected():
    for template_id in ("../../secret.pptx", "theme99_page001", None, []):
        with pytest.raises(PptAssetError):
            prepare_ppt_template_assets(template_id)


def test_full_original_3d_group_is_available_without_a_workspace_path(tmp_path):
    op = {"op": "slide_add_image", "payload": {"slideId": "s_1", "assetId": "theme03-3d-01", "x": 100, "y": 100, "width": 200, "height": 200}}
    prepared = OfficeTool(workspace=tmp_path)._prepare_slide_assets([op])[0]
    assert "assetId" not in prepared["payload"]
    assert prepared["payload"]["dataUrl"].startswith("data:image/png;base64,")
    assert "dataUrl" not in op["payload"]
    with pytest.raises(PptAssetError):
        OfficeTool(workspace=tmp_path)._prepare_slide_assets([{"op": "slide_add_image", "payload": {"assetId": "../not-registered"}}])


def test_native_template_and_read_only_preview_wire_contracts():
    operation = SlidesOperation.model_validate({
        "op": "slide_add_template",
        "payload": {"slideId": "s_1", "templateId": "theme01_page001", "fields": {"titleTop": "验证"}},
    })
    assert operation.op == "slide_add_template"
    query = OfficeInspectRequest.model_validate({
        "sessionId": "test",
        "query": {"mode": "visual", "templateId": "theme01_page001", "templateFields": {"titleTop": "验证"}},
    }).query
    assert query.template_id == "theme01_page001"
    assert query.accept_warnings is False
    assert CapabilitiesQuery.model_validate({"mode": "capabilities", "templateId": "theme01_page001"}).template_id == query.template_id
