"""Host input limits; native objects and event payloads keep their own schema."""

import datetime
import re
from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    field_validator,
    model_serializer,
    model_validator,
)

from mona.config.schema import StockVibeConfig, StockVibeModelBinding


class HostInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


StrategyLibraryId = Annotated[str, StringConstraints(
    min_length=1, max_length=136, pattern=r"^(?:builtin|sdm):[A-Za-z0-9_.-]{1,128}$",
)]
StrategyVersion = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]


class ModelSelection(HostInput):
    model_preset: str | None = Field(default=None, min_length=1, max_length=128)
    model_binding: StockVibeModelBinding | None = None

    @model_validator(mode="after")
    def validate_selection(self):
        if not {"model_preset", "model_binding"}.intersection(self.model_fields_set):
            raise ValueError("a model selection is required")
        if self.model_preset is not None and self.model_binding is not None:
            raise ValueError("model_preset and model_binding are mutually exclusive")
        return self

    @model_serializer(mode="wrap")
    def omit_empty_binding(self, handler):
        data = handler(self)
        if self.model_binding is None:
            data.pop("model_binding", None)
        return data


class StockVibeDataSettingsUpdate(HostInput):
    tushare_token: str = Field(max_length=512, repr=False, pattern=r"^[^\x00-\x1f\x7f]*$")

    @field_validator("tushare_token")
    @classmethod
    def trim_tushare_token(cls, value: str) -> str:
        return value.strip()


class AttentionPreferences(HostInput):
    proactive_mode: Literal["manual", "important_changes", "continuous"]
    watched_symbols: list[str] = Field(max_length=50)
    notification_start: str
    notification_end: str
    attention_interval_sec: int
    data_sources: list[Literal["tencent", "eastmoney"]] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def validate_preferences(self):
        checked = StockVibeConfig.model_validate(self.model_dump())
        self.watched_symbols = checked.watched_symbols
        return self


class WorkbenchContext(HostInput):
    symbol: str = Field(pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    task: Literal["comprehensive", "fundamental", "technical", "risk"]
    mode: Literal["ultrashort", "swing", "medium"]


class WorkbenchQuery(HostInput):
    symbol: str = Field(pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")


class WorkbenchMarketQuery(WorkbenchQuery):
    interval: Literal["intraday", "1D"] = "intraday"


class WorkbenchHistoryQuery(WorkbenchQuery):
    q: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120, pattern=r"^[^\x00-\x1f\x7f]*$")] = ""
    task: Literal["all", "comprehensive", "fundamental", "technical", "risk"] = "all"
    state: Literal["all", "completed", "active", "unfinished"] = "all"
    offset: int = Field(default=0, ge=0, le=1_000_000)
    limit: int = Field(default=10, ge=1, le=50)


class OpportunityListQuery(HostInput):
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=1_000_000)

    @field_validator("limit", "offset", mode="before")
    @classmethod
    def strict_query_integer(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value):
            raise ValueError("pagination values must be decimal integers")
        return int(value)


class NativeResearchCatalogQuery(HostInput):
    limit: int | None = Field(default=None, ge=1, le=100)
    offset: int | None = Field(default=None, ge=0, le=1_000_000)
    source: Literal["alpha_zoo", "sdm"] | None = None

    @field_validator("limit", "offset", mode="before")
    @classmethod
    def strict_catalog_integer(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value)):
            raise ValueError("catalog pagination must use decimal integers")
        return int(value) if value is not None else None


class StrategyLibraryQuery(OpportunityListQuery):
    limit: int = Field(default=100, ge=1, le=100)
    q: Annotated[str, StringConstraints(strip_whitespace=True, max_length=160, pattern=r"^[^\x00-\x1f\x7f]*$")] = ""
    source: Literal["builtin", "custom"] | None = None
    market: Literal["china_a", "all"] = "china_a"


class StrategyLibraryHistoryQuery(OpportunityListQuery):
    limit: int = Field(default=50, ge=1, le=100)
    strategy_id: StrategyLibraryId | None = None
    operation: Literal["backtest", "strategy_scan"] | None = None


class EmptyQuery(HostInput):
    pass


class AlphaListQuery(HostInput):
    zoo: Literal["alpha101", "gtja191", "qlib158", "academic", "fundamental"] | None = None
    theme: Literal[
        "momentum", "reversal", "volume", "volatility", "quality", "value", "liquidity",
        "microstructure", "sentiment", "growth", "leverage",
    ] | None = None
    universe: Literal[
        "equity_us", "equity_cn", "equity_hk", "equity_in", "equity_kr", "crypto", "futures",
        "csi300", "sp500", "btc-usdt",
    ] | None = None
    limit: int | None = Field(default=None, ge=1, le=1000)

    @field_validator("limit", mode="before")
    @classmethod
    def strict_limit(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,4}", value)):
            raise ValueError("alpha list limit must be a decimal integer")
        return int(value) if value is not None else None


class ReportRunsQuery(HostInput):
    limit: int | None = Field(default=None, ge=1, le=100)

    @field_validator("limit", mode="before")
    @classmethod
    def strict_report_limit(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,3}", value)):
            raise ValueError("report limit must be a decimal integer")
        return int(value) if value is not None else None


class ReportRunQuery(HostInput):
    chart_symbol: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
    chart_payload: Literal["summary"] | None = None


class ReportPositionsQuery(HostInput):
    refresh: Literal["0", "1"] | None = None


class SymbolSearchQuery(HostInput):
    q: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40, pattern=r"^[^\x00-\x1f]+$")]


class CreateSchedule(HostInput):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=1, max_length=200)
    prompt: str = Field(min_length=1, max_length=100_000)
    schedule: str = Field(min_length=1, max_length=128)
    timezone: Literal["Asia/Shanghai"] = "Asia/Shanghai"
    workbench: WorkbenchContext


class NativeResearchOrigin(HostInput):
    swarm_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    task_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    symbol: str | None = Field(default=None, pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    strategy_id: str | None = Field(default=None, min_length=1, max_length=136, pattern=r"^(?:alpha_zoo|builtin|sdm):[A-Za-z0-9_.-]{1,128}$")
    strategy_version: StrategyVersion | None = None
    operation_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @model_serializer(mode="wrap")
    def omit_unset_origin_fields(self, handler):
        data = handler(self)
        return {key: value for key, value in data.items() if key in self.model_fields_set}

    @model_validator(mode="after")
    def valid_origin(self):
        if (self.swarm_id is None) == (self.strategy_id is None):
            raise ValueError("provide exactly one native research source")
        if self.strategy_id is not None and (self.task_id is not None or self.symbol is not None):
            raise ValueError("strategy origins cannot include task or symbol")
        if self.strategy_version is not None and self.strategy_id is None:
            raise ValueError("strategy versions require a strategy source")
        if self.operation_id is not None and (self.strategy_id is None or self.strategy_version is None):
            raise ValueError("strategy operation provenance requires its strategy version")
        return self


class UpdateSchedule(HostInput):
    schedule: str = Field(min_length=1, max_length=128)
    timezone: Literal["Asia/Shanghai"] = "Asia/Shanghai"


class CreateSession(HostInput):
    title: str = Field(default="", max_length=200)
    workbench: WorkbenchContext | None = None
    native_research: NativeResearchOrigin | None = None
    journal_operation_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    strategy_creation: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def one_context(self):
        if sum(value is not None for value in (self.workbench, self.journal_operation_id)) > 1:
            raise ValueError("session must have only one task context")
        if self.journal_operation_id is not None and (self.native_research is not None or self.strategy_creation):
            raise ValueError("strategy research and trade review contexts are mutually exclusive")
        if (self.strategy_creation and self.native_research is not None
                and self.native_research.strategy_id is not None
                and not self.native_research.strategy_id.startswith("sdm:")):
            raise ValueError("only custom strategies can be modified with AI")
        if self.native_research is not None and self.native_research.symbol is not None:
            if self.workbench is None or self.native_research.symbol != self.workbench.symbol:
                raise ValueError("candidate provenance must match the workbench stock")
        return self


class ResearchContext(HostInput):
    symbol: str | None = Field(default=None, pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    mode: Literal["ultrashort", "swing", "medium"]


class ResearchAttachment(HostInput):
    file_path: str = Field(max_length=64, pattern=r"^uploads/[a-f0-9]{32}\.(csv|tsv|xls|xlsx|pdf|docx|txt|md)$")
    filename: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def safe_attachment(self):
        Upload.safe_filename(self.filename)
        if PurePosixPath(self.file_path).suffix != PurePosixPath(self.filename).suffix.lower():
            raise ValueError("附件名称或类型无效")
        return self


class SendMessage(HostInput):
    content: str = Field(min_length=1, max_length=100_000)
    research: ResearchContext | None = None
    attachments: list[ResearchAttachment] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def distinct_attachments(self):
        paths = [item.file_path for item in self.attachments]
        if len(paths) != len(set(paths)):
            raise ValueError("附件重复")
        return self

    @model_serializer(mode="wrap")
    def omit_unused_context(self, handler):
        data = handler(self)
        if self.research is None:
            data.pop("research", None)
        if not self.attachments:
            data.pop("attachments", None)
        return data


class Upload(HostInput):
    filename: str = Field(min_length=1, max_length=200)
    data_base64: str = Field(max_length=12 * 1024 * 1024)

    @field_validator("filename")
    @classmethod
    def safe_filename(cls, value):
        if (PurePosixPath(value).name != value or PureWindowsPath(value).name != value
            or any(ord(char) < 32 for char in value)
            or PurePosixPath(value).suffix.lower() not in {".csv", ".tsv", ".xls", ".xlsx", ".pdf", ".docx", ".txt", ".md"}):
            raise ValueError("附件名称或类型无效")
        return value


_NATIVE_RESEARCH_TEXT = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000, pattern=r"^[^\x00-\x1f\x7f]*$")]
_NATIVE_RESEARCH_URL = re.compile(r"(?i)(?:[a-z][a-z0-9+.-]*://|www\.)")
_NATIVE_RESEARCH_CREDENTIAL = re.compile(
    r"(?i)\b(?:api[-_ ]?key|access[-_ ]?token|token|password|secret|credential|authorization)\s*[:=]\s*\S+"
)


class NativeResearchVars(HostInput):
    @field_validator("*", check_fields=False)
    @classmethod
    def reject_links_and_credentials(cls, value):
        if isinstance(value, str) and (
            _NATIVE_RESEARCH_URL.search(value) or _NATIVE_RESEARCH_CREDENTIAL.search(value)
        ):
            raise ValueError("research inputs cannot contain URLs or credentials")
        return value


class AshareResearchVars(NativeResearchVars):
    symbol: str
    start_date: datetime.date
    end_date: datetime.date
    question: Annotated[str, StringConstraints(max_length=5000, pattern=r"^[^\x00-\x1f\x7f]*$")] = "核对区间行情证据，说明观察边界与下一步。"

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value):
        return _normalize_a_share_code(value)

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def strict_date(cls, value):
        return _strict_iso_date(value)

    @model_validator(mode="after")
    def valid_window(self):
        if self.end_date < self.start_date or self.end_date > datetime.date.today():
            raise ValueError("研究日期区间无效")
        return self


class QuantStrategyDeskVars(NativeResearchVars):
    market: _NATIVE_RESEARCH_TEXT
    goal: _NATIVE_RESEARCH_TEXT


class FactorResearchCommitteeVars(NativeResearchVars):
    market: _NATIVE_RESEARCH_TEXT
    factor_type: _NATIVE_RESEARCH_TEXT


class MlQuantLabVars(NativeResearchVars):
    market: _NATIVE_RESEARCH_TEXT
    target_variable: _NATIVE_RESEARCH_TEXT
    goal: _NATIVE_RESEARCH_TEXT


class FundamentalResearchTeamVars(NativeResearchVars):
    target: _NATIVE_RESEARCH_TEXT
    market: _NATIVE_RESEARCH_TEXT


SectorRotationTeamVars = QuantStrategyDeskVars


class EventDrivenTaskForceVars(NativeResearchVars):
    market: _NATIVE_RESEARCH_TEXT
    event_type: _NATIVE_RESEARCH_TEXT | None = None


EquityResearchTeamVars = QuantStrategyDeskVars


InvestmentCommitteeVars = FundamentalResearchTeamVars


_RESEARCH_PRESETS = {
    "mona_ashare_research": AshareResearchVars,
    "quant_strategy_desk": QuantStrategyDeskVars,
    "factor_research_committee": FactorResearchCommitteeVars,
    "ml_quant_lab": MlQuantLabVars,
    "fundamental_research_team": FundamentalResearchTeamVars,
    "sector_rotation_team": SectorRotationTeamVars,
    "event_driven_task_force": EventDrivenTaskForceVars,
    "equity_research_team": EquityResearchTeamVars,
    "investment_committee": InvestmentCommitteeVars,
}


class StartSwarm(HostInput):
    preset_name: Literal[
        "mona_ashare_research", "quant_strategy_desk", "factor_research_committee", "ml_quant_lab",
        "fundamental_research_team", "sector_rotation_team", "event_driven_task_force",
        "equity_research_team", "investment_committee",
    ]
    user_vars: (
        AshareResearchVars | QuantStrategyDeskVars | FactorResearchCommitteeVars | MlQuantLabVars
        | FundamentalResearchTeamVars | SectorRotationTeamVars | EventDrivenTaskForceVars
        | EquityResearchTeamVars | InvestmentCommitteeVars
    )

    @model_validator(mode="after")
    def matching_preset_contract(self):
        expected = _RESEARCH_PRESETS[self.preset_name]
        if not isinstance(self.user_vars, expected):
            raise ValueError("user_vars do not match the selected Vibe team")
        return self

    @model_serializer(mode="wrap")
    def preserve_only_supplied_variables(self, handler):
        data = handler(self)
        data["user_vars"] = self.user_vars.model_dump(
            mode="json", exclude_none=True, exclude_unset=self.preset_name != "mona_ashare_research",
        )
        return data


class MarketQuery(HostInput):
    symbol: str = Field(pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    start_date: datetime.date
    end_date: datetime.date
    interval: Literal["1m", "5m", "15m", "30m", "1H", "1D", "1W", "1M"] = "1D"
    source: Literal["tencent", "eastmoney"] | None = None

    @model_validator(mode="after")
    def valid_window(self):
        if self.end_date < self.start_date or self.end_date > datetime.date.today():
            raise ValueError("行情日期区间无效")
        return self


class EventTicket(HostInput):
    kind: Literal["session", "swarm"]
    object_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    last_event_id: str = Field(default="", max_length=160, pattern=r"^[a-zA-Z0-9_.:-]*$")


class ExtractShadow(HostInput):
    operation: Literal["extract_shadow_strategy"]
    upload_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    min_support: int = Field(default=3, ge=1, le=100)
    max_rules: int = Field(default=5, ge=1, le=20)


class AnalyzeTradeJournal(HostInput):
    operation: Literal["analyze_trade_journal"]
    upload_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ShadowInput(HostInput):
    shadow_id: str = Field(pattern=r"^shadow_[a-f0-9]{8}$")


class ShadowBacktest(ShadowInput):
    operation: Literal["run_shadow_backtest"]
    window_start: datetime.date | None = None
    window_end: datetime.date | None = None
    upload_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    source: Literal["auto", "local", "tencent", "eastmoney"] = "auto"
    per_market_count: int = Field(default=5, ge=1, le=100)
    markets: list[Literal["china_a"]] = Field(default_factory=lambda: ["china_a"], min_length=1, max_length=1)


class ShadowReport(ShadowInput):
    operation: Literal["render_shadow_report"]
    include_today_signals: Literal[False] = False
    window_start: datetime.date
    window_end: datetime.date
    upload_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    source: Literal["auto", "local", "tencent", "eastmoney"]
    per_market_count: int = Field(ge=1, le=100)
    markets: list[Literal["china_a"]] = Field(min_length=1, max_length=1)


class ShadowScan(ShadowInput):
    operation: Literal["scan_shadow_signals"]
    date: datetime.date | None = None
    per_market: int = Field(default=3, ge=1, le=100)
    source: Literal["auto", "local", "tencent", "eastmoney"] = "auto"


class StrategyCostOverrides(HostInput):
    commission_rate: float | None = Field(default=None, ge=0, lt=1, allow_inf_nan=False)
    commission_min: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    stamp_tax: float | None = Field(default=None, ge=0, lt=1, allow_inf_nan=False)
    transfer_fee: float | None = Field(default=None, ge=0, lt=1, allow_inf_nan=False)
    slippage: float | None = Field(default=None, ge=0, lt=1, allow_inf_nan=False)

    @field_validator("commission_rate", "commission_min", "stamp_tax", "transfer_fee", "slippage", mode="before")
    @classmethod
    def json_number_only(cls, value):
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("cost overrides must be JSON numbers")
        return value


def _strict_iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("date must use YYYY-MM-DD")
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("date must use YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise ValueError("date must use YYYY-MM-DD")
    return parsed


def _normalize_a_share_code(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("expected an A-share symbol")
    value = value.upper()
    if re.fullmatch(r"[0-9]{6}", value):
        suffix = "SH" if value.startswith("6") else "BJ" if value.startswith(("4", "8", "92")) else "SZ"
        value = f"{value}.{suffix}"
    if not re.fullmatch(r"[0-9]{6}\.(SH|SZ|BJ)", value):
        raise ValueError("expected a six-digit A-share symbol")
    return value


_BACKTEST_GROUP_NAME = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[^\x00-\x1f\x7f]+$")]
_BACKTEST_GROUP_WEIGHT = Annotated[float, Field(gt=0, le=1, allow_inf_nan=False)]


class BacktestOptimizerParams(HostInput):
    lookback: int | None = Field(default=None, ge=1, le=10_000)
    risk_free: float | None = Field(default=None, allow_inf_nan=False)
    risk_aversion: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    turnover_penalty: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    max_per_name: float | None = Field(default=None, gt=0, le=1, allow_inf_nan=False)
    groups: dict[str, _BACKTEST_GROUP_NAME] | None = Field(default=None, max_length=100)
    max_per_group: dict[_BACKTEST_GROUP_NAME, _BACKTEST_GROUP_WEIGHT] | None = Field(default=None, max_length=100)

    @field_validator("lookback", mode="before")
    @classmethod
    def integer_lookback(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("lookback must be a JSON integer")
        return value

    @field_validator("risk_free", "risk_aversion", "turnover_penalty", "max_per_name", mode="before")
    @classmethod
    def json_number_only(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("optimizer parameters must be JSON numbers")
        return value

    @field_validator("groups")
    @classmethod
    def safe_group_mapping(cls, value):
        if value is None:
            return None
        normalized = {}
        for code, group in value.items():
            symbol = _normalize_a_share_code(code)
            if not group.strip():
                raise ValueError("group names must not be blank")
            if symbol in normalized:
                raise ValueError("duplicate optimizer group symbol")
            normalized[symbol] = group
        return normalized

    @field_validator("max_per_group", mode="before")
    @classmethod
    def strict_group_weights(cls, value):
        if value is not None:
            if not isinstance(value, dict):
                raise ValueError("max_per_group must be a JSON object")
            if any(isinstance(weight, bool) or not isinstance(weight, (int, float)) for weight in value.values()):
                raise ValueError("group weights must be JSON numbers")
        return value

    @model_validator(mode="after")
    def valid_group_caps(self):
        if self.max_per_group and not self.groups:
            raise ValueError("max_per_group requires groups")
        if self.max_per_group and not set(self.max_per_group).issubset(set(self.groups.values())):
            raise ValueError("max_per_group keys must be present in groups")
        return self


class BacktestMonteCarlo(HostInput):
    n_simulations: int | None = Field(default=None, ge=1, le=20_000)
    seed: int | None = Field(default=None, ge=0)

    @field_validator("n_simulations", "seed", mode="before")
    @classmethod
    def strict_integer(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("monte_carlo parameters must be JSON integers")
        return value


class BacktestBootstrap(HostInput):
    n_bootstrap: int | None = Field(default=None, ge=1, le=20_000)
    confidence: float | None = Field(default=None, gt=0, lt=1, allow_inf_nan=False)
    seed: int | None = Field(default=None, ge=0)

    @field_validator("n_bootstrap", "seed", mode="before")
    @classmethod
    def strict_integer(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("bootstrap parameters must be JSON integers")
        return value

    @field_validator("confidence", mode="before")
    @classmethod
    def json_confidence(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("confidence must be a JSON number")
        return value


class BacktestWalkForward(HostInput):
    n_windows: int | None = Field(default=None, ge=1, le=100)

    @field_validator("n_windows", mode="before")
    @classmethod
    def strict_window_count(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("n_windows must be a JSON integer")
        return value


class BacktestValidation(HostInput):
    monte_carlo: BacktestMonteCarlo | None = None
    bootstrap: BacktestBootstrap | None = None
    walk_forward: BacktestWalkForward | None = None


class BacktestStrategyParameters(HostInput):
    momentum_window: int | None = Field(default=None, gt=0)
    vol_window: int | None = Field(default=None, gt=0)
    top_n: int | None = Field(default=None, gt=0)
    rebalance_freq: int | None = Field(default=None, gt=0)

    @field_validator("momentum_window", "vol_window", "top_n", "rebalance_freq", mode="before")
    @classmethod
    def strict_strategy_integers(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("strategy parameters must be JSON integers")
        return value


class BacktestSettings(StrategyCostOverrides):
    codes: list[str] | None = Field(default=None, min_length=1, max_length=5000)
    start_date: datetime.date | None = None
    end_date: datetime.date | None = None
    source: Literal[
        "tushare", "okx", "nobitex", "wallex", "binance", "yfinance", "akshare", "baostock",
        "tencent", "mootdx", "ccxt", "futu", "eastmoney", "sina", "stooq", "yahoo", "finnhub",
        "alphavantage", "tiingo", "fmp", "gildata", "qveris", "india_broker", "pykrx", "longbridge",
        "mt5", "tickerall", "b3_cotahist", "local", "auto",
    ] | None = None
    interval: Literal["1m", "5m", "15m", "30m", "1H", "4H", "1D", "1W", "1M"] | None = None
    initial_cash: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    position_adjustment: Literal["hold", "rebalance"] | None = None
    rebalance_mask: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)] | list[str] | None = Field(default=None, max_length=500)
    rebalance_tolerance: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    benchmark: str | None = Field(default=None, pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    warmup_bars: int | None = Field(default=None, ge=0)
    evaluation_start_date: datetime.date | None = None
    optimizer: Literal[
        "equal_volatility", "risk_parity", "mean_variance", "max_diversification", "turnover_aware",
    ] | None = None
    optimizer_params: BacktestOptimizerParams | None = None
    validation: BacktestValidation | None = None

    @field_validator("start_date", "end_date", "evaluation_start_date", mode="before")
    @classmethod
    def strict_dates(cls, value):
        return None if value is None else _strict_iso_date(value)

    @field_validator("codes")
    @classmethod
    def normalized_a_share_codes(cls, value):
        if value is not None:
            normalized = []
            for code in value:
                normalized.append(_normalize_a_share_code(code))
            if len(set(normalized)) != len(normalized):
                raise ValueError("duplicate backtest codes")
            return normalized
        return value

    @field_validator("benchmark")
    @classmethod
    def normalize_benchmark(cls, value):
        if value is None:
            return None
        return _normalize_a_share_code(value)

    @field_validator("warmup_bars", mode="before")
    @classmethod
    def strict_warmup_bars(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, int)):
            raise ValueError("warmup_bars must be a JSON integer")
        return value

    @field_validator("rebalance_tolerance", "initial_cash", mode="before")
    @classmethod
    def json_number_only(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise ValueError("backtest settings must be JSON numbers")
        return value

    @field_validator("rebalance_mask")
    @classmethod
    def strict_rebalance_dates(cls, value):
        if isinstance(value, list):
            if not value:
                raise ValueError("rebalance date list must not be empty")
            for item in value:
                _strict_iso_date(item)
        return value

    @model_validator(mode="after")
    def valid_backtest_settings(self):
        if self.start_date is not None and self.end_date is not None and self.start_date > self.end_date:
            raise ValueError("start_date must be <= end_date")
        if self.warmup_bars is not None and self.evaluation_start_date is not None:
            raise ValueError("warmup_bars and evaluation_start_date are mutually exclusive")
        if self.rebalance_mask is not None and "position_adjustment" in self.model_fields_set and self.position_adjustment == "hold":
            raise ValueError("rebalance_mask requires position_adjustment='rebalance'")
        return self


class StrategyScope(HostInput):
    kind: Literal["all_a", "industry", "watchlist"]
    industry_code: str | None = Field(default=None, pattern=r"^BK[0-9]{4,8}$")
    codes: list[str] | None = Field(default=None, min_length=1, max_length=5000)

    @field_validator("codes")
    @classmethod
    def normalized_scope_codes(cls, value):
        if value is None:
            return None
        normalized = [_normalize_a_share_code(code) for code in value]
        if len(set(normalized)) != len(normalized):
            raise ValueError("duplicate scope codes")
        return normalized

    @model_validator(mode="after")
    def matching_scope_fields(self):
        if (self.industry_code is not None) != (self.kind == "industry"):
            raise ValueError("industry scope requires an industry code")
        if (self.codes is not None) != (self.kind == "watchlist"):
            raise ValueError("only watchlist scope accepts explicit stock codes")
        return self

    @model_serializer(mode="wrap")
    def selected_scope_fields(self, handler):
        return {key: value for key, value in handler(self).items() if value is not None}


class Backtest(HostInput):
    operation: Literal["backtest"]
    run_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    template_id: Literal["vibe_multifactor_example"] | None = None
    strategy_id: StrategyLibraryId | None = None
    strategy_version: StrategyVersion | None = None
    settings: BacktestSettings | None = None
    strategy_parameters: BacktestStrategyParameters | None = None
    scope: StrategyScope | None = None

    @model_validator(mode="after")
    def exactly_one_backtest_source(self):
        if sum(value is not None for value in (self.run_id, self.template_id, self.strategy_id)) != 1:
            raise ValueError("provide exactly one backtest source")
        if (self.strategy_id is None) != (self.strategy_version is None):
            raise ValueError("strategy source and version must be provided together")
        if self.scope is not None and (self.strategy_id is None or self.settings is not None and "codes" in self.settings.model_fields_set):
            raise ValueError("strategy scope and settings codes are mutually exclusive")
        if self.run_id is not None and self.strategy_parameters is not None and self.strategy_parameters.model_dump(exclude_none=True):
            raise ValueError("strategy_parameters are supported only by vibe_multifactor_example")
        if self.strategy_id is not None and self.strategy_id != "builtin:multi-factor" and self.strategy_parameters is not None and self.strategy_parameters.model_dump(exclude_none=True):
            raise ValueError("strategy parameters are read-only for this strategy")
        return self

    @model_serializer(mode="wrap")
    def omit_empty_strategy_parameters(self, handler):
        data = handler(self)
        if self.run_id is None:
            data.pop("run_id", None)
        if self.template_id is None:
            data.pop("template_id", None)
        if self.strategy_id is None:
            data.pop("strategy_id", None)
            data.pop("strategy_version", None)
        if self.scope is None:
            data.pop("scope", None)
        if self.settings is None:
            data.pop("settings", None)
        else:
            data["settings"] = self.settings.model_dump(mode="json", exclude_unset=True)
        if self.strategy_parameters is None or not self.strategy_parameters.model_fields_set:
            data.pop("strategy_parameters", None)
        else:
            data["strategy_parameters"] = self.strategy_parameters.model_dump(mode="json", exclude_unset=True)
        return data


class StrategyScan(HostInput):
    operation: Literal["strategy_scan"]
    strategy_id: StrategyLibraryId
    strategy_version: StrategyVersion
    settings: BacktestSettings | None = None
    strategy_parameters: BacktestStrategyParameters | None = None
    scope: StrategyScope | None = None

    @model_validator(mode="after")
    def supported_parameters(self):
        if self.scope is not None and self.settings is not None and "codes" in self.settings.model_fields_set:
            raise ValueError("strategy scope and settings codes are mutually exclusive")
        if self.strategy_id != "builtin:multi-factor" and self.strategy_parameters is not None and self.strategy_parameters.model_dump(exclude_none=True):
            raise ValueError("strategy parameters are read-only for this strategy")
        return self

    @model_serializer(mode="wrap")
    def explicit_scan_settings(self, handler):
        data = handler(self)
        if self.scope is None:
            data.pop("scope", None)
        for name in ("settings", "strategy_parameters"):
            value = getattr(self, name)
            if value is None or not value.model_fields_set:
                data.pop(name, None)
            else:
                data[name] = value.model_dump(mode="json", exclude_unset=True)
        return data


class StrategyDelete(HostInput):
    operation: Literal["strategy_delete"]
    strategy_id: StrategyLibraryId
    strategy_version: StrategyVersion

    @field_validator("strategy_id")
    @classmethod
    def custom_strategy_only(cls, value):
        if not value.startswith("sdm:") or ".." in value:
            raise ValueError("only custom strategies can be deleted")
        return value


class StrategyCostScenario(HostInput):
    scenario_id: str = Field(min_length=1, max_length=32)
    overrides: StrategyCostOverrides

    @field_validator("scenario_id")
    @classmethod
    def safe_scenario_id(cls, value):
        if value != "source_config" and not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", value):
            raise ValueError("invalid cost scenario id")
        return value

    @model_validator(mode="after")
    def validate_overrides(self):
        configured = bool(self.overrides.model_fields_set)
        if self.scenario_id == "source_config" and configured:
            raise ValueError("source_config scenario cannot override costs")
        if self.scenario_id != "source_config" and not configured:
            raise ValueError("stress scenario requires at least one cost override")
        return self


def _source_config_cost_scenario() -> StrategyCostScenario:
    return StrategyCostScenario(scenario_id="source_config", overrides=StrategyCostOverrides())


class StrategyOOSValidation(HostInput):
    operation: Literal["strategy_oos_validation"]
    run_id: str = Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")
    window_start: datetime.date
    window_end: datetime.date
    cost_scenarios: list[StrategyCostScenario] = Field(default_factory=lambda: [_source_config_cost_scenario()], min_length=1, max_length=3)

    @field_validator("window_start", "window_end", mode="before")
    @classmethod
    def strict_iso_date(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("date must use YYYY-MM-DD")
        return value

    @model_validator(mode="after")
    def validate_scenarios_and_window(self):
        if self.window_end < self.window_start:
            raise ValueError("test window is invalid")
        ids = [scenario.scenario_id for scenario in self.cost_scenarios]
        if len(ids) != len(set(ids)) or ids.count("source_config") != 1:
            raise ValueError("cost scenarios require one unique source_config entry")
        return self


class StrictFactorValidation(HostInput):
    operation: Literal["strict_factor_validation"]
    zoo: Literal["alpha101", "qlib158"]
    start_date: datetime.date
    end_date: datetime.date
    oos_cutoff: datetime.date
    n_random_seeds: int = Field(default=5, ge=1, le=5)
    horizon: int = Field(default=1, ge=1, le=21)
    top: int = Field(default=20, ge=1, le=100)

    @field_validator("start_date", "end_date", "oos_cutoff", mode="before")
    @classmethod
    def strict_iso_date(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("date must use YYYY-MM-DD")
        return value

    @field_validator("n_random_seeds", "horizon", "top", mode="before")
    @classmethod
    def integer_only(cls, value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("value must be a JSON integer")
        return value

    @model_validator(mode="after")
    def validate_period_and_oos_split(self):
        if not self.start_date < self.oos_cutoff < self.end_date:
            raise ValueError("OOS cutoff must fall strictly inside the requested period")
        try:
            max_end = self.start_date.replace(year=self.start_date.year + 5)
        except ValueError:
            max_end = self.start_date.replace(year=self.start_date.year + 5, day=28)
        if self.end_date > max_end:
            raise ValueError("factor validation period cannot exceed five calendar years")
        return self


_ALPHA_PERIOD = Annotated[
    str,
    StringConstraints(
        min_length=4,
        max_length=32,
        pattern=r"^(?:[0-9]{4}-[0-9]{4}|[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9]{4}-[0-9]{2}-[0-9]{2})$",
    ),
]
_ALPHA_ID_PATTERN = r"^[a-z][a-z0-9]+_[a-z0-9_]{1,64}$"


class AlphaBenchOperation(HostInput):
    operation: Literal["alpha_bench"]
    zoo: Literal["alpha101", "gtja191", "qlib158", "academic", "fundamental"]
    universe: Literal["csi300", "sp500", "btc-usdt"]
    period: _ALPHA_PERIOD
    alpha_id: str | None = Field(default=None, pattern=_ALPHA_ID_PATTERN)
    top: int = Field(default=20, ge=1, le=500)

    @field_validator("top", mode="before")
    @classmethod
    def strict_top_integer(cls, value):
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("top must be a JSON integer")
        return value

    @field_validator("period")
    @classmethod
    def valid_native_period(cls, value):
        if re.fullmatch(r"[0-9]{4}-[0-9]{4}", value):
            start, end = (int(part) for part in value.split("-"))
            if start > end:
                raise ValueError("period start must be <= end")
        else:
            start, end = value.split("/")
            if _strict_iso_date(start) > _strict_iso_date(end):
                raise ValueError("period start must be <= end")
        return value

class AlphaCompareOperation(HostInput):
    operation: Literal["alpha_compare"]
    alpha_ids: list[str] = Field(min_length=2, max_length=50)
    universe: Literal["csi300", "sp500", "btc-usdt"]
    period: _ALPHA_PERIOD
    sort: Literal["ir", "ic_mean", "ic_positive_ratio", "ic_count"] = "ir"

    @field_validator("alpha_ids", mode="before")
    @classmethod
    def strict_alpha_ids(cls, value):
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError("alpha_ids must be a JSON array of strings")
        return value

    @field_validator("alpha_ids")
    @classmethod
    def deduplicate_alpha_ids(cls, value):
        if any(not re.fullmatch(_ALPHA_ID_PATTERN, item) for item in value):
            raise ValueError("alpha_ids contains an invalid factor id")
        result = list(dict.fromkeys(value))
        if len(result) < 2:
            raise ValueError("alpha_ids must contain at least two distinct factors")
        return result

    @field_validator("period")
    @classmethod
    def valid_native_period(cls, value):
        if re.fullmatch(r"[0-9]{4}-[0-9]{4}", value):
            start, end = (int(part) for part in value.split("-"))
            if start > end:
                raise ValueError("period start must be <= end")
        else:
            start, end = value.split("/")
            if _strict_iso_date(start) > _strict_iso_date(end):
                raise ValueError("period start must be <= end")
        return value


OPERATION_INPUT = TypeAdapter(Annotated[
    Backtest | StrategyScan | StrategyDelete | AnalyzeTradeJournal | ExtractShadow | ShadowBacktest | ShadowReport | ShadowScan
    | StrategyOOSValidation | StrictFactorValidation | AlphaBenchOperation | AlphaCompareOperation,
    Field(discriminator="operation"),
])
