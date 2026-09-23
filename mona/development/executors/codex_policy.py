"""Codex project-only launch policy; never copies the user's CLI home/config.

Authentication belongs to the managed native home or an explicit auth flow, not
this resource loader. Effective configuration is checked before starting threads.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mona.development.context import ProjectContext
from mona.development.executors.rpc import RpcError

_ENV_KEYS = frozenset({
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
})
_FIXED_CONFIG: dict[str, Any] = {
    "features.hooks": False,
    "features.memories": False,
    "features.apps": False,
    "features.plugins": False,
    "features.remote_plugin": False,
    "features.goals": False,
    "notify": [],
    "mcp_servers": {},
    "project_doc_max_bytes": 0,
    "project_doc_fallback_filenames": [],
    "project_root_markers": [],
    "allow_login_shell": False,
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.ignore_default_excludes": False,
}


def _toml(value: Any) -> str:
    if value == {}:
        return "{}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _get(config: dict[str, Any], key: str) -> Any:
    value: Any = config
    for part in key.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


@dataclass(frozen=True)
class CodexProfile:
    command: tuple[str, ...]
    home: Path
    project_root: Path
    environment: Mapping[str, str] = field(repr=False)


def prepare_codex_profile(executable: Path, home: Path, project_root: Path,
                          *, environment: Mapping[str, str] | None = None) -> CodexProfile:
    """Home is a host-owned persistent directory outside the source project."""
    executable = Path(executable).resolve(strict=True)
    project_root = Path(project_root).resolve(strict=True)
    home = Path(home).resolve()
    if not executable.is_file() or not project_root.is_dir():
        raise RpcError("invalid_launch", "Codex 需要实际可执行程序和项目目录。")
    if home.is_relative_to(project_root) or project_root.is_relative_to(home):
        raise RpcError("invalid_native_home", "原生会话数据不能与源代码目录互相包含。")
    if executable.suffix.lower() in {".cmd", ".bat", ".ps1"}:
        raise RpcError("unsupported_launcher", "请选择 Codex 原生可执行文件，而非终端包装脚本。")
    home.mkdir(parents=True, exist_ok=True)
    # The caller provides a Mona-owned directory, never ~/.codex. Refuse an
    # unrelated existing directory instead of treating its config as trusted.
    marker = home / ".mona-native-home"
    if not marker.exists():
        if any(home.iterdir()):
            raise RpcError("invalid_native_home", "原生数据目录不属于 Mona，未读取或覆盖其中配置。")
        with marker.open("x", encoding="utf-8") as stream:
            stream.write("mona-development-codex-v1\n")
    elif marker.read_text(encoding="utf-8") != "mona-development-codex-v1\n":
        raise RpcError("invalid_native_home", "原生数据目录标识不匹配。")
    source = os.environ if environment is None else environment
    env: dict[str, str] = {}
    for key, value in source.items():
        canonical = key.upper()
        if canonical in _ENV_KEYS:
            env[canonical] = value
    env.update({"HOME": str(home), "USERPROFILE": str(home), "CODEX_HOME": str(home),
                "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1"})
    args = [str(executable), "app-server"]
    config = {**_FIXED_CONFIG, f"projects.{json.dumps(str(project_root))}.trust_level": "untrusted"}
    for key, value in config.items():
        args.extend(("-c", f"{key}={_toml(value)}"))
    return CodexProfile(tuple(args), home, project_root, env)


def validate_effective_config(response: Any) -> None:
    if not isinstance(response, dict) or not isinstance(response.get("config"), dict):
        raise RpcError("isolation_unverified", "原生执行者未返回有效配置，未启动开发会话。")
    config = response["config"]
    # Do not mistake an empty-table override for removal after recursive merging.
    if config.get("mcp_servers") or config.get("hooks") or config.get("plugins"):
        raise RpcError("project_policy_violation", "原生配置仍包含自定义 MCP、Hooks 或插件，未启动开发会话。")
    for key, expected in _FIXED_CONFIG.items():
        if key in {"mcp_servers", "project_root_markers", "project_doc_fallback_filenames", "notify"}:
            actual = _get(config, key)
            if actual not in (None, expected):
                raise RpcError("project_policy_violation", f"原生配置未满足项目隔离：{key}。")
        elif _get(config, key) != expected:
            raise RpcError("isolation_unverified", f"当前版本不能确认项目隔离配置：{key}。")
    for key in ("developer_instructions", "model_instructions_file", "instructions"):
        if config.get(key):
            raise RpcError("project_policy_violation", "检测到项目来源之外的自定义提示词，未启动会话。")


def disabled_skill_overrides(response: Any, context: ProjectContext) -> list[dict[str, Any]]:
    """Explicitly disable every discovered skill outside the authorized index."""
    if not isinstance(response, dict) or not isinstance(response.get("data"), list):
        raise RpcError("isolation_unverified", "当前版本不能检查原生 Skills 来源。")
    if len(response["data"]) != 1:
        raise RpcError("isolation_unverified", "原生 Skills 未返回唯一的当前项目结果。")
    allowed = {(context.root / skill.path).resolve() for skill in context.skills}
    disabled: list[dict[str, Any]] = []
    for group in response["data"]:
        if (not isinstance(group, dict) or group.get("errors") or group.get("cwd") != str(context.root)):
            raise RpcError("isolation_unverified", "原生 Skills 发现不完整，未启动会话。")
        skills = group.get("skills")
        if not isinstance(skills, list) or len(skills) > 2048:
            raise RpcError("isolation_unverified", "原生 Skills 数据格式不兼容。")
        for skill in skills:
            if not isinstance(skill, dict) or not isinstance(skill.get("path"), str):
                raise RpcError("isolation_unverified", "原生 Skill 缺少可核对的来源路径。")
            if not Path(skill["path"]).is_absolute():
                raise RpcError("isolation_unverified", "原生 Skill 来源不是绝对路径。")
            path = Path(skill["path"]).resolve()
            skill_file = path if path.name == "SKILL.md" else path / "SKILL.md"
            if skill_file not in allowed:
                disabled.append({"path": str(path.parent if path.name == "SKILL.md" else path), "enabled": False})
    return disabled
