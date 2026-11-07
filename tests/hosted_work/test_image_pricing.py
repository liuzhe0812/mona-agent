"""Image prices are explicit CNY per successfully verified image."""
import pytest

from mona.hosted_work.image_pricing import image_actual_units, image_price_units


def test_one_verified_image_is_charged_at_the_admin_price():
    price = {"amount_per_image": "0.123456"}
    assert image_price_units(price) == 123456
    assert image_actual_units(price, {"sha256": "a" * 64, "image_count": 1}) == 123456
    assert image_price_units({"amount_per_image": "0"}) == 0


@pytest.mark.parametrize("receipt", [
    {}, {"sha256": "a" * 64}, {"sha256": "bad", "image_count": 1},
    {"sha256": "a" * 64, "image_count": 0}, {"sha256": "a" * 64, "image_count": True},
    {"sha256": "a" * 64, "image_count": 2},
])
def test_missing_or_invalid_image_receipt_cannot_be_settled(receipt):
    with pytest.raises(ValueError):
        image_actual_units({"amount_per_image": "1"}, receipt)


def test_invalid_price_is_not_an_implicit_free_price():
    with pytest.raises(ValueError):
        image_price_units({"amount_per_image": "-1"})
