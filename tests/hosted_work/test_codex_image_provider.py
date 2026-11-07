"""Local-only checks for the account-bound Codex image adapter."""
import base64
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from loguru import logger

from mona.config.schema import HostedCodexSettings
from mona.hosted_work.admin import CodexAdmin
from mona.hosted_work.codex_image_provider import (
    HostedCodexImageGenerationClient,
    codex_image_ready,
)
from mona.providers.image_generation import ImageGenerationError

_ACCOUNT = "test-account"
_REFRESH = "test-refresh-never-read-or-copied"
_PIXEL = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91Jpz"
          "AAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==")


def token(*, expired=False, account=_ACCOUNT):
    body = {"exp": int(time.time()) + (-60 if expired else 3600),
            "https://api.openai.com/auth": {"chatgpt_account_id": account}}
    payload = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")
    return f"testheader.{payload}.testsignature"


def write_auth(path: Path, access: str, account=_ACCOUNT):
    path.write_text(json.dumps({"tokens": {"access_token": access, "account_id": account,
                                           "refresh_token": _REFRESH}}), encoding="utf-8")
    path.chmod(0o600)


@pytest.fixture
def account(tmp_path, monkeypatch):
    operator = tmp_path / "operator.json"
    operator.write_text("{}", encoding="utf-8")
    executable = Path(sys.executable).resolve()
    monkeypatch.setattr("mona.development.executors.discovery.resolve_executable",
                        lambda *_args: (executable, None))
    admin = CodexAdmin(operator)
    profile = admin.profile(HostedCodexSettings(cli_path=str(executable)))
    path = profile.home / "auth.json"
    access = token()
    write_auth(path, access)
    return admin, profile, path, access


def event(value):
    return "data: " + json.dumps(value) + "\n\n"


def completed_stream():
    return (event({"type": "response.output_item.done",
                   "item": {"type": "image_generation_call", "result": _PIXEL}})
            + event({"type": "response.completed", "response": {"status": "completed"}})
            + "data: [DONE]\n\n")


@pytest.mark.asyncio
async def test_uses_only_verified_account_and_fixed_endpoint(account, monkeypatch):
    from types import ModuleType

    admin, profile, path, access = account
    original = path.read_bytes()
    requests, forbidden_calls = [], []
    def respond(request):
        assert adapter.request_started is True
        requests.append(request)
        return httpx.Response(200, text=completed_stream())
    def forbidden(*_args, **_kwargs):
        forbidden_calls.append(True)
        raise AssertionError("must not use the desktop credential store")
    desktop_auth = ModuleType("oauth_cli_kit")
    desktop_auth.get_token = forbidden
    monkeypatch.setitem(sys.modules, "oauth_cli_kit", desktop_auth)
    monkeypatch.setattr(admin, "profile", forbidden)
    monkeypatch.setenv("OAUTH_CLI_KIT_TOKEN_PATH", "must-not-be-used")
    assert codex_image_ready(admin, profile)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False) as client:
        adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client)
        assert adapter.request_started is False
        result = await adapter.generate(prompt="draw", model="fixture-model")
        assert adapter.request_started is True
        with pytest.raises(AttributeError):
            adapter.request_started = False
    assert len(requests) == 1 and not forbidden_calls
    assert str(requests[0].url) == "https://chatgpt.com/backend-api/codex/responses"
    assert requests[0].headers["Authorization"] == "Bearer " + access
    assert requests[0].headers["chatgpt-account-id"] == _ACCOUNT
    assert result.images == [_PIXEL] and result.content == "" and result.raw == {"status": "completed"}
    assert access not in repr(result) and _REFRESH not in repr(result)
    assert path.read_bytes() == original and sorted(item.name for item in profile.home.iterdir()) == [
        ".mona-native-home", "auth.json"
    ]


@pytest.mark.asyncio
async def test_unavailable_auth_fails_before_network_and_does_not_use_a_default_account(account, monkeypatch):
    admin, profile, path, _ = account
    attempts = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: attempts.append(request)),
                                 trust_env=False) as client:
        adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client)
        assert adapter.request_started is False
        for access in (token(expired=True), "not-a-token"):
            write_auth(path, access)
            assert not codex_image_ready(admin, profile)
            with pytest.raises(ImageGenerationError) as error:
                await adapter.generate(prompt="draw", model="fixture-model")
            assert error.value.code == "IMAGE_PROVIDER_UNAVAILABLE"
            assert access not in str(error.value)
            assert adapter.request_started is False
        path.unlink()
        monkeypatch.setenv("CODEX_HOME", str(path.parent.parent / "personal"))
        assert not codex_image_ready(admin, profile)
        with pytest.raises(ImageGenerationError) as error:
            await adapter.generate(prompt="draw", model="fixture-model")
        assert error.value.code == "IMAGE_PROVIDER_UNAVAILABLE"
        assert adapter.request_started is False
    assert attempts == []


def test_profile_and_account_mismatch_fail_closed(account):
    admin, profile, path, access = account
    assert not codex_image_ready(admin, replace(profile, home=profile.home.parent))
    assert not codex_image_ready(admin, replace(profile, environment={"CODEX_HOME": str(profile.home.parent)}))
    write_auth(path, access, account="different-account")
    assert not codex_image_ready(admin, profile)
    if os.name != "nt":
        write_auth(path, access)
        path.chmod(0o644)
        assert not codex_image_ready(admin, profile)


@pytest.mark.parametrize("mode", [None, "chatgpt"])
def test_chatgpt_or_unambiguous_legacy_auth_mode_is_ready(account, mode):
    admin, profile, path, _ = account
    document = json.loads(path.read_text(encoding="utf-8"))
    document["auth_mode"] = mode
    # The CLI can serialize absent optional credential types as null.
    document["OPENAI_API_KEY"] = None
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(0o600)
    assert codex_image_ready(admin, profile)


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"auth_mode": "apikey"}, {"auth_mode": "chatgptAuthTokens"},
    {"auth_mode": "agentIdentity"}, {"auth_mode": "personalAccessToken"},
    {"auth_mode": "bedrockApiKey"}, {"auth_mode": "bedrockAccessKeys"},
    {"auth_mode": "unknown"}, {"auth_mode": 0},
    {"OPENAI_API_KEY": ""}, {"personal_access_token": "other"},
    {"agent_identity": {}}, {"bedrock_api_key": {}}, {"bedrock_access_keys": {}},
    {"auth_mode": "chatgpt", "OPENAI_API_KEY": "other"},
])
async def test_non_chatgpt_or_mixed_auth_is_unavailable_before_dispatch(account, extra):
    admin, profile, path, _ = account
    document = json.loads(path.read_text(encoding="utf-8"))
    document.update(extra)
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(0o600)
    before = path.read_bytes()
    attempts = []
    assert not codex_image_ready(admin, profile)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: attempts.append(request)),
                                 trust_env=False) as client:
        adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client)
        with pytest.raises(ImageGenerationError) as error:
            await adapter.generate(prompt="draw", model="fixture-model")
        assert adapter.request_started is False
    assert error.value.code == "IMAGE_PROVIDER_UNAVAILABLE" and not attempts
    assert path.read_bytes() == before


def test_auth_file_cannot_be_hardlinked(account, tmp_path):
    admin, profile, path, _ = account
    other = tmp_path / "other-auth"
    os.link(path, other)
    try:
        assert not codex_image_ready(admin, profile)
    finally:
        other.unlink()


def test_linked_account_directory_is_not_accepted(account):
    admin, profile, _path, _ = account
    home = profile.home
    backup = home.with_name("account-backup")
    home.rename(backup)
    linked = False
    try:
        try:
            home.symlink_to(backup, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                pytest.skip("directory links unavailable")
            import _winapi
            _winapi.CreateJunction(str(backup), str(home))
        linked = True
        assert not codex_image_ready(admin, profile)
    finally:
        if linked:
            if os.name == "nt":
                os.rmdir(home)
            else:
                home.unlink()
        backup.rename(home)


@pytest.mark.asyncio
async def test_changed_account_or_reference_image_is_rejected_before_request(account, monkeypatch):
    admin, profile, path, _ = account
    attempts = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: attempts.append(request)),
                                 trust_env=False) as client:
        adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client)
        original = adapter._read_auth
        async def switched():
            old = await original()
            write_auth(path, token(account="another"), account="another")
            return old
        monkeypatch.setattr(adapter, "_read_auth", switched)
        with pytest.raises(ImageGenerationError) as changed:
            await adapter.generate(prompt="draw", model="fixture-model")
        assert changed.value.code == "IMAGE_PROVIDER_UNAVAILABLE"
        with pytest.raises(ImageGenerationError) as reference:
            await adapter.generate(prompt="edit", model="fixture-model", reference_images=["/workspace/a.png"])
        assert reference.value.code == "REFERENCE_IMAGE_UNSUPPORTED"
        assert adapter.request_started is False
    assert attempts == []


@pytest.mark.asyncio
async def test_unsupported_size_does_not_mark_request_started(account):
    admin, profile, _, _ = account
    attempts = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: attempts.append(request)),
                                 trust_env=False) as client:
        adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client)
        with pytest.raises(ImageGenerationError) as error:
            await adapter.generate(prompt="draw", model="fixture-model", image_size="2K")
        assert error.value.code == "UNSUPPORTED_IMAGE_SIZE"
        assert adapter.request_started is False
    assert attempts == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["http", "redirect", "failed", "incomplete", "truncated", "too_large", "multiple"])
async def test_unconfirmed_response_is_redacted_and_never_retried(account, kind):
    admin, profile, _path, access = account
    secret = "upstream-error-do-not-log"
    calls, logs = [], []
    def respond(request):
        assert adapter.request_started is True
        calls.append(request)
        if kind == "http":
            return httpx.Response(500, text=secret)
        if kind == "redirect":
            return httpx.Response(302, headers={"Location": "https://example.test/"}, text=secret)
        if kind == "too_large":
            return httpx.Response(200, content=b"x" * 5000)
        if kind == "truncated":
            return httpx.Response(200, text=event({"type": "response.output_item.done",
                                                   "item": {"type": "image_generation_call", "result": _PIXEL}}))
        if kind == "multiple":
            return httpx.Response(200, text=event({"type": "response.output_item.done",
                "item": {"type": "image_generation_call", "result": _PIXEL}}) + completed_stream())
        name = "response.failed" if kind == "failed" else "response.incomplete"
        return httpx.Response(200, text=event({"type": name, "error": {"message": secret + access}}))
    sink = logger.add(lambda message: logs.append(str(message)))
    try:
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond), trust_env=False,
                                     follow_redirects=True) as client:
            adapter = HostedCodexImageGenerationClient(admin=admin, profile=profile, client=client,
                                                        max_response_bytes=4096)
            with pytest.raises(ImageGenerationError) as error:
                await adapter.generate(prompt="draw", model="fixture-model")
            assert adapter.request_started is True
    finally:
        logger.remove(sink)
    assert error.value.code == "result_unknown" and error.value.retry_safe is False
    assert len(calls) == 1 and secret not in str(error.value) and access not in str(error.value)
    assert secret not in "".join(logs) and access not in "".join(logs)
