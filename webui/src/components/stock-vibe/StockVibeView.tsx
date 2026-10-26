import { useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import {
  createStockVibeRequestId,
  getStockVibeAttention,
  getStockVibeMarketData,
  getStockVibeWorkbenchMarket,
  getStockVibeRequest,
  getStockVibeStatus,
  listStockVibeJournalSessions,
  StockVibeApiError,
  updateStockVibeAttention,
  type StockVibeAttentionPreferences,
  type StockVibeAttentionRead,
  type StockVibeChartInterval,
  type StockVibeResearchTask,
  type StockVibeRead,
  type StockVibeRequestRecord,
  type StockVibeStatus,
  type StockVibeNativeResearchOrigin,
} from "@/lib/stock-vibe-api";
import { inferStockVibeExchange } from "@/lib/stock-vibe-symbol";
import { readStockVibeMarketSnapshot, saveStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";
import { stockBars, workbenchMarket } from "@/lib/stock-vibe-market";

import { StockVibeOperations } from "./StockVibeOperations";
import { StockVibeOpportunity } from "./StockVibeOpportunity";
import { StockVibeModelSettings } from "./StockVibeModelSettings";
import { StockVibeDataSettings } from "./StockVibeDataSettings";
import { StockVibeAttentionSettings } from "./StockVibeAttentionSettings";
import { StockVibeResearchDialog, type StockVibeResearchTarget } from "./StockVibeResearchDialog";
import type { StockVibeNotificationTarget } from "./StockVibeSavedResearch";
import { StockVibeWorkbench } from "./StockVibeWorkbench";
import { StockVibeMessages } from "./StockVibeMessages";
import { StockVibeBacktest } from "./StockVibeBacktest";
import { StockVibeTeam } from "./StockVibeTeam";
import type { StockVibeNativeResearchContext } from "./StockVibeNativeResearch";
import "./stock-vibe-shell.css";

type Mode = "ultrashort" | "swing" | "medium";
type Tab = "workbench" | "opportunity" | "account";
type Display = { symbols: string[]; selected: string | null; interval: StockVibeChartInterval; mode: Mode };
const DISPLAY_KEY = "mona.stock-vibe.display.v1";
const ATTENTION_PENDING_KEY = "mona.stock-vibe.attention.pending.v1";
const REQUEST_ID_PATTERN = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const SYMBOL_PATTERN = /^\d{6}\.(SH|SZ|BJ)$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATA_SOURCES = new Set(["tencent", "eastmoney"]);
const DEFAULT_ATTENTION: StockVibeAttentionPreferences = {
  proactive_mode: "important_changes",
  watched_symbols: [],
  notification_start: "09:30",
  notification_end: "15:00",
  attention_interval_sec: 900,
  data_sources: ["tencent", "eastmoney"],
};
const tabs: { id: Tab; label: string }[] = [
  { id: "workbench", label: "投资工作台" }, { id: "opportunity", label: "机会选股" },
  { id: "account", label: "账户与复盘" },
];

interface PendingAttentionUpdate {
  requestId: string;
  preferences: StockVibeAttentionPreferences;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAttentionPreferences(value: unknown): value is StockVibeAttentionPreferences {
  if (!isRecord(value)
    || !["manual", "important_changes", "continuous"].includes(String(value.proactive_mode))
    || !Array.isArray(value.watched_symbols)
    || !Array.isArray(value.data_sources)) return false;
  const symbols = value.watched_symbols;
  const sources = value.data_sources;
  const fields = ["proactive_mode", "watched_symbols", "notification_start", "notification_end", "attention_interval_sec", "data_sources"];
  return Object.keys(value).sort().join("|") === [...fields].sort().join("|")
    && symbols.length <= 50
    && symbols.every((symbol) => typeof symbol === "string" && SYMBOL_PATTERN.test(symbol))
    && new Set(symbols).size === symbols.length
    && TIME_PATTERN.test(String(value.notification_start))
    && TIME_PATTERN.test(String(value.notification_end))
    && Number.isInteger(value.attention_interval_sec)
    && Number(value.attention_interval_sec) >= 300
    && Number(value.attention_interval_sec) <= 86_400
    && sources.length >= 1
    && sources.length <= 2
    && sources.every((source) => typeof source === "string" && DATA_SOURCES.has(source))
    && new Set(sources).size === sources.length;
}

function isAttentionRead(value: unknown): value is StockVibeAttentionRead {
  return isRecord(value)
    && isAttentionPreferences(value.preferences)
    && typeof value.execution_allowed === "boolean"
    && (value.runtime === null || isRecord(value.runtime));
}

function readPendingAttention(): PendingAttentionUpdate | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ATTENTION_PENDING_KEY) ?? "null");
    if (!isRecord(value) || typeof value.requestId !== "string"
      || !REQUEST_ID_PATTERN.test(value.requestId) || !isAttentionPreferences(value.preferences)) return null;
    return { requestId: value.requestId, preferences: value.preferences };
  } catch {
    return null;
  }
}

function persistPendingAttention(pending: PendingAttentionUpdate): boolean {
  try {
    window.localStorage.setItem(ATTENTION_PENDING_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

function clearPendingAttention(): void {
  try {
    window.localStorage.removeItem(ATTENTION_PENDING_KEY);
  } catch {
    // In-memory recovery continues even if the local preference store is unavailable.
  }
}

function sameAttentionPreferences(left: StockVibeAttentionPreferences, right: StockVibeAttentionPreferences): boolean {
  return left.proactive_mode === right.proactive_mode
    && left.watched_symbols.length === right.watched_symbols.length
    && left.watched_symbols.every((symbol, index) => symbol === right.watched_symbols[index])
    && left.notification_start === right.notification_start
    && left.notification_end === right.notification_end
    && left.attention_interval_sec === right.attention_interval_sec
    && left.data_sources.length === right.data_sources.length
    && left.data_sources.every((source, index) => source === right.data_sources[index]);
}

function isLocalAttentionReceipt(
  record: StockVibeRequestRecord,
  pending: PendingAttentionUpdate,
  status: "completed" | "rejected",
): boolean {
  const receipt = record.receipt;
  const code = receipt?.status_code;
  if (record.status !== status
    || record.request_id.replace(/-/g, "").toLowerCase() !== pending.requestId.replace(/-/g, "").toLowerCase()
    || record.method !== "PUT"
    || record.path !== "/host/attention"
    || record.receipt_owner !== "mona_settings"
    || record.source !== null
    || !receipt
    || !Number.isInteger(code)
    || typeof record.receipt_sha256 !== "string"
    || !/^[a-f0-9]{64}$/i.test(record.receipt_sha256)
    || !isAttentionPreferences(receipt.body)) return false;
  if (status === "completed" && (code! < 200 || code! >= 300)) return false;
  if (status === "rejected" && (code! < 400 || code! >= 500)) return false;
  return sameAttentionPreferences(receipt.body, pending.preferences);
}

function attentionRuntimeNotice(read: StockVibeAttentionRead, saved: boolean): string {
  const prefix = saved ? "关注设置已保存。" : "关注设置只记录偏好。";
  if (!read.runtime || read.runtime.enabled === false) return `${prefix}后台关注运行态尚未启用。`;
  return `${prefix}已读取后台运行状态；保存偏好本身不会启动服务。`;
}

function normalizeDisplaySymbols(display: Display): Display {
  const normalize = (symbol: string) => {
    const code = symbol.slice(0, 6);
    const exchange = inferStockVibeExchange(code);
    // Existing Shanghai index references overlap Shenzhen stock codes.
    return exchange && !/^000\d{3}\.SH$/.test(symbol) ? `${code}.${exchange}` : symbol;
  };
  const symbols = [...new Set(display.symbols.map(normalize))];
  const selected = display.selected ? normalize(display.selected) : null;
  return selected === display.selected && symbols.length === display.symbols.length
    && symbols.every((symbol, index) => symbol === display.symbols[index])
    ? display : { ...display, symbols, selected };
}

function initialDisplay(): Display {
  const empty: Display = { symbols: [], selected: null, interval: "intraday", mode: "swing" };
  try {
    const value = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "null");
    if (!value || !Array.isArray(value.symbols)) return empty;
    const symbols = [...new Set<string>(value.symbols.filter((s: unknown) => typeof s === "string" && /^[0-9]{6}\.(SH|SZ|BJ)$/.test(s)))];
    return normalizeDisplaySymbols({ symbols, selected: typeof value.selected === "string" && SYMBOL_PATTERN.test(value.selected) ? value.selected : symbols[0] ?? null,
      interval: (value.workbench_version === 2 || value.interval !== "1D") && ["intraday", "1m", "5m", "15m", "30m", "1H", "1D", "1W", "1M"].includes(value.interval) ? value.interval : "intraday",
      mode: ["ultrashort", "swing", "medium"].includes(value.mode) ? value.mode : "swing" });
  } catch {
    return empty;
  }
}

function dayOffset(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function StockVibeView({ onOpenSettings, focusSymbol, onConsumeFocusSymbol, notificationTarget, onConsumeNotification }: {
  onOpenSettings?: () => void; focusSymbol?: string | null; onConsumeFocusSymbol?: () => void;
  notificationTarget?: StockVibeNotificationTarget | null; onConsumeNotification?: () => void;
}) {
  const [display, setDisplay] = useState(initialDisplay);
  const [tab, setTab] = useState<Tab>("workbench");
  const [status, setStatus] = useState<StockVibeStatus | null>(null);
  const [marketRead, setMarketRead] = useState<{ symbol: string; interval: StockVibeChartInterval; result: StockVibeRead } | null>(null);
  const savedMarket = useMemo(() => display.selected ? readStockVibeMarketSnapshot(display.selected, display.interval) : null,
    [display.selected, display.interval]);
  const market = marketRead?.symbol === display.selected && marketRead.interval === display.interval ? marketRead.result : savedMarket;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marketRevision, setMarketRevision] = useState(0);
  const [marketNotice, setMarketNotice] = useState<string | null>(null);
  const [researchTarget, setResearchTarget] = useState<StockVibeResearchTarget | null>(null);
  const [nativeOrigins, setNativeOrigins] = useState<Record<string, StockVibeNativeResearchOrigin>>({});
  const [nativeRunId, setNativeRunId] = useState<string | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [researchRevision, setResearchRevision] = useState(0);
  const [strategyFocusId, setStrategyFocusId] = useState<string | null>(null);
  const journalLookup = useRef(0);
  const [modelOpen, setModelOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const executionAllowed = status?.execution_allowed !== false;
  const modelAvailable = Boolean(status?.model_preset || status?.model_binding);

  useEffect(() => {
    if (!notificationTarget) return;
    setResearchTarget({ symbol: notificationTarget.symbol ?? null, mode: display.mode,
      ...(notificationTarget.session_id && notificationTarget.attempt_id
        ? { saved: { sessionId: notificationTarget.session_id, attemptId: notificationTarget.attempt_id } }
        : { artifactId: notificationTarget.artifact_id }) });
    setResearchOpen(true);
    onConsumeNotification?.();
  }, [notificationTarget, onConsumeNotification]);

  useEffect(() => {
    if (!focusSymbol) return;
    if (/^[0-9]{6}\.(SH|SZ|BJ)$/.test(focusSymbol)) {
      setDisplay((value) => ({ ...value, symbols: value.symbols.includes(focusSymbol) ? value.symbols : [...value.symbols, focusSymbol], selected: focusSymbol }));
      setTab("workbench");
    }
    onConsumeFocusSymbol?.();
  }, [focusSymbol, onConsumeFocusSymbol]);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [attentionSaving, setAttentionSaving] = useState(false);
  const [attentionValue, setAttentionValue] = useState<StockVibeAttentionPreferences>(DEFAULT_ATTENTION);
  const [attentionPending, setAttentionPending] = useState<PendingAttentionUpdate | null>(readPendingAttention);
  const attentionPendingRef = useRef(attentionPending);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [attentionNotice, setAttentionNotice] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    getStockVibeStatus().then((value) => { if (!disposed) setStatus(value); }).catch((reason) => {
      if (!disposed) {
        setError(reason instanceof StockVibeApiError ? reason.message : "未能读取股票服务状态，请稍后重新打开。");
      }
    });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const normalized = normalizeDisplaySymbols(display);
    if (normalized !== display) {
      setDisplay(normalized);
      return;
    }
    try { localStorage.setItem(DISPLAY_KEY, JSON.stringify({ ...display, workbench_version: 2 })); } catch { /* Display preferences only. */ }
  }, [display]);

  useEffect(() => {
    setMarketNotice(null);
    if (!display.selected || tab !== "workbench") { setLoading(false); return; }
    let disposed = false, reading = false;
    const symbol = display.selected, interval = display.interval;
    let hasMarket = stockBars(market, symbol, interval).bars.length > 0;
    if (hasMarket) setMarketNotice("正在更新行情，当前显示上次数据。");
    const load = async (initial: boolean) => {
      if (reading) return;
      reading = true;
      if (initial) setLoading(true);
      try {
        const end = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
        const days = interval === "1M" ? 1825 : interval === "1W" ? 730 : 14;
        const result = interval === "intraday" || interval === "1D" ? await getStockVibeWorkbenchMarket(symbol, interval)
          : await getStockVibeMarketData({ symbol, interval, start_date: dayOffset(end, -days), end_date: end });
        if (disposed) return;
        const available = stockBars(result, symbol, interval).bars.length > 0
          && (!(interval === "intraday" || interval === "1D") || workbenchMarket(result, symbol)?.status === "ok");
        if (!available && hasMarket) {
          setMarketNotice("本次行情未能刷新，图中保留上次数据，请留意数据时点。");
          return;
        }
        if (available) { saveStockVibeMarketSnapshot(symbol, interval, result); hasMarket = true; }
        setMarketRead({ symbol, interval, result }); setMarketNotice(null);
      } catch (reason) {
        if (!disposed) {
          if (initial && !hasMarket) setError(reason instanceof StockVibeApiError ? reason.message : "未能取得所选区间的行情。");
          else setMarketNotice("本次行情未能刷新，图中保留上次数据，请留意数据时点。");
        }
      } finally { reading = false; if (!disposed) setLoading(false); }
    };
    void load(true);
    const visible = () => { if (document.visibilityState === "visible") void load(false); };
    const timer = interval === "intraday" ? window.setInterval(() => {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      if (document.visibilityState === "visible" && time >= "09:25" && time <= "15:05") void load(false);
    }, 30000) : undefined;
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [display.selected, display.interval, tab, marketRevision]);

  const setPendingAttention = (pending: PendingAttentionUpdate | null) => {
    attentionPendingRef.current = pending;
    setAttentionPending(pending);
  };

  const clearAttentionPending = () => {
    clearPendingAttention();
    setPendingAttention(null);
  };

  const refreshAttention = async (saved: boolean): Promise<StockVibeAttentionRead> => {
    const result: unknown = await getStockVibeAttention();
    if (!isAttentionRead(result)) throw new StockVibeApiError(0, "invalid_response");
    setAttentionValue(result.preferences);
    setAttentionNotice(attentionRuntimeNotice(result, saved));
    return result;
  };

  const finishAttentionSave = async (pending: PendingAttentionUpdate) => {
    clearAttentionPending();
    setAttentionValue(pending.preferences);
    setAttentionError(null);
    setAttentionOpen(false);
    try {
      await refreshAttention(true);
    } catch {
      setAttentionNotice("关注设置已确认保存，但暂时无法读取后台状态。保存偏好本身不会启动服务。");
    }
  };

  const processAttentionRecord = async (
    record: StockVibeRequestRecord,
    pending: PendingAttentionUpdate,
  ): Promise<"completed" | "rejected" | "unconfirmed"> => {
    if (isLocalAttentionReceipt(record, pending, "completed")) {
      await finishAttentionSave(pending);
      return "completed";
    }
    if (isLocalAttentionReceipt(record, pending, "rejected")) {
      clearAttentionPending();
      setAttentionError("这次关注设置被拒绝。你可以修改后手动再次保存。");
      return "rejected";
    }
    setPendingAttention(pending);
    setAttentionError("上次保存结果仍未确认。系统只查询回执，没有重新提交；关闭并重新打开此窗口可再次核对。");
    return "unconfirmed";
  };

  const reconcileAttention = async (
    pending: PendingAttentionUpdate,
  ): Promise<"completed" | "rejected" | "unconfirmed" | "not_found"> => {
    try {
      const record = await getStockVibeRequest(pending.requestId);
      return processAttentionRecord(record, pending);
    } catch (reason) {
      if (reason instanceof StockVibeApiError && reason.status === 404) {
        clearAttentionPending();
        setAttentionError("没有找到上次保存的回执，本次结果无法确认；系统不会自动重发。检查后可由你手动保存。");
        return "not_found";
      }
      setPendingAttention(pending);
      setAttentionError("暂时无法核对上次保存状态。系统没有重发；关闭并重新打开此窗口可再次查询回执。");
      return "unconfirmed";
    }
  };

  const openAttentionSettings = async () => {
    setAttentionLoading(true);
    setAttentionError(null);
    try {
      const pending = attentionPendingRef.current;
      const outcome = pending ? await reconcileAttention(pending) : null;
      const current: unknown = await getStockVibeAttention();
      if (!isAttentionRead(current)) throw new StockVibeApiError(0, "invalid_response");
      setAttentionValue(current.preferences);
      setAttentionNotice(attentionRuntimeNotice(current, outcome === "completed"));
      setAttentionOpen(true);
    } catch (reason) {
      setError(reason instanceof StockVibeApiError
        ? reason.message
        : "无法读取关注设置，请检查股票服务状态后重试。");
    } finally {
      setAttentionLoading(false);
    }
  };

  const saveAttention = async (value: StockVibeAttentionPreferences) => {
    if (attentionPendingRef.current) {
      setAttentionError("上次保存结果尚未确认。请先关闭并重新打开窗口查询回执；系统不会重发旧请求。");
      return;
    }
    setAttentionError(null);
    if (value.data_sources.length === 0) {
      setAttentionError("至少选择腾讯或东方财富作为数据源偏好。");
      return;
    }
    const preferences: StockVibeAttentionPreferences = {
      proactive_mode: value.proactive_mode,
      watched_symbols: [...value.watched_symbols],
      notification_start: value.notification_start,
      notification_end: value.notification_end,
      attention_interval_sec: value.attention_interval_sec,
      data_sources: [...value.data_sources],
    };
    if (!isAttentionPreferences(preferences)) {
      setAttentionError("关注设置内容无效，请检查时间、代码和数据源选择。");
      return;
    }
    const pending: PendingAttentionUpdate = {
      requestId: createStockVibeRequestId(),
      preferences,
    };
    if (!persistPendingAttention(pending)) {
      setAttentionError("无法安全保存请求核对信息，因此没有提交关注设置。");
      return;
    }
    setPendingAttention(pending);
    setAttentionSaving(true);
    try {
      const record = await updateStockVibeAttention(pending.requestId, preferences);
      const outcome = await processAttentionRecord(record, pending);
      if (outcome === "unconfirmed") await reconcileAttention(pending);
    } catch {
      await reconcileAttention(pending);
    } finally {
      setAttentionSaving(false);
    }
  };

  const openResearch = (symbol: string, task: StockVibeResearchTask = "comprehensive",
    resume?: { sessionId: string; attemptId?: string; mode?: Mode; readOnly?: boolean }, origin?: StockVibeNativeResearchOrigin) => {
    setResearchTarget({ symbol, task, mode: resume?.mode ?? display.mode, originalScope: Boolean(resume?.mode),
      ...(!resume && (origin ?? nativeOrigins[symbol]) ? { nativeResearch: origin ?? nativeOrigins[symbol] } : {}),
      ...(resume?.readOnly && resume.attemptId ? { saved: { sessionId: resume.sessionId, attemptId: resume.attemptId } }
        : resume ? { resume: { sessionId: resume.sessionId, attemptId: resume.attemptId } } : {}) });
    setResearchOpen(true);
  };

  return <div data-workbench={tab === "workbench" || undefined} data-opportunity={tab === "opportunity" || undefined} data-account={tab === "account" || undefined} className={`stock-vibe-page scrollbar-scope flex h-full min-h-0 min-w-0 flex-col p-5 ${tab === "opportunity" ? "gap-3 overflow-hidden" : "gap-5 overflow-auto"}`}>
    <header className={`stock-vibe-header flex flex-wrap items-center justify-between gap-3 ${tab === "opportunity" ? "stock-vibe-header--opportunity shrink-0" : ""}`}>
      <div className="flex min-w-0 items-center gap-6">
        <nav className="flex items-center gap-4" aria-label="股票功能">
          {tabs.map((item) => <Button key={item.id} variant="ghost" className="stock-vibe-tab" data-active={tab === item.id}
            aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>{item.label}</Button>)}
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {tab !== "account" && <label className="flex items-center gap-1.5 text-caption text-muted-foreground">投资风格
          <select className="stock-vibe-mode-select text-ui" value={display.mode}
            onChange={(event) => setDisplay((value) => ({ ...value, mode: event.target.value as Mode }))}>
            <option value="ultrashort">超短线</option><option value="swing">波段</option><option value="medium">中短线</option>
          </select>
        </label>}
        <Button variant="ghost" disabled={attentionLoading || attentionSaving} onClick={() => { void openAttentionSettings(); }}>
          {attentionLoading ? "正在读取关注设置…" : "关注与提醒"}
        </Button>
        <StockVibeMessages onError={setError} onOpen={(target) => {
          setResearchTarget({ symbol: target.symbol ?? null, mode: display.mode,
            ...(target.session_id && target.attempt_id ? { saved: { sessionId: target.session_id, attemptId: target.attempt_id } }
              : { artifactId: target.artifact_id }) });
          setResearchOpen(true);
        }} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="更多设置"><MoreHorizontal size={16} /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setModelOpen(true)}>研究模型</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDataOpen(true)}>行情数据</DropdownMenuItem>
            <DropdownMenuItem disabled={!display.selected} onSelect={() => setTeamOpen(true)}>行情证据复核</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {attentionPending && <p role="status" className="text-caption text-muted-foreground">
      有一项关注设置等待回执核对。打开“关注与提醒”只会查询状态，不会重新提交。
    </p>}
    {attentionNotice && <p role="status" className="text-caption text-muted-foreground">{attentionNotice}</p>}
    <main className={`min-h-0 min-w-0 flex-1 ${tab === "opportunity" ? "overflow-hidden" : ""}`}>
        {tab === "workbench" && <StockVibeWorkbench symbols={display.symbols} selectedSymbol={display.selected}
          interval={display.interval} market={market} loading={loading} mode={display.mode} researchRevision={researchRevision} marketNotice={marketNotice} onError={setError}
          onSelect={(selected) => setDisplay((value) => ({ ...value, selected }))}
          onAdd={(symbol) => setDisplay((value) => ({ ...value, symbols: [...value.symbols, symbol], selected: symbol }))}
          onReorder={(symbols) => setDisplay((value) => ({ ...value, symbols }))}
          onAsk={(symbol, question) => { setResearchTarget({ symbol, mode: display.mode, question, autoSubmit: true }); setResearchOpen(true); }}
          onRemove={(symbol) => setDisplay((value) => {
            const symbols = value.symbols.filter((item) => item !== symbol);
            return { ...value, symbols, selected: value.selected === symbol ? symbols[0] ?? null : value.selected };
          })}
          onInterval={(interval) => setDisplay((value) => ({ ...value, interval }))}
          onRefresh={() => setMarketRevision((value) => value + 1)}
          onAccount={() => setTab("account")}
          nativeOrigin={display.selected ? nativeOrigins[display.selected] : undefined}
          onOpenBacktestRun={setNativeRunId}
          onResearch={openResearch} />}
        {tab === "opportunity" && <StockVibeOpportunity mode={display.mode} symbols={display.symbols}
          catalogRevision={researchRevision}
          focusStrategyId={strategyFocusId}
          onCreateStrategy={() => {
            setResearchTarget({ symbol: null, mode: display.mode, strategyCreation: true, strategyDraftId: createStockVibeRequestId() });
            setResearchOpen(true);
          }}
          onModifyStrategy={(strategy) => {
            if (strategy.source !== "custom" || strategy.deleted) return;
            setResearchTarget({ symbol: null, mode: display.mode, strategyCreation: true, strategyDraftId: createStockVibeRequestId(), strategyName: strategy.name,
              nativeResearch: { strategy_id: strategy.strategy_id, strategy_version: strategy.version } });
            setResearchOpen(true);
          }}
          onStrategyMarket={(symbol, context) => {
            if (context) setNativeOrigins((value) => ({ ...value, [symbol]: context }));
            setDisplay((value) => ({ ...value, selected: symbol, interval: "intraday" })); setTab("workbench");
          }}
          onStrategyResearch={(symbol, context) => {
            if (context) setNativeOrigins((value) => ({ ...value, [symbol]: context }));
            openResearch(symbol, "comprehensive", undefined, context);
          }}
          enabled={executionAllowed} modelAvailable={Boolean(status?.model_preset || status?.model_binding)} onError={setError}
          onOpenModel={() => setModelOpen(true)}
          onOpenDataSettings={() => setDataOpen(true)}
          onOpenWorkbench={() => setTab("workbench")}
          onAdd={(symbol) => setDisplay((value) => ({ ...value, symbols: value.symbols.includes(symbol) ? value.symbols : [...value.symbols, symbol] }))}
          onMarket={(symbol, context?: StockVibeNativeResearchContext) => {
            if (context) setNativeOrigins((value) => ({ ...value, [symbol]: { swarm_id: context.swarmId, ...(context.taskId ? { task_id: context.taskId } : {}), symbol } }));
            setDisplay((value) => ({ ...value, selected: symbol, interval: "intraday" })); setTab("workbench");
          }}
          onResearch={(symbol, context?: StockVibeNativeResearchContext) => {
            const origin = context ? { swarm_id: context.swarmId, ...(context.taskId ? { task_id: context.taskId } : {}), symbol } : undefined;
            if (origin) setNativeOrigins((value) => ({ ...value, [symbol]: origin }));
            openResearch(symbol, "comprehensive", undefined, origin);
          }}
          onReuseStrategy={(strategyId) => {
            setResearchTarget({ symbol: null, mode: display.mode, nativeResearch: { strategy_id: strategyId },
              question: "我想复用这个已有策略。请先说明已有证据和可调整范围，再沿原生流程补齐必要条件并研究验证，保留本次真实结果。" });
            setResearchOpen(true);
          }}
          onSaveStrategy={(context) => {
            setResearchTarget({ symbol: null, mode: display.mode,
              nativeResearch: { swarm_id: context.swarmId, ...(context.taskId ? { task_id: context.taskId } : {}) },
              question: "请将这次研究中已经生成的策略按原生流程登记，关联真实代码、设置和已完成的回测证据，方便以后查找和复用。缺少登记所需信息时请明确说明，不要复制或编造历史绩效。" });
            setResearchOpen(true);
          }} />}
        {tab === "account" && <StockVibeOperations enabled={executionAllowed} onReviewQuestion={(input) => {
          const lookup = ++journalLookup.current;
          void listStockVibeJournalSessions(input.operationId).then(({ native }) => {
            if (journalLookup.current !== lookup) return;
            if (!Array.isArray(native) || native.some((value) => !value || typeof value !== "object"
              || value.journal_operation_id !== input.operationId || typeof value.session_id !== "string")) {
              throw new Error("invalid review research");
            }
            setResearchTarget({ symbol: null, mode: display.mode, journalOperationId: input.operationId,
              journalFilename: input.filename, question: input.question,
              ...(native[0] ? { resume: { sessionId: native[0].session_id } } : {}) });
            setResearchOpen(true);
          }).catch(() => { if (journalLookup.current === lookup) setError("暂时无法核对这份复盘的解读记录，请稍后重试。"); });
        }} />}
    </main>
    <StockVibeResearchDialog target={researchTarget} open={researchOpen} onOpenChange={setResearchOpen}
      onStrategyRegistered={(id) => { setStrategyFocusId(id); setResearchRevision((value) => value + 1); }}
      onOpenStrategy={(id) => { setStrategyFocusId(id); setTab("opportunity"); setResearchOpen(false); }}
      enabled={executionAllowed} modelAvailable={modelAvailable} onOpenModel={() => setModelOpen(true)}
      onChanged={() => setResearchRevision((value) => value + 1)} />
    <Dialog open={teamOpen} onOpenChange={setTeamOpen}>
      <DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[88dvh] max-w-4xl overflow-y-auto">
        <DialogHeader><DialogTitle>行情证据复核{display.selected ? ` · ${display.selected.slice(0, 6)}` : ""}</DialogTitle></DialogHeader>
        {teamOpen && display.selected && <StockVibeTeam symbol={display.selected} mode={display.mode}
          enabled={executionAllowed && modelAvailable} />}
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(nativeRunId)} onOpenChange={(open) => { if (!open) setNativeRunId(null); }}>
      <DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[88dvh] max-w-4xl overflow-y-auto">
        <DialogHeader><DialogTitle>关联策略回测</DialogTitle></DialogHeader>
        {nativeRunId && <StockVibeBacktest symbols={display.symbols} initialRunId={nativeRunId} onError={setError} />}
      </DialogContent>
    </Dialog>
    <AlertDialog open={error !== null} onOpenChange={(open) => { if (!open) setError(null); }}>
      <AlertDialogContent className="scrollbar-scope"><AlertDialogHeader><AlertDialogTitle>股票操作未能完成</AlertDialogTitle>
        <AlertDialogDescription>{error}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel onClick={() => setError(null)}>知道了</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <StockVibeModelSettings open={modelOpen} onOpenChange={setModelOpen} onOpenEngineSettings={onOpenSettings}
      onSaved={() => { void getStockVibeStatus().then(setStatus).catch(() => setError("模型设置已提交，但暂时无法读取当前状态。")); }} />
    <Dialog open={dataOpen} onOpenChange={setDataOpen}>
      <DialogContent aria-describedby={undefined} className="scrollbar-scope">
        <DialogHeader><DialogTitle>行情数据</DialogTitle></DialogHeader>
        {dataOpen && <StockVibeDataSettings onError={setError} />}
      </DialogContent>
    </Dialog>
    <StockVibeAttentionSettings
      open={attentionOpen}
      onOpenChange={setAttentionOpen}
      value={attentionValue}
      saving={attentionSaving}
      onSave={saveAttention}
      error={attentionError ?? undefined}
    />
  </div>;
}
