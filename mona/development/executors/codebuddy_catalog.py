"""Read CodeBuddy account/model metadata over its public ACP surface, never prompt.

The Python SDK's initialization does not expose the catalog. Reuse the exact
managed native program/home/region and our existing RPC transport instead of
reading credential files or maintaining a static list of vendor models.
"""
from __future__ import annotations

import asyncio

from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorModel, ExecutorProbe
from mona.development.executors.rpc import JsonRpcProcess, RemoteRpcError, RpcError
from mona.development.executors.sdk_policy import SDKProfile
from mona.development.executors.workbuddy_application import workbuddy_cli_launcher


def parse_models(reply: object) -> tuple[list[ExecutorModel], str | None]:
    if not isinstance(reply, dict) or not isinstance(reply.get("sessionId"), str) or not reply["sessionId"]:
        raise ValueError("invalid_catalog_session")
    catalog = reply.get("models")
    if not isinstance(catalog, dict) or not isinstance(catalog.get("availableModels"), list):
        raise ValueError("missing_model_catalog")
    rows = catalog["availableModels"]
    if len(rows) > 512:
        raise ValueError("model_catalog_too_large")
    models, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid_model_entry")
        meta = row.get("_meta", {})
        if not isinstance(meta, dict):
            raise ValueError("invalid_model_metadata")
        model = ExecutorModel(id=row.get("modelId"), label=row.get("name"),
            description=row.get("description"), context_window=meta.get("maxInputTokens"))
        if model.id != model.id.strip() or not model.label.strip() or model.id in seen:
            raise ValueError("invalid_or_duplicate_model")
        seen.add(model.id)
        models.append(model)
    default = catalog.get("currentModelId")
    if default is not None and (not isinstance(default, str) or default and models and default not in seen):
        raise ValueError("invalid_default_model")
    return models, default if default in seen else None


async def inspect_codebuddy_catalog(profile: SDKProfile) -> ExecutorProbe:
    result = ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="detected", stage="protocol",
        executable=str(profile.executable), model_catalog_state="unavailable")
    connection = None
    async def reject_request(*_args):
        raise RpcError("catalog_tools_disabled", "账号和模型检查不允许执行工具或发起授权。")
    try:
        async with asyncio.timeout(45):
            launcher = workbuddy_cli_launcher(profile.executable)
            command = (str(launcher), str(profile.executable)) if launcher else (str(profile.executable),)
            connection = await JsonRpcProcess.spawn((*command, "--acp",
                "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                "--tools", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}'),
                cwd=profile.project_root, env=profile.environment, jsonrpc_version=True,
                notification=lambda *_: None, server_request=reject_request,
                disconnected=lambda _: None, request_timeout=20)
            info = await connection.request("initialize", {"protocolVersion": 1,
                "clientInfo": {"name": "mona-model-catalog", "version": "1.8.0"},
                "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
            if not isinstance(info, dict) or type(info.get("protocolVersion")) is not int or info["protocolVersion"] != 1:
                raise ValueError("incompatible_catalog_protocol")
            result.protocol_verified, result.stage = True, "authentication"
            account = await connection.request("_codebuddy.ai/getUserInfo", {})
            if not isinstance(account, dict) or account and "userInfo" not in account:
                raise ValueError("invalid_account_state")
            # Desktop CLI omits userInfo (undefined in JS) when signed out.
            user = account.get("userInfo")
            if user is None or user == {}:
                result.authentication = "required"
            elif isinstance(user, dict) and isinstance(user.get("userId"), str) and user["userId"].strip():
                # Only the verified state escapes; account values and tokens do not.
                result.authentication, result.stage = "ready", "models"
                reply = await connection.request("session/new", {"cwd": str(profile.project_root), "mcpServers": []})
                result.model_details, result.default_model = parse_models(reply)
                result.model_catalog_state = "ready" if result.model_details else "empty"
                result.state = "ready"
                result.stage = "ready"
            else:
                raise ValueError("unconfirmed_account_identity")
    except RemoteRpcError as exc:
        if exc.rpc_code == -32000:
            result.authentication, result.stage = "required", "authentication"
        result.error_code = "codebuddy_auth_required" if exc.rpc_code == -32000 else (
            "codebuddy_catalog_unsupported" if exc.rpc_code == -32601 else "codebuddy_catalog_unavailable")
    except (RpcError, TimeoutError, ValueError):
        result.error_code = "codebuddy_catalog_unavailable"
    finally:
        if connection:
            await connection.close()
    if result.authentication == "required":
        result.reason = "WorkBuddy 账号尚未登录或已失效，请完成官方授权。"
        result.next_action = "连接 WorkBuddy"
    elif result.model_catalog_state == "ready":
        result.reason = "WorkBuddy 账号状态已确认，真实模型目录已同步。"
    elif result.model_catalog_state == "empty":
        result.reason = "WorkBuddy 账号状态已确认，但当前账号未返回可用模型。"
        result.next_action = "重新同步模型"
    else:
        result.reason = ("WorkBuddy 账号状态已确认，但模型目录同步失败。" if result.authentication == "ready"
                         else "尚未确认 WorkBuddy 账号状态和模型目录。")
        result.next_action = "重新同步账号与模型"
    return result
