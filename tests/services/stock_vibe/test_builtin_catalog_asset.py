"""The fixed catalog stays tied to native source without requiring runtime at build time."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from tools.stock_vibe import export_builtin_catalog as catalog


def asset() -> dict:
    return json.loads(catalog.OUTPUT.read_text(encoding="utf-8"))


def test_committed_catalog_is_complete_and_fast_check_needs_no_native_python(monkeypatch) -> None:
    catalog.validate_catalog(asset())
    monkeypatch.setattr(catalog, "native_python", lambda *args: pytest.fail("check started native Python"))
    monkeypatch.setattr(catalog, "generate", lambda *args: pytest.fail("check regenerated native source"))
    assert catalog.main(["--check"]) == 0
    result = subprocess.run([sys.executable, str(Path(catalog.__file__)), "--check"],
        cwd=catalog.ROOT, env={**os.environ, "MONA_VIBE_TEST_PYTHON": "unavailable-native-python"},
        capture_output=True, encoding="utf-8", timeout=10, check=False)
    assert result.returncode == 0, result.stderr
    assert "20 entries" in result.stdout


def test_fast_check_rejects_stale_pins_changed_content_and_user_state() -> None:
    original = asset()
    changed = copy.deepcopy(original)
    changed["source"]["patches"][-1]["sha256"] = "0" * 64
    with pytest.raises(catalog.CatalogExportError, match="source pins are stale"):
        catalog.validate_catalog(changed)
    changed = copy.deepcopy(original)
    changed["items"][0]["description"] = "manual replacement"
    with pytest.raises(catalog.CatalogExportError, match="content checksum"):
        catalog.validate_catalog(changed)
    changed["source"]["items_sha256"] = catalog._sha256(catalog._items_bytes(changed["items"]))
    changed["items"][0]["has_evidence"] = True
    changed["source"]["items_sha256"] = catalog._sha256(catalog._items_bytes(changed["items"]))
    with pytest.raises(catalog.CatalogExportError, match="user or execution state"):
        catalog.validate_catalog(changed)


def test_output_scope_resolves_paths_before_writing() -> None:
    with pytest.raises(catalog.CatalogExportError, match="inside this repository"):
        catalog.resolve_output(catalog.ROOT.parent / "outside-catalog.json")
    assert catalog.resolve_output("webui/src/lib/stock-vibe-builtin-catalog.generated.json") == catalog.OUTPUT.resolve()


def test_native_export_matches_committed_fixed_details() -> None:
    try:
        python = catalog.native_python(os.environ.get("MONA_VIBE_TEST_PYTHON"))
    except (OSError, catalog.CatalogExportError):
        pytest.skip("explicit or managed pinned financial Python required for native export")
    generated = catalog.generate(python)
    assert generated == asset()
    assert len(generated["items"]) == 20
    assert sum(item["market"] == "china_a" for item in generated["items"]) == 15
