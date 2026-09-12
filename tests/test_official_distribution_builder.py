"""Deterministic official server repository builder tests."""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from types import ModuleType, SimpleNamespace

from mona.agent.package_store import AgentPackageStore
from mona.runtime.manager import RuntimeComponentStore
from scripts.build_official_distribution import (
    _publish_primary_catalogs,
    _upload_immutable_object,
    build_expert_repository,
    build_runtime_repository,
    upload_repository,
)


def test_builds_deterministic_installable_expert(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source = source_root / "com.example.researcher"
    source.mkdir(parents=True)
    (source / "package-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "agentId": "com.example.researcher",
                "version": "1.0.0",
                "requiredTools": ["read_file"],
                "runtimePacks": [],
            }
        ),
        encoding="utf-8",
    )
    (source / "agent.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "com.example.researcher",
                "displayName": "Researcher",
                "prompt": "prompt.md",
                "toolAllowlist": ["read_file"],
                "skills": [],
                "packageId": "com.example.researcher",
                "packageVersion": "1.0.0",
            }
        ),
        encoding="utf-8",
    )
    (source / "prompt.md").write_text("Research carefully.", encoding="utf-8")
    ignored = source / "__pycache__"
    ignored.mkdir()
    (ignored / "fixture.pyc").write_bytes(b"ignored")
    first = tmp_path / "first"
    second = tmp_path / "second"

    first_catalog = build_expert_repository(
        source_root,
        first,
        base_url="https://cdn.example.test",
    )
    build_expert_repository(
        source_root,
        second,
        base_url="https://cdn.example.test",
    )

    first_archive = first / "experts/agents/com.example.researcher/1.0.0.zip"
    second_archive = second / "experts/agents/com.example.researcher/1.0.0.zip"
    assert first_archive.read_bytes() == second_archive.read_bytes()
    with zipfile.ZipFile(first_archive) as bundle:
        assert not any("__pycache__" in name for name in bundle.namelist())
    entry = first_catalog["experts"][0]
    assert "signature" not in entry
    installed = AgentPackageStore(tmp_path / "installed").install_archive(
        first_archive,
        expected_sha256=entry["sha256"],
        expected_agent_id=entry["id"],
        expected_version=entry["version"],
    )
    assert installed.activated is True


def test_builds_installable_runtime_without_signing_key(tmp_path: Path) -> None:
    source = tmp_path / "runtime-sources" / "python-base" / "3.13"
    source.mkdir(parents=True)
    (source / "runtime-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "python-base",
                "version": "3.13",
                "kind": "python-runtime",
                "entrypoints": {"python": "python.exe"},
            }
        ),
        encoding="utf-8",
    )
    (source / "distribution.json").write_text(
        json.dumps({"platforms": ["win32"], "architectures": ["x64"]}),
        encoding="utf-8",
    )
    (source / "python.exe").write_bytes(b"fixture executable")
    output = tmp_path / "output"

    catalog = build_runtime_repository(
        tmp_path / "runtime-sources",
        output,
        base_url="https://cdn.example.test",
    )

    archive = output / "runtimes/components/python-base/3.13.zip"
    entry = catalog["components"][0]
    assert "signature" not in entry
    manifest = RuntimeComponentStore(tmp_path / "installed-runtimes").install_archive(
        archive
    )
    assert manifest.id == "python-base"
    assert entry["sha256"]


def test_refuses_to_overwrite_changed_immutable_object(tmp_path: Path) -> None:
    archive = tmp_path / "1.0.0.zip"
    archive.write_bytes(b"new package bytes")

    class BucketManager:
        @staticmethod
        def stat(_bucket: str, _key: str):
            return {"fsize": 3, "hash": "old"}, SimpleNamespace(status_code=200)

    try:
        _upload_immutable_object(
            archive,
            key="experts/agents/com.example.researcher/1.0.0.zip",
            bucket="test",
            auth=SimpleNamespace(),
            bucket_manager=BucketManager(),
            put_file=lambda *_args, **_kwargs: None,
            etag_file=lambda _path: "new",
        )
    except RuntimeError as error:
        assert "bump its version" in str(error)
    else:
        raise AssertionError("changed immutable object should be rejected")


def test_uploads_archives_before_catalog_and_then_publishes_primary(
    tmp_path: Path,
    monkeypatch,
) -> None:
    output = tmp_path / "distribution"
    archive = output / "experts/agents/com.example.researcher/1.0.0.zip"
    catalog = output / "experts/catalog-v1.json"
    archive.parent.mkdir(parents=True)
    catalog.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(b"archive")
    catalog.write_text('{"schemaVersion":1,"experts":[]}', encoding="utf-8")
    events: list[str] = []
    objects: dict[str, dict[str, object]] = {}

    class Auth:
        def __init__(self, _access_key: str, _secret_key: str) -> None:
            pass

        @staticmethod
        def upload_token(
            _bucket: str,
            _key: str,
            _expires: int,
            *,
            policy: dict[str, int],
        ) -> str:
            return str(policy["insertOnly"])

    class BucketManager:
        def __init__(self, _auth: Auth) -> None:
            pass

        @staticmethod
        def stat(_bucket: str, key: str):
            value = objects.get(key)
            if value is None:
                return None, SimpleNamespace(status_code=612)
            return value, SimpleNamespace(status_code=200)

    class CdnManager:
        def __init__(self, _auth: Auth) -> None:
            pass

        @staticmethod
        def refresh_urls(_urls: list[str]):
            events.append("refresh")
            return {"code": 200}, SimpleNamespace(status_code=200)

    def etag(path: str) -> str:
        return Path(path).read_bytes().hex()

    def put_file(_token: str, key: str, path: str, *, version: str):
        assert version == "v2"
        events.append(f"upload:{key}")
        source = Path(path)
        objects[key] = {"fsize": source.stat().st_size, "hash": etag(path)}
        return {"key": key}, SimpleNamespace(status_code=200)

    qiniu = ModuleType("qiniu")
    qiniu.Auth = Auth
    qiniu.BucketManager = BucketManager
    qiniu.CdnManager = CdnManager
    qiniu.etag = etag
    qiniu.put_file_v2 = put_file
    monkeypatch.setitem(sys.modules, "qiniu", qiniu)
    monkeypatch.setenv("QINIU_AK", "test")
    monkeypatch.setenv("QINIU_SK", "test")
    monkeypatch.setenv("QINIU_BUCKET", "test")
    monkeypatch.setenv("QINIU_DOMAIN", "cdn.example.test")
    monkeypatch.setattr(
        "scripts.build_official_distribution._publish_primary_catalogs",
        lambda _output: events.append("publish-primary"),
    )

    upload_repository(output, prefix="")

    assert events == [
        "upload:experts/agents/com.example.researcher/1.0.0.zip",
        "upload:experts/catalog-v1.json",
        "refresh",
        "publish-primary",
    ]


def test_publishes_primary_catalog_with_atomic_rename(
    tmp_path: Path,
    monkeypatch,
) -> None:
    output = tmp_path / "distribution"
    catalog = output / "experts/catalog-v1.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text('{"schemaVersion":1,"experts":[]}', encoding="utf-8")
    events: list[tuple[str, str]] = []
    remote_sizes: dict[str, int] = {}

    class Sftp:
        @staticmethod
        def put(source: str, target: str) -> None:
            events.append(("put", target))
            remote_sizes[target] = Path(source).stat().st_size

        @staticmethod
        def stat(target: str):
            return SimpleNamespace(st_size=remote_sizes[target])

        @staticmethod
        def posix_rename(source: str, target: str) -> None:
            events.append(("rename", target))
            remote_sizes[target] = remote_sizes.pop(source)

        @staticmethod
        def remove(target: str) -> None:
            if target not in remote_sizes:
                raise OSError
            remote_sizes.pop(target)

        @staticmethod
        def close() -> None:
            pass

    class Ssh:
        @staticmethod
        def set_missing_host_key_policy(_policy) -> None:
            pass

        @staticmethod
        def connect(
            host: str,
            *,
            username: str,
            password: str,
            timeout: int,
        ) -> None:
            assert (host, username, password, timeout) == ("vps.test", "root", "test", 15)

        @staticmethod
        def open_sftp() -> Sftp:
            return Sftp()

        @staticmethod
        def close() -> None:
            pass

    paramiko = ModuleType("paramiko")
    paramiko.SSHClient = Ssh
    paramiko.AutoAddPolicy = object
    monkeypatch.setitem(sys.modules, "paramiko", paramiko)
    monkeypatch.setenv("VPS_PASSWORD", "test")
    monkeypatch.setenv("VPS_HOST", "vps.test")

    _publish_primary_catalogs(output)

    target = "/var/www/mona/catalogs/experts/catalog-v1.json"
    assert events[0][0] == "put"
    assert events[0][1].startswith(target + ".tmp-")
    assert events[1] == ("rename", target)
    assert remote_sizes[target] == catalog.stat().st_size
