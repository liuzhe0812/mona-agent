"""Mona release uploader.

Uploads release artifacts to Qiniu Cloud Kodo (CDN-accelerated) and updates
the hot-update manifest on the VPS.

Artifacts:
  - NSIS installer  -> qiniu://Mona-latest.exe        (官网下载)
  - Update package  -> qiniu://mona-<version>.tar.zst  (App 热更新下载)
  - update.json     -> VPS /var/www/mona/updates/     (App 启动检查)

Credentials are read from environment variables, never hardcoded:
  QINIU_AK        七牛云 Access Key
  QINIU_SK        七牛云 Secret Key
  QINIU_BUCKET    七牛云空间名（公开读）
  QINIU_DOMAIN    CDN 域名（不带协议和斜杠，如 dl.mona.lzfun.vip）
  VPS_HOST        VPS 地址（默认 47.117.69.105）
  VPS_PASSWORD    VPS SSH 密码

Usage:
  python scripts/release_upload.py <version> <nsis_path> <update_pkg_path> <sha256> <notes> <git_hash>

Example:
  python scripts/release_upload.py 1.0.2 \
    "src-tauri/target/release/bundle/nsis/Mona_1.0.2_x64-setup.exe" \
    "dist/mona-1.0.2.tar.zst" \
    "abc123..." "修复若干问题" "def456..."
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def _load_env_file() -> None:
    """从项目根目录的 .env 文件加载环境变量（不覆盖已存在的值）。"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # 不覆盖已在系统环境中设置的值
        if key not in os.environ:
            os.environ[key] = value


_load_env_file()


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"错误：缺少环境变量 {name}", file=sys.stderr)
        print(
            "请先设置七牛云凭证：\n"
            "  $env:QINIU_AK='你的AK'\n"
            "  $env:QINIU_SK='你的SK'\n"
            "  $env:QINIU_BUCKET='mona-releases'\n"
            "  $env:QINIU_DOMAIN='dl.mona.lzfun.vip'",
            file=sys.stderr,
        )
        sys.exit(1)
    return value


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_size(path: str) -> int:
    return Path(path).stat().st_size


def upload_to_qiniu(local_path: str, key: str) -> None:
    """上传单个文件到七牛云存储空间。

    使用分片上传，适合大文件。上传策略覆盖同名文件。
    """
    from qiniu import Auth, BucketManager  # type: ignore[import-untyped]

    ak = _require_env("QINIU_AK")
    sk = _require_env("QINIU_SK")
    bucket = _require_env("QINIU_BUCKET")

    auth = Auth(ak, sk)
    token = auth.upload_token(bucket, key, 3600, policy={"insertOnly": 0})

    size_mb = _file_size(local_path) / 1_048_576
    print(f"  上传 {key} ({size_mb:.0f} MB) ...")

    from qiniu import put_file  # type: ignore[import-untyped]

    ret, info = put_file(token, key, local_path, version="v2")
    if info.status_code != 200:
        print(f"  上传失败：{info}", file=sys.stderr)
        sys.exit(1)

    # 刷新 CDN 缓存，确保用户立即拿到最新版本
    domain = os.environ.get("QINIU_DOMAIN", "")
    if domain:
        try:
            bucket_mgr = BucketManager(auth)
            # 七牛 SDK 的预取方法名是 prefetch，不是 prefetch_urls
            ret, info = bucket_mgr.prefetch(bucket, key)
            print(f"  CDN 预取：{info.status_code}")
            # prefetch 失败不阻断流程，文件仍可通过正常访问触发回源
        except Exception as e:
            print(f"  CDN 预取跳过：{e}")

    print(f"  完成 -> https://{domain}/{key}")


def update_vps_manifest(
    version: str,
    update_pkg_filename: str,
    sha256_hash: str,
    size: int,
    notes: str,
    git_hash: str,
) -> None:
    """更新 VPS 上的 update.json 清单（小文件，保留在 VPS 便于频繁更新）。"""
    import paramiko

    host = os.environ.get("VPS_HOST", "47.117.69.105")
    password = os.environ.get("VPS_PASSWORD")
    if not password:
        print("错误：缺少环境变量 VPS_PASSWORD", file=sys.stderr)
        sys.exit(1)

    domain = os.environ.get("QINIU_DOMAIN", "dl.mona.lzfun.vip")
    manifest = {
        "version": version,
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": f"https://{domain}/{update_pkg_filename}",
        "sha256": sha256_hash,
        "size": size,
        "git_hash": git_hash,
    }

    print("更新 VPS update.json ...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username="root", password=password, timeout=10)
    sftp = ssh.open_sftp()
    with sftp.open("/var/www/mona/updates/update.json", "w") as f:
        f.write(json.dumps(manifest, indent=2))
    sftp.close()
    ssh.close()
    print("  完成")


def main() -> None:
    if len(sys.argv) != 7:
        print(__doc__)
        sys.exit(1)

    version, nsis_path, update_pkg_path, sha256_hash, notes, git_hash = sys.argv[1:7]

    # 校验文件存在
    for label, path in [("NSIS 安装包", nsis_path), ("热更新包", update_pkg_path)]:
        if not Path(path).exists():
            print(f"错误：{label}不存在：{path}", file=sys.stderr)
            sys.exit(1)

    update_pkg_filename = Path(update_pkg_path).name
    update_size = _file_size(update_pkg_path)

    # 重新计算 sha256 以防传入错误值
    actual_sha = _sha256(update_pkg_path)
    if sha256_hash and sha256_hash.lower() != actual_sha:
        print(f"警告：传入的 sha256 与实际不符，使用实际值 {actual_sha}", file=sys.stderr)
    sha256_hash = actual_sha

    print(f"=== Mona {version} 发布上传 ===\n")

    # 1. 上传 NSIS 安装包到七牛云（覆盖 Mona-latest.exe）
    print("[1/3] 上传 NSIS 安装包")
    upload_to_qiniu(nsis_path, "Mona-latest.exe")

    # 2. 上传热更新包到七牛云
    print("\n[2/3] 上传热更新包")
    upload_to_qiniu(update_pkg_path, update_pkg_filename)

    # 3. 更新 VPS update.json 清单
    print("\n[3/3] 更新清单")
    update_vps_manifest(
        version=version,
        update_pkg_filename=update_pkg_filename,
        sha256_hash=sha256_hash,
        size=update_size,
        notes=notes,
        git_hash=git_hash,
    )

    print("\n=== 全部完成 ===")
    domain = os.environ.get("QINIU_DOMAIN", "dl.mona.lzfun.vip")
    print(f"安装包：https://{domain}/Mona-latest.exe")
    print(f"更新包：https://{domain}/{update_pkg_filename}")
    print("清单：  https://mona.lzfun.vip/updates/update.json")


if __name__ == "__main__":
    main()
