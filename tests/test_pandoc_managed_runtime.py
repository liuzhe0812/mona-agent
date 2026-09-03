from __future__ import annotations

import json
import zipfile

from mona.api.pandoc_runtime import PandocRuntime
from mona.runtime.manager import RuntimeComponentStore


def test_pandoc_prefers_managed_component(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "managed"
    archive = tmp_path / "pandoc.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "pandoc",
                    "version": "3.10.1",
                    "kind": "pandoc-runtime",
                    "entrypoints": {"pandoc": "bin/pandoc.exe"},
                }
            ),
        )
        bundle.writestr("bin/pandoc.exe", b"pandoc")
    RuntimeComponentStore(runtime_root).install_archive(archive)
    monkeypatch.setattr("mona.config.paths.get_managed_runtimes_dir", lambda: runtime_root)

    path = PandocRuntime(tmp_path / "legacy").get_pandoc_path()

    assert path is not None
    assert path.endswith("pandoc.exe")
