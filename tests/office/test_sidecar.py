from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from mona.office.errors import OfficeError, OfficeErrorCode
from mona.office.sidecar import _runtime_platform_and_arch, load_bundled_xlsx_sidecar


def _write_sidecar_fixture(tmp_path: Path) -> tuple[Path, Path]:
    resources = tmp_path / "resources"
    office_root = resources / "office-editor"
    executable = office_root / "sheets" / "xlsx-sidecar.exe"
    executable.parent.mkdir(parents=True)
    payload = b"xlsx sidecar fixture"
    executable.write_bytes(payload)
    runtime_platform, runtime_arch = _runtime_platform_and_arch()
    (office_root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "platform": runtime_platform,
                "arch": runtime_arch,
                "xlsxSidecar": {
                    "path": "sheets/xlsx-sidecar.exe",
                    "version": "d0",
                    "size": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                },
            }
        ),
        encoding="utf-8",
    )
    return resources, executable


def test_load_bundled_sidecar_verifies_manifest_size_and_hash(tmp_path: Path) -> None:
    resources, executable = _write_sidecar_fixture(tmp_path)

    sidecar = load_bundled_xlsx_sidecar(resources)

    assert sidecar.path == executable.resolve()
    assert sidecar.version == "d0"


def test_load_bundled_sidecar_rejects_tampered_file(tmp_path: Path) -> None:
    resources, executable = _write_sidecar_fixture(tmp_path)
    executable.write_bytes(b"tampered")

    with pytest.raises(OfficeError) as error:
        load_bundled_xlsx_sidecar(resources)

    assert error.value.code == OfficeErrorCode.EDITOR_UNAVAILABLE


def test_load_bundled_sidecar_rejects_another_platform(tmp_path: Path) -> None:
    resources, _ = _write_sidecar_fixture(tmp_path)
    manifest_path = resources / "office-editor" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["platform"] = "macos" if manifest["platform"] != "macos" else "windows"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(OfficeError) as error:
        load_bundled_xlsx_sidecar(resources)

    assert error.value.code == OfficeErrorCode.EDITOR_UNAVAILABLE
