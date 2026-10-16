"""Prepare verified bundled media for registered native slide templates."""

from __future__ import annotations

import json
from functools import lru_cache

from mona.office.ppt_assets import ASSET_ROOT, PptAssetError, get_ppt_asset_data_url


@lru_cache(maxsize=1)
def _template_assets() -> dict[str, list[str]]:
    try:
        catalog = json.loads((ASSET_ROOT / "template-assets.json").read_text(encoding="utf-8"))
        if catalog.get("schemaVersion") != 1:
            raise ValueError("unsupported version")
        return {page["id"]: page["assetIds"] for page in catalog["pages"]}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PptAssetError("PPT template registry is unavailable or invalid") from exc


def prepare_ppt_template_assets(template_id: str) -> dict[str, str]:
    """Accept a known template ID only; caller paths and XML never enter here."""
    if not isinstance(template_id, str) or not template_id:
        raise PptAssetError("A registered PPT template ID is required")
    asset_ids = _template_assets().get(template_id)
    if asset_ids is None:
        raise PptAssetError("Unknown PPT template ID")
    return {asset_id: get_ppt_asset_data_url(asset_id) for asset_id in asset_ids}
