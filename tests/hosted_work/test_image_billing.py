"""Image billing is separate from text usage and requires explicit pricing."""
import httpx
import pytest

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.billing import BillingError
from mona.hosted_work.image_billing import HostedImageBilling


@pytest.mark.asyncio
async def test_image_billing_uses_per_image_price_and_verifies_settlement(monkeypatch):
    monkeypatch.setenv("MONA_WORK_BILLING_TEST_KEY", "x" * 32)
    config = HostedWorkConfig(auth_origin="https://auth.example.test", billing_key_env="MONA_WORK_BILLING_TEST_KEY")
    image = HostedWorkImageSettings(model="gpt-image-test", price=HostedWorkImagePrice(amount_per_image="0.000004"))
    seen = []
    def reply(request):
        seen.append(request)
        actual = 4 if request.url.path.endswith("/settle") else None
        return httpx.Response(200, json={"run_id": "a" * 32, "status": "settled" if actual else "reserved",
                                          "reserved_units": 4, "actual_units": actual})
    bridge = HostedImageBilling(config, transport=httpx.MockTransport(reply))
    await bridge.reserve_image("a" * 32, "account-token", image)
    await bridge.settle_image("a" * 32, image, {"sha256": "b" * 64, "image_count": 1})
    assert seen[0].url.path.endswith("/image/reserve") and seen[1].url.path.endswith("/image/" + "a" * 32 + "/settle")
    assert seen[0].headers["Authorization"] == "Bearer account-token"
    assert b"token" not in seen[0].content and b"amount_per_image" in seen[0].content


@pytest.mark.asyncio
async def test_image_billing_does_not_assume_missing_prices_are_free(monkeypatch):
    monkeypatch.setenv("MONA_WORK_BILLING_TEST_KEY", "x" * 32)
    config = HostedWorkConfig(auth_origin="https://auth.example.test", billing_key_env="MONA_WORK_BILLING_TEST_KEY")
    with pytest.raises(BillingError) as error:
        await HostedImageBilling(config).reserve_image("a" * 32, "account-token", HostedWorkImageSettings())
    assert error.value.code == "price_unavailable" and error.value.rejected
