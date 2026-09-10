from typing import Any


def subscription_period_days(
    *,
    plan_id: str | None,
    duration_months: int | None,
    configured_days: int | None = None,
) -> int:
    if configured_days is not None and configured_days > 0:
        return configured_days
    standard_days = {"monthly": 30, "quarterly": 90, "yearly": 365}
    if plan_id in standard_days:
        return standard_days[plan_id]
    return max(1, duration_months or 1) * 30


def effective_plan_period_days(plan: Any) -> int:
    return subscription_period_days(
        plan_id=getattr(plan, "id", None),
        duration_months=getattr(plan, "duration_months", None),
        configured_days=getattr(plan, "period_days", None),
    )
