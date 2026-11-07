"""Account-bound Codex image provider; not registered as a Work capability.

Only the trusted host may supply the verified admin profile and network client.
This adapter never discovers, copies, or refreshes account credentials.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import re
import stat
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from mona.development.executors.codex_policy import CodexProfile
from mona.hosted_work.admin import CodexAdmin
from mona.providers.image_generation import (
    CodexImageGenerationClient,
    GeneratedImageResponse,
    ImageGenerationError,
)
from mona.utils.artifacts import decode_image_data_url

_BASE = "https://chatgpt.com/backend-api"
_URL = _BASE + "/codex/responses"
_AUTH_MAX_BYTES = 256 * 1024
_TOKEN_PART = re.compile(r"^[A-Za-z0-9_-]+$")
_ACCOUNT = re.compile(r"^[\x21-\x7e]{1,256}$")


@dataclass(frozen=True, repr=False)
class _Auth:
    access: str = field(repr=False)
    account_id: str = field(repr=False)


def _unavailable() -> ImageGenerationError:
    return ImageGenerationError("图片账号尚未就绪，请检查登录状态。", code="IMAGE_PROVIDER_UNAVAILABLE")


def _unknown() -> ImageGenerationError:
    return ImageGenerationError("图片结果待核对，请勿重复生成。", code="result_unknown")


def _verified_auth(admin: CodexAdmin, profile: CodexProfile) -> _Auth:
    """Extract the current access credential from the one trusted CLI home."""
    try:
        if not isinstance(admin, CodexAdmin) or not isinstance(profile, CodexProfile):
            raise ValueError
        home = admin._scoped("development/native/codex")
        marker = admin._scoped("development/native/codex/.mona-native-home")
        path = admin._scoped("development/native/codex/auth.json")
        marker_info = marker.lstat()
        if (not home.is_dir() or home.resolve(strict=True) != home
                or profile.home != home or profile.environment.get("CODEX_HOME") != str(home)
                or not stat.S_ISREG(marker_info.st_mode) or marker_info.st_nlink != 1
                or marker_info.st_size > 128
                or marker.read_text(encoding="utf-8") != "mona-development-codex-v1\n"):
            raise ValueError
        before = path.lstat()
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or not 0 < before.st_size <= _AUTH_MAX_BYTES
                or os.name != "nt" and (stat.S_IMODE(before.st_mode) & 0o077 or before.st_uid != os.geteuid())):
            raise ValueError
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or os.name != "nt" and (stat.S_IMODE(opened.st_mode) & 0o077
                                              or opened.st_uid != os.geteuid())
                    or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
                raise ValueError
            raw = stream.read(_AUTH_MAX_BYTES + 1)
            after = os.fstat(stream.fileno())
        current = path.lstat()
        if ((opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)
                != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
                or os.name != "nt" and (stat.S_IMODE(current.st_mode) & 0o077
                                          or current.st_uid != os.geteuid())
                or len(raw) != opened.st_size or len(raw) > _AUTH_MAX_BYTES
                or admin._scoped("development/native/codex/auth.json") != path):
            raise ValueError
        document = json.loads(raw)
        if not isinstance(document, dict):
            raise ValueError
        # Match Codex's resolved auth mode: legacy files may omit auth_mode,
        # but cannot carry another credential type alongside ChatGPT tokens.
        mode = document.get("auth_mode")
        if (mode is not None and mode != "chatgpt"
                or any(document.get(key) is not None for key in (
                    "OPENAI_API_KEY", "personal_access_token", "agent_identity",
                    "bedrock_api_key", "bedrock_access_keys",
                ))):
            raise ValueError
        tokens = document.get("tokens")
        access = tokens.get("access_token") if isinstance(tokens, dict) else None
        if not isinstance(access, str) or len(access) > 32768:
            raise ValueError
        parts = access.split(".")
        if len(parts) != 3 or any(not _TOKEN_PART.fullmatch(part) for part in parts):
            raise ValueError
        payload = base64.b64decode(parts[1] + "=" * (-len(parts[1]) % 4), altchars=b"-_", validate=True)
        claims = json.loads(payload)
        if not isinstance(claims, dict) or type(claims.get("exp")) is not int or claims["exp"] <= time.time():
            raise ValueError
        auth_claim = claims.get("https://api.openai.com/auth")
        claim_account = auth_claim.get("chatgpt_account_id") if isinstance(auth_claim, dict) else None
        stored_account = tokens.get("account_id")
        if stored_account is not None and claim_account is not None and stored_account != claim_account:
            raise ValueError
        account = stored_account or claim_account
        if not isinstance(account, str) or not _ACCOUNT.fullmatch(account):
            raise ValueError
        return _Auth(access, account)
    except (OSError, ValueError, TypeError, AttributeError, KeyError, binascii.Error):
        raise _unavailable() from None
    except Exception:
        # Scoped-path and profile validation failures must not expose host paths.
        raise _unavailable() from None


def codex_image_ready(admin: CodexAdmin, profile: CodexProfile) -> bool:
    """Check local file scope and expiry only; this cannot verify remote access.

    The caller must supply an admin-verified profile. JWT expiry is decoded
    locally; signature, revocation, model access and image access are not probed.
    """
    try:
        _verified_auth(admin, profile)
        return True
    except ImageGenerationError:
        return False


class HostedCodexImageGenerationClient(CodexImageGenerationClient):
    """Reuse the desktop provider with a fixed endpoint and private CLI identity.

    The caller supplies a client with its trusted network/loopback proxy policy.
    """

    _strict_stream = True

    def __init__(self, *, admin: CodexAdmin, profile: CodexProfile, client: httpx.AsyncClient,
                 max_response_bytes: int = 48 * 1024 * 1024):
        if (not isinstance(admin, CodexAdmin) or not isinstance(profile, CodexProfile)
                or not isinstance(client, httpx.AsyncClient)
                or type(max_response_bytes) is not int or not 0 < max_response_bytes <= 128 * 1024 * 1024):
            raise ValueError("invalid hosted image connection")
        super().__init__(api_key=None, api_base=_BASE, client=client)
        self._admin, self._profile, self._max_response_bytes = admin, profile, max_response_bytes
        self._request_started = False

    @property
    def request_started(self) -> bool:
        """Once set, the upstream outcome must be treated as potentially unknown."""
        return self._request_started

    async def _read_auth(self) -> _Auth:
        return _verified_auth(self._admin, self._profile)

    async def _http_post(self, url: str, *, headers: dict[str, str], body: dict[str, Any]) -> httpx.Response:
        if url != _URL:
            raise _unavailable()
        current = _verified_auth(self._admin, self._profile)
        if (not hmac.compare_digest(headers.get("Authorization", ""), "Bearer " + current.access)
                or not hmac.compare_digest(headers.get("chatgpt-account-id", ""), current.account_id)):
            raise _unavailable()
        try:
            self._request_started = True
            async with self._client.stream("POST", _URL, headers=headers, json=body, follow_redirects=False) as reply:
                if not 200 <= reply.status_code < 300:
                    raise _unknown()
                declared = reply.headers.get("Content-Length")
                if declared is not None and (not declared.isdecimal() or int(declared) > self._max_response_bytes):
                    raise _unknown()
                data = bytearray()
                async for chunk in reply.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > self._max_response_bytes:
                        raise _unknown()
            # Do not retain authentication headers in an exception or response.
            return httpx.Response(200, content=bytes(data), request=httpx.Request("POST", _URL))
        except ImageGenerationError:
            raise
        except Exception:
            raise _unknown() from None

    async def generate(self, *, prompt: str, model: str, reference_images: list[str] | None = None,
                       aspect_ratio: str | None = None, image_size: str | None = None) -> GeneratedImageResponse:
        if reference_images:
            raise ImageGenerationError("当前图片来源不支持所选参考图编辑。", code="REFERENCE_IMAGE_UNSUPPORTED")
        try:
            result = await super().generate(prompt=prompt, model=model, reference_images=None,
                                            aspect_ratio=aspect_ratio, image_size=image_size)
            if len(result.images) != 1:
                raise _unknown()
            image, mime = decode_image_data_url(result.images[0])
            if not image or len(image) > self._max_response_bytes:
                raise _unknown()
            data_url = f"data:{mime};base64," + base64.b64encode(image).decode("ascii")
        except ImageGenerationError as exc:
            if exc.code in {"IMAGE_PROVIDER_UNAVAILABLE", "UNSUPPORTED_IMAGE_SIZE"}:
                raise
            raise _unknown() from None
        except Exception:
            raise _unknown() from None
        # Neither text from the upstream nor its untrusted raw frames is exposed.
        return GeneratedImageResponse(images=[data_url], content="", raw={"status": "completed"})
