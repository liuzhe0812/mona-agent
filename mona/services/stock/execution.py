"""Deterministic A-share execution and direction-aware plan materialization."""

from __future__ import annotations

import math
from datetime import datetime
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from typing import Any, Literal, Mapping

from mona.services.stock.schemas import (
    V5PositionPlan,
    V5TradingPlan,
    V6CostAssumptions,
    V6CurrentAction,
    V6Direction,
    V6ExecutionAssessment,
    V6ExecutionFacts,
    V6ExecutionStatus,
    V6HoldingState,
    V6MaterializedTradingPlan,
    V6PortfolioContext,
    V6RiskProfile,
    V6RuleStatus,
)

EXECUTION_METHOD_VERSION = "a-share-execution-constraints-v1"
SLIPPAGE_METHOD_VERSION = "turnover-amount-atr-proxy-v1"
PLAN_METHOD_VERSION = "direction-aware-a-share-plan-v1"
PRICE_RULE_VERSION = "a-share-price-rules-2026-v1"
QUANTITY_RULE_VERSION = "a-share-order-size-rules-v1"
CAPACITY_SHARE_OF_DAILY_AMOUNT = 0.02
RULE_REFERENCE_POSITION_CAP_PCT = 10.0

# Domain-facing names for callers that do not need the V6 prefix.
ExecutionFacts = V6ExecutionFacts
RiskProfile = V6RiskProfile
PortfolioContext = V6PortfolioContext

_BOARD_LIMITS: dict[str, float] = {
    "main": 10.0,
    "chinext": 20.0,
    "star": 20.0,
    "bse": 30.0,
}
_BOARD_NAMES: dict[str, str] = {
    "主板": "main",
    "创业板": "chinext",
    "科创板": "star",
    "北交所": "bse",
    "main_board": "main",
    "chi_next": "chinext",
    "star_market": "star",
    "bjse": "bse",
}


def _field(value: Mapping[str, Any], name: str, default: Any = None) -> Any:
    if name in value:
        return value[name]
    parts = name.split("_")
    alias = parts[0] + "".join(part.title() for part in parts[1:])
    return value.get(alias, default)


def _coerce_facts(value: V6ExecutionFacts | Mapping[str, Any]) -> V6ExecutionFacts:
    if isinstance(value, V6ExecutionFacts):
        return value
    if not isinstance(value, Mapping):
        raise ValueError("execution facts must be an object")
    raw = dict(value)
    aliases = {
        "board_type": "board",
        "market": "exchange",
        "is_suspended": "suspended",
        "is_delisted": "delisted",
        "is_delisting": "delisting",
        "is_st": "risk_warning",
        "st": "risk_warning",
        "is_registration_listing": "registration_listing",
        "days_since_listing": "listing_days",
        "amount": "amount_yuan",
        "turnover": "turnover_rate_pct",
        "as_of": "observed_at",
        "quote_price": "price",
        "prev_close": "previous_close",
    }
    for old, new in aliases.items():
        if new not in raw and old in raw:
            raw[new] = raw[old]
    board = raw.get("board", "unknown")
    if isinstance(board, str):
        raw["board"] = _BOARD_NAMES.get(board.strip().lower(), board.strip().lower())
    raw.setdefault("observed_at", raw.get("market_as_of"))
    return V6ExecutionFacts.model_validate(raw)


def _coerce_portfolio(
    value: V6PortfolioContext | Mapping[str, Any] | None,
    holding_state: V6HoldingState,
) -> V6PortfolioContext:
    if value is None:
        return V6PortfolioContext(holding_state=holding_state)
    if isinstance(value, V6PortfolioContext):
        context = value
    else:
        raw = dict(value)
        raw.setdefault("holding_state", holding_state)
        if "correlated_exposure_pct" not in raw and "correlation_exposure_pct" in raw:
            raw["correlated_exposure_pct"] = raw["correlation_exposure_pct"]
        context = V6PortfolioContext.model_validate(raw)
    if context.holding_state != holding_state:
        raise ValueError("holding_state must match portfolio context")
    return context


def _coerce_risk(value: V6RiskProfile | Mapping[str, Any] | None) -> V6RiskProfile:
    if value is None:
        return V6RiskProfile.conservative_default()
    if isinstance(value, V6RiskProfile):
        return value
    raw = dict(value)
    aliases = {
        "single_trade_risk_pct": "risk_budget_pct",
        "single_stock_cap_pct": "max_single_position_pct",
        "industry_cap_pct": "max_industry_exposure_pct",
        "correlation_cap_pct": "max_correlated_exposure_pct",
    }
    for old, new in aliases.items():
        if new not in raw and old in raw:
            raw[new] = raw[old]
    return V6RiskProfile.model_validate(raw)


def _coerce_costs(value: V6CostAssumptions | Mapping[str, Any] | None) -> V6CostAssumptions:
    if value is None:
        return V6CostAssumptions()
    if isinstance(value, V6CostAssumptions):
        return value
    raw = dict(value)
    if "stamp_tax_pct" not in raw and "stamp_duty_pct" in raw:
        raw["stamp_tax_pct"] = raw["stamp_duty_pct"]
    return V6CostAssumptions.model_validate(raw)


def _limit_rule(facts: V6ExecutionFacts) -> tuple[float | None, float | None, V6RuleStatus, list[str]]:
    warnings: list[str] = []
    try:
        observed_year = datetime.fromisoformat(facts.observed_at.replace("Z", "+00:00")).year
    except ValueError:
        observed_year = 0
    if observed_year < 2026:
        warnings.append("历史价格限制规则未在当前版本复现，执行状态按受限处理")
        return None, None, "limited", warnings
    if facts.board == "unknown" or facts.risk_warning is None or facts.listing_days is None:
        warnings.append("板块、风险警示或上市阶段未完全确认，价格限制按受限状态处理")
        return None, None, "limited", warnings
    if facts.board not in _BOARD_LIMITS:
        warnings.append("板块规则未覆盖，价格限制按受限状态处理")
        return None, None, "limited", warnings
    confirmed_exchange = {
        "main": "XSHG",
        "chinext": "XSHE",
        "star": "XSHG",
        "bse": "BJSE",
    }[facts.board]
    if facts.exchange != confirmed_exchange:
        warnings.append("交易所规则来源未确认，不能猜测该板块价格限制")
        return None, None, "limited", warnings
    if facts.board == "main" and facts.listing_days <= 5:
        if facts.registration_listing is None:
            warnings.append("主板上市初期是否注册制未确认，不能猜测前五日价格限制")
            return None, None, "limited", warnings
        if not facts.registration_listing:
            if facts.listing_days == 1:
                return 44.0, 36.0, "confirmed", warnings
            return 10.0, 10.0, "confirmed", warnings
        warnings.append("注册制主板上市前五个交易日无固定涨跌幅限制")
        return None, None, "confirmed", warnings
    if facts.board in {"chinext", "star"} and facts.listing_days <= 5:
        warnings.append("上市初期无固定涨跌幅限制，不能用价格边界判断可成交")
        return None, None, "confirmed", warnings
    if facts.board == "bse" and facts.listing_days == 1:
        warnings.append("北交所上市首日无固定涨跌幅限制，不能用价格边界判断可成交")
        return None, None, "confirmed", warnings
    if facts.exchange == "XSHE":
        warnings.append("深圳交易所当前价格限制规则未在本版本完成权威来源闭包")
        return None, None, "limited", warnings
    else:
        upper = _BOARD_LIMITS[facts.board]
        if facts.risk_warning and facts.board == "main":
            # Current Shanghai risk-warning rule is versioned above; Shenzhen
            # is deliberately not inferred from this branch.
            upper = lower = 10.0
        else:
            lower = upper
    return upper, lower, "confirmed", warnings


def _price_limits(
    facts: V6ExecutionFacts,
    upper_pct: float | None,
    lower_pct: float | None,
) -> tuple[float | None, float | None]:
    if facts.previous_close is None or upper_pct is None or lower_pct is None:
        return None, None
    previous = Decimal(str(facts.previous_close))
    tick = Decimal("0.01")
    upper = (previous * (Decimal("1") + Decimal(str(upper_pct)) / Decimal("100"))).quantize(
        tick, rounding=ROUND_DOWN
    )
    lower = (previous * (Decimal("1") - Decimal(str(lower_pct)) / Decimal("100"))).quantize(
        tick, rounding=ROUND_UP
    )
    return (
        float(upper),
        float(lower),
    )


def _order_size_rule(board: str) -> tuple[int, int]:
    if board == "star":
        return 200, 1
    if board == "bse":
        return 100, 1
    return 100, 100


def _slippage_proxy(
    facts: V6ExecutionFacts,
) -> tuple[float | None, float | None, Literal["proxy", "limited"]]:
    amount = facts.amount_yuan
    turnover = facts.turnover_rate_pct
    atr = facts.atr20_pct
    if amount is None or amount <= 0 or turnover is None or turnover <= 0 or atr is None or atr < 0:
        return None, None, "limited"
    amount_scale = max(amount / 100_000_000, 0.0)
    slippage = 0.05 + 0.25 * atr + 0.5 / math.sqrt(1 + amount_scale)
    slippage += 0.2 / math.sqrt(1 + turnover)
    slippage = round(max(0.05, min(5.0, slippage)), 6)
    capacity = round(amount * CAPACITY_SHARE_OF_DAILY_AMOUNT, 2)
    return slippage, capacity, "proxy"


def assess_a_share_execution(
    facts: V6ExecutionFacts | Mapping[str, Any],
    *,
    holding_state: V6HoldingState = "not_holding",
    today_bought_quantity: int | None = None,
    requested_side: Literal["buy", "sell"] | None = None,
) -> V6ExecutionAssessment:
    """Apply exchange rules and conservative free-data execution proxies."""
    current = _coerce_facts(facts)
    min_order_quantity, order_quantity_increment = _order_size_rule(current.board)
    upper_pct, lower_pct, rules_status, warnings = _limit_rule(current)
    state_unknown = any(
        value is None for value in (current.suspended, current.delisted, current.delisting)
    )
    if state_unknown:
        warnings.append("停牌或退市状态未完全确认，执行状态按受限处理")
    upper_price, lower_price = _price_limits(current, upper_pct, lower_pct)
    slippage, capacity, liquidity_status = _slippage_proxy(current)
    if not current.has_order_book:
        warnings.append("缺少真实盘口，成交可行性仅为代理状态，不代表立即成交")
    else:
        warnings.append("盘口深度未完成成交模拟，仍不承诺立即成交")

    t_plus_one: str
    if holding_state == "not_holding":
        t_plus_one = "not_applicable"
    elif today_bought_quantity is None:
        t_plus_one = "unknown"
        warnings.append("持仓买入日期未确认，卖出受T+1限制的状态未知")
    elif today_bought_quantity > 0:
        t_plus_one = "restricted"
        warnings.append("当日买入数量受T+1约束，不能建议当日卖出")
    else:
        t_plus_one = "allowed"

    hard_block = current.suspended is True or current.delisted is True or current.delisting is True
    if current.suspended is True:
        warnings.append("股票停牌，当前不能按普通交易计划执行")
    if current.delisted is True or current.delisting is True:
        warnings.append("股票处于退市状态，当前不能按普通交易计划执行")
    if current.price is None:
        warnings.append("缺少当前价格，无法判断涨跌停边界")
    buy_blocked = hard_block
    sell_blocked = hard_block or t_plus_one == "restricted"
    if upper_price is not None and current.price is not None and current.price >= upper_price:
        buy_blocked = True
        warnings.append("价格接近或达到涨停上沿，买入存在无法成交风险")
    if lower_price is not None and current.price is not None and current.price <= lower_price:
        sell_blocked = True
        warnings.append("价格接近或达到跌停下沿，止损卖出存在无法成交风险")

    def side_status(blocked: bool, not_applicable: bool = False) -> str:
        if not_applicable:
            return "not_applicable"
        if blocked:
            return "blocked"
        if (
            current.price is None
            or rules_status == "limited"
            or liquidity_status == "limited"
            or state_unknown
        ):
            return "limited"
        return "proxy"

    buy_status = side_status(buy_blocked)
    sell_status = side_status(sell_blocked, holding_state == "not_holding")
    if holding_state == "holding" and t_plus_one == "unknown" and not hard_block:
        sell_status = "limited"
    selected = buy_status if requested_side == "buy" else sell_status if requested_side == "sell" else None
    if selected == "blocked" or requested_side == "sell" and t_plus_one == "unknown":
        execution_status: V6ExecutionStatus = "blocked" if selected == "blocked" else "limited"
    elif (
        selected == "limited"
        or selected is None
        and (liquidity_status == "limited" or rules_status == "limited" or state_unknown)
    ):
        execution_status = "limited"
    else:
        execution_status = "proxy"
    if hard_block:
        execution_status = "blocked"

    return V6ExecutionAssessment(
        execution_status=execution_status,
        rules_status=rules_status,
        liquidity_status=liquidity_status,
        board=current.board,
        exchange=current.exchange,
        risk_warning=current.risk_warning,
        price_limit_pct=upper_pct,
        upper_limit_price=upper_price,
        lower_limit_price=lower_price,
        buy_status=buy_status,
        sell_status=sell_status,
        t_plus_one_status=t_plus_one,
        min_order_quantity=min_order_quantity,
        order_quantity_increment=order_quantity_increment,
        estimated_slippage_pct=slippage,
        capacity_notional_yuan=capacity,
        method_version=EXECUTION_METHOD_VERSION,
        rule_version=PRICE_RULE_VERSION,
        quantity_rule_version=QUANTITY_RULE_VERSION,
        slippage_method_version=SLIPPAGE_METHOD_VERSION,
        warnings=list(dict.fromkeys(warnings)),
        source_ids=list(current.source_ids),
    )


def _current_action(direction: V6Direction, action: str, holding: V6HoldingState) -> V6CurrentAction:
    if direction == "positive":
        if holding == "holding":
            return "participate" if action == "conditional_participation" else "hold"
        return "participate" if action == "conditional_participation" else "wait"
    if direction == "neutral":
        return "reduce" if holding == "holding" and action == "reduce" else "hold" if holding == "holding" else "wait"
    if holding == "holding":
        return "exit" if action == "exit" else "reduce"
    return "avoid"


def cost_adjusted_risk_reward(
    *,
    entry_price: float,
    stop_loss: float,
    first_take_profit: float,
    second_take_profit: float,
    slippage_pct: float | None,
    costs: V6CostAssumptions | Mapping[str, Any] | None = None,
) -> tuple[float | None, float | None]:
    if slippage_pct is None:
        return None, None
    assumptions = _coerce_costs(costs)
    prices = (entry_price, stop_loss, first_take_profit, second_take_profit)
    if (
        any(not math.isfinite(value) or value <= 0 for value in prices)
        or not math.isfinite(slippage_pct)
        or slippage_pct < 0
    ):
        return None, None
    buy_cost = assumptions.commission_pct + assumptions.transfer_fee_pct + slippage_pct
    sell_cost = assumptions.commission_pct + assumptions.transfer_fee_pct + assumptions.stamp_tax_pct + slippage_pct
    effective_entry = entry_price * (1 + buy_cost / 100)
    effective_stop = stop_loss * (1 - sell_cost / 100)
    denominator = effective_entry - effective_stop
    if denominator <= 0:
        return None, None
    first = first_take_profit * (1 - sell_cost / 100)
    second = second_take_profit * (1 - sell_cost / 100)
    return (
        round((first - effective_entry) / denominator, 6),
        round((second - effective_entry) / denominator, 6),
    )


def _cost_adjusted_rr(
    plan: V5TradingPlan,
    slippage_pct: float | None,
    costs: V6CostAssumptions,
) -> tuple[float | None, float | None]:
    return cost_adjusted_risk_reward(
        entry_price=(plan.reference_buy_low + plan.reference_buy_high) / 2,
        stop_loss=plan.stop_loss,
        first_take_profit=plan.first_take_profit,
        second_take_profit=plan.second_take_profit,
        slippage_pct=slippage_pct,
        costs=costs,
    )


def materialize_v6_trading_plan(
    plan: V5TradingPlan | Mapping[str, Any],
    *,
    direction: V6Direction,
    action: str,
    holding_state: V6HoldingState,
    execution_facts: V6ExecutionFacts | Mapping[str, Any],
    portfolio: V6PortfolioContext | Mapping[str, Any] | None = None,
    risk_profile: V6RiskProfile | Mapping[str, Any] | None = None,
    costs: V6CostAssumptions | Mapping[str, Any] | None = None,
    alpha_calibrated: bool = True,
    plan_type: Literal["alpha_calibrated", "rule_reference"] | None = None,
) -> V6MaterializedTradingPlan:
    """Materialize one V5 plan for direction, holding and A-share constraints."""
    if plan_type is None:
        plan_type = "alpha_calibrated" if alpha_calibrated else "rule_reference"
    v5_position: V5PositionPlan | None = None
    if isinstance(plan, V5TradingPlan):
        trading_plan = plan
    elif isinstance(plan, Mapping) and _field(plan, "trading_plan") is not None:
        trading_plan = V5TradingPlan.model_validate(_field(plan, "trading_plan"))
        position_payload = _field(plan, "position_plan")
        if position_payload is not None:
            v5_position = V5PositionPlan.model_validate(position_payload)
    elif hasattr(plan, "trading_plan"):
        trading_plan = V5TradingPlan.model_validate(plan.trading_plan)
        if getattr(plan, "position_plan", None) is not None:
            v5_position = V5PositionPlan.model_validate(plan.position_plan)
    else:
        trading_plan = V5TradingPlan.model_validate(plan)
    if action not in {
        "conditional_participation", "wait", "hold", "reduce", "exit", "avoid"
    }:
        raise ValueError("unsupported V6 action")
    if direction == "positive" and action in {"reduce", "exit", "avoid"}:
        raise ValueError("positive direction cannot reduce, exit or avoid")
    if direction == "negative" and action in {"conditional_participation", "hold"}:
        raise ValueError("negative direction cannot participate or hold")
    if direction == "neutral" and action == "conditional_participation":
        raise ValueError("neutral direction cannot conditionally participate")
    if direction == "avoid" and action not in {"avoid", "reduce", "exit"}:
        raise ValueError("avoid direction only allows avoid, reduce or exit")
    context = _coerce_portfolio(portfolio, holding_state)
    profile = _coerce_risk(risk_profile)
    cost_assumptions = _coerce_costs(costs)
    requested_side: Literal["buy", "sell"] | None = None
    if direction == "positive" and (holding_state == "not_holding" or action == "conditional_participation"):
        requested_side = "buy"
    elif direction in {"negative", "avoid"} and holding_state == "holding":
        requested_side = "sell"
    execution = assess_a_share_execution(
        execution_facts,
        holding_state=holding_state,
        today_bought_quantity=context.today_bought_quantity,
        requested_side=requested_side,
    )
    current_action = _current_action(direction, action, holding_state)
    if execution.execution_status == "blocked":
        current_action = (
            "execution_blocked"
            if requested_side == "sell"
            else "hold" if holding_state == "holding" else "wait"
        )
    elif direction == "positive" and execution.execution_status == "limited":
        current_action = "hold" if holding_state == "holding" else "wait"
    midpoint = (trading_plan.reference_buy_low + trading_plan.reference_buy_high) / 2
    buy_low = buy_high = pullback_low = pullback_high = None
    confirmation = invalidation = exit_price = reentry = None
    stop_loss = first_take = second_take = None
    if (
        direction == "positive"
        and execution.execution_status == "proxy"
        and (holding_state == "not_holding" or action == "conditional_participation")
    ):
        buy_low = trading_plan.reference_buy_low
        buy_high = trading_plan.reference_buy_high
        pullback_low = trading_plan.pullback_buy_low
        pullback_high = trading_plan.pullback_buy_high
        stop_loss = trading_plan.stop_loss
        first_take = trading_plan.first_take_profit
        second_take = trading_plan.second_take_profit
    elif direction == "positive" and holding_state == "holding":
        stop_loss = trading_plan.stop_loss
        first_take = trading_plan.first_take_profit
        second_take = trading_plan.second_take_profit
    elif direction == "neutral" or (
        direction == "positive" and execution.execution_status == "limited"
    ):
        confirmation = trading_plan.reference_buy_high
        invalidation = trading_plan.stop_loss
        if direction == "neutral" and holding_state == "holding" and action == "reduce":
            exit_price = trading_plan.stop_loss
    else:
        reentry = trading_plan.reference_buy_high
        if holding_state == "holding":
            exit_price = trading_plan.stop_loss

    initial_position = target_max_position = additional_position = risk_budget = 0.0
    cap_reasons: list[str] = []
    liquidity_cap_pct: float | None = None
    if not profile.configured:
        cap_reasons.append("使用 conservative_default 保守默认风险配置")
    if direction == "positive" and execution.execution_status in {"proxy", "limited"}:
        if v5_position is not None:
            base_max = v5_position.max_position_pct
            base_initial = v5_position.initial_position_pct
            base_risk_budget = v5_position.risk_budget_pct
        else:
            stop_distance = max(
                0.000001,
                (midpoint - trading_plan.stop_loss) / midpoint * 100,
            )
            base_max = min(100.0, 1.0 / stop_distance * 100)
            base_initial = base_max / 2
            base_risk_budget = 1.0
        risk_budget = min(profile.risk_budget_pct, base_risk_budget)
        caps = [
            (base_max, "交易计划风险上限"),
            (profile.max_single_position_pct, "单股仓位上限"),
            (max(0.0, profile.max_industry_exposure_pct - context.industry_exposure_pct), "行业暴露剩余上限"),
            (max(0.0, profile.max_correlated_exposure_pct - context.correlated_exposure_pct), "相关暴露剩余上限"),
        ]
        if plan_type == "rule_reference":
            caps.append(
                (
                    RULE_REFERENCE_POSITION_CAP_PCT,
                    "量化策略未通过历史校准，规则参考计划仓位上限为10%",
                )
            )
        if execution.capacity_notional_yuan is not None and context.portfolio_value_yuan:
            liquidity_cap_pct = round(
                execution.capacity_notional_yuan / context.portfolio_value_yuan * 100, 6
            )
            caps.append((max(0.0, liquidity_cap_pct), "成交额容量代理上限"))
        else:
            cap_reasons.append("未配置资金或成交额不完整，容量仅能保持受限代理状态")
        target_max_position, limiting_reason = min(caps, key=lambda item: item[0])
        cap_reasons.append(limiting_reason)
        target_max_position = round(target_max_position, 6)
        additional_position = round(
            max(0.0, target_max_position - context.current_position_pct), 6
        )
        if context.current_position_pct > 0:
            cap_reasons.append("现有持仓只影响可新增仓位，不改变目标总仓位上限")
        initial_position = round(min(base_initial, additional_position / 2), 6)
        if holding_state == "holding" and action != "conditional_participation":
            initial_position = 0.0

        if additional_position <= 0:
            updated_warnings = list(execution.warnings)
            updated_warnings.append("组合上限已用尽，当前不生成新增买入计划")
            execution = execution.model_copy(
                update={
                    "execution_status": "limited",
                    "warnings": list(dict.fromkeys(updated_warnings)),
                }
            )
            current_action = "hold" if holding_state == "holding" else "wait"
            buy_low = buy_high = pullback_low = pullback_high = None
            confirmation = trading_plan.reference_buy_high
            invalidation = trading_plan.stop_loss

    rr_first, rr_second = (
        _cost_adjusted_rr(trading_plan, execution.estimated_slippage_pct, cost_assumptions)
        if direction == "positive" and additional_position > 0
        else (None, None)
    )
    if rr_first is None and direction == "positive":
        cap_reasons.append("缺少成交额、换手率或波动率，成本后风险收益暂不能确认")
    source_ids = list(dict.fromkeys([*trading_plan.source_ids, *execution.source_ids]))
    return V6MaterializedTradingPlan(
        direction=direction,
        action=action,
        holding_state=holding_state,
        current_action=current_action,
        plan_status=execution.execution_status,
        plan_type=plan_type,
        alpha_calibration_status="calibrated" if alpha_calibrated else "research_only",
        execution=execution,
        buy_low=buy_low,
        buy_high=buy_high,
        pullback_low=pullback_low,
        pullback_high=pullback_high,
        confirmation_price=confirmation,
        invalidation_price=invalidation,
        exit_price=exit_price,
        reentry_confirmation_price=reentry,
        stop_loss=stop_loss,
        first_take_profit=first_take,
        second_take_profit=second_take,
        initial_position_pct=initial_position,
        max_position_pct=target_max_position,
        target_max_position_pct=target_max_position,
        additional_position_pct=additional_position,
        liquidity_cap_pct=liquidity_cap_pct,
        risk_budget_pct=risk_budget,
        risk_reward_first_after_cost=rr_first,
        risk_reward_second_after_cost=rr_second,
        risk_profile_name=profile.profile_name,
        risk_profile_configured=profile.configured,
        position_cap_reasons=list(dict.fromkeys(cap_reasons)),
        calculation_method="direction-aware-a-share-plan",
        calculation_version=PLAN_METHOD_VERSION,
        execution_mode="research_only",
        source_ids=source_ids,
    )
