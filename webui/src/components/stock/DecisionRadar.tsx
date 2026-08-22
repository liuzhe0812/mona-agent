import { Clock3, Loader2, Play, Square } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  type StockConditionOperator,
  type StockHorizonCondition,
  type StockHorizonStances,
  type StockNewsItem,
  type StockReportDocument,
  type StockReportV4Document,
  type StockStance,
  isStockViewPoint,
  stockClaimText,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";

export type DecisionRadarTab = "market" | "fundamentals" | "news" | "report";

export interface DecisionRadarProps {
  starting: boolean;
  runActive: boolean;
  runFailed: boolean;
  runSettled: number;
  runningStepLabel?: string;
  report: StockReportDocument | null;
  reportStance: StockStance | null | undefined;
  reportDataQuality: string | null | undefined;
  comparison: string;
  horizonComparison?: HorizonComparison;
  technical: {
    trend: string;
    support: number | null;
    resistance: number | null;
    ma5?: number | null;
    ma10?: number | null;
    ma20?: number | null;
  };
  quote: { price: number | null; changePct: number | null; updatedAt: string | null };
  latestNews: StockNewsItem | null;
  fundamentalsPeriod: string | null;
  sourceCount: number;
  onStartRun: () => void;
  onCancelRun: () => void;
  cancellingRun: boolean;
  onNavigate: (tab: DecisionRadarTab) => void;
}

/** Keep this threshold explicit until the product has a shared freshness policy. */
export const DECISION_RADAR_STALE_MS = 24 * 60 * 60 * 1000;

type HorizonKey = "short_term" | "medium_term" | "long_term";
type HorizonStanceKey = "shortTerm" | "mediumTerm" | "longTerm";

export interface HorizonComparison {
  current: StockHorizonStances | null;
  previous: StockHorizonStances | null;
  hasCurrentReport: boolean;
  hasPreviousReport: boolean;
}

const HORIZONS: Array<{ key: HorizonKey; label: string }> = [
  { key: "short_term", label: "短线" },
  { key: "medium_term", label: "中线" },
  { key: "long_term", label: "长线" },
];

const HORIZON_STANCE_ITEMS: Array<{ key: HorizonStanceKey; id: HorizonKey; label: string }> = [
  { key: "shortTerm", id: "short_term", label: "短线" },
  { key: "mediumTerm", id: "medium_term", label: "中线" },
  { key: "longTerm", id: "long_term", label: "长线" },
];

function isV4Report(report: StockReportDocument | null): report is StockReportV4Document {
  return Boolean(report && report.schema_version === 4 && "horizon_views" in report);
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return isStockViewPoint(value) ? stockClaimText(value).trim() : "";
}

// Keep the existing user-facing cleaning for persisted condition text. The
// radar never evaluates or invents numeric thresholds on the client.
const RADAR_FIELD_LABELS: Record<string, string> = {
  industry_context: "行业数据",
  peer_valuation: "同行估值数据",
  operating_cashflow: "经营现金流",
  "indicators.swing.support": "20日支撑位",
  "indicators.swing.resistance": "20日压力位",
  "indicators.ma5": "5日均线",
  "indicators.ma10": "10日均线",
  "indicators.ma20": "20日均线",
};

const RADAR_FIELD_PATTERN = /\b(industry_context|peer_valuation|operating_cashflow|indicators\.swing\.support|indicators\.swing\.resistance|indicators\.ma5|indicators\.ma10|indicators\.ma20)\b/g;
const RADAR_QUARTER_LABELS = ["", "一", "二", "三", "四"];

function radarTextLabel(value: string): string {
  return value
    .replace(RADAR_FIELD_PATTERN, (token) => RADAR_FIELD_LABELS[token] ?? token)
    .replace(/\b(20\d{2})\s*Q([1-4])\b/gi, (_match, year: string, quarter: string) => `${year}年${RADAR_QUARTER_LABELS[Number(quarter)]}季度`)
    .replace(/\b(20\d{2})\s*H([12])\b/gi, (_match, year: string, half: string) => `${year}年${half === "1" ? "上半年" : "下半年"}`)
    .replace(/\bQ([1-4])\b/gi, (_match, quarter: string) => `${RADAR_QUARTER_LABELS[Number(quarter)]}季度`)
    .replace(/\bH([12])\b/gi, (_match, half: string) => half === "1" ? "上半年" : "下半年")
    .replace(/\bswing-high-low-v1\b/gi, "波段高低点规则")
    .replace(/\b(\d+)\s*日\s*swing\s*(阻力|支撑)(?:位)?\s*\/\s*(阻力|支撑)(?:位)?/gi, (_match, days: string, first: string, second: string) => `${days}日${first === "阻力" ? "压力位" : "支撑位"}/${second === "阻力" ? "压力位" : "支撑位"}`)
    .replace(/\b(\d+)\s*日\s*swing\s*(阻力|支撑)(?:位)?/gi, (_match, days: string, side: string) => `${days}日${side === "阻力" ? "压力位" : "支撑位"}`)
    .replace(/\bswing\s*(阻力|支撑)(?:位)?/gi, (_match, side: string) => side === "阻力" ? "压力位" : "支撑位")
    .replace(/\bswing\b/gi, "波段")
    .replace(/\bMA\s*(\d+)\b/gi, (_match, days: string) => `${days}日均线`)
    .replace(/\bOCF\b/gi, "经营现金流");
}

function conditionTextLabel(value: string, operator: StockConditionOperator | null | undefined): string {
  const text = radarTextLabel(value);
  if (operator === "crosses_above") return text.replace(/上穿|突破/g, "高于");
  if (operator === "crosses_below") return text.replace(/跌破|下穿/g, "低于");
  return text;
}

function directionLabel(stance: StockStance, status: string): string {
  if (status === "insufficient_data" || stance === "insufficient_data") return "数据不足";
  if (stance === "positive") return "看涨";
  if (stance === "negative") return "看跌";
  return "中性";
}

function actionLabel(action: string): string {
  switch (action) {
    case "conditional_participation": return "满足条件再参与";
    case "wait_for_confirmation": return "等待确认";
    case "reduce_exposure": return "减仓或回避";
    case "observe": return "继续观察";
    default: return "继续观察";
  }
}

function isReportStale(report: StockReportDocument): boolean {
  const values = isV4Report(report)
    ? [report.research_cutoff_at, report.market_as_of]
    : [report.as_of];
  const timestamps = values
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .map((value) => Date.parse(value));
  return timestamps.length === 0 || timestamps.some((value) => Date.now() - value > DECISION_RADAR_STALE_MS);
}

function horizonStanceText(value: StockHorizonStances[HorizonStanceKey]): string {
  if (value.status === "insufficient_data" || value.stance === "insufficient_data") return "数据不足";
  if (value.stance === "positive") return "看涨";
  if (value.stance === "negative") return "看跌";
  return "中性";
}

function changedHorizonStances(comparison: HorizonComparison) {
  if (!comparison.current || !comparison.previous) return [];
  return HORIZON_STANCE_ITEMS.filter(({ key }) => {
    const current = comparison.current?.[key];
    const previous = comparison.previous?.[key];
    return current && previous && (current.stance !== previous.stance || current.status !== previous.status);
  });
}

/** Kept for the central stage's historical comparison summary. */
export function summarizeHorizonComparison(
  current: StockHorizonStances,
  previous: StockHorizonStances,
): string {
  const changed = changedHorizonStances({
    current,
    previous,
    hasCurrentReport: true,
    hasPreviousReport: true,
  });
  return changed.length === 0
    ? "观点不变"
    : changed.map(({ key, label }) => `${label}${horizonStanceText(previous[key])} → ${horizonStanceText(current[key])}`).join("；");
}

function DecisionList({
  title,
  conditions,
}: {
  title: string;
  conditions: StockHorizonCondition[];
}) {
  const visible = (Array.isArray(conditions) ? conditions : [])
    .map((condition) => conditionTextLabel(textValue(condition?.text), condition?.operator))
    .filter(Boolean)
    .slice(0, 2);
  return (
    <div className="border-t border-border/60 py-2.5">
      <div className="text-micro font-medium text-muted-foreground">{title}</div>
      {visible.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-caption">
          {visible.map((text, index) => <li key={`${title}-${index}`} className="line-clamp-2">{text}</li>)}
        </ul>
      ) : (
        <p className="mt-1 text-micro text-muted-foreground">未提供</p>
      )}
    </div>
  );
}

function CycleDecision({ report, horizon }: { report: StockReportV4Document; horizon: HorizonKey }) {
  const view = report.horizon_views[horizon];
  const entryConditions = [
    ...(Array.isArray(view?.participation_conditions) ? view.participation_conditions : []),
    ...(Array.isArray(view?.confirmation_conditions) ? view.confirmation_conditions : []),
  ].slice(0, 2);
  return (
    <section className="pt-3" data-testid="decision-radar-cycle-output">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-b border-border/60 pb-3 text-caption">
        <div>
          <div className="text-micro text-muted-foreground">方向</div>
          <div className="mt-0.5 font-medium">{directionLabel(view.stance, view.status)}</div>
        </div>
        <div>
          <div className="text-micro text-muted-foreground">当前操作</div>
          <div className="mt-0.5 font-medium">{actionLabel(view.action)}</div>
        </div>
      </div>
      <DecisionList title="参与或买入条件" conditions={entryConditions} />
      <DecisionList title="退出或减仓条件" conditions={view.invalidation_conditions ?? []} />
      <div className="border-t border-border/60 py-2.5">
        <div className="text-micro font-medium text-muted-foreground">时间边界</div>
        <p className="mt-1 line-clamp-2 text-caption">{textValue(view.time_stop) || "未提供"}</p>
      </div>
    </section>
  );
}

export function DecisionRadar({
  starting,
  runActive,
  report,
  onStartRun,
  onCancelRun,
  cancellingRun,
}: DecisionRadarProps) {
  const v4 = isV4Report(report);
  const [activeHorizon, setActiveHorizon] = useState<HorizonKey>("medium_term");
  const launchLabel = report ? "重新投研" : "启动深度投研";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-testid="decision-radar">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <h2 className="min-w-0 truncate text-ui font-semibold">关注雷达</h2>
        {starting ? (
          <Button type="button" variant="outline" size="sm" disabled aria-label="正在准备投研"><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />准备中</Button>
        ) : runActive ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancelRun} disabled={cancellingRun}>
            <Square className="mr-1.5 h-3.5 w-3.5" aria-hidden />{cancellingRun ? "取消中" : "取消投研"}
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={onStartRun}><Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />{launchLabel}</Button>
        )}
      </header>

      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {!v4 ? (
          <div className="flex min-h-48 flex-col items-center justify-center text-center">
            <p className="text-caption font-medium">尚无投研结论</p>
          </div>
        ) : (
          <>
            <div className="flex border-b border-border/60" role="tablist" aria-label="研究周期">
              {HORIZONS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={activeHorizon === key}
                  className={cn("flex-1 border-b-2 px-2 py-2 text-caption", activeHorizon === key ? "border-info font-medium text-foreground" : "border-transparent text-muted-foreground")}
                  onClick={() => setActiveHorizon(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <CycleDecision report={report} horizon={activeHorizon} />
            {isReportStale(report) && (
              <div className="mt-2 flex items-start gap-1.5 border-t border-warning/40 pt-2 text-micro text-warning" data-testid="decision-radar-freshness">
                <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>报告已超过时效窗口，建议重新投研</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
