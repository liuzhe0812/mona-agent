import { useState } from "react";
import type { ReactNode } from "react";

import type {
  StockClaimType,
  StockCycleState,
  StockDimensionKey,
  StockHorizonCondition,
  StockHorizonView,
  StockMarketBreadthProjection,
  StockPublicActivityProjection,
  StockPublicDisclosureSignal,
  StockReportDocument,
  StockReportV4Document,
  StockSelectionOrigin,
  StockScenario,
  StockStance,
  StockSummarySection,
  StockViewPoint,
} from "@/lib/stock-api";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { evidenceCountLabel, evidenceStrengthLabel, evidenceTextLabel, missingFieldsLabel, stanceLabel, thesisLabel } from "./labels";
import { DebateResolutionPanel, ResearchEvidenceDetail, ValuationAnalysis } from "./ResearchEvidenceDetail";
import { OutcomeCalibrationPanel } from "./OutcomeCalibrationPanel";

type HorizonKey = "short_term" | "medium_term" | "long_term";
type ScenarioKey = "optimistic" | "base" | "pessimistic";

const HORIZONS: Array<{ key: HorizonKey; label: string; range: string }> = [
  { key: "short_term", label: "短线", range: "1–10 个交易日" },
  { key: "medium_term", label: "中线", range: "2 周–6 个月" },
  { key: "long_term", label: "长线", range: "6 个月以上" },
];

const SCENARIOS: Array<{ key: ScenarioKey; label: string }> = [
  { key: "optimistic", label: "乐观" },
  { key: "base", label: "基准" },
  { key: "pessimistic", label: "悲观" },
];

const CYCLES: Array<{ key: keyof StockReportV4Document["cycle_states"]; label: string }> = [
  { key: "policy", label: "宏观与流动性周期" },
  { key: "industry", label: "行业供需与产品价格周期" },
  { key: "earnings", label: "公司盈利与现金流周期" },
  { key: "valuation", label: "市场风格与筹码周期" },
];

const DIMENSIONS: Array<{ key: StockDimensionKey; label: string }> = [
  { key: "market_environment", label: "市场环境" },
  { key: "industry", label: "行业信息" },
  { key: "policy", label: "政策信息" },
  { key: "cycle", label: "周期判断" },
  { key: "company_quality", label: "公司质量" },
  { key: "valuation", label: "估值" },
  { key: "capital_positioning", label: "资金与筹码" },
  { key: "event_risk", label: "事件与风险" },
];

const EMPTY_VALUATION_SECTION: StockSummarySection = {
  status: "missing",
  summary: "",
  points: [],
  missing_fields: ["valuation_metrics", "peer_valuation"],
  source_ids: [],
};

function isV4(report: StockReportDocument): report is StockReportV4Document {
  return report.schema_version === 4;
}

function statusLabel(value: string | null | undefined): string {
  switch (value) {
    case "available":
    case "complete":
      return "可用";
    case "degraded":
      return "部分缺失";
    case "missing":
      return "缺失";
    case "insufficient_data":
      return "数据不足";
    default:
      return "未提供";
  }
}

function statusTone(value: string | null | undefined): string {
  if (value === "insufficient_data" || value === "missing") return "text-destructive";
  if (value === "degraded") return "text-warning";
  return "text-foreground";
}

function stanceTone(value: StockStance | null | undefined): string {
  if (value === "positive") return "text-stock-up";
  if (value === "negative") return "text-stock-down";
  if (value === "insufficient_data") return "text-warning";
  return "text-foreground";
}

function horizonStanceLabel(value: StockStance | null | undefined): string {
  switch (value) {
    case "positive":
      return "看涨";
    case "negative":
      return "看跌";
    case "neutral":
      return "中性";
    case "insufficient_data":
      return "数据不足";
    default:
      return "观点待确认";
  }
}

function horizonThesisLabel(value: string | null | undefined): string {
  const text = thesisLabel(evidenceTextLabel(value ?? "")) || "未提供";
  return text.replace(/^(positive|negative|neutral|insufficient_data)\b/i, (token) => {
    const normalized = token.toLowerCase();
    if (normalized === "positive") return "看涨";
    if (normalized === "negative") return "看跌";
    if (normalized === "neutral") return "中性";
    return "数据不足";
  });
}

function pricedInLabel(value: StockHorizonView["priced_in"]): string {
  switch (value) {
    case "not_priced_in":
      return "尚未计价";
    case "partially_priced_in":
      return "部分计价";
    case "fully_priced_in":
      return "已充分计价";
    default:
      return "未知";
  }
}

function selectionOriginHorizonLabel(value: string): string {
  switch (value) {
    case "short_term": return "短线（1—10 个交易日）";
    case "swing": return "波段（数周）";
    case "medium_term": return "中线（2 周—6 个月）";
    case "long_term": return "长线（6 个月以上）";
    default: return "观察周期待确认";
  }
}

const SELECTION_ORIGIN_DISPLAY_LABELS: Record<string, string> = {
  short_term: "短线",
  swing: "波段",
  medium_term: "中线",
  long_term: "长线",
  operating_cashflow: "经营活动现金流",
  momentum20: "20日价格动量",
  momentum60: "60日价格动量",
  volatility20: "20日波动幅度",
  industry_context: "行业信息",
  policy_context: "政策信息",
  insufficient_data: "数据不足",
  partial: "部分缺失",
  stale: "可能已过期",
  unavailable: "暂不可用",
};

function selectionOriginDisplayText(value: string): string {
  return Object.entries(SELECTION_ORIGIN_DISPLAY_LABELS).reduce(
    (text, [code, label]) => text.replace(new RegExp(`\\b${code}\\b`, "gi"), label),
    value,
  );
}

function selectionOriginTime(value: string | null): string {
  return value ? fmtDateTime(value, "zh-CN") || "时间待确认" : "时间待确认";
}

function SelectionOriginCard({ origin }: { origin: StockSelectionOrigin }) {
  return <section className="border-l-2 border-info/50 bg-info/5 px-3 py-2.5" data-testid="selection-origin-report">
    <div className="flex items-center justify-between gap-2">
      <div>
        <h2 className="text-caption font-medium">选股线索</h2>
      </div>
      <span className="text-micro text-muted-foreground">来自人工智能选股</span>
    </div>
    <dl className="mt-2 grid gap-1 text-micro text-muted-foreground sm:grid-cols-2">
      <div><dt className="inline">策略：</dt><dd className="inline text-foreground">{selectionOriginDisplayText(origin.strategy_name)}</dd></div>
      <div><dt className="inline">原始排名：</dt><dd className="inline text-foreground">第 {origin.deterministic_rank} 名</dd></div>
      <div><dt className="inline">选股周期：</dt><dd className="inline text-foreground">{selectionOriginHorizonLabel(origin.strategy_horizon)}</dd></div>
      <div><dt className="inline">选股时间：</dt><dd className="inline text-foreground">{selectionOriginTime(origin.selection_as_of)}</dd></div>
      <div><dt className="inline">来源数量：</dt><dd className="inline text-foreground">{origin.source_count} 条</dd></div>
    </dl>
    <div className="mt-2 grid gap-2 text-micro">
      <div><div className="text-muted-foreground">为什么入选</div><div className="mt-0.5 text-foreground">{origin.selection_reasons.length > 0 ? origin.selection_reasons.map(selectionOriginDisplayText).join("；") : "未提供"}</div></div>
      <div><div className="text-muted-foreground">为什么值得继续研究</div><div className="mt-0.5 text-foreground">{origin.why_now ? selectionOriginDisplayText(origin.why_now) : "未提供"}</div></div>
      <div><div className="text-muted-foreground">需要重点核验</div><div className="mt-0.5 text-foreground">{origin.focus_questions.length > 0 ? origin.focus_questions.map(selectionOriginDisplayText).join("；") : "未提供"}</div></div>
    </div>
  </section>;
}

function relativeViewLabel(value: StockHorizonView["benchmark"]["relative_view"]): string {
  switch (value) {
    case "outperform":
      return "相对跑赢";
    case "underperform":
      return "相对跑输";
    case "inline":
      return "大致同步";
    default:
      return "未知";
  }
}

function actionLabel(value: StockHorizonView["action"]): string {
  switch (value) {
    case "conditional_participation":
      return "满足条件再参与";
    case "wait_for_confirmation":
      return "等待确认";
    case "reduce_exposure":
      return "减仓或回避";
    case "observe":
      return "继续观察";
    default:
      return "不适用";
  }
}

function claimTypeLabel(value: StockClaimType): string {
  switch (value) {
    case "fact":
      return "事实";
    case "inference":
      return "推断";
    default:
      return "假设";
  }
}

function PointList({ points, empty = "未提供" }: { points: StockViewPoint[]; empty?: string }) {
  if (!points.length) return <p className="text-caption text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1 text-caption">
      {points.map((point, index) => (
        <li key={`${point.claim}-${index}`} className="flex gap-1.5">
          <span className="shrink-0 text-micro text-muted-foreground">{claimTypeLabel(point.claim_type)}</span>
          <span className="min-w-0">{evidenceTextLabel(point.claim)}</span>
        </li>
      ))}
    </ul>
  );
}

function ConditionList({
  conditions,
  title,
  testId,
  kindLabelMode = "full",
}: {
  conditions: StockHorizonCondition[];
  title: string;
  testId?: string;
  kindLabelMode?: "full" | "decision";
}) {
  return (
    <div data-testid={testId}>
      <div className="text-micro font-medium text-muted-foreground">{title}</div>
      {conditions.length ? (
        <ul className="mt-1 space-y-1 text-caption">
          {conditions.map((condition, index) => (
            <li key={`${condition.text}-${index}`} className="flex items-start gap-1.5">
              {kindLabelMode === "full" && (
                <span className="shrink-0 px-1 text-[10px] leading-4 text-muted-foreground">
                  {condition.kind === "manual" ? "人工观察（不会自动触发）" : "系统可计算"}
                </span>
              )}
              {kindLabelMode === "decision" && condition.kind === "manual" && (
                <span className="shrink-0 px-1 text-[10px] leading-4 text-muted-foreground">需人工观察</span>
              )}
              <span className="min-w-0">{evidenceTextLabel(condition.text) || "未提供"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-caption text-muted-foreground">未提供</p>
      )}
    </div>
  );
}

function SummarySection({
  title,
  section,
  compact = false,
  testId,
  className,
  children,
}: {
  title: string;
  section: StockSummarySection;
  compact?: boolean;
  testId?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cn("border-b border-border/70 px-0 py-3", className)} data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-medium">{title}</h3>
        <span className="flex items-center gap-2">
          <span className={cn("text-micro", statusTone(section.status))}>{statusLabel(section.status)}</span>
          <span className="text-micro text-muted-foreground">{section.source_ids.length} 个来源</span>
          {section.missing_fields.length > 0 && <span className="text-micro text-warning">{section.missing_fields.length} 项缺失</span>}
        </span>
      </div>
      <p className={cn("mt-1 text-caption", compact && "line-clamp-2")}>
        {evidenceTextLabel(section.summary) || "未提供总结"}
      </p>
      {children}
      {!compact && section.points.length > 0 && <div className="mt-2"><PointList points={section.points} /></div>}
      {!compact && section.missing_fields.length > 0 && (
        <p className="mt-2 text-micro text-warning">缺失：{missingFieldsLabel(section.missing_fields)}</p>
      )}
    </section>
  );
}

const MARKET_BREADTH_MISSING_LABELS: Record<string, string> = {
  market_snapshot: "市场快照",
  breadth: "涨跌分布",
  market_snapshot_complete: "市场快照完整性",
  "coverage.complete": "覆盖完整性",
  "coverage.loaded_count": "已加载数量",
  "coverage.expected_count": "应加载数量",
  member_count: "市场成员数",
  available_change_count: "可用涨跌幅数量",
  change_pct: "涨跌幅数据",
  advancing: "上涨数量",
  declining: "下跌数量",
  unchanged: "平盘数量",
  suspended: "停牌数量",
  limit_up_count: "涨停数量",
  limit_down_count: "跌停数量",
  advance_ratio: "上涨占比",
  turnover_amount: "市场快照成交额",
  observed_at: "数据时点",
  basis: "统计依据",
  method: "计算口径",
};

const PUBLIC_ACTIVITY_MISSING_LABELS: Record<string, string> = {
  turnover: "个股成交额",
  turnover_rate: "换手率",
  volume: "成交量",
  price_change_pct: "涨跌幅",
  volume_change_pct_5d: "近5日成交量变化",
  observed_at: "数据时点",
  disclosure_signals: "公开披露信号",
  "disclosure_signals.source_ids": "公开披露信号可追溯来源",
  share_unlock: "限售股解禁",
  share_reduction: "股东减持",
  share_pledge: "股权质押",
  unlock: "限售股解禁",
  reduction: "股东减持",
  pledge: "股权质押",
  financing_balance: "融资余额",
  short_balance: "融券余额",
  financing_flow: "融资融券变化",
  institutional_flow: "机构资金流",
  etf_flow: "交易型开放式指数基金（ETF）资金流",
  shareholder_concentration: "股东集中度",
  basis: "统计依据",
  method: "计算口径",
};

function referenceMissingFields(fields: string[] | undefined, labels: Record<string, string>): string[] {
  return [...new Set((fields ?? []).map((field) => labels[field] ?? "其他必要数据"))];
}

function referenceNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
    : "暂无";
}

function formatRatioAsPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`
    : "暂无";
}

function formatPercentValue(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`
    : "暂无";
}

function referenceDateTime(value: string | null | undefined): string {
  return value ? fmtDateTime(value, "zh-CN") || "日期待确认" : "日期待确认";
}

function referenceDate(value: string | null | undefined): string {
  if (!value) return "日期待确认";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (dateOnly) return `${Number(dateOnly[1])}年${Number(dateOnly[2])}月${Number(dateOnly[3])}日`;
  return referenceDateTime(value);
}

function referenceCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "暂无";
}

function hasMarketBreadthData(projection: StockMarketBreadthProjection): boolean {
  return [
    projection.member_count,
    projection.available_change_count,
    projection.advancing,
    projection.declining,
    projection.unchanged,
    projection.suspended,
    projection.advance_ratio,
    projection.turnover_amount,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function MarketBreadthReference({ projection }: { projection?: StockMarketBreadthProjection | null }) {
  const missing = referenceMissingFields(projection?.missing_fields, MARKET_BREADTH_MISSING_LABELS);
  const coverage = projection?.coverage;
  const hasCoverageCounts = typeof coverage?.loaded_count === "number" && typeof coverage?.expected_count === "number";
  const coverageText = hasCoverageCounts
    ? `覆盖范围：已加载 ${referenceCount(coverage.loaded_count)} / 应加载 ${referenceCount(coverage.expected_count)}（${coverage.complete === true ? "完整" : coverage.complete === false ? "不完整" : "完整性待确认"}）`
    : "覆盖范围：暂无可验证的覆盖数量";
  const hasData = projection ? hasMarketBreadthData(projection) : false;

  return (
    <div className="mt-2 rounded border bg-muted/10 px-2.5 py-2" data-testid="market-breadth-reference">
      <h4 className="text-micro font-medium">市场宽度参考（不是市场情绪）</h4>
      {hasData ? (
        <div className="mt-1 space-y-1 text-micro">
          <div>{coverageText}</div>
          <div>上涨 {referenceCount(projection?.advancing)} · 下跌 {referenceCount(projection?.declining)} · 平盘 {referenceCount(projection?.unchanged)} · 停牌 {referenceCount(projection?.suspended)}</div>
          <div>上涨占比：{formatRatioAsPercent(projection?.advance_ratio)}</div>
          <div>市场快照成交额：{referenceNumber(projection?.turnover_amount)}（按数据源口径）</div>
          <div>数据时点：{referenceDateTime(projection?.observed_at)}</div>
        </div>
      ) : (
        <p className="mt-1 text-micro text-muted-foreground">暂无可验证的市场宽度数据</p>
      )}
      {missing.length > 0 && <p className="mt-1 text-micro text-warning">缺失：{missing.join("、")}</p>}
      <p className="mt-1 text-micro text-muted-foreground">仅反映当前行情快照的涨跌分布，不代表市场情绪</p>
    </div>
  );
}

function disclosureTypeLabel(value: string | null | undefined): string {
  switch (value) {
    case "share_unlock":
      return "限售股解禁";
    case "share_reduction":
      return "股东减持";
    case "share_pledge":
      return "股权质押";
    default:
      return "公开披露事件";
  }
}

function disclosureSignalLabel(signal: StockPublicDisclosureSignal): string {
  const title = typeof signal.title === "string" && signal.title.trim()
    ? signal.title.trim()
    : "标题待确认";
  return `${disclosureTypeLabel(signal.event_type)} · ${referenceDate(signal.event_date ?? signal.published_at)} · ${title}`;
}

function hasPublicActivityData(projection: StockPublicActivityProjection): boolean {
  return [
    projection.turnover,
    projection.turnover_rate,
    projection.volume,
    projection.price_change_pct,
    projection.volume_change_pct_5d,
  ].some((value) => typeof value === "number" && Number.isFinite(value)) || Boolean(projection.observed_at);
}

function PublicActivityReference({ projection }: { projection?: StockPublicActivityProjection | null }) {
  const missing = referenceMissingFields(projection?.missing_fields, PUBLIC_ACTIVITY_MISSING_LABELS);
  const signals = projection?.disclosure_signals ?? [];
  const hasData = projection ? hasPublicActivityData(projection) : false;

  return (
    <div className="mt-2 rounded border bg-muted/10 px-2.5 py-2" data-testid="public-activity-reference">
      <h4 className="text-micro font-medium">公开交易活跃度参考（不代表机构资金）</h4>
      {hasData ? (
        <div className="mt-1 grid gap-x-3 gap-y-1 text-micro sm:grid-cols-2">
          <div>个股成交额：{referenceNumber(projection?.turnover)}（按数据源口径）</div>
          <div>换手率：{formatPercentValue(projection?.turnover_rate)}</div>
          <div>成交量：{referenceNumber(projection?.volume)}（按数据源口径）</div>
          <div>涨跌幅：{formatPercentValue(projection?.price_change_pct)}</div>
          <div>5日成交量变化：{formatPercentValue(projection?.volume_change_pct_5d)}</div>
          <div>数据时点：{referenceDateTime(projection?.observed_at)}</div>
        </div>
      ) : (
        <p className="mt-1 text-micro text-muted-foreground">暂无可验证的公开交易活跃度数据</p>
      )}
      {missing.length > 0 && <p className="mt-1 text-micro text-warning">缺失：{missing.join("、")}</p>}
      <div className="mt-1 text-micro">
        <span className="font-medium">公开披露信号：</span>
        {signals.length > 0 ? (
          <ul className="mt-0.5 space-y-0.5">
            {signals.map((signal, index) => <li key={`${signal.event_type ?? "event"}-${index}`}>{disclosureSignalLabel(signal)}</li>)}
          </ul>
        ) : (
          <span className="text-muted-foreground">暂无可验证的公开披露信号</span>
        )}
      </div>
      <p className="mt-1 text-micro text-muted-foreground">不推断机构净买入或主力控盘</p>
    </div>
  );
}

function DimensionOverview({ report }: { report: StockReportV4Document }) {
  return (
    <section className="border-t pt-4" data-testid="research-dimension-overview">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-caption font-medium">八项分析维度</h2>
        </div>
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-0 sm:grid-cols-2 xl:grid-cols-4">
        {DIMENSIONS.map(({ key, label }) => {
          const section = report.dimension_views?.[key];
          if (section || key === "valuation") {
            const displaySection = section ?? EMPTY_VALUATION_SECTION;
            return (
              <SummarySection
                key={key}
                title={label}
                section={displaySection}
                compact
                className={key === "valuation" ? "xl:col-span-2" : undefined}
                testId={`research-dimension-${key}`}
              >
                {key === "valuation" ? <ValuationAnalysis section={displaySection} /> : null}
                {key === "market_environment" ? <MarketBreadthReference projection={displaySection.market_breadth} /> : null}
                {key === "capital_positioning" ? <PublicActivityReference projection={displaySection.public_activity} /> : null}
              </SummarySection>
            );
          }
          return (
            <div key={key} className="border-b border-dashed border-border/70 px-0 py-3" data-testid={`research-dimension-${key}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-caption font-medium">{label}</h3>
                <span className="flex items-center gap-2 text-micro">
                  <span className="text-destructive">缺失</span>
                  <span className="text-muted-foreground">0 个来源</span>
                </span>
              </div>
              <p className="mt-1 text-caption text-muted-foreground">本报告未提供该维度</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CycleState({ title, state }: { title: string; state: StockCycleState }) {
  return (
    <div className="bg-muted/10 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium">{title}</span>
        <span className={cn("text-micro", statusTone(state.status))}>{statusLabel(state.status)}</span>
      </div>
      <div className="mt-1 text-caption">阶段：{evidenceTextLabel(state.stage) || "未提供"}</div>
      {state.observation_window && <div className="mt-0.5 text-micro text-muted-foreground">观察窗口：{evidenceTextLabel(state.observation_window)}</div>}
      {state.missing_fields.length > 0 && <div className="mt-1 text-micro text-warning">缺失：{missingFieldsLabel(state.missing_fields)}</div>}
    </div>
  );
}

function ScenarioPanel({ scenario }: { scenario: StockScenario }) {
  return (
    <div className="border-l-2 border-info/30 bg-muted/10 px-3 py-2.5" data-testid="scenario-panel">
      <p className="text-caption">{evidenceTextLabel(scenario.summary) || "未提供情景总结"}</p>
      <div className="mt-1 text-caption">结果方向：{evidenceTextLabel(scenario.outcome_direction) || "未提供"}</div>
      <ConditionList conditions={scenario.conditions} title="触发条件" />
      {scenario.risks.length > 0 && (
        <div className="mt-2"><div className="text-micro font-medium text-muted-foreground">主要风险</div><PointList points={scenario.risks} /></div>
      )}
    </div>
  );
}

const EMPTY_SCENARIO: StockScenario = {
  summary: "",
  conditions: [],
  outcome_direction: "",
  risks: [],
  source_ids: [],
};

function HorizonCard({
  meta,
  view,
  expanded,
  onToggle,
  scenarioKey,
  onScenarioChange,
  scenarios,
}: {
  meta: (typeof HORIZONS)[number];
  view: StockHorizonView;
  expanded: boolean;
  onToggle: () => void;
  scenarioKey: ScenarioKey;
  onScenarioChange: (key: ScenarioKey) => void;
  scenarios: StockReportV4Document["scenario_sets"][HorizonKey];
}) {
  const headingId = `research-horizon-${meta.key}`;
  const participationConditions = [...view.participation_conditions, ...view.confirmation_conditions].slice(0, 3);
  const exitConditions = view.invalidation_conditions.slice(0, 3);
  const dimensionLabels = Array.isArray(view.dimension_keys)
    ? view.dimension_keys.map((key) => DIMENSIONS.find((dimension) => dimension.key === key)?.label ?? key)
    : [];
  const benchmarkCode = view.benchmark.instrument_id ? `（${view.benchmark.instrument_id}）` : "";
  const coreThesis = horizonThesisLabel(view.thesis);
  const mainRisks = [...view.tradeability_risks, ...view.blind_spots];
  return (
    <section className="border-b border-border/70 last:border-b-0" data-testid={`horizon-card-${meta.key}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-muted/30"
        aria-expanded={expanded}
        aria-controls={`${headingId}-body`}
        onClick={onToggle}
      >
        <span className="min-w-0">
          <span id={headingId} className="text-ui font-medium">{meta.label}</span>
          <span className="ml-2 text-caption text-muted-foreground">{meta.range}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={cn("text-caption font-medium", stanceTone(view.stance))}>{horizonStanceLabel(view.stance)}</span>
          <span aria-hidden className="text-caption text-muted-foreground">{expanded ? "⌃" : "⌄"}</span>
        </span>
      </button>
      <div className="px-0 py-2.5" data-testid={`horizon-summary-${meta.key}`}>
        <div className="grid gap-x-4 gap-y-1 text-caption md:grid-cols-2">
          <div><span className="text-muted-foreground">当前操作：</span>{actionLabel(view.action)}</div>
          <div className="md:col-span-1"><span className="text-muted-foreground">核心命题：</span>{coreThesis}</div>
        </div>
      </div>
      {expanded && (
        <div id={`${headingId}-body`} className="space-y-4 border-t py-3">
          <div data-testid={`horizon-action-${meta.key}`}>
            <div className="text-caption font-medium">当前操作</div>
            <p className="mt-1 text-caption">{actionLabel(view.action)}</p>
          </div>
          <ConditionList
            title="参与/买入条件"
            conditions={participationConditions}
            testId={`horizon-participation-${meta.key}`}
            kindLabelMode="decision"
          />
          <ConditionList
            title="退出/减仓条件"
            conditions={exitConditions}
            testId={`horizon-exit-${meta.key}`}
            kindLabelMode="decision"
          />
          <div data-testid={`horizon-time-boundary-${meta.key}`}>
            <div className="text-caption font-medium">时间边界</div>
            <p className="mt-1 text-caption">{view.time_stop || "未提供"}</p>
          </div>
          <div data-testid={`horizon-risks-${meta.key}`}>
            <div className="text-caption font-medium">主要风险</div>
            <div className="mt-1"><PointList points={mainRisks} /></div>
          </div>
          <section data-testid={`horizon-basis-${meta.key}`}>
            <div className="text-caption font-medium">判断依据</div>
            <div className="mt-1 space-y-2 text-caption">
              <div data-testid={`horizon-dimensions-${meta.key}`}>
                本周期依据：{dimensionLabels.length > 0 ? dimensionLabels.join("、") : "未提供"}
              </div>
              {view.watch_conditions.length > 0 && (
                <ConditionList title="观察条件" conditions={view.watch_conditions} kindLabelMode="decision" />
              )}
              <div>
                <span className="text-muted-foreground">相对基准：</span>
                {evidenceTextLabel(view.benchmark.name) || "未提供"}{benchmarkCode} · {relativeViewLabel(view.benchmark.relative_view)}
                {view.benchmark.basis && <div className="mt-0.5 text-micro text-muted-foreground">比较依据：{evidenceTextLabel(view.benchmark.basis)}</div>}
                {view.benchmark.source_ids?.length ? <div className="mt-0.5 text-micro text-muted-foreground">依据：{evidenceCountLabel(view.benchmark.source_ids)}</div> : null}
              </div>
              <div><span className="text-muted-foreground">市场计价：</span>{pricedInLabel(view.priced_in)}</div>
              {view.priced_in_basis && <div><span className="text-muted-foreground">计价依据：</span><span className="mr-1 text-micro text-muted-foreground">{claimTypeLabel(view.priced_in_basis.claim_type)}</span>{evidenceTextLabel(view.priced_in_basis.claim)}</div>}
              <div><span className="text-muted-foreground">关键驱动：</span>{view.drivers.length > 0 ? view.drivers.map((point) => evidenceTextLabel(point.claim)).join("；") : "未提供"}</div>
              <div><span className="text-muted-foreground">证据强度：</span>{evidenceStrengthLabel(view.evidence_strength)} · <span className={statusTone(view.data_status)}>数据状态：{statusLabel(view.data_status)}</span></div>
              <div className="text-micro text-warning">缺失数据：{missingFieldsLabel(view.missing_fields)}</div>
            </div>
            <div className="mt-3">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-caption font-medium">情景</span>
                {SCENARIOS.map((scenario) => (
                  <button
                    type="button"
                    key={scenario.key}
                    className={cn("rounded border px-2 py-0.5 text-micro", scenarioKey === scenario.key ? "border-info bg-info/10 text-info" : "text-muted-foreground hover:text-foreground")}
                    aria-pressed={scenarioKey === scenario.key}
                    onClick={() => onScenarioChange(scenario.key)}
                  >
                    {scenario.label}
                  </button>
                ))}
              </div>
              <ScenarioPanel scenario={scenarios?.[scenarioKey] ?? EMPTY_SCENARIO} />
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function LegacyView({ report }: { report: Exclude<StockReportDocument, StockReportV4Document> }) {
  const legacy = report as Exclude<StockReportDocument, StockReportV4Document> & {
    research_stance?: StockStance | null;
    summary?: string;
    time_horizon?: string | null;
  };
  return (
    <section className="space-y-3 px-1" data-testid="legacy-research-view">
      <div className="rounded-md border bg-muted/10 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui font-medium">历史投研结论</h3>
        </div>
        <div className="mt-2 grid gap-2 text-caption md:grid-cols-3">
          <div><div className="text-muted-foreground">研究倾向</div><div className={cn("mt-0.5 font-medium", stanceTone(legacy.research_stance))}>{stanceLabel(legacy.research_stance)}</div></div>
          <div><div className="text-muted-foreground">适用周期</div><div className="mt-0.5 font-medium">{legacy.time_horizon || "未提供"}</div></div>
          <div><div className="text-muted-foreground">报告状态</div><div className="mt-0.5 font-medium">{statusLabel(legacy.data_quality)}</div></div>
        </div>
      </div>
      <div>
        <h3 className="text-ui font-medium">主审摘要</h3>
        <p className="mt-1 text-body text-muted-foreground">{evidenceTextLabel(legacy.summary) || "报告未提供摘要"}</p>
      </div>
    </section>
  );
}

export function ResearchDecisionView({ report }: { report: StockReportDocument }) {
  const [expandedHorizon, setExpandedHorizon] = useState<HorizonKey | null>("medium_term");
  const [scenarioKeys, setScenarioKeys] = useState<Record<HorizonKey, ScenarioKey>>({
    short_term: "base",
    medium_term: "base",
    long_term: "base",
  });

  if (!isV4(report)) return <LegacyView report={report} />;

  return (
    <div className="space-y-5 px-1" data-testid="research-decision-view">
      <h1 className="text-title font-semibold">投研结论</h1>
      <section className="space-y-0" aria-label="三周期决策卡" data-testid="research-horizon-conclusions">
        <div className="flex items-center justify-between gap-2 border-b border-border/70 pb-2">
          <div>
            <h2 className="text-ui font-semibold">三周期独立结论</h2>
          </div>
        </div>
        {HORIZONS.map((meta) => (
          <HorizonCard
            key={meta.key}
            meta={meta}
            view={report.horizon_views[meta.key]}
            expanded={expandedHorizon === meta.key}
            onToggle={() => setExpandedHorizon((current) => current === meta.key ? null : meta.key)}
            scenarioKey={scenarioKeys[meta.key]}
            onScenarioChange={(scenarioKey) => setScenarioKeys((current) => ({ ...current, [meta.key]: scenarioKey }))}
            scenarios={report.scenario_sets[meta.key]}
          />
        ))}
      </section>
      <details className="border-t py-3" data-testid="research-full-analysis">
        <summary className="cursor-pointer text-caption font-medium">查看完整分析报告</summary>
        <div className="mt-4 space-y-5">
          {report.selection_origin && <SelectionOriginCard origin={report.selection_origin} />}
          {!report.dimension_views && (
            <div className="grid gap-2 md:grid-cols-2">
              <SummarySection title="市场状态" section={report.market_regime_summary} />
              <SummarySection title="行业与政策" section={report.industry_policy_summary} />
            </div>
          )}
          <DimensionOverview report={report} />
          <section className="border-t pt-4">
            <div className="mb-2 text-caption font-medium">四类周期状态</div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {CYCLES.map(({ key, label }) => <CycleState key={key} title={label} state={report.cycle_states[key]} />)}
            </div>
          </section>
          <section className="border-t pt-4" data-testid="research-cross-horizon-conflict">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-caption font-medium">周期冲突与裁决边界</h2>
              <span className={cn("text-micro", statusTone(report.cross_horizon_conflict.status))}>
                {statusLabel(report.cross_horizon_conflict.status)}
              </span>
            </div>
            <p className="mt-1 text-caption">{evidenceTextLabel(report.cross_horizon_conflict.explanation) || "未提供冲突说明"}</p>
            {report.cross_horizon_conflict.source_ids.length > 0 && (
              <p className="mt-1 text-micro text-muted-foreground">依据：{evidenceCountLabel(report.cross_horizon_conflict.source_ids)}</p>
            )}
          </section>
          <section className="border-t pt-4" data-testid="research-debate-summary">
            <h2 className="text-caption font-medium">核心多空分歧与裁决</h2>
            <div className="mt-2">
              <DebateResolutionPanel report={report} compact />
            </div>
          </section>
          <section className="border-t pt-4" data-testid="research-evidence-coverage">
            <h2 className="text-caption font-medium">证据覆盖</h2>
            <div className="mt-1 text-caption">研究截至：{report.research_cutoff_at || "未提供"}</div>
            <div className="mt-1 text-caption">行情截至：{report.market_as_of || "未提供"}</div>
          </section>
          <section className="border-t pt-4" data-testid="research-evidence-detail">
            <ResearchEvidenceDetail report={report} />
          </section>
          <section className="border-t pt-4" data-testid="outcome-calibration-details">
            <h2 className="text-caption font-medium">结果追踪与校准</h2>
            <div className="mt-3">
              <OutcomeCalibrationPanel reportId={report.report_id} />
            </div>
          </section>
        </div>
      </details>
    </div>
  );
}
