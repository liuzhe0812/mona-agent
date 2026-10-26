"""Bounded native diagnostics: no task submission, guessed auth, or raw stderr."""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path

from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe
from mona.development.executors.login import AUTH_FAILURE_REASONS
from mona.development.executors.rpc import RpcError
from mona.development.executors.workbuddy_application import workbuddy_cli_launcher
from mona.development.store import DevelopmentError

# Only host-owned error codes may cross the SDK worker boundary.
ERRORS = {
    "executable_not_found": ("discovery", "未找到本地程序。", "选择已安装的原生程序路径。"),
    "invalid_executable": ("discovery", "程序路径无效。", "重新选择该执行者的实际程序文件。"),
    "unsupported_launcher": ("discovery", "入口是当前不支持的包装脚本。", "选择原生可执行文件；不会通过 shell 执行包装脚本。"),
    "executable_access_denied": ("launch", "系统拒绝启动所选程序。", "核对文件权限，或选择当前账户可以启动的官方独立 CLI。"),
    "invalid_executable_format": ("launch", "程序格式或系统架构不匹配。", "选择适用于当前系统和架构的原生程序。"),
    "native_launch_failed": ("launch", "程序未能启动。", "检查程序及其系统依赖后重新连接。"),
    "native_version_failed": ("launch", "程序未返回有效版本。", "核对所选文件是否为该执行者的官方 CLI。"),
    "native_version_timeout": ("launch", "读取程序版本超时。", "检查程序是否可以正常启动，然后重新检查。"),
    "native_exit_unconfirmed": ("launch", "版本检查进程尚未确认退出。", "先核对本次诊断进程状态，不重复启动检查。"),
    "native_version_incompatible": ("launch", "程序版本输出不属于所选执行者。", "选择正确的官方 CLI，不要选择桌面启动器或辅助程序。"),
    "sdk_not_installed": ("dependency", "缺少此执行者的配套 SDK。", "源码环境安装项目的 development 依赖；安装版应修复配套应用资源。"),
    "sdk_dependency_missing": ("dependency", "SDK 依赖不完整。", "修复项目的 development 依赖后重新检查。"),
    "sdk_version_unknown": ("dependency", "无法核对 SDK 版本。", "重新安装项目声明的配套 SDK。"),
    "unsupported_sdk_version": ("dependency", "SDK 不在支持的版本范围内。", "使用项目声明的 SDK 版本范围，不自动升级或降级。"),
    "sdk_contract_incompatible": ("dependency", "SDK 接口与当前接入契约不兼容。", "使用配套 SDK 和官方 CLI 后重新检查。"),
    "sdk_host_tools_unsupported": ("dependency", "当前 SDK 缺少宿主协作工具接口。", "使用与 Mona 配套的官方 SDK；不会静默关闭子智能体协作或改用其他模型。"),
    "sdk_isolation_unsupported": ("protocol", "此 SDK 无法表达要求的配置隔离。", "更新到支持矩阵内的 SDK 与 CLI；不会放宽配置隔离。"),
    "sdk_cli_path_unsupported": ("dependency", "SDK 不支持显式指定当前 CLI。", "使用配套 SDK，不改用其他未指定的程序。"),
    "sdk_unexpected_mcp": ("protocol", "原生连接出现未授权 MCP。", "检查配套版本和隔离配置；未启动开发任务。"),
    "native_startup_failed": ("protocol", "原生初始化没有完成。", "核对 CLI 与 SDK 版本及认证设置，再重新检查。"),
    "native_protocol_error": ("protocol", "原生协议回执不兼容。", "使用受支持的 CLI 版本重新检查。"),
    "native_request_rejected": ("protocol", "模型引擎拒绝了当前操作。", "请检查引擎连接与程序版本；本次操作未自动重试。"),
    "native_history_unsupported": ("protocol", "当前程序不支持查询完整任务历史。", "原任务仍保留，未自动重新执行；请核对文件和任务结果。"),
    "native_request_timeout": ("protocol", "等待原生接口超时。", "检查执行者进程和网络；已有任务不会自动重跑。"),
    "native_transport_lost": ("protocol", "原生连接已断开。", "重新检查连接；已有执行结果需另行核对。"),
    "native_disconnected": ("protocol", "原生连接已关闭。", "重新检查连接，不会自动重新执行旧任务。"),
    "isolation_unverified": ("protocol", "不能确认项目配置隔离。", "使用支持矩阵内版本；不会默认继承用户配置。"),
    "project_policy_violation": ("protocol", "当前配置不满足项目隔离要求。", "核对配套版本，保留项目规则和 Skills 白名单。"),
    "authentication_required": ("authentication", "尚未完成当前受管环境的认证。", "使用官方登录入口或明确的认证环境变量。"),
    **{code: ("authentication", reason, "先核对当前连接与原登录状态，不自动重复授权。")
       for code, reason in AUTH_FAILURE_REASONS.items()},
}


def failed_probe(executor: ExecutorId, error: DevelopmentError, *, executable: str | None = None,
                 sdk_version: str | None = None, version: str | None = None) -> ExecutorProbe:
    stage, reason, action = ERRORS.get(error.code, ("protocol", "执行者检查未完成。", "核对执行者设置后重新检查。"))
    return ExecutorProbe(executor=executor, state="unavailable", executable=executable,
        sdk_version=sdk_version, version=version, stage=stage, error_code=error.code,
        authentication="required" if stage == "authentication" else "unknown", reason=reason, next_action=action)


async def native_version(executable: Path, executor: ExecutorId, *, cwd: Path,
                         env: Mapping[str, str], timeout: float = 8) -> str:
    """A version check is not a model request or an authenticated session."""
    launcher = workbuddy_cli_launcher(executable) if executor == ExecutorId.CODEBUDDY else None
    command = (str(launcher), str(executable)) if launcher else (str(executable),)
    launch_env = dict(env)
    if launcher:
        launch_env["ELECTRON_RUN_AS_NODE"] = "1"
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(*command, "--version", cwd=str(cwd),
        env=launch_env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, **kwargs))
    process = None
    readers: list[asyncio.Task] = []
    try:
        process = await asyncio.shield(spawn)
        async def read(stream):
            data = bytearray()
            while block := await stream.read(1024):
                data.extend(block)
                if len(data) > 8192:
                    raise RpcError("native_version_failed", "版本回执超过大小限制。")
            return bytes(data)
        readers = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr))]
        stdout, _ = await asyncio.wait_for(asyncio.gather(*readers), timeout)
        await asyncio.wait_for(process.wait(), 1)
        if process.returncode:
            raise RpcError("native_version_failed", "程序没有正常返回版本。")
        text = stdout.decode("utf8", "replace").strip()
        patterns = {ExecutorId.CLAUDE: r"(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\s+\(Claude Code\)",
                    ExecutorId.CODEBUDDY: r"(?:CodeBuddy(?: Code)?\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)(?:\s+\(CodeBuddy(?: Code)?\))?",
                    ExecutorId.CODEX: r"codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.]+)?)"}
        match = re.fullmatch(patterns[executor], text, re.IGNORECASE)
        if not match:
            raise RpcError("native_version_incompatible", "版本回执不属于所选执行者。")
        return match.group(1)
    except asyncio.TimeoutError as exc:
        raise RpcError("native_version_timeout", "等待版本超时，未发送任务。") from exc
    except OSError as exc:
        code = "executable_access_denied" if isinstance(exc, PermissionError) else (
            "invalid_executable_format" if getattr(exc, "winerror", None) in {193, 216} or exc.errno == 8 else "native_launch_failed")
        raise RpcError(code, "程序未能启动，未发送任务。") from exc
    finally:
        if process is None and not spawn.cancelled():
            try:
                process = await spawn
            except OSError:
                pass
        try:
            if process is not None and process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError as exc:
                    raise RpcError("native_exit_unconfirmed", "版本检查进程尚未确认退出。", outcome_unknown=True) from exc
        finally:
            for task in readers:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
