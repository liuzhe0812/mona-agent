"""Daily-review cron support (stock-module design §11, dev plan T20).

Three pieces shared by the gateway's cron branch:

- :func:`is_trading_day` — trading-day gate derived from the SH index daily
  bars. Calendar failure raises :class:`TradingCalendarUnavailableError`;
  the caller converts it into a ``CronSkip`` — never a weekday-guess
  fallback (design §11).
- :func:`guard_review_run` — the pre-dispatch gate: trading-day check plus
  watchlist load. Returns the ``exchange:symbol`` ids that ride into the
  run as ``inputs.symbols``; raises ``CronSkip`` for non-trading days,
  unavailable calendars, or an empty watchlist.
- :func:`notify_review_complete` — post-run fan-out: desktop notification
  via the services process's schedule-notification queue (the same channel
  the Tauri side already polls), plus an optional digest email through the
  ``channels.email`` SMTP config. Notification failures are logged, never
  raised — the run itself already succeeded.
"""

from __future__ import annotations

import asyncio
import smtplib
import ssl
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from loguru import logger

from mona.channels.email import EmailConfig
from mona.cron.service import CronSkip
from mona.schedule.client import ScheduleServiceClient
from mona.services.stock.evidence import (
    SH_INDEX,
    TradingCalendarUnavailableError,
)
from mona.services.stock.provenance import CN_TZ
from mona.services.stock.provider import EastMoneyProvider
from mona.services.stock.storage import WatchlistStore

CALENDAR_LOOKBACK_BARS = 10


def _default_watchlist_root() -> Path:
    """Global watchlist root (``~/.mona/stock``); tests rebind it."""
    return Path.home() / ".mona" / "stock"


def review_watchlist_symbols(
    root: Path | None = None, *, scope: str = "all"
) -> list[str]:
    """Current watchlist as ``exchange:symbol`` ids, in watchlist order.

    ``scope="focus"`` keeps only focus-marked instruments (design §11) —
    the review never silently widens beyond the configured scope.
    """
    store = WatchlistStore(root or _default_watchlist_root())
    items = store.list()
    if scope == "focus":
        items = [i for i in items if i.focus]
    return [item.id for item in items]


def should_catch_up_review(
    *,
    now: datetime | None = None,
    review_time: str,
    stock_output_dir: Path | None,
) -> bool:
    """True when today's review window has passed with no digest yet.

    Powers the gateway-start catch-up (design §11: a machine powered off
    at ``review_time`` recovers the day's review on next start). A
    ``daily_review`` digest dated today means the cron already ran — a
    ``deep_research`` report never blocks the catch-up.
    """
    now = now or datetime.now(CN_TZ)
    hour_s, minute_s = review_time.split(":")
    scheduled = now.replace(hour=int(hour_s), minute=int(minute_s), second=0, microsecond=0)
    if now < scheduled:
        return False
    if stock_output_dir is None:
        return True
    today = now.date().isoformat()
    from mona.services.stock.reports import scan_reports

    for item in scan_reports(Path(stock_output_dir)):
        if item.get("kind") != "daily_review":
            continue
        if str(item.get("asOf") or "")[:10] == today:
            return False  # today's digest exists — already reviewed
    return True


async def is_trading_day(provider: Any, *, now: datetime | None = None) -> bool:
    """True when ``now``'s date (Asia/Shanghai) has an SH index daily bar."""
    now = now or datetime.now(CN_TZ)
    try:
        series = await provider.kline(SH_INDEX, limit=CALENDAR_LOOKBACK_BARS)
    except Exception as exc:
        raise TradingCalendarUnavailableError(
            f"trading calendar fetch failed: {exc}"
        ) from exc
    dates = {b.date for b in series.bars}
    if not dates:
        raise TradingCalendarUnavailableError("trading calendar is empty")
    return now.date().isoformat() in dates


async def guard_review_run(
    *,
    provider: Any | None = None,
    watchlist_root: Path | None = None,
    scope: str = "all",
    now: datetime | None = None,
) -> list[str]:
    """Gate the daily-review cron; returns the review symbols.

    Raises :class:`CronSkip` so the cron history records an explicit skip —
    non-trading day, calendar unavailable, or nothing to review. With
    ``scope="focus"`` a watchlist lacking focus-marked items also skips.
    """
    provider = provider if provider is not None else EastMoneyProvider()
    try:
        trading = await is_trading_day(provider, now=now)
    except TradingCalendarUnavailableError as exc:
        raise CronSkip(f"daily review skipped: trading calendar unavailable ({exc})") from exc
    if not trading:
        raise CronSkip("daily review skipped: non-trading day")
    symbols = review_watchlist_symbols(watchlist_root, scope=scope)
    if not symbols:
        if scope == "focus":
            raise CronSkip("daily review skipped: no focus-marked instruments")
        raise CronSkip("daily review skipped: watchlist is empty")
    return symbols


async def notify_review_complete(
    config: Any, *, run_id: str, symbols: list[str]
) -> None:
    """Fan out the succeeded review run per ``StockConfig`` (design §11).

    The desktop click payload (``open-stock`` + ``runId``) lands on the
    StockView digest of this run — never a second task-detail page.
    """
    stock = config.stock
    date_str = datetime.now(CN_TZ).strftime("%Y-%m-%d")
    title = f"每日复盘完成 {date_str}"
    body = f"已覆盖 {len(symbols)} 只自选股，点击查看复盘简报"
    if stock.push_notification:
        await _push_desktop_notification(config, title=title, body=body, run_id=run_id)
    if stock.push_email:
        await _send_digest_email(config, date_str=date_str, run_id=run_id, fallback=body)


async def notify_review_failed(
    config: Any, *, run_id: str, symbols: list[str]
) -> None:
    """Fan out a failed review run (design §11: 用户永远不错过交易日复盘).

    Same desktop click payload as success — the StockView shows the failed
    run and its step errors, so the user can retry from there. Email is
    intentionally not sent for failures: there is no digest to deliver.
    """
    stock = config.stock
    date_str = datetime.now(CN_TZ).strftime("%Y-%m-%d")
    title = f"每日复盘失败 {date_str}"
    body = f"覆盖 {len(symbols)} 只自选股的复盘未能完成，点击查看失败原因"
    if stock.push_notification:
        await _push_desktop_notification(config, title=title, body=body, run_id=run_id)


async def _push_desktop_notification(
    config: Any, *, title: str, body: str, run_id: str
) -> None:
    try:
        client = ScheduleServiceClient.from_port(config.services.port)
        await client.push_notification(
            title,
            body,
            click_action="open-stock",
            click_data={"runId": run_id},
        )
    except Exception as exc:
        logger.warning("Stock review desktop notification failed: {}", exc)


async def _send_digest_email(
    config: Any, *, date_str: str, run_id: str, fallback: str
) -> None:
    section = getattr(config.channels, "email", None)
    cfg = EmailConfig.model_validate(section) if isinstance(section, dict) else EmailConfig()
    if not (cfg.smtp_host and cfg.smtp_username):
        logger.warning("Stock review email skipped: channels.email SMTP not configured")
        return
    from mona.config.paths import get_stock_project_dir

    digest = get_stock_project_dir(config.workspace_path, run_id) / "digest.md"
    try:
        text = digest.read_text(encoding="utf-8")
    except OSError:
        logger.warning("Stock review digest {} not readable; sending summary", digest)
        text = fallback
    sender = cfg.from_address or cfg.smtp_username or cfg.imap_username
    recipient = cfg.from_address or cfg.imap_username or cfg.smtp_username
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = f"每日复盘 {date_str}"
    msg.set_content(text)
    try:
        await asyncio.to_thread(_smtp_send_sync, cfg, msg)
    except Exception as exc:
        logger.warning("Stock review email send failed: {}", exc)


def _smtp_send_sync(cfg: EmailConfig, msg: EmailMessage) -> None:
    """SMTP send mirroring ``EmailChannel._smtp_send`` (ssl / tls / plain)."""
    timeout = 30
    if cfg.smtp_use_ssl:
        with smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=timeout) as smtp:
            smtp.login(cfg.smtp_username, cfg.smtp_password)
            smtp.send_message(msg)
        return
    with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=timeout) as smtp:
        if cfg.smtp_use_tls:
            smtp.starttls(context=ssl.create_default_context())
        smtp.login(cfg.smtp_username, cfg.smtp_password)
        smtp.send_message(msg)
