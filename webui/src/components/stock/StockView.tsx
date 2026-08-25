import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { useClient } from "@/providers/ClientProvider";
import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { cn } from "@/lib/utils";
import type {
  StockDashboardItem,
  StockKlineResponse,
  StockQuote,
  StockResearchContext,
  StockReportDetail,
  StockReportListItem,
  StockSelectionOrigin,
  StockDecisionEvaluation,
  StockWatchlistAddInput,
  StockDiagnosisRun,
  StockDiagnosisV1,
} from "@/lib/stock-api";
import {
  addStockWatchlist,
  deleteStockReport,
  fetchStockDashboard,
  fetchStockKline,
  fetchStockQuotes,
  fetchStockResearchContext,
  fetchStockDiagnoses,
  fetchStockDiagnosis,
  fetchStockDecisionConditions,
  isStockReportV5Document,
  preflightStockResearch,
  fetchStockReport,
  fetchStockReports,
  removeStockWatchlist,
  reorderStockWatchlist,
  searchStocks,
  setStockWatchlistFocus,
  STOCK_DIAGNOSIS_ROOM_CHAT_ID,
  STOCK_ROOM_CHAT_ID,
} from "@/lib/stock-api";
import type { ToolProgressEvent, WorkflowRun } from "@/lib/types";
import {
  INDEX_IDS,
  MarketTickerBar,
} from "./MarketTickerBar";
import {
  InstrumentStage,
  KLINE_PERIODS,
  STOCK_KLINE_FETCH_BARS,
  type KlinePeriodKey,
} from "./InstrumentStage";
import { ReportDetail } from "./ReportDetail";
import { ReviewHeroCard } from "./ReviewHeroCard";
import { OpportunityDiscovery } from "./OpportunityDiscovery";
import {
  WatchGrid,
  type StockWatchSignal,
} from "./WatchGrid";

/** 股票工作台：
 *  紧凑指数条 → 今日复盘状态 → 自选观察 / 行情研究 / 决策上下文三栏；
 *  完整报告使用覆盖层阅读。
 *  执行走隐形房间的 run_workflow（携带 inputs.symbols），进度经
 *  workflow_run_updated 推送；行情/K线走 services 端口，报告走
 *  WebSocket 端口。 */

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"]);
/** 行情轮询间隔兜底值；实际取 StockConfig.quote_refresh_sec（经 props 注入）。 */
const DEFAULT_QUOTE_POLL_MS = 30_000;
/** 自选列表信号窗口：近 30 个交易日。 */
const SPARKLINE_LIMIT = 30;
/** 日线包含当日未收盘数据，短缓存避免切换标的时重复拉取。 */
const KLINE_CACHE_TTL_MS = 60_000;
/** 基本面与资讯变化较慢，允许更长的后台刷新窗口。 */
const RESEARCH_CACHE_TTL_MS = 5 * 60_000;
const DASHBOARD_CACHE_TTL_MS = 30_000;
const REPORT_LIST_CACHE_TTL_MS = 30_000;
const QUOTE_CACHE_TTL_MS = 30_000;
const SIGNAL_CACHE_TTL_MS = 60_000;

type CacheSlot<T> = {
  entry?: { value: T; updatedAt: number };
  request?: Promise<T>;
};

const dashboardCache = new Map<string, CacheSlot<StockDashboardItem[]>>();
const reportListCache = new Map<string, CacheSlot<StockReportListItem[]>>();
const quoteCache = new Map<string, CacheSlot<StockQuote[]>>();
const signalCache = new Map<string, CacheSlot<StockWatchSignal>>();
const klineCache = new Map<string, CacheSlot<StockKlineResponse>>();
const researchCache = new Map<string, CacheSlot<StockResearchContext>>();
const reportCache = new Map<string, CacheSlot<StockReportDetail>>();

export function clearStockViewCache() {
  dashboardCache.clear();
  reportListCache.clear();
  quoteCache.clear();
  signalCache.clear();
  klineCache.clear();
  researchCache.clear();
  reportCache.clear();
}

function cachedRequest<T>(
  cache: Map<string, CacheSlot<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): { cached: T | null; request: Promise<T> | null } {
  const slot = cache.get(key);
  const cached = slot?.entry?.value ?? null;
  if (slot?.entry && Date.now() - slot.entry.updatedAt < ttlMs) {
    return { cached, request: null };
  }
  if (slot?.request) return { cached, request: slot.request };

  const request = loader()
    .then((value) => {
      cache.set(key, { entry: { value, updatedAt: Date.now() } });
      return value;
    })
    .catch((error) => {
      if (slot?.entry) cache.set(key, { entry: slot.entry });
      else cache.delete(key);
      throw error;
    });
  cache.set(key, { entry: slot?.entry, request });
  return { cached, request };
}

/** 首屏工作台数据（自选 + 报告）加载状态。 */
type BootState = "loading" | "ready" | "error";
/** 选中标的的 K 线加载状态；idle = 未选标的。 */
type KlineState = "idle" | "loading" | "ok" | "error";

/** Asia/Shanghai 视角的日历日（复盘「今日」判定）。 */
function shanghaiDay(d: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(d));
}

function lastNumber(values: (number | null)[] | undefined): number | null {
  if (!values) return null;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] != null) return values[i];
  }
  return null;
}

function watchSignal(resp: StockKlineResponse): StockWatchSignal {
  const closes = resp.bars.map((bar) => bar.close);
  const close = closes.at(-1);
  const ma5 = lastNumber(resp.indicators.ma.ma5);
  const ma20 = lastNumber(resp.indicators.ma.ma20);
  const volumeChange = resp.indicators.volumeChangePct ?? null;
  const trendLabel =
    close == null || ma5 == null || ma20 == null
      ? "待更新"
      : close > ma5 && ma5 > ma20
        ? "技术偏强"
        : close < ma5 && ma5 < ma20
          ? "技术偏弱"
          : "区间震荡";
  const volumeLabel =
    volumeChange == null
      ? "量能待更新"
      : Math.abs(volumeChange) < 10
        ? "平稳"
        : volumeChange > 0
          ? "成交放量"
          : "成交缩量";
  return { closes, trendLabel, volumeLabel };
}

interface StockViewProps {
  /** 复盘通知点击带入的 runId（T20）：命中报告列表后打开对应简报并消费。 */
  focusRunId?: string | null;
  onConsumeFocusRun?: () => void;
  /** 私聊确认卡（T22d）带入的标的：进入工作台后自动选中并启动深度投研。 */
  autoRunSymbol?: string | null;
  onConsumeAutoRun?: () => void;
  /** 行情轮询间隔毫秒（StockConfig.quote_refresh_sec × 1000，设置页可改）。 */
  quoteRefreshSecMs?: number;
  /** 复盘时间（StockConfig.review_time，Hero 未复盘态展示）。 */
  reviewTime?: string;
  /** 复盘范围（StockConfig.review_scope）。 */
  reviewScope?: "all" | "focus";
  /** 自动每日复盘开关；与股票模块开关独立。 */
  autoReviewEnabled?: boolean;
  /** 打开设置页股票分区（顶栏齿轮）。 */
  onOpenSettings?: () => void;
}

export function StockView({
  focusRunId,
  onConsumeFocusRun,
  autoRunSymbol,
  onConsumeAutoRun,
  quoteRefreshSecMs = DEFAULT_QUOTE_POLL_MS,
  reviewTime = "15:30",
  reviewScope = "focus",
  autoReviewEnabled = false,
  onOpenSettings,
}: StockViewProps) {
  const { client, token } = useClient();
  const [items, setItems] = useState<StockDashboardItem[]>([]);
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [watchSignals, setWatchSignals] = useState<
    Record<string, StockWatchSignal>
  >({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kline, setKline] = useState<StockKlineResponse | null>(null);
  const [klineState, setKlineState] = useState<KlineState>("idle");
  const [klineNonce, setKlineNonce] = useState(0);
  const [period, setPeriod] = useState<KlinePeriodKey>("daily");
  const [reports, setReports] = useState<StockReportListItem[]>([]);
  const [activeReport, setActiveReport] = useState<StockReportDetail | null>(null);
  const [contextReport, setContextReport] = useState<StockReportDetail | null>(null);
  const [decisionEvaluation, setDecisionEvaluation] = useState<StockDecisionEvaluation | null>(null);
  const [researchContext, setResearchContext] = useState<StockResearchContext | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [diagnosisRun, setDiagnosisRun] = useState<WorkflowRun | null>(null);
  const [diagnosisReports, setDiagnosisReports] = useState<StockDiagnosisRun[]>([]);
  const [diagnosisReport, setDiagnosisReport] = useState<StockDiagnosisV1 | null>(null);
  const [stepActivities, setStepActivities] = useState<
    Record<string, ToolProgressEvent[]>
  >({});
  const [starting, setStarting] = useState(false);
  const [diagnosisStarting, setDiagnosisStarting] = useState(false);
  const [bootState, setBootState] = useState<BootState>("loading");
  /** 行情轮询失败：保留旧报价并提示，恢复后自动消失（非阻断）。 */
  const [quotesStale, setQuotesStale] = useState(false);
  /** 行情请求进行中：顶栏刷新图标旋转提示。 */
  const [quotesLoading, setQuotesLoading] = useState(false);
  /** 写操作（添加/移除/星标/删除/启动）失败提示，可手动关闭。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 决策雷达面板开关：切换按钮在顶栏（MarketTickerBar）。 */
  const [decisionSummaryOpen, setDecisionSummaryOpen] = useState(true);
  const [watchGridCollapsed, setWatchGridCollapsed] = useState(false);
  const [stageTabRequest, setStageTabRequest] = useState<{ revision: number; tab: "market" | "news" } | null>(null);
  const [stockMode, setStockMode] = useState<"watch" | "opportunity">("watch");
  const mounted = useRef(true);
  const decisionEvaluationRequestId = useRef(0);
  const diagnosisRequestId = useRef(0);
  const autoRunStarted = useRef<string | null>(null);
  const cancellingRunId = useRef<string | null>(null);
  const diagnosisCancellingRunId = useRef<string | null>(null);
  const [cancellingRun, setCancellingRun] = useState(false);
  const [diagnosisCancellingRun, setDiagnosisCancellingRun] = useState(false);
  const finishCancellation = useCallback(() => {
    cancellingRunId.current = null;
    if (mounted.current) setCancellingRun(false);
  }, []);
  const finishDiagnosisCancellation = useCallback(() => {
    if (mounted.current) setDiagnosisCancellingRun(false);
  }, []);

  const refreshDecisionEvaluation = useCallback((reportId: string | null) => {
    const requestId = ++decisionEvaluationRequestId.current;
    if (!reportId) {
      setDecisionEvaluation(null);
      return;
    }
    setDecisionEvaluation(null);
    void fetchStockDecisionConditions(token, reportId)
      .then((evaluation) => {
        if (mounted.current && requestId === decisionEvaluationRequestId.current) {
          setDecisionEvaluation(evaluation);
        }
      })
      .catch(() => {
        if (mounted.current && requestId === decisionEvaluationRequestId.current) {
          setDecisionEvaluation(null);
        }
      });
  }, [token]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDashboard = useCallback(async (force = false) => {
    if (force) dashboardCache.delete(token);
    const { cached, request } = cachedRequest(
      dashboardCache,
      token,
      DASHBOARD_CACHE_TTL_MS,
      () => fetchStockDashboard(token),
    );
    const apply = (dashboard: StockDashboardItem[]) => {
      if (!mounted.current) return;
      setItems(dashboard);
      setSelectedId((prev) =>
        prev && dashboard.some((i) => i.instrumentId === prev)
          ? prev
          : (dashboard[0]?.instrumentId ?? null),
      );
    };
    if (cached) {
      apply(cached);
      if (request) void request.then(apply).catch(() => undefined);
      return;
    }
    if (request) apply(await request);
  }, [token]);

  const refreshReports = useCallback(async (force = false) => {
    if (force) reportListCache.delete(token);
    const { cached, request } = cachedRequest(
      reportListCache,
      token,
      REPORT_LIST_CACHE_TTL_MS,
      () => fetchStockReports(token),
    );
    const apply = (list: StockReportListItem[]) => {
      if (mounted.current) setReports(list);
    };
    if (cached) {
      apply(cached);
      if (request) void request.then(apply).catch(() => undefined);
      return;
    }
    if (request) apply(await request);
  }, [token]);

  const refreshDiagnoses = useCallback(async (instrumentId: string | null) => {
    const requestId = ++diagnosisRequestId.current;
    if (!instrumentId) {
      setDiagnosisReports([]);
      setDiagnosisReport(null);
      return;
    }
    const retryDelays = [0, 250, 750];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      if (retryDelays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
      if (!mounted.current || requestId !== diagnosisRequestId.current) return;
      try {
        const diagnosisItems = await fetchStockDiagnoses(instrumentId);
        if (!mounted.current || requestId !== diagnosisRequestId.current) return;
        const latest = diagnosisItems.find((item) => item.status === "succeeded") ?? null;
        let latestReport = latest?.report ?? null;
        if (latest && !latestReport) {
          const detail = await fetchStockDiagnosis(latest.diagnosisId);
          latestReport = detail.report ?? null;
        }
        if (!mounted.current || requestId !== diagnosisRequestId.current) return;
        setDiagnosisReports(diagnosisItems);
        setDiagnosisReport(latestReport);
        return;
      } catch {
        if (attempt < retryDelays.length - 1) continue;
      }
    }
    if (mounted.current && requestId === diagnosisRequestId.current) {
      setDiagnosisReports([]);
      setDiagnosisReport(null);
    }
  }, []);

  const handleOpenDiagnosis = useCallback(async (diagnosisId: string) => {
    try {
      const detail = await fetchStockDiagnosis(diagnosisId);
      if (mounted.current) setDiagnosisReport(detail.report ?? null);
    } catch {
      if (mounted.current) setActionError("AI诊股历史详情打开失败，请稍后重试");
    }
  }, []);

  useEffect(() => {
    void refreshDiagnoses(selectedId);
  }, [selectedId, refreshDiagnoses]);

  // 首屏：自选 + 报告并行加载，失败给出可重试的错误态（商用可用性）。
  const loadBoot = useCallback(async () => {
    setBootState("loading");
    try {
      await Promise.all([refreshDashboard(), refreshReports()]);
      if (mounted.current) setBootState("ready");
    } catch {
      if (mounted.current) setBootState("error");
    }
  }, [refreshDashboard, refreshReports]);

  // 首屏加载独立于 client（client 引用每次渲染可能变化，不能作为
  // loadBoot 的依赖，否则 loading/ready 状态会无限震荡）。
  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  // 恢复进行中的运行。
  useEffect(() => {
    void client
      .getWorkflowRun(STOCK_ROOM_CHAT_ID)
      .then((existing) => {
        if (mounted.current && existing && existing.inputs?.mode !== "stock_selection") setRun(existing);
      })
      .catch(() => undefined);
    void client
      .getWorkflowRun(STOCK_DIAGNOSIS_ROOM_CHAT_ID)
      .then((existing) => {
        if (mounted.current && existing) setDiagnosisRun(existing);
      })
      .catch(() => undefined);
  }, [client]);

  const refreshQuotes = useCallback(async (ids: string[], force = false) => {
    if (ids.length === 0) {
      setQuotes({});
      setQuotesStale(false);
      return;
    }
    const key = ids.join(",");
    if (force) quoteCache.delete(key);
    const { cached, request } = cachedRequest(
      quoteCache,
      key,
      Math.min(QUOTE_CACHE_TTL_MS, quoteRefreshSecMs),
      () => fetchStockQuotes(ids),
    );
    if (cached && mounted.current) {
      setQuotes(Object.fromEntries(cached.map((q) => [q.instrumentId, q])));
      setQuotesStale(false);
    }
    if (!request) {
      if (mounted.current) setQuotesLoading(false);
      return;
    }
    setQuotesLoading(true);
    try {
      const list = await request;
      if (!mounted.current) return;
      setQuotes(Object.fromEntries(list.map((q) => [q.instrumentId, q])));
      setQuotesStale(false);
    } catch {
      // 上游不可用保留旧报价并提示；下一轮轮询自愈后提示消失。
      if (mounted.current) setQuotesStale(true);
    } finally {
      if (mounted.current) setQuotesLoading(false);
    }
  }, [quoteRefreshSecMs]);

  // 自选变化 → 拉批量报价（含大盘指数，给自选涨跌一个参照系）；
  // 间隔跟随 StockConfig.quote_refresh_sec。门控到 boot ready 后启动，
  // 避免 items 为空时先用纯指数列表发起一次多余请求。
  const idsKey = items.map((i) => i.instrumentId).join(",");
  const quoteIdsKey = idsKey ? `${INDEX_IDS.join(",")},${idsKey}` : INDEX_IDS.join(",");
  useEffect(() => {
    if (bootState !== "ready") return;
    const ids = quoteIdsKey.split(",");
    void refreshQuotes(ids);
    const timer = setInterval(() => {
      // 页面不可见时跳过轮询（省资源、防限流）；恢复可见立即补一轮。
      if (document.hidden) return;
      void refreshQuotes(ids);
    }, quoteRefreshSecMs);
    return () => clearInterval(timer);
  }, [bootState, quoteIdsKey, refreshQuotes, quoteRefreshSecMs]);

  // 可见性恢复：立即刷新一轮行情，不等下一个轮询点。
  useEffect(() => {
    if (bootState !== "ready") return;
    const onVisibility = () => {
      if (document.hidden) return;
      void refreshQuotes(quoteIdsKey.split(","));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [bootState, quoteIdsKey, refreshQuotes]);

  // 自选列表信号：复用近 30 日 K 线响应，同时得到 sparkline、量能和
  // 技术趋势；单只失败仅退化该行，不打断主流程。
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) {
      setWatchSignals({});
      return;
    }
    let stale = false;
    void Promise.all(
      ids.map(async (id) => {
        try {
          const { cached, request } = cachedRequest(
            signalCache,
            id,
            SIGNAL_CACHE_TTL_MS,
            async () => watchSignal(await fetchStockKline(id, SPARKLINE_LIMIT, 101)),
          );
          return [id, cached ?? await request!] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (stale || !mounted.current) return;
      const next: Record<string, StockWatchSignal> = {};
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      setWatchSignals(next);
    });
    return () => {
      stale = true;
    };
  }, [idsKey]);

  // 选中标的/周期 → 优先复用缓存，过期后保留旧图并在后台刷新；
  // klineNonce 驱动手动重试。每次拉满 250 根（API 上限）。
  const klinePeriodDef = useMemo(
    () =>
      KLINE_PERIODS.find((p) => p.key === period) ?? KLINE_PERIODS[0],
    [period],
  );
  useEffect(() => {
    if (!selectedId) {
      setKline(null);
      setKlineState("idle");
      return;
    }
    const key = `${token}:${selectedId}:${klinePeriodDef.klt}`;
    let stale = false;
    const { cached, request } = cachedRequest(
      klineCache,
      key,
      KLINE_CACHE_TTL_MS,
      () =>
        fetchStockKline(
          selectedId,
          STOCK_KLINE_FETCH_BARS,
          klinePeriodDef.klt,
        ),
    );
    setKline(cached);
    setKlineState(cached ? "ok" : request ? "loading" : "ok");
    if (!request) return;
    void request
      .then((resp) => {
        if (!stale && mounted.current) {
          setKline(resp);
          setKlineState("ok");
        }
      })
      .catch(() => {
        if (!stale && mounted.current && !cached) setKlineState("error");
      });
    return () => {
      stale = true;
    };
  }, [selectedId, klinePeriodDef, klineNonce, token]);

  // 基本面和资讯是即时数据，不写入报告；报告只保留投研工作流的证据化结论。
  useEffect(() => {
    if (!selectedId) {
      setResearchContext(null);
      return;
    }
    let stale = false;
    const key = `${token}:${selectedId}`;
    const { cached, request } = cachedRequest(
      researchCache,
      key,
      RESEARCH_CACHE_TTL_MS,
      () => fetchStockResearchContext(selectedId),
    );
    setResearchContext(cached);
    if (!request) return;
    void request
      .then((context) => {
        if (!stale && mounted.current) setResearchContext(context);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [selectedId, token]);

  // 运行进度与研究助手实时活动推送（仅隐形股票房间）。
  useEffect(() => {
    const unsubscribeRun = client.onWorkflowRunUpdated((chatId, pushed, error, detail) => {
      if (chatId !== STOCK_ROOM_CHAT_ID && chatId !== STOCK_DIAGNOSIS_ROOM_CHAT_ID) return;
      const diagnosisEvent = chatId === STOCK_DIAGNOSIS_ROOM_CHAT_ID;
      if (error) {
        if (diagnosisEvent) setDiagnosisStarting(false);
        else setStarting(false);
        setActionError((diagnosisEvent ? "AI诊股" : "投研") + "运行失败：" + (detail || error));
        return;
      }
      if (!pushed) return;
      // OpportunityDiscovery owns the selection workflow state. Keep it out
      // of the deep-research timeline so switching views cannot mix runs.
      if (pushed.inputs?.mode === "stock_selection") return;
      if (diagnosisEvent) {
        setDiagnosisStarting(false);
        setDiagnosisRun(pushed);
      } else {
        setStarting(false);
        setRun(pushed);
      }
      if (TERMINAL_RUN_STATUSES.has(pushed.status)) {
        if (diagnosisEvent) {
          if (diagnosisCancellingRunId.current === pushed.id) {
            diagnosisCancellingRunId.current = null;
            finishDiagnosisCancellation();
          }
          void refreshDiagnoses(selectedId);
        } else {
          if (cancellingRunId.current === pushed.id) finishCancellation();
          if (pushed.status === "succeeded") reportCache.clear();
          void refreshDashboard(true).catch(() => undefined);
          void refreshReports(true).catch(() => undefined);
        }
      }
    });
    const unsubscribeActivity = client.onWorkflowStepActivity((chatId, payload) => {
      if (chatId !== STOCK_ROOM_CHAT_ID && chatId !== STOCK_DIAGNOSIS_ROOM_CHAT_ID) return;
      setStepActivities((current) => ({
        ...current,
        [`${payload.runId}:${payload.stepId}`]: payload.toolEvents,
      }));
    });
    client.attach(STOCK_ROOM_CHAT_ID);
    client.attach(STOCK_DIAGNOSIS_ROOM_CHAT_ID);
    return () => {
      unsubscribeRun();
      unsubscribeActivity();
    };
  }, [client, finishCancellation, finishDiagnosisCancellation, refreshDashboard, refreshReports, refreshDiagnoses, selectedId]);

  const handleAdd = useCallback(
    async (input: StockWatchlistAddInput) => {
      try {
        await addStockWatchlist(input);
        await refreshDashboard(true);
      } catch {
        setActionError("添加自选失败，请稍后重试");
      }
    },
    [refreshDashboard],
  );

  const handleRemove = useCallback(
    async (instrumentId: string) => {
      try {
        await removeStockWatchlist(instrumentId);
        await refreshDashboard(true);
      } catch {
        setActionError("移除自选失败，请稍后重试");
      }
    },
    [refreshDashboard],
  );

  // 星标切换（T22b）：失败提示用户，由下一次刷新自愈数据。
  const handleToggleFocus = useCallback(
    async (instrumentId: string, focus: boolean) => {
      try {
        await setStockWatchlistFocus(instrumentId, focus);
      } catch {
        setActionError("重点标记保存失败，请稍后重试");
        return;
      }
      if (!mounted.current) return;
      dashboardCache.delete(token);
      setItems((prev) =>
        prev.map((i) =>
          i.instrumentId === instrumentId ? { ...i, focus } : i,
        ),
      );
    },
    [token],
  );

  // 拖动排序：乐观重排，失败回滚并提示（由下一次刷新自愈）。
  const handleReorder = useCallback(
    async (instrumentIds: string[]) => {
      const prevItems = items;
      const byId = new Map(prevItems.map((i) => [i.instrumentId, i]));
      const reordered = instrumentIds
        .map((id) => byId.get(id))
        .filter((i): i is StockDashboardItem => i != null);
      if (reordered.length !== prevItems.length) return;
      setItems(reordered);
      try {
        await reorderStockWatchlist(instrumentIds);
        dashboardCache.delete(token);
      } catch {
        if (!mounted.current) return;
        setItems(prevItems);
        setActionError("排序保存失败，请稍后重试");
      }
    },
    [items, token],
  );

  const requestPreflight = useCallback(
    async (instrumentId: string, origin?: StockSelectionOrigin) => {
      const previousRunId = run?.id ?? null;
      const selectionContext = origin ?? null;
      setSelectedId(instrumentId);
      refreshDecisionEvaluation(null);
      setActionError(null);
      setStarting(true);
      try {
        const item = items.find((entry) => entry.instrumentId === instrumentId);
        const result = await preflightStockResearch(instrumentId, item?.name);
        await client.runWorkflow(STOCK_ROOM_CHAT_ID, {
          symbols: [instrumentId],
          evidence_context_id: result.contextId,
          ...(selectionContext ? { selection_origin: selectionContext } : {}),
        });
        const startedRun = await client.getWorkflowRun(STOCK_ROOM_CHAT_ID);
        if (!mounted.current) return;
        if (startedRun && startedRun.id !== previousRunId) setRun(startedRun);
        else setActionError("投研任务已提交，但运行状态暂未同步，请稍后重试");
      } catch (err) {
        if (mounted.current) {
          const message = err instanceof Error ? err.message : "";
          const reason = /[\u4e00-\u9fff]/.test(message) && !/[A-Za-z_]/.test(message)
            ? message
            : "研究资料准备失败，请稍后重试";
          setActionError(
            `投研启动失败：${reason}`,
          );
        }
      } finally {
        if (mounted.current) setStarting(false);
      }
    },
    [client, items, refreshDecisionEvaluation, run?.id],
  );

  const handleStartRun = useCallback(async () => {
    if (!selectedId) return;
    await requestPreflight(selectedId);
  }, [selectedId, requestPreflight]);

  const handleStartDiagnosis = useCallback(async () => {
    if (!selectedId || diagnosisStarting) return;
    const previousRunId = diagnosisRun?.id ?? null;
    setActionError(null);
    setDiagnosisStarting(true);
    try {
      const item = items.find((entry) => entry.instrumentId === selectedId);
      const result = await preflightStockResearch(selectedId, item?.name);
      await client.runWorkflow(STOCK_DIAGNOSIS_ROOM_CHAT_ID, {
        symbols: [selectedId],
        evidence_context_id: result.contextId,
      });
      const startedRun = await client.getWorkflowRun(STOCK_DIAGNOSIS_ROOM_CHAT_ID);
      if (!mounted.current) return;
      if (startedRun && startedRun.id !== previousRunId) setDiagnosisRun(startedRun);
      else setActionError("AI诊股任务已提交，但运行状态暂未同步，请稍后重试");
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "";
      setActionError(`AI诊股启动失败：${/^[\u4e00-\u9fff\s，。！？、]+$/.test(message) ? message : "研究资料准备失败，请稍后重试"}`);
    } finally {
      if (mounted.current) setDiagnosisStarting(false);
    }
  }, [client, diagnosisRun?.id, diagnosisStarting, items, selectedId]);

  const handleCancelDiagnosis = useCallback(async () => {
    const activeRun = diagnosisRun;
    if (!activeRun || !ACTIVE_RUN_STATUSES.has(activeRun.status) || diagnosisCancellingRun || diagnosisCancellingRunId.current === activeRun.id) return;
    diagnosisCancellingRunId.current = activeRun.id;
    const cancellingId = activeRun.id;
    setDiagnosisCancellingRun(true);
    setActionError(null);
    try {
      const cancelledRunId = await client.cancelWorkflowRun(STOCK_DIAGNOSIS_ROOM_CHAT_ID, activeRun.id);
      if (cancelledRunId !== cancellingId) throw new Error("取消请求返回的运行编号不一致");
      const serverRun = await client.getWorkflowRun(STOCK_DIAGNOSIS_ROOM_CHAT_ID, cancelledRunId);
      if (!mounted.current || diagnosisCancellingRunId.current !== cancellingId) return;
      setDiagnosisRun(serverRun);
      setDiagnosisStarting(false);
      if (!serverRun || TERMINAL_RUN_STATUSES.has(serverRun.status)) {
        diagnosisCancellingRunId.current = null;
        finishDiagnosisCancellation();
      }
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "";
      setActionError(`取消AI诊股失败：${/^[\u4e00-\u9fff\s，。！？、]+$/.test(message) ? message : "取消请求失败，请稍后重试"}`);
      diagnosisCancellingRunId.current = null;
      finishDiagnosisCancellation();
    }
  }, [client, diagnosisCancellingRun, diagnosisRun, finishDiagnosisCancellation]);

  const handleCancelRun = useCallback(async () => {
    const activeRun = run;
    if (
      !activeRun ||
      !["queued", "running", "waiting_approval"].includes(activeRun.status) ||
      cancellingRun ||
      cancellingRunId.current === activeRun.id
    ) return;

    cancellingRunId.current = activeRun.id;
    const cancellingId = activeRun.id;
    setCancellingRun(true);
    setActionError(null);
    try {
      const cancelledRunId = await client.cancelWorkflowRun(STOCK_ROOM_CHAT_ID, activeRun.id);
      if (cancelledRunId !== cancellingId) {
        throw new Error("取消请求返回的运行编号不一致");
      }
      const serverRun = await client.getWorkflowRun(STOCK_ROOM_CHAT_ID, cancelledRunId);
      if (!mounted.current) return;
      // A terminal push may have won the race while the GET was in flight;
      // never overwrite it with this stale snapshot.
      if (cancellingRunId.current !== cancellingId) return;
      // 以服务端重新读取的状态为准；没有活动运行也表示取消已生效。
      setRun(serverRun);
      setStarting(false);
      if (!serverRun || TERMINAL_RUN_STATUSES.has(serverRun.status)) {
        finishCancellation();
      }
    } catch (err) {
      if (!mounted.current) return;
      const message = err instanceof Error ? err.message : "";
      const reason = /[\u4e00-\u9fff]/.test(message) && !/[A-Za-z_]/.test(message)
        ? message
        : "取消请求失败，请稍后重试";
      setActionError(`取消投研失败：${reason}`);
      finishCancellation();
    }
  }, [cancellingRun, client, finishCancellation, run]);

  const loadReport = useCallback(
    async (reportId: string) => {
      const key = `${token}:${reportId}`;
      const { cached, request } = cachedRequest(
        reportCache,
        key,
        Number.POSITIVE_INFINITY,
        () => fetchStockReport(token, reportId),
      );
      return cached ?? await request!;
    },
    [token],
  );

  const handleOpenReport = useCallback(
    async (reportId: string) => {
      try {
        const detail = await loadReport(reportId);
        if (mounted.current) setActiveReport(detail);
      } catch {
        setActionError("报告打开失败，请稍后重试");
      }
    },
    [loadReport],
  );

  // 手动清理（design §9）：删除后关闭详情并刷新列表/工作台。
  const handleDeleteReport = useCallback(
    async (reportId: string) => {
      try {
        await deleteStockReport(token, reportId);
      } catch {
        setActionError("报告删除失败，请稍后重试");
        return;
      }
      if (!mounted.current) return;
      reportCache.delete(`${token}:${reportId}`);
      setActiveReport(null);
      if (decisionEvaluation?.reportId === reportId) refreshDecisionEvaluation(null);
      void refreshReports(true).catch(() => undefined);
      void refreshDashboard(true).catch(() => undefined);
    },
    [decisionEvaluation?.reportId, refreshDashboard, refreshDecisionEvaluation, refreshReports, token],
  );

  // 复盘通知点击进入（T20）：报告列表刷新后命中 runId 即打开简报。
  useEffect(() => {
    if (!focusRunId) return;
    const target = reports.find((r) => r.runId === focusRunId);
    if (!target) return;
    void handleOpenReport(target.reportId);
    onConsumeFocusRun?.();
  }, [focusRunId, reports, handleOpenReport, onConsumeFocusRun]);

  // 私聊入口只选中标的，不自动启动任何股票工作流；用户必须在对应 Tab 主动确认。
  useEffect(() => {
    if (!autoRunSymbol) {
      autoRunStarted.current = null;
      return;
    }
    if (!items.some((i) => i.instrumentId === autoRunSymbol)) return;
    if (autoRunStarted.current === autoRunSymbol) return;
    autoRunStarted.current = autoRunSymbol;
    setSelectedId(autoRunSymbol);
    onConsumeAutoRun?.();
  }, [autoRunSymbol, items, onConsumeAutoRun]);

  const selectedItem = items.find((i) => i.instrumentId === selectedId) ?? null;
  const selectedQuote = selectedId ? quotes[selectedId] : undefined;
  const selectedReports = useMemo(
    () =>
      selectedId
        ? reports.filter(
            (r) =>
              r.kind === "deep_research" &&
              (r.instrument?.instrumentId === selectedId ||
                r.symbols.includes(selectedId)),
          )
        : [],
    [reports, selectedId],
  );

  // 右侧决策上下文读取最新真实报告的结构化字段；失败只退化上下文，
  // 报告仍可从历史列表按需打开。
  const contextReportId =
    selectedItem?.latest?.kind === "deep_research"
      ? selectedItem.latest.reportId
      : null;
  useEffect(() => {
    if (!contextReportId) {
      setContextReport(null);
      return;
    }
    let stale = false;
    setContextReport(
      reportCache.get(`${token}:${contextReportId}`)?.entry?.value ?? null,
    );
    void loadReport(contextReportId)
      .then((detail) => {
        if (!stale && mounted.current) setContextReport(detail);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [contextReportId, loadReport, token]);

  const contextDocument = contextReport?.report;
  const v5ContextReport = isStockReportV5Document(contextDocument)
    ? contextDocument
    : null;
  const v4ContextReport = contextDocument?.schema_version === 4
    && "report_id" in contextDocument
    && typeof contextDocument.report_id === "string"
    ? contextDocument
    : null;
  const decisionReportId =
    selectedItem?.latest?.kind === "deep_research"
      && selectedItem.latest.reportId === (v5ContextReport?.reportId ?? v4ContextReport?.report_id)
      ? v5ContextReport?.reportId ?? v4ContextReport?.report_id ?? null
      : null;

  useEffect(() => {
    refreshDecisionEvaluation(decisionReportId);
  }, [decisionReportId, refreshDecisionEvaluation, selectedId]);

  const handleManualRefresh = useCallback(() => {
    void refreshQuotes(quoteIdsKey.split(","), true);
    if (decisionReportId) refreshDecisionEvaluation(decisionReportId);
  }, [decisionReportId, quoteIdsKey, refreshDecisionEvaluation, refreshQuotes]);

  const handleRetryKline = useCallback(() => {
    if (selectedId) {
      klineCache.delete(`${token}:${selectedId}:${klinePeriodDef.klt}`);
    }
    setKlineNonce((n) => n + 1);
  }, [selectedId, klinePeriodDef.klt]);

  // 今日复盘状态：最新一份 daily_review 的 asOf 是否为上海时区的今天。
  const latestReview = useMemo(
    () => reports.find((r) => r.kind === "daily_review") ?? null,
    [reports],
  );
  const reviewedToday =
    latestReview?.asOf != null &&
    shanghaiDay(latestReview.asOf) === shanghaiDay(new Date());

  return (
    <div className="relative flex h-full flex-col">
      {bootState === "loading" && (
        <div className="flex flex-1 items-center justify-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          正在加载股票工作台…
        </div>
      )}

      {bootState === "error" && (
        <div className="p-4">
          <StatusNotice
            tone="danger"
            title="自选股加载失败"
            action={
              <Button variant="outline" size="xs" onClick={() => void loadBoot()}>
                重试
              </Button>
            }
          >
            网络或服务暂不可用，请检查连接后重试
          </StatusNotice>
        </div>
      )}

      {bootState === "ready" && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <MarketTickerBar
            quotes={quotes}
            watchCount={items.length}
            activeView={stockMode}
            onViewChange={setStockMode}
            refreshing={quotesLoading}
            onRefresh={handleManualRefresh}
            onOpenSettings={() => onOpenSettings?.()}
            decisionSummaryOpen={decisionSummaryOpen}
            onToggleDecisionSummary={() => setDecisionSummaryOpen((open) => !open)}
          />

          {(quotesStale || actionError) && (
            <div className="shrink-0 space-y-2 border-b px-4 py-2">
              {quotesStale && (
                <StatusNotice tone="warning" title="行情刷新失败">
                  正在显示最近一次行情，恢复后自动更新
                </StatusNotice>
              )}
              {actionError && (
                <StatusNotice
                  tone="danger"
                  title="操作失败"
                  action={
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setActionError(null)}
                    >
                      知道了
                    </Button>
                  }
                >
                  {actionError}
                </StatusNotice>
              )}
            </div>
          )}

          {stockMode === "opportunity" ? (
            <OpportunityDiscovery
              client={client}
              onAddWatchlist={handleAdd}
              onDeepResearch={(instrumentId, origin) => {
                setStockMode("watch");
                void requestPreflight(instrumentId, origin);
              }}
            />
          ) : (
            <>
              <ReviewHeroCard
                latestReview={latestReview}
                reviewedToday={reviewedToday}
                run={run}
                autoReviewEnabled={autoReviewEnabled}
                watchCount={items.length}
                focusCount={items.filter((i) => i.focus).length}
                reviewTime={reviewTime}
                reviewScope={reviewScope}
                onOpenReport={(id) => void handleOpenReport(id)}
              />

              <div
                className={cn(
                  "grid min-h-0 flex-1",
                  watchGridCollapsed
                    ? "grid-cols-[48px_minmax(0,1fr)]"
                    : "grid-cols-1 lg:grid-cols-[34%_66%] xl:grid-cols-[33%_67%] 2xl:grid-cols-[31%_69%]",
                )}
              >
                <WatchGrid
                  items={items}
                  quotes={quotes}
                  signals={watchSignals}
                  selectedId={selectedId}
                  onSelect={(instrumentId) => {
                    setSelectedId(instrumentId);
                    setStageTabRequest((request) => ({ revision: (request?.revision ?? 0) + 1, tab: "market" }));
                  }}
                  onOpenNews={(instrumentId) => {
                    setSelectedId(instrumentId);
                    setStageTabRequest((request) => ({ revision: (request?.revision ?? 0) + 1, tab: "news" }));
                  }}
                  onToggleFocus={(id, focus) => void handleToggleFocus(id, focus)}
                  onRemove={(id) => void handleRemove(id)}
                  onAdd={(input) => void handleAdd(input)}
                  onReorder={(ids) => void handleReorder(ids)}
                  onSearch={searchStocks}
                  collapsed={watchGridCollapsed}
                  onToggleCollapsed={() => setWatchGridCollapsed((collapsed) => !collapsed)}
                />

                {selectedItem ? (
                  <InstrumentStage
                    key={`${selectedItem.instrumentId}:${stageTabRequest?.revision ?? 0}`}
                    token={token}
                    item={selectedItem}
                    quote={selectedQuote}
                    kline={kline}
                    klineState={klineState}
                    period={period}
                    onPeriodChange={setPeriod}
                    onRetryKline={handleRetryKline}
                    run={run}
                    diagnosisRun={diagnosisRun}
                    diagnosisReport={diagnosisReport}
                    diagnosisReports={diagnosisReports}
                    stepActivities={stepActivities}
                    starting={starting}
                    diagnosisStarting={diagnosisStarting}
                    cancellingRun={cancellingRun}
                    diagnosisCancellingRun={diagnosisCancellingRun}
                    onStartRun={() => void handleStartRun()}
                    onCancelRun={() => void handleCancelRun()}
                    onStartDiagnosis={() => void handleStartDiagnosis()}
                    onCancelDiagnosis={() => void handleCancelDiagnosis()}
                    onOpenDiagnosis={(id) => void handleOpenDiagnosis(id)}
                    reports={selectedReports}
                    reportDetail={contextReport}
                    decisionEvaluation={decisionEvaluation}
                    researchContext={researchContext}
                    onOpenReport={(id) => void handleOpenReport(id)}
                    onDeleteReport={(id) => void handleDeleteReport(id)}
                    decisionSummaryOpen={decisionSummaryOpen}
                    initialTab={stageTabRequest?.tab}
                  />
                ) : (
                  <div className="flex min-h-64 items-center justify-center text-caption text-muted-foreground">
                    添加自选标的后开始研究
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeReport && (
        <div className="absolute inset-0 z-10 bg-background">
          <ReportDetail
            activeReport={activeReport}
            onClose={() => setActiveReport(null)}
            onDeleteReport={(id) => void handleDeleteReport(id)}
            onDeepResearch={(id) => {
              setActiveReport(null);
              void requestPreflight(id);
            }}
          />
        </div>
      )}

    </div>
  );
}
