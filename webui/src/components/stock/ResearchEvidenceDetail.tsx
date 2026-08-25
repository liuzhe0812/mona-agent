import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useState, type ReactNode } from "react";
import type {
  StockCycleState,
  StockDataStatus,
  StockDebateResolution,
  StockDebateResolutions,
  StockDimensionKey,
  StockEventCalendar,
  StockEventCalendarItem,
  StockHorizonCondition,
  StockHorizonView,
  StockRawReportSource,
  StockReportV4Document,
  StockSummarySection,
  StockValuationMetrics,
  StockViewPoint,
} from "@/lib/stock-api";
import { fetchStockMaterialPage } from "@/lib/stock-api";

import {
  claimTypeLabel,
  conditionOperatorLabel,
  cycleLabel,
  evidenceTextLabel,
  eventTypeLabel,
  fieldLabel,
  metricLabel,
  periodLabel,
  providerLabel,
  researchEvidenceStrengthLabel,
  researchStatusLabel,
  safeUserValue,
  timeHorizonLabel,
} from "./labels";

const DEBATE_HORIZONS: Array<{ key: keyof StockDebateResolutions; label: string }> = [
  { key: "short_term", label: "短线" },
  { key: "medium_term", label: "中线" },
  { key: "long_term", label: "长线" },
];

const DIMENSION_LABELS: Array<{ key: StockDimensionKey; label: string }> = [
  { key: "market_environment", label: "市场环境" },
  { key: "industry", label: "行业信息" },
  { key: "policy", label: "政策信息" },
  { key: "cycle", label: "周期判断" },
  { key: "company_quality", label: "公司质量" },
  { key: "valuation", label: "估值" },
  { key: "capital_positioning", label: "资金与筹码" },
  { key: "event_risk", label: "事件与风险" },
];

const CLAIM_GROUP_LABELS: Record<string, string> = {
  technical: "技术分析",
  fundamental: "基本面分析",
  news: "资讯分析",
  bull: "看多分析",
  bear: "看空分析",
};

const VALUATION_METHOD_LABELS: Record<string, string> = {
  "same-industry-current-snapshot-percentile-v1": "同行业当前行情快照比较",
};

const EVIDENCE_TIME_ZONE = "Asia/Shanghai";
const EVIDENCE_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "long",
  timeZone: EVIDENCE_TIME_ZONE,
});
const EVIDENCE_DATETIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "long",
  timeStyle: "short",
  hour12: false,
  timeZone: EVIDENCE_TIME_ZONE,
});

function formatEvidenceTime(value: string | null | undefined): string {
  if (!value || !value.trim()) return "未提供";
  const raw = value.trim();
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  return (dateOnly ? EVIDENCE_DATE_FORMATTER : EVIDENCE_DATETIME_FORMATTER).format(date);
}

function valuationMethodLabel(value: string | null | undefined): string {
  return value ? VALUATION_METHOD_LABELS[value] ?? "同行比较方法待确认" : "未提供";
}

function valuationNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "未提供";
}

function valuationPercentile(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "未提供";
}

function dimensionSection(
  report: StockReportV4Document,
  key: StockDimensionKey,
): StockSummarySection | null {
  const direct = report.dimension_views?.[key];
  if (direct) return direct;

  // Early V4 reports predate dimension_views. Keep their verified summaries
  // readable without recreating the removed permanent-placeholder copy.
  if (key === "market_environment") return report.market_regime_summary;
  if (key === "industry" || key === "policy") return report.industry_policy_summary;
  if (key === "cycle") {
    const states = Object.values(report.cycle_states);
    const status: StockDataStatus = states.some((state) => state.status === "available")
      ? states.some((state) => state.status === "missing") ? "degraded" : "available"
      : states.some((state) => state.status === "degraded") ? "degraded" : "missing";
    return {
      status,
      summary: "四类周期状态见下方周期证据明细。",
      points: [],
      missing_fields: states.flatMap((state) => state.missing_fields),
      source_ids: [...new Set(states.flatMap((state) => state.source_ids))],
    };
  }
  if (key === "company_quality" && report.cycle_states.earnings) {
    const state = report.cycle_states.earnings;
    return {
      status: state.status,
      summary: state.stage ? `盈利周期阶段：${safeUserValue(state.stage, "阶段待确认")}` : "公司质量证据见盈利周期。",
      points: [...state.leading_indicators, ...state.confirmation_indicators],
      missing_fields: state.missing_fields,
      source_ids: state.source_ids,
    };
  }
  if (key === "valuation") {
    return {
      status: "missing",
      summary: "本报告未提供估值分析数据。",
      points: [],
      missing_fields: ["valuation_metrics", "peer_valuation"],
      source_ids: [],
    };
  }
  return null;
}

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function materialDisplayName(value: string | null | undefined): string {
  const clean = value?.replace(/\\/g, "/").split("/").at(-1)?.trim();
  return clean || "未命名财报";
}

export function ResearchEvidenceDetail({
  report,
}: {
  report: StockReportV4Document;
}) {
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  const cycles = report.cycle_states;
  const horizons = report.horizon_views;

  return (
    <div className="space-y-3" data-testid="research-evidence-detail">
      <div className="rounded-lg border bg-card px-3 py-2 text-caption">
        <div className="font-medium">投研依据</div>
        <div className="mt-1 grid gap-x-4 gap-y-1 text-micro text-muted-foreground sm:grid-cols-3">
          <span>研究截止：{formatEvidenceTime(report.research_cutoff_at)}</span>
          <span>行情截至：{formatEvidenceTime(report.market_as_of)}</span>
          <span>结果追踪：{report.outcome_tracking_id ? "已建立" : "未提供"}</span>
        </div>
        <p className="mt-2 text-caption">{evidenceTextLabel(report.summary) || "未提供"}</p>
      </div>

      <EvidenceSection title="八项分析维度" dataTestId="research-dimension-evidence">
        <div className="grid gap-2 md:grid-cols-2">
          {DIMENSION_LABELS.map(({ key, label }) => {
            const section = dimensionSection(report, key);
            return section ? (
              <div key={key} data-testid={`research-dimension-${key}`}>
                <SummaryBlock
                  label={label}
                  section={section}
                  sources={sources}
                  isValuation={key === "valuation"}
                />
              </div>
            ) : (
              <MissingState key={key} testId={`research-dimension-${key}`} text={`${label}：本报告未提供该维度`} />
            );
          })}
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          {Object.entries(horizons).map(([horizon, view]) => (
            <HorizonTradeability
              key={horizon}
              horizon={horizon}
              view={view}
              sources={sources}
            />
          ))}
        </div>
      </EvidenceSection>

      <EvidenceSection title="事件日历" dataTestId="research-event-calendar-evidence">
        <EventCalendarEvidence calendar={report.event_calendar} sources={sources} />
      </EvidenceSection>

      <EvidenceSection title="四周期">
        <div className="grid gap-2 md:grid-cols-2">
          {Object.entries(cycles).map(([cycle, state]) => (
            <CycleBlock
              key={cycle}
              label={cycleLabel(cycle)}
              state={state}
              sources={sources}
            />
          ))}
        </div>
      </EvidenceSection>

      <EvidenceSection title="分析产物引用">
        <ArtifactRefs
          label="上游分析产物（仅用于追溯，不替代八项结构化维度）"
          refs={report.analyst_views}
        />
      </EvidenceSection>

      <EvidenceSection title="风险、催化与待验证">
        <ClaimList label="风险" points={report.risks} sources={sources} />
        <ClaimList label="催化" points={report.catalysts} sources={sources} />
        <ClaimList
          label="待验证问题"
          points={report.open_questions}
          sources={sources}
        />
      </EvidenceSection>

      <EvidenceSection title="核心多空分歧与裁决">
        <DebateResolutionPanel report={report} />
        <div className="mt-2 rounded-md border bg-muted/10 p-2 text-caption">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">跨周期状态</span>
            <Badge variant="outline">
              {researchStatusLabel(report.cross_horizon_conflict.status)}
            </Badge>
          </div>
          <p className="mt-1">{evidenceTextLabel(report.cross_horizon_conflict.explanation) || "未提供"}</p>
          <SourceIds
            ids={report.cross_horizon_conflict.source_ids}
            sources={sources}
          />
        </div>
        <details className="mt-2 rounded-md border bg-muted/10 px-2 py-1.5 text-micro">
          <summary className="cursor-pointer text-muted-foreground">多空上游产物引用（仅追溯，不替代裁决）</summary>
          <ArtifactRefs
            label=""
            refs={report.debate}
            emptyText="多空正文未提供"
          />
        </details>
      </EvidenceSection>

      <section className="rounded-lg border bg-card px-3 py-2">
        <div className="text-caption font-medium">来源总览</div>
        <div className="mt-2 space-y-2">
          {report.sources.length > 0 ? (
            report.sources.map((source) => (
              <SourceCard key={source.id} source={source} />
            ))
          ) : (
            <MissingState text="未提供来源明细" />
          )}
        </div>
      </section>
    </div>
  );
}

function EvidenceSection({
  title,
  children,
  dataTestId,
}: {
  title: string;
  children: ReactNode;
  dataTestId?: string;
}) {
  return (
    <section className="rounded-lg border bg-card px-3 py-3" data-testid={dataTestId}>
      <h2 className="text-ui font-medium">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function SummaryBlock({
  label,
  section,
  sources,
  isValuation = false,
}: {
  label: string;
  section: StockSummarySection;
  sources: Map<string, StockRawReportSource>;
  isValuation?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">{label}</span>
        <Badge variant="outline">{researchStatusLabel(section.status)}</Badge>
      </div>
      <p className="mt-1 text-caption">{evidenceTextLabel(section.summary) || "未提供"}</p>
      {isValuation ? <ValuationAnalysis section={section} /> : null}
      <ClaimList label="依据" points={section.points} sources={sources} />
      {section.source_ids.length > 0 && !section.points.some((point) => point.source_ids.length > 0) ? (
        <SourceIds ids={section.source_ids} sources={sources} />
      ) : null}
      <MissingFields fields={section.missing_fields} />
    </div>
  );
}

function valuationMissingLabel(value: string): string {
  const labels: Record<string, string> = {
    valuation_metrics: "估值指标",
    current_pe: "市盈率（PE）当前值",
    current_pb: "市净率（PB）当前值",
    peer_valuation: "同行估值比较",
  };
  return labels[value] ?? "估值数据";
}

function ValuationMetricRow({
  label,
  current,
  peerCount,
  median,
  percentile,
}: {
  label: string;
  current: number | null | undefined;
  peerCount: number | null | undefined;
  median: number | null | undefined;
  percentile: number | null | undefined;
}) {
  const peerComparable = [current, median, percentile].every(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  return (
    <div className="rounded border bg-background/60 px-2 py-1.5 text-micro">
      <div className="font-medium">{label}</div>
      <div className="mt-1 grid gap-x-3 gap-y-1 sm:grid-cols-3">
        <span>当前值：{valuationNumber(current)}</span>
        <span>同行样本：{typeof peerCount === "number" ? `${peerCount} 家` : "未提供"}</span>
        <span>同行中位数：{valuationNumber(median)}</span>
      </div>
      <div className="mt-1">
        同行分位：{peerComparable ? valuationPercentile(percentile) : "未提供"}
        {peerComparable ? "（数值越高表示相对同行估值越高）" : "；同行比较待确认，暂不能判断相对高低"}
      </div>
    </div>
  );
}

export function ValuationAnalysis({ section }: { section: StockSummarySection }) {
  const metrics: StockValuationMetrics | null | undefined = section.valuation_metrics;
  if (!metrics) {
    const missing = section.missing_fields.length > 0
      ? section.missing_fields.map(valuationMissingLabel).join("、")
      : "当前估值和同行比较数据均未提供";
    return (
      <div className="mt-2 rounded border border-dashed px-2 py-1.5 text-micro text-muted-foreground" data-testid="research-valuation-analysis">
        估值暂不判断：{missing}
      </div>
    );
  }

  const comparisonComplete = metrics.peer_comparison_status === "complete";
  const missingReasons = metrics.missing_reasons ?? [];
  const asOf = metrics.comparison_as_of || section.market_as_of || section.research_cutoff_at;
  return (
    <div className="mt-2 rounded border bg-background/40 p-2 text-micro" data-testid="research-valuation-analysis">
      <div className="font-medium">估值分析</div>
      <div className="mt-1 text-muted-foreground">
        比较方法：{valuationMethodLabel(metrics.comparison_method)} · 数据时点：{formatEvidenceTime(asOf)}
      </div>
      {metrics.comparison_basis ? (
        <div className="mt-1 text-muted-foreground">比较口径：{evidenceTextLabel(metrics.comparison_basis)}</div>
      ) : null}
      <div className="mt-2 space-y-1.5">
        <ValuationMetricRow
          label="市盈率（PE）"
          current={metrics.current_pe}
          peerCount={metrics.pe_peer_count}
          median={metrics.pe_median}
          percentile={metrics.pe_percentile}
        />
        <ValuationMetricRow
          label="市净率（PB）"
          current={metrics.current_pb}
          peerCount={metrics.pb_peer_count}
          median={metrics.pb_median}
          percentile={metrics.pb_percentile}
        />
      </div>
      {!comparisonComplete ? (
        <div className="mt-2 text-muted-foreground">同行比较待确认，暂不能判断相对高低</div>
      ) : null}
      {missingReasons.length > 0 ? (
        <div className="mt-1 text-muted-foreground">缺少信息：{missingReasons.join("；")}</div>
      ) : null}
    </div>
  );
}

function HorizonTradeability({
  horizon,
  view,
  sources,
}: {
  horizon: string;
  view: StockHorizonView;
  sources: Map<string, StockRawReportSource>;
}) {
  return (
    <div className="rounded-md border bg-muted/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">
          {timeHorizonLabel(horizon)}可交易性
        </span>
        <Badge variant="outline">{researchStatusLabel(view.status)}</Badge>
      </div>
      <ClaimList
        label="交易风险"
        points={view.tradeability_risks}
        sources={sources}
      />
      <ClaimList label="盲区" points={view.blind_spots} sources={sources} />
      <MissingFields fields={view.missing_fields} />
    </div>
  );
}

function EventCalendarEvidence({
  calendar,
  sources,
}: {
  calendar: StockEventCalendar | null | undefined;
  sources: Map<string, StockRawReportSource>;
}) {
  if (!calendar) {
    return <MissingState testId="research-event-calendar-missing" text="本报告未提供可信事件日历" />;
  }
  const events = calendar.events ?? [];
  return (
    <div data-testid="research-event-calendar">
      <div className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground">
        <span>状态：{researchStatusLabel(calendar.status)}</span>
        <span>事件数：{events.length}</span>
      </div>
      {events.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {events.map((event, index) => (
            <EventCalendarItemView key={`${event.event_date ?? "undated"}-${event.title ?? event.event_type ?? index}`} event={event} sources={sources} />
          ))}
        </div>
      ) : (
        <MissingState text="事件日历没有可展示记录" />
      )}
      {calendar.missing_fields && calendar.missing_fields.length > 0 ? (
        <MissingFields fields={calendar.missing_fields} />
      ) : null}
      {calendar.source_ids && calendar.source_ids.length > 0 ? (
        <SourceIds ids={calendar.source_ids} sources={sources} />
      ) : null}
    </div>
  );
}

function EventCalendarItemView({
  event,
  sources,
}: {
  event: StockEventCalendarItem;
  sources: Map<string, StockRawReportSource>;
}) {
  const title = evidenceTextLabel(event.title?.trim() || event.summary?.trim() || eventTypeLabel(event.event_type));
  return (
    <article className="rounded-md border bg-muted/10 px-2 py-1.5 text-caption" data-testid="research-event-calendar-item">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{title}</span>
        {event.status ? <Badge variant="outline">{researchStatusLabel(event.status)}</Badge> : null}
      </div>
      <div className="mt-1 text-micro text-muted-foreground">
        事件日期：{event.event_date ? formatEvidenceTime(event.event_date) : "未提供（不可用于未来事件判断）"}
        {event.published_at ? ` · 发布：${formatEvidenceTime(event.published_at)}` : ""}
      </div>
      {event.summary && event.title ? <div className="mt-1 text-micro text-muted-foreground">摘要：{evidenceTextLabel(event.summary)}</div> : null}
      <SourceIds ids={event.source_ids ?? []} sources={sources} />
    </article>
  );
}

function CycleBlock({
  label,
  state,
  sources,
}: {
  label: string;
  state: StockCycleState | undefined;
  sources: Map<string, StockRawReportSource>;
}) {
  if (!state) return <MissingState text={`${label}周期字段未提供`} />;
  return (
    <article className="rounded-md border bg-muted/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">{label}</span>
        <Badge variant="outline">{researchStatusLabel(state.status)}</Badge>
      </div>
      <p className="mt-1 text-caption">阶段：{safeUserValue(state.stage, "阶段待确认")}</p>
      <p className="text-micro text-muted-foreground">
        观察窗口：{periodLabel(state.observation_window)} · 证据可信度：{researchEvidenceStrengthLabel(state.evidence_strength)}
      </p>
      <ClaimList
        label="领先指标"
        points={state.leading_indicators}
        sources={sources}
      />
      <ClaimList
        label="确认指标"
        points={state.confirmation_indicators}
        sources={sources}
      />
      <ConditionList label="转折条件" conditions={state.turning_conditions} sources={sources} />
      <MissingFields fields={state.missing_fields} />
    </article>
  );
}

function ClaimList({
  label,
  points,
  sources,
  showSources = true,
}: {
  label: string;
  points: StockViewPoint[];
  sources: Map<string, StockRawReportSource>;
  showSources?: boolean;
}) {
  return (
    <div className="mt-2">
      <div className="text-micro font-medium text-muted-foreground">{label}</div>
      {points.length > 0 ? (
        <div className="mt-1 space-y-1.5">
          {points.map((point, index) => (
            <div
              key={`${point.claim}-${index}`}
              className="rounded border bg-background/60 px-2 py-1.5 text-caption"
              data-testid="research-claim"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="px-1.5 py-0 text-micro">
                  {claimTypeLabel(point.claim_type)}
                </Badge>
                <span className="break-words">{evidenceTextLabel(point.claim) || "未提供"}</span>
              </div>
              {point.basis ? (
                <div className="mt-1 text-micro text-muted-foreground">依据：{evidenceTextLabel(point.basis)}</div>
              ) : null}
              {point.evidence ? (
                <div className="mt-1 text-micro text-muted-foreground">证据：{evidenceTextLabel(point.evidence)}</div>
              ) : null}
              {showSources && <SourceIds ids={point.source_ids} sources={sources} />}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-micro text-muted-foreground">未提供</div>
      )}
    </div>
  );
}

function ConditionList({
  label,
  conditions,
  sources,
  showSources = true,
}: {
  label: string;
  conditions: StockHorizonCondition[];
  sources: Map<string, StockRawReportSource>;
  showSources?: boolean;
}) {
  return (
    <div className="mt-2">
      <div className="text-micro font-medium text-muted-foreground">{label}</div>
      {conditions.length > 0 ? (
        <div className="mt-1 space-y-1">
          {conditions.map((condition, index) => (
            <div key={`${condition.text}-${index}`} className="rounded border px-2 py-1 text-micro">
              <Badge variant="outline" className="mr-1 px-1.5 py-0 text-micro">
                {condition.kind === "trigger" ? "系统可计算" : "人工观察"}
              </Badge>
              <span>{evidenceTextLabel(condition.text) || "未提供"}</span>
              {condition.kind === "trigger" ? (
                <div className="mt-1 text-muted-foreground">
                  观测指标：{metricLabel(condition.observed_metric_ref)} · 比较方式：{conditionOperatorLabel(condition.operator)} · 阈值指标：
                  {metricLabel(condition.threshold_metric_ref)}
                </div>
              ) : null}
              {showSources && <SourceIds ids={condition.source_ids} sources={sources} />}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-micro text-muted-foreground">未提供</div>
      )}
    </div>
  );
}

function SourceIds({
  ids,
  sources,
}: {
  ids: string[];
  sources: Map<string, StockRawReportSource>;
}) {
  return (
    <div className="mt-1 text-micro text-muted-foreground">
      证据来源：{ids.length > 0 ? `${ids.length} 条` : "未提供"}
      {ids.length > 0 ? (
        <details className="mt-1 rounded border bg-background/40 px-2 py-1" data-testid="research-technical-trace">
          <summary className="cursor-pointer">技术追溯信息</summary>
          <div className="mt-1 space-y-1">
            {ids.map((id) => {
              const source = sources.get(id);
              return source ? (
                <SourceInline key={id} source={source} />
              ) : (
                <div key={id}>来源编号：{id}；来源明细未提供</div>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SourceInline({ source }: { source: StockRawReportSource }) {
  if (source.url.startsWith("materials://") || source.material_id) {
    return <LocalMaterialSource source={source} />;
  }
  const url = safeExternalUrl(source.url);
  return (
    <div className="rounded border bg-background/50 px-2 py-1">
      <div>
        <span className="font-medium">来源编号：{source.id}</span> · 数据提供方：{providerLabel(source.provider)}
      </div>
      <div>
        来源公开时间：{formatEvidenceTime(source.published_at)} · 数据统计期末：
        {formatEvidenceTime(source.period_end)} · 采集时间：{formatEvidenceTime(source.fetched_at)}
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-info underline underline-offset-2"
        >
          打开来源
        </a>
      ) : (
        <span>来源链接不可安全打开</span>
      )}
    </div>
  );
}

function LocalMaterialSource({ source }: { source: StockRawReportSource }) {
  const [preview, setPreview] = useState<{ page: number; text: string; materialName: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = typeof source.page === "number" && Number.isInteger(source.page) && source.page > 0
    ? source.page
    : null;
  const materialName = materialDisplayName(source.material_name);

  const openPage = async () => {
    if (!source.material_id || page === null) {
      setError("财报页码或资料信息未提供，暂时无法打开原文");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStockMaterialPage(source.material_id, page);
      setPreview({ page: result.page || page, text: result.text, materialName: materialDisplayName(result.material_name || materialName) });
    } catch {
      setError("财报原文读取失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded border bg-background/50 px-2 py-1" data-testid="research-material-source">
      <div className="font-medium">财报名称：{materialName}</div>
      <div>
        报告期：{formatEvidenceTime(source.period_end)} · 首次公开时间：{formatEvidenceTime(source.published_at)} · 页码：
        {page === null ? "未提供" : `第 ${page} 页`}
      </div>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0 py-0 text-micro"
        disabled={loading || !source.material_id || page === null}
        onClick={() => void openPage()}
      >
        {loading ? "正在读取财报原文…" : page === null ? "财报页码未提供" : `查看财报第 ${page} 页`}
      </Button>
      {error ? <div className="mt-1 text-destructive">{error}</div> : null}
      {preview ? (
        <div className="mt-2 rounded border bg-background px-2 py-1.5" data-testid="research-material-page-preview">
          <div className="font-medium">{preview.materialName || materialName} · 第 {preview.page} 页</div>
          <p className="mt-1 whitespace-pre-wrap">{preview.text || "本页没有可显示的提取文本"}</p>
        </div>
      ) : null}
    </div>
  );
}

function SourceCard({ source }: { source: StockRawReportSource }) {
  return (
    <div className="rounded-md border bg-muted/10 px-2 py-1.5 text-micro">
      <div>证据来源：1 条</div>
      <details className="mt-1 rounded border bg-background/40 px-2 py-1">
        <summary className="cursor-pointer">技术追溯信息</summary>
        <div className="mt-1">
          <SourceInline source={source} />
        </div>
      </details>
    </div>
  );
}

function MissingFields({ fields }: { fields: string[] }) {
  if (fields.length === 0) return null;
  return <MissingState text={`缺少信息：${fields.map(fieldLabel).join("、")}`} />;
}

function MissingState({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="mt-2 rounded border border-dashed px-2 py-1.5 text-micro text-muted-foreground" data-testid={testId}>
      {text}
    </div>
  );
}

function DebateResolutionCard({
  id,
  label,
  resolution,
  sources,
  compact,
  testIdPrefix,
}: {
  id: string;
  label: string;
  resolution: StockDebateResolution;
  sources: Map<string, StockRawReportSource>;
  compact: boolean;
  testIdPrefix: string;
}) {
  const limit = compact ? 2 : undefined;
  const slice = <T,>(values: T[]) => (limit == null ? values : values.slice(0, limit));
  const omitted = (values: unknown[]) => compact && values.length > 2 ? `（另有 ${values.length - 2} 项见证据明细）` : "";
  return (
    <article className="rounded-md border bg-muted/10 p-2" data-testid={`${testIdPrefix}-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption font-medium">{label}</span>
        <Badge variant="outline">{researchStatusLabel(resolution.status)}</Badge>
      </div>
      <div className="mt-1 text-caption"><span className="text-muted-foreground">争议问题：</span>{evidenceTextLabel(resolution.issue) || "未提供"}</div>
      <ClaimList label={`多方依据${omitted(resolution.bull_case)}`} points={slice(resolution.bull_case)} sources={sources} showSources={!compact} />
      <ClaimList label={`空方依据${omitted(resolution.bear_case)}`} points={slice(resolution.bear_case)} sources={sources} showSources={!compact} />
      <ClaimList label={`最终研判${omitted(resolution.verdict)}`} points={slice(resolution.verdict)} sources={sources} showSources={!compact} />
      <ConditionList label="改变判断的条件" conditions={slice(resolution.change_conditions)} sources={sources} showSources={!compact} />
      <MissingFields fields={resolution.missing_fields} />
      {!compact && <SourceIds ids={resolution.source_ids} sources={sources} />}
    </article>
  );
}

/** Render the structured V4 debate ruling. Artifact references are deliberately
 * kept outside this panel so they cannot be mistaken for the ruling itself. */
export function DebateResolutionPanel({
  report,
  compact = false,
}: {
  report: StockReportV4Document;
  compact?: boolean;
}) {
  const resolutions = report.debate_resolution;
  const sources = new Map(report.sources.map((source) => [source.id, source]));
  return (
    <div data-testid={compact ? "research-debate-resolution-compact" : "research-debate-resolution"}>
      {resolutions ? (
        <div className="grid gap-2 lg:grid-cols-3">
          {DEBATE_HORIZONS.map(({ key, label }) => (
            <DebateResolutionCard
              key={key}
              id={key}
              label={label}
              resolution={resolutions[key]}
              sources={sources}
              compact={compact}
              testIdPrefix={compact ? "research-decision-debate" : "research-debate"}
            />
          ))}
        </div>
      ) : (
        <MissingState testId="research-debate-resolution-missing" text="本报告未提供按周期拆分的结构化多空裁决；上游多空产物仅可追溯，不能替代结论。" />
      )}
    </div>
  );
}

function ArtifactRefs({
  label,
  refs,
  emptyText = "未提供",
}: {
  label: string;
  refs: Record<string, string | undefined>;
  emptyText?: string;
}) {
  const entries = Object.entries(refs).filter(([, ref]) => Boolean(ref));
  return (
    <div className="mt-2 text-micro text-muted-foreground">
      <div className="font-medium">{label}</div>
      {entries.length > 0 ? (
        <details className="mt-1 rounded border bg-background/40 px-2 py-1">
          <summary className="cursor-pointer">技术追溯信息（{entries.length} 项）</summary>
          <div className="mt-1 space-y-1">
            {entries.map(([key, ref]) => (
              <div key={key} className="break-all">
                {CLAIM_GROUP_LABELS[key] ?? "分析产物"}：{ref}
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div className="mt-1">{emptyText}</div>
      )}
    </div>
  );
}
