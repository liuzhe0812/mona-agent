import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  FileText,
  Loader2,
  Newspaper,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusNotice } from "@/components/ui/status-notice";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  STOCK_DIAGNOSIS_ROOM_CHAT_ID,
  STOCK_ROOM_CHAT_ID,
  fetchStockIntraday,
  openStockIntradayStream,
  type StockDashboardItem,
  type StockIntradayPoint,
  type StockIntradaySeries,
  type StockIntradayStatusEvent,
  type StockKlineBar,
  type StockKlineIndicators,
  type StockKlineResponse,
  type StockQuote,
  type StockResearchContext,
  type StockReportDetail,
  type StockReportListItem,
  type StockReportV5ListProjection,
  type StockReportV6ListProjection,
  type StockDiagnosisRun,
  type StockDiagnosisV1,
  type StockHorizonStances,
  type StockDecisionEvaluation,
} from "@/lib/stock-api";
import type { ToolProgressEvent, WorkflowRun } from "@/lib/types";
import { isTauri, openExternalUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  DEFAULT_KLINE_VIEW_BARS,
  KLINE_PAD_LEFT,
  KLINE_PAD_RIGHT,
  KlineChart,
  type KlineView,
} from "./KlineChart";
import { IntradayChart, type IntradayChartState } from "./IntradayChart";
import { StepTimeline } from "./StepTimeline";
import { DecisionRadar, summarizeHorizonComparison, type HorizonComparison } from "./DecisionRadar";
import { ResearchDecisionView } from "./ResearchDecisionView";
import { ExpertPanel } from "./ExpertPanel";
import { dataQualityLabel, evidenceTextLabel, periodLabel, stanceLabel } from "./labels";

/** 标的工作台：中央行情/研究区 + 右侧决策上下文。 */

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"]);
export const DECISION_SUMMARY_PANEL_ID = "stock-decision-summary-panel";
const INTRADAY_SSE_GRACE_MS = 3_000;

export type KlineState = "idle" | "loading" | "ok" | "error";
export type IntradayState = IntradayChartState;

/** K线周期（专业软件口径）：日线 / 周线 / 月线。 */
export const KLINE_PERIODS = [
  { key: "daily", label: "日线", klt: 101 },
  { key: "weekly", label: "周线", klt: 102 },
  { key: "monthly", label: "月线", klt: 103 },
] as const;

/** 单次拉取根数（API 上限 250）：默认视口 120 根，滚轮缩放/拖动有余量。 */
export const STOCK_KLINE_FETCH_BARS = 250;

export type KlinePeriodKey = (typeof KLINE_PERIODS)[number]["key"];

function formatPrice(v: number | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 成交量副图：柱高按最大量归一，涨跌色跟随当根蜡烛。
 *  坐标系与主图共享（KLINE_PAD_*）：柱位与蜡烛一一对齐；
 *  hoverIdx 跟随主图十字光标联动显示读数。 */
function VolumeChart({
  bars,
  hoverIdx,
  className,
}: {
  bars: StockKlineBar[];
  /** 主图悬停 bar 的可见区下标；null 显示最后一根。 */
  hoverIdx: number | null;
  className?: string;
}) {
  const W = 600;
  const H = 56;
  if (bars.length === 0) return null;
  const maxVol = Math.max(...bars.map((b) => b.volume), 1);
  const innerW = W - KLINE_PAD_LEFT - KLINE_PAD_RIGHT;
  const slot = innerW / bars.length;
  const barW = Math.max(1, slot * 0.6);
  const x = (i: number) => KLINE_PAD_LEFT + slot * i + slot / 2;
  const focusIdx = hoverIdx != null ? Math.max(0, Math.min(bars.length - 1, hoverIdx)) : bars.length - 1;
  const focusBar = bars[focusIdx];
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      role="img"
      aria-label="成交量"
    >
      <text
        x={KLINE_PAD_LEFT}
        y={10}
        fill="hsl(var(--muted-foreground))"
        fontSize={9}
        data-testid="volume-readout"
      >
        {`成交量 ${formatVolume(focusBar.volume)}`}
      </text>
      {bars.map((b, i) => {
        const up = b.close >= b.open;
        const h = Math.max(1, (b.volume / maxVol) * (H - 16));
        return (
          <rect
            key={b.date || i}
            x={x(i) - barW / 2}
            y={H - h}
            width={barW}
            height={h}
            className={up ? "fill-stock-up" : "fill-stock-down"}
            opacity={i === focusIdx ? 1 : 0.55}
          />
        );
      })}
    </svg>
  );
}

/** 成交量（手）读数：大数转万/亿，看盘软件习惯。 */
function formatVolume(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿手`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(2)}万手`;
  return `${v.toLocaleString("zh-CN")}手`;
}

/** MACD 副图：DIF/DEA 双线 + 红柱绿柱（hist）。 */
function MacdChart({
  macd,
  className,
}: {
  macd: NonNullable<StockKlineIndicators["macd"]>;
  className?: string;
}) {
  const W = 600;
  const H = 56;
  const geometry = useMemo(() => {
    const all = [...macd.dif, ...macd.dea, ...macd.hist].filter(
      (v): v is number => v != null,
    );
    if (all.length === 0) return null;
    const max = Math.max(...all);
    const min = Math.min(...all);
    const span = max - min || 1;
    const y = (v: number) => 3 + (H - 6) * (1 - (v - min) / span);
    const zeroY = y(Math.max(Math.min(0, max), min));
    // 坐标系与主图共享：柱位与蜡烛一一对齐。
    const slot = (W - KLINE_PAD_LEFT - KLINE_PAD_RIGHT) / macd.dif.length;
    const x = (i: number) => KLINE_PAD_LEFT + slot * i + slot / 2;
    const line = (vals: (number | null)[]) =>
      vals
        .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
        .filter((p): p is string => p !== null)
        .join(" ");
    return { y, zeroY, slot, x, dif: line(macd.dif), dea: line(macd.dea) };
  }, [macd]);

  if (!geometry) return null;
  const { zeroY, slot, x, y, dif, dea } = geometry;
  const barW = Math.max(1, slot * 0.5);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      role="img"
      aria-label="MACD 指标"
    >
      {macd.hist.map((v, i) =>
        v == null ? null : (
          <rect
            key={i}
            x={x(i) - barW / 2}
            y={Math.min(y(v), zeroY)}
            width={barW}
            height={Math.max(1, Math.abs(y(v) - zeroY))}
            className={v >= 0 ? "fill-stock-up" : "fill-stock-down"}
            opacity={0.6}
          />
        ),
      )}
      {dif && (
        <polyline points={dif} fill="none" stroke="hsl(var(--info))" strokeWidth={1.1} />
      )}
      {dea && (
        <polyline
          points={dea}
          fill="none"
          stroke="hsl(var(--warning))"
          strokeWidth={1.1}
        />
      )}
    </svg>
  );
}

interface InstrumentStageProps {
  token: string;
  item: StockDashboardItem;
  quote: StockQuote | undefined;
  kline: StockKlineResponse | null;
  klineState: KlineState;
  period: KlinePeriodKey;
  onPeriodChange: (period: KlinePeriodKey) => void;
  onRetryKline: () => void;
  run: WorkflowRun | null;
  stepActivities: Record<string, ToolProgressEvent[]>;
  starting: boolean;
  cancellingRun: boolean;
  onStartRun: () => void;
  onCancelRun: () => void;
  reports: StockReportListItem[];
  reportDetail: StockReportDetail | null;
  researchContext: StockResearchContext | null;
  onOpenReport: (reportId: string) => void;
  onDeleteReport: (reportId: string) => void;
  /** Standard AI diagnosis state is deliberately independent from the deep run. */
  diagnosisRun?: WorkflowRun | null;
  diagnosisReport?: StockDiagnosisV1 | null;
  diagnosisReports?: StockDiagnosisRun[];
  diagnosisStarting?: boolean;
  diagnosisCancellingRun?: boolean;
  onStartDiagnosis?: () => void;
  onCancelDiagnosis?: () => void;
  onOpenDiagnosis?: (diagnosisId: string) => void;
  decisionEvaluation?: StockDecisionEvaluation | null;
  /** 决策雷达面板开关：由顶栏按钮控制（StockView 持有状态），收起时不渲染右列。 */
  decisionSummaryOpen?: boolean;
  /** 自选列表跳转时指定初始页签。 */
  initialTab?: StageTab;
}

type StageTab = "market" | "fundamentals" | "news" | "diagnosis" | "expert";
type MarketView = "intraday" | "kline";

export function isCurrentIntradayEvent(
  eventGeneration: number,
  currentGeneration: number,
  expectedInstrumentId: string,
  eventInstrumentId: string,
): boolean {
  return eventGeneration === currentGeneration && expectedInstrumentId === eventInstrumentId;
}

function lastNumber(values: (number | null)[] | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] != null) return values[i];
  }
  return null;
}

function formatLevel(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(2);
}

function shortDate(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "—";
}

function visibleStanceLabel(value: string | null | undefined): string {
  if (value === "positive" || value === "neutral" || value === "negative" || value === "insufficient_data") {
    return stanceLabel(value);
  }
  return "观点待确认";
}

function visibleDataQualityLabel(value: string | null | undefined): string {
  if (value === "complete" || value === "degraded") return dataQualityLabel(value);
  return value == null ? "数据质量待确认" : "数据质量待确认";
}

export function horizonBrief(value: StockHorizonStances | undefined): string | null {
  if (!value) return null;
  const labels = [
    visibleStanceLabel(value.shortTerm.stance),
    visibleStanceLabel(value.mediumTerm.stance),
    visibleStanceLabel(value.longTerm.stance),
  ];
  return value.shortTerm.stance === value.mediumTerm.stance && value.mediumTerm.stance === value.longTerm.stance
    ? `三周期均${labels[0]}`
    : `短${labels[0]} · 中${labels[1]} · 长${labels[2]}`;
}

function v5HorizonBrief(value: StockReportV5ListProjection["horizonDecisions"] | StockReportV6ListProjection["horizonDecisions"] | undefined): string | null {
  if (!value) return null;
  const label = (direction: string) => direction === "positive" ? "看涨" : direction === "negative" ? "看跌" : "中性";
  return `短${label(value.shortTerm.direction)} · 中${label(value.mediumTerm.direction)} · 长${label(value.longTerm.direction)}`;
}

function reportHorizonStances(entry: StockReportListItem | null | undefined): StockHorizonStances | null {
  return entry && "horizonStances" in entry ? entry.horizonStances ?? null : null;
}

export function reportHorizonComparison(deepReports: StockReportListItem[]): HorizonComparison {
  const currentReport = deepReports[0] ?? null;
  const previousReport = deepReports[1] ?? null;
  return {
    current: reportHorizonStances(currentReport),
    previous: reportHorizonStances(previousReport),
    hasCurrentReport: currentReport != null,
    hasPreviousReport: previousReport != null,
  };
}

export function summarizeReportComparison(deepReports: StockReportListItem[]): string {
  const currentReport = deepReports[0] ?? null;
  const previousReport = deepReports[1] ?? null;
  if (!currentReport) return "暂无历史";
  if (!previousReport) return "首次结论";
  const currentHorizonStances = reportHorizonStances(currentReport);
  const previousHorizonStances = reportHorizonStances(previousReport);
  if (currentHorizonStances || previousHorizonStances) {
    return currentHorizonStances && previousHorizonStances
      ? summarizeHorizonComparison(currentHorizonStances, previousHorizonStances)
      : "周期结论不可比";
  }
  return previousReport.stance === currentReport.stance
    ? "观点不变"
    : `${visibleStanceLabel(previousReport.stance ?? "insufficient_data")} → ${visibleStanceLabel(currentReport.stance ?? "insufficient_data")}`;
}

function sourceLabel(provider: string | undefined): string {
  if (!provider) return "来源待确认";
  const key = provider.toLowerCase();
  if (key.includes("tencent")) return "腾讯行情";
  if (key.includes("eastmoney")) return "东方财富";
  return "来源待确认";
}

function userFacingError(message: string | null | undefined, fallback: string): string {
  const text = message?.trim();
  return text && !/[A-Za-z_]{2,}/.test(text) ? text : fallback;
}

export function InstrumentStage({
  token,
  item,
  quote,
  kline,
  klineState,
  period,
  onPeriodChange,
  onRetryKline,
  run,
  stepActivities,
  starting,
  cancellingRun,
  onStartRun,
  onCancelRun,
  reports,
  reportDetail,
  researchContext,
  onOpenReport,
  onDeleteReport,
  diagnosisRun = null,
  diagnosisReport = null,
  diagnosisReports = [],
  diagnosisStarting = false,
  diagnosisCancellingRun = false,
  onStartDiagnosis = () => undefined,
  onCancelDiagnosis = () => undefined,
  onOpenDiagnosis = () => undefined,
  decisionEvaluation = null,
  decisionSummaryOpen = true,
  initialTab = "market",
}: InstrumentStageProps) {
  const pct = quote?.changePct;
  const runSymbols = Array.isArray(run?.inputs?.symbols)
    ? run.inputs.symbols.filter((value): value is string => typeof value === "string")
    : [];
  const visibleRun = run?.roomId === STOCK_ROOM_CHAT_ID && runSymbols.includes(item.instrumentId)
    ? run
    : null;
  const runActive = visibleRun != null && ACTIVE_RUN_STATUSES.has(visibleRun.status);
  const diagnosisSymbols = Array.isArray(diagnosisRun?.inputs?.symbols)
    ? diagnosisRun.inputs.symbols.filter((value): value is string => typeof value === "string")
    : [];
  const visibleDiagnosisRun = diagnosisRun?.roomId === STOCK_DIAGNOSIS_ROOM_CHAT_ID && diagnosisSymbols.includes(item.instrumentId)
    ? diagnosisRun
    : null;
  const diagnosisRunActive = visibleDiagnosisRun != null && ACTIVE_RUN_STATUSES.has(visibleDiagnosisRun.status);
  const [showMacd, setShowMacd] = useState(true);
  const [activeTab, setActiveTab] = useState<StageTab>(initialTab);
  const [marketView, setMarketView] = useState<MarketView>("intraday");
  const [intraday, setIntraday] = useState<StockIntradaySeries | null>(null);
  const [intradayState, setIntradayState] = useState<IntradayState>("idle");
  const [intradayError, setIntradayError] = useState<string | null>(null);
  const [intradayDisconnected, setIntradayDisconnected] = useState(false);
  const intradayGeneration = useRef(0);
  const [confirmRerunOpen, setConfirmRerunOpen] = useState(false);
  const [deleteReportId, setDeleteReportId] = useState<string | null>(null);
  /** 主图十字光标悬停的可见区下标（副图联动读数/高亮）。 */
  const [hoverVisibleIdx, setHoverVisibleIdx] = useState<number | null>(null);
  // K线视口（缩放/拖动状态）：标的/周期切换或数据重取后回到最近 120 根。
  const [klineView, setKlineView] = useState<KlineView>({
    offset: 0,
    count: DEFAULT_KLINE_VIEW_BARS,
  });
  const totalBars = kline?.bars.length ?? 0;
  useEffect(() => {
    if (totalBars === 0) return;
    const count = Math.min(DEFAULT_KLINE_VIEW_BARS, totalBars);
    setKlineView({ offset: totalBars - count, count });
  }, [item.instrumentId, period, totalBars]);
  useEffect(() => {
    if (starting || runActive) setActiveTab("expert");
    if (diagnosisStarting || diagnosisRunActive) setActiveTab("diagnosis");
  }, [starting, runActive, diagnosisStarting, diagnosisRunActive]);
  useEffect(() => {
    setMarketView("intraday");
    setIntraday(null);
    setIntradayState("idle");
    setIntradayError(null);
    setIntradayDisconnected(false);
  }, [item.instrumentId]);

  const intradayActive = activeTab === "market" && marketView === "intraday";
  useEffect(() => {
    const generation = ++intradayGeneration.current;
    let disposed = false;
    let paused = document.hidden;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let sseGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let sseWarningVisible = false;
    let retryAttempt = 0;
    let stream: { close: () => void } | null = null;
    let requestAbort: AbortController | null = null;

    const current = () => !disposed && generation === intradayGeneration.current;
    const currentEvent = (instrumentId: string) => current() && isCurrentIntradayEvent(
      generation,
      intradayGeneration.current,
      item.instrumentId,
      instrumentId,
    );
    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const clearSseGrace = () => {
      if (sseGraceTimer !== null) {
        clearTimeout(sseGraceTimer);
        sseGraceTimer = null;
      }
    };
    const markSseRecovered = () => {
      clearSseGrace();
      clearRetry();
      retryAttempt = 0;
      sseWarningVisible = false;
      if (!current()) return;
      setIntradayDisconnected(false);
      setIntradayError((previous) =>
        previous === "分时连接已断开，正在重连" ? null : previous,
      );
    };
    const beginSseGrace = () => {
      if (!current() || paused || sseGraceTimer !== null || sseWarningVisible) return;
      sseGraceTimer = setTimeout(() => {
        sseGraceTimer = null;
        if (!current() || paused) return;
        sseWarningVisible = true;
        setIntradayState((previous) => (previous === "ready" ? previous : "error"));
        setIntradayDisconnected(true);
        setIntradayError("分时连接已断开，正在重连");
      }, INTRADAY_SSE_GRACE_MS);
    };
    const stop = () => {
      clearRetry();
      requestAbort?.abort();
      requestAbort = null;
      stream?.close();
      stream = null;
    };
    const schedule = () => {
      if (!current() || paused || retryTimer !== null) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt, 5));
      retryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void startRound();
      }, delay);
    };
    const applySnapshot = (next: StockIntradaySeries, fromSse = false) => {
      if (!currentEvent(next.instrumentId)) return;
      if (fromSse) markSseRecovered();
      setIntraday(next);
      setIntradayState("ready");
      if (fromSse || !sseWarningVisible) setIntradayError(next.error);
    };
    const applyPoint = (payload: StockIntradayPoint | StockIntradaySeries) => {
      if ("points" in payload) {
        applySnapshot(payload, true);
        return;
      }
      if (!current()) return;
      markSseRecovered();
      setIntraday((previous) => {
        if (!previous) return previous;
        const points = [...previous.points.filter((point) => point.time !== payload.time), payload]
          .sort((left, right) => left.time.localeCompare(right.time));
        return { ...previous, points, asOf: payload.time };
      });
      setIntradayState("ready");
    };
    const applyStatus = (payload: StockIntradayStatusEvent) => {
      if (!currentEvent(payload.instrumentId)) return;
      markSseRecovered();
      setIntraday((previous) => previous
        ? {
            ...previous,
            status: payload.status,
            stale: payload.stale ?? previous.stale,
            quality: payload.quality ?? previous.quality,
            error: payload.error ?? previous.error,
          }
        : previous);
      if (payload.error) setIntradayError(payload.error);
    };
    const onStreamError = () => {
      if (!current()) return;
      beginSseGrace();
      stream?.close();
      stream = null;
      schedule();
    };
    const startRound = async () => {
      if (!current() || paused) return;
      stop();
      const controller = new AbortController();
      requestAbort = controller;
      try {
        const snapshot = await fetchStockIntraday(item.instrumentId, controller.signal);
        if (!current() || controller.signal.aborted) return;
        applySnapshot(snapshot);
        const nextStream = await openStockIntradayStream(
          item.instrumentId,
          {
            onSnapshot: (payload) => applySnapshot(payload, true),
            onPoint: applyPoint,
            onStatus: applyStatus,
            onError: onStreamError,
          },
          { signal: controller.signal },
        );
        if (!current() || paused || controller.signal.aborted) {
          nextStream.close();
          return;
        }
        stream = nextStream;
      } catch (error) {
        if (!current() || controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
        beginSseGrace();
        setIntradayState((previous) =>
          previous === "ready" || sseWarningVisible ? previous : "loading",
        );
        schedule();
      }
    };
    const onVisibility = () => {
      paused = document.hidden;
      if (paused) {
        clearSseGrace();
        stop();
        return;
      }
      void startRound();
    };

    if (intradayActive) {
      setIntradayState((previous) => (intraday ? previous : "loading"));
      void startRound();
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      disposed = true;
      clearSseGrace();
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intradayActive, item.instrumentId]);
  const latest = item.latest;
  const report = reportDetail?.report ?? null;
  const reportStance = report?.research_stance ?? latest?.stance;
  const latestHorizonBrief = latest && "horizonStances" in latest
    ? horizonBrief(latest.horizonStances)
    : latest && "horizonDecisions" in latest
      ? v5HorizonBrief(latest.horizonDecisions)
      : null;
  const reportDataQuality = report?.data_quality ?? latest?.dataQuality;
  const requestStartRun = () => {
    if (report) setConfirmRerunOpen(true);
    else onStartRun();
  };

  // 副图与主图共享同一视口切片（缩放/拖动同步）。
  const visibleBars = useMemo(
    () =>
      kline ? kline.bars.slice(klineView.offset, klineView.offset + klineView.count) : [],
    [kline, klineView],
  );
  const visibleMacd = useMemo(() => {
    const m = kline?.indicators.macd;
    if (!m) return null;
    const from = klineView.offset;
    const to = from + klineView.count;
    return {
      dif: m.dif.slice(from, to),
      dea: m.dea.slice(from, to),
      hist: m.hist.slice(from, to),
    };
  }, [kline, klineView]);

  const technical = useMemo(() => {
    const close = quote?.price ?? kline?.bars.at(-1)?.close ?? null;
    const ma5 = lastNumber(kline?.indicators.ma.ma5);
    const ma20 = lastNumber(kline?.indicators.ma.ma20);
    const rsi = lastNumber(kline?.indicators.rsi14);
    const volumeChange = kline?.indicators.volumeChangePct ?? null;
    const macdDif = lastNumber(kline?.indicators.macd?.dif);
    const macdDea = lastNumber(kline?.indicators.macd?.dea);
    const macdState = macdDif == null || macdDea == null
      ? "数据待补充"
      : macdDif > macdDea
        ? "多头"
        : macdDif < macdDea
          ? "空头"
          : "中性";
    const trend =
      close == null || ma5 == null || ma20 == null
        ? "数据待补充"
        : close > ma5 && ma5 > ma20
          ? "技术偏强"
          : close < ma5 && ma5 < ma20
            ? "技术偏弱"
            : "区间震荡";
    const resistance =
      report?.technical_levels?.resistance ??
      kline?.indicators.swing?.resistance ??
      null;
    const support =
      report?.technical_levels?.support ??
      kline?.indicators.swing?.support ??
      null;
    return { ma5, ma20, rsi, volumeChange, macdDif, macdDea, macdState, trend, resistance, support };
  }, [kline, quote?.price, report?.technical_levels]);

  const deepReports = reports.filter((entry) => entry.kind === "deep_research");
  const previous = deepReports[1] ?? null;
  const horizonComparison = reportHorizonComparison(deepReports);
  const comparison = summarizeReportComparison(deepReports);
  const sourceCount = report?.source_ids?.length ?? 0;
  const fundamentals = researchContext?.fundamentals;
  const news = researchContext?.news;
  const runStepIds = ["technical", "fundamental", "news", "bull", "bear", "referee"] as const;
  const runSettled = visibleRun
    ? runStepIds.filter((id) => ["succeeded", "failed", "skipped", "cancelled"].includes(visibleRun.steps[id]?.status ?? "")).length
    : 0;

  const tabs: { key: StageTab; label: string }[] = [
    { key: "market", label: "行情" },
    { key: "fundamentals", label: "基本面" },
    { key: "news", label: "资讯公告" },
    { key: "diagnosis", label: "AI诊股" },
    { key: "expert", label: "专家团论证" },
  ];

  return (
    <section
      className={cn(
        "grid min-h-0 min-w-0 grid-cols-1 overflow-hidden",
        decisionSummaryOpen && "lg:grid-cols-[minmax(0,1fr)_336px]",
      )}
    >
      <>
      <div className="scrollbar-hover min-h-0 min-w-0 overflow-y-auto bg-background">
        <header className="flex h-12 items-center gap-3 border-b px-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-title-sm">{item.name}</h2>
            <span className="text-ui text-muted-foreground">{item.instrumentId.split(":")[1]}</span>
          </div>
          {quote?.price != null && (
            <span className="ml-auto text-title font-semibold tabular-nums text-stock-up">{formatPrice(quote.price)}</span>
          )}
          {pct != null && (
            <span className={cn("text-ui tabular-nums", pct >= 0 ? "text-stock-up" : "text-stock-down")}>
              {`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
            </span>
          )}
          <span className="ml-auto hidden text-caption text-muted-foreground xl:inline">
            {kline?.source.fetchedAt ? `更新于 ${kline.source.fetchedAt.slice(11, 19)}` : "等待行情"}
          </span>
        </header>

        <div className="mx-3 mt-3 grid grid-cols-2 rounded-md border md:grid-cols-4">
          <div className="border-b px-3 py-2.5 text-center md:border-b-0 md:border-r">
            <div className="text-caption font-medium">研究观点</div>
            <div className="mt-1 text-ui">
              {latestHorizonBrief ?? (latest?.stance ? visibleStanceLabel(latest.stance) : report?.schema_version === 4 ? "分周期结论" : "尚无可用结论")}
            </div>
            <div className="text-caption text-muted-foreground">{latest ? shortDate(latest.asOf) : "尚无报告"}</div>
          </div>
          <div className="border-b px-3 py-2.5 text-center md:border-b-0 md:border-r">
            <div className="text-caption font-medium">趋势状态</div>
            <div className="mt-1 text-ui">{technical.trend}</div>
            <div className="text-caption text-muted-foreground">按技术规则计算</div>
          </div>
          <div className="border-r px-3 py-2.5 text-center">
            <div className="text-caption font-medium">关键价位</div>
            <div className="mt-1 text-ui font-medium tabular-nums">
              <span className="text-stock-up">{formatLevel(technical.resistance)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-stock-down">{formatLevel(technical.support)}</span>
            </div>
            <div className="text-caption text-muted-foreground">压力 / 支撑</div>
          </div>
          <div className="px-3 py-2.5 text-center">
            <div className="text-caption font-medium">相比上次</div>
            <div className="mt-1 truncate text-ui">{comparison}</div>
            <div className="text-caption text-muted-foreground">{previous ? shortDate(previous.asOf) : "无可比报告"}</div>
          </div>
        </div>

        <div className="mt-1 flex h-8 items-end gap-5 border-b px-4" role="tablist" aria-label="标的研究视图">
          {tabs.map((tab) => (
            <Button
              key={tab.key}
              type="button"
              variant="ghost"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "h-8 rounded-none border-b-2 border-transparent px-0.5 text-caption transition-colors duration-instant hover:bg-transparent focus-visible:border-info focus-visible:ring-0",
                activeTab === tab.key ? "border-info text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {activeTab === "market" && (
          <div className="px-3 pb-3">
            <div className="flex h-8 items-center gap-1">
              <div className="flex items-center rounded-md bg-muted p-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setMarketView("intraday")}
                  aria-pressed={marketView === "intraday"}
                  className={cn(
                    "h-6 rounded px-2 py-0 text-micro hover:bg-transparent",
                    marketView === "intraday"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  分时
                </Button>
                {KLINE_PERIODS.map((p) => (
                  <Button
                    key={p.key}
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setMarketView("kline");
                      onPeriodChange(p.key);
                    }}
                    aria-pressed={marketView === "kline" && period === p.key}
                    className={cn(
                      "h-6 rounded px-2 py-0 text-micro hover:bg-transparent",
                      marketView === "kline" && period === p.key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
              {marketView === "kline" && <>
                <span className="ml-2 hidden text-micro text-info lg:inline">5日均线 {formatLevel(technical.ma5)}</span>
                <span className="hidden text-micro text-warning lg:inline">20日均线 {formatLevel(technical.ma20)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setShowMacd((v) => !v)}
                  aria-pressed={showMacd}
                  className={cn(
                    "ml-auto h-6 rounded px-2 py-0 text-micro hover:bg-accent/50",
                    showMacd ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  MACD 指标
                </Button>
                <span className="ml-2 hidden text-micro text-muted-foreground xl:inline">
                  前复权 · 成交量
                </span>
              </>}
            </div>

            {marketView === "intraday" && (
              <IntradayChart
                series={intraday}
                state={intradayState}
                error={intradayError}
                disconnected={intradayDisconnected}
                className="mt-2"
              />
            )}

            {marketView === "kline" && klineState === "loading" && (
              <div className="flex h-72 items-center justify-center gap-2 text-caption text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                正在加载K线…
              </div>
            )}
          {marketView === "kline" && klineState === "error" && (
            <StatusNotice
              tone="danger"
              title="K线加载失败"
              className="mt-2"
              action={
                <Button variant="outline" size="xs" onClick={onRetryKline}>
                  重试K线
                </Button>
              }
            >
              网络或数据源暂不可用
            </StatusNotice>
          )}
          {marketView === "kline" && (klineState === "ok" || klineState === "idle") && (
            <>
              <KlineChart
                bars={kline?.bars ?? []}
                ma={kline?.indicators.ma}
                view={klineView}
                onViewChange={setKlineView}
                onHoverChange={(idx) =>
                  setHoverVisibleIdx(
                    idx == null ? null : idx - klineView.offset,
                  )
                }
                className="mt-1 h-64 2xl:h-72"
              />
              {kline && kline.bars.length > 0 && (
                <>
                  <VolumeChart
                    bars={visibleBars}
                    hoverIdx={hoverVisibleIdx}
                    className="mt-1 h-12"
                  />
                  {showMacd && visibleMacd && (
                    <MacdChart macd={visibleMacd} className="mt-1 h-12" />
                  )}
                </>
              )}
            </>
          )}
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
              <section className="rounded-md border">
                <div className="flex h-8 items-center border-b px-2.5 text-caption font-medium">
                  <BarChart3 className="mr-1.5 h-3.5 w-3.5" aria-hidden />技术状态
                </div>
                <div className="px-2.5 py-1 text-caption">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">RSI(14)</span><span className="tabular-nums">{technical.rsi == null ? "—" : technical.rsi.toFixed(1)}</span><span>{technical.rsi == null ? "数据待补充" : technical.rsi > 60 ? "偏强" : technical.rsi < 40 ? "偏弱" : "中性"}</span></div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">成交量</span><span className={cn("tabular-nums", technical.volumeChange != null && technical.volumeChange >= 0 ? "text-success" : "")}>{technical.volumeChange == null ? "—" : `${technical.volumeChange >= 0 ? "+" : ""}${technical.volumeChange.toFixed(1)}%`}</span><span>{technical.volumeChange == null ? "数据待补充" : technical.volumeChange > 10 ? "放量" : technical.volumeChange < -10 ? "缩量" : "平稳"}</span></div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">支撑位</span><span className="tabular-nums">{formatLevel(technical.support)}</span><span>{technical.support == null ? "数据待补充" : "按技术规则计算"}</span></div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">压力位</span><span className="tabular-nums">{formatLevel(technical.resistance)}</span><span>{technical.resistance == null ? "数据待补充" : "按技术规则计算"}</span></div>
                  <div className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">MACD 指标</span><span className="tabular-nums">{technical.macdDif == null || technical.macdDea == null ? "—" : `快线（DIF）：${technical.macdDif.toFixed(2)} / 慢线（DEA）：${technical.macdDea.toFixed(2)}`}</span><span>{technical.macdState}</span></div>
                </div>
              </section>
              <section className="rounded-md border">
                <div className="flex h-8 items-center border-b px-2.5 text-caption font-medium">
                  <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden />基本面快照
                  <span className="ml-2 text-muted-foreground">{fundamentals?.status === "available" ? "数据可用" : fundamentals?.status === "not_applicable" ? "交易型开放式指数基金（ETF）不适用" : fundamentals?.status === "unavailable" ? "部分条件待确认" : "数据状态待确认"}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto h-6 gap-0.5 px-1.5 font-normal text-muted-foreground"
                    aria-label="查看基本面详情"
                    onClick={() => setActiveTab("fundamentals")}
                  >
                    更多<ChevronRight className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
                <div className="px-2.5 py-1 text-caption">
                  {[
                    ["营业收入", "revenue_yoy", "同比"],
                    ["归母净利润", "profit_yoy", "同比"],
                    ["毛利率", "gross_margin", ""],
                    ["净资产收益率（ROE）", "roe", ""],
                    ["EPS", "eps", ""],
                  ].map(([label, key, suffix]) => {
                    const value = fundamentals?.data?.metrics[key];
                    return <div key={key} className="grid grid-cols-[1fr_auto_auto] gap-3 py-1"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value == null ? "—" : `${value.toFixed(2)}${key === "eps" ? "" : "%"}`}</span><span className={value != null && value > 0 ? "text-success" : "text-muted-foreground"}>{value == null ? "数据待补充" : suffix || "最新数据"}</span></div>;
                  })}
                </div>
              </section>
            </div>
          </div>
        )}

        {activeTab === "fundamentals" && (
          <div className="px-4 py-4">
            {fundamentals?.status === "available" && fundamentals.data ? (
              <div className="overflow-hidden rounded-md border">
                <div className="flex h-10 items-center border-b bg-muted/20 px-3">
                  <FileText className="mr-2 h-4 w-4 text-muted-foreground" aria-hidden />
                  <h3 className="text-ui font-medium">最新财务指标</h3>
                  <span className="ml-auto text-caption text-muted-foreground">
                    报告期 {periodLabel(fundamentals.data.reportPeriod)}
                  </span>
                </div>
                <div className="grid grid-cols-2 divide-x md:grid-cols-3">
                  {[
                    ["营业收入同比", "revenue_yoy"],
                    ["归母净利润同比", "profit_yoy"],
                    ["毛利率", "gross_margin"],
                    ["净资产收益率", "roe"],
                    ["每股收益", "eps"],
                    ["市盈率", "pe"],
                  ].map(([label, key]) => {
                    const value = key === "pe" ? quote?.pe : fundamentals.data?.metrics[key];
                    return (
                      <div key={key} className="border-b px-3 py-3 last:border-b-0">
                        <div className="text-caption text-muted-foreground">{label}</div>
                        <div className="mt-1 text-title-sm font-medium tabular-nums">
                          {value == null ? "—" : `${value.toFixed(2)}${key === "eps" || key === "pe" ? "" : "%"}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="px-3 py-2 text-caption text-muted-foreground">
                  来源：{sourceLabel(fundamentals.data.source.provider)} · 更新于 {shortDate(fundamentals.data.source.fetchedAt)}
                </div>
              </div>
            ) : fundamentals?.status === "not_applicable" ? (
              <div className="flex min-h-56 items-center justify-center text-caption text-muted-foreground">
                当前标的是交易型开放式指数基金（ETF），不适用公司财务指标。
              </div>
            ) : (
              <StatusNotice tone="warning" title="基本面数据暂不可用">
                {userFacingError(fundamentals?.error?.message, "数据源尚未返回可核验的财务指标")}
              </StatusNotice>
            )}
          </div>
        )}

        {activeTab === "news" && (
          <div className="px-4 py-3">
            {news?.items.length ? (
              <div className="divide-y">
                {news.items.map((entry) => (
                  <a
                    key={`${entry.url}-${entry.publishedAt ?? ""}`}
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex gap-3 py-3 hover:text-info"
                    onClick={(event) => {
                      if (!isTauri() || !/^https?:\/\//i.test(entry.url)) return;
                      event.preventDefault();
                      void openExternalUrl(entry.url);
                    }}
                  >
                    <Newspaper className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-info" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui font-medium">{entry.title}</span>
                      <span className="mt-1 line-clamp-2 block text-caption text-muted-foreground">{evidenceTextLabel(entry.summary) || "暂无摘要"}</span>
                    </span>
                    <time className="shrink-0 text-caption text-muted-foreground">{shortDate(entry.publishedAt)}</time>
                  </a>
                ))}
              </div>
            ) : (
              <div className="flex min-h-56 flex-col items-center justify-center text-caption text-muted-foreground">
                <Newspaper className="mb-2 h-5 w-5" aria-hidden />
                {userFacingError(news?.error?.message, "暂无已核验资讯或公告")}
              </div>
            )}
          </div>
        )}

        {activeTab === "diagnosis" && (
          <>
          {diagnosisStarting && !visibleDiagnosisRun ? (
            <div className="space-y-4 px-4 py-4" role="status" data-testid="ai-diagnosis-running">
              <p className="text-caption text-muted-foreground">正在准备 AI 诊股，完成后显示标准结论。</p>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="正在准备" />
            </div>
          ) : diagnosisReport ? (
            <div className="space-y-5 px-4 py-4" data-testid="ai-diagnosis-content">
              <ResearchDecisionView report={diagnosisReport} />
            </div>
          ) : visibleDiagnosisRun ? (
            <div className="space-y-4 px-4 py-4" data-testid="ai-diagnosis-running">
              <p className="text-caption text-muted-foreground">AI 诊股正在生成标准结论，请稍候。</p>
              <div className="rounded border bg-muted/10 px-3 py-3 text-caption">当前状态：{visibleDiagnosisRun.status === "queued" ? "排队中" : "分析中"}</div>
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center" data-testid="ai-diagnosis-empty">
              <FileText className="mb-2 h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="text-ui">尚未生成 AI 诊股结论</p>
              <p className="mt-1 max-w-md text-caption text-muted-foreground">AI 诊股使用一次语义研究和确定性因子计算，专家团论证不会在此自动启动。</p>
            </div>
          )}
          {diagnosisReports.length > 0 && (
            <details className="border-t px-4 py-3" data-testid="ai-diagnosis-history">
              <summary className="cursor-pointer text-caption font-medium">AI诊股历史（{diagnosisReports.length}）</summary>
              <div className="mt-2 divide-y">
                {diagnosisReports.map((entry) => (
                  <Button key={entry.diagnosisId} type="button" variant="ghost" onClick={() => onOpenDiagnosis(entry.diagnosisId)} className="h-auto w-full justify-start gap-3 rounded-none px-0 py-2 text-left">
                    <span className="w-16 shrink-0 text-caption">AI诊股</span>
                    <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{entry.status === "succeeded" ? "已完成" : entry.status === "failed" ? "失败" : entry.status === "cancelled" ? "已取消" : "进行中"}</span>
                    <time className="text-micro text-muted-foreground">{shortDate(entry.updatedAt ?? entry.createdAt)}</time>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  </Button>
                ))}
              </div>
            </details>
          )}
          </>
        )}

        {activeTab === "expert" && (
          <>
            <ExpertPanel
              run={visibleRun}
              report={report}
              starting={starting}
              cancellingRun={cancellingRun}
              onStart={requestStartRun}
              onCancel={onCancelRun}
              historyCount={deepReports.length}
            />
            {report && (
              <details className="mx-4 mb-4 border-t pt-3" data-testid="expert-full-report">
                <summary className="cursor-pointer text-caption font-medium">查看结构化完整结论</summary>
                <div className="mt-4 space-y-5">
                  <ResearchDecisionView report={report} />
                  {visibleRun && <StepTimeline run={visibleRun} token={token} stepActivities={stepActivities} report={null} variant="overview" />}
                </div>
              </details>
            )}
          </>
        )}

        {activeTab === "expert" && deepReports.length > 0 && (
          <details className="border-t px-4 py-3">
            <summary className="cursor-pointer text-caption font-medium">历史版本（{deepReports.length}）</summary>
            <div className="mt-2 divide-y">
                {deepReports.map((entry) => (
                  <ContextMenu key={entry.reportId}>
                    <ContextMenuTrigger asChild>
                      <Button type="button" variant="ghost" onClick={() => onOpenReport(entry.reportId)} className="h-auto w-full justify-start gap-3 rounded-none px-0 py-2 text-left hover:bg-accent/50">
                        <span className="w-20 shrink-0 text-caption">深度投研</span>
                        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{horizonBrief("horizonStances" in entry ? entry.horizonStances : undefined) ?? (entry.stance ? visibleStanceLabel(entry.stance) : "分周期结论")} · {visibleDataQualityLabel(entry.dataQuality)}</span>
                        <time className="text-micro text-muted-foreground">{shortDate(entry.asOf)}</time>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      </Button>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-40">
                      <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteReportId(entry.reportId)}>
                        <Trash2 className="mr-2 h-3.5 w-3.5" />删除历史报告
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
            </div>
          </details>
        )}
      </div>

      {decisionSummaryOpen && (
        <aside
          id={DECISION_SUMMARY_PANEL_ID}
          className="scrollbar-hover min-h-0 overflow-hidden border-t bg-muted/10 lg:border-l lg:border-t-0"
          aria-label="决策雷达"
        >
          <DecisionRadar
            instrumentId={item.instrumentId}
            decisionEvaluation={decisionEvaluation}
            starting={diagnosisStarting}
            cancellingRun={diagnosisCancellingRun}
            runActive={diagnosisRunActive}
            runFailed={visibleDiagnosisRun?.status === "failed"}
            runSettled={runSettled}
            runningStepLabel={undefined}
            report={report}
            diagnosisReport={diagnosisReport}
            diagnosisMode
            reportStance={reportStance}
            reportDataQuality={reportDataQuality}
            comparison={comparison}
            horizonComparison={horizonComparison}
            technical={{
              trend: technical.trend,
              support: technical.support,
              resistance: technical.resistance,
            }}
            quote={{
              price: quote?.price ?? null,
              changePct: quote?.changePct ?? null,
              updatedAt: quote?.asOf ?? kline?.source.fetchedAt ?? null,
            }}
            latestNews={news?.items[0] ?? null}
            fundamentalsPeriod={fundamentals?.data?.reportPeriod ?? null}
            sourceCount={sourceCount}
            onStartRun={onStartDiagnosis}
            onCancelRun={onCancelDiagnosis}
            onNavigate={(tab) => setActiveTab(tab === "report" ? "expert" : tab)}
          />
        </aside>
      )}
        </>
      

      <AlertDialog open={confirmRerunOpen} onOpenChange={setConfirmRerunOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>重新论证{item.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              将使用最新行情、公告、财务和行业资料更新专家团论证，历史报告会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRerunOpen(false);
                onStartRun();
              }}
            >
              确认重新论证
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={deleteReportId != null} onOpenChange={(open) => { if (!open) setDeleteReportId(null); }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除历史报告？</AlertDialogTitle>
          <AlertDialogDescription>将同时删除本次投研的报告及相关研究记录，此操作不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteReportId) onDeleteReport(deleteReportId); setDeleteReportId(null); }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
