"""SQLite persistence for accessed intraday snapshots.

This database is deliberately separate from ``watchlist.json``.  A snapshot
row stores the complete validated contract for fast recovery; the point table
keeps a normalized, de-duplicated archive for the viewed minutes.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from mona.services.stock.intraday import IntradaySeries
from mona.services.stock.provenance import CN_TZ

logger = logging.getLogger(__name__)


class IntradayStore:
    """Thread-safe SQLite store with one connection per store instance."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "intraday.sqlite3"
        self._lock = threading.RLock()
        self._closed = False
        self._connection: sqlite3.Connection | None = None
        try:
            self._initialize_database()
        except sqlite3.DatabaseError as initialization_error:
            logger.warning(
                "Initial intraday database initialization failed; quarantining files: %s",
                initialization_error,
            )
            self._close_connection()
            self._quarantine_database_files()
            try:
                self._initialize_database()
            except BaseException:
                self._close_connection()
                raise
        except BaseException:
            self._close_connection()
            raise

    def _initialize_database(self) -> None:
        self._connection = sqlite3.connect(
            self.path,
            timeout=5.0,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA busy_timeout=5000")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS intraday_snapshots (
                  instrument_id TEXT PRIMARY KEY,
                  trading_date TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS intraday_points (
                  instrument_id TEXT NOT NULL,
                  trading_date TEXT NOT NULL,
                  time TEXT NOT NULL,
                  open REAL NOT NULL,
                  high REAL NOT NULL,
                  low REAL NOT NULL,
                  close REAL NOT NULL,
                  price REAL NOT NULL,
                  average REAL NOT NULL,
                  volume REAL NOT NULL,
                  amount REAL NOT NULL,
                  source TEXT NOT NULL,
                  received_at TEXT NOT NULL,
                  PRIMARY KEY (instrument_id, trading_date, time)
                );
                """
            )
            self._connection.commit()

    def _close_connection(self) -> None:
        connection = self._connection
        self._connection = None
        if connection is not None:
            try:
                connection.close()
            except sqlite3.DatabaseError as close_error:
                logger.warning("Failed to close failed intraday database connection: %s", close_error)

    def _quarantine_database_files(self) -> None:
        suffix = f".corrupt-{datetime.now(CN_TZ).strftime('%Y%m%dT%H%M%S%f')}"
        for path in (
            self.path,
            Path(f"{self.path}-wal"),
            Path(f"{self.path}-shm"),
        ):
            if not path.exists():
                continue
            backup = Path(f"{path}{suffix}")
            path.replace(backup)
            logger.warning("Quarantined corrupt intraday database file %s as %s", path, backup)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("intraday store is closed")

    def upsert(self, series: IntradaySeries) -> None:
        """Atomically replace the latest snapshot and upsert its minute points."""

        payload = json.dumps(
            series.model_dump(by_alias=True, mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        received_at = datetime.now(CN_TZ).isoformat()
        with self._lock:
            self._ensure_open()
            try:
                self._connection.execute("BEGIN")
                self._connection.executemany(
                    """
                    INSERT INTO intraday_points
                      (instrument_id, trading_date, time, open, high, low, close,
                       price, average, volume, amount, source, received_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(instrument_id, trading_date, time) DO UPDATE SET
                      open=excluded.open, high=excluded.high, low=excluded.low,
                      close=excluded.close, price=excluded.price,
                      average=excluded.average, volume=excluded.volume,
                      amount=excluded.amount, source=excluded.source,
                      received_at=excluded.received_at
                    """,
                    [
                        (
                            series.instrument_id,
                            series.trading_date,
                            point.time,
                            point.open,
                            point.high,
                            point.low,
                            point.close,
                            point.price,
                            point.average,
                            point.volume,
                            point.amount,
                            series.source.provider,
                            received_at,
                        )
                        for point in series.points
                    ],
                )
                self._connection.execute(
                    """
                    INSERT INTO intraday_snapshots
                      (instrument_id, trading_date, updated_at, payload)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(instrument_id) DO UPDATE SET
                      trading_date=excluded.trading_date,
                      updated_at=excluded.updated_at,
                      payload=excluded.payload
                    """,
                    (series.instrument_id, series.trading_date, received_at, payload),
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def load_latest(self, instrument_id: str) -> IntradaySeries | None:
        with self._lock:
            self._ensure_open()
            row = self._connection.execute(
                "SELECT payload FROM intraday_snapshots WHERE instrument_id = ?",
                (instrument_id,),
            ).fetchone()
        if row is None:
            return None
        try:
            return IntradaySeries.model_validate(json.loads(row["payload"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            return None

    def point_count(self, instrument_id: str, trading_date: str) -> int:
        """Small diagnostic helper used by storage tests and health checks."""
        with self._lock:
            self._ensure_open()
            row = self._connection.execute(
                """
                SELECT COUNT(*) AS count FROM intraday_points
                WHERE instrument_id = ? AND trading_date = ?
                """,
                (instrument_id, trading_date),
            ).fetchone()
        return int(row["count"] if row else 0)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._connection.commit()
            self._connection.close()
            self._closed = True


__all__ = ["IntradayStore"]
