"""Deterministic technical indicators (design §7.2).

The data layer computes MA / MACD / RSI / volume change / swing high-low;
agents only interpret the results and must never invent their own levels.
Support/resistance numbers may enter a report only with an explicit,
versioned algorithm — currently ``swing-high-low-v1``.

Conventions:
- Outputs align with the input length; insufficient windows yield ``None``
  missing markers rather than exceptions.
- EMA is seeded with the first value (``EMA_1 = v_1``,
  ``alpha = 2/(span+1)``). MACD histogram follows the Chinese convention
  ``hist = 2 * (DIF - DEA)``.
- RSI uses Wilder smoothing (seed = SMA of the first ``window`` changes);
  flat series (avg gain == avg loss == 0) yields 50.0.
"""

from __future__ import annotations

SWING_METHOD = "swing-high-low-v1"


def sma(values: list[float], window: int) -> list[float | None]:
    """Simple moving average aligned to input; ``None`` until window fills."""
    if window <= 0:
        raise ValueError("window must be positive")
    out: list[float | None] = []
    acc = 0.0
    for i, v in enumerate(values):
        acc += v
        if i >= window:
            acc -= values[i - window]
        out.append(acc / window if i >= window - 1 else None)
    return out


def _ema(values: list[float], span: int) -> list[float]:
    """EMA seeded with the first value."""
    if not values:
        return []
    alpha = 2 / (span + 1)
    out = [float(values[0])]
    for v in values[1:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


def macd(
    values: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[float], list[float], list[float]]:
    """Return (dif, dea, hist) full-length lists; ``hist = 2 * (DIF - DEA)``."""
    if not values:
        return [], [], []
    ema_fast = _ema(values, fast)
    ema_slow = _ema(values, slow)
    dif = [f - s for f, s in zip(ema_fast, ema_slow)]
    dea = _ema(dif, signal)
    hist = [2 * (d - e) for d, e in zip(dif, dea)]
    return dif, dea, hist


def rsi(values: list[float], window: int = 14) -> list[float | None]:
    """Wilder RSI aligned to input; first value at index ``window``."""
    if window <= 0:
        raise ValueError("window must be positive")
    n = len(values)
    out: list[float | None] = [None] * n
    if n <= window:
        return out
    gains, losses = [], []
    for i in range(1, n):
        change = values[i] - values[i - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains[:window]) / window
    avg_loss = sum(losses[:window]) / window
    out[window] = _rsi_value(avg_gain, avg_loss)
    for i in range(window, len(gains)):
        avg_gain = (avg_gain * (window - 1) + gains[i]) / window
        avg_loss = (avg_loss * (window - 1) + losses[i]) / window
        out[i + 1] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def swing_high_low(
    highs: list[float], lows: list[float], window: int = 20
) -> dict[str, float | int | str | None]:
    """Support = min(lows[-window:]), resistance = max(highs[-window:]).

    Versioned as ``swing-high-low-v1``; insufficient data yields ``None``
    markers rather than silently shrinking the window.
    """
    result: dict[str, float | int | str | None] = {
        "support": None,
        "resistance": None,
        "method": SWING_METHOD,
        "window": window,
    }
    if len(highs) < window or len(lows) < window:
        return result
    result["support"] = min(lows[-window:])
    result["resistance"] = max(highs[-window:])
    return result


def volume_change_pct(volumes: list[float], window: int = 5) -> float | None:
    """Latest volume vs the mean of the previous ``window`` bars, in percent."""
    if len(volumes) <= window:
        return None
    base = sum(volumes[-window - 1 : -1]) / window
    if base == 0:
        return None
    return (volumes[-1] - base) / base * 100
