from __future__ import annotations

import json
import zipfile
from datetime import datetime
from pathlib import Path

import pytest

from mona.runtime.manager import RuntimeComponentStore
from mona.services.stock import westock_runtime as runtime
from mona.services.stock.provider import InstrumentRef

CN_STOCK = InstrumentRef(exchange="XSHE", symbol="002407")


def test_runtime_paths_prefer_managed_westock_and_node(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "managed"
    store = RuntimeComponentStore(runtime_root)
    for component_id, version, kind, entrypoint, relative in (
        ("node-base", "22.23.2", "node-runtime", "node", "node/node.exe"),
        ("westock-data", "1.0.5", "stock-data-runtime", "main", "westock/index.js"),
    ):
        archive = tmp_path / f"{component_id}.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr(
                "runtime-manifest.json",
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": component_id,
                        "version": version,
                        "kind": kind,
                        "entrypoints": {entrypoint: relative},
                    }
                ),
            )
            bundle.writestr(relative, b"fixture")
        store.install_archive(archive)
    monkeypatch.setattr("mona.config.paths.get_managed_runtimes_dir", lambda: runtime_root)

    paths = runtime._runtime_paths()

    assert paths is not None
    assert paths[0].name == "node.exe"
    assert paths[1].name == "index.js"


class StubCliRunner(runtime.WeStockCliRunner):
    """Feed the runtime command normalizers deterministic JSON without I/O."""

    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = responses
        self.calls: list[list[str]] = []

    async def _execute(self, args: list[str]) -> object:
        self.calls.append(args)
        key = "finance" if args[0] == "finance" else args[0]
        return self.responses[key]


def _runner() -> StubCliRunner:
    return StubCliRunner(
        {
            "profile": {
                "success": True,
                "data": {
                    "sz002407": {
                        "name": "多氟多",
                        "business": "含氟材料研发、生产与销售",
                        "industry": "化学原料",
                        "listedDate": "2010-05-18",
                        "chairman": "李某",
                    }
                },
            },
            "finance": {
                "success": True,
                "data": {
                    "sections": [
                        [
                            {
                                "EndDate": "2025-06-30",
                                "OperatingRevenue": "1000",
                                "NPParentCompanyOwners": "100",
                                "OperatingRevenueTTM": "4000",
                                "NPParentCompanyOwnersTTM": "400",
                                "GrossProfitTTM": "1200",
                                "BasicEPS": "0.50",
                                "FinancialExpense": "20",
                                "InfoPublDate": "2025-08-30",
                            },
                            {
                                "EndDate": "2024-06-30",
                                "OperatingRevenue": "800",
                                "NPParentCompanyOwners": "50",
                                "InfoPublDate": "2024-08-30",
                            },
                        ],
                        [
                            {
                                "EndDate": "2025-06-30",
                                "TotalLiability": "600",
                                "SEWithoutMI": "1000",
                                "TotalCurrentAssets": "900",
                                "TotalNonCurrentAssets": "1100",
                                "TotalCurrentLiability": "450",
                                "EBIT": "130",
                                "InfoPublDate": "2025-08-29",
                            }
                        ],
                        [
                            {
                                "EndDate": "2025-06-30",
                                "NetOperateCashFlow": "300",
                                "InfoPublDate": "2025-08-28",
                            }
                        ],
                    ]
                },
            },
            "technical": {
                "success": True,
                "data": {
                    "sz002407": {
                        "date": "2025-08-25",
                        "closePrice": "35.50",
                        "ma": {
                            "MA_5": "35.00",
                            "MA_10": "34.50",
                            "MA_20": "33.00",
                            "MA_60": "30.00",
                        },
                        "rsi": {"RSI_12": "58.5"},
                        "macd": {"DIF": "0.80", "DEA": "0.60", "MACD": "0.40"},
                    }
                },
            },
            "chip": {
                "success": True,
                "data": {
                    "sz002407": {
                        "date": "2025-08-25",
                        "closePrice": "35.50",
                        "chipProfitRate": "72.5",
                        "chipAvgCost": "31.20",
                        "chipConcentration70": "8.5",
                        "chipConcentration90": "16.0",
                    }
                },
            },
            "report": {
                "success": True,
                "data": [
                    {
                        "id": "report-1",
                        "title": "多氟多盈利预测报告",
                        "time": "2025-08-24T18:30:00+08:00",
                        "url": "https://example.test/report-1",
                        "typeStr": "公司报告",
                        "tzpj": "增持",
                        "summary": "业绩改善。",
                    }
                ],
            },
            "notice": {
                "success": True,
                "data": [
                    {
                        "id": "notice-1",
                        "title": "关于签订重大合同的公告",
                        "update_time": "2025-08-24T17:00:00+08:00",
                        "url": "https://example.test/notice-1",
                        "newstype": "重大事项",
                    }
                ],
            },
            "macro": {
                "success": True,
                "data": {
                    "sections": [
                        [
                            {
                                "CURV_M2_YOY": "7.0",
                                "CURV_END_DATE": "2025-07-31",
                                "CURV_INFO_DATE": "2025-08-15",
                            },
                            {
                                "PMI_PMI_MANU": "49.8",
                                "PMI_END_DATE": "2025-07-31",
                                "PMI_INFO_DATE": "2025-08-01",
                            },
                        ]
                    ]
                },
            },
            "sector": {
                "success": True,
                "data": [
                    {
                        "指标代码": "OPERATING_REVENUE",
                        "指标名称": "行业营业收入",
                        "数据点": "12",
                        "最新日期": "2025-06-30",
                        "最新值": "15.2",
                    }
                ],
            },
        }
    )


def test_stock_code_maps_supported_a_share_exchanges() -> None:
    assert runtime._stock_code(InstrumentRef(exchange="XSHG", symbol="600519")) == "sh600519"
    assert runtime._stock_code(InstrumentRef(exchange="XSHE", symbol="002407")) == "sz002407"
    assert runtime._stock_code(InstrumentRef(exchange="BJSE", symbol="430047")) == "bj430047"

    with pytest.raises(runtime.WeStockUnavailableError):
        runtime._stock_code(InstrumentRef(exchange="XNAS", symbol="AAPL"))


@pytest.mark.asyncio
async def test_profile_json_is_normalized_and_uses_a_share_code() -> None:
    runner = _runner()

    result = await runner("profile", CN_STOCK)

    assert result["data"] == {
        "code": "002407",
        "name": "多氟多",
        "company_name": "多氟多",
        "main_business": "含氟材料研发、生产与销售",
        "industry": "化学原料",
        "industry_name": "化学原料",
        "sector": "化学原料",
        "listing_date": "2010-05-18",
        "chairman": "李某",
    }
    assert runner.calls == [["profile", "sz002407"]]


@pytest.mark.asyncio
async def test_finance_json_is_normalized_with_yoy_and_cashflow_metrics() -> None:
    runner = _runner()

    result = await runner("asfund", CN_STOCK)

    current = result["data"][0]
    assert current["code"] == "002407"
    assert current["report_period"] == "2025-06-30"
    assert current["period_end"] == "2025-06-30"
    assert current["published_at"] == "2025-08-30T00:00:00+08:00"
    assert current["revenue"] == 1000.0
    assert current["net_profit"] == 100.0
    assert current["revenue_yoy"] == pytest.approx(25.0)
    assert current["profit_yoy"] == pytest.approx(100.0)
    assert current["cashflow_to_profit"] == pytest.approx(3.0)
    assert current["gross_margin"] == pytest.approx(30.0)
    assert current["net_margin"] == pytest.approx(10.0)
    assert current["roe"] == pytest.approx(40.0)
    assert current["debt_ratio"] == pytest.approx(30.0)
    assert current["current_ratio"] == pytest.approx(2.0)
    assert current["interest_coverage"] == pytest.approx(6.5)
    assert runner.calls == [["finance", "sz002407", "--num", "8"]]


@pytest.mark.asyncio
async def test_technical_and_chip_json_are_normalized() -> None:
    runner = _runner()

    technical = await runner("technical", CN_STOCK)
    chip = await runner("chip", CN_STOCK)

    assert technical["data"] == {
        "code": "002407",
        "as_of": "2025-08-25",
        "close_price": 35.5,
        "ma5": 35.0,
        "ma10": 34.5,
        "ma20": 33.0,
        "ma60": 30.0,
        "rsi12": 58.5,
        "dif": 0.8,
        "dea": 0.6,
        "macd": 0.4,
    }
    assert chip["data"] == {
        "code": "002407",
        "as_of": "2025-08-25",
        "close_price": 35.5,
        "profit_ratio": 72.5,
        "average_cost": 31.2,
        "concentration": 8.5,
        "concentration70": 8.5,
        "concentration90": 16.0,
    }
    assert runner.calls == [
        ["technical", "sz002407", "--indicator", "all"],
        ["chip", "sz002407"],
    ]


@pytest.mark.asyncio
async def test_report_and_notice_json_are_normalized() -> None:
    runner = _runner()

    report = await runner("report", CN_STOCK)
    notice = await runner("notice", CN_STOCK)

    assert report["data"] == [
        {
            "code": "002407",
            "document_id": "report-1",
            "title": "多氟多盈利预测报告",
            "published_at": "2025-08-24T18:30:00+08:00",
            "url": "https://example.test/report-1",
            "category": "公司报告",
            "rating": "增持",
            "summary": "业绩改善。",
        }
    ]
    assert notice["data"] == [
        {
            "code": "002407",
            "document_id": "notice-1",
            "title": "关于签订重大合同的公告",
            "published_at": "2025-08-24T17:00:00+08:00",
            "url": "https://example.test/notice-1",
            "category": "重大事项",
            "rating": None,
            "summary": "",
        }
    ]
    assert runner.calls == [
        ["report", "list", "sz002407", "--limit", "20"],
        ["notice", "list", "sz002407", "--limit", "20"],
    ]


@pytest.mark.asyncio
async def test_macro_and_sector_json_are_normalized() -> None:
    runner = _runner()

    macro = await runner("macro", CN_STOCK)
    sector = await runner("sector", CN_STOCK)

    assert macro["data"] == [
        {
            "name": "M2同比",
            "value": 7.0,
            "unit": "percent",
            "period_end": "2025-07-31",
            "published_at": "2025-08-15T00:00:00+08:00",
        },
        {
            "name": "制造业采购经理指数",
            "value": 49.8,
            "unit": "percent",
            "period_end": "2025-07-31",
            "published_at": "2025-08-01T00:00:00+08:00",
        },
    ]
    assert sector["data"] == [
        {
            "code": "002407",
            "industry": "化学原料",
            "sector": "化学原料",
            "indicator_code": "OPERATING_REVENUE",
            "indicator_name": "行业营业收入",
            "point_count": 12,
            "latest_date": "2025-06-30",
            "latest_value": 15.2,
            "as_of": "2025-06-30",
        }
    ]
    assert runner.calls == [
        ["macro", "indicator", "cn_core", "--date", datetime.now(runtime.CN_TZ).date().isoformat()],
        ["profile", "sz002407"],
        ["sector", "oper", "化学原料"],
    ]


def test_default_provider_is_none_without_runtime_resources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("MONA_ENABLE_WESTOCK", "1")
    monkeypatch.setattr(runtime, "_runtime_paths", lambda: None)
    monkeypatch.setattr(
        runtime,
        "_install_runtime_package",
        lambda: (_ for _ in ()).throw(RuntimeError("not published")),
    )

    assert runtime.create_default_westock_provider(tmp_path) is None


def test_default_provider_is_disabled_by_default_even_if_resources_exist(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("MONA_ENABLE_WESTOCK", raising=False)
    monkeypatch.setattr(runtime, "_runtime_paths", lambda: (tmp_path / "node", tmp_path / "entry"))

    assert runtime.create_default_westock_provider(tmp_path) is None


def test_runtime_installer_uses_managed_component(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mona.runtime import official

    calls: list[str] = []
    node = tmp_path / "node.exe"
    entry = tmp_path / "index.js"
    node.write_bytes(b"node")
    entry.write_bytes(b"westock")
    monkeypatch.setattr(
        official,
        "ensure_official_runtime_resource_sync",
        lambda resource: calls.append(resource),
    )
    monkeypatch.setattr(runtime, "_runtime_paths", lambda: (node, entry))

    runtime._install_runtime_package()

    assert calls == ["westock"]
