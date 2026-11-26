"""Read the managed Codex account for an isolated Work connection."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
from pathlib import Path
from typing import Any

from mona.development.executors.codex_policy import prepare_codex_profile
from mona.development.executors.rpc import RpcError


def _account_id_from_token(token: str) -> str | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        claims = payload.get("https://api.openai.com/auth") if isinstance(payload, dict) else None
        account_id = claims.get("chatgpt_account_id") if isinstance(claims, dict) else None
        return account_id if isinstance(account_id, str) and account_id.strip() else None
    except (ValueError, TypeError, UnicodeDecodeError, binascii.Error):
        return None


async def read_codex_work_auth(
    executable: Path,
    home: Path,
    root: Path,
    *,
    refresh: bool = False,
    expected_account_id: str | None = None,
) -> dict[str, Any]:
    from mona.development.executors.codex import CodexExecutor

    try:
        host = CodexExecutor(prepare_codex_profile(executable, home, root))
    except Exception:
        raise RpcError("native_auth_binding_unavailable", "无法确认模型连接的登录状态。") from None
    try:
        try:
            client = await host._ensure_started()
            status = await client.request("getAuthStatus", {"includeToken": True, "refreshToken": refresh})
            account = await client.request("account/read", {"refreshToken": False})
            current = await client.request("getAuthStatus", {"includeToken": True, "refreshToken": False})
            if not isinstance(status, dict) or not isinstance(current, dict) or not isinstance(account, dict):
                raise ValueError
            token = status.get("authToken")
            method = status.get("authMethod")
            if (not isinstance(token, str) or not token.strip()
                    or current.get("authToken") != token or current.get("authMethod") != method):
                raise ValueError
            info = account.get("account")
            if not isinstance(info, dict):
                raise ValueError
            if method == "apikey" and info.get("type") == "apiKey" and expected_account_id is None:
                return {"type": "apiKey", "apiKey": token}
            if method not in {"chatgpt", "chatgptAuthTokens"} or info.get("type") != "chatgpt":
                raise ValueError
            routing = account.get("workspaceRouting")
            account_id = routing.get("chatgptAccountId") if isinstance(routing, dict) else None
            if not isinstance(account_id, str) or not account_id.strip():
                account_id = _account_id_from_token(token)
            if not account_id or (expected_account_id is not None and account_id != expected_account_id):
                raise ValueError
            plan = info.get("planType")
            return {"type": "chatgptAuthTokens", "accessToken": token, "chatgptAccountId": account_id,
                    "chatgptPlanType": plan if isinstance(plan, str) and plan else None}
        except Exception:
            raise RpcError("native_auth_binding_unavailable", "无法确认模型连接的登录状态。") from None
    finally:
        cleanup = asyncio.create_task(host.shutdown())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        try:
            cleanup.result()
        except (Exception, asyncio.CancelledError):
            raise RpcError("native_exit_unconfirmed", "认证连接尚未确认结束。", outcome_unknown=True) from None
        if cancelled:
            raise asyncio.CancelledError
