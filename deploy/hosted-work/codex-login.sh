#!/usr/bin/env bash
set -euo pipefail

# Run as liuzhe in the Ubuntu terminal; this never prints the authentication file.
cd /home/liuzhe/mona-hosted-work/releases/20261030-accounts-committed/content
exec /home/liuzhe/mona-hosted-work/venv/bin/python -c '
import json
import os
import subprocess
import sys
from pathlib import Path

from mona.config.schema import Config, DevelopmentConfig, _resolve_tool_config_refs
from mona.development.executors.discovery import discover_executors
from mona.development.executors.codex_policy import prepare_codex_profile

os.umask(0o077)
_resolve_tool_config_refs()
base = Path("/home/liuzhe/mona-hosted-work").resolve(strict=True)
config_root = (base / "config").resolve(strict=True)
if not config_root.is_relative_to(base):
    raise SystemExit("配置目录不在 Work 目录内。")
native_config = config_root / "codex-provider.json"
home = config_root / "development" / "native" / "codex"
bootstrap = config_root / "codex-bootstrap"
if not home.resolve().is_relative_to(config_root) or not bootstrap.resolve().is_relative_to(config_root):
    raise SystemExit("Codex 目录不在 Work 配置范围内。")
if native_config.is_symlink():
    raise SystemExit("Codex 配置不能是符号链接。")
args = sys.argv[1:]
if native_config.exists():
    try:
        config = Config.model_validate(json.loads(native_config.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        raise SystemExit("Codex 连接配置无法读取或格式无效，请在本机核对。") from None
    development = config.development
    if "codex" not in development.enabled_engines:
        raise SystemExit("Codex 连接配置尚未启用 codex 引擎。")
    if not development.codex_path:
        raise SystemExit("请在现有 Codex 连接配置中填写 development.codex_path，确保服务使用同一程序。")
elif args == ["--init-config"]:
    development = DevelopmentConfig(enabled_engines=["codex"])
else:
    raise SystemExit("请先运行 --init-config 初始化 Codex 连接配置。")
bootstrap.mkdir(mode=0o700, parents=True, exist_ok=True)
if any(bootstrap.iterdir()):
    raise SystemExit("Codex 初始化目录不是空目录，请先核对；未删除任何文件。")
probe = next((p for p in discover_executors(development)
              if p.executor.value == "codex"), None)
if probe is None or probe.state != "detected" or not probe.executable:
    raise SystemExit("未找到已配置的 Codex 原生程序，请核对 development.codex_path；未下载或安装。")
profile = prepare_codex_profile(Path(probe.executable), home, bootstrap)
if args == ["--init-config"]:
    if native_config.exists():
        print("已核对并保留现有 codex-provider.json。")
    else:
        with native_config.open("x", encoding="utf-8") as stream:
            json.dump({"development": {"enabled_engines": ["codex"],
                "codex_path": profile.command[0]}}, stream, indent=2)
        print("已创建 Codex 连接配置。")
    print("Codex 程序：" + profile.command[0])
    print("CODEX_HOME：" + str(profile.home))
elif args == ["--list-cached-models"]:
    cache = home / "models_cache.json"
    if not cache.is_file() or cache.stat().st_size > 10 * 1024 * 1024:
        raise SystemExit("CLI 尚未生成可用的 models_cache.json；Work 尚未就绪。")
    models = json.loads(cache.read_text(encoding="utf-8")).get("models")
    if not isinstance(models, list) or not models or not all(
        isinstance(m, dict) and isinstance(m.get("slug"), str) and m["slug"] for m in models
    ):
        raise SystemExit("原生模型缓存格式与已发布 Work 不兼容。")
    print("\n".join(dict.fromkeys(m["slug"] for m in models)))
else:
    environment = dict(profile.environment)
    if os.environ.get("TERM"):
        environment["TERM"] = os.environ["TERM"]
    raise SystemExit(subprocess.run([profile.command[0], *args], cwd=bootstrap, env=environment).returncode)
' "$@"
