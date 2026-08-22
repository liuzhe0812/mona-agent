"""Watchlist storage for the stock module (design §7.1, §9, §13).

The watchlist is workspace-independent user data stored at
``~/.mona/stock/watchlist.json`` — it never enters ``config.json``.
Writes are atomic (temp file + flush + ``os.replace``) and guarded by a
process-local lock.

Instruments are identified as ``exchange:symbol`` (e.g. ``XSHG:600519``);
``instrument_type`` (``equity`` / ``etf``) is mandatory because equity and
ETF follow different research templates.
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator

from mona.config.schema import Base

CN_TZ = timezone(timedelta(hours=8))  # Asia/Shanghai (fixed offset, no DST)

_EXCHANGES = ("XSHG", "XSHE", "BJSE")


class WatchlistCorruptError(ValueError):
    """Raised when ``watchlist.json`` exists but cannot be parsed."""


def infer_exchange(symbol: str) -> str:
    """Infer the exchange from a bare 6-digit A-share code.

    6xxxxx → XSHG, 0xxxxx/3xxxxx → XSHE, 8xxxxx/4xxxxx → BJSE.
    """
    if len(symbol) != 6 or not symbol.isdigit():
        raise ValueError(f"invalid symbol {symbol!r}: expect 6 digits")
    head = symbol[0]
    if head == "6":
        return "XSHG"
    if head in ("0", "3"):
        return "XSHE"
    if head in ("8", "4"):
        return "BJSE"
    raise ValueError(f"cannot infer exchange for symbol {symbol!r}")


class WatchlistItem(Base):
    """One watched instrument."""

    symbol: str = Field(pattern=r"^\d{6}$")
    exchange: str
    name: str = ""
    instrument_type: Literal["equity", "etf"]
    focus: bool = False  # 重点标的 — review scope may be limited to these (§5.3)
    added_at: str = ""  # ISO timestamp, filled by the store when empty

    @field_validator("exchange")
    @classmethod
    def _check_exchange(cls, v: str) -> str:
        if v not in _EXCHANGES:
            raise ValueError(f"unknown exchange {v!r}")
        return v

    @property
    def id(self) -> str:
        return f"{self.exchange}:{self.symbol}"


@dataclass
class ImportResult:
    imported: int = 0
    skipped: int = 0  # duplicates (existing file or within the import text)
    errors: list[str] = field(default_factory=list)


class WatchlistStore:
    """CRUD for ``<root>/watchlist.json``."""

    SCHEMA_VERSION = 1

    def __init__(self, root: Path):
        self.root = Path(root)
        self.path = self.root / "watchlist.json"
        self._lock = threading.Lock()

    def load(self) -> list[WatchlistItem]:
        """Load the watchlist; missing file means an empty list.

        A present-but-unparseable file raises :class:`WatchlistCorruptError`
        with the underlying cause chained, instead of an obscure crash.
        """
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return [WatchlistItem.model_validate(i) for i in data["items"]]
        except Exception as exc:
            raise WatchlistCorruptError(f"cannot load watchlist {self.path}: {exc}") from exc

    def list(self) -> list[WatchlistItem]:
        return self.load()

    def add(self, item: WatchlistItem) -> list[WatchlistItem]:
        """Add an item, de-duplicated by ``exchange:symbol``. Returns the list."""
        with self._lock:
            items = self.load()
            if any(i.id == item.id for i in items):
                return items
            if not item.added_at:
                item = item.model_copy(update={"added_at": datetime.now(CN_TZ).isoformat()})
            items.append(item)
            self._save(items)
            return items

    def remove(self, instrument_id: str) -> bool:
        with self._lock:
            items = self.load()
            rest = [i for i in items if i.id != instrument_id]
            if len(rest) == len(items):
                return False
            self._save(rest)
            return True

    def set_focus(self, instrument_id: str, focus: bool) -> bool:
        with self._lock:
            items = self.load()
            for idx, item in enumerate(items):
                if item.id == instrument_id:
                    items[idx] = item.model_copy(update={"focus": focus})
                    self._save(items)
                    return True
            return False

    def reorder(self, instrument_ids: list[str]) -> bool:
        """Reorder items to match ``instrument_ids`` (a permutation of the
        current ids). Returns False when ids don't exactly cover the list —
        the caller then reloads instead of writing a lossy order."""
        with self._lock:
            items = self.load()
            if set(instrument_ids) != {i.id for i in items} or len(instrument_ids) != len(items):
                return False
            by_id = {i.id: i for i in items}
            self._save([by_id[i] for i in instrument_ids])
            return True

    def import_csv(self, text: str) -> ImportResult:
        """Import ``code[,name[,instrument_type]]`` lines (CSV / clipboard paste).

        Bare 6-digit codes get the exchange inferred via :func:`infer_exchange`;
        ``EXCHANGE:symbol`` is accepted as-is. Blank lines and ``#`` comments
        are skipped; bad lines are reported, never silently dropped.
        """
        result = ImportResult()
        with self._lock:
            items = self.load()
            seen = {i.id for i in items}
            for lineno, raw in enumerate(text.splitlines(), start=1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [p.strip() for p in re.split(r"[,，\t]", line) if p.strip()]
                try:
                    item = self._parse_line(parts)
                except ValueError as exc:
                    result.errors.append(f"line {lineno}: {exc}")
                    continue
                if item.id in seen:
                    result.skipped += 1
                    continue
                seen.add(item.id)
                items.append(
                    item.model_copy(update={"added_at": datetime.now(CN_TZ).isoformat()})
                )
                result.imported += 1
            if result.imported:
                self._save(items)
        return result

    @staticmethod
    def _parse_line(parts: list[str]) -> WatchlistItem:
        if not parts:
            raise ValueError("empty line")
        code, name = parts[0], parts[1] if len(parts) > 1 else ""
        instrument_type = parts[2] if len(parts) > 2 else "equity"
        if ":" in code:
            exchange, symbol = code.split(":", 1)
            exchange = exchange.upper()
        else:
            symbol = code
            exchange = infer_exchange(symbol)
        return WatchlistItem(
            symbol=symbol,
            exchange=exchange,
            name=name,
            instrument_type=instrument_type,  # type: ignore[arg-type]
        )

    def _save(self, items: list[WatchlistItem]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": self.SCHEMA_VERSION,
            "items": [i.model_dump(by_alias=True) for i in items],
        }
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
        os.replace(tmp, self.path)
