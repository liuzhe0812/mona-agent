"""Upload one verified release artifact to Qiniu Kodo."""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
from urllib.parse import quote


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def _object_key(value: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts:
        raise SystemExit("object key must be a non-empty relative POSIX path")
    return path.as_posix()


def upload(artifact: Path, object_key: str) -> None:
    try:
        from qiniu import Auth, BucketManager, CdnManager, etag, put_file_v2
    except ImportError as exc:
        raise SystemExit("install the qiniu package before publishing") from exc

    access_key = _required("QINIU_AK")
    secret_key = _required("QINIU_SK")
    bucket = _required("QINIU_BUCKET")
    auth = Auth(access_key, secret_key)
    expected_hash = etag(str(artifact))
    existing, info = BucketManager(auth).stat(bucket, object_key)
    status = getattr(info, "status_code", "unknown")
    if status not in (200, 612):
        raise SystemExit(f"Qiniu object lookup failed (status {status})")
    if status == 200 and (not isinstance(existing, dict) or not isinstance(existing.get("hash"), str)):
        raise SystemExit("Qiniu object lookup did not return a hash")
    if status != 200 or existing["hash"] != expected_hash:
        token = auth.upload_token(bucket, object_key, 3600)
        result, info = put_file_v2(token, object_key, str(artifact), version="v2")
        if not isinstance(result, dict) or result.get("key") != object_key or result.get("hash") != expected_hash:
            status = getattr(info, "status_code", "unknown")
            raise SystemExit(f"Qiniu upload verification failed (status {status})")
    domain = _required("QINIU_DOMAIN").removeprefix("https://").removeprefix("http://").strip("/")
    _, info = CdnManager(auth).refresh_urls([f"https://{domain}/{quote(object_key, safe='/')}"])
    if getattr(info, "status_code", None) != 200:
        status = getattr(info, "status_code", "unknown")
        raise SystemExit(f"Qiniu CDN refresh failed (status {status})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--object-key", required=True)
    args = parser.parse_args()

    artifact = args.artifact.expanduser().resolve()
    if not artifact.is_file():
        raise SystemExit(f"artifact does not exist: {artifact}")
    object_key = _object_key(args.object_key)
    upload(artifact, object_key)
    print(f"Uploaded {artifact.name} to qiniu://{_required('QINIU_BUCKET')}/{object_key}")


if __name__ == "__main__":
    main()
