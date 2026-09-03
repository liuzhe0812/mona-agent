from __future__ import annotations

from unittest.mock import MagicMock

from mona.api.officecli_runtime import OfficeCliRuntime
from mona.api.server import handle_office_runtime_download


async def test_officecli_no_longer_downloads_new_binary(tmp_path) -> None:
    runtime = OfficeCliRuntime(tmp_path / "resources")

    result = await runtime.ensure()

    assert result == {
        "ok": False,
        "code": "OFFICECLI_REMOVED",
        "error": "旧 OfficeCLI 能力已停止分发",
    }
    assert not (tmp_path / "resources" / "officecli").exists()


def test_existing_officecli_binary_remains_available(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("mona.api.officecli_runtime.shutil.which", lambda _name: None)
    executable = tmp_path / "resources" / "officecli" / "officecli.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"legacy")

    assert OfficeCliRuntime(tmp_path / "resources").get_officecli_path() == str(executable)


async def test_legacy_officecli_download_route_returns_gone() -> None:
    response = await handle_office_runtime_download(MagicMock())

    assert response.status == 410
