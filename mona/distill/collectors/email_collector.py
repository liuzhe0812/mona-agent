"""Email data collector.

Aggregates email statistics directly from the email SQLite database.
Falls back gracefully if email DB is not present.
"""

from __future__ import annotations

import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from loguru import logger


@dataclass
class EmailStats:
    """Aggregated email statistics."""

    total_emails: int = 0
    total_senders: int = 0
    # Top senders: [{sender, name, count}]
    top_senders: list[dict[str, Any]] = field(default_factory=list)
    # Top subjects (for LLM context)
    top_subjects: list[str] = field(default_factory=list)
    # Emails per month: {YYYY-MM: count}
    monthly_distribution: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_emails": self.total_emails,
            "total_senders": self.total_senders,
            "top_senders": self.top_senders,
            "top_subjects": self.top_subjects,
            "monthly_distribution": self.monthly_distribution,
        }


def _find_email_db() -> Path | None:
    """Locate the email.sqlite3 database."""
    candidates: list[Path] = []
    # Windows: %APPDATA%/mona/email.sqlite3
    appdata = Path.home() / "AppData" / "Roaming" / "mona"
    candidates.append(appdata / "email.sqlite3")
    # Linux/macOS fallback
    xdg = Path.home() / ".local" / "share" / "mona"
    candidates.append(xdg / "email.sqlite3")
    for p in candidates:
        if p.exists() and p.stat().st_size > 0:
            return p
    return None


def _parse_month(rfc822_date: str) -> str | None:
    """Parse RFC822 date string and return YYYY-MM, or None on failure."""
    if not rfc822_date:
        return None
    try:
        dt = parsedate_to_datetime(rfc822_date)
        if dt is None:
            return None
        return dt.strftime("%Y-%m")
    except Exception:
        return None


def collect_email_stats(top_n: int = 15) -> EmailStats:
    """Aggregate email statistics directly from the SQLite database."""
    stats = EmailStats()
    db_path = _find_email_db()
    if db_path is None:
        logger.debug("[email_collector] email.sqlite3 not found")
        return stats

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as e:
        logger.warning(f"[email_collector] cannot open email DB: {e}")
        return stats

    try:
        # Total count
        row = conn.execute("SELECT COUNT(*) FROM messages").fetchone()
        stats.total_emails = row[0] if row else 0
        if stats.total_emails == 0:
            return stats

        # Own addresses (from configured accounts) — excluded from top senders
        own_addresses = {
            (r[0] or "").strip().lower()
            for r in conn.execute("SELECT from_address FROM accounts").fetchall()
            if r[0]
        }

        # Top senders (by address, prefer display name; skip self)
        sender_rows = conn.execute(
            "SELECT from_address, from_name, COUNT(*) AS c "
            "FROM messages GROUP BY from_address ORDER BY c DESC LIMIT ?",
            (top_n + len(own_addresses),),
        ).fetchall()
        seen_addresses: set[str] = set()
        for addr, name, count in sender_rows:
            if not addr or addr in seen_addresses:
                continue
            if addr.strip().lower() in own_addresses:
                continue
            seen_addresses.add(addr)
            label = name.strip() if name and name.strip() else addr
            stats.top_senders.append({"sender": label, "address": addr, "count": count})
            if len(stats.top_senders) >= top_n:
                break

        stats.total_senders = conn.execute(
            "SELECT COUNT(DISTINCT from_address) FROM messages"
        ).fetchone()[0]

        # Top subjects
        subject_rows = conn.execute(
            "SELECT subject FROM messages WHERE subject != '' ORDER BY date DESC LIMIT ?",
            (top_n,),
        ).fetchall()
        for (subject,) in subject_rows:
            s = (subject or "").strip()
            if s:
                stats.top_subjects.append(s)

        # Monthly distribution
        date_rows = conn.execute("SELECT date FROM messages").fetchall()
        month_counter: Counter[str] = Counter()
        for (date_str,) in date_rows:
            month = _parse_month(date_str or "")
            if month:
                month_counter[month] += 1
        stats.monthly_distribution = dict(sorted(month_counter.items()))

        logger.debug(
            f"[email_collector] {stats.total_emails} emails, "
            f"{stats.total_senders} senders, "
            f"{len(stats.monthly_distribution)} months"
        )
    except sqlite3.Error as e:
        logger.warning(f"[email_collector] query failed: {e}")
    finally:
        conn.close()

    return stats
