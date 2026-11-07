"""Work-only image pricing based on an independently verified output image."""
from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import ROUND_CEILING, Decimal

_DIGEST = re.compile(r"^[a-f0-9]{64}$")


def image_price_units(price: Mapping[str, str]) -> int:
    """Convert the administrator's CNY-per-image price to micro-CNY."""
    amount = price["amount_per_image"]
    if not isinstance(amount, str) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?", amount):
        raise ValueError("invalid image price")
    value = Decimal(amount)
    if value > 1_000_000_000:
        raise ValueError("invalid image price")
    return int((value * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def image_actual_units(price: Mapping[str, str], receipt: dict) -> int:
    """One server-verified image is one charge; this is not token usage."""
    if (not isinstance(receipt, dict) or set(receipt) != {"sha256", "image_count"}
            or type(receipt["image_count"]) is not int or receipt["image_count"] != 1
            or not isinstance(receipt["sha256"], str) or not _DIGEST.fullmatch(receipt["sha256"])):
        raise ValueError("invalid image receipt")
    return image_price_units(price)
