"""The only business-service boundary: validate an account token and read its subject."""
from __future__ import annotations

import json

import httpx

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, https_origin, owner_key


class AuthClient:
    def __init__(self, config: HostedWorkConfig):
        self.origin = https_origin(config.auth_origin)

    async def login(self, account: str, password: str) -> dict:
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=15) as client:
                async with client.stream("POST", self.origin + "/auth/web/login",
                        json={"account": account, "password": password},
                        headers={"Accept": "application/json"}) as response:
                    if response.status_code in {401, 403}:
                        raise WorkError("invalid_credentials", "账号或密码不正确。", 401)
                    if response.status_code == 429:
                        raise WorkError("login_limited", "登录尝试过于频繁，请稍后重试。", 429)
                    if (response.status_code != 200 or
                            response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json"):
                        raise WorkError("auth_unavailable", "账号登录服务暂不可用。", 503)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 16384:
                            raise ValueError("oversized account response")
            result = json.loads(body)
            token = result.get("access_token") if isinstance(result, dict) else None
            if not isinstance(token, str) or not token or len(token) > 8192:
                raise ValueError("invalid account login response")
            user = result.get("user")
            return {"access_token": token, **({"user": user} if isinstance(user, dict) and isinstance(user.get("id"), str) else {})}
        except (httpx.HTTPError, ValueError) as exc:
            raise WorkError("auth_unavailable", "账号登录服务暂不可用。", 503) from exc

    async def logout(self, token: str) -> None:
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=15) as client:
                response = await client.post(self.origin + "/auth/web/logout", json={},
                    headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
            if response.status_code == 401:
                return
            if (response.status_code != 200 or
                    response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json"):
                raise WorkError("logout_unconfirmed", "退出尚未确认，请稍后重试。", 503)
        except httpx.HTTPError as exc:
            raise WorkError("logout_unconfirmed", "退出尚未确认，请稍后重试。", 503) from exc

    async def identity(self, token: str) -> str:
        if (not isinstance(token, str) or not token or len(token) > 8192
                or not token.isascii() or any(ord(c) < 33 or ord(c) == 127 for c in token)):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        try:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=15) as client:
                async with client.stream("GET", self.origin + "/auth/identity",
                        headers={"Authorization": "Bearer " + token, "Accept": "application/json"}) as response:
                    if response.status_code in {401, 403}:
                        raise WorkError("login_required", "登录已失效，请重新登录。", 401)
                    if (response.status_code != 200 or
                            response.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json"):
                        raise WorkError("auth_unavailable", "在线账号服务暂不可用。", 503)
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 16384:
                            raise WorkError("auth_unavailable", "在线账号服务暂不可用。", 503)
            result = json.loads(body)
            if not isinstance(result, dict) or not isinstance(result.get("account_id"), str):
                raise ValueError("invalid identity response")
            return owner_key(result["account_id"])
        except (httpx.HTTPError, ValueError) as exc:
            raise WorkError("auth_unavailable", "在线账号服务暂不可用。", 503) from exc
