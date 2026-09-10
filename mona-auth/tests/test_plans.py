from types import SimpleNamespace

from app.plans import effective_plan_period_days, subscription_period_days


def test_standard_plan_periods_match_product_labels_when_database_value_is_missing():
    assert subscription_period_days(plan_id="monthly", duration_months=1) == 30
    assert subscription_period_days(plan_id="quarterly", duration_months=3) == 90
    assert subscription_period_days(plan_id="yearly", duration_months=12) == 365


def test_explicit_period_days_take_precedence():
    plan = SimpleNamespace(id="yearly", duration_months=12, period_days=366)
    assert effective_plan_period_days(plan) == 366
