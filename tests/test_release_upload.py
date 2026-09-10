from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "release_upload.py"
_SPEC = importlib.util.spec_from_file_location("release_upload", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
release_upload = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release_upload)


def test_update_local_changelog_replaces_same_version_and_preserves_history(
    monkeypatch, tmp_path: Path
) -> None:
    changelog = tmp_path / "changelog.json"
    changelog.write_text(
        json.dumps(
            {
                "releases": [
                    {"version": "1.5.1", "gitHash": "previous", "items": ["old"]},
                    {"version": "1.5.0", "gitHash": "older", "items": ["older"]},
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(release_upload, "_CHANGELOG_PATH", changelog)

    release_upload.update_local_changelog(
        version="1.6.0",
        pub_date="2026-09-10T00:00:00Z",
        git_hash="release",
        summary="修复更新",
        items=["修复 Gateway 并发部署"],
    )
    release_upload.update_local_changelog(
        version="1.6.0",
        pub_date="2026-09-10T01:00:00Z",
        git_hash="release",
        summary="修复更新并补齐官网日志",
        items=["修复 Gateway 并发部署", "修复更新状态"],
    )

    releases = json.loads(changelog.read_text(encoding="utf-8"))["releases"]
    assert [release["version"] for release in releases] == ["1.6.0", "1.5.1", "1.5.0"]
    assert releases[0]["previousGitHash"] == "previous"
    assert releases[0]["summary"] == "修复更新并补齐官网日志"
    assert releases[0]["items"] == ["修复 Gateway 并发部署", "修复更新状态"]


def test_read_changelog_items_rejects_empty_or_non_string_items(tmp_path: Path) -> None:
    invalid = tmp_path / "invalid.json"
    invalid.write_text('["ok", 3]', encoding="utf-8")

    try:
        release_upload._read_changelog_items(str(invalid))
    except SystemExit as error:
        assert "字符串数组" in str(error)
    else:
        raise AssertionError("invalid changelog items should be rejected")
