from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

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


@pytest.mark.parametrize("path", ["/var/www/mona", "/tmp/site", "/var/www/mona/../other", "/var/www/mona/site/", "site"])
def test_site_root_must_be_a_normalized_path_under_mona(path: str) -> None:
    with pytest.raises(ValueError):
        release_upload._validated_site_root(path)


def test_site_root_accepts_a_verified_release_directory() -> None:
    path = "/var/www/mona/site-releases/example/content"
    assert release_upload._validated_site_root(path) == path


def test_republished_manifest_preserves_original_release_date_and_notes(monkeypatch) -> None:
    saved: list[str] = []

    class Output:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def write(self, value): saved.append(value)

    class SFTP:
        def open(self, path, mode):
            assert path == "/var/www/mona/updates/update.json" and mode == "w"
            return Output()
        def close(self): pass

    class SSH:
        def set_missing_host_key_policy(self, _policy): pass
        def connect(self, *_args, **_kwargs): pass
        def open_sftp(self): return SFTP()
        def close(self): pass

    monkeypatch.setitem(sys.modules, "paramiko", SimpleNamespace(SSHClient=SSH, AutoAddPolicy=lambda: None))
    monkeypatch.setenv("VPS_PASSWORD", str(object()))
    monkeypatch.setenv("QINIU_DOMAIN", "storage.example")
    release_upload.update_vps_manifest("1.8.4", "mona-1.8.4.tar.zst", "hash", 123, "original notes", "commit", pub_date="2026-10-31T18:08:18Z")
    manifest = json.loads("".join(saved))
    assert manifest["pub_date"] == "2026-10-31T18:08:18Z"
    assert manifest["notes"] == "original notes"


@pytest.mark.parametrize("commit,valid", [("a" * 40, True), ("not-a-commit", False)])
def test_macos_release_source_can_be_selected_without_changelog(tmp_path: Path, commit: str, valid: bool) -> None:
    workflow = yaml.safe_load((_SCRIPT.parents[1] / ".github/workflows/build-macos.yml").read_text(encoding="utf-8"))
    step = next(item for item in workflow["jobs"]["build"]["steps"] if item.get("id") == "release_source")
    code = step["run"].split("python - <<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "1.8.4"\n', encoding="utf-8")
    env = {**os.environ, "RELEASE_SOURCE_COMMIT": commit}
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True)
    assert (result.returncode == 0) is valid
    if valid:
        assert result.stdout.strip() == commit


@pytest.mark.parametrize("already_uploaded", [False, True])
@pytest.mark.parametrize("cdn_status", [200, 503])
def test_macos_upload_refreshes_cdn_and_reuses_matching_object(monkeypatch, tmp_path: Path, already_uploaded: bool, cdn_status: int) -> None:
    spec = importlib.util.spec_from_file_location("macos_upload", _SCRIPT.parents[1] / ".github/scripts/upload_qiniu_artifact.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    actions: list[object] = []

    class Auth:
        def __init__(self, *_args): pass
        def upload_token(self, *_args): return None

    class BucketManager:
        def __init__(self, _auth): pass
        def stat(self, *_args): return ({"hash": "same" if already_uploaded else "old"}, SimpleNamespace(status_code=200))

    class CdnManager:
        def __init__(self, _auth): pass
        def refresh_urls(self, urls):
            actions.append(("refresh", urls))
            return {}, SimpleNamespace(status_code=cdn_status)

    def put_file_v2(_token, key, _path, **_kwargs):
        actions.append("upload")
        return {"key": key, "hash": "same"}, SimpleNamespace(status_code=200)

    monkeypatch.setitem(sys.modules, "qiniu", SimpleNamespace(Auth=Auth, BucketManager=BucketManager, CdnManager=CdnManager, etag=lambda _path: "same", put_file_v2=put_file_v2))
    monkeypatch.setattr(module, "_required", lambda name: "storage.example" if name == "QINIU_DOMAIN" else "configured")
    artifact = tmp_path / "Mona.dmg"
    artifact.write_bytes(b"release")
    if cdn_status == 200:
        module.upload(artifact, "macos/1.8.4/Mona.dmg")
    else:
        with pytest.raises(SystemExit, match="CDN refresh failed"):
            module.upload(artifact, "macos/1.8.4/Mona.dmg")
    assert actions == ([] if already_uploaded else ["upload"]) + [("refresh", ["https://storage.example/macos/1.8.4/Mona.dmg"])]
