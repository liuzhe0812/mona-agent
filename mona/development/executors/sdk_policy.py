
from __future__ import annotations

import importlib.metadata
import importlib.util
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from mona.development.contracts import ExecutorId
from mona.development.executors.codex_policy import _ENV_KEYS
from mona.development.executors.rpc import RpcError
from mona.development.executors.workbuddy_application import workbuddy_cli_launcher

SDK_MODULES = {ExecutorId.CLAUDE: "claude_agent_sdk", ExecutorId.CODEBUDDY: "codebuddy_agent_sdk"}
SDK_PACKAGES = {ExecutorId.CLAUDE: "claude-agent-sdk", ExecutorId.CODEBUDDY: "codebuddy-agent-sdk"}
MIN_SDK = {ExecutorId.CLAUDE: (0, 2, 134), ExecutorId.CODEBUDDY: (0, 3, 264)}


@dataclass(frozen=True)
class SDKProfile:
    executor: ExecutorId
    executable: Path
    home: Path
    project_root: Path
    environment: dict[str, str] = field(repr=False)


def sdk_version(executor: ExecutorId) -> str:
    if importlib.util.find_spec(SDK_MODULES[executor]) is None:
        raise RpcError("sdk_not_installed", "当前 Mona 环境缺少该执行者的官方 Agent SDK，请安装配套开发依赖。")
    try:
        value = importlib.metadata.version(SDK_PACKAGES[executor])
    except importlib.metadata.PackageNotFoundError as exc:
        raise RpcError("sdk_version_unknown", "官方 SDK 版本不可核对，未启动。") from exc
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value)
    if not match or not (MIN_SDK[executor] <= tuple(map(int, match.groups())) <
                         ((0, 3, 0) if executor == ExecutorId.CLAUDE else (0, 4, 0))):
        raise RpcError("unsupported_sdk_version", "当前 SDK 不满足项目配置隔离版本要求，未启动。")
    return value


def prepare_sdk_profile(executor: ExecutorId, executable: Path, home: Path, root: Path,
                        *, credential_env: str | None = None, environment: dict[str, str] | None = None,
                        codebuddy_environment: str = "internal", model_endpoint: str | None = None,
                        model_token: str | None = None) -> SDKProfile:
    if executor not in SDK_MODULES:
        raise RpcError("wrong_executor", "此宿主只接入 Claude Code 和 WorkBuddy 的配套 SDK。")
    if executor == ExecutorId.CODEBUDDY and codebuddy_environment not in {"internal", "external"}:
        raise RpcError("sdk_contract_incompatible", "请选择国内或国际 WorkBuddy 环境，未切换到其他服务。")
    executable, root, home = executable.resolve(strict=True), root.resolve(strict=True), home.resolve()
    if not executable.is_file() or not root.is_dir() or executable.suffix.lower() in {".bat", ".cmd", ".ps1"}:
        raise RpcError("unsupported_launcher", "请选择原生 CLI 可执行文件，不执行命令包装脚本。")
    if home.is_relative_to(root) or root.is_relative_to(home):
        raise RpcError("invalid_native_home", "受管原生会话数据必须与项目目录分离。")
    home.mkdir(parents=True, exist_ok=True)
    marker = home / ".mona-native-home"
    expected = f"mona-development-{executor.value}-v1\n"
    if not marker.exists():
        if any(home.iterdir()):
            raise RpcError("invalid_native_home", "目录不属于 Mona，未加载其中配置。")
        marker.write_text(expected, encoding="utf8")
    elif marker.read_text(encoding="utf8") != expected:
        raise RpcError("invalid_native_home", "原生数据目录标识不匹配。")
    source = os.environ if environment is None else environment
    env = {k.upper(): v for k, v in source.items() if k.upper() in _ENV_KEYS}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "appdata"),
        "LOCALAPPDATA": str(home / "localappdata"), "XDG_CONFIG_HOME": str(home / "config"),
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1", "NO_COLOR": "1",
        "CLAUDE_CONFIG_DIR": str(home / ".claude"), "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
        "ENABLE_CLAUDEAI_MCP_SERVERS": "false", "CODEBUDDY_CONFIG_DIR": str(home / ".codebuddy"),
        "DISABLE_AUTOUPDATER": "1"})
    if executor == ExecutorId.CODEBUDDY:
        # Pin one region for login, probes, main work and child work; ignore ambient overrides.
        env["CODEBUDDY_INTERNET_ENVIRONMENT"] = codebuddy_environment
        if workbuddy_cli_launcher(executable):
            env["ELECTRON_RUN_AS_NODE"] = "1"
    if model_endpoint and model_token:
        if executor != ExecutorId.CLAUDE:
            raise RpcError("unsupported_model_route", "此引擎暂不支持配置的模型来源。")
        env.update({"ANTHROPIC_BASE_URL": model_endpoint, "ANTHROPIC_API_KEY": model_token})
    elif credential_env:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", credential_env):
            raise RpcError("invalid_credential_reference", "认证只接受显式环境变量名称。")
        value = source.get(credential_env)
        if value:
            env["ANTHROPIC_API_KEY" if executor == ExecutorId.CLAUDE else "CODEBUDDY_API_KEY"] = value
    if not getattr(sys, "frozen", False):
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[3])
    return SDKProfile(executor, executable, home, root, env)


def worker_command() -> tuple[str, ...]:
    if getattr(sys, "frozen", False):
        return (sys.executable, "--development-sdk-worker")
    return (sys.executable, "-X", "utf8", "-m", "mona.development.executors.sdk_worker")
