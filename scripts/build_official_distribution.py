"""Build and optionally upload Mona expert and runtime repositories."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from mona.agent.package_store import AgentPackageManifest
from mona.runtime.manager import RuntimeComponentManifest

_IGNORED_PARTS = {"__pycache__", ".git", ".pytest_cache"}
_IGNORED_SUFFIXES = {".pyc", ".pyo", ".tmp"}
_QINIU_NOT_FOUND = 612
_PRIMARY_CATALOG_TARGETS = {
    "experts/catalog-v1.json": "/var/www/mona/catalogs/experts/catalog-v1.json",
    "runtimes/catalog-v1.json": "/var/www/mona/catalogs/runtimes/catalog-v1.json",
}


def build_expert_repository(
    source_root: Path,
    output_root: Path,
    *,
    base_url: str,
) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    for source in sorted(path for path in source_root.iterdir() if path.is_dir()):
        manifest = AgentPackageManifest.model_validate_json(
            (source / "package-manifest.json").read_text(encoding="utf-8")
        )
        agent = json.loads((source / "agent.json").read_text(encoding="utf-8"))
        if source.name != manifest.agent_id or agent.get("id") != manifest.agent_id:
            raise ValueError(f"expert source identity mismatch: {source}")
        if agent.get("packageVersion") != manifest.version:
            raise ValueError(f"expert source version mismatch: {source}")
        distribution = _distribution_metadata(source)
        archive = output_root / "experts" / "agents" / manifest.agent_id / f"{manifest.version}.zip"
        _deterministic_zip(
            archive,
            ((path, Path(manifest.agent_id) / path.relative_to(source)) for path in _files(source)),
        )
        digest = _sha256(archive)
        entries.append(
            {
                "schemaVersion": 1,
                "id": manifest.agent_id,
                "displayName": str(agent.get("displayName") or manifest.agent_id),
                "description": str(agent.get("description") or ""),
                "version": manifest.version,
                "minMonaVersion": manifest.min_mona_version,
                "downloadUrl": f"{base_url.rstrip('/')}/experts/agents/"
                f"{manifest.agent_id}/{manifest.version}.zip",
                "mirrors": distribution.get("mirrors", []),
                "size": archive.stat().st_size,
                "sha256": digest,
                "runtimePacks": manifest.runtime_packs,
                "requiredTools": manifest.required_tools,
                "platforms": distribution.get("platforms", []),
                "architectures": distribution.get("architectures", []),
            }
        )
    catalog = {
        "schemaVersion": 1,
        "generatedAt": _source_date_epoch_iso(),
        "experts": entries,
    }
    _write_json(output_root / "experts" / "catalog-v1.json", catalog)
    return catalog


def build_runtime_repository(
    source_root: Path,
    output_root: Path,
    *,
    base_url: str,
) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    for manifest_path in sorted(source_root.glob("*/*/runtime-manifest.json")):
        source = manifest_path.parent
        manifest = RuntimeComponentManifest.model_validate_json(
            manifest_path.read_text(encoding="utf-8")
        )
        if source.parent.name != manifest.id or source.name != manifest.version:
            raise ValueError(f"runtime source identity mismatch: {source}")
        distribution = _distribution_metadata(source)
        if not distribution.get("platforms") or not distribution.get("architectures"):
            raise ValueError(
                f"runtime distribution metadata must pin platform and architecture: {source}"
            )
        archive = output_root / "runtimes" / "components" / manifest.id / f"{manifest.version}.zip"
        _deterministic_zip(
            archive,
            ((path, path.relative_to(source)) for path in _files(source)),
        )
        digest = _sha256(archive)
        entries.append(
            {
                "schemaVersion": 1,
                "id": manifest.id,
                "version": manifest.version,
                "kind": manifest.kind,
                "downloadUrl": f"{base_url.rstrip('/')}/runtimes/components/"
                f"{manifest.id}/{manifest.version}.zip",
                "mirrors": distribution.get("mirrors", []),
                "size": archive.stat().st_size,
                "sha256": digest,
                "dependencies": manifest.dependencies,
                "platforms": distribution["platforms"],
                "architectures": distribution["architectures"],
            }
        )
    catalog = {
        "schemaVersion": 1,
        "generatedAt": _source_date_epoch_iso(),
        "components": entries,
    }
    _write_json(output_root / "runtimes" / "catalog-v1.json", catalog)
    return catalog


def upload_repository(output_root: Path, *, prefix: str) -> None:
    try:
        from qiniu import Auth, BucketManager, CdnManager, etag, put_file_v2
    except ImportError as exc:
        raise RuntimeError("qiniu is required for --upload") from exc
    access_key = _required_env("QINIU_AK")
    secret_key = _required_env("QINIU_SK")
    bucket = _required_env("QINIU_BUCKET")
    domain = _required_env("QINIU_DOMAIN").rstrip("/")
    if not domain.startswith(("http://", "https://")):
        domain = "https://" + domain
    auth = Auth(access_key, secret_key)
    bucket_manager = BucketManager(auth)
    paths = sorted(_files(output_root))
    artifacts = [path for path in paths if path.name != "catalog-v1.json"]
    catalogs = [path for path in paths if path.name == "catalog-v1.json"]
    legacy_catalog_urls: list[str] = []
    for path in artifacts:
        key = "/".join(
            part for part in (prefix.strip("/"), path.relative_to(output_root).as_posix()) if part
        )
        _upload_immutable_object(
            path,
            key=key,
            bucket=bucket,
            auth=auth,
            bucket_manager=bucket_manager,
            put_file=put_file_v2,
            etag_file=etag,
        )
    for path in catalogs:
        key = "/".join(
            part for part in (prefix.strip("/"), path.relative_to(output_root).as_posix()) if part
        )
        _upload_replaceable_object(
            path,
            key=key,
            bucket=bucket,
            auth=auth,
            bucket_manager=bucket_manager,
            put_file=put_file_v2,
            etag_file=etag,
        )
        legacy_catalog_urls.append(f"{domain}/{key}")
    if legacy_catalog_urls:
        result, info = CdnManager(auth).refresh_urls(legacy_catalog_urls)
        if (
            info.status_code != 200
            or not isinstance(result, dict)
            or result.get("code") != 200
        ):
            raise RuntimeError(f"Qiniu legacy catalog refresh failed: {result}")
    if not prefix.strip("/"):
        _publish_primary_catalogs(output_root)


def _upload_immutable_object(
    path: Path,
    *,
    key: str,
    bucket: str,
    auth: Any,
    bucket_manager: Any,
    put_file: Any,
    etag_file: Any,
) -> None:
    expected_size = path.stat().st_size
    expected_hash = etag_file(str(path))
    existing, info = bucket_manager.stat(bucket, key)
    if info.status_code == 200:
        if (
            isinstance(existing, dict)
            and existing.get("fsize") == expected_size
            and existing.get("hash") == expected_hash
        ):
            return
        raise RuntimeError(
            f"refusing to overwrite immutable distribution object {key}; bump its version"
        )
    if info.status_code != _QINIU_NOT_FOUND:
        raise RuntimeError(f"Qiniu stat failed for {key}: {info}")
    token = auth.upload_token(bucket, key, 3600, policy={"insertOnly": 1})
    result, info = put_file(token, key, str(path), version="v2")
    if info.status_code != 200 or not isinstance(result, dict) or result.get("key") != key:
        raise RuntimeError(f"Qiniu upload failed for {key}: {info}")
    _verify_qiniu_object(
        path,
        key=key,
        bucket=bucket,
        bucket_manager=bucket_manager,
        etag_file=etag_file,
    )


def _upload_replaceable_object(
    path: Path,
    *,
    key: str,
    bucket: str,
    auth: Any,
    bucket_manager: Any,
    put_file: Any,
    etag_file: Any,
) -> None:
    token = auth.upload_token(bucket, key, 3600, policy={"insertOnly": 0})
    result, info = put_file(token, key, str(path), version="v2")
    if info.status_code != 200 or not isinstance(result, dict) or result.get("key") != key:
        raise RuntimeError(f"Qiniu upload failed for {key}: {info}")
    _verify_qiniu_object(
        path,
        key=key,
        bucket=bucket,
        bucket_manager=bucket_manager,
        etag_file=etag_file,
    )


def _verify_qiniu_object(
    path: Path,
    *,
    key: str,
    bucket: str,
    bucket_manager: Any,
    etag_file: Any,
) -> None:
    result, info = bucket_manager.stat(bucket, key)
    if (
        info.status_code != 200
        or not isinstance(result, dict)
        or result.get("fsize") != path.stat().st_size
        or result.get("hash") != etag_file(str(path))
    ):
        raise RuntimeError(f"Qiniu object verification failed for {key}: {info}")


def _publish_primary_catalogs(output_root: Path) -> None:
    try:
        import paramiko
    except ImportError as exc:
        raise RuntimeError("paramiko is required to publish primary catalogs") from exc
    password = _required_env("VPS_PASSWORD")
    host = os.environ.get("VPS_HOST", "47.117.69.105").strip()
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username="root", password=password, timeout=15)
    sftp = ssh.open_sftp()
    try:
        for relative, target in _PRIMARY_CATALOG_TARGETS.items():
            source = output_root / Path(relative)
            if not source.is_file():
                continue
            temporary = f"{target}.tmp-{os.getpid()}"
            try:
                sftp.put(str(source), temporary)
                if sftp.stat(temporary).st_size != source.stat().st_size:
                    raise RuntimeError(f"primary catalog upload size mismatch: {relative}")
                sftp.posix_rename(temporary, target)
            finally:
                try:
                    sftp.remove(temporary)
                except OSError:
                    pass
    finally:
        sftp.close()
        ssh.close()


def _deterministic_zip(
    destination: Path,
    files: Iterable[tuple[Path, Path]],
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        destination,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as bundle:
        for source, relative in sorted(files, key=lambda item: item[1].as_posix()):
            info = zipfile.ZipInfo(relative.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, source.read_bytes(), compresslevel=9)


def _files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in _IGNORED_PARTS for part in relative.parts):
            continue
        if path.suffix.lower() in _IGNORED_SUFFIXES or path.name == "distribution.json":
            continue
        yield path


def _distribution_metadata(root: Path) -> dict[str, object]:
    path = root / "distribution.json"
    if not path.is_file():
        return {"platforms": [], "architectures": [], "mirrors": []}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"distribution metadata must be an object: {path}")
    return payload


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _source_date_epoch_iso() -> str:
    from datetime import datetime, timezone

    raw = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    value = datetime.fromtimestamp(int(raw), tz=timezone.utc) if raw else datetime.now(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expert-source", type=Path, default=Path("expert-library/agents"))
    parser.add_argument("--runtime-source", type=Path, default=Path("runtime-library/components"))
    parser.add_argument("--output", type=Path, default=Path("dist/official-distribution"))
    parser.add_argument("--base-url", default="https://dl.mona.lzfun.vip")
    parser.add_argument("--experts-only", action="store_true")
    parser.add_argument("--runtimes-only", action="store_true")
    parser.add_argument("--upload", action="store_true")
    parser.add_argument("--upload-prefix", default="")
    args = parser.parse_args()
    if args.experts_only and args.runtimes_only:
        parser.error("--experts-only and --runtimes-only are mutually exclusive")
    if not args.runtimes_only:
        build_expert_repository(
            args.expert_source,
            args.output,
            base_url=args.base_url,
        )
    if not args.experts_only:
        build_runtime_repository(
            args.runtime_source,
            args.output,
            base_url=args.base_url,
        )
    if args.upload:
        upload_repository(args.output, prefix=args.upload_prefix)


if __name__ == "__main__":
    main()
