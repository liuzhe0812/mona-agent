"""Local model-usage records for the desktop usage page."""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.paths import get_data_dir

_DB_FILE = "usage.sqlite3"
_PERIOD_DAYS = 30


def _db_path() -> Path:
    app_data_dir = os.environ.get("MONA_APP_DATA_DIR")
    if app_data_dir:
        return Path(app_data_dir) / _DB_FILE
    return get_data_dir() / _DB_FILE


def _connect() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS model_usage (
            id INTEGER PRIMARY KEY,
            created_at INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL,
            completion_tokens INTEGER NOT NULL,
            cached_tokens INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_model_usage_created_at ON model_usage(created_at)"
    )
    return conn


def _token_count(usage: dict[str, int], key: str) -> int:
    value = usage.get(key, 0)
    return int(value) if isinstance(value, (int, float)) else 0


def record_model_usage(
    *,
    provider: str,
    model: str,
    usage: dict[str, int],
    created_at: datetime | None = None,
) -> None:
    prompt_tokens = _token_count(usage, "prompt_tokens")
    completion_tokens = _token_count(usage, "completion_tokens")
    cached_tokens = _token_count(usage, "cached_tokens")
    if prompt_tokens + completion_tokens <= 0:
        return

    timestamp = int((created_at or datetime.now(timezone.utc)).timestamp())
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO model_usage (
                created_at, provider, model, prompt_tokens, completion_tokens, cached_tokens
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                timestamp,
                provider or "未知供应商",
                model or "未知模型",
                prompt_tokens,
                completion_tokens,
                cached_tokens,
            ),
        )


def record_provider_usage(provider: Any, model: str | None, response: Any) -> None:
    effective_provider = getattr(response, "_usage_provider", provider)
    effective_model = getattr(response, "_usage_model", model)
    spec = getattr(effective_provider, "_spec", None) or getattr(
        effective_provider, "spec", None
    )
    label = getattr(spec, "label", "")
    provider_name = (
        label if isinstance(label, str) and label else type(effective_provider).__name__
    )
    try:
        record_model_usage(
            provider=provider_name,
            model=effective_model or effective_provider.get_default_model(),
            usage=getattr(response, "usage", {}),
        )
    except (OSError, sqlite3.Error) as exc:
        logger.warning("Unable to persist local model usage: {}", exc)


def get_usage_summary(
    tz_offset_minutes: int,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    offset = timedelta(minutes=tz_offset_minutes)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    current = current.astimezone(timezone.utc)
    today = (current + offset).date()
    first_day = today - timedelta(days=_PERIOD_DAYS - 1)
    start_utc = datetime.combine(first_day, time.min, tzinfo=timezone.utc) - offset

    daily: dict[str, dict[str, int]] = {
        (first_day + timedelta(days=index)).isoformat(): {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "cached_tokens": 0,
        }
        for index in range(_PERIOD_DAYS)
    }
    models: dict[tuple[str, str], dict[str, int]] = {}

    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT created_at, provider, model, prompt_tokens, completion_tokens, cached_tokens
            FROM model_usage
            WHERE created_at >= ?
            ORDER BY created_at DESC
            """,
            (int(start_utc.timestamp()),),
        ).fetchall()

    for row in rows:
        local_date = (
            datetime.fromtimestamp(row["created_at"], timezone.utc) + offset
        ).date().isoformat()
        prompt_tokens = row["prompt_tokens"]
        completion_tokens = row["completion_tokens"]
        cached_tokens = row["cached_tokens"]
        if local_date in daily:
            daily[local_date]["prompt_tokens"] += prompt_tokens
            daily[local_date]["completion_tokens"] += completion_tokens
            daily[local_date]["cached_tokens"] += cached_tokens
        item = models.setdefault(
            (row["provider"], row["model"]),
            {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "cached_tokens": 0,
                "request_count": 0,
            },
        )
        item["prompt_tokens"] += prompt_tokens
        item["completion_tokens"] += completion_tokens
        item["cached_tokens"] += cached_tokens
        item["request_count"] += 1

    daily_items = [
        {
            "date": day,
            **values,
            "total_tokens": values["prompt_tokens"] + values["completion_tokens"],
        }
        for day, values in daily.items()
    ]
    by_model = [
        {
            "provider": provider,
            "model": model,
            **values,
            "total_tokens": values["prompt_tokens"] + values["completion_tokens"],
        }
        for (provider, model), values in sorted(
            models.items(),
            key=lambda item: (
                -(item[1]["prompt_tokens"] + item[1]["completion_tokens"]),
                item[0],
            ),
        )
    ]
    recent = [
        {
            "provider": row["provider"],
            "model": row["model"],
            "prompt_tokens": row["prompt_tokens"],
            "completion_tokens": row["completion_tokens"],
            "cached_tokens": row["cached_tokens"],
            "total_tokens": row["prompt_tokens"] + row["completion_tokens"],
            "created_at": datetime.fromtimestamp(
                row["created_at"], timezone.utc
            ).isoformat(),
        }
        for row in rows[:20]
    ]
    period_tokens = sum(item["total_tokens"] for item in daily_items)

    return {
        "period_days": _PERIOD_DAYS,
        "today_tokens": next(
            item["total_tokens"] for item in daily_items if item["date"] == today.isoformat()
        ),
        "period_tokens": period_tokens,
        "request_count": len(rows),
        "model_count": len(by_model),
        "provider_count": len({item["provider"] for item in by_model}),
        "daily": daily_items,
        "by_model": by_model,
        "recent": recent,
        "updated_at": current.isoformat(),
    }
