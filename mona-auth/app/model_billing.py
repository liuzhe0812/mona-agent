from __future__ import annotations

import json
from decimal import ROUND_CEILING, Decimal

from sqlalchemy.orm import Session

from app.errors import AuthError
from app.models import ModelPrice

RATE_SCALE = 1_000_000
FULL_PRICE_MULTIPLIER_BPS = 10_000
IMAGE_RATE_KEYS = {
    "qima_input_1k",
    "qima_input_2k",
    "qima_output_1k",
    "qima_output_2k",
}
VIDEO_RATE_KEYS = {
    "video_ratio_480p",
    "video_ratio_720p",
    "video_ratio_1080p",
}


def active_price(db: Session, model: str) -> ModelPrice:
    price = (
        db.query(ModelPrice)
        .filter(ModelPrice.model == model, ModelPrice.enabled.is_(True))
        .order_by(ModelPrice.version.desc())
        .first()
    )
    if price is None:
        raise AuthError("model_not_available", "Managed model is not available", status_code=404)
    return price


def _scaled_cost(tokens: int, rate: int) -> int:
    if tokens <= 0 or rate <= 0:
        return 0
    return (tokens * rate + RATE_SCALE - 1) // RATE_SCALE


def effective_rate(rate: int, price_multiplier_bps: int = FULL_PRICE_MULTIPLIER_BPS) -> int:
    if not 0 < price_multiplier_bps <= FULL_PRICE_MULTIPLIER_BPS:
        raise ValueError("price multiplier must be between 1 and 10000 basis points")
    if rate <= 0:
        return 0
    return (
        rate * price_multiplier_bps + FULL_PRICE_MULTIPLIER_BPS - 1
    ) // FULL_PRICE_MULTIPLIER_BPS


def reserve_units(
    body: dict,
    price: ModelPrice,
    *,
    max_output_tokens: int,
    price_multiplier_bps: int = FULL_PRICE_MULTIPLIER_BPS,
) -> int:
    input_upper_bound = len(
        json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    return max(
        1,
        _scaled_cost(input_upper_bound, effective_rate(price.input_rate, price_multiplier_bps))
        + _scaled_cost(
            max_output_tokens,
            effective_rate(price.output_rate, price_multiplier_bps),
        ),
    )


def actual_units(
    price: ModelPrice,
    *,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int,
    price_multiplier_bps: int = FULL_PRICE_MULTIPLIER_BPS,
) -> int:
    uncached_tokens = max(0, prompt_tokens - cached_tokens)
    return (
        _scaled_cost(uncached_tokens, effective_rate(price.input_rate, price_multiplier_bps))
        + _scaled_cost(
            cached_tokens,
            effective_rate(price.cached_input_rate, price_multiplier_bps),
        )
        + _scaled_cost(
            completion_tokens,
            effective_rate(price.output_rate, price_multiplier_bps),
        )
    )


def media_rate(price: ModelPrice, key: str) -> int:
    rates = price.rates_json if isinstance(price.rates_json, dict) else {}
    value = rates.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise AuthError(
            "model_rate_unavailable",
            "Managed model rate is unavailable",
            status_code=503,
        )
    return value


def _media_cost(rate: int, quantity: int | float | Decimal) -> int:
    value = Decimal(str(quantity)) * Decimal(rate)
    return max(1, int(value.to_integral_value(rounding=ROUND_CEILING)))


def image_reserve_units(
    price: ModelPrice,
    *,
    input_count: int,
    output_count: int,
    size: str,
) -> int:
    width, height = (int(value) for value in size.split("*", 1))
    tier = "2k" if width * height > 2_250_000 else "1k"
    total = _media_cost(media_rate(price, f"qima_output_{tier}"), output_count)
    if input_count:
        total += _media_cost(media_rate(price, f"qima_input_{tier}"), input_count)
    return total


def image_actual_units(price: ModelPrice, usage: dict) -> int:
    input_count = int(usage.get("input_image_count") or 0)
    output_count = int(usage.get("output_image_count") or 0)
    input_key = str(usage.get("input_image_type") or "")
    output_key = str(usage.get("output_image_type") or "")
    if input_count < 0 or output_count <= 0:
        raise ValueError("invalid image usage")
    if output_key not in IMAGE_RATE_KEYS or not output_key.startswith("qima_output_"):
        raise ValueError("invalid image output rate key")
    total = _media_cost(media_rate(price, output_key), output_count)
    if input_count:
        if input_key not in IMAGE_RATE_KEYS or not input_key.startswith("qima_input_"):
            raise ValueError("invalid image input rate key")
        total += _media_cost(media_rate(price, input_key), input_count)
    return total


def video_reserve_units(price: ModelPrice, *, resolution: str, duration: int) -> int:
    key = f"video_ratio_{resolution.lower()}"
    if key not in VIDEO_RATE_KEYS:
        raise ValueError("invalid video resolution")
    return _media_cost(media_rate(price, key), duration)


def video_actual_units(price: ModelPrice, usage: dict) -> int:
    raw_resolution = str(usage.get("SR") or usage.get("sr") or "0").upper().removesuffix("P")
    resolution = int(raw_resolution)
    duration = Decimal(str(usage.get("duration") or 0))
    key = f"video_ratio_{resolution}p"
    if key not in VIDEO_RATE_KEYS or duration <= 0:
        raise ValueError("invalid video usage")
    return _media_cost(media_rate(price, key), duration)
