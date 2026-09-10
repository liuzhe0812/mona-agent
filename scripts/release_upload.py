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
  python scripts/release_upload.py <version> <nsis_path> <update_pkg_path> <sha256> <notes> <git_hash> \\
    --changelog-items-file <items.json>

Example:
  python scripts/release_upload.py 1.0.2 \
    "src-tauri/target/release/bundle/nsis/Mona_1.0.2_x64-setup.exe" \
    "dist/mona-1.0.2.tar.zst" \
    "abc123..." "修复若干问题" "def456..." \\
    --changelog-items-file "output/release-changelog-items.json"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_OFFICIAL_SITE_ROOT = _PROJECT_ROOT / "official-site"
_CHANGELOG_PATH = _OFFICIAL_SITE_ROOT / "public" / "changelog.json"
_STATIC_SITE_PATH = _OFFICIAL_SITE_ROOT / "dist-static"


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


def _read_changelog_items(path: str) -> list[str]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"错误：无法读取更新日志条目：{path}") from exc
    if not isinstance(value, list) or not value or not all(
        isinstance(item, str) and item.strip() for item in value
    ):
        raise SystemExit("错误：更新日志条目必须是非空 JSON 字符串数组。")
    return [item.strip() for item in value]


def update_local_changelog(
    *,
    version: str,
    pub_date: str,
    git_hash: str,
    summary: str,
    items: list[str],
) -> Path:
    """Prepend or replace one release entry in the official site source."""
    try:
        document: dict[str, Any] = json.loads(_CHANGELOG_PATH.read_text(encoding="utf-8"))
        releases = document["releases"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"错误：官网更新日志无效：{_CHANGELOG_PATH}") from exc
    if not isinstance(releases, list):
        raise SystemExit(f"错误：官网更新日志 releases 必须是数组：{_CHANGELOG_PATH}")

    previous = next(
        (
            str(release.get("gitHash", ""))
            for release in releases
            if isinstance(release, dict) and release.get("version") != version
        ),
        "",
    )
    entry = {
        "version": version,
        "pubDate": pub_date,
        "gitHash": git_hash,
        "previousGitHash": previous,
        "summary": summary,
        "items": items,
    }
    document["releases"] = [entry] + [
        release
        for release in releases
        if not isinstance(release, dict) or release.get("version") != version
    ]

    temporary = _CHANGELOG_PATH.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(_CHANGELOG_PATH)
    return _CHANGELOG_PATH


def _run_remote(ssh: Any, command: str, label: str) -> None:
    _, stdout, stderr = ssh.exec_command(command, timeout=60)
    status = stdout.channel.recv_exit_status()
    if status != 0:
        detail = stderr.read().decode("utf-8", errors="replace").strip()
        raise SystemExit(f"错误：{label}失败（退出码 {status}）：{detail}")


def _upload_tree(sftp: Any, source: Path, destination: str) -> None:
    for directory, directories, files in os.walk(source):
        directories.sort()
        files.sort()
        relative = Path(directory).relative_to(source).as_posix()
        remote_directory = destination if relative == "." else f"{destination}/{relative}"
        try:
            sftp.mkdir(remote_directory)
        except OSError:
            pass
        for filename in files:
            sftp.put(str(Path(directory) / filename), f"{remote_directory}/{filename}")


def build_and_publish_changelog(
    *,
    version: str,
    notes: str,
    git_hash: str,
    items: list[str],
    pub_date: str,
) -> None:
    """Build the official static site and atomically deploy its changelog."""
    if not (_OFFICIAL_SITE_ROOT / "package.json").is_file():
        raise SystemExit(f"错误：未找到官网源码：{_OFFICIAL_SITE_ROOT}")
    update_local_changelog(
        version=version,
        pub_date=pub_date,
        git_hash=git_hash,
        summary=notes,
        items=items,
    )
    print("构建官网更新日志 ...")
    npm = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.run([npm, "run", "build:static"], cwd=_OFFICIAL_SITE_ROOT, check=True)
    static_index = _STATIC_SITE_PATH / "static-index.html"
    if not static_index.is_file():
        raise SystemExit(f"错误：官网静态构建缺少 static-index.html：{_STATIC_SITE_PATH}")

    import paramiko

    password = _require_env("VPS_PASSWORD")
    host = os.environ.get("VPS_HOST", "47.117.69.105")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stage = f"/var/www/mona/.dist-staging-{stamp}-{os.getpid()}"
    backup = f"/var/www/mona/backups/dist-{stamp}"
    target = "/var/www/mona/dist"
    print("发布官网更新日志 ...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username="root", password=password, timeout=15)
    sftp = ssh.open_sftp()
    try:
        _run_remote(ssh, f"mkdir {stage}", "创建官网发布暂存目录")
        _upload_tree(sftp, _STATIC_SITE_PATH, stage)
        sftp.rename(f"{stage}/static-index.html", f"{stage}/index.html")
        _run_remote(ssh, f"test -f {stage}/index.html", "验证官网暂存内容")
        _run_remote(ssh, "mkdir -p /var/www/mona/backups", "创建官网备份目录")
        _run_remote(ssh, f"mv {target} {backup}", "备份当前官网")
        try:
            _run_remote(ssh, f"mv {stage} {target}", "切换官网发布目录")
        except BaseException:
            _run_remote(ssh, f"mv {backup} {target}", "恢复官网备份")
            raise
    finally:
        sftp.close()
        ssh.close()
    print("  完成")


def _require_valid_authenticode_signature(path: str) -> None:
    """Refuse to publish an unsigned Windows installer."""
    if os.name != "nt":
        return

    sdk_root = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    sign_tools = sorted(
        (sdk_root / "Windows Kits" / "10" / "bin").glob("*/x64/signtool.exe"),
        reverse=True,
    )
    if not sign_tools:
        raise SystemExit("错误：未找到 signtool.exe，无法验证 Windows 安装包签名。")

    result = subprocess.run(
        [str(sign_tools[0]), "verify", "/pa", "/tw", "/v", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise SystemExit(
            f"错误：拒绝上传未通过 Authenticode 验证的安装包：{path}\n{detail}"
        )


def upload_to_qiniu(local_path: str, key: str) -> None:
    """上传单个文件到七牛云存储空间。

    使用分片上传，适合大文件。上传策略覆盖同名文件。
    """
    from qiniu import Auth  # type: ignore[import-untyped]

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

    # Overwriting a fixed release key requires invalidation, not prefetch.
    # Prefetch only warms the existing cached value and can leave an older
    # same-version package visible to clients.
    domain = os.environ.get("QINIU_DOMAIN", "")
    if domain:
        try:
            from qiniu import CdnManager  # type: ignore[import-untyped]

            _, info = CdnManager(auth).refresh_urls([f"https://{domain}/{key}"])
            print(f"  CDN 刷新：{info.status_code}")
        except Exception as e:
            print(f"  CDN 刷新跳过：{e}")

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
    parser = argparse.ArgumentParser(description="上传 Mona 桌面端发布产物并更新官网更新日志。")
    parser.add_argument("version")
    parser.add_argument("nsis_path")
    parser.add_argument("update_pkg_path")
    parser.add_argument("sha256_hash")
    parser.add_argument("notes")
    parser.add_argument("git_hash")
    parser.add_argument(
        "--changelog-items-file",
        required=True,
        help="包含面向用户更新条目的 JSON 字符串数组文件",
    )
    args = parser.parse_args()
    version = args.version
    nsis_path = args.nsis_path
    update_pkg_path = args.update_pkg_path
    sha256_hash = args.sha256_hash
    notes = args.notes
    git_hash = args.git_hash
    changelog_items = _read_changelog_items(args.changelog_items_file)

    # 校验文件存在
    for label, path in [("NSIS 安装包", nsis_path), ("热更新包", update_pkg_path)]:
        if not Path(path).exists():
            print(f"错误：{label}不存在：{path}", file=sys.stderr)
            sys.exit(1)

    _require_valid_authenticode_signature(nsis_path)

    update_pkg_filename = Path(update_pkg_path).name
    update_size = _file_size(update_pkg_path)

    # 重新计算 sha256 以防传入错误值
    actual_sha = _sha256(update_pkg_path)
    if sha256_hash and sha256_hash.lower() != actual_sha:
        print(f"警告：传入的 sha256 与实际不符，使用实际值 {actual_sha}", file=sys.stderr)
    sha256_hash = actual_sha

    print(f"=== Mona {version} 发布上传 ===\n")

    # 1. 上传 NSIS 安装包到七牛云（覆盖 Mona-latest.exe）
    print("[1/4] 上传 NSIS 安装包")
    upload_to_qiniu(nsis_path, "Mona-latest.exe")

    # 2. 上传热更新包到七牛云
    print("\n[2/4] 上传热更新包")
    upload_to_qiniu(update_pkg_path, update_pkg_filename)

    # 3. The website must be visible before the manifest advertises this release.
    print("\n[3/4] 发布官网更新日志")
    pub_date = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    build_and_publish_changelog(
        version=version,
        notes=notes,
        git_hash=git_hash,
        items=changelog_items,
        pub_date=pub_date,
    )

    # 4. Update manifest only after website publication succeeds.
    print("\n[4/4] 更新清单")
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
    print("清单：  https://www.mona-ai.cn/updates/update.json")


if __name__ == "__main__":
    main()
