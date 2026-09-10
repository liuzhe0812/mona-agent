from types import SimpleNamespace

from app.model_billing import actual_units, effective_rate, reserve_units


def _price(**overrides):
    values = {
        "input_rate": 1_000_000,
        "cached_input_rate": 20_000,
        "output_rate": 2_000_000,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_actual_units_prices_uncached_cached_and_output_separately():
    assert (
        actual_units(
            _price(),
            prompt_tokens=100,
            completion_tokens=10,
            cached_tokens=20,
        )
        == 101
    )


def test_cost_rounds_each_nonzero_component_up_to_one_unit():
    price = _price(input_rate=1, cached_input_rate=1, output_rate=1)

    assert actual_units(
        price,
        prompt_tokens=2,
        completion_tokens=1,
        cached_tokens=1,
    ) == 3


def test_zero_rates_produce_zero_actual_cost():
    price = _price(input_rate=0, cached_input_rate=0, output_rate=0)

    assert actual_units(
        price,
        prompt_tokens=100,
        completion_tokens=100,
        cached_tokens=50,
    ) == 0


def test_reservation_is_positive_and_uses_requested_output_ceiling():
    body = {"model": "managed-model", "messages": [{"role": "user", "content": "hi"}]}
    price = _price(input_rate=0, cached_input_rate=0, output_rate=1_000_000)

    assert reserve_units(body, price, max_output_tokens=10) == 10
    assert reserve_units(body, _price(input_rate=0, output_rate=0), max_output_tokens=10) == 1


def test_discounted_rates_round_up_and_apply_to_reservation_and_settlement():
    price = _price(input_rate=1_000_001, cached_input_rate=20_001, output_rate=2_000_001)
    body = {"messages": [{"role": "user", "content": "hello"}]}

    assert effective_rate(price.input_rate, 5_000) == 500_001
    assert effective_rate(price.cached_input_rate, 5_000) == 10_001
    assert reserve_units(
        body,
        price,
        max_output_tokens=10,
        price_multiplier_bps=5_000,
    ) < reserve_units(body, price, max_output_tokens=10)
    assert actual_units(
        price,
        prompt_tokens=100,
        completion_tokens=10,
        cached_tokens=20,
        price_multiplier_bps=5_000,
    ) == 53
