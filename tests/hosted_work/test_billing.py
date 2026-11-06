"""Offline checks for the Work billing contract and token-price calculations."""
import json

import httpx
import pytest

from mona.config.schema import HostedWorkConfig, HostedWorkModel, HostedWorkPrice
from mona.hosted_work.billing import (
    BillingError,
    HostedBilling,
    actual_units,
    reservation_units,
    settlement_usage,
)

RUN_ID = "a" * 32
TOKEN = "test-website-session"
KEY = "test-service-key-" + "k" * 32
PREFIX = "/auth/internal/hosted-work/billing"


def model(input_price="2", cached_price="0.1", output_price="10"):
    return HostedWorkModel(
        label="Codex", source="codex", model="test-model", billing_mode="wallet", max_output_tokens=4096,
        price=HostedWorkPrice(input_amount_per_million=input_price,
                              cached_input_amount_per_million=cached_price,
                              output_amount_per_million=output_price),
    )


def client(monkeypatch, handler):
    monkeypatch.setenv("MONA_WORK_BILLING_TEST", KEY)
    config = HostedWorkConfig(auth_origin="https://auth.example.test", billing_key_env="MONA_WORK_BILLING_TEST")
    return HostedBilling(config, transport=httpx.MockTransport(handler))


def reply(status="reserved", *, run_id=RUN_ID, reserved=123, actual=None):
    return {"run_id": run_id, "status": status, "reserved_units": reserved, "actual_units": actual}


@pytest.mark.asyncio
async def test_reserve_binds_website_session_and_later_calls_use_only_service_key(monkeypatch):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append((request.method, request.url.path, dict(request.headers), body))
        status = {"reserve": "reserved", "dispatch": "running", "settle": "settled",
                  "uncertain": "uncertain", "release": "released"}[request.url.path.rsplit("/", 1)[-1]]
        return httpx.Response(200, json=reply(status, actual=7 if status == "settled" else None))

    billing = client(monkeypatch, handler)
    selected = model()
    usage = {"input_tokens": 12, "cached_input_tokens": 3, "output_tokens": 4}
    await billing.reserve(RUN_ID, TOKEN, selected)
    await billing.dispatch(RUN_ID)
    await billing.settle(RUN_ID, usage)
    await billing.uncertain(RUN_ID, "usage_unavailable")
    await billing.release(RUN_ID)

    assert [(method, path) for method, path, _, _ in seen] == [
        ("POST", PREFIX + "/reserve"), ("POST", f"{PREFIX}/{RUN_ID}/dispatch"),
        ("POST", f"{PREFIX}/{RUN_ID}/settle"), ("POST", f"{PREFIX}/{RUN_ID}/uncertain"),
        ("POST", f"{PREFIX}/{RUN_ID}/release"),
    ]
    assert all(headers["x-hosted-work-key"] == KEY for _, _, headers, _ in seen)
    assert seen[0][2]["authorization"] == "Bearer " + TOKEN
    assert all("authorization" not in headers for _, _, headers, _ in seen[1:])
    assert seen[0][3] == {"run_id": RUN_ID, "model": "test-model", "reserve_units": 106496,
                          "price": selected.price.model_dump()}
    assert [body for _, _, _, body in seen[1:]] == [{}, {"usage": usage}, {"reason": "usage_unavailable"}, {}]


@pytest.mark.asyncio
@pytest.mark.parametrize("first_failure", ["timeout", "server_error"])
async def test_retry_reuses_same_run_and_request_after_uncertain_response(monkeypatch, first_failure):
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url), dict(request.headers), request.content))
        if len(seen) == 1:
            if first_failure == "timeout":
                raise httpx.ReadTimeout("test timeout", request=request)
            return httpx.Response(503)
        return httpx.Response(200, json=reply())

    result = await client(monkeypatch, handler).reserve(RUN_ID, TOKEN, model())
    assert result["status"] == "reserved"
    assert len(seen) == 2 and seen[0] == seen[1]


@pytest.mark.asyncio
async def test_unconfirmed_retry_is_not_a_rejected_or_free_request(monkeypatch):
    attempts = 0

    def handler(request):
        nonlocal attempts
        attempts += 1
        raise httpx.ReadTimeout("test timeout", request=request)

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, handler).dispatch(RUN_ID)
    assert attempts == 2
    assert error.value.code == "billing_unknown" and error.value.rejected is False


@pytest.mark.asyncio
async def test_insufficient_balance_is_a_confirmed_rejection_without_retry(monkeypatch):
    attempts = 0

    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(402)

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, handler).reserve(RUN_ID, TOKEN, model())
    assert attempts == 1
    assert error.value.code == "insufficient_balance" and error.value.status == 402 and error.value.rejected is True


@pytest.mark.asyncio
@pytest.mark.parametrize("first_failure", ["timeout", "server_error"])
@pytest.mark.parametrize("retry_status", [401, 402, 422, 404])
async def test_rejection_after_ambiguous_reserve_does_not_confirm_no_charge(monkeypatch, first_failure, retry_status):
    requests = []

    def handler(request):
        requests.append((request.method, str(request.url), dict(request.headers), request.content))
        if len(requests) == 1:
            if first_failure == "timeout":
                raise httpx.ReadTimeout("test timeout", request=request)
            return httpx.Response(503)
        return httpx.Response(retry_status)

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, handler).reserve(RUN_ID, TOKEN, model())
    assert len(requests) == 2 and requests[0] == requests[1]
    assert error.value.status == retry_status and error.value.rejected is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 402, 422, 404])
async def test_first_reserve_rejection_is_confirmed_without_retry(monkeypatch, status):
    attempts = 0

    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(status)

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, handler).reserve(RUN_ID, TOKEN, model())
    assert attempts == 1
    assert error.value.status == status and error.value.rejected is True


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", [
    reply(run_id="b" * 32), reply(status="finished"), reply(reserved=-1),
    reply(reserved=True), reply(status="settled", actual=True),
])
async def test_invalid_or_mismatched_status_receipts_remain_unknown(monkeypatch, invalid):
    attempts = 0

    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(200, json=invalid)

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, handler).dispatch(RUN_ID)
    assert attempts == 2
    assert error.value.code == "billing_unknown" and error.value.rejected is False


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_actual", [True, False])
async def test_settled_receipt_requires_an_actual_amount(monkeypatch, missing_actual):
    value = reply("settled")
    if missing_actual:
        value.pop("actual_units")

    with pytest.raises(BillingError) as error:
        await client(monkeypatch, lambda _request: httpx.Response(200, json=value)).settle(RUN_ID, {
            "input_tokens": 3, "cached_input_tokens": 1, "output_tokens": 1,
        })
    assert error.value.code == "billing_unknown" and error.value.rejected is False


def test_amounts_round_each_category_up_and_hold_uses_larger_input_rate():
    fractional = model("0.1", "0.2", "0.3")
    assert actual_units(fractional, {"input_tokens": 5, "cached_input_tokens": 2, "output_tokens": 3}) == 3
    assert reservation_units(model("2", "3", "10")) == 139264
    assert reservation_units(model("0", "0", "0")) == 0
    missing = model().model_copy(update={"price": None})
    with pytest.raises(BillingError) as error:
        reservation_units(missing)
    assert error.value.code == "price_unavailable" and error.value.rejected is True


@pytest.mark.parametrize("receipt", [
    None, {}, {"complete": False, "prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": 2},
    {"complete": 1, "prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": 2},
    {"complete": True, "prompt_tokens": 8, "cached_tokens": 1},
    {"complete": True, "prompt_tokens": True, "cached_tokens": 0, "completion_tokens": 2},
    {"complete": True, "prompt_tokens": 8, "cached_tokens": -1, "completion_tokens": 2},
    {"complete": True, "prompt_tokens": 8, "cached_tokens": 9, "completion_tokens": 2},
    {"complete": True, "prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": "2"},
])
def test_missing_or_invalid_usage_is_not_settled(receipt):
    assert settlement_usage(receipt) is None


def test_complete_usage_maps_to_the_accounting_contract_including_zero():
    assert settlement_usage({"complete": True, "prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": 2}) == {
        "input_tokens": 8, "cached_input_tokens": 1, "output_tokens": 2,
    }
    assert settlement_usage({"complete": True, "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0}) == {
        "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0,
    }
