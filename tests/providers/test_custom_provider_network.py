from __future__ import annotations

import pytest

from mona.security.network import validate_url_target
from mona.webui import settings_api


def test_private_network_bypass_is_request_scoped() -> None:
    url = "http://172.31.13.189:8080/v1/models"

    blocked, _ = validate_url_target(url)
    allowed, error = validate_url_target(url, allow_private=True)
    metadata_allowed, _ = validate_url_target(
        "http://169.254.169.254/latest/meta-data",
        allow_private=True,
    )

    assert blocked is False
    assert allowed is True
    assert error == ""
    assert metadata_allowed is False


@pytest.mark.asyncio
async def test_custom_provider_probe_allows_private_api_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class Response:
        status_code = 200
        text = '{"data":[{"id":"self-hosted-model"}]}'

        def json(self):
            return {"data": [{"id": "self-hosted-model"}]}

    class Client:
        def __init__(self, *args, **kwargs):
            del args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            del args

        async def get(self, url: str, **kwargs):
            del kwargs
            calls.append(url)
            return Response()

    monkeypatch.setattr(settings_api.httpx, "AsyncClient", Client)

    models = await settings_api.probe_provider_models(
        provider_name="custom",
        api_base="http://172.31.13.189:8080/v1",
    )

    assert models == ["self-hosted-model"]
    assert calls == ["http://172.31.13.189:8080/v1/models"]
