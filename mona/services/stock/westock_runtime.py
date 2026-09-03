"""Packaged WeStock CLI runner and command normalization."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import os
import shutil
import sys
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from mona.services.stock.provenance import CN_TZ, normalize_asia_datetime
from mona.services.stock.provider import InstrumentRef
from mona.services.stock.westock_provider import (
    WESTOCK_CONTRACT_VERSION,
    WESTOCK_PACKAGE_NAME,
    WESTOCK_PACKAGE_VERSION,
    WeStockError,
    WeStockSupplementProvider,
    WeStockUnavailableError,
)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value in (None, "", "-"):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _date(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(int(value))
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        return text[:10]
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    normalized = normalize_asia_datetime(text)
    return normalized[:10] if normalized else None


def _published_at(value: Any) -> str | None:
    date = _date(value)
    if date is None:
        return None
    text = str(value).strip()
    if len(text) >= 19 and text[4:5] == "-" and text[7:8] == "-":
        normalized = normalize_asia_datetime(f"{text[:19]}+08:00")
    else:
        normalized = normalize_asia_datetime(value)
    return normalized or normalize_asia_datetime(f"{date}T00:00:00+08:00")


def _stock_code(inst: InstrumentRef) -> str:
    prefix = {"XSHG": "sh", "XSHE": "sz", "BJSE": "bj"}.get(inst.exchange)
    if prefix is None:
        raise WeStockUnavailableError(f"unsupported WeStock exchange {inst.exchange!r}")
    return f"{prefix}{inst.symbol}"


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, Mapping) and payload.get("success") is False:
        raise WeStockError(
            str(payload.get("message") or payload.get("error") or "WeStock request failed")
        )
    if isinstance(payload, Mapping) and payload.get("success") is True and "data" in payload:
        return payload["data"]
    return payload


def _target_row(payload: Any, code: str) -> dict[str, Any]:
    payload = _unwrap(payload)
    if isinstance(payload, Mapping):
        value = payload.get(code) or payload.get(code.lower()) or payload.get(code.upper())
        if isinstance(value, Mapping):
            return dict(value)
        return dict(payload)
    return {}


def _profile(payload: Any, inst: InstrumentRef) -> dict[str, Any]:
    row = _target_row(payload, _stock_code(inst))
    return {
        "code": inst.symbol,
        "name": row.get("name"),
        "company_name": row.get("name"),
        "main_business": row.get("business"),
        "industry": row.get("industry") or row.get("sector"),
        "industry_name": row.get("industry") or row.get("sector"),
        "sector": row.get("sector") or row.get("industry"),
        "listing_date": _date(row.get("listedDate")),
        "chairman": row.get("chairman"),
    }


def _finance(payload: Any, inst: InstrumentRef) -> list[dict[str, Any]]:
    payload = _unwrap(payload)
    sections = payload.get("sections") if isinstance(payload, Mapping) else None
    sections = sections if isinstance(sections, list) else []
    income: dict[str, dict[str, Any]] = {}
    balance: dict[str, dict[str, Any]] = {}
    cashflow: dict[str, dict[str, Any]] = {}
    for section in sections:
        if not isinstance(section, list):
            continue
        for raw in section:
            if not isinstance(raw, Mapping):
                continue
            row = dict(raw)
            period = _date(row.get("EndDate") or row.get("date") or row.get("_date"))
            if period is None:
                continue
            if "OperatingRevenue" in row:
                income[period] = row
            elif "TotalLiability" in row:
                balance[period] = row
            elif "NetOperateCashFlow" in row:
                cashflow[period] = row

    periods = sorted(set(income) | set(balance) | set(cashflow), reverse=True)
    rows: list[dict[str, Any]] = []
    for period in periods:
        inc = income.get(period, {})
        bal = balance.get(period, {})
        cash = cashflow.get(period, {})
        revenue = _number(inc.get("OperatingRevenue"))
        profit = _number(inc.get("NPParentCompanyOwners"))
        revenue_ttm = _number(inc.get("OperatingRevenueTTM"))
        profit_ttm = _number(inc.get("NPParentCompanyOwnersTTM"))
        gross_profit_ttm = _number(inc.get("GrossProfitTTM"))
        equity = _number(bal.get("SEWithoutMI"))
        liability = _number(bal.get("TotalLiability"))
        current_assets = _number(bal.get("TotalCurrentAssets"))
        noncurrent_assets = _number(bal.get("TotalNonCurrentAssets"))
        current_liability = _number(bal.get("TotalCurrentLiability"))
        operating_cashflow = _number(cash.get("NetOperateCashFlow"))
        financial_expense = _number(inc.get("FinancialExpense"))
        ebit = _number(bal.get("EBIT"))
        previous_period = f"{int(period[:4]) - 1}{period[4:]}"
        prior_income = income.get(previous_period, {})
        prior_revenue = _number(prior_income.get("OperatingRevenue"))
        prior_profit = _number(prior_income.get("NPParentCompanyOwners"))
        total_assets = (
            current_assets + noncurrent_assets
            if current_assets is not None and noncurrent_assets is not None
            else None
        )
        published = max(
            (
                value
                for value in (
                    _published_at(inc.get("InfoPublDate")),
                    _published_at(bal.get("InfoPublDate")),
                    _published_at(cash.get("InfoPublDate")),
                )
                if value
            ),
            default=None,
        )
        row = {
            "code": inst.symbol,
            "report_period": period,
            "period_end": period,
            "published_at": published,
            "eps": _number(inc.get("BasicEPS")),
            "revenue": revenue,
            "net_profit": profit,
            "operating_cashflow": operating_cashflow,
            "gross_margin": (
                gross_profit_ttm / revenue_ttm * 100
                if gross_profit_ttm is not None and revenue_ttm not in (None, 0)
                else None
            ),
            "net_margin": (
                profit_ttm / revenue_ttm * 100
                if profit_ttm is not None and revenue_ttm not in (None, 0)
                else None
            ),
            "roe": (
                profit_ttm / equity * 100
                if profit_ttm is not None and equity not in (None, 0)
                else None
            ),
            "revenue_yoy": (
                (revenue / prior_revenue - 1) * 100
                if revenue is not None and prior_revenue not in (None, 0)
                else None
            ),
            "profit_yoy": (
                (profit / prior_profit - 1) * 100
                if profit is not None and prior_profit not in (None, 0)
                else None
            ),
            "cashflow_to_profit": (
                operating_cashflow / profit
                if operating_cashflow is not None and profit not in (None, 0)
                else None
            ),
            "debt_ratio": (
                liability / total_assets * 100
                if liability is not None and total_assets not in (None, 0)
                else None
            ),
            "current_ratio": (
                current_assets / current_liability
                if current_assets is not None and current_liability not in (None, 0)
                else None
            ),
            "interest_coverage": (
                ebit / financial_expense
                if ebit is not None and financial_expense not in (None, 0)
                else None
            ),
        }
        rows.append({key: value for key, value in row.items() if value is not None})
    return rows


def _technical(payload: Any, inst: InstrumentRef) -> dict[str, Any]:
    row = _target_row(payload, _stock_code(inst))
    ma = row.get("ma") if isinstance(row.get("ma"), Mapping) else {}
    macd = row.get("macd") if isinstance(row.get("macd"), Mapping) else {}
    rsi = row.get("rsi") if isinstance(row.get("rsi"), Mapping) else {}
    return {
        "code": inst.symbol,
        "as_of": _date(row.get("date")),
        "close_price": _number(row.get("closePrice")),
        "ma5": _number(ma.get("MA_5")),
        "ma10": _number(ma.get("MA_10")),
        "ma20": _number(ma.get("MA_20")),
        "ma60": _number(ma.get("MA_60")),
        "rsi12": _number(rsi.get("RSI_12")),
        "dif": _number(macd.get("DIF")),
        "dea": _number(macd.get("DEA")),
        "macd": _number(macd.get("MACD")),
    }


def _chip(payload: Any, inst: InstrumentRef) -> dict[str, Any]:
    row = _target_row(payload, _stock_code(inst))
    return {
        "code": inst.symbol,
        "as_of": _date(row.get("date")),
        "close_price": _number(row.get("closePrice")),
        "profit_ratio": _number(row.get("chipProfitRate")),
        "average_cost": _number(row.get("chipAvgCost")),
        "concentration": _number(row.get("chipConcentration70")),
        "concentration70": _number(row.get("chipConcentration70")),
        "concentration90": _number(row.get("chipConcentration90")),
    }


def _documents(payload: Any, inst: InstrumentRef, *, notice: bool) -> list[dict[str, Any]]:
    payload = _unwrap(payload)
    rows = payload if isinstance(payload, list) else []
    result = []
    for raw in rows:
        if not isinstance(raw, Mapping):
            continue
        published = _published_at(raw.get("time") or raw.get("update_time"))
        if published is None:
            continue
        result.append(
            {
                "code": inst.symbol,
                "document_id": raw.get("id"),
                "title": raw.get("title"),
                "published_at": published,
                "url": raw.get("url") or "",
                "category": raw.get("newstype") if notice else raw.get("typeStr"),
                "rating": None if notice else raw.get("tzpj"),
                "summary": raw.get("summary") or "",
            }
        )
    return result


def _macro(payload: Any) -> list[dict[str, Any]]:
    payload = _unwrap(payload)
    sections = payload.get("sections") if isinstance(payload, Mapping) else None
    sections = sections if isinstance(sections, list) else []
    rows = [
        row
        for section in sections
        if isinstance(section, list)
        for row in section
        if isinstance(row, Mapping)
    ]
    specs = (
        ("M2同比", "CURV_M2_YOY", "CURV_END_DATE", "CURV_INFO_DATE"),
        ("M1同比", "CURV_M1_YOY", "CURV_END_DATE", "CURV_INFO_DATE"),
        ("居民消费价格同比", "CPI_CPI_YOY", "CPI_END_DATE", "CPI_INFO_DATE"),
        ("国内生产总值累计同比", "GDP_REAL_GDP_CUM_YOY", "GDP_END_DATE", "GDP_INFO_DATE"),
        (
            "社会融资规模存量同比",
            "FINANCING_SR_SIZE_YOY",
            "FINANCING_END_DATE",
            "FINANCING_INFO_DATE",
        ),
        ("制造业采购经理指数", "PMI_PMI_MANU", "PMI_END_DATE", "PMI_INFO_DATE"),
    )
    result = []
    for name, value_key, period_key, published_key in specs:
        row = next((item for item in rows if value_key in item), None)
        if row is None or (value := _number(row.get(value_key))) is None:
            continue
        period = _date(row.get(period_key))
        published = _published_at(row.get(published_key))
        if period is None or published is None:
            continue
        result.append(
            {
                "name": name,
                "value": value,
                "unit": "percent",
                "period_end": period,
                "published_at": published,
            }
        )
    return result


def _sector(payload: Any, inst: InstrumentRef, industry: str) -> list[dict[str, Any]]:
    payload = _unwrap(payload)
    rows = payload if isinstance(payload, list) else []
    result = []
    for raw in rows[:100]:
        if not isinstance(raw, Mapping):
            continue
        latest_date = _date(raw.get("最新日期"))
        latest_value = _number(raw.get("最新值"))
        if latest_date is None or latest_value is None:
            continue
        result.append(
            {
                "code": inst.symbol,
                "industry": industry,
                "sector": industry,
                "indicator_code": raw.get("指标代码"),
                "indicator_name": raw.get("指标名称"),
                "point_count": int(raw.get("数据点") or 0),
                "latest_date": latest_date,
                "latest_value": latest_value,
                "as_of": latest_date,
            }
        )
    return result


class WeStockCliRunner:
    """Invoke the bundled CLI with JSON output and normalize its public contract."""

    __version__ = WESTOCK_PACKAGE_VERSION
    version = WESTOCK_PACKAGE_VERSION

    def __init__(self, node: Path, entry: Path, *, timeout: float = 25.0) -> None:
        self.node = Path(node)
        self.entry = Path(entry)
        self.timeout = timeout

    async def _execute(self, args: list[str]) -> Any:
        process = await asyncio.create_subprocess_exec(
            str(self.node),
            str(self.entry),
            *args,
            "--raw",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=self.timeout)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise WeStockUnavailableError("WeStock request timed out") from None
        if process.returncode:
            detail = (
                stderr.decode("utf-8", errors="replace").strip()
                or stdout.decode("utf-8", errors="replace").strip()
            )
            raise WeStockError(detail[:300] or "WeStock request failed")
        try:
            return json.loads(stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WeStockError("WeStock returned invalid JSON") from exc

    async def __call__(
        self,
        command: str,
        instrument: InstrumentRef,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        del params
        code = _stock_code(instrument)
        industry = ""
        if command == "profile":
            data = _profile(await self._execute(["profile", code]), instrument)
        elif command == "asfund":
            data = _finance(await self._execute(["finance", code, "--num", "8"]), instrument)
        elif command == "technical":
            data = _technical(
                await self._execute(["technical", code, "--indicator", "all"]), instrument
            )
        elif command == "chip":
            data = _chip(await self._execute(["chip", code]), instrument)
        elif command == "report":
            data = _documents(
                await self._execute(["report", "list", code, "--limit", "20"]),
                instrument,
                notice=False,
            )
        elif command == "notice":
            data = _documents(
                await self._execute(["notice", "list", code, "--limit", "20"]),
                instrument,
                notice=True,
            )
        elif command == "macro":
            day = datetime.now(CN_TZ).date().isoformat()
            data = _macro(await self._execute(["macro", "indicator", "cn_core", "--date", day]))
        elif command == "sector":
            profile = _profile(await self._execute(["profile", code]), instrument)
            industry = str(profile.get("industry") or "").strip()
            if not industry:
                raise WeStockError("WeStock profile has no industry classification")
            data = _sector(await self._execute(["sector", "oper", industry]), instrument, industry)
        else:
            raise WeStockUnavailableError(f"unsupported WeStock command {command!r}")

        timestamps = []
        rows = data if isinstance(data, list) else [data]
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            for key in ("published_at", "as_of", "latest_date", "period_end", "report_period"):
                if (value := _published_at(row.get(key))) is not None:
                    timestamps.append(value)
        fetched_at = datetime.now(CN_TZ).isoformat()
        return {
            "package_name": WESTOCK_PACKAGE_NAME,
            "package_version": WESTOCK_PACKAGE_VERSION,
            "contract_version": WESTOCK_CONTRACT_VERSION,
            "data_as_of": max(timestamps, default=fetched_at),
            "fetched_at": fetched_at,
            "validation_mode": "real_canary",
            "canary": True,
            "data": data,
        }


def _runtime_paths() -> tuple[Path, Path] | None:
    try:
        from mona.config.paths import get_managed_runtimes_dir
        from mona.runtime.manager import RuntimeComponentStore

        store = RuntimeComponentStore(get_managed_runtimes_dir())
        managed_package = store.active("westock-data")
        managed_node = store.active("node-base")
    except Exception:
        managed_package = None
        managed_node = None
    if managed_package is not None and managed_node is not None:
        package_relative = managed_package[0].entrypoints.get("main")
        node_relative = managed_node[0].entrypoints.get("node")
        package_entry = managed_package[1] / Path(package_relative or "")
        node_entry = managed_node[1] / Path(node_relative or "")
        if package_relative and node_relative and package_entry.is_file() and node_entry.is_file():
            return node_entry, package_entry

    roots = []
    configured = os.environ.get("MONA_WESTOCK_RUNTIME_DIR")
    if configured:
        roots.append(Path(configured))
    executable_dir = Path(sys.executable).resolve().parent
    roots.append(executable_dir / "westock-data")
    app_data = Path(os.environ.get("MONA_APP_DATA_DIR") or (Path.home() / ".mona"))
    roots.append(app_data / "runtime" / "westock-data" / WESTOCK_PACKAGE_VERSION)
    repo_root = Path(__file__).resolve().parents[3]

    node_candidates = [
        executable_dir
        / "_internal"
        / "playwright"
        / "driver"
        / ("node.exe" if os.name == "nt" else "node"),
        repo_root
        / "src-tauri"
        / "resources"
        / "mona-gateway"
        / "_internal"
        / "playwright"
        / "driver"
        / ("node.exe" if os.name == "nt" else "node"),
    ]
    playwright_spec = importlib.util.find_spec("playwright")
    if playwright_spec is not None and playwright_spec.origin:
        node_candidates.append(
            Path(playwright_spec.origin).resolve().parent
            / "driver"
            / ("node.exe" if os.name == "nt" else "node")
        )
    system_node = shutil.which("node")
    if system_node:
        node_candidates.append(Path(system_node))
    node = next((path for path in node_candidates if path.is_file()), None)
    if node is None:
        return None
    for root in roots:
        for entry in (
            root / "index.js",
            root / "node_modules" / WESTOCK_PACKAGE_NAME / "index.js",
        ):
            if entry.is_file():
                return node, entry
    return None


def _install_runtime_package() -> None:
    from mona.runtime.official import ensure_official_runtime_resource_sync

    ensure_official_runtime_resource_sync("westock")
    if _runtime_paths() is None:
        raise WeStockUnavailableError("WeStock managed runtime is unavailable after installation")


def create_default_westock_provider(cache_root: str | Path) -> WeStockSupplementProvider | None:
    if os.environ.get("MONA_ENABLE_WESTOCK") != "1":
        return None
    paths = _runtime_paths()
    if paths is None:
        try:
            _install_runtime_package()
        except Exception as exc:
            logger.warning("WeStock runtime installation unavailable: {}", exc)
            return None
        paths = _runtime_paths()
    if paths is None:
        return None
    node, entry = paths
    return WeStockSupplementProvider(
        runner=WeStockCliRunner(node, entry),
        expected_version=WESTOCK_PACKAGE_VERSION,
        contract_version=WESTOCK_CONTRACT_VERSION,
        timeout=30.0,
        cache_root=cache_root,
        validation_mode="real_canary",
    )


__all__ = ["WeStockCliRunner", "create_default_westock_provider"]
