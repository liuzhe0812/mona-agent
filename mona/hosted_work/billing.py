"""Trusted Work-to-Auth billing; credentials never enter a model sandbox."""
from __future__ import annotations

import hashlib
import os
import re
from decimal import ROUND_CEILING, Decimal

import httpx

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import WorkError, https_origin, identifier

_PREFIX = "/auth/internal/hosted-work/billing"
_FIELDS = ("input_amount_per_million", "cached_input_amount_per_million", "output_amount_per_million")
_STATES = frozenset({"reserved", "running", "settled", "released", "uncertain"})


def charge_id(owner: str, run_id: str) -> str:
    identifier(run_id)
    if not isinstance(owner, str) or not re.fullmatch(r"[a-f0-9]{64}", owner):
        raise ValueError("invalid billing owner")
    return hashlib.sha256(("mona-hosted-billing-v1:" + owner + ":" + run_id).encode()).hexdigest()[:32]


class BillingError(WorkError):
    def __init__(self, code: str, message: str, status: int, *, rejected: bool = False):
        super().__init__(code, message, status)
        self.rejected = rejected


def reservation_units(model: HostedWorkModel) -> int:
    if model.price is None:
        raise BillingError("price_unavailable", "此模型尚未配置价格，暂不能使用。", 503, rejected=True)
    price = model.price.model_dump()
    # This is a reversible initial hold, not a model context-window limit.
    input_price = max(Decimal(price[_FIELDS[0]]), Decimal(price[_FIELDS[1]]))
    amount = input_price * 32768 + Decimal(price[_FIELDS[2]]) * model.max_output_tokens
    return int(amount.to_integral_value(rounding=ROUND_CEILING))


def actual_units(model: HostedWorkModel, usage: dict[str, int]) -> int:
    if model.price is None:
        raise ValueError("missing model price")
    price = model.price.model_dump()
    amounts = ((usage["input_tokens"] - usage["cached_input_tokens"], price[_FIELDS[0]]),
               (usage["cached_input_tokens"], price[_FIELDS[1]]),
               (usage["output_tokens"], price[_FIELDS[2]]))
    return sum(int((Decimal(tokens) * Decimal(rate)).to_integral_value(rounding=ROUND_CEILING))
               for tokens, rate in amounts)


def settlement_usage(receipt: object) -> dict[str, int] | None:
    if not isinstance(receipt, dict) or receipt.get("complete") is not True:
        return None
    keys = {"input_tokens": "prompt_tokens", "cached_input_tokens": "cached_tokens", "output_tokens": "completion_tokens"}
    values = {key: receipt.get(source) for key, source in keys.items()}
    if (any(type(value) is not int or value < 0 for value in values.values())
            or values["cached_input_tokens"] > values["input_tokens"]):
        return None
    return values


class HostedBilling:
    def __init__(self, config: HostedWorkConfig, *, transport=None):
        self.origin = https_origin(config.auth_origin)
        self.key = os.environ.get(config.billing_key_env, "") if config.billing_key_env else ""
        if (len(self.key) < 32 or len(self.key) > 8192 or not self.key.isascii()
                or any(ord(char) < 33 or ord(char) == 127 for char in self.key)):
            raise BillingError("billing_unavailable", "余额计费暂不可用，请稍后重试。", 503, rejected=True)
        self.transport = transport

    async def _request(self, method: str, path: str, run_id: str, *, body=None, token: str | None = None) -> dict:
        identifier(run_id)
        headers = {"Accept": "application/json", "X-Hosted-Work-Key": self.key}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        ambiguous = False
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(transport=self.transport, trust_env=False, follow_redirects=False,
                                             timeout=15) as client:
                    response = await client.request(method, self.origin + path, headers=headers, json=body)
                if response.status_code >= 500 and attempt == 0:
                    ambiguous = True
                    continue
                if response.status_code == 402:
                    raise BillingError("insufficient_balance", "账号余额不足，请充值后重试。", 402, rejected=not ambiguous)
                if response.status_code == 404:
                    raise BillingError("billing_not_found", "计费记录不存在，请核对后继续。", 404, rejected=not ambiguous)
                if response.status_code in {401, 403, 422}:
                    raise BillingError("billing_rejected", "账号或计费配置未通过验证，请检查后重试。",
                                       response.status_code, rejected=not ambiguous)
                if response.status_code != 200 or len(response.content) > 16384:
                    raise BillingError("billing_unknown", "计费状态尚未确认，请核对后继续。", 503)
                value = response.json()
                if (not isinstance(value, dict) or value.get("run_id") != run_id or value.get("status") not in _STATES
                        or type(value.get("reserved_units")) is not int or value["reserved_units"] < 0
                        or value.get("actual_units") is not None and
                        (type(value["actual_units"]) is not int or value["actual_units"] < 0)
                        or value.get("status") == "settled" and type(value.get("actual_units")) is not int):
                    raise ValueError("invalid billing response")
                return value
            except (httpx.HTTPError, ValueError):
                if attempt == 0:
                    ambiguous = True
                    continue
                raise BillingError("billing_unknown", "计费状态尚未确认，请核对后继续。", 503) from None
        raise BillingError("billing_unknown", "计费状态尚未确认，请核对后继续。", 503)

    async def reserve(self, run_id: str, token: str, model: HostedWorkModel) -> dict:
        return await self._request("POST", _PREFIX + "/reserve", run_id, token=token, body={
            "run_id": run_id, "model": model.model, "reserve_units": reservation_units(model),
            "price": model.price.model_dump(),
        })

    async def get(self, run_id: str) -> dict:
        return await self._request("GET", f"{_PREFIX}/{run_id}", run_id)

    async def dispatch(self, run_id: str) -> dict:
        return await self._request("POST", f"{_PREFIX}/{run_id}/dispatch", run_id, body={})

    async def settle(self, run_id: str, usage: dict) -> dict:
        return await self._request("POST", f"{_PREFIX}/{run_id}/settle", run_id, body={"usage": usage})

    async def uncertain(self, run_id: str, reason: str) -> dict:
        return await self._request("POST", f"{_PREFIX}/{run_id}/uncertain", run_id, body={"reason": reason})

    async def release(self, run_id: str) -> dict:
        return await self._request("POST", f"{_PREFIX}/{run_id}/release", run_id, body={})
