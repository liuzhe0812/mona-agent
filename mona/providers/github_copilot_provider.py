"""GitHub Copilot OAuth-backed provider."""

from __future__ import annotations

import asyncio
import re
import time
import webbrowser
from collections.abc import Awaitable, Callable
from contextlib import suppress
from urllib.parse import urlsplit
from urllib.parse import urlsplit

import httpx
from oauth_cli_kit.models import OAuthToken
from oauth_cli_kit.storage import FileTokenStorage

from mona.providers.openai_compat_provider import OpenAICompatProvider

DEFAULT_GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code"
DEFAULT_GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
DEFAULT_GITHUB_USER_URL = "https://api.github.com/user"
DEFAULT_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
DEFAULT_COPILOT_BASE_URL = "https://api.githubcopilot.com"
GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98"
GITHUB_COPILOT_SCOPE = "read:user"
TOKEN_FILENAME = "github-copilot.json"
TOKEN_APP_NAME = "mona"
USER_AGENT = "mona/0.1"
EDITOR_VERSION = "vscode/1.99.0"
EDITOR_PLUGIN_VERSION = "copilot-chat/0.26.0"
_EXPIRY_SKEW_SECONDS = 60
_LONG_LIVED_TOKEN_SECONDS = 315360000


def get_storage() -> FileTokenStorage:
    return FileTokenStorage(
        token_filename=TOKEN_FILENAME,
        app_name=TOKEN_APP_NAME,
        import_codex_cli=False,
    )


def _copilot_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"token {token}",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
        "Editor-Version": EDITOR_VERSION,
        "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
    }


def _load_github_token() -> OAuthToken | None:
    token = get_storage().load()
    if not token or not token.access:
        return None
    return token


def github_copilot_authorized() -> bool:
    """Check the saved GitHub session without contacting GitHub or exposing it."""
    try:
        token = _load_github_token()
        return bool(token and token.access and token.expires > time.time() * 1000)
    except (OSError, TypeError, ValueError):
        return False


class CopilotDeviceLoginError(Exception):
    """A bounded, user-facing device-login failure reason."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def _github_verification_url(value: object) -> str:
    if not isinstance(value, str):
        raise CopilotDeviceLoginError("invalid_response")
    try:
        url = urlsplit(value)
        if (
            url.scheme.lower() != "https"
            or url.hostname != "github.com"
            or url.port not in (None, 443)
            or url.username is not None
            or url.password is not None
            or url.path.rstrip("/") != "/login/device"
        ):
            raise CopilotDeviceLoginError("invalid_response")
    except ValueError as exc:
        raise CopilotDeviceLoginError("invalid_response") from exc
    # Return only the known verification page, never arbitrary query parameters.
    return "https://github.com/login/device"


async def request_github_copilot_token(
    on_device_code: Callable[[str, str], None],
) -> OAuthToken:
    """Run the device flow without persisting credentials or opening a browser."""
    timeout = httpx.Timeout(20.0, connect=20.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=True) as client:
        response = await client.post(
            DEFAULT_GITHUB_DEVICE_CODE_URL,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
            data={"client_id": GITHUB_COPILOT_CLIENT_ID, "scope": GITHUB_COPILOT_SCOPE},
        )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise CopilotDeviceLoginError("invalid_response")
        device_code = payload.get("device_code")
        user_code = payload.get("user_code")
        if (
            not isinstance(device_code, str) or not device_code or len(device_code) > 512
            or not isinstance(user_code, str) or not re.fullmatch(r"[A-Za-z0-9]{4}-[A-Za-z0-9]{4}", user_code)
        ):
            raise CopilotDeviceLoginError("invalid_response")
        verification_url = _github_verification_url(
            payload.get("verification_uri") or payload.get("verification_uri_complete")
        )
        try:
            interval = min(60, max(1, int(payload.get("interval") or 5)))
            expires_in = min(3600, max(1, int(payload.get("expires_in") or 900)))
        except (TypeError, ValueError, OverflowError) as exc:
            raise CopilotDeviceLoginError("invalid_response") from exc
        on_device_code(user_code, verification_url)

        deadline = time.monotonic() + expires_in
        access_token = None
        token_expires_in = _LONG_LIVED_TOKEN_SECONDS
        while time.monotonic() < deadline:
            poll = await client.post(
                DEFAULT_GITHUB_ACCESS_TOKEN_URL,
                headers={"Accept": "application/json", "User-Agent": USER_AGENT},
                data={
                    "client_id": GITHUB_COPILOT_CLIENT_ID,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
            )
            poll.raise_for_status()
            result = poll.json()
            if not isinstance(result, dict):
                raise CopilotDeviceLoginError("invalid_response")
            token = result.get("access_token")
            if isinstance(token, str) and token:
                access_token = token
                try:
                    token_expires_in = int(result.get("expires_in") or _LONG_LIVED_TOKEN_SECONDS)
                except (TypeError, ValueError, OverflowError) as exc:
                    raise CopilotDeviceLoginError("invalid_response") from exc
                if token_expires_in <= 0:
                    raise CopilotDeviceLoginError("invalid_response")
                break
            error = result.get("error")
            if error == "expired_token":
                raise CopilotDeviceLoginError("expired")
            if error == "access_denied":
                raise CopilotDeviceLoginError("denied")
            if error == "slow_down":
                interval = min(60, interval + 5)
            elif error not in (None, "authorization_pending"):
                raise CopilotDeviceLoginError("failed")
            await asyncio.sleep(min(interval, max(0, deadline - time.monotonic())))
        if access_token is None:
            raise CopilotDeviceLoginError("expired")

        user = await client.get(
            DEFAULT_GITHUB_USER_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": USER_AGENT,
            },
        )
        user.raise_for_status()
        user_payload = user.json()
        if not isinstance(user_payload, dict):
            raise CopilotDeviceLoginError("invalid_response")
        account_id = user_payload.get("login") or str(user_payload.get("id") or "") or None

    return OAuthToken(
        access=access_token,
        refresh="",
        expires=int((time.time() + token_expires_in) * 1000),
        account_id=str(account_id) if account_id else None,
    )


def login_github_copilot(
    print_fn: Callable[[str], None] | None = None,
    prompt_fn: Callable[[str], str] | None = None,
) -> OAuthToken:
    """Run GitHub device flow and persist the GitHub OAuth token used for Copilot."""
    del prompt_fn
    printer = print_fn or print

    def on_device_code(user_code: str, verification_url: str) -> None:
        printer(f"Open: {verification_url}")
        printer(f"Code: {user_code}")
        with suppress(Exception):
            webbrowser.open(verification_url)

    token = asyncio.run(request_github_copilot_token(on_device_code))
    get_storage().save(token)
    return token


def _copilot_origin(value: str) -> str:
    url = urlsplit(value)
    permitted = {"api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"}
    if (url.scheme != "https" or url.hostname not in permitted or url.port not in {None, 443}
            or url.username is not None or url.password is not None or url.path.rstrip("/") or url.query or url.fragment):
        raise ValueError("GitHub Copilot 账户返回的服务地址无效。")
    return "https://" + url.hostname


class GitHubCopilotProvider(OpenAICompatProvider):
    """Provider that exchanges a stored GitHub OAuth token for Copilot access tokens."""

    def __init__(self, default_model: str = "github-copilot/gpt-4.1", *, api_base: str | None = None,
                 wire_api: str | None = None, model_metadata=None):
        from mona.providers.registry import find_by_name

        self._copilot_access_token: str | None = None
        self._copilot_expires_at: float = 0.0
        self._copilot_base = _copilot_origin(api_base or DEFAULT_COPILOT_BASE_URL)
        self._catalog_api_base = "https://api.individual.githubcopilot.com"
        self._messages_provider = None
        self._messages_model_metadata = model_metadata
        super().__init__(
            api_key="no-key",
            api_base=self._copilot_base,
            default_model=default_model,
            extra_headers={
                "Editor-Version": EDITOR_VERSION,
                "Editor-Plugin-Version": EDITOR_PLUGIN_VERSION,
                "User-Agent": USER_AGENT,
                "Copilot-Integration-Id": "vscode-chat",
            },
            spec=find_by_name("github_copilot"),
            wire_api=wire_api,
            model_metadata=model_metadata,
        )

    async def _get_copilot_access_token(self) -> str:
        now = time.time()
        if self._copilot_access_token and now < self._copilot_expires_at - _EXPIRY_SKEW_SECONDS:
            return self._copilot_access_token

        github_token = _load_github_token()
        if not github_token or not github_token.access:
            raise RuntimeError("GitHub Copilot is not logged in. Sign in from Mona settings.")

        timeout = httpx.Timeout(20.0, connect=20.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=True) as client:
                response = await client.get(DEFAULT_COPILOT_TOKEN_URL, headers=_copilot_headers(github_token.access))
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError):
            raise RuntimeError("无法获取 GitHub Copilot 访问凭据，请确认网络和账户授权。") from None

        token = payload.get("token")
        if not token:
            raise RuntimeError("GitHub Copilot token exchange returned no token.")

        endpoints = payload.get("endpoints")
        if isinstance(endpoints, dict) and isinstance(endpoints.get("api"), str):
            self._copilot_base = _copilot_origin(endpoints["api"])
        expires_at = payload.get("expires_at")
        if isinstance(expires_at, (int, float)):
            self._copilot_expires_at = float(expires_at)
        else:
            refresh_in = payload.get("refresh_in") or 1500
            self._copilot_expires_at = time.time() + int(refresh_in)
        self._copilot_access_token = str(token)
        return self._copilot_access_token

    async def _refresh_client_api_key(self) -> str:
        token = await self._get_copilot_access_token()
        self.api_base = self._effective_base = self._copilot_base
        client = await self._ensure_client()
        self.api_key = token
        client.api_key = token
        client.base_url = self._copilot_base
        return token

    async def catalog_request(self) -> tuple[str, dict[str, str]]:
        token = await self._get_copilot_access_token()
        return self._copilot_base + "/models", {**self.extra_headers, "Authorization": "Bearer " + token, "Accept": "application/json"}

    async def _messages_client(self):
        from mona.providers.anthropic_provider import AnthropicProvider

        token = await self._get_copilot_access_token()
        if self._messages_provider is None:
            connection = self.http_client_factory() if self.http_client_factory else httpx.AsyncClient()
            connection.follow_redirects = False
            self._messages_provider = AnthropicProvider(
                default_model=self.default_model, auth_token=token, api_base=self._copilot_base,
                extra_headers=self.extra_headers, http_client=connection, model_metadata=self._messages_model_metadata,
            )
            self._messages_provider._catalog_api_base = self._catalog_api_base
            self._messages_provider.wire_model_ids = getattr(self, "wire_model_ids", {})
        self._messages_provider.api_base = self._copilot_base
        self._messages_provider._client.base_url = self._copilot_base
        self._messages_provider._client.auth_token = token
        return self._messages_provider

    async def aclose(self) -> None:
        if self._messages_provider is not None:
            await self._messages_provider.aclose()
            self._messages_provider = None
        await super().aclose()

    async def chat(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        tool_choice: str | dict[str, object] | None = None,
    ):
        if self._wire_api == "anthropic-messages":
            call = (await self._messages_client()).chat
        else:
            await self._refresh_client_api_key()
            call = super().chat
        return await call(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            tool_choice=tool_choice,
        )

    async def chat_stream(
        self,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]] | None = None,
        model: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        tool_choice: str | dict[str, object] | None = None,
        on_content_delta: Callable[[str], None] | None = None,
        on_thinking_delta: Callable[[str], Awaitable[None]] | None = None,
        on_tool_call_delta: Callable[[dict[str, object]], Awaitable[None]] | None = None,
    ):
        if self._wire_api == "anthropic-messages":
            call = (await self._messages_client()).chat_stream
        else:
            await self._refresh_client_api_key()
            call = super().chat_stream
        return await call(
            messages=messages,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            tool_choice=tool_choice,
            on_content_delta=on_content_delta,
            on_thinking_delta=on_thinking_delta,
            on_tool_call_delta=on_tool_call_delta,
        )
