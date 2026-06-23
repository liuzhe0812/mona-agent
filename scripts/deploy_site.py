"""Mona 官网站点部署脚本。

构建 site/ 前端并上传到 VPS /var/www/mona/dist/。

凭证从 .env 读取（VPS_HOST / VPS_PASSWORD），不硬编码。

Usage:
  python scripts/deploy_site.py
"""

from __future__ import annotations

import os
import subprocess
import sys
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
        if key not in os.environ:
            os.environ[key] = value


_load_env_file()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = PROJECT_ROOT / "site"
DIST_DIR = SITE_DIR / "dist"


def build_site() -> None:
    """构建官网前端。"""
    print("[1/2] 构建官网前端 ...")
    # Windows 上 npm 是 npm.cmd，shell=True 让系统解析命令
    result = subprocess.run(
        "npm run build",
        cwd=str(SITE_DIR),
        capture_output=True,
        text=True,
        shell=True,
    )
    if result.returncode != 0:
        print(f"构建失败：\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    if not DIST_DIR.exists():
        print(f"构建产物不存在：{DIST_DIR}", file=sys.stderr)
        sys.exit(1)
    file_count = sum(1 for _ in DIST_DIR.rglob("*") if _.is_file())
    print(f"  完成，共 {file_count} 个文件")


def upload_to_vps() -> None:
    """上传 site/dist/ 到 VPS /var/www/mona/dist/。"""
    import paramiko

    host = os.environ.get("VPS_HOST", "47.117.69.105")
    password = os.environ.get("VPS_PASSWORD")
    if not password:
        print("错误：缺少环境变量 VPS_PASSWORD（请配置 .env）", file=sys.stderr)
        sys.exit(1)

    print(f"[2/2] 上传到 VPS {host} ...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username="root", password=password, timeout=10)
    sftp = ssh.open_sftp()

    local_dist = str(DIST_DIR)
    remote_dist = "/var/www/mona/dist"

    # 确保远程根目录存在
    ssh.exec_command(f"mkdir -p {remote_dist}")

    uploaded = 0
    for root, _dirs, files in os.walk(local_dist):
        rel = os.path.relpath(root, local_dist).replace("\\", "/")
        remote_root = f"{remote_dist}/{rel}" if rel != "." else remote_dist
        if rel != ".":
            ssh.exec_command(f"mkdir -p {remote_root}")
        for f in files:
            local_path = os.path.join(root, f)
            remote_path = f"{remote_root}/{f}"
            sftp.put(local_path, remote_path)
            uploaded += 1

    sftp.close()
    ssh.close()
    print(f"  完成，上传 {uploaded} 个文件")


def main() -> None:
    print("=== Mona 官网部署 ===\n")
    build_site()
    upload_to_vps()
    print("\n=== 部署完成 ===")
    print("官网地址：https://mona.lzfun.vip/")


if __name__ == "__main__":
    main()
