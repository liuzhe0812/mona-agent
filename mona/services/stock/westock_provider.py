"""Controlled, optional adapter for the external ``westock-data`` package.

The package is deliberately not a Mona dependency.  A caller must inject an
isolated runner (or an already imported package object) before this adapter can
do anything.  This keeps an uninstalled package a zero-request, zero-write
condition and makes fixtures and real canaries distinguishable.

Only structured command results cross this boundary.  The adapter validates
the command, package/contract version, instrument code, timestamps, numeric
types and declared units before creating a normal :class:`SourceRecord`.
``quote`` is intentionally unsupported until its output contract is stable.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import math
import os
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Mapping

from mona.services.stock.provenance import (
    CN_TZ,
    SourceRecord,
    normalize_asia_datetime,
    parse_asia_datetime,
)
from mona.services.stock.provider import InstrumentRef, ProviderError

# The SkillHub documentation and the package name have historically reported
# different versions.  We pin the package version used by this contract and
# reject any runtime drift instead of guessing which schema is in use.
WESTOCK_PACKAGE_NAME = "westock-data-skillhub"
WESTOCK_PACKAGE_VERSION = "1.0.5"
WESTOCK_CONTRACT_VERSION = "westock-contract-v2"
WESTOCK_COMMANDS = frozenset(
    {"profile", "asfund", "sector", "macro", "report", "notice", "chip", "technical"}
)
WESTOCK_COMMAND_ALIASES = {"finance": "asfund", "asfund": "asfund"}
WESTOCK_SUPPORTED_COMMANDS = frozenset({*WESTOCK_COMMANDS, "finance"})
ALLOWED_COMMANDS = WESTOCK_SUPPORTED_COMMANDS
WESTOCK_UNSUPPORTED_COMMANDS = frozenset({"quote"})

_FIELD_ALIASES = {
    "security_code": "code",
    "secu_code": "code",
    "secucode": "code",
    "stock_code": "code",
    "ts_code": "code",
    "证券代码": "code",
    "股票代码": "code",
    "security_name": "name",
    "security_name_abbr": "name",
    "证券简称": "name",
    "industry_name": "industry",
    "industryname": "industry",
    "行业": "industry",
    "行业名称": "industry",
    "industrycode": "industry_code",
    "行业代码": "industry_code",
    "report_date": "report_period",
    "reportdate": "report_period",
    "报告期": "report_period",
    "publish_date": "published_at",
    "publishdate": "published_at",
    "公告日期": "published_at",
    "公告标题": "title",
    "公告链接": "url",
    "roe_jq": "roe",
    "roejq": "roe",
    "净资产收益率": "roe",
    "roic": "roic",
    "毛利率": "gross_margin",
    "净利率": "net_margin",
    "营收同比": "revenue_yoy",
    "净利润同比": "profit_yoy",
    "营业收入": "revenue",
    "净利润": "net_profit",
    "经营现金流": "operating_cashflow",
    "资产负债率": "debt_ratio",
    "资本开支": "capex",
    "市盈率": "pe",
    "市净率": "pb",
}


class WeStockError(ProviderError):
    """Base error for an invalid or unavailable optional supplement."""


class WeStockUnavailableError(WeStockError):
    """The optional package/runner is not installed or was not enabled."""


class WeStockTimeoutError(WeStockError):
    """The isolated command exceeded its configured timeout."""


class WeStockVersionDriftError(WeStockError):
    """The runtime package version differs from the fixed contract version."""


class WeStockSchemaError(WeStockError):
    """A command returned a shape not covered by the fixed output schema."""


class WeStockFieldError(WeStockSchemaError):
    """A response field has an invalid type, unit, or instrument code."""


class WeStockUnsupportedCommandError(WeStockError):
    """The command is outside the controlled first-batch contract."""


@dataclass(frozen=True)
class WeStockCommandSpec:
    """Small, inspectable description of one controlled command."""

    command: str
    requires_instrument: bool
    numeric_fields: frozenset[str] = frozenset()
    date_fields: frozenset[str] = frozenset()
    required_fields: frozenset[str] = frozenset()
    allowed_units: Mapping[str, frozenset[str]] | None = None


_PERCENT_UNITS = frozenset({"%", "percent", "percentage", "pct", "pp"})
_CURRENCY_UNITS = frozenset({"cny", "rmb", "yuan", "元", "万元", "亿元"})
_RATIO_UNITS = frozenset({"ratio", "x", "times", "multiple"})
_SHARE_UNITS = frozenset({"cny/share", "rmb/share", "元/股", "share"})

_COMMON_DATE_FIELDS = frozenset(
    {
        "as_of",
        "data_as_of",
        "updated_at",
        "update_time",
        "published_at",
        "publish_time",
        "notice_date",
        "report_period",
        "period_end",
    }
)

_COMMAND_SPECS: dict[str, WeStockCommandSpec] = {
    "profile": WeStockCommandSpec(
        command="profile",
        requires_instrument=True,
        required_fields=frozenset({"industry", "name", "company_name", "main_business"}),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "asfund": WeStockCommandSpec(
        command="asfund",
        requires_instrument=True,
        required_fields=frozenset(
            {
                "report_period",
                "period_end",
                "eps",
                "roe",
                "roic",
                "gross_margin",
                "net_margin",
                "revenue",
                "revenue_yoy",
                "net_profit",
                "profit_yoy",
                "operating_cashflow",
                "debt_ratio",
                "capex",
                "pe",
                "pb",
            }
        ),
        numeric_fields=frozenset(
            {
                "eps",
                "roe",
                "roic",
                "gross_margin",
                "net_margin",
                "revenue",
                "revenue_yoy",
                "net_profit",
                "profit_yoy",
                "operating_cashflow",
                "cashflow_to_profit",
                "debt_ratio",
                "capex",
                "pe",
                "pb",
                "interest_coverage",
                "current_ratio",
            }
        ),
        date_fields=_COMMON_DATE_FIELDS,
        allowed_units={
            "roe": _PERCENT_UNITS,
            "roic": _PERCENT_UNITS,
            "gross_margin": _PERCENT_UNITS,
            "net_margin": _PERCENT_UNITS,
            "revenue_yoy": _PERCENT_UNITS,
            "profit_yoy": _PERCENT_UNITS,
            "debt_ratio": _PERCENT_UNITS,
            "eps": _SHARE_UNITS,
            "pe": _RATIO_UNITS,
            "pb": _RATIO_UNITS,
            "revenue": _CURRENCY_UNITS,
            "net_profit": _CURRENCY_UNITS,
            "operating_cashflow": _CURRENCY_UNITS,
            "capex": _CURRENCY_UNITS,
        },
    ),
    "sector": WeStockCommandSpec(
        command="sector",
        requires_instrument=True,
        required_fields=frozenset({"sector", "industry", "industry_name", "industry_code"}),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "macro": WeStockCommandSpec(
        command="macro",
        requires_instrument=False,
        numeric_fields=frozenset({"value", "yoy", "mom", "m2_yoy", "social_financing_yoy"}),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "report": WeStockCommandSpec(
        command="report",
        requires_instrument=True,
        required_fields=frozenset({"title", "published_at", "report_period", "url"}),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "notice": WeStockCommandSpec(
        command="notice",
        requires_instrument=True,
        required_fields=frozenset({"title", "published_at", "notice_date", "url"}),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "chip": WeStockCommandSpec(
        command="chip",
        requires_instrument=True,
        numeric_fields=frozenset(
            {"turnover_rate", "concentration", "profit_ratio", "average_cost", "holder_count"}
        ),
        date_fields=_COMMON_DATE_FIELDS,
    ),
    "technical": WeStockCommandSpec(
        command="technical",
        requires_instrument=True,
        numeric_fields=frozenset(
            {
                "ma5",
                "ma10",
                "ma20",
                "ma60",
                "rsi14",
                "macd",
                "dif",
                "dea",
                "hist",
                "momentum20",
                "momentum60",
                "volatility20",
                "volume_change_pct",
            }
        ),
        date_fields=_COMMON_DATE_FIELDS,
    ),
}


class WeStockResult(dict):
    """Validated result with both mapping and attribute-style access.

    Mapping compatibility keeps the adapter convenient for Evidence fixtures,
    while the explicit properties make it difficult to accidentally lose
    provenance metadata.
    """

    def __init__(
        self,
        *,
        command: str,
        instrument_id: str | None,
        package_name: str,
        package_version: str,
        contract_version: str,
        data: dict[str, Any] | list[Any],
        data_as_of: str | None,
        fetched_at: str,
        cache_status: Literal["live", "fresh_cache"],
        raw_output_hash: str,
        fields: list[str],
        source: SourceRecord,
        validation_mode: Literal["fixture", "real_canary", "unknown"] = "unknown",
    ) -> None:
        super().__init__(
            command=command,
            instrument_id=instrument_id,
            package_name=package_name,
            package_version=package_version,
            contract_version=contract_version,
            data=data,
            data_as_of=data_as_of,
            fetched_at=fetched_at,
            cache_status=cache_status,
            raw_output_hash=raw_output_hash,
            fields=list(fields),
            source=source,
            source_ids=[source.id],
            validation_mode=validation_mode,
        )

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:  # pragma: no cover - normal AttributeError semantics
            raise AttributeError(name) from exc

    def model_dump(self, *_, **__) -> dict[str, Any]:
        """Pydantic-like helper used by existing Evidence serialization code."""
        value = dict(self)
        source = value.get("source")
        if isinstance(source, SourceRecord):
            value["source"] = source.model_dump()
        return value


@dataclass(frozen=True)
class WeStockCapability:
    """One row of the explicit fixture/canary capability matrix."""

    command: str
    status: Literal["canary_verified", "fixture_only", "not_installed", "unsupported"]
    real_canary: bool
    fixture_contract: bool
    note: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "status": self.status,
            "real_canary": self.real_canary,
            "fixture_contract": self.fixture_contract,
            "note": self.note,
        }


def _canonical_command(command: str) -> str:
    normalized = str(command or "").strip().lower()
    normalized = WESTOCK_COMMAND_ALIASES.get(normalized, normalized)
    if normalized in WESTOCK_UNSUPPORTED_COMMANDS:
        raise WeStockUnsupportedCommandError(
            f"westock command {command!r} is intentionally outside the core contract"
        )
    if normalized not in WESTOCK_COMMANDS:
        raise WeStockUnsupportedCommandError(f"unsupported westock command {command!r}")
    return normalized


def _json_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    except (TypeError, ValueError) as exc:
        raise WeStockSchemaError(f"westock output is not JSON serializable: {exc}") from exc


def _json_value(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray)):
        try:
            value = bytes(value).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeStockSchemaError("westock output is not UTF-8 JSON") from exc
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise WeStockSchemaError(f"westock output is not JSON: {exc}") from exc
    return value


def _dict_get(row: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row[name]
        camel = name.split("_")
        camel_name = camel[0] + "".join(part.title() for part in camel[1:])
        if camel_name in row:
            return row[camel_name]
    return None


def _canonical_field_name(name: Any) -> str:
    text = str(name).strip()
    lower = text.lower().replace("-", "_").replace(" ", "_")
    if lower in _FIELD_ALIASES:
        return _FIELD_ALIASES[lower]
    if text in _FIELD_ALIASES:
        return _FIELD_ALIASES[text]
    return lower


def _canonicalize_data(data: Any) -> Any:
    if isinstance(data, list):
        return [_canonicalize_data(item) for item in data]
    if not isinstance(data, Mapping):
        return data
    return {
        _canonical_field_name(key): _canonicalize_data(value)
        for key, value in data.items()
    }


def _rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, Mapping):
        rows = value.get("rows") or value.get("items") or value.get("records")
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, Mapping)]
        return [dict(value)]
    if isinstance(value, list):
        return [dict(row) for row in value if isinstance(row, Mapping)]
    return []


def _instrument_token(inst: InstrumentRef) -> set[str]:
    return {inst.id, inst.symbol, inst.em_code, inst.secu_code, inst.symbol.lstrip("0") or "0"}


def _validate_instrument(row: Mapping[str, Any], inst: InstrumentRef, *, required: bool) -> None:
    raw = _dict_get(
        row,
        "instrument_id",
        "stock_id",
        "symbol",
        "code",
        "stock_code",
        "security_code",
        "secu_code",
    )
    if raw in (None, ""):
        if required:
            raise WeStockFieldError(f"westock result for {inst.id} has no stock code")
        return
    token = str(raw).strip().upper()
    if token not in {item.upper() for item in _instrument_token(inst)}:
        raise WeStockFieldError(
            f"westock result code {raw!r} does not match requested instrument {inst.id}"
        )


def _numeric(value: Any, *, field: str, unit: str | None, allowed: frozenset[str] | None) -> float:
    if isinstance(value, Mapping):
        if "value" not in value:
            raise WeStockFieldError(f"westock numeric field {field!r} lacks value")
        unit = value.get("unit", unit)
        value = value["value"]
    if isinstance(value, bool) or value in (None, ""):
        raise WeStockFieldError(f"westock numeric field {field!r} is empty or boolean")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise WeStockFieldError(f"westock numeric field {field!r} is not numeric") from exc
    if not math.isfinite(result):
        raise WeStockFieldError(f"westock numeric field {field!r} is not finite")
    if unit is not None:
        normalized_unit = str(unit).strip().lower()
        if allowed is not None and normalized_unit not in allowed:
            raise WeStockFieldError(
                f"westock field {field!r} has unsupported unit {unit!r}; expected {sorted(allowed)}"
            )
    return result


def _normalize_date(value: Any, *, field: str) -> str | None:
    if value in (None, ""):
        return None
    normalized = normalize_asia_datetime(value)
    if normalized is None:
        # Report periods are allowed to be date-only and are normalized by the
        # same parser; anything else is an invalid availability timestamp.
        raise WeStockFieldError(f"westock date field {field!r} is invalid")
    return normalized


def _normalize_period(value: Any, *, field: str) -> str | None:
    normalized = _normalize_date(value, field=field)
    return normalized[:10] if normalized is not None else None


def _extract_envelope(payload: Any, *, configured_version: str | None) -> tuple[Any, dict[str, Any]]:
    if not isinstance(payload, Mapping):
        return payload, {}
    metadata: dict[str, Any] = {}
    for key in (
        "package_name",
        "package",
        "package_version",
        "version",
        "contract_version",
        "schema_version",
        "data_as_of",
        "as_of",
        "updated_at",
        "fetched_at",
        "validation_mode",
        "canary",
    ):
        if key in payload:
            metadata[key] = payload[key]
    nested = payload.get("data")
    if nested is not None and isinstance(nested, (Mapping, list)):
        return nested, metadata
    nested = payload.get("result")
    if nested is not None and isinstance(nested, (Mapping, list)):
        return nested, metadata
    nested = payload.get("payload")
    if nested is not None and isinstance(nested, (Mapping, list)):
        return nested, metadata
    if configured_version and "package_version" not in metadata:
        metadata["package_version"] = configured_version
    return payload, metadata


def _top_level_fields(data: Any) -> set[str]:
    fields: set[str] = set()
    for row in _rows(data):
        fields.update(str(key) for key in row)
    return fields


def _extract_data_as_of(data: Any, metadata: Mapping[str, Any]) -> str | None:
    value = _dict_get(metadata, "data_as_of", "as_of", "updated_at")
    if value is None:
        rows = _rows(data)
        for row in rows:
            value = _dict_get(row, "data_as_of", "as_of", "updated_at", "published_at", "notice_date")
            if value is not None:
                break
    if value is None:
        return None
    return _normalize_date(value, field="data_as_of")


def _validate_data(
    command: str,
    data: Any,
    inst: InstrumentRef,
    metadata: Mapping[str, Any],
) -> tuple[dict[str, Any] | list[Any], list[str], str | None]:
    spec = _COMMAND_SPECS[command]
    data = _canonicalize_data(data)
    rows = _rows(data)
    if not rows:
        raise WeStockSchemaError(f"westock {command} returned no structured rows")
    for row in rows:
        _validate_instrument(row, inst, required=spec.requires_instrument)
        for key, value in row.items():
            field = str(key)
            canonical = field
            if field not in spec.numeric_fields:
                pieces = field.split("_")
                canonical = pieces[0] + "".join(part.title() for part in pieces[1:])
            numeric_name = field if field in spec.numeric_fields else next(
                (candidate for candidate in spec.numeric_fields if candidate.replace("_", "") == field.replace("_", "")),
                None,
            )
            if numeric_name is not None:
                wrapper_unit = value.get("unit") if isinstance(value, Mapping) else None
                _numeric(
                    value,
                    field=numeric_name,
                    unit=wrapper_unit,
                    allowed=(spec.allowed_units or {}).get(numeric_name),
                )
            if field in spec.date_fields or canonical in spec.date_fields:
                _normalize_date(value, field=field)
        if command in {"profile", "sector"}:
            recognized = {
                key
                for key in row
                if key
                in {
                    "name",
                    "company_name",
                    "industry",
                    "industry_name",
                    "industry_code",
                    "sector",
                    "main_business",
                }
            }
            if not recognized:
                raise WeStockFieldError(f"westock {command} has no recognized profile fields")
        if command == "asfund":
            recognized = set(row) & set(spec.required_fields)
            if not recognized:
                raise WeStockFieldError("westock asfund has no recognized financial fields")
        if command in {"chip", "technical"}:
            recognized_numeric = set(row) & set(spec.numeric_fields)
            if not recognized_numeric:
                raise WeStockFieldError(f"westock {command} has no recognized numeric fields")
    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        cleaned = dict(row)
        for key, value in list(cleaned.items()):
            numeric_name = key if key in spec.numeric_fields else next(
                (candidate for candidate in spec.numeric_fields if candidate.replace("_", "") == str(key).replace("_", "")),
                None,
            )
            if numeric_name is not None:
                unit = value.get("unit") if isinstance(value, Mapping) else None
                cleaned[key] = _numeric(
                    value,
                    field=numeric_name,
                    unit=unit,
                    allowed=(spec.allowed_units or {}).get(numeric_name),
                )
            if key in spec.date_fields:
                cleaned[key] = (
                    _normalize_period(value, field=str(key))
                    if key in {"report_period", "period_end"}
                    else _normalize_date(value, field=str(key))
                )
        normalized_rows.append(cleaned)
    normalized: dict[str, Any] | list[Any]
    if isinstance(data, list):
        normalized = normalized_rows
    elif isinstance(data, Mapping) and isinstance(data.get("rows") or data.get("items") or data.get("records"), list):
        normalized = dict(data)
        list_key = next(key for key in ("rows", "items", "records") if isinstance(data.get(key), list))
        normalized[list_key] = normalized_rows
    else:
        normalized = normalized_rows[0]
    return normalized, sorted(_top_level_fields(normalized)), _extract_data_as_of(normalized, metadata)


def _default_runner_command(runner: str | list[str] | tuple[str, ...], command: str, inst: InstrumentRef) -> list[str]:
    base = [runner] if isinstance(runner, str) else list(runner)
    return [*base, command, inst.id]


async def _run_subprocess(
    runner: str | list[str] | tuple[str, ...], command: str, inst: InstrumentRef, timeout: float
) -> bytes:
    executable = runner[0] if isinstance(runner, (list, tuple)) else runner
    if shutil.which(str(executable)) is None:
        raise WeStockUnavailableError(f"westock executable {executable!r} is not installed")
    try:
        process = await asyncio.create_subprocess_exec(
            *_default_runner_command(runner, command, inst),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise WeStockTimeoutError(f"westock command {command!r} timed out") from exc
    except OSError as exc:
        raise WeStockUnavailableError(f"westock command could not start: {exc}") from exc
    if process.returncode:
        detail = stderr.decode("utf-8", errors="replace")[:200]
        raise WeStockError(f"westock command {command!r} failed: {detail}")
    return stdout


class WeStockSupplementProvider:
    """Optional, version-locked WeStock boundary.

    ``runner`` is intentionally dependency-injected.  It may be an async or
    sync callable, a mapping of command→callable, an object exposing
    ``query``/``run``/``execute``, or an executable path.  No package import or
    network request is attempted when no runner/package was supplied.
    """

    name = "westock"
    package_name = WESTOCK_PACKAGE_NAME
    package_version = WESTOCK_PACKAGE_VERSION
    contract_version = WESTOCK_CONTRACT_VERSION

    def __init__(
        self,
        *,
        runner: Any | None = None,
        command_runner: Any | None = None,
        package: Any | None = None,
        executable: str | list[str] | tuple[str, ...] | None = None,
        expected_version: str = WESTOCK_PACKAGE_VERSION,
        package_version: str | None = None,
        fixed_version: str | None = None,
        contract_version: str = WESTOCK_CONTRACT_VERSION,
        timeout: float = 5.0,
        cache_root: str | Path | None = None,
        cache_dir: str | Path | None = None,
        clock: Callable[[], datetime] | None = None,
        canary_verified: Mapping[str, bool] | None = None,
        validation_mode: Literal["fixture", "real_canary", "unknown"] = "unknown",
        enabled: bool | None = None,
    ) -> None:
        if timeout <= 0:
            raise ValueError("westock timeout must be positive")
        self.runner = runner if runner is not None else command_runner
        if self.runner is None:
            self.runner = executable
        self.package = package
        self.expected_version = str(package_version or fixed_version or expected_version)
        self.package_version = self.expected_version
        self.contract_version = str(contract_version)
        self.timeout = float(timeout)
        self.cache_root = Path(cache_root if cache_root is not None else cache_dir) if (cache_root is not None or cache_dir is not None) else None
        self.clock = clock or (lambda: datetime.now(CN_TZ))
        self.canary_verified = dict(canary_verified or {})
        self.validation_mode = validation_mode
        self._enabled_override = enabled
        self._memory_cache: dict[tuple[str, str, str], WeStockResult] = {}

    @property
    def enabled(self) -> bool:
        if self._enabled_override is not None:
            return bool(self._enabled_override)
        return self.runner is not None or self.package is not None

    @property
    def installed(self) -> bool:
        if self.runner is None:
            return self.package is not None
        if isinstance(self.runner, (str, list, tuple)):
            executable = self.runner[0] if isinstance(self.runner, (list, tuple)) else self.runner
            return shutil.which(str(executable)) is not None
        return True

    def capability_matrix(self) -> dict[str, dict[str, Any]]:
        """Return explicit contract/fixture/canary status for user-facing QA."""
        rows: dict[str, dict[str, Any]] = {}
        for command in ("profile", "asfund", "sector", "macro", "report", "notice", "chip", "technical"):
            verified = bool(self.canary_verified.get(command, False))
            if command == "asfund":
                verified = verified or bool(self.canary_verified.get("finance", False))
            if verified:
                status = "canary_verified"
                note = "isolated real canary explicitly recorded by caller"
            elif not self.enabled or not self.installed:
                status = "not_installed"
                note = "no runner/package configured; no request and no cache write"
            elif self.validation_mode == "fixture":
                status = "fixture_only"
                note = "fixture contract only; external capability is not claimed"
            else:
                status = "fixture_only"
                note = "runner configured but no isolated real canary recorded"
            rows[command] = WeStockCapability(
                command=command,
                status=status,
                real_canary=verified,
                fixture_contract=True,
                note=note,
            ).as_dict()
        rows["quote"] = WeStockCapability(
            command="quote",
            status="unsupported",
            real_canary=False,
            fixture_contract=False,
            note="quote is excluded from the core contract",
        ).as_dict()
        return rows

    def _cache_day(self) -> str:
        parsed = parse_asia_datetime(self.clock())
        if parsed is None:
            raise WeStockSchemaError("westock clock returned an invalid time")
        return parsed.date().isoformat()

    def _cache_path(self, command: str, inst: InstrumentRef, day: str) -> Path | None:
        if self.cache_root is None:
            return None
        safe_id = f"{inst.exchange}_{inst.symbol}"
        return self.cache_root / "westock" / command / f"{safe_id}_{day}.json"

    def _read_cache(self, command: str, inst: InstrumentRef, day: str) -> WeStockResult | None:
        path = self._cache_path(command, inst, day)
        if path is None or not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            result_payload = payload.get("result") if isinstance(payload, Mapping) else None
            if not isinstance(result_payload, Mapping):
                return None
            if (
                payload.get("cache_day") != day
                or result_payload.get("command") != command
                or result_payload.get("instrument_id") != inst.id
                or result_payload.get("package_version") != self.expected_version
                or result_payload.get("contract_version") != self.contract_version
            ):
                return None
            source = SourceRecord.model_validate(result_payload.get("source"))
            return WeStockResult(
                command=command,
                instrument_id=result_payload.get("instrument_id"),
                package_name=str(result_payload.get("package_name") or self.package_name),
                package_version=str(result_payload.get("package_version")),
                contract_version=str(result_payload.get("contract_version")),
                data=result_payload.get("data"),
                data_as_of=result_payload.get("data_as_of"),
                fetched_at=str(result_payload.get("fetched_at")),
                cache_status="fresh_cache",
                raw_output_hash=str(result_payload.get("raw_output_hash")),
                fields=list(result_payload.get("fields") or []),
                source=source,
                validation_mode=result_payload.get("validation_mode", "unknown"),
            )
        except (OSError, TypeError, ValueError, KeyError):
            return None

    def _write_cache(self, result: WeStockResult, day: str) -> None:
        path = self._cache_path(result.command, InstrumentRef(
            exchange=result.instrument_id.split(":", 1)[0],
            symbol=result.instrument_id.split(":", 1)[1],
        ) if result.instrument_id and ":" in result.instrument_id else None, day) if result.instrument_id else None
        if path is None:
            return
        payload = {"cache_day": day, "result": result.model_dump()}
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        os.replace(temp, path)

    async def _invoke(self, command: str, inst: InstrumentRef, params: Mapping[str, Any] | None) -> Any:
        if not self.enabled:
            raise WeStockUnavailableError("westock package is not installed or not enabled")
        if isinstance(self.runner, (str, list, tuple)):
            return await _run_subprocess(self.runner, command, inst, self.timeout)
        target = self.runner
        if target is None:
            target = self.package
        if isinstance(target, Mapping):
            target = target.get(command) or target.get("query") or target.get("run")
        if target is not None and not callable(target):
            for name in ("query", "run", "execute", "fetch"):
                candidate = getattr(target, name, None)
                if callable(candidate):
                    target = candidate
                    break
        if not callable(target):
            raise WeStockUnavailableError("westock runner exposes no query/run callable")
        kwargs = {
            "command": command,
            "symbol": inst.symbol,
            "code": inst.symbol,
            "instrument_id": inst.id,
            "instrument": inst,
            "inst": inst,
            "exchange": inst.exchange,
            "params": dict(params or {}),
        }
        try:
            signature = inspect.signature(target)
            accepts_kwargs = any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
            if accepts_kwargs:
                call_kwargs: dict[str, Any] | None = kwargs
                call_args: tuple[Any, ...] = ()
            else:
                named = {
                    name: kwargs[name]
                    for name, parameter in signature.parameters.items()
                    if name in kwargs and parameter.kind
                    in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
                }
                if named:
                    call_kwargs = named
                    call_args = ()
                else:
                    call_kwargs = None
                    positional = [command, inst.id]
                    call_args = tuple(positional[: len(signature.parameters)])
        except (TypeError, ValueError) as exc:
            raise WeStockSchemaError(f"westock runner signature is unsupported: {exc}") from exc
        is_async = inspect.iscoroutinefunction(target) or inspect.iscoroutinefunction(
            getattr(target, "__call__", None)
        )
        try:
            if is_async:
                value = target(*call_args, **(call_kwargs or {}))
            else:
                value = await asyncio.wait_for(
                    asyncio.to_thread(target, *call_args, **(call_kwargs or {})),
                    timeout=self.timeout,
                )
        except asyncio.TimeoutError as exc:
            raise WeStockTimeoutError(f"westock command {command!r} timed out") from exc
        if inspect.isawaitable(value):
            try:
                return await asyncio.wait_for(value, timeout=self.timeout)
            except asyncio.TimeoutError as exc:
                raise WeStockTimeoutError(f"westock command {command!r} timed out") from exc
        return value

    def _check_runtime_version(self) -> None:
        target = self.package if self.package is not None else self.runner
        if target is None or isinstance(target, (str, list, tuple)):
            return
        runtime_version = getattr(target, "__version__", None) or getattr(target, "version", None)
        if runtime_version is not None and str(runtime_version) != self.expected_version:
            raise WeStockVersionDriftError(
                f"westock package version {runtime_version!r} != expected {self.expected_version!r}"
            )

    async def fetch(
        self,
        command: str,
        inst: InstrumentRef,
        *,
        params: Mapping[str, Any] | None = None,
        fallback: Callable[[], Awaitable[Any]] | None = None,
    ) -> WeStockResult | Any:
        """Fetch one validated command, optionally invoking an existing-source fallback.

        Fallback is deliberately caller-supplied: the adapter never constructs
        or calls an Agent/tool path.  Evidence passes its existing provider
        seam when it needs a controlled fallback.
        """
        canonical = _canonical_command(command)
        day = self._cache_day()
        cache_key = (canonical, inst.id, day)
        cached = self._memory_cache.get(cache_key)
        if cached is None:
            cached = self._read_cache(canonical, inst, day)
            if cached is not None:
                self._memory_cache[cache_key] = cached
        if cached is not None:
            if cached.validation_mode == "real_canary":
                self.canary_verified[canonical] = True
            if cached.get("cache_status") != "fresh_cache":
                cached = WeStockResult(
                    command=cached.command,
                    instrument_id=cached.instrument_id,
                    package_name=cached.package_name,
                    package_version=cached.package_version,
                    contract_version=cached.contract_version,
                    data=cached.data,
                    data_as_of=cached.data_as_of,
                    fetched_at=cached.fetched_at,
                    cache_status="fresh_cache",
                    raw_output_hash=cached.raw_output_hash,
                    fields=cached.fields,
                    source=cached.source,
                    validation_mode=cached.validation_mode,
                )
                self._memory_cache[cache_key] = cached
            return cached
        try:
            self._check_runtime_version()
            raw = await self._invoke(canonical, inst, params)
            raw_bytes = _json_bytes(raw)
            payload = _json_value(raw)
            data, metadata = _extract_envelope(payload, configured_version=self.expected_version)
            package_version = str(metadata.get("package_version") or self.expected_version)
            if package_version != self.expected_version:
                raise WeStockVersionDriftError(
                    f"westock package version {package_version!r} != expected {self.expected_version!r}"
                )
            runtime_contract = str(metadata.get("contract_version") or self.contract_version)
            if runtime_contract != self.contract_version:
                raise WeStockVersionDriftError(
                    f"westock contract version {runtime_contract!r} != expected {self.contract_version!r}"
                )
            normalized, fields, data_as_of = _validate_data(canonical, data, inst, metadata)
            if data_as_of is None:
                raise WeStockFieldError(
                    f"westock {canonical} result has no verifiable data timestamp"
                )
            fetched_at = normalize_asia_datetime(metadata.get("fetched_at")) or datetime.now(CN_TZ).isoformat()
            source = SourceRecord.create(
                provider=self.name,
                url=f"westock://{canonical}/{inst.id}",
                body=raw_bytes,
                fields=sorted(set(fields) | {"command", "package_version", "raw_output_hash"}),
                published_at=data_as_of or fetched_at,
                period_end=(
                    _normalize_period(
                        _dict_get(_rows(normalized)[0], "period_end", "report_period"),
                        field="period_end",
                    )
                    if canonical == "asfund" and _rows(normalized)
                    else None
                ),
                fetched_at=fetched_at,
            )
            result = WeStockResult(
                command=canonical,
                instrument_id=inst.id,
                package_name=str(metadata.get("package_name") or self.package_name),
                package_version=package_version,
                contract_version=runtime_contract,
                data=normalized,
                data_as_of=data_as_of,
                fetched_at=fetched_at,
                cache_status="live",
                raw_output_hash="sha256:" + hashlib.sha256(raw_bytes).hexdigest(),
                fields=fields,
                source=source,
                validation_mode=(
                    "real_canary"
                    if bool(metadata.get("canary")) or metadata.get("validation_mode") == "real_canary"
                    else ("fixture" if metadata.get("validation_mode") == "fixture" else self.validation_mode)
                ),
            )
            if result.validation_mode == "real_canary":
                self.canary_verified[canonical] = True
            self._memory_cache[cache_key] = result
            if self.cache_root is not None:
                self._write_cache(result, day)
            return result
        except WeStockError:
            if fallback is not None:
                return await fallback()
            raise
        except (OSError, TypeError, ValueError, KeyError) as exc:
            if fallback is not None:
                return await fallback()
            raise WeStockSchemaError(f"westock {canonical} output validation failed: {exc}") from exc

    async def query(self, command: str, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        """Alias used by isolated canaries and contract tests."""
        return await self.fetch(command, inst, **kwargs)

    async def profile(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("profile", inst, **kwargs)

    async def finance(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("asfund", inst, **kwargs)

    async def asfund(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("asfund", inst, **kwargs)

    async def sector(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("sector", inst, **kwargs)

    async def macro(self, inst: InstrumentRef | None = None, **kwargs: Any) -> WeStockResult | Any:
        target = inst or InstrumentRef(exchange="XSHG", symbol="000001", instrument_type="index")
        return await self.fetch("macro", target, **kwargs)

    async def report(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("report", inst, **kwargs)

    async def notice(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("notice", inst, **kwargs)

    async def chip(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("chip", inst, **kwargs)

    async def technical(self, inst: InstrumentRef, **kwargs: Any) -> WeStockResult | Any:
        return await self.fetch("technical", inst, **kwargs)


__all__ = [
    "WESTOCK_COMMANDS",
    "WESTOCK_SUPPORTED_COMMANDS",
    "ALLOWED_COMMANDS",
    "WESTOCK_CONTRACT_VERSION",
    "WESTOCK_PACKAGE_NAME",
    "WESTOCK_PACKAGE_VERSION",
    "WeStockCapability",
    "WeStockCommandSpec",
    "WeStockError",
    "WeStockFieldError",
    "WeStockSchemaError",
    "WeStockSupplementProvider",
    "WeStockResult",
    "WeStockTimeoutError",
    "WeStockUnavailableError",
    "WeStockUnsupportedCommandError",
    "WeStockVersionDriftError",
]
