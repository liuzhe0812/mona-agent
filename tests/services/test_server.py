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
async def test_services_health_identifies_stock_capability() -> None:
    response = await handle_services_health(None)
    assert json.loads(response.body) == {
        "status": "ok",
        "service": "mona-services",
        "version": __version__,
        "capabilities": ["stock-v1", "office-editor-v1"],
    }
