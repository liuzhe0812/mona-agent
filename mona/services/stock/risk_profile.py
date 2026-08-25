"""Local-only V6 risk profile and manual holding-context storage."""

from __future__ import annotations

import json
import os
import re
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from filelock import FileLock
from filelock import Timeout as FileLockTimeout

from mona.services.stock.schemas import V6PortfolioContext, V6RiskProfile

STORE_SCHEMA_VERSION = 1
DEFAULT_PROFILE_NAME = "conservative_default"
RISK_PROFILE_FILENAME = "risk_profile.json"
_INSTRUMENT_KEY = re.compile(r"(?:XSHG|XSHE|BJSE):\d{6}\Z")
_FUNDS_RANGES = {
    "under_100k": (0.0, 100_000.0),
    "100k_500k": (100_000.0, 500_000.0),
    "500k_2m": (500_000.0, 2_000_000.0),
    "over_2m": (2_000_000.0, float("inf")),
}
_STORE_FIELDS = frozenset({"schema_version", "risk_profile", "portfolio_contexts"})

DISPLAY_METADATA: dict[str, Any] = {
    "risk_profile": {
        "supported_fields": [
            {"key": "profile_name", "label": "配置名称", "unit": None},
            {"key": "risk_level", "label": "风险等级", "unit": None},
            {"key": "max_drawdown_tolerance_pct", "label": "最大回撤容忍度", "unit": "%"},
            {"key": "total_funds_range", "label": "资金规模区间", "unit": None},
            {"key": "risk_budget_pct", "label": "单笔风险上限", "unit": "%"},
            {"key": "max_single_position_pct", "label": "单股仓位上限", "unit": "%"},
            {"key": "max_industry_exposure_pct", "label": "行业暴露上限", "unit": "%"},
            {"key": "max_correlated_exposure_pct", "label": "相关暴露上限", "unit": "%"},
        ],
        "future_fields": [],
    },
    "portfolio_context": {
        "supported_fields": [
            {"key": "position_input_mode", "label": "持仓录入方式", "unit": None},
            {"key": "portfolio_value_yuan", "label": "总资产", "unit": "元"},
            {"key": "holding_quantity", "label": "持有股数", "unit": "股"},
            {"key": "current_position_pct", "label": "当前仓位", "unit": "%"},
        ],
        "future_fields": [],
    },
}


class RiskProfileStorageError(RuntimeError):
    """The local risk store is unreadable or cannot be updated safely."""


def _default_profile() -> V6RiskProfile:
    return V6RiskProfile.conservative_default()


def _default_context() -> V6PortfolioContext:
    return V6PortfolioContext()


def _instrument_key(value: str) -> str:
    if not isinstance(value, str) or _INSTRUMENT_KEY.fullmatch(value) is None:
        raise ValueError("instrument key must match EXCHANGE:123456")
    return value


def _copy_profile(value: V6RiskProfile) -> V6RiskProfile:
    return value.model_copy(deep=True)


def _copy_context(value: V6PortfolioContext) -> V6PortfolioContext:
    return value.model_copy(deep=True)


def _normalize_portfolio_context(context: V6PortfolioContext) -> V6PortfolioContext:
    """Normalize user input without changing the readable legacy model."""
    updates: dict[str, Any] = {
        "holding_state": (
            "holding" if context.current_position_pct > 0 else "not_holding"
        ),
        "industry_exposure_pct": 0.0,
        "correlated_exposure_pct": 0.0,
        "today_bought_quantity": None,
        "holding_cost": None,
    }
    if context.position_input_mode == "percentage":
        updates.update(portfolio_value_yuan=None, holding_quantity=None)
    else:
        if context.portfolio_value_yuan is None:
            raise ValueError(
                "assets_shares mode requires portfolio_value_yuan greater than 0"
            )
        if context.holding_quantity is None:
            raise ValueError(
                "assets_shares mode requires holding_quantity as a non-negative integer"
            )
        if "current_position_pct" not in context.model_fields_set:
            raise ValueError(
                "assets_shares mode requires current_position_pct calculated by the client"
            )
        if context.holding_quantity == 0 and context.current_position_pct != 0:
            raise ValueError("holding_quantity=0 requires current_position_pct=0")
        if context.holding_quantity > 0 and context.current_position_pct <= 0:
            raise ValueError(
                "holding_quantity greater than 0 requires current_position_pct greater than 0"
            )
    return context.model_copy(update=updates, deep=True)


class LocalRiskProfileStore:
    """Persist one local risk profile and per-instrument manual contexts.

    The file contains no broker credentials, account identifiers or fetched
    private balances.  A missing file is the unconfigured conservative
    default and is intentionally not created until the user explicitly saves
    something.
    """

    def __init__(self, path: str | Path, *, lock_timeout_seconds: float = 5.0):
        self.path = Path(path)
        self.lock_path = self.path.with_name(self.path.name + ".lock")
        self.lock_timeout_seconds = lock_timeout_seconds

    @contextmanager
    def _locked(self) -> Iterator[None]:
        try:
            self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RiskProfileStorageError("risk profile store directory cannot be created") from exc
        lock = FileLock(str(self.lock_path), timeout=self.lock_timeout_seconds)
        try:
            with lock:
                yield
        except FileLockTimeout as exc:
            raise RiskProfileStorageError("risk profile store is locked") from exc

    def _read_unlocked(self) -> tuple[V6RiskProfile | None, dict[str, V6PortfolioContext]]:
        if not self.path.exists():
            return None, {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RiskProfileStorageError(
                f"risk profile store cannot be read: {self.path}"
            ) from exc
        if not isinstance(raw, dict) or set(raw) - _STORE_FIELDS:
            raise RiskProfileStorageError("risk profile store has an invalid shape")
        if raw.get("schema_version") != STORE_SCHEMA_VERSION:
            raise RiskProfileStorageError("risk profile store schema version is unsupported")
        try:
            profile_raw = raw.get("risk_profile")
            profile = (
                V6RiskProfile.model_validate(profile_raw)
                if profile_raw is not None
                else None
            )
            contexts_raw = raw.get("portfolio_contexts", {})
            if not isinstance(contexts_raw, dict):
                raise ValueError("portfolio_contexts must be an object")
            contexts: dict[str, V6PortfolioContext] = {}
            for key, value in contexts_raw.items():
                instrument = _instrument_key(key)
                contexts[instrument] = V6PortfolioContext.model_validate(value)
        except (TypeError, ValueError) as exc:
            raise RiskProfileStorageError("risk profile store contains invalid data") from exc
        return profile, contexts

    def _write_unlocked(
        self,
        profile: V6RiskProfile | None,
        contexts: Mapping[str, V6PortfolioContext],
    ) -> None:
        payload = {
            "schema_version": STORE_SCHEMA_VERSION,
            "risk_profile": profile.model_dump(mode="json") if profile else None,
            "portfolio_contexts": {
                key: context.model_dump(mode="json")
                for key, context in sorted(contexts.items())
            },
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except (OSError, UnicodeError) as exc:
            temporary.unlink(missing_ok=True)
            raise RiskProfileStorageError("risk profile store cannot be written") from exc

    def get_risk_profile(self) -> V6RiskProfile:
        with self._locked():
            profile, _ = self._read_unlocked()
        return _copy_profile(profile if profile is not None else _default_profile())

    def save_risk_profile(
        self, profile: V6RiskProfile | Mapping[str, Any]
    ) -> V6RiskProfile:
        try:
            candidate = (
                profile
                if isinstance(profile, V6RiskProfile)
                else V6RiskProfile.model_validate(profile)
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("risk profile is invalid") from exc
        # configured=True is evidence that this method was explicitly called;
        # it is never inferred from merely reading the conservative default.
        candidate = candidate.model_copy(update={"configured": True}, deep=True)
        with self._locked():
            _, contexts = self._read_unlocked()
            self._write_unlocked(candidate, contexts)
        return _copy_profile(candidate)

    def clear_risk_profile(self) -> V6RiskProfile:
        with self._locked():
            _, contexts = self._read_unlocked()
            if contexts:
                self._write_unlocked(None, contexts)
            else:
                self.path.unlink(missing_ok=True)
        return _default_profile()

    def get_portfolio_context(self, instrument_id: str) -> V6PortfolioContext:
        key = _instrument_key(instrument_id)
        with self._locked():
            _, contexts = self._read_unlocked()
        return _copy_context(contexts.get(key, _default_context()))

    def save_portfolio_context(
        self,
        instrument_id: str,
        context: V6PortfolioContext | Mapping[str, Any],
    ) -> V6PortfolioContext:
        key = _instrument_key(instrument_id)
        try:
            candidate = (
                context
                if isinstance(context, V6PortfolioContext)
                else V6PortfolioContext.model_validate(context)
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("portfolio context is invalid") from exc
        candidate = _normalize_portfolio_context(candidate)
        with self._locked():
            profile, contexts = self._read_unlocked()
            if (
                profile is not None
                and profile.total_funds_range is not None
                and candidate.portfolio_value_yuan is not None
            ):
                low, high = _FUNDS_RANGES[profile.total_funds_range]
                if not low <= candidate.portfolio_value_yuan < high:
                    raise ValueError("portfolio_value_yuan does not match total_funds_range")
            contexts[key] = _copy_context(candidate)
            self._write_unlocked(profile, contexts)
        return _copy_context(candidate)

    def delete_portfolio_context(self, instrument_id: str) -> V6PortfolioContext:
        key = _instrument_key(instrument_id)
        with self._locked():
            profile, contexts = self._read_unlocked()
            contexts.pop(key, None)
            if profile is None and not contexts:
                self.path.unlink(missing_ok=True)
            else:
                self._write_unlocked(profile, contexts)
        return _default_context()

    def list_portfolio_contexts(self) -> dict[str, V6PortfolioContext]:
        with self._locked():
            _, contexts = self._read_unlocked()
        return {key: _copy_context(value) for key, value in contexts.items()}

    @staticmethod
    def display_metadata() -> dict[str, Any]:
        """Return immutable display/API metadata without reading user data."""
        return json.loads(json.dumps(DISPLAY_METADATA, ensure_ascii=False))


RiskProfileStore = LocalRiskProfileStore


def risk_profile_path(workspace: str | Path) -> Path:
    """Return the single local store path used by API and research runs."""
    return Path(workspace).expanduser() / "stock" / RISK_PROFILE_FILENAME
