import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Zap,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MonaClient } from "@/lib/mona-client";
import type { WorkflowRun } from "@/lib/types";
import {
  compareStockScreenCandidates,
  deleteStockScreenStrategy,
  fetchStockOpportunitySource,
  fetchStockScreenHistory,
  fetchStockScreenOutcomes,
  fetchStockScreenResult,
  fetchStockScreenStrategies,
  fetchStockScreenTemplates,
  saveStockScreenStrategy,
  refreshStockScreenOutcomes,
  STOCK_ROOM_CHAT_ID,
  type StockScreenCandidate,
  type StockCatalystCapture,
  type StockCatalystEvent,
  type StockScreenCompareResult,
  type StockScreenHistoryItem,
  type StockScreenReport,
  type StockScreenOutcomesResponse,
  type StockScreenDataQuality,
  type StockOpportunityCandidate,
  type StockOpportunityClaim,
  type StockOpportunityEventTransmission,
  type StockOpportunityHorizon,
  type StockOpportunityHorizonView,
  type StockOpportunitySource,
  type StockValuationContext,
  type StockValuationMetric,
  type StockScreenStrategy,
  type StockScreenTemplate,
  type StockSelectionOrigin,
  type StockQuantFactorObservation,
  type StockQuantHorizon,
  type StockQuantHorizonValidation,
  type StockQuantSnapshot,
  type StockWatchlistAddInput,
  STOCK_SELECTION_ORIGIN_USAGE_NOTE,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";

const STOCK_SELECTION_TEMPLATE_REF =
  "package://com.mona.a-share-team/workflows/stock-selection.json";
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const EVIDENCE_GAP_TEXT = ["证据", "不足"].join("");
const DATA_GAP_TEXT = ["数据", "不足"].join("");

type DiscoveryTab = "ai" | "professional" | "history";
type GuideAnswer = "stable" | "growth" | "trend" | "event" | "short" | "medium" | "long";

const FILTER_FIELDS = [
  ["price", "价格"],
  ["change_pct", "涨跌幅"],
  ["volume", "成交量"],
  ["turnover", "成交额"],
  ["market_cap", "市值"],
  ["pe", "市盈率"],
  ["pb", "市净率"],
  ["roe", "净资产收益率（ROE）"],
  ["roic", "投入资本回报率（ROIC）"],
  ["gross_margin", "毛利率"],
  ["net_margin", "净利率"],
  ["eps", "每股收益（EPS）"],
  ["net_profit", "净利润"],
  ["revenue_yoy", "营收同比"],
  ["profit_yoy", "利润同比"],
  ["operating_cashflow", "经营活动现金流"],
  ["debt_ratio", "资产负债率"],
  ["ma5", "5日均线"],
  ["ma20", "20日均线"],
  ["ma60", "60日均线"],
  ["volatility20", "20日波动幅度"],
  ["momentum20", "20日价格动量"],
  ["momentum60", "60日价格动量"],
  ["listing_days", "上市天数"],
  ["is_st", "特别处理标记（ST）"],
  ["is_suspended", "停牌状态"],
  ["industry", "行业"],
] as const;
const FILTER_OPERATORS = [">=", "<=", ">", "<", "=", "!="] as const;
const RANK_FIELDS = [
  ...FILTER_FIELDS.filter(([field]) => field !== "is_st" && field !== "is_suspended" && field !== "industry"),
];

const HORIZON_LABELS: Record<string, string> = {
  short_term: "短线（约1至10个交易日）",
  swing: "波段（数周）",
  medium_term: "中线（约2周至6个月）",
  long_term: "长线（6个月以上）",
};

const OPPORTUNITY_HORIZON_DETAILS: Record<StockOpportunityHorizon, {
  label: string;
  range: string;
  question: string;
}> = {
  short_term: { label: "短线", range: "1—10 个交易日", question: "当前时点和交易风险" },
  medium_term: { label: "中线", range: "2 周—6 个月", question: "预期是否持续上修或下修" },
  long_term: { label: "长线", range: "6 个月以上", question: "价值与竞争力能否持续" },
};

const QUANT_FACTOR_LABELS: Record<string, string> = {
  momentum20: "20日价格动量",
  momentum60: "60日价格动量",
  volatility20: "20日波动幅度",
  volume: "成交量",
  turnover: "成交额",
  revenue_yoy: "营业收入同比",
  profit_yoy: "净利润同比",
  net_profit: "净利润",
  roe: "净资产收益率",
  roic: "投入资本回报率",
  gross_margin: "毛利率",
  net_margin: "净利率",
  operating_cashflow: "经营活动现金流",
  debt_ratio: "资产负债率",
  eps: "每股收益",
  pe: "市盈率",
  pb: "市净率",
};

const QUANT_HORIZON_LABELS: Record<StockQuantHorizon, string> = {
  short_term: "短线",
  medium_term: "中线",
  long_term: "长线",
};

const OPERATOR_LABELS: Record<string, string> = {
  ">=": "大于或等于",
  "<=": "小于或等于",
  ">": "大于",
  "<": "小于",
  "=": "等于",
  "!=": "不等于",
};

const DISPLAY_CODE_LABELS: Record<string, string> = {
  short_term: "短线",
  swing: "波段",
  medium_term: "中线",
  long_term: "长线",
  operating_cashflow: "经营活动现金流",
  momentum20: "20日价格动量",
  momentum60: "60日价格动量",
  volatility20: "20日波动幅度",
  industry_context: "行业信息",
  peer_valuation: "同行估值",
  partial: "部分缺失",
  stale: "使用最近缓存，可能已过期",
  unavailable: "数据源暂不可用",
  degraded: "部分缺失",
  insufficient_data: "尚未形成量化结论",
  available: "数据可用",
  complete: "数据完整",
  unknown: "待确认",
};

const FALLBACK_CARDS: StockScreenTemplate[] = [
  {
    strategy_id: "stable_business",
    name: "经营稳健",
    beginner_label: "经营稳健",
    beginner_description: "关注盈利、现金流和波动，适合先建立观察清单。",
    source: "builtin",
    horizon: "long_term",
  },
  {
    strategy_id: "quality_growth",
    name: "业绩成长",
    beginner_label: "业绩成长",
    beginner_description: "关注收入、利润和经营质量的持续改善。",
    source: "builtin",
    horizon: "medium_term",
  },
  {
    strategy_id: "trend_confirmation",
    name: "趋势机会",
    beginner_label: "趋势机会",
    beginner_description: "关注走势、成交和波动是否相互确认。",
    source: "builtin",
    horizon: "swing",
  },
  {
    strategy_id: "recent_catalyst",
    name: "近期催化",
    beginner_label: "近期催化",
    beginner_description: "从近期可核验公告中发现值得继续研究的事件线索。",
    source: "builtin",
    availability: "available",
    horizon: "short_term",
  },
];

const BEGINNER_CARD_IDS = [
  "stable_business",
  "quality_growth",
  "trend_confirmation",
  "recent_catalyst",
] as const;

function directionIcon(strategyId: string) {
  const Icon = strategyId === "stable_business"
    ? ShieldCheck
    : strategyId === "quality_growth"
      ? TrendingUp
      : strategyId === "trend_confirmation"
        ? Activity
        : Zap;
  return <Icon className="h-4 w-4" />;
}

const GUIDE_QUESTIONS: Array<{
  title: string;
  options: Array<{ label: string; value: GuideAnswer }>;
}> = [
  {
    title: "你更想关注哪类机会？",
    options: [
      { label: "经营稳定", value: "stable" },
      { label: "业绩成长", value: "growth" },
      { label: "近期走势", value: "trend" },
      { label: "事件机会", value: "event" },
    ],
  },
  {
    title: "你计划观察多久？",
    options: [
      { label: "几天到几周", value: "short" },
      { label: "一到几个月", value: "medium" },
      { label: "更长时间", value: "long" },
    ],
  },
];

interface OpportunityDiscoveryProps {
  client: MonaClient;
  onAddWatchlist: (input: StockWatchlistAddInput) => Promise<void>;
  onDeepResearch: (instrumentId: string, selectionOrigin?: StockSelectionOrigin) => void;
}

function isSelectionRun(run: WorkflowRun | null): boolean {
  if (!run) return false;
  const inputs = run.inputs ?? {};
  if (inputs.mode === "stock_selection" || inputs.selection === true) return true;
  if (typeof inputs.strategy_id === "string") return true;
  return run.workflowId.includes("stock-selection") || run.workflow.goal.includes("选股");
}

function stepLabel(step: WorkflowRun["workflow"]["steps"][number]): string {
  if (step.id === "screening" || step.id === "selection") return "市场初筛";
  if (step.id === "opportunity_research") return "候选研究";
  if (step.task) return humanizeResearchText(step.task);
  const id = step.agentId?.split(".").at(-1) ?? step.id;
  return DISPLAY_CODE_LABELS[id] ?? "当前步骤";
}

function horizonLabel(value: string | null | undefined): string {
  return value ? HORIZON_LABELS[value] ?? "观察周期待确认" : "观察周期待确认";
}

function fieldLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "筛选指标待确认";
  return FILTER_FIELDS.find(([field]) => field === value)?.[1] ?? "筛选指标待确认";
}

function filterStatisticLabel(stat: { label?: string; field?: string }): string {
  const label = typeof stat.label === "string" ? stat.label.trim() : "";
  if (label) return humanizeResearchText(label);
  const field = typeof stat.field === "string" ? stat.field.trim() : "";
  if (!field) return "其他筛选条件";
  const readable = fieldLabel(field);
  return readable === "筛选指标待确认" ? "其他筛选条件" : readable;
}

function operatorLabel(value: unknown): string {
  if (typeof value !== "string") return "比较方式待确认";
  return OPERATOR_LABELS[value] ?? "比较方式待确认";
}

function formatConditionValue(value: unknown): string {
  if (value === true) return "是";
  if (value === false) return "否";
  if (value == null || value === "") return "待提供";
  if (Array.isArray(value)) return value.map(formatConditionValue).join("、");
  if (typeof value === "number" && Number.isFinite(value)) return formatNumber(value);
  return humanizeResearchText(String(value));
}

function conditionLabel(value: { label?: string; field?: string; op?: string; value?: unknown }): string {
  if (typeof value.label === "string" && value.label.trim()) return humanizeResearchText(value.label);
  return `${fieldLabel(value.field)}${operatorLabel(value.op)}${formatConditionValue(value.value)}`;
}

function changeStateLabel(value: string | null | undefined): string {
  switch (value) {
    case "new": return "新入选";
    case "continued": return "连续入选";
    case "reentered": return "重新入选";
    case "exited": return "已退出";
    case "unchanged": return "保持入选";
    default: return value ? "状态待确认" : "状态待更新";
  }
}

function exchangeLabel(value: string | null | undefined): string {
  switch (value) {
    case "XSHG": return "上海证券交易所";
    case "XSHE": return "深圳证券交易所";
    case "BJSE": return "北京证券交易所";
    default: return value ? "交易所待确认" : "交易所待更新";
  }
}

function providerLabel(value: string | null | undefined): string {
  switch ((value ?? "").toLowerCase()) {
    case "eastmoney": return "东方财富";
    case "tushare": return "Tushare 数据服务";
    case "akshare": return "AkShare 数据服务";
    default: return value ? "来源方待确认" : "来源方未提供";
  }
}

function strategyDescription(strategy: StockScreenStrategy | null): string {
  if (!strategy) return "选择一个方向，选股分析师会把它转换成可追溯的筛选条件。";
  if (strategy.strategy_id === "combined_discovery") return "各方向独立召回后取并集、去重并统一排序；重复命中多个方向的股票更靠前。";
  if (strategy.description) return humanizeResearchText(strategy.description);
  if (strategy.source === "agent" && !strategy.filters?.length && !strategy.ranking?.length) {
    return "选股分析师尚未形成可执行条件，结果只能作为待确认请求，不能当作有效筛选。";
  }
  const count = strategy.filters?.length ?? 0;
  return count > 0
    ? `将应用 ${count} 项可解释条件，并按策略权重排序候选。`
    : "由选股分析师整理目标，再由确定性筛选服务计算结果。";
}

function hasExecutableStrategy(strategy: StockScreenStrategy | null): boolean {
  if (!strategy) return false;
  if (strategy.strategy_id === "combined_discovery") return (strategy.included_strategy_ids?.length ?? 0) >= 2;
  return strategy.source !== "agent" || Boolean(strategy.filters?.length || strategy.ranking?.length);
}

function parseResearchLimit(value: string | number): number | null {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : null;
}

function parseConditionValue(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return raw;
}

function candidateId(candidate: StockScreenCandidate): string {
  const row = candidate as StockScreenCandidate & { instrumentId?: string };
  return row.instrument_id || row.instrumentId || "";
}

function candidateSymbol(candidate: StockScreenCandidate): string {
  const id = candidateId(candidate);
  return candidate.symbol || id.split(":")[1] || "股票代码待确认";
}

function candidateExchange(candidate: StockScreenCandidate): string {
  const id = candidateId(candidate);
  return candidate.exchange || id.split(":")[0] || "XSHG";
}

function candidateMetric(candidate: StockScreenCandidate, key: string): number | null {
  const direct = candidate[key];
  const snapshot = candidate.snapshot?.[key];
  const value = typeof direct === "number" ? direct : snapshot;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function comparisonCandidateLabel(id: string, candidates: StockScreenCandidate[]): string {
  const candidate = candidates.find((item) => candidateId(item) === id);
  if (!candidate || !candidate.name?.trim()) return "候选股票（名称待确认）";
  return `${candidate.name.trim()} · 股票代码 ${candidateSymbol(candidate)}`;
}

function historyStrategyLabel(item: StockScreenHistoryItem, strategies: StockScreenStrategy[]): string {
  const directName = item.strategy_name?.trim();
  if (directName && directName !== item.strategy_id) return humanizeResearchText(directName);
  const matched = item.strategy_id
    ? strategies.find((strategy) => strategy.strategy_id === item.strategy_id)
    : undefined;
  const matchedName = matched?.name?.trim();
  return matchedName && matchedName !== item.strategy_id
    ? humanizeResearchText(matchedName)
    : "选股策略（名称待确认）";
}

function isRecentCatalystStrategy(strategy: StockScreenStrategy | null | undefined): boolean {
  return strategy?.strategy_id === "recent_catalyst" || strategy?.included_strategy_ids?.includes("recent_catalyst") === true;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  periodic_report: "定期报告", report: "定期报告", earnings: "业绩披露",
  earnings_report: "业绩报告", earnings_forecast: "业绩预告", performance_forecast: "业绩预告",
  earnings_express: "业绩快报", dividend: "利润分配", cash_dividend: "现金分红",
  buyback: "股份回购", share_reduction: "股东减持", share_increase: "股东增持",
  share_change: "股东持股变动", shareholder_change: "股东持股变动",
  major_contract: "重大合同", contract: "合同事项", project: "重大项目", product: "产品进展",
  merger: "并购事项", restructuring: "资产重组", asset_sale: "资产处置",
  financing: "融资事项", refinancing: "再融资", suspension: "停牌事项", resumption: "复牌事项",
  risk_warning: "风险警示", inquiry: "监管问询", penalty: "监管处罚", litigation: "重大诉讼",
  major_event: "重大事项", material_event: "重大事项", major_matter: "重大事项",
};

function humanizeResearchText(value: string): string {
  let text = Object.entries(EVENT_TYPE_LABELS).reduce(
    (current, [code, label]) => current.replace(new RegExp(`\\b${code}\\b`, "gi"), label),
    value,
  );
  for (const [code, label] of Object.entries(DISPLAY_CODE_LABELS)) {
    text = text.replace(new RegExp(`\\b${code}\\b`, "gi"), label);
  }
  return text
    .replace(/selection-only/gi, "仅完成确定性初筛")
    .replace(/stale_cache/gi, "最近缓存")
    .replace(new RegExp(EVIDENCE_GAP_TEXT, "g"), "关键条件待确认")
    .replace(new RegExp(DATA_GAP_TEXT, "g"), "部分条件待确认");
}

function isRunnableStrategy(strategy: StockScreenStrategy | null | undefined): boolean {
  const availability = (strategy as StockScreenTemplate | null | undefined)?.availability;
  return Boolean(strategy) && (availability !== "unavailable" || isRecentCatalystStrategy(strategy));
}

function strategyCardDescription(card: StockScreenTemplate): string {
  if (isRecentCatalystStrategy(card)) return "从近期可核验公告中发现值得继续研究的事件线索。";
  return card.description ?? card.beginner_description ?? "可编辑确定性筛选条件";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function candidateCatalystEvents(candidate: StockScreenCandidate): StockCatalystEvent[] {
  const direct = Array.isArray(candidate.catalyst_events) ? candidate.catalyst_events : null;
  const nested = candidate.snapshot?.catalyst_events;
  const raw = direct ?? (Array.isArray(nested) ? nested : []);
  return raw.filter((event): event is StockCatalystEvent => Boolean(asRecord(event)));
}

function catalystEventSource(event: StockCatalystEvent): { id: string | null; url: string | null } {
  const source = asRecord(event.source);
  const sourceId = typeof event.source_id === "string" && event.source_id.trim()
    ? event.source_id
    : Array.isArray(event.source_ids) && typeof event.source_ids[0] === "string"
      ? event.source_ids[0]
      : source && typeof source.id === "string" ? source.id : null;
  const url = typeof event.url === "string" && /^https?:\/\//i.test(event.url)
    ? event.url
    : source && typeof source.url === "string" && /^https?:\/\//i.test(source.url)
      ? source.url
      : null;
  return { id: sourceId, url };
}

function catalystEventLabel(event: StockCatalystEvent): string {
  const rawType = typeof event.event_type === "string" ? event.event_type.trim() : "";
  const type = EVENT_TYPE_LABELS[rawType.toLowerCase().replace(/[- ]/g, "_")] || (rawType && !/^[a-z_ -]+$/i.test(rawType) ? rawType : "公告事件");
  const title = typeof event.title === "string" && event.title.trim()
    ? event.title
    : typeof event.summary === "string" && event.summary.trim()
      ? event.summary
      : "未提供事件标题";
  return `${type} · ${title}`;
}

function catalystEventTime(event: StockCatalystEvent): string {
  return event.published_at || event.event_date ? formatAsOf(event.published_at || event.event_date) : "时间未提供";
}

function catalystCaptureFromReport(report: StockScreenReport | null): StockCatalystCapture | null {
  if (!report) return null;
  const direct = report.catalyst_capture ?? report.event_capture;
  if (direct) return direct;
  const quality = asRecord(report.data_quality);
  const nested = quality?.catalyst_capture ?? quality?.event_capture;
  return asRecord(nested) as StockCatalystCapture | null;
}

type CatalystDataState = "complete" | "partial" | "stale" | "unavailable" | "unknown";

function catalystDataState(report: StockScreenReport | null): CatalystDataState {
  const capture = catalystCaptureFromReport(report);
  const quality = typeof report?.data_quality === "object" ? report.data_quality.status : undefined;
  const status = capture?.status;
  const cacheStatus = capture?.cache_status;
  if (status === "unavailable" || cacheStatus === "unavailable") return "unavailable";
  if (status === "stale" || cacheStatus === "stale_cache") return "stale";
  if (status === "partial" || capture?.complete === false || quality === "partial" || capture?.error) return "partial";
  if (status === "complete" || capture?.complete === true || quality === "complete" || quality === "available") return "complete";
  return "unknown";
}

function catalystCoverageLabel(report: StockScreenReport | null, options?: { beforeRun?: boolean }): string {
  const beforeRun = options?.beforeRun ?? false;
  const capture = catalystCaptureFromReport(report);
  const state = catalystDataState(report);
  if (beforeRun && !capture) return "运行时确认公告覆盖范围";
  if (state === "unavailable") return "公告数据源暂不可用";
  if (state === "stale") return "当前使用最近缓存，公告数据可能已过期";
  if (state === "partial") {
    const loaded = capture?.loaded_count;
    const expected = capture?.expected_count;
    return typeof loaded === "number" && typeof expected === "number"
      ? `公告数据仅覆盖 ${loaded} / ${expected} 条，不能代表完整市场`
      : "公告覆盖范围不完整，不能代表完整市场";
  }
  if (state === "complete") {
    const loaded = capture?.loaded_count;
    return typeof loaded === "number" ? `已核验 ${loaded} 条公告` : "公告覆盖范围已完成核验";
  }
  return "公告覆盖范围待确认";
}

function CatalystEventFacts({
  candidate,
  limit,
}: {
  candidate: StockScreenCandidate;
  limit?: number;
}) {
  const events = candidateCatalystEvents(candidate);
  if (events.length === 0) return <p className="text-micro text-muted-foreground">暂无可核验事件</p>;
  const visible = typeof limit === "number" ? events.slice(0, limit) : events;
  return <div className="space-y-2">{visible.map((event, index) => {
    const source = catalystEventSource(event);
    return <div key={event.event_id || `${event.title || "event"}-${index}`} className="min-w-0 text-micro">
      <div className="truncate text-foreground" title={catalystEventLabel(event)}>{catalystEventLabel(event)}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
        <span>公开于 {catalystEventTime(event)}</span>
        {event.event_date && <span>事件日 {formatAsOf(event.event_date)}</span>}
        {source.url ? <a className="text-info underline-offset-2 hover:underline" href={source.url} target="_blank" rel="noreferrer">查看来源</a> : source.id ? <span title={source.id}>来源已记录</span> : <span>来源未提供</span>}
      </div>
    </div>;
  })}</div>;
}

function formatNumber(value: number | null | undefined, suffix = ""): string {
  if (value == null || !Number.isFinite(value)) return "待提供";
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;
}

function formatAsOf(value: string | null | undefined): string {
  if (!value) return "数据时间待确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "数据时间格式待确认" : date.toLocaleString("zh-CN", { hour12: false });
}

function dataQualityLabel(value: string | StockScreenDataQuality | undefined): string {
  const status = typeof value === "string" ? value : value?.status;
  if (status === "complete" || status === "available") return "数据完整";
  if (status === "partial") return "部分条件待确认";
  if (status === "stale") return "使用最近缓存，可能已过期";
  if (status === "unavailable") return "数据源暂不可用";
  if (status === "degraded") return "部分条件待确认";
  return status ? "数据状态待确认" : "数据质量待确认";
}

const VALUATION_MISSING_LABELS: Record<string, string> = {
  current_pe: "当前市盈率",
  current_pb: "当前市净率",
  peer_pe: "同行市盈率样本",
  peer_pb: "同行市净率样本",
  peer_valuation: "同行估值比较",
  industry_classification: "行业分类",
};

function valuationMissingLabel(value: string): string {
  return VALUATION_MISSING_LABELS[value] ?? "估值数据";
}

function valuationStatusLabel(value: string | undefined): string {
  if (value === "complete") return "估值数据完整";
  if (value === "partial") return "估值参考不完整";
  if (value === "unavailable") return "估值暂不判断";
  return "估值状态待确认";
}

function valuationBasisLabel(value: string | undefined): string {
  if (!value || /comparison_scope|current_pe|current_pb|peer_count|same_industry_current_snapshot/.test(value)) {
    return "同一行业当前快照中除目标公司外的正值估值样本用于比较";
  }
  return value;
}

function valuationMetricValue(
  metric: StockValuationMetric | undefined,
  current: number | null | undefined,
): StockValuationMetric {
  return metric ?? { value: current ?? null, peer_count: 0, median: null, percentile: null };
}

function valuationPercentile(value: number | null | undefined): string {
  return value == null ? "待提供" : formatNumber(value * 100, "%");
}

function ValuationMetricRow({
  label,
  metric,
  current,
}: {
  label: string;
  metric: StockValuationMetric;
  current: number | null | undefined;
}) {
  const value = metric.value ?? current;
  const hasComparison = metric.median != null && metric.percentile != null;
  return <div className="rounded-md bg-background/70 p-2.5">
    <div className="text-caption font-medium">{label}</div>
    <div className="mt-1 grid gap-1 text-micro text-muted-foreground">
      <div className="flex justify-between gap-2"><span>当前值</span><span className="tabular-nums text-foreground">{formatNumber(value)}</span></div>
      <div className="flex justify-between gap-2"><span>同行样本（不含当前公司）</span><span className="tabular-nums text-foreground">{metric.peer_count} 家</span></div>
      <div className="flex justify-between gap-2"><span>同行中位数</span><span className="tabular-nums text-foreground">{hasComparison ? formatNumber(metric.median) : "待提供"}</span></div>
      <div className="flex justify-between gap-2"><span>同行分位</span><span className="tabular-nums text-foreground">{hasComparison ? valuationPercentile(metric.percentile) : "待提供"}</span></div>
    </div>
    {!hasComparison && <p className="mt-2 text-micro text-warning">同行比较待确认，暂不能判断相对高低</p>}
  </div>;
}

function ValuationReference({
  context,
  fallbackAsOf,
}: {
  context: StockValuationContext;
  fallbackAsOf?: string | null;
}) {
  const pe = valuationMetricValue(context.pe, context.current_pe);
  const pb = valuationMetricValue(context.pb, context.current_pb);
  const missing = Array.from(new Set((context.missing_fields ?? []).map(valuationMissingLabel)));
  const hasMissingCurrent = pe.value == null && pb.value == null;
  const dataAsOf = context.as_of ?? fallbackAsOf;
  return <section className="mt-5 rounded-xl border bg-background/60 p-3.5" aria-label="估值参考">
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-caption font-medium">估值参考</h4>
      <span className="rounded-full bg-muted px-2 py-1 text-micro text-muted-foreground">{valuationStatusLabel(context.status)}</span>
    </div>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      <ValuationMetricRow label="市盈率（PE）" metric={pe} current={context.current_pe} />
      <ValuationMetricRow label="市净率（PB）" metric={pb} current={context.current_pb} />
    </div>
    <p className="mt-2 text-micro text-muted-foreground">数值越高表示相对同行估值越高</p>
    {missing.length > 0 && <p className="mt-2 rounded-md bg-warning/10 px-2 py-1.5 text-micro text-warning">{hasMissingCurrent ? "无法形成估值参考，" : "估值参考暂不完整，"}缺少：{missing.join("、")}</p>}
    <dl className="mt-3 grid gap-1 text-micro text-muted-foreground">
      <div className="flex flex-wrap justify-between gap-x-3"><dt>比较方法：</dt><dd className="text-foreground">同行业当前行情快照比较</dd></div>
      <div className="flex flex-wrap justify-between gap-x-3"><dt>数据时点：</dt><dd className="text-foreground">{formatAsOf(dataAsOf)}</dd></div>
      <div className="flex flex-wrap justify-between gap-x-3"><dt>比较口径：</dt><dd className="text-right text-foreground">{valuationBasisLabel(context.basis)}</dd></div>
    </dl>
  </section>;
}

function quantValidationLabel(value: unknown): string | null {
  if (value === "uncalibrated") return "量化未校准";
  if (value === "insufficient_data") return "尚未形成量化结论";
  if (typeof value === "string" && value.trim()) return "量化状态待验证";
  return null;
}

function quantScopeLabel(value: unknown): string {
  if (value === "industry") return "同行业比较";
  if (value === "market_fallback") return "全市场比较（同行样本不足）";
  if (value === "market") return "全市场比较";
  if (value === "mixed") return "行业与全市场混合比较";
  return "比较口径待确认";
}

function quantFactorLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return QUANT_FACTOR_LABELS[value] ?? "其他量化因子";
}

function quantObservationIsAvailable(observation: StockQuantFactorObservation): boolean {
  const status = observation.validation_status;
  return (status == null || status === "uncalibrated")
    && typeof observation.raw_value === "number"
    && Number.isFinite(observation.raw_value)
    && typeof observation.percentile_or_rank === "number"
    && Number.isFinite(observation.percentile_or_rank);
}

const QUANT_PERCENT_FIELDS = new Set([
  "momentum20", "momentum60", "volatility20", "revenue_yoy", "profit_yoy",
  "roe", "roic", "gross_margin", "net_margin", "debt_ratio", "change_pct",
]);
const QUANT_MULTIPLE_FIELDS = new Set(["pe", "pb"]);
const QUANT_PRICE_FIELDS = new Set(["price", "ma5", "ma20", "ma60"]);
const QUANT_AMOUNT_FIELDS = new Set(["turnover", "market_cap", "net_profit", "operating_cashflow"]);

function quantScaledValue(value: number, unit: string): string {
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${formatNumber(value / 100_000_000)}亿${unit}`;
  if (absolute >= 10_000) return `${formatNumber(value / 10_000)}万${unit}`;
  return `${formatNumber(value)}${unit}`;
}

function quantRawValueLabel(field: string, value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂无可核验数值";
  if (QUANT_PERCENT_FIELDS.has(field)) return `${formatNumber(value)}%`;
  if (QUANT_MULTIPLE_FIELDS.has(field)) return `${formatNumber(value)}倍`;
  if (field === "eps") return `${formatNumber(value)}元/股`;
  if (QUANT_PRICE_FIELDS.has(field)) return `${formatNumber(value)}元`;
  if (field === "volume") return quantScaledValue(value, "股");
  if (QUANT_AMOUNT_FIELDS.has(field)) return quantScaledValue(value, "元");
  if (field === "listing_days") return `${formatNumber(value)}天`;
  return `${formatNumber(value)}（单位未提供）`;
}

function quantPercentileLabel(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "暂无可核验分位";
  return value >= 0 && value <= 1 ? formatNumber(value * 100, "%") : formatNumber(value);
}

function quantDirectionLabel(value: unknown): string {
  if (value === "asc") return "数值越低越优";
  if (value === "desc") return "数值越高越优";
  return "方向待确认";
}

function QuantObservationRow({ observation }: { observation: StockQuantFactorObservation }) {
  const label = quantFactorLabel(observation.field);
  if (!label) return null;
  const available = quantObservationIsAvailable(observation);
  return <article className="rounded-md bg-background/70 p-2.5" data-testid="quant-observation-row">
    <div className="flex items-center justify-between gap-2">
      <span className="text-caption font-medium">{label}</span>
      <span className={cn("text-micro", available ? "text-foreground" : "text-warning")}>{available ? "可用观察" : "尚未形成量化结论"}</span>
    </div>
    <dl className="mt-2 grid gap-1 text-micro text-muted-foreground sm:grid-cols-2">
      <div className="flex justify-between gap-2"><dt>原始值</dt><dd className="tabular-nums text-foreground">{quantRawValueLabel(observation.field, observation.raw_value)}</dd></div>
      <div className="flex justify-between gap-2"><dt>分位/排名</dt><dd className="tabular-nums text-foreground">{quantPercentileLabel(observation.percentile_or_rank)}</dd></div>
      <div className="flex justify-between gap-2"><dt>比较口径</dt><dd className="text-right text-foreground">{quantScopeLabel(observation.scope)}</dd></div>
      <div className="flex justify-between gap-2"><dt>排序方向</dt><dd className="text-right text-foreground">{quantDirectionLabel(observation.direction)}</dd></div>
      <div className="flex justify-between gap-2"><dt>样本数</dt><dd className="tabular-nums text-foreground">{typeof observation.sample_count === "number" ? `${observation.sample_count} 个` : "未提供"}</dd></div>
      <div className="flex justify-between gap-2"><dt>缺失数</dt><dd className="tabular-nums text-foreground">{typeof observation.missing_count === "number" ? `${observation.missing_count} 个` : "未提供"}</dd></div>
      <div className="flex justify-between gap-2"><dt>数据时点</dt><dd className="text-right text-foreground">{formatAsOf(observation.as_of)}</dd></div>
      <div className="flex justify-between gap-2"><dt>来源</dt><dd className="text-right text-foreground">{observation.source_ids?.length ? `${observation.source_ids.length} 条` : "未提供"}</dd></div>
      <div className="flex justify-between gap-2 sm:col-span-2"><dt>计算版本</dt><dd className="text-right text-foreground">当前分位数排序版本</dd></div>
    </dl>
  </article>;
}

function QuantObservationGroup({
  horizon,
  validation,
}: {
  horizon: StockQuantHorizon;
  validation?: StockQuantHorizonValidation;
}) {
  const observations = validation?.factor_observations ?? [];
  const statusLabel = quantValidationLabel(validation?.validation_status) ?? (observations.length > 0 ? "量化状态待验证" : "尚未形成量化结论");
  return <section className="space-y-2" data-testid={`quant-observations-${horizon}`}>
    <div className="flex items-center justify-between gap-2"><div className="text-caption font-medium">{QUANT_HORIZON_LABELS[horizon]}</div><span className="text-micro text-muted-foreground">{statusLabel}</span></div>
    {observations.length > 0
      ? observations.map((observation, index) => <QuantObservationRow key={`${observation.field}-${index}`} observation={observation} />)
      : <p className="text-micro text-muted-foreground">暂无可用观察因子</p>}
  </section>;
}

function QuantObservationPanel({
  candidate,
  snapshot,
}: {
  candidate: StockScreenCandidate;
  snapshot?: StockQuantSnapshot | null;
}) {
  const validation = candidate.quant_validation;
  if (!validation) return null;
  const statusLabel = quantValidationLabel(validation.validation_status) ?? "量化状态待验证";
  const mediumObservations = validation.horizons?.medium_term?.factor_observations ?? [];
  const availableMedium = mediumObservations.filter(quantObservationIsAvailable).length;
  const missingMedium = mediumObservations.length > 0 ? mediumObservations.length - availableMedium : null;
  const universe = snapshot?.universe;
  const processed = typeof universe?.enriched_count === "number" ? `${universe.enriched_count} 只` : "未提供";
  const unprocessed = typeof universe?.unprocessed_after_cap === "number" ? `${universe.unprocessed_after_cap} 只` : "未提供";
  const dataAsOf = snapshot?.as_of ?? candidate.as_of;
  return <section className="mt-5 rounded-xl border bg-background/60 p-3.5" aria-label="量化观察" data-testid="quant-observation-panel">
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-caption font-medium">量化观察</h4>
      <span className={cn("rounded-full px-2 py-1 text-micro", statusLabel === "量化未校准" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground")}>{statusLabel}</span>
    </div>
    <dl className="mt-3 grid gap-2 text-micro sm:grid-cols-2">
      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">数据时点</dt><dd className="text-right text-foreground">{formatAsOf(dataAsOf)}</dd></div>
      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">因子计算覆盖</dt><dd className="text-right text-foreground">处理 {processed} / 未处理 {unprocessed}</dd></div>
      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">中线可用因子</dt><dd className="text-right text-foreground">{mediumObservations.length > 0 ? `${availableMedium} 个` : "尚未形成量化结论"}</dd></div>
      <div className="flex justify-between gap-2"><dt className="text-muted-foreground">中线缺失因子</dt><dd className="text-right text-foreground">{missingMedium == null ? "未提供" : `${missingMedium} 个`}</dd></div>
    </dl>
    <p className="mt-3 text-micro text-muted-foreground">仅展示确定性因子观察，尚未经过样本外校准，不构成支持或反对结论</p>
    <details className="mt-3 text-caption">
      <summary className="cursor-pointer text-info">查看量化因子详情</summary>
      <div className="mt-3 space-y-4">
        {(["short_term", "medium_term", "long_term"] as StockQuantHorizon[]).map((horizon) => (
          <QuantObservationGroup key={horizon} horizon={horizon} validation={validation.horizons?.[horizon]} />
        ))}
      </div>
    </details>
  </section>;
}

function runProgress(run: WorkflowRun | null): { completed: number; total: number } {
  if (!run) return { completed: 0, total: 0 };
  const steps = run.workflow?.steps ?? [];
  return {
    completed: steps.filter((step) => ["succeeded", "skipped"].includes(run.steps[step.id]?.status ?? "")).length,
    total: steps.length,
  };
}

function claimText(value: unknown): string {
  if (typeof value === "string") return humanizeResearchText(value);
  if (!value || typeof value !== "object") return "待确认";
  const claim = value as StockOpportunityClaim;
  return typeof claim.text === "string" && claim.text.trim() ? humanizeResearchText(claim.text) : "待确认";
}

function claimTypeLabel(value: unknown): string {
  if (!value || typeof value !== "object") return "待确认";
  const type = (value as StockOpportunityClaim).claim_type;
  if (type === "fact") return "事实";
  if (type === "inference") return "推断";
  return "待确认";
}

function claimSources(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const sources = (value as StockOpportunityClaim).source_ids;
  return Array.isArray(sources) ? sources.filter((source): source is string => typeof source === "string") : [];
}

function claimList(value: unknown): Array<StockOpportunityClaim | string> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StockOpportunityClaim | string => typeof item === "string" || Boolean(item && typeof item === "object"));
}

function rawClaimTextOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }
  if (typeof value !== "object") return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" && text.trim() ? text : null;
}

function rawClaimTexts(values: unknown): string[] {
  const texts: string[] = [];
  for (const item of claimList(values)) {
    const text = rawClaimTextOrNull(item);
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

function buildSelectionOrigin({
  report,
  candidate,
  opportunity,
}: {
  report: StockScreenReport | null;
  candidate: StockScreenCandidate | null;
  opportunity: StockOpportunityCandidate | null;
}): StockSelectionOrigin | null {
  const strategy = report?.strategy;
  const selectionRunId = report?.workflow_run_id?.trim();
  const selectionReportId = report?.report_id?.trim();
  const instrumentId = candidate ? candidateId(candidate).trim() : "";
  const strategyId = strategy?.strategy_id?.trim();
  const strategyName = strategy?.name?.trim();
  const strategyHorizon = strategy?.horizon;
  const rank = opportunity?.deterministic_rank ?? candidate?.rank;
  const opportunityReportId = opportunity ? report?.opportunity_research?.report_id : null;
  if (!selectionRunId || !selectionReportId || !instrumentId || !strategyId || !strategyName || !strategyHorizon || typeof rank !== "number" || !Number.isInteger(rank) || rank < 1 || (opportunity && !opportunityReportId)) return null;

  const selectionReasons = (candidate?.selection_reasons ?? [])
    .filter((reason): reason is string => typeof reason === "string" && Boolean(reason.trim()));
  const sourceIds = opportunity?.source_ids ?? [];
  const sourceCount = new Set(sourceIds.filter((source): source is string => typeof source === "string" && Boolean(source.trim())).map((source) => source.trim())).size;
  const priority = opportunity?.research_priority;
  return {
    schema_version: 1,
    selection_run_id: selectionRunId,
    selection_report_id: selectionReportId,
    opportunity_report_id: opportunityReportId ?? null,
    instrument_id: instrumentId,
    strategy_id: strategyId,
    strategy_name: strategyName,
    strategy_horizon: strategyHorizon,
    deterministic_rank: rank,
    selection_reasons: selectionReasons,
    why_now: rawClaimTextOrNull(opportunity?.why_now),
    research_priority: priority === "high" || priority === "medium" || priority === "low" ? priority : null,
    focus_questions: [...rawClaimTexts(opportunity?.watch_items), ...rawClaimTexts(opportunity?.data_gaps)].filter((text, index, values) => values.indexOf(text) === index),
    source_count: sourceCount,
    selection_as_of: report?.as_of ?? null,
    usage_note: STOCK_SELECTION_ORIGIN_USAGE_NOTE,
  };
}

function priorityLabel(value: string | undefined): string {
  if (value === "high") return "可进入深度投研";
  if (value === "medium") return "可继续研究";
  if (value === "low") return "暂不形成买卖建议";
  return "尚不能形成买卖建议";
}

function opportunityStatusLabel(value: string | undefined): string {
  if (value === "completed") return "研究完成";
  if (value === "partial") return "部分完成";
  if (value === "running") return "研究中";
  if (value === "unavailable") return "能力未接入";
  if (value === "failed") return "研究失败";
  return "尚未研究";
}

function historyStatusLabel(value: string | undefined): string {
  switch (value) {
    case "completed":
    case "succeeded":
      return "完成";
    case "partial":
      return "部分完成";
    case "unavailable":
      return "暂不可用";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "running":
      return "运行中";
    case "queued":
      return "排队中";
    default:
      return "状态待确认";
  }
}

function sourceTimestamp(value: string | null | undefined): string {
  if (!value) return "未提供";
  return formatAsOf(value);
}

interface OpportunitySourceContext {
  runId: string;
  contextId: string;
}

function sourceContext(
  runId: string | undefined,
  contextId: string | null | undefined,
): OpportunitySourceContext | null {
  const validRunId = runId?.trim();
  const validContextId = contextId?.trim();
  return validRunId && validContextId
    ? { runId: validRunId, contextId: validContextId }
    : null;
}

function OpportunitySourceRecord({
  runId,
  contextId,
  sourceId,
  label,
}: OpportunitySourceContext & {
  sourceId: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState<StockOpportunitySource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readSource = async () => {
    setOpen(true);
    if (source || loading) return;
    setLoading(true);
    setError(null);
    try {
      setSource(await fetchStockOpportunitySource(runId, contextId, sourceId));
    } catch {
      setError("来源记录暂时无法读取");
    } finally {
      setLoading(false);
    }
  };

  return <div className="min-w-0 max-w-full">
    <button type="button" className="max-w-full truncate text-info underline-offset-2 hover:underline" title={sourceId} aria-expanded={open} onClick={() => { if (open) setOpen(false); else void readSource(); }}>{label}</button>
    {open && <div className="mt-1 w-full min-w-0 rounded-md bg-muted/50 p-2 text-micro text-muted-foreground">
      <div className="mb-1 flex items-center justify-between gap-2"><span className="font-medium text-foreground">来源详情</span><button type="button" className="text-info hover:underline" onClick={() => setOpen(false)}>关闭</button></div>
      {loading && <div className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" />正在读取来源…</div>}
      {error && <div className="flex items-center justify-between gap-2 text-destructive"><span>{error}</span><button type="button" className="shrink-0 text-info hover:underline" onClick={() => void readSource()}>重试</button></div>}
      {source && !loading && !error && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1"><dt>数据提供方</dt><dd className="break-all text-foreground">{providerLabel(source.provider)}</dd><dt>来源链接</dt><dd className="break-all text-foreground">{source.url || "来源链接未提供"}</dd><dt>发布时间</dt><dd className="text-foreground">{sourceTimestamp(source.published_at)}</dd><dt>抓取时间</dt><dd className="text-foreground">{sourceTimestamp(source.fetched_at)}</dd><dt>内容指纹（技术追溯）</dt><dd className="break-all text-foreground">{source.content_hash || "未提供"}</dd></dl>}
    </div>}
  </div>;
}

function OpportunitySources({ values, context }: { values: string[]; context?: OpportunitySourceContext | null }) {
  return <div className="mt-1 flex min-w-0 flex-wrap items-start gap-x-1 text-micro text-muted-foreground"><span className="shrink-0">来源：</span><div className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-1">{values.map((sourceId, index) => context ? <OpportunitySourceRecord key={sourceId} {...context} sourceId={sourceId} label={`来源 ${index + 1}`} /> : <span key={sourceId}>来源 {index + 1}</span>)}</div></div>;
}

function OpportunityClaimList({
  title,
  values,
  empty = "暂无记录",
  sourceContext: citedSourceContext,
}: {
  title: string;
  values: unknown;
  empty?: string;
  sourceContext?: OpportunitySourceContext | null;
}) {
  const items = claimList(values);
  return <div className="mt-4"><div className="text-caption font-medium">{title}</div>{items.length === 0 ? <p className="mt-1 text-micro text-muted-foreground">{empty}</p> : <ul className="mt-1.5 space-y-2">{items.map((item, index) => <li key={`${claimText(item)}-${index}`} className="min-w-0 text-caption"><div className="flex min-w-0 items-start gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" /><span className="min-w-0 flex-1 break-words">{claimText(item)}</span><span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">{claimTypeLabel(item)}</span></div>{claimSources(item).length > 0 && <OpportunitySources values={claimSources(item)} context={citedSourceContext} />}</li>)}</ul>}</div>;
}

function horizonStatusLabel(value: string | undefined): string {
  if (value === "available") return "证据可用";
  if (value === "insufficient_data") return "当前周期待确认";
  return "当前周期状态待确认";
}

function eventStatusLabel(value: string | undefined): string {
  if (value === "available") return "证据可用";
  if (value === "insufficient_data") return "事件传导待确认";
  return "事件传导状态待确认";
}

function pricedInLabel(value: string | undefined): string {
  switch (value) {
    case "not_priced_in": return "尚未反映";
    case "partially_priced_in": return "部分反映";
    case "fully_priced_in": return "已经充分反映";
    default: return "无法判断";
  }
}

function singleClaim(value: unknown): unknown[] {
  return value == null ? [] : [value];
}

function OpportunityEventTransmission({
  transmission,
  hasCatalystEvent,
  sourceContext: citedSourceContext,
}: {
  transmission?: StockOpportunityEventTransmission | null;
  hasCatalystEvent: boolean;
  sourceContext: OpportunitySourceContext | null;
}) {
  if (!transmission) {
    return hasCatalystEvent ? <section className="mt-5 rounded-xl border bg-warning/5 p-3.5" aria-label="事件影响传导">
      <h4 className="text-caption font-medium">事件影响传导</h4>
      <p className="mt-2 text-micro text-warning">这份历史候选研究未生成可追溯的事件传导链</p>
    </section> : null;
  }

  const insufficient = transmission.status === "insufficient_data";
  const gaps = claimList(transmission.data_gaps);
  const gapText = Array.from(new Set(gaps.map(claimText).filter((item) => item !== "待确认"))).join("；") || "缺少可核验的事件、业务敞口或收入利润路径数据";
  if (insufficient) {
    return <section className="mt-5 rounded-xl border bg-warning/5 p-3.5" aria-label="事件影响传导">
      <div className="flex items-center justify-between gap-2"><h4 className="text-caption font-medium">事件传导待确认</h4><span className="rounded-full bg-warning/10 px-2 py-1 text-micro text-warning">{eventStatusLabel(transmission.status)}</span></div>
      <p className="mt-2 text-caption">当前无法形成事件影响传导判断，原因：{gapText}</p>
      <OpportunityClaimList title="还缺什么" values={gaps} empty="暂未明确具体缺失项" sourceContext={citedSourceContext} />
      <p className="mt-3 text-micro text-muted-foreground">题材联想不等于业务受益，业务涉及不等于收入或利润兑现。</p>
    </section>;
  }

  const pricedIn = pricedInLabel(transmission.priced_in);
  const pricedInBasis = singleClaim(transmission.priced_in_basis);
  const isUnknownPricing = pricedIn === "无法判断";
  return <section className="mt-5 rounded-xl border bg-background/60 p-3.5" aria-label="事件影响传导">
    <div className="flex items-center justify-between gap-2"><h4 className="text-caption font-medium">事件影响传导</h4><span className="rounded-full bg-success/10 px-2 py-1 text-micro text-success">{eventStatusLabel(transmission.status)}</span></div>
    <p className="mt-2 text-micro text-muted-foreground">题材联想不等于业务受益，业务涉及不等于收入或利润兑现。</p>
    <div className="mt-1">
      <OpportunityClaimList title="1. 可核验事件" values={singleClaim(transmission.event)} empty="未提供可核验事件" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="2. 直接影响" values={singleClaim(transmission.direct_impact)} empty="未提供直接影响" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="3. 行业与产业链传导（按顺序）" values={transmission.industry_chain} empty="未提供行业与产业链传导" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="4. 公司业务敞口" values={singleClaim(transmission.business_exposure)} empty="未提供公司业务敞口" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="5. 收入与利润验证路径" values={singleClaim(transmission.earnings_path)} empty="未提供收入与利润验证路径" sourceContext={citedSourceContext} />
    </div>
    <OpportunityClaimList title="验证时间与观察内容" values={singleClaim(transmission.validation_window)} empty="未提供验证时间与观察内容" sourceContext={citedSourceContext} />
    <div className="mt-4 rounded-md bg-muted/40 p-2.5 text-caption">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">已计价程度</span><span>{pricedIn}</span></div>
      {isUnknownPricing ? <p className="mt-1 text-micro text-muted-foreground">缺少可核验的价格与预期证据时只能显示无法判断。</p> : <OpportunityClaimList title="计价依据" values={pricedInBasis} empty="未提供计价依据" sourceContext={citedSourceContext} />}
    </div>
    <OpportunityClaimList title="最重要反证" values={transmission.counter_evidence} empty="未提供最重要反证" sourceContext={citedSourceContext} />
    <OpportunityClaimList title="失效条件" values={transmission.invalidation_conditions} empty="未提供失效条件" sourceContext={citedSourceContext} />
    <OpportunityClaimList title="数据缺口" values={transmission.data_gaps} empty="暂无明确数据缺口" sourceContext={citedSourceContext} />
  </section>;
}

function OpportunityHorizonView({
  horizon,
  view,
  sourceContext: citedSourceContext,
}: {
  horizon: StockOpportunityHorizon;
  view?: StockOpportunityHorizonView;
  sourceContext: OpportunitySourceContext | null;
}) {
  const details = OPPORTUNITY_HORIZON_DETAILS[horizon];
  if (!view) {
    return <div className="rounded-lg border bg-background/60 p-3">
      <div className="flex items-center justify-between gap-2"><div className="text-caption font-medium">{details.label} · {details.range}</div><span className="rounded-full bg-muted px-2 py-1 text-micro text-muted-foreground">独立分析未生成</span></div>
      <p className="mt-2 text-micro text-muted-foreground">核心判断：该周期独立分析未生成</p>
    </div>;
  }
  const insufficient = view.status === "insufficient_data";
  const summary = claimText(view.summary);
  const gapReasons = claimList(view.data_gaps)
    .map(claimText)
    .filter((item) => item !== "待确认");
  const reason = Array.from(new Set([summary, ...gapReasons].filter((item) => item !== "待确认"))).join("；") || "相关条件待确认";
  return <details open={horizon === "medium_term"} className="rounded-lg border bg-background/60 p-3">
    <summary className="cursor-pointer list-none">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="text-caption font-medium">{details.label} · {details.range}</div><div className="mt-1 text-micro text-muted-foreground">回答：{details.question}</div></div>
        <span className={cn("shrink-0 rounded-full px-2 py-1 text-micro", insufficient ? "bg-warning/10 text-warning" : "bg-success/10 text-success")}>{horizonStatusLabel(view.status)}</span>
      </div>
      <p className="mt-2 text-caption"><span className="text-muted-foreground">核心判断：</span>{insufficient ? `当前无法形成${details.label}判断，原因：${reason}` : summary}</p>
    </summary>
    <div className="mt-3 border-t pt-3">
      <OpportunityClaimList title="支持证据" values={view.supporting_evidence} empty="未提供支持证据" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="最重要反证" values={view.counter_evidence} empty="未提供反证，不能把当前判断视为完整" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="后续观察" values={view.watch_items} empty="未提供后续观察项" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="失效条件" values={view.invalidation_conditions} empty="未提供失效条件" sourceContext={citedSourceContext} />
      <OpportunityClaimList title="数据缺口" values={view.data_gaps} empty={insufficient ? "未说明具体数据缺口" : "暂无明确数据缺口"} sourceContext={citedSourceContext} />
    </div>
  </details>;
}

function OpportunityDetail({ candidate, workflowRunId, hasCatalystEvent = false }: { candidate: StockOpportunityCandidate; workflowRunId?: string; hasCatalystEvent?: boolean }) {
  const gaps = claimList(candidate.data_gaps);
  const citedSourceContext = sourceContext(workflowRunId, candidate.context_id);
  const horizonViews = candidate.horizon_views;
  const horizonResearch = horizonViews ? <div className="mt-5 space-y-2"><div className="text-caption font-medium">三周期候选研究</div><div className="grid gap-2"><OpportunityHorizonView horizon="short_term" view={horizonViews.short_term} sourceContext={citedSourceContext} /><OpportunityHorizonView horizon="medium_term" view={horizonViews.medium_term} sourceContext={citedSourceContext} /><OpportunityHorizonView horizon="long_term" view={horizonViews.long_term} sourceContext={citedSourceContext} /></div></div> : <p className="mt-5 rounded-md bg-warning/10 px-2 py-1.5 text-micro text-warning">这份历史候选研究未生成短线、中线、长线独立分析</p>;
  const sharedInformation = horizonViews ? <details className="mt-5 rounded-lg border bg-background/60 p-3"><summary className="cursor-pointer text-caption font-medium">跨周期共同信息</summary><div className="mt-1"><OpportunityClaimList title="跨周期机会假设" values={candidate.thesis} empty="未形成跨周期机会假设" sourceContext={citedSourceContext} /><OpportunityClaimList title="相对候选特点" values={candidate.relative_edge} empty="暂无同批候选比较" sourceContext={citedSourceContext} /><OpportunityClaimList title="共同数据缺口" values={gaps} empty="暂无明确共同数据缺口" sourceContext={citedSourceContext} /></div></details> : <><OpportunityClaimList title="机会假设" values={candidate.thesis} empty="未形成独立机会假设" sourceContext={citedSourceContext} /><OpportunityClaimList title="支持证据" values={candidate.supporting_evidence} empty="没有可引用的支持证据" sourceContext={citedSourceContext} /><OpportunityClaimList title="反对证据" values={candidate.counter_evidence} empty="暂无反对证据，当前只能作为待核验线索" sourceContext={citedSourceContext} /><OpportunityClaimList title="相对候选特点" values={candidate.relative_edge} empty="暂无同批候选比较" sourceContext={citedSourceContext} /><OpportunityClaimList title="后续观察" values={candidate.watch_items} empty="暂无观察项" sourceContext={citedSourceContext} /><OpportunityClaimList title="失效条件" values={candidate.invalidation_conditions} empty="暂无明确失效条件" sourceContext={citedSourceContext} />{gaps.length > 0 && <OpportunityClaimList title="数据缺口" values={gaps} sourceContext={citedSourceContext} />}</>;
  return <section className="min-w-0 rounded-xl bg-info/5 p-4"><div className="flex items-center justify-between gap-2"><h3 className="text-ui font-medium">人工智能机会研究</h3><span className="rounded-full bg-background/80 px-2 py-1 text-micro text-info">{priorityLabel(candidate.research_priority)}</span></div><div className="mt-3 min-w-0"><div className="text-micro text-muted-foreground">为什么现在值得研究 · 推断需结合证据验证</div><p className="mt-1 break-words text-caption">{claimText(candidate.why_now)}</p>{claimSources(candidate.why_now).length > 0 && <OpportunitySources values={claimSources(candidate.why_now)} context={citedSourceContext} />}</div><OpportunityEventTransmission transmission={candidate.event_transmission} hasCatalystEvent={hasCatalystEvent} sourceContext={citedSourceContext} />{horizonResearch}{sharedInformation}</section>;
}

const SELECTION_OUTCOME_WINDOWS = [5, 20, 60] as const;

function outcomeWindowLabel(window: number): string {
  return `第 ${window} 个交易日`;
}

function outcomeStatusLabel(row: StockScreenOutcomesResponse["observations"][number] | null): string {
  if (!row || row.status === "pending") return "尚未到观察日期";
  if (row.status === "complete") return "数据完整";
  return outcomeIncompleteReason(row);
}

function outcomeIncompleteReason(row: StockScreenOutcomesResponse["observations"][number] | null): string {
  const labels: Record<string, string> = {
    window_not_mature: "尚未到观察日期",
    missing_benchmark_volume: "基准成交量缺失",
    missing_benchmark_price: "基准价格缺失",
    missing_benchmark_bar: "基准缺少对应交易日行情",
    missing_target_bar: "标的缺少对应交易日行情",
    missing_target_volume: "标的成交量缺失",
    missing_target_price: "标的价格缺失",
    upstream_unavailable: "行情数据暂不可用",
  };
  const rawCode = row?.data_status?.trim();
  const rawLabel = row?.data_status_label?.trim();
  return (rawCode && labels[rawCode]) || (rawLabel && labels[rawLabel])
    || (rawLabel && !/^[A-Za-z0-9_.:-]+$/.test(rawLabel) ? rawLabel : null)
    || "数据不完整，原因待确认";
}

function outcomeDateLabel(value: string | null): string {
  return value ? value.slice(0, 10) : "待提供";
}

function outcomePercentLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "待提供";
  return `${value >= 0 ? "+" : ""}${formatNumber(value, "%")}`;
}

function outcomeRowFor(
  outcomes: StockScreenOutcomesResponse,
  instrumentId: string,
  window: 5 | 20 | 60,
) {
  return [...outcomes.observations, ...outcomes.pending].find(
    (row) => row.instrument_id === instrumentId && row.window === window,
  ) ?? null;
}

function SelectionOutcomeWindow({
  row,
  window,
  benchmarkName,
}: {
  row: StockScreenOutcomesResponse["observations"][number] | null;
  window: 5 | 20 | 60;
  benchmarkName: string;
}) {
  const status = outcomeStatusLabel(row);
  return <article className="rounded-lg border bg-background/60 p-3" data-testid={`selection-outcome-window-${window}`}>
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-caption font-medium">{outcomeWindowLabel(window)}</h4>
      <span className={cn("rounded-full px-2 py-0.5 text-micro", row?.status === "complete" ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>{status}</span>
    </div>
    {!row ? <p className="mt-2 text-micro text-muted-foreground">暂无该观察窗口记录。</p> : row.status === "complete" ? <>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-micro">
        <span className="text-muted-foreground">标的收益</span><span className="text-right tabular-nums">{outcomePercentLabel(row.target_return_pct)}</span>
        <span className="text-muted-foreground">基准收益（{benchmarkName}）</span><span className="text-right tabular-nums">{outcomePercentLabel(row.benchmark_return_pct)}</span>
        <span className="text-muted-foreground">相对收益（标的减基准）</span><span className="text-right tabular-nums">{outcomePercentLabel(row.relative_return_pct)}</span>
      </div>
      <p className="mt-2 text-micro text-muted-foreground">起止日：{outcomeDateLabel(row.entry_date)} 至 {outcomeDateLabel(row.exit_date)}</p>
    </> : <>
      <p className="mt-2 text-micro text-muted-foreground">{row.status === "pending" ? "当前尚未到达该观察日期，暂不计算收益。" : `数据不完整：${outcomeIncompleteReason(row)}`}</p>
      {(row.entry_date || row.exit_date) && <p className="mt-1 text-micro text-muted-foreground">已记录日期：{outcomeDateLabel(row.entry_date)} 至 {outcomeDateLabel(row.exit_date)}</p>}
    </>}
  </article>;
}

function SelectionOutcomePanel({
  outcomes,
  loading,
  refreshing,
  error,
  candidate,
  onReload,
  onRefresh,
}: {
  outcomes: StockScreenOutcomesResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  candidate: StockScreenCandidate | null;
  onReload: () => void;
  onRefresh: () => void;
}) {
  const summary = outcomes?.summary;
  const benchmarkName = outcomes?.public_market_benchmark.name || "中证全指";
  const hasLocalObservations = Boolean(outcomes?.observations.length);
  return <section className="rounded-xl bg-muted/25 p-4" data-testid="selection-outcomes">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 className="text-ui font-medium">历史验证</h3>
        <p className="mt-0.5 text-micro text-muted-foreground">比较候选股票与{benchmarkName}在报告日后的实际表现</p>
      </div>
      <Button variant="outline" size="sm" disabled={refreshing || loading || !outcomes} onClick={onRefresh}>{refreshing ? "正在更新…" : "更新历史结果"}</Button>
    </div>
    <p className="mt-2 rounded-md bg-info/5 px-2.5 py-2 text-micro text-info">选股是候选排序，不计算涨跌胜率。</p>
    {loading && !outcomes ? <div className="flex items-center gap-2 py-5 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取本地历史结果…</div> : outcomes ? <>
      {loading && <div className="mt-3 flex items-center gap-2 text-micro text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取最新本地历史结果，先显示最近一次结果…</div>}
      {error && <div className="mt-3 rounded-md bg-warning/10 px-2.5 py-2 text-micro text-warning"><p>{error}</p><div className="mt-2 flex gap-2"><Button variant="outline" size="sm" onClick={onReload}>重试读取</Button><Button size="sm" onClick={onRefresh} disabled={refreshing}>重试更新</Button></div></div>}
      <div className="mt-3 grid grid-cols-2 gap-2 text-micro sm:grid-cols-4" data-testid="selection-outcome-summary">
        <div className="rounded-md border bg-background/60 px-2.5 py-2"><div className="text-muted-foreground">候选数</div><div className="mt-1 text-caption font-medium">{summary?.candidate_count ?? 0}</div></div>
        <div className="rounded-md border bg-background/60 px-2.5 py-2"><div className="text-muted-foreground">已到观察日期的结果数</div><div className="mt-1 text-caption font-medium">{summary?.mature_window_count ?? 0}</div></div>
        <div className="rounded-md border bg-background/60 px-2.5 py-2"><div className="text-muted-foreground">数据完整的结果数</div><div className="mt-1 text-caption font-medium">{summary?.sample_count ?? 0}</div></div>
        <div className="rounded-md border bg-background/60 px-2.5 py-2"><div className="text-muted-foreground">数据完整度</div><div className="mt-1 text-caption font-medium">{summary?.data_completeness_pct == null ? "暂无已到观察日期的结果" : `${formatNumber(summary.data_completeness_pct, "%")}`}</div></div>
      </div>
      {!hasLocalObservations && <div className="mt-3 rounded-md border border-dashed px-3 py-2.5 text-micro text-muted-foreground" data-testid="selection-outcomes-empty">尚未形成历史结果。请点击“更新历史结果”，获取已经到达观察日期的实际表现。</div>}
      {candidate ? <div className="mt-3 grid gap-2" data-testid="selection-outcome-windows">{SELECTION_OUTCOME_WINDOWS.map((window) => <SelectionOutcomeWindow key={window} row={outcomeRowFor(outcomes, candidateId(candidate), window)} window={window} benchmarkName={benchmarkName} />)}</div> : <p className="mt-3 text-micro text-muted-foreground">当前未选中具体候选，仅显示本批次汇总；选择候选后可查看各观察窗口的标的收益、基准收益和相对收益。</p>}
    </> : error ? <div className="mt-3 rounded-md bg-warning/10 px-2.5 py-2 text-micro text-warning"><p>{error}</p><Button className="mt-2" variant="outline" size="sm" onClick={onReload}>重试读取</Button></div> : null}
  </section>;
}

export function OpportunityDiscovery({
  client,
  onAddWatchlist,
  onDeepResearch,
}: OpportunityDiscoveryProps) {
  const [tab, setTab] = useState<DiscoveryTab>("ai");
  const [templates, setTemplates] = useState<StockScreenTemplate[]>([]);
  const [strategies, setStrategies] = useState<StockScreenStrategy[]>([]);
  const [history, setHistory] = useState<StockScreenHistoryItem[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<StockScreenStrategy | null>(null);
  const [query, setQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [guideAnswers, setGuideAnswers] = useState<GuideAnswer[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [researchLimitInput, setResearchLimitInput] = useState("1");
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [report, setReport] = useState<StockScreenReport | null>(null);
  const [selectionOutcomes, setSelectionOutcomes] = useState<StockScreenOutcomesResponse | null>(null);
  const [selectionOutcomesLoading, setSelectionOutcomesLoading] = useState(false);
  const [selectionOutcomesRefreshing, setSelectionOutcomesRefreshing] = useState(false);
  const [selectionOutcomesError, setSelectionOutcomesError] = useState<string | null>(null);
  const selectionOutcomesRequestRef = useRef(0);
  const selectionOutcomesControllerRef = useRef<AbortController | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareResult, setCompareResult] = useState<StockScreenCompareResult | null>(null);
  const [bootState, setBootState] = useState<"loading" | "ready" | "error">("loading");
  const [starting, setStarting] = useState(false);
  const [resultLoading, setResultLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"manual" | "daily_after_close" | "weekly">("manual");
  const [error, setError] = useState<string | null>(null);

  const cards = templates.length > 0 ? templates : FALLBACK_CARDS;
  const beginnerCards = BEGINNER_CARD_IDS.flatMap((id) => {
    const card = cards.find((item) => item.strategy_id === id)
      ?? FALLBACK_CARDS.find((item) => item.strategy_id === id);
    return card ? [card] : [];
  });
  const researchLimit = parseResearchLimit(researchLimitInput);
  const selectedDirectionIds = selectedStrategy?.strategy_id === "combined_discovery"
    ? selectedStrategy.included_strategy_ids ?? []
    : selectedStrategy && (BEGINNER_CARD_IDS as readonly string[]).includes(selectedStrategy.strategy_id)
      ? [selectedStrategy.strategy_id]
      : [];
  const toggleBeginnerCard = (card: StockScreenTemplate) => {
    const nextIds = selectedDirectionIds.includes(card.strategy_id)
      ? selectedDirectionIds.filter((id) => id !== card.strategy_id)
      : [...selectedDirectionIds, card.strategy_id];
    if (nextIds.length === 0) setSelectedStrategy(null);
    else if (nextIds.length === 1) setSelectedStrategy(beginnerCards.find((item) => item.strategy_id === nextIds[0]) ?? card);
    else setSelectedStrategy({
      strategy_id: "combined_discovery",
      name: nextIds.map((id) => beginnerCards.find((item) => item.strategy_id === id)?.beginner_label ?? "自定义方向").join("、"),
      source: "agent",
      horizon: "medium_term",
      included_strategy_ids: nextIds,
      limit: 30,
      research_limit: researchLimit ?? 1,
    });
    if (researchLimit === null) setResearchLimitInput("1");
    setQuery("");
  };
  const activeRun = run && !TERMINAL_RUN_STATUSES.has(run.status) ? run : null;
  const progress = runProgress(run);
  const workflowSteps = run?.workflow?.steps ?? [];
  const candidates = report?.candidates ?? [];
  const comparisonCandidates = [...candidates, ...(compareResult?.candidates ?? [])];
  const selectedCandidate = candidates.find((candidate) => candidateId(candidate) === selectedCandidateId) ?? candidates[0] ?? null;
  const opportunityResearch = report?.opportunity_research ?? null;
  const opportunityCandidates = opportunityResearch?.candidates ?? [];
  const opportunityByInstrument = new Map(opportunityCandidates.map((candidate) => [candidate.instrument_id, candidate]));
  const selectedOpportunity = selectedCandidate ? opportunityByInstrument.get(candidateId(selectedCandidate)) ?? null : null;
  const isCatalystResult = isRecentCatalystStrategy(report?.strategy ?? selectedStrategy);
  const hasResultsView = Boolean(report || activeRun || starting || run);

  const updateSelectedStrategy = (update: Partial<StockScreenStrategy>) => {
    setSelectedStrategy((current) => current ? { ...current, ...update } : current);
  };

  const updateStrategyUniverse = (key: string, value: unknown) => {
    setSelectedStrategy((current) => current ? {
      ...current,
      universe: { ...(current.universe ?? {}), [key]: value },
    } : current);
  };

  const updateFilter = (index: number, update: Partial<NonNullable<StockScreenStrategy["filters"]>[number]>) => {
    setSelectedStrategy((current) => {
      if (!current) return current;
      const filters = [...(current.filters ?? [])];
      filters[index] = { ...filters[index], ...update };
      return { ...current, filters };
    });
  };

  const removeFilter = (index: number) => {
    setSelectedStrategy((current) => current ? { ...current, filters: (current.filters ?? []).filter((_, itemIndex) => itemIndex !== index) } : current);
  };

  const updateRanking = (index: number, update: Partial<NonNullable<StockScreenStrategy["ranking"]>[number]>) => {
    setSelectedStrategy((current) => {
      if (!current) return current;
      const ranking = [...(current.ranking ?? [])];
      ranking[index] = { ...ranking[index], ...update };
      return { ...current, ranking };
    });
  };

  const removeRanking = (index: number) => {
    setSelectedStrategy((current) => current ? { ...current, ranking: (current.ranking ?? []).filter((_, itemIndex) => itemIndex !== index) } : current);
  };

  const loadData = useCallback(async () => {
    setBootState("loading");
    setError(null);
    try {
      const [nextTemplates, nextStrategies, nextHistory] = await Promise.all([
        fetchStockScreenTemplates(),
        fetchStockScreenStrategies(),
        fetchStockScreenHistory(),
      ]);
      setTemplates(nextTemplates);
      setStrategies(nextStrategies);
      setHistory(nextHistory);
      setBootState("ready");
    } catch {
      // Strategy cards remain usable when the metadata endpoint is down; a run
      // still reports the authoritative service error instead of fake results.
      setBootState("ready");
      setError("选股配置暂时不可用，仍可查看基础入口；运行时会再次检查数据服务。");
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const loadResult = useCallback(async (runId: string, completedRun?: WorkflowRun) => {
    setResultLoading(true);
    try {
      const next = await fetchStockScreenResult(runId);
      setReport(next);
      setSelectedStrategy(next.strategy ?? null);
      setResearchLimitInput(String(Math.max(1, Math.min(8, next.strategy?.research_limit ?? next.opportunity_research?.candidate_count ?? 1))));
      setSelectedCandidateId(next.candidates?.[0] ? candidateId(next.candidates[0]) : null);
      setTab("ai");
      setError(null);
    } catch {
      setReport(null);
      const clarification = completedRun?.steps?.screening?.output?.summary?.trim()
        ?? completedRun?.steps?.selection?.output?.summary?.trim();
      if (clarification) {
        setTab("ai");
        setError(`选股分析师需要你补充条件：${humanizeResearchText(clarification)}`);
      } else {
        setError("选股结果尚未生成或暂时无法读取，请稍后重试。");
      }
    } finally {
      setResultLoading(false);
    }
  }, []);

  const selectionOutcomeRunId = report?.workflow_run_id ?? null;

  useEffect(() => {
    const requestId = ++selectionOutcomesRequestRef.current;
    selectionOutcomesControllerRef.current?.abort();
    if (!selectionOutcomeRunId) {
      setSelectionOutcomes(null);
      setSelectionOutcomesLoading(false);
      setSelectionOutcomesRefreshing(false);
      setSelectionOutcomesError(null);
      return;
    }
    const controller = new AbortController();
    selectionOutcomesControllerRef.current = controller;
    setSelectionOutcomes(null);
    setSelectionOutcomesLoading(true);
    setSelectionOutcomesRefreshing(false);
    setSelectionOutcomesError(null);
    void fetchStockScreenOutcomes(selectionOutcomeRunId, controller.signal)
      .then((next) => {
        if (requestId !== selectionOutcomesRequestRef.current) return;
        setSelectionOutcomes(next);
      })
      .catch((err) => {
        if (requestId !== selectionOutcomesRequestRef.current || (err instanceof Error && err.name === "AbortError")) return;
        setSelectionOutcomesError(`历史结果读取失败：${humanizeResearchText(err instanceof Error ? err.message : "请稍后重试")}`);
      })
      .finally(() => {
        if (requestId === selectionOutcomesRequestRef.current) setSelectionOutcomesLoading(false);
    });
    return () => {
      selectionOutcomesControllerRef.current?.abort();
      selectionOutcomesRequestRef.current += 1;
    };
  }, [selectionOutcomeRunId]);

  const reloadSelectionOutcomes = useCallback(() => {
    const runId = selectionOutcomeRunId;
    if (!runId) return;
    const requestId = ++selectionOutcomesRequestRef.current;
    selectionOutcomesControllerRef.current?.abort();
    const controller = new AbortController();
    selectionOutcomesControllerRef.current = controller;
    setSelectionOutcomesLoading(true);
    setSelectionOutcomesError(null);
    void fetchStockScreenOutcomes(runId, controller.signal)
      .then((next) => {
        if (requestId === selectionOutcomesRequestRef.current) setSelectionOutcomes(next);
      })
      .catch((err) => {
        if (requestId !== selectionOutcomesRequestRef.current || (err instanceof Error && err.name === "AbortError")) return;
        setSelectionOutcomesError(`历史结果读取失败：${humanizeResearchText(err instanceof Error ? err.message : "请稍后重试")}`);
      })
      .finally(() => {
        if (requestId === selectionOutcomesRequestRef.current) setSelectionOutcomesLoading(false);
      });
  }, [selectionOutcomeRunId]);

  const refreshSelectionOutcomes = useCallback(() => {
    const runId = selectionOutcomeRunId;
    if (!runId) return;
    const requestId = ++selectionOutcomesRequestRef.current;
    selectionOutcomesControllerRef.current?.abort();
    const controller = new AbortController();
    selectionOutcomesControllerRef.current = controller;
    setSelectionOutcomesRefreshing(true);
    setSelectionOutcomesError(null);
    void refreshStockScreenOutcomes(runId, controller.signal)
      .then((next) => {
        if (requestId === selectionOutcomesRequestRef.current) setSelectionOutcomes(next);
      })
      .catch((err) => {
        if (requestId !== selectionOutcomesRequestRef.current || (err instanceof Error && err.name === "AbortError")) return;
        setSelectionOutcomesError(`历史结果更新失败：${humanizeResearchText(err instanceof Error ? err.message : "请稍后重试")}`);
      })
      .finally(() => {
        if (requestId === selectionOutcomesRequestRef.current) setSelectionOutcomesRefreshing(false);
      });
  }, [selectionOutcomeRunId]);

  useEffect(() => {
    client.attach(STOCK_ROOM_CHAT_ID);
    const unsubscribe = client.onWorkflowRunUpdated((chatId, next, eventError, detail) => {
      if (chatId !== STOCK_ROOM_CHAT_ID) return;
      if (eventError) {
        setStarting(false);
        setError(`选股运行失败：${humanizeResearchText(detail || eventError)}`);
        return;
      }
      if (!next || !isSelectionRun(next)) return;
      setStarting(false);
      setRun(next);
      if (next.status === "succeeded" || next.status === "failed") void loadResult(next.id, next);
    });
    void client.getWorkflowRun(STOCK_ROOM_CHAT_ID).then((existing) => {
      if (existing && isSelectionRun(existing)) {
        setRun(existing);
        if (existing.status === "succeeded" || existing.status === "failed") void loadResult(existing.id, existing);
      }
    }).catch(() => undefined);
    return unsubscribe;
  }, [client, loadResult]);

  const startSelection = useCallback(async () => {
    if (activeRun || starting) return;
    if (!isRunnableStrategy(selectedStrategy)) {
      setError(humanizeResearchText((selectedStrategy as StockScreenTemplate | null)?.unavailable_reason ?? "当前策略所需数据源尚未接入，暂不能运行。"));
      return;
    }
    if (!selectedStrategy && !query.trim()) {
      setError("请先选择一个方向，或输入你想找的股票特征。");
      return;
    }
    if (researchLimit === null) {
      setError("人工智能研究数量请输入 1–8 的整数。");
      return;
    }
    const effectiveResearchLimit = researchLimit;
    const strategy = selectedStrategy ? {
      ...selectedStrategy,
      research_limit: effectiveResearchLimit,
    } : {
      strategy_id: "natural_language",
      name: "自然语言选股",
      source: "agent" as const,
      description: query.trim(),
      research_limit: effectiveResearchLimit,
    };
    setStarting(true);
    setError(null);
    setReport(null);
    setRun(null);
    const inputs: Record<string, unknown> = {
      mode: "stock_selection",
      selection: true,
      strategy_id: strategy.strategy_id,
      strategy,
      research_limit: effectiveResearchLimit,
      ...(query.trim() ? { query: query.trim(), user_question: query.trim() } : {}),
    };
    try {
      await client.runWorkflow(STOCK_ROOM_CHAT_ID, inputs, STOCK_SELECTION_TEMPLATE_REF);
      const next = await client.getWorkflowRun(STOCK_ROOM_CHAT_ID);
      if (next && isSelectionRun(next)) setRun(next);
      setTab("ai");
    } catch (err) {
      setStarting(false);
      setError(`选股启动失败：${humanizeResearchText(err instanceof Error ? err.message : "请稍后重试")}`);
    }
  }, [activeRun, client, query, researchLimit, selectedStrategy, starting]);

  const answerGuide = (answer: GuideAnswer) => {
    const nextAnswers = [...guideAnswers, answer];
    setGuideAnswers(nextAnswers);
    if (guideStep < GUIDE_QUESTIONS.length - 1) {
      setGuideStep((value) => value + 1);
      return;
    }
    const first = nextAnswers[0];
    const id = first === "stable" ? "stable_business" : first === "growth" ? "quality_growth" : first === "trend" ? "trend_confirmation" : "recent_catalyst";
    const strategy = cards.find((item) => item.strategy_id === id) ?? FALLBACK_CARDS.find((item) => item.strategy_id === id) ?? null;
    const horizonAnswer = nextAnswers[1];
    const horizon = horizonAnswer === "short" ? "short_term" : horizonAnswer === "medium" ? "medium_term" : "long_term";
    setSelectedStrategy(strategy ? {
      ...strategy,
      horizon,
      research_limit: 1,
    } : null);
    setResearchLimitInput("1");
    setGuideOpen(false);
    setGuideStep(0);
    setGuideAnswers([]);
  };

  const toggleCompare = (id: string) => {
    setCompareIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length < 5 ? [...current, id] : current);
  };

  const runCompare = async () => {
    if (compareIds.length < 2) return;
    const runId = report?.workflow_run_id ?? run?.id;
    if (!runId) {
      setError("当前结果缺少运行标识，暂时无法比较。");
      return;
    }
    try {
      setCompareResult(await compareStockScreenCandidates(compareIds, runId));
      setError(null);
    } catch {
      setError("候选比较暂时不可用，请稍后重试。");
    }
  };

  const saveStrategy = async () => {
    if (!selectedStrategy) return;
    setSaving(true);
    try {
      const requestedSchedule = {
        mode: scheduleMode,
        enabled: scheduleMode !== "manual",
        time: "15:30",
        ...(scheduleMode === "weekly" ? { weekday: 4 } : {}),
        timezone: "Asia/Shanghai",
      } as const;
      const saved = await saveStockScreenStrategy({
        ...selectedStrategy,
        source: "user",
        schedule: requestedSchedule,
      });
      setStrategies((current) => [saved, ...current.filter((item) => item.strategy_id !== saved.strategy_id)]);

      // HTTP persistence and cron registration are separate concerns.  Always
      // synchronize explicitly so switching back to manual removes a prior
      // job, and never present a disabled/unavailable schedule as active.
      try {
        const sync = await client.syncStockScreenSchedule(STOCK_ROOM_CHAT_ID, saved.strategy_id, requestedSchedule);
        if (scheduleMode !== "manual" && sync.status !== "registered") {
          setError(`策略已保存，但自动运行未启用：${humanizeResearchText(sync.detail ?? "调度服务暂不可用")}`);
        } else if (scheduleMode === "manual" && sync.status !== "disabled") {
          setError("策略已保存，但旧的自动运行未能确认移除，请稍后重试。");
        } else {
          setError(null);
        }
      } catch (syncError) {
        setError(`策略已保存，但自动运行同步失败：${humanizeResearchText(syncError instanceof Error ? syncError.message : "调度服务暂不可用")}`);
      }
    } catch (err) {
      setError(humanizeResearchText(err instanceof Error ? err.message : "策略保存失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  const removeStrategy = async (strategyId: string) => {
    const existing = strategies.find((strategy) => strategy.strategy_id === strategyId);
    if (!existing) return;
    const disabledSchedule = { mode: "manual", enabled: false, time: "15:30" } as const;
    try {
      // Remove the durable cron binding before deleting the strategy.  The
      // copy is persisted first so the scheduler has the same strategy id and
      // can remove an already-registered job even after a restart.
      const saved = await saveStockScreenStrategy({
        ...existing,
        source: "user",
        schedule: disabledSchedule,
      });
      const sync = await client.syncStockScreenSchedule(STOCK_ROOM_CHAT_ID, saved.strategy_id, disabledSchedule);
      if (sync.status !== "disabled") {
        setError("策略未删除：旧的自动运行未能确认移除，请稍后重试。");
        return;
      }
      await deleteStockScreenStrategy(strategyId);
      setStrategies((current) => current.filter((item) => item.strategy_id !== strategyId));
      if (selectedStrategy?.strategy_id === strategyId) setSelectedStrategy(null);
      setError(null);
    } catch (err) {
      setError(`策略删除未完成：${humanizeResearchText(err instanceof Error ? err.message : "请稍后重试")}`);
    }
  };

  const cancelSelection = async () => {
    if (!run?.id) return;
    try {
      await client.cancelWorkflowRun(STOCK_ROOM_CHAT_ID, run.id);
      setError(null);
    } catch (err) {
      setError(`取消选股失败：${err instanceof Error ? err.message : "请稍后重试"}`);
    }
  };

  const addCandidate = async (candidate: StockScreenCandidate) => {
    try {
      await onAddWatchlist({
        symbol: candidateSymbol(candidate),
        exchange: candidateExchange(candidate),
        name: candidate.name,
        instrumentType: "equity",
      });
      setError(null);
    } catch {
      setError("加入自选失败，请稍后重试。");
    }
  };

  if (bootState === "loading") {
    return <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载机会发现…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
        <div>
          <h2 className="text-title-sm font-semibold">机会发现</h2>
          <p className="mt-0.5 text-caption text-muted-foreground">把筛选条件、数据时点和风险一起交代清楚</p>
        </div>
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="tablist" aria-label="机会发现视图">
          {([
            ["ai", "智能发现"],
            ["professional", "专业筛选"],
            ["history", "历史"],
          ] as Array<[DiscoveryTab, string]>).map(([key, label]) => (
            <Button key={key} type="button" variant="ghost" size="sm" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); if (key === "professional") setAdvancedOpen(true); }} className={cn("h-7 px-2.5 text-caption", tab === key && "bg-background text-foreground shadow-surface")}>{label}</Button>
          ))}
        </div>
      </div>

      {(error || bootState === "error") && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-muted-foreground" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{error ?? "选股配置加载失败"}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="关闭提示" onClick={() => setError(null)}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}

      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {((tab === "ai" && !hasResultsView) || tab === "professional") && (
          <div className="mx-auto max-w-4xl space-y-8">
            {tab === "ai" && <>
            <section aria-labelledby="stock-discovery-heading" className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info"><Sparkles className="h-5 w-5" /></div>
                  <div className="min-w-0">
                    <h3 id="stock-discovery-heading" className="text-title-sm">说说你想找什么机会</h3>
                    <p className="mt-1 text-body text-muted-foreground">可以直接描述想法，也可以从下面选择一个或多个方向。</p>
                  </div>
                </div>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setGuideOpen(true); setGuideStep(0); setGuideAnswers([]); }}>
                  不知道怎么选？让分析师引导<ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="flex items-center gap-2 rounded-xl bg-muted/60 p-2 focus-within:bg-muted">
                <Search className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <Input id="stock-selection-query" aria-label="描述选股目标" value={query} onChange={(event) => { setQuery(event.target.value); setSelectedStrategy(null); }} placeholder="例如：找经营稳健、估值不过高、走势没有明显转弱的股票" className="h-10 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0" />
                <Button type="button" size="sm" disabled={!query.trim()} onClick={() => { setSelectedStrategy({ strategy_id: "natural_language", name: "自然语言选股", source: "agent", description: query.trim(), horizon: "medium_term", research_limit: 1 }); setResearchLimitInput("1"); setTab("ai"); }}>确认目标</Button>
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-caption font-semibold">或者选择关注方向 <span className="font-normal text-muted-foreground">· 可多选</span></p>
                  {selectedDirectionIds.length > 0 && <span className="text-caption text-info">已选 {selectedDirectionIds.length} 项</span>}
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {beginnerCards.map((card) => (
                  <button key={card.strategy_id} type="button" disabled={!isRunnableStrategy(card)} aria-pressed={selectedDirectionIds.includes(card.strategy_id)} onClick={() => toggleBeginnerCard(card)} className={cn("group flex min-h-20 items-start gap-3 rounded-lg bg-muted/35 p-3.5 text-left transition-colors duration-instant hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-65", selectedDirectionIds.includes(card.strategy_id) && "bg-info/10 hover:bg-info/10") }>
                    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground transition-colors", selectedDirectionIds.includes(card.strategy_id) && "bg-info text-white")}>{directionIcon(card.strategy_id)}</span>
                    <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="text-ui font-medium">{card.beginner_label ?? card.name}</span>{!isRunnableStrategy(card) ? <span className="text-caption text-warning">数据源未接入</span> : selectedDirectionIds.includes(card.strategy_id) && <Check className="h-4 w-4 text-info" />}</span><span className="mt-1 block text-caption leading-5 text-muted-foreground">{isRunnableStrategy(card) ? strategyCardDescription(card) : humanizeResearchText(card.unavailable_reason ?? "当前所需数据暂不可用")}</span></span>
                  </button>
                ))}
                </div>
              </div>
              <p className="text-caption text-muted-foreground">人工智能（AI）负责理解目标和研究候选；实际筛选、排序与风险检查仍由确定性服务完成。</p>
            </section>
            </>}

            {tab === "professional" && <section className="space-y-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-info/10 text-info"><Search className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1"><h3 className="text-title-sm">专业筛选</h3><p className="mt-1 text-body text-muted-foreground">选择一个研究方向，再编辑股票池、硬筛选、排序和研究数量。</p></div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {cards.filter((card) => isRunnableStrategy(card)).map((card) => <button key={card.strategy_id} type="button" onClick={() => { setSelectedStrategy(card); setQuery(""); setResearchLimitInput(String(card.research_limit ?? 1)); }} className={cn("rounded-lg bg-muted/35 p-3.5 text-left transition-colors duration-instant hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", selectedStrategy?.strategy_id === card.strategy_id && "bg-info/10 hover:bg-info/10")}><div className="flex items-center justify-between gap-2"><span className="text-ui font-medium">{card.name}</span>{selectedStrategy?.strategy_id === card.strategy_id && <Check className="h-4 w-4 text-info" />}</div><p className="mt-1.5 text-caption leading-5 text-muted-foreground">{strategyCardDescription(card)}</p></button>)}
              </div>
              {strategies.filter((strategy) => strategy.source === "user").length > 0 && <div className="mt-3 border-t pt-3"><div className="text-caption font-medium">我的策略</div><div className="mt-2 flex flex-wrap gap-2">{strategies.filter((strategy) => strategy.source === "user").map((strategy) => <Button key={strategy.strategy_id} type="button" variant={selectedStrategy?.strategy_id === strategy.strategy_id ? "default" : "outline"} size="sm" onClick={() => { setSelectedStrategy(strategy); setResearchLimitInput(String(strategy.research_limit ?? 1)); }}>{strategy.name}</Button>)}</div></div>}
            </section>}

             {selectedStrategy && (
              <section className="rounded-xl bg-info/5 px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><div className="text-ui font-semibold">本次寻找：{selectedStrategy.name}</div><p className="mt-1 text-caption text-muted-foreground">{strategyDescription(selectedStrategy)}</p></div>
                  <Button type="button" size="sm" disabled={Boolean(activeRun) || starting || researchLimit === null} onClick={() => void startSelection()}><Play className="mr-1.5 h-3.5 w-3.5" />{starting ? "正在启动…" : "确认并开始"}</Button>
                </div>
                 <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-caption text-muted-foreground"><span>观察周期：{horizonLabel(selectedStrategy.horizon)}</span><label className={cn("flex items-center gap-1.5", researchLimit === null && "text-destructive")}>人工智能研究前<Input aria-label="人工智能研究排名前几只" type="number" inputMode="numeric" min="1" max="8" step="1" value={researchLimitInput} onChange={(event) => setResearchLimitInput(event.target.value)} className={cn("h-7 w-12 bg-background px-1 text-center text-caption text-foreground", researchLimit === null && "border-destructive")} />只</label><span>证据：行情、技术、财务与资讯</span><span>不构成买卖建议</span></div>
                  <p className={cn("mt-2 text-caption", researchLimit === null ? "text-destructive" : "text-muted-foreground")}>{researchLimit === null ? "请输入 1至8的整数。" : `先由确定性服务筛选，再由人工智能研究前 ${researchLimit} 只候选；缺失数据不会被补写。`}</p>
                  {isRecentCatalystStrategy(selectedStrategy) && <div className="mt-3 rounded-lg bg-background/75 px-3 py-2 text-caption">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-medium text-foreground">事件窗口：近 7 日</span>
                      <span className="text-muted-foreground">公告覆盖：{catalystCoverageLabel(report, { beforeRun: true })}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground">仅使用可追溯、可映射到 A 股证券的公告事件；运行后会显示实际覆盖状态。</p>
                  </div>}
                {selectedStrategy.strategy_id !== "combined_discovery" && <button type="button" className="mt-3 flex items-center gap-1 text-caption text-info hover:underline" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}高级条件</button>}
                {selectedStrategy.strategy_id !== "combined_discovery" && advancedOpen && <div className="mt-2 space-y-3 rounded-lg bg-background/75 p-3 text-caption">
                  <div>
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">筛选条件</span><Button type="button" variant="outline" size="sm" className="h-7 px-2 text-micro" onClick={() => updateSelectedStrategy({ filters: [...(selectedStrategy.filters ?? []), { field: "change_pct", op: ">=", value: 0, label: "涨跌幅" }] })}>添加条件</Button></div>
                    {(selectedStrategy.filters ?? []).length === 0 ? <p className="mt-1 text-micro text-muted-foreground">未设置硬筛选，服务将按策略默认条件运行。</p> : <div className="mt-2 space-y-2">{(selectedStrategy.filters ?? []).map((filter, index) => <div key={`${filter.field}-${index}`} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_110px_92px_auto]"><select aria-label={`筛选指标 ${index + 1}`} value={filter.field} onChange={(event) => updateFilter(index, { field: event.target.value, label: FILTER_FIELDS.find(([field]) => field === event.target.value)?.[1] })} className="h-8 rounded-md border bg-background px-2 text-micro">{FILTER_FIELDS.map(([field, label]) => <option key={field} value={field}>{label}</option>)}</select><select aria-label={`筛选比较方式 ${index + 1}`} value={filter.op} onChange={(event) => updateFilter(index, { op: event.target.value })} className="h-8 rounded-md border bg-background px-2 text-micro">{FILTER_OPERATORS.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}</select><Input aria-label={`筛选比较值 ${index + 1}`} value={String(filter.value ?? "")} onChange={(event) => updateFilter(index, { value: parseConditionValue(event.target.value) })} className="h-8 text-micro" /><Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`删除筛选条件 ${index + 1}`} onClick={() => removeFilter(index)}><X className="h-3.5 w-3.5" /></Button></div>)}</div>}
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2"><span className="font-medium">排序依据</span><Button type="button" variant="outline" size="sm" className="h-7 px-2 text-micro" onClick={() => updateSelectedStrategy({ ranking: [...(selectedStrategy.ranking ?? []), { field: "momentum20", direction: "desc", weight: 1, label: "20日价格动量" }] })}>添加排序依据</Button></div>
                    {(selectedStrategy.ranking ?? []).length === 0 ? <p className="mt-1 text-micro text-muted-foreground">未设置排序，服务将使用策略默认权重。</p> : <div className="mt-2 space-y-2">{(selectedStrategy.ranking ?? []).map((factor, index) => <div key={`${factor.field}-${index}`} className="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_76px_76px_auto]"><select aria-label={`排序指标 ${index + 1}`} value={factor.field} onChange={(event) => updateRanking(index, { field: event.target.value, label: FILTER_FIELDS.find(([field]) => field === event.target.value)?.[1] })} className="h-8 rounded-md border bg-background px-2 text-micro">{RANK_FIELDS.map(([field, label]) => <option key={field} value={field}>{label}</option>)}</select><select aria-label={`排序方向 ${index + 1}`} value={factor.direction} onChange={(event) => updateRanking(index, { direction: event.target.value as "asc" | "desc" })} className="h-8 rounded-md border bg-background px-2 text-micro"><option value="desc">从高到低</option><option value="asc">从低到高</option></select><Input aria-label={`排序权重 ${index + 1}`} type="number" min="0" step="0.1" value={String(factor.weight ?? 1)} onChange={(event) => updateRanking(index, { weight: Number(event.target.value) || 0 })} className="h-8 text-micro" /><Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label={`删除排序依据 ${index + 1}`} onClick={() => removeRanking(index)}><X className="h-3.5 w-3.5" /></Button></div>)}</div>}
                  </div>
                  <div className="grid gap-2 border-t pt-3 sm:grid-cols-2">
                    <label className="flex items-center gap-2 text-micro"><input type="checkbox" checked={selectedStrategy.universe?.exclude_st !== false} onChange={(event) => updateStrategyUniverse("exclude_st", event.target.checked)} className="accent-[hsl(var(--info))]" />排除 ST</label>
                    <label className="flex items-center gap-2 text-micro"><input type="checkbox" checked={selectedStrategy.universe?.exclude_suspended !== false} onChange={(event) => updateStrategyUniverse("exclude_suspended", event.target.checked)} className="accent-[hsl(var(--info))]" />排除停牌</label>
                    <label className="flex items-center justify-between gap-2 text-micro"><span>最少上市天数</span><Input aria-label="最少上市天数" type="number" min="0" value={String(selectedStrategy.universe?.min_listing_days ?? 120)} onChange={(event) => updateStrategyUniverse("min_listing_days", Number(event.target.value) || 0)} className="h-8 w-24 text-micro" /></label>
                    <label className="flex items-center justify-between gap-2 text-micro"><span>最低成交额（元）</span><Input aria-label="最低成交额" type="number" min="0" value={String(selectedStrategy.universe?.min_daily_amount ?? "")} onChange={(event) => updateStrategyUniverse("min_daily_amount", event.target.value === "" ? null : Number(event.target.value) || 0)} className="h-8 w-24 text-micro" /></label>
                    <label className="flex items-center justify-between gap-2 text-micro"><span>最多结果</span><Input aria-label="最多结果数量" type="number" min="1" max="100" value={String(selectedStrategy.limit ?? 30)} onChange={(event) => updateSelectedStrategy({ limit: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} className="h-8 w-24 text-micro" /></label>
                  </div>
                  <p className="text-micro text-muted-foreground">条件只使用服务允许的字段；运行前会在确认卡显示，结果会返回实际命中和未命中的依据。</p>
                </div>}
             </section>
            )}

            {strategies.some((strategy) => strategy.source === "user") && (
              <section className="border-t border-border/60 pt-5">
                <div className="flex items-center justify-between gap-2"><h3 className="text-ui font-medium">我的策略</h3><span className="text-micro text-muted-foreground">可在历史结果中继续运行</span></div>
                <div className="mt-2 space-y-1">
                  {strategies.filter((strategy) => strategy.source === "user").map((strategy) => (
                    <div key={strategy.strategy_id} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-muted/60">
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-caption hover:text-info" onClick={() => { setSelectedStrategy(strategy); setQuery(""); }}>{strategy.name}</button>
                      <span className="shrink-0 text-micro text-muted-foreground">{strategy.schedule?.enabled ? "自动运行" : "手动"}</span>
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-micro text-muted-foreground hover:text-destructive" onClick={() => void removeStrategy(strategy.strategy_id)}>删除</Button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === "ai" && hasResultsView && (
          <div className="grid min-h-full w-full min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)_minmax(320px,380px)]">
            <aside className="self-start rounded-xl bg-muted/30 p-4">
              <div className="flex items-center justify-between"><h3 className="text-ui font-medium">本次策略</h3><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="返回选择策略" onClick={() => { setReport(null); setRun(null); setTab("ai"); }}><ChevronRight className="h-4 w-4 rotate-180" /></Button></div>
              {selectedStrategy ? <><div className="mt-4 text-caption font-medium">{selectedStrategy.name}</div><p className="mt-1.5 text-caption leading-5 text-muted-foreground">{strategyDescription(selectedStrategy)}</p><dl className="mt-5 space-y-2 text-micro"><div className="flex justify-between gap-2"><dt className="text-muted-foreground">数据时点</dt><dd className="text-right">{formatAsOf(report?.as_of)}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">股票池</dt><dd>{report?.universe_count ?? "—"}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">通过筛选</dt><dd>{report?.filtered_count ?? (candidates.length || "—")}</dd></div><div className="flex justify-between gap-2"><dt className="text-muted-foreground">数据质量</dt><dd>{dataQualityLabel(report?.data_quality)}</dd></div></dl><Button variant="ghost" size="sm" className="mt-5 w-full bg-background/70 hover:bg-background" disabled={saving || !hasExecutableStrategy(selectedStrategy)} onClick={() => void saveStrategy()}><Save className="mr-1.5 h-3.5 w-3.5" />{saving ? "保存中…" : hasExecutableStrategy(selectedStrategy) ? "保存策略" : "条件尚未形成，不能保存"}</Button><select aria-label="自动运行频率" value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as typeof scheduleMode)} className="mt-2 h-8 w-full rounded-md border bg-background px-2 text-caption"><option value="manual">手动运行</option><option value="daily_after_close">盘后每日运行</option><option value="weekly">每周运行</option></select></> : <p className="mt-3 text-caption text-muted-foreground">完成一次选股后，这里会显示条件、数据时点和历史验证。</p>}
            </aside>

            <section className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-3"><div><h3 className="text-ui font-medium">候选结果</h3><p className="mt-0.5 text-micro text-muted-foreground">{activeRun ? `已完成 ${progress.completed}/${progress.total} 个真实步骤` : report ? `${candidates.length} 只候选 · 按策略排序` : "启动选股后，结果会出现在这里"}</p></div><div className="flex items-center gap-1"><Button variant="secondary" size="sm" disabled={compareIds.length < 2} onClick={() => void runCompare()}>比较 {compareIds.length > 0 ? `(${compareIds.length})` : ""}</Button><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新选股结果" disabled={resultLoading || !(run?.id || report?.workflow_run_id)} onClick={() => { const runId = run?.id ?? report?.workflow_run_id; if (runId) void loadResult(runId); }}><RefreshCw className={cn("h-3.5 w-3.5", resultLoading && "animate-spin")} /></Button></div></div>
              {activeRun && <div className="rounded-xl bg-info/5 px-4 py-3"><div className="flex items-center justify-between gap-2 text-caption"><span className="font-medium">选股分析师正在工作</span><div className="flex items-center gap-2"><span className="tabular-nums text-muted-foreground">{progress.total ? `${progress.completed}/${progress.total}` : "等待步骤"}</span><Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-micro" onClick={() => void cancelSelection()}>取消选股</Button></div></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full bg-info transition-[width] duration-300", !progress.total && "w-1/3 animate-pulse")} style={progress.total ? { width: `${Math.round((progress.completed / progress.total) * 100)}%` } : undefined} /></div>{!progress.total && <p className="mt-1 text-micro text-muted-foreground">正在等待服务返回真实工作流步骤…</p>}<div className="mt-3 grid gap-1.5 sm:grid-cols-2">{workflowSteps.map((step) => { const state = activeRun.steps[step.id]?.status ?? "queued"; return <div key={step.id} className="flex items-center gap-2 text-caption"><span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-micro", state === "succeeded" || state === "skipped" ? "bg-success/10 text-success" : state === "running" ? "bg-info/10 text-info" : state === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{state === "succeeded" || state === "skipped" ? <Check className="h-3 w-3" /> : state === "failed" ? <X className="h-3.5 w-3.5" /> : state === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>{workflowSteps.indexOf(step) + 1}</span>}</span><span className={cn("truncate", state === "running" && "font-medium text-info")}>{stepLabel(step)}</span><span className="ml-auto text-micro text-muted-foreground">{state === "waiting_approval" ? "等待确认" : state === "running" ? "进行中" : state === "succeeded" ? "完成" : state === "failed" ? "失败" : "待处理"}</span></div>; })}</div></div>}
               {!activeRun && report && <div className={cn("mb-2 rounded-lg px-3 py-2 text-caption", opportunityResearch?.status === "completed" ? "bg-success/5 text-success" : "bg-warning/5 text-warning")}>
                 {isRecentCatalystStrategy(report.strategy) && <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground"><span>事件窗口：近 7 日</span><span>公告覆盖：{catalystCoverageLabel(report)}</span></div>}
                 {opportunityResearch ? `人工智能候选研究：${opportunityStatusLabel(opportunityResearch.status)} · ${opportunityResearch.candidate_count ?? opportunityCandidates.length} 只` : "当前为仅完成确定性初筛的历史结果：人工智能候选研究尚未生成，以下内容不代表机会结论。"}
               </div>}
              {resultLoading && <div className="flex items-center justify-center gap-2 py-10 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在读取可追溯结果…</div>}
               {!resultLoading && !activeRun && !report && <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center text-caption text-muted-foreground"><Database className="h-8 w-8 text-muted-foreground/60" /><p>{run?.status === "failed" ? "本次选股运行失败" : run?.status === "cancelled" ? "本次选股已取消" : "还没有本次选股结果"}</p><div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => setTab("ai")}>返回策略入口</Button>{run?.status === "failed" && <Button size="sm" onClick={() => void startSelection()}>重试</Button>}</div></div>}
               {!resultLoading && !activeRun && report && candidates.length === 0 && <div className="space-y-3 px-4 py-8 text-center text-caption text-muted-foreground">
                 {isRecentCatalystStrategy(report.strategy) && catalystDataState(report) === "unavailable" ? <><Database className="mx-auto h-8 w-8 text-warning" /><p className="font-medium text-warning">近期催化事件源暂不可用</p><p>{catalystCoverageLabel(report)}</p><p>请稍后重试；没有有效事件数据时不会生成伪候选。</p></> : isRecentCatalystStrategy(report.strategy) && catalystDataState(report) === "partial" ? <><Database className="mx-auto h-8 w-8 text-warning" /><p className="font-medium text-warning">事件覆盖不完整，暂未生成可靠候选</p><p>{catalystCoverageLabel(report)}</p><p>请等待数据源恢复或稍后重试，系统不会把部分公告当作全市场完整结果。</p></> : isRecentCatalystStrategy(report.strategy) && catalystDataState(report) === "stale" ? <><Clock3 className="mx-auto h-8 w-8 text-warning" /><p className="font-medium text-warning">当前使用过期事件缓存</p><p>{catalystCoverageLabel(report)}</p><p>为避免误导，本次没有基于过期数据生成候选。</p></> : isRecentCatalystStrategy(report.strategy) ? <><Search className="mx-auto h-8 w-8 text-muted-foreground/60" /><p className="font-medium text-foreground">近 7 日没有命中材料事件</p><p>当前窗口内没有同时满足事件材料性与股票池条件的可核验公告。</p><p>可以返回策略入口，改用其他方向；系统不会把涨幅或热点直接当成催化。</p></> : <><p>当前没有满足全部条件的候选。</p>{report.filter_statistics?.length ? <div className="mx-auto max-w-md rounded-md border bg-muted/20 p-3 text-left">{report.filter_statistics.map((stat, index) => <div key={`${stat.field ?? stat.label ?? "filter"}-${index}`} className="flex justify-between gap-3 py-1"><span>{filterStatisticLabel(stat)}</span><span className="tabular-nums">{stat.removed ?? "—"} 只未通过</span></div>)}</div> : null}<p>可以返回策略入口，明确选择要放宽的条件；系统不会把缺失数据填零冒充有效结果。</p></>}
               </div>}
                {!resultLoading && report && candidates.length > 0 && <div className="space-y-1">{candidates.map((candidate) => { const id = candidateId(candidate); const opportunity = opportunityByInstrument.get(id); const checked = compareIds.includes(id); const price = candidateMetric(candidate, "price"); const changePct = candidateMetric(candidate, "change_pct"); const quantLabel = candidate.quant_validation ? (quantValidationLabel(candidate.quant_validation.validation_status) ?? "量化状态待验证") : null; const lowPriorityGap = opportunity?.research_priority === "low" ? Array.from(new Set(claimList(opportunity.data_gaps).map(claimText).filter((text) => text !== "待确认")))[0] ?? "关键条件待确认" : null; return <div key={id} className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/60", selectedCandidateId === id && "bg-info/10 hover:bg-info/10")} onClick={() => setSelectedCandidateId(id)}><input type="checkbox" aria-label={`加入比较 ${candidate.name}`} checked={checked} onChange={() => toggleCompare(id)} onClick={(event) => event.stopPropagation()} className="mt-1 h-3.5 w-3.5 accent-[hsl(var(--info))]" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-ui font-medium">{candidate.name}</span><span className="text-micro text-muted-foreground">{candidateSymbol(candidate)}</span>{opportunity && <span className="rounded-full bg-info/10 px-1.5 py-0.5 text-micro text-info">{priorityLabel(opportunity.research_priority)}</span>}{candidate.change_state && <span className="rounded-full bg-info/10 px-1.5 py-0.5 text-micro text-info">{changeStateLabel(candidate.change_state)}</span>}{quantLabel && <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-micro text-warning">{quantLabel}</span>}</div><p className="mt-1 truncate text-caption text-muted-foreground">{opportunity ? claimText(opportunity.why_now) : humanizeResearchText(candidate.selection_reasons?.[0] ?? "人工智能研究尚未完成，当前仅显示确定性入选原因")}</p>{lowPriorityGap && <p className="mt-1 truncate text-micro text-warning">暂不形成买卖建议：{lowPriorityGap}</p>}{isCatalystResult && <div className="mt-2"><CatalystEventFacts candidate={candidate} limit={2} /></div>}<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-micro text-muted-foreground"><span>{formatNumber(price)} {changePct == null ? "" : `${changePct >= 0 ? "+" : ""}${formatNumber(changePct, "%")}`}</span><span>{candidate.industry ? humanizeResearchText(candidate.industry) : "行业信息待确认"}</span><span>{dataQualityLabel(candidate.data_quality)}</span><span>{formatAsOf(candidate.as_of)}</span></div></div><span className="shrink-0 text-caption tabular-nums text-muted-foreground">第 {candidate.rank ?? "—"} 名</span></div>; })}</div>}
            </section>

            <aside className="min-w-0 space-y-6">
              {selectedCandidate ? <section className="min-w-0 rounded-xl bg-muted/25 p-4"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-ui font-medium">{selectedCandidate.name}</h3><p className="text-micro text-muted-foreground">{exchangeLabel(candidateExchange(selectedCandidate))} · 股票代码 {candidateSymbol(selectedCandidate)} · {selectedCandidate.industry ? humanizeResearchText(selectedCandidate.industry) : "行业信息待确认"}</p></div><span className="rounded-full bg-background/80 px-2 py-1 text-micro">{dataQualityLabel(selectedCandidate.data_quality)}</span></div><div className="mt-4 flex gap-10 text-caption"><div><div className="text-micro text-muted-foreground">当前价格</div><div className="mt-0.5 tabular-nums">{formatNumber(candidateMetric(selectedCandidate, "price"))}</div></div><div><div className="text-micro text-muted-foreground">涨跌幅</div><div className={cn("mt-0.5 tabular-nums", (candidateMetric(selectedCandidate, "change_pct") ?? 0) >= 0 ? "text-stock-up" : "text-stock-down")}>{formatNumber(candidateMetric(selectedCandidate, "change_pct"), "%")}</div></div></div><QuantObservationPanel candidate={selectedCandidate} snapshot={report?.quant_snapshot} />{selectedCandidate.valuation_context && <ValuationReference context={selectedCandidate.valuation_context} fallbackAsOf={selectedCandidate.as_of} />}{isCatalystResult && <div className="mt-5"><div className="text-caption font-medium">触发事件</div><div className="mt-2"><CatalystEventFacts candidate={selectedCandidate} /></div></div>}<div className="mt-5"><div className="text-caption font-medium">为什么入选</div><ul className="mt-1.5 list-disc space-y-1 pl-4 text-caption text-muted-foreground">{(selectedCandidate.selection_reasons?.length ? selectedCandidate.selection_reasons : ["暂无可展示的解释"]).slice(0, 3).map((reason) => <li key={reason}>{humanizeResearchText(reason)}</li>)}</ul></div><div className="mt-5"><div className="flex items-center gap-1 text-caption font-medium"><AlertTriangle className="h-3.5 w-3.5 text-warning" />主要风险</div><ul className="mt-1.5 list-disc space-y-1 pl-4 text-caption text-muted-foreground">{(selectedCandidate.risk_flags?.length ? selectedCandidate.risk_flags : ["风险检查结果待更新"]).slice(0, 3).map((risk) => <li key={risk}>{humanizeResearchText(risk)}</li>)}</ul></div>{selectedCandidate.missing_fields?.length ? <div className="mt-4 rounded-md bg-warning/10 px-2 py-1.5 text-micro text-warning">缺失：{selectedCandidate.missing_fields.map(fieldLabel).join("、")}</div> : null}<details className="mt-4 min-w-0 text-caption"><summary className="cursor-pointer text-info">查看筛选条件与依据</summary><div className="mt-2 min-w-0 space-y-2 break-words text-micro text-muted-foreground"><div>已满足：{selectedCandidate.matched_conditions?.length ? selectedCandidate.matched_conditions.map(conditionLabel).join("；") : "服务未返回逐项条件"}</div><div>未满足：{selectedCandidate.unmatched_conditions?.length ? selectedCandidate.unmatched_conditions.map(conditionLabel).join("；") : "无"}</div><div>排序依据与参考值：{selectedCandidate.score_contributions && Object.keys(selectedCandidate.score_contributions).length ? Object.entries(selectedCandidate.score_contributions).map(([key, value]) => `${fieldLabel(key)}：${formatNumber(value)}`).join("；") : "未提供"}</div><div>证据来源：{selectedCandidate.source_ids?.length ? `${selectedCandidate.source_ids.length} 条可追溯来源` : "未提供"}</div></div></details><div className="mt-5 flex flex-wrap gap-1.5"><Button size="sm" onClick={() => void addCandidate(selectedCandidate)}><Plus className="mr-1.5 h-3.5 w-3.5" />加入自选</Button><Button variant="ghost" size="sm" className="bg-background/80 hover:bg-background" onClick={() => { const origin = buildSelectionOrigin({ report, candidate: selectedCandidate, opportunity: selectedOpportunity }); onDeepResearch(candidateId(selectedCandidate), origin ?? undefined); }}><Play className="mr-1.5 h-3.5 w-3.5" />深度投研</Button></div></section> : <section className="rounded-xl bg-muted/25 p-4 text-caption text-muted-foreground">选择一只候选查看入选条件、风险和数据来源。</section>}
              {selectedOpportunity && <OpportunityDetail candidate={selectedOpportunity} workflowRunId={report?.workflow_run_id} hasCatalystEvent={Boolean(selectedCandidate && candidateCatalystEvents(selectedCandidate).length > 0)} />}
              {opportunityResearch?.comparison_summary?.length ? <section className="rounded-xl bg-muted/25 p-4"><OpportunityClaimList title="本批候选比较" values={opportunityResearch.comparison_summary} /></section> : null}
              {compareResult && <section className="rounded-xl bg-muted/25 p-4"><div className="flex items-center justify-between"><h3 className="text-ui font-medium">候选比较</h3><Button variant="ghost" size="icon" className="h-6 w-6" aria-label="关闭候选比较" onClick={() => setCompareResult(null)}><X className="h-3.5 w-3.5" /></Button></div>{compareResult.note && <p className="mt-1 text-micro text-muted-foreground">{humanizeResearchText(compareResult.note)}</p>}<div className="mt-3 space-y-3">{(compareResult.dimensions ?? []).map((dimension) => <div key={dimension.key} className="text-caption"><div className="text-micro text-muted-foreground">{humanizeResearchText(dimension.label)}</div><div className="mt-1 grid gap-1">{Object.entries(dimension.values).map(([id, value]) => <div key={id} className="flex justify-between gap-2"><span className="truncate">{comparisonCandidateLabel(id, comparisonCandidates)}</span><span className="tabular-nums">{value ?? "待提供"}</span></div>)}</div></div>)}{!compareResult.dimensions?.length && (compareResult.candidates ?? []).map((candidate) => <div key={candidateId(candidate)} className="flex items-center justify-between gap-2 text-caption"><span className="truncate">{candidate.name} · 股票代码 {candidateSymbol(candidate)}</span><span className="tabular-nums">{formatNumber(candidateMetric(candidate, "price"))}</span></div>)}</div></section>}
              {report && <SelectionOutcomePanel outcomes={selectionOutcomes} loading={selectionOutcomesLoading} refreshing={selectionOutcomesRefreshing} error={selectionOutcomesError} candidate={selectedCandidate} onReload={reloadSelectionOutcomes} onRefresh={refreshSelectionOutcomes} />}
            </aside>
          </div>
        )}

              {tab === "history" && <div className="mx-auto max-w-3xl rounded-lg border bg-card"><div className="flex items-center justify-between border-b px-3 py-3"><div><h3 className="text-ui font-medium">历史运行</h3><p className="mt-0.5 text-micro text-muted-foreground">重启后仍可从这里读取筛选结果和机会研究（若已生成）</p></div><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="刷新历史运行" onClick={() => void loadData()}><RefreshCw className="h-3.5 w-3.5" /></Button></div>{history.length === 0 ? <div className="px-4 py-10 text-center text-caption text-muted-foreground">还没有历史选股运行</div> : <div className="divide-y">{history.map((item) => <div key={item.run_id} className="flex items-center gap-3 px-3 py-3"><Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="truncate text-ui font-medium">{historyStrategyLabel(item, strategies)}</div><div className="mt-1 text-micro text-muted-foreground">{formatAsOf(item.as_of)} · {item.candidate_count ?? 0} 只候选 · {dataQualityLabel(item.data_quality)} · 候选研究：{opportunityStatusLabel(item.research_status)}</div></div><span className={cn("text-caption", item.status === "succeeded" || item.status === "completed" ? "text-success" : item.status === "failed" ? "text-destructive" : item.status === "partial" ? "text-warning" : "text-muted-foreground")}>{historyStatusLabel(item.status)}</span><Button variant="outline" size="sm" disabled={!item.report_id && !item.run_id} onClick={() => { if (item.strategy_id) setSelectedStrategy(strategies.find((strategy) => strategy.strategy_id === item.strategy_id) ?? null); void loadResult(item.run_id); }}>查看</Button></div>)}</div>}</div>}
      </div>

      {guideOpen && <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/20 p-4" role="dialog" aria-modal="true" aria-label="选股分析师引导"><div className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg"><div className="flex items-center justify-between"><div><h3 className="text-ui font-medium">选股分析师引导</h3><p className="mt-0.5 text-micro text-muted-foreground">第 {guideStep + 1} / {GUIDE_QUESTIONS.length} 个问题</p></div><Button variant="ghost" size="icon" className="h-7 w-7" aria-label="关闭引导" onClick={() => setGuideOpen(false)}><X className="h-4 w-4" /></Button></div><p className="mt-4 text-ui">{GUIDE_QUESTIONS[guideStep].title}</p><div className="mt-3 space-y-2">{GUIDE_QUESTIONS[guideStep].options.map((option) => <Button key={option.value} type="button" variant="outline" className="h-auto w-full justify-start py-2.5 text-left" onClick={() => answerGuide(option.value)}>{option.label}<ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" /></Button>)}</div></div></div>}
    </div>
  );
}
