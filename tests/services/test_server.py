import json

import pytest

from mona import __version__
from mona.api.server import handle_health
from mona.services.server import handle_services_health


@pytest.mark.asyncio
async def test_gateway_health_identifies_current_version_and_capabilities() -> None:
    response = await handle_health(None)
    assert json.loads(response.body) == {
        "status": "ok",
        "service": "mona-gateway",
        "version": __version__,
        "capabilities": ["agent-http-v1"],
    }


@pytest.mark.asyncio
async def test_services_health_identifies_stock_vibe_capability() -> None:
    response = await handle_services_health(None)
    assert json.loads(response.body) == {
        "status": "ok",
        "service": "mona-services",
        "version": __version__,
        "capabilities": ["stock-vibe-v1", "office-editor-v1"],
    }


@pytest.mark.asyncio
async def test_services_register_stock_vibe_without_legacy_stock_routes(monkeypatch) -> None:
    import mona.services.server as services

    monkeypatch.setattr(services, "get_services_token", lambda: "test-token")
    monkeypatch.setattr(services.imap_pool_manager, "keepalive", lambda _interval: None)
    monkeypatch.setattr(services._idle_manager, "set_loop", lambda _loop: None)

    app = services.create_services_app()
    paths = {route.resource.canonical for route in app.router.routes()}

    assert any(path == "/api/stock-vibe" or path.startswith("/api/stock-vibe/") for path in paths)
    assert not any(path == "/api/stock" or path.startswith("/api/stock/") for path in paths)
