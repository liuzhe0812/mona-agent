from __future__ import annotations

import math
import time

from pydantic import ConfigDict, Field

from mona.development.contracts import Contract


class UsageWindow(Contract):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)
    used_percent: float = Field(strict=True)
    window_duration_mins: int | None = None
    resets_at: int | None = None


class UsageCredits(Contract):
    model_config = ConfigDict(extra="ignore")
    balance: str | None = None
    has_credits: bool
    unlimited: bool


class UsageLimit(Contract):
    model_config = ConfigDict(extra="ignore")
    limit_id: str | None = None
    limit_name: str | None = None
    primary: UsageWindow | None = None
    secondary: UsageWindow | None = None


class AccountUsage(Contract):
    revision: int = 0
    connected: bool = False
    account_key: str | None = None
    email: str | None = None
    plan_type: str | None = None
    limits: list[UsageLimit] = Field(default_factory=list)
    credits: UsageCredits | None = None
    available_resets: int | None = None
    reset_credits_expire_at: int | None = None
    rate_limit_reached_type: str | None = None
    fetched_at: int | None = None
    error: str | None = None


def account_identity(reply: dict) -> AccountUsage:
    account = reply.get("account")
    if not isinstance(account, dict) or account.get("type") != "chatgpt":
        return AccountUsage()
    routing = reply.get("workspaceRouting")
    account_id = routing.get("chatgptAccountId") if isinstance(routing, dict) else None
    return AccountUsage(connected=True,
        account_key=account_id if isinstance(account_id, str) else account.get("email") if isinstance(account.get("email"), str) else None,
        email=account.get("email") if isinstance(account.get("email"), str) else None,
        plan_type=account.get("planType") if isinstance(account.get("planType"), str) else None)


def _stale_bucket(bucket: dict, now_ms: float) -> bool:
    windows = [bucket[key] for key in ("primary", "secondary") if isinstance(bucket.get(key), dict)]
    resets = [window.get("resetsAt") for window in windows]
    return bool(resets) and all(type(value) in (int, float) and math.isfinite(value) and value > 0 for value in resets) and max(resets) * 1000 + 86_400_000 < now_ms


def with_usage(identity: AccountUsage, reply: dict) -> AccountUsage:
    legacy = reply.get("rateLimits")
    buckets = reply.get("rateLimitsByLimitId")
    selected = None
    now_ms = time.time() * 1000
    # Display account-wide limits, excluding model-specific pools.
    if isinstance(buckets, dict):
        selected = next((buckets[key] for key in ("codex", "__default__")
            if isinstance(buckets.get(key), dict) and not _stale_bucket(buckets[key], now_ms)), None)
    elif isinstance(legacy, dict):
        if legacy.get("limitId") in {None, "", "codex", "__default__"} and not _stale_bucket(legacy, now_ms):
            selected = legacy
    else:
        raise ValueError("missing usage snapshot")
    limits = [UsageLimit.model_validate({**selected, "limitId": selected.get("limitId") or "codex"})] if selected is not None else []
    snapshots = ([legacy] if isinstance(legacy, dict) else []) + (
        [value for value in buckets.values() if isinstance(value, dict)] if isinstance(buckets, dict) else [])
    credit = next((value["credits"] for value in snapshots if isinstance(value.get("credits"), dict)), None)
    plan = next((value for value in [identity.plan_type, (selected or {}).get("planType"), (legacy if isinstance(legacy, dict) else {}).get("planType")]
                 if isinstance(value, str) and value.strip() and value.lower() != "unknown"), None)
    reset = reply.get("rateLimitResetCredits")
    reset_count = reset.get("availableCount") if isinstance(reset, dict) else None
    details = reset.get("credits") if isinstance(reset, dict) else None
    expiries = [credit["expiresAt"] for credit in details if isinstance(credit, dict)
                and credit.get("status") == "available" and type(credit.get("expiresAt")) is int and credit["expiresAt"] > 0] if isinstance(details, list) else []
    return identity.model_copy(update={
        "limits": limits,
        "plan_type": plan,
        "credits": UsageCredits.model_validate(credit) if isinstance(credit, dict) else None,
        "available_resets": reset_count if type(reset_count) is int and reset_count >= 0 else None,
        "reset_credits_expire_at": min(expiries) if expiries else None,
        "rate_limit_reached_type": selected.get("rateLimitReachedType") if selected and isinstance(selected.get("rateLimitReachedType"), str) else None,
        "fetched_at": int(now_ms),
    })
