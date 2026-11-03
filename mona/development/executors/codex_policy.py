
from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

from mona.development.context import ProjectContext
from mona.development.executors.rpc import RpcError

_ENV_KEYS = frozenset({
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
})


def similar_command_prefix(params: dict[str, Any]) -> list[str] | None:
    prefix = params.get("proposedExecpolicyAmendment")
    if not isinstance(prefix, list) or not 1 <= len(prefix) <= 32 or any(
            not isinstance(part, str) or not part.strip() or len(part) > 2048 or "\x00" in part or "\n" in part for part in prefix):
        return None
    choices = params.get("availableDecisions")
    if choices is not None and (not isinstance(choices, list) or not any(
            value == "acceptWithExecpolicyAmendment" or isinstance(value, dict) and "acceptWithExecpolicyAmendment" in value for value in choices)):
        return None
    return prefix


_FIXED_CONFIG: dict[str, Any] = {
    "features.hooks": False,
    "features.memories": False,
    "features.apps": False,
    "features.plugins": False,
    "features.remote_plugin": False,
    "features.goals": False,
    "features.multi_agent": False,
    "features.multi_agent_v2": False,
    "agents.enabled": False,
    "notify": [],
    "mcp_servers": {},
    "project_doc_max_bytes": 0,
    "project_doc_fallback_filenames": [],
    "project_root_markers": [],
    "allow_login_shell": False,
    "shell_environment_policy.inherit": "core",
    "shell_environment_policy.ignore_default_excludes": False,
}


def _fixed_config() -> dict[str, Any]:
    # Windows otherwise downgrades workspace-write to read-only. Enable the
    # restricted-token backend without an elevated setup or unrestricted access.
    return {**_FIXED_CONFIG, **({"windows.sandbox": "unelevated"} if sys.platform == "win32" else {})}


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
    model_endpoint: str | None = None
    work_model_catalog: Path | None = None
    work_native_tools: tuple[str, ...] = ()


def prepare_codex_profile(executable: Path, home: Path, project_root: Path,
                          *, environment: Mapping[str, str] | None = None,
                          model_endpoint: str | None = None, model_token: str | None = None) -> CodexProfile:
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
    config = {**_fixed_config(), f"projects.{json.dumps(str(project_root))}.trust_level": "untrusted"}
    if model_endpoint and model_token:
        env["MONA_MODEL_ROUTE_TOKEN"] = model_token
        config.update({"model_provider": "mona_models", "model_providers.mona_models.name": "Mona Models",
            "model_providers.mona_models.base_url": model_endpoint + "/v1",
            "model_providers.mona_models.wire_api": "responses",
            "model_providers.mona_models.env_key": "MONA_MODEL_ROUTE_TOKEN",
            "model_providers.mona_models.requires_openai_auth": False,
            "model_providers.mona_models.supports_websockets": False,
            "features.enable_request_compression": False, "web_search": "disabled"})
    for key, value in config.items():
        args.extend(("-c", f"{key}={_toml(value)}"))
    return CodexProfile(tuple(args), home, project_root, env, model_endpoint)


def prepare_codex_work_profile(executable: Path, home: Path, root: Path, *,
                               native_tools: tuple[str, ...] = ()) -> tuple[CodexProfile, Path]:
    """Keep only the native basic tools authorized for this Work request."""
    selected = frozenset(native_tools)
    if (not selected.issubset({"exec_command", "write_stdin", "apply_patch", "view_image"})
            or ("exec_command" in selected) != ("write_stdin" in selected)):
        raise RpcError("native_policy_unavailable", "当前原生工具组合不能保持会话权限，未启动任务。")
    profile = prepare_codex_profile(executable, home, root)
    if selected:
        _check_empty_rule_directory(profile.home)
    try:
        catalog = json.loads((profile.home / "models_cache.json").read_text(encoding="utf-8"))
        models = catalog["models"]
        if not isinstance(models, list) or not models or not all(isinstance(model, dict) and model.get("slug") for model in models):
            raise ValueError("invalid native model catalog")
    except (OSError, ValueError, KeyError) as exc:
        raise RpcError("native_catalog_unavailable", "模型目录尚未同步，请在模型设置中刷新后重试。") from exc
    for model in models:
        if "exec_command" not in selected:
            model["shell_type"] = "disabled"
        if "apply_patch" not in selected:
            model["apply_patch_tool_type"] = None
        model.update(experimental_supported_tools=[], tool_mode="direct",
                     node_repl_disabled=True, include_skills_usage_instructions=False,
                     include_apps_usage_instructions=False, include_plugin_usage_instructions=False)
    path = profile.home / f".mona-work-models-{uuid4().hex}.json"
    with path.open("x", encoding="utf-8") as stream:
        json.dump({"models": models}, stream, ensure_ascii=False)
    overrides = {
        "model_catalog_json": str(path), "features.shell_tool": "exec_command" in selected,
        "features.shell_snapshot": False, "features.view_image": "view_image" in selected,
        "features.image_generation": False, "features.standalone_web_search": False,
        "web_search": "disabled", "features.js_repl": False, "features.code_mode": False,
        "features.code_mode_only": False,
        "model_provider": "mona_work_openai", "model_providers.mona_work_openai.name": "OpenAI",
        "model_providers.mona_work_openai.requires_openai_auth": True,
        "model_providers.mona_work_openai.wire_api": "responses",
        "model_providers.mona_work_openai.supports_websockets": False,
        "model_providers.mona_work_openai.include_internal_metadata": True,
    }
    command = list(profile.command)
    for key, value in overrides.items():
        command.extend(("-c", f"{key}={_toml(value)}"))
    if selected:
        projects = "{ " + json.dumps(str(profile.project_root)) + ' = { trust_level = "untrusted" } }'
        command.extend(("-c", f"projects={projects}"))
    return replace(profile, command=tuple(command), work_model_catalog=path,
                   work_native_tools=tuple(native_tools)), path


def _check_empty_rule_directory(folder: Path) -> None:
    try:
        directory = folder / "rules"
        if not directory.exists():
            return
        if not directory.resolve().is_relative_to(folder.resolve()):
            raise ValueError("rule directory outside configuration root")
        for path in directory.rglob("*.rules"):
            if not path.resolve().is_relative_to(directory.resolve()) or path.stat().st_size:
                raise ValueError("unverified native execution rules")
    except (OSError, RuntimeError, ValueError) as exc:
        raise RpcError("native_policy_unavailable", "现有原生执行规则可能绕过当前工具权限，未启动任务。") from exc


def validate_work_rule_sources(response: dict[str, Any], profile: CodexProfile,
                               requirements: Any) -> None:
    """Only an empty, verified policy stack can use per-operation approvals."""
    if not isinstance(requirements, dict) or "requirements" not in requirements or requirements["requirements"] is not None:
        raise RpcError("native_policy_unavailable", "无法确认原生托管策略不会扩大工具权限，未启动任务。")
    config = response["config"]
    if config.get("project_root_markers") != []:
        raise RpcError("native_policy_unavailable", "原生项目规则来源未通过权限检查，未启动任务。")
    layers = response.get("layers")
    if not isinstance(layers, list) or not layers:
        raise RpcError("native_policy_unavailable", "原生配置未提供可核对的规则来源，未启动任务。")
    _check_empty_rule_directory(profile.home)
    project_trust = []
    for layer in layers:
        if not isinstance(layer, dict) or not isinstance(layer.get("name"), dict):
            raise RpcError("native_policy_unavailable", "原生配置规则来源无法识别，未启动任务。")
        if layer.get("disabledReason"):
            continue
        source = layer["name"]
        kind = source.get("type")
        layer_config = layer.get("config")
        if not isinstance(layer_config, dict):
            raise RpcError("native_policy_unavailable", "原生配置层未提供可核对的权限内容，未启动任务。")
        priorities = {"packagedDefaults": -10, "system": 10, "user": 21 if source.get("profile") else 20,
                      "sessionFlags": 30}
        projects = layer_config.get("projects")
        if isinstance(projects, dict) and isinstance(projects.get(str(profile.project_root)), dict):
            trust = projects[str(profile.project_root)].get("trust_level")
            if trust is not None:
                project_trust.append((priorities.get(kind, 100), trust))
        if kind in {"sessionFlags", "packagedDefaults"}:
            continue
        if kind not in {"user", "system"}:
            raise RpcError("native_policy_unavailable", "原生配置包含无法保证逐次审批的规则来源，未启动任务。")
        path = source.get("file")
        if not isinstance(path, str) or not Path(path).is_absolute():
            raise RpcError("native_policy_unavailable", "原生配置缺少可核对的规则路径，未启动任务。")
        folder = Path(path).resolve().parent
        if kind == "user" and not folder.is_relative_to(profile.home.resolve()):
            raise RpcError("native_policy_unavailable", "原生用户规则不属于当前受管会话，未启动任务。")
        _check_empty_rule_directory(folder)
    if not project_trust or max(project_trust, key=lambda entry: entry[0])[1] != "untrusted":
        raise RpcError("native_policy_unavailable", "原生项目的实际信任配置未通过检查，未启动任务。")


def validate_effective_config(response: Any, *, model_endpoint: str | None = None,
                              work_model_catalog: Path | None = None,
                              work_native_tools: tuple[str, ...] = ()) -> None:
    if not isinstance(response, dict) or not isinstance(response.get("config"), dict):
        raise RpcError("isolation_unverified", "原生执行者未返回有效配置，未启动开发会话。")
    config = response["config"]
    if work_model_catalog is not None:
        for key, expected in {"model_catalog_json": str(work_model_catalog),
                              "features.shell_tool": "exec_command" in work_native_tools,
                              "features.view_image": "view_image" in work_native_tools, "web_search": "disabled",
                              "model_provider": "mona_work_openai",
                              "model_providers.mona_work_openai.name": "OpenAI",
                              "model_providers.mona_work_openai.wire_api": "responses",
                              "model_providers.mona_work_openai.requires_openai_auth": True,
                              "model_providers.mona_work_openai.supports_websockets": False,
                              "model_providers.mona_work_openai.base_url": None}.items():
            if _get(config, key) != expected:
                raise RpcError("work_policy_unverified", "模型引擎的工具权限未生效，未发送会话请求。")
    if model_endpoint:
        for key, expected in {"model_provider": "mona_models",
                "model_providers.mona_models.base_url": model_endpoint + "/v1",
                "model_providers.mona_models.wire_api": "responses",
                "model_providers.mona_models.env_key": "MONA_MODEL_ROUTE_TOKEN",
                "model_providers.mona_models.requires_openai_auth": False}.items():
            if _get(config, key) != expected:
                raise RpcError("model_route_unverified", "模型来源配置未生效，未启动任务。")
    # Do not mistake an empty-table override for removal after recursive merging.
    if config.get("mcp_servers") or config.get("hooks") or config.get("plugins"):
        raise RpcError("project_policy_violation", "原生配置仍包含自定义 MCP、Hooks 或插件，未启动开发会话。")
    for key, expected in _fixed_config().items():
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
