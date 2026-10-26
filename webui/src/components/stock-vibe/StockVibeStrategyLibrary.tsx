import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Play, Search, SlidersHorizontal, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { createStockVibeRequestId, getStockVibeOperation, getStockVibeRequest, listStockVibeSwarmRuns, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import { getStockVibeBacktestDefaults, stockVibeBacktestSettings, type StockVibeBacktestDefaults, type StockVibeBacktestSettings, type StockVibeStrategyScope } from "@/lib/stock-vibe-backtest-api";
import {
  getStockVibeLibraryStrategy, getStockVibeStrategyHistory, getStockVibeStrategyLibrary, getStockVibeStrategyIndustries,
  deleteStockVibeLibraryStrategy, parseStockVibeStrategyDeleteOperation, stockVibeStrategyDeleteConfirmed,
  parseStockVibeStrategyOperation, startStockVibeStrategyScan, stockVibeStrategyScanResult, validStockVibeStrategyId,
  stockVibeBuiltinStrategies, stockVibeBuiltinStrategy,
  type StockVibeLibraryStrategy, type StockVibeLibraryStrategyDetail, type StockVibeStrategyContext,
  type StockVibeStrategyOperation, type StockVibeStrategyIndustries,
} from "@/lib/stock-vibe-strategy-library-api";
import { StockVibeBacktest } from "./StockVibeBacktest";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeOpportunityArchive } from "./StockVibeOpportunityArchive";
import { StockVibeNativeResearchDetails } from "./StockVibeNativeResearch";
import "./stock-vibe-strategy-library.css";

export interface StockVibeStrategyLibraryProps {
  symbols: string[]; enabled: boolean; mode?: "ultrashort" | "swing" | "medium"; catalogRevision?: number; focusStrategyId?: string | null;
  onError: (message: string) => void; onAdd: (symbol: string) => void;
  onMarket: (symbol: string, context?: StockVibeStrategyContext) => void;
  onResearch: (symbol: string, context?: StockVibeStrategyContext) => void;
  onCreateStrategy?: () => void; onModifyStrategy?: (strategy: StockVibeLibraryStrategyDetail) => void;
  onOpenDataSettings?: () => void;
  onOpenWorkbench?: () => void;
}
interface PendingScan { requestId: string; strategyId: string; version: string; operationId?: string; }
interface PendingDelete extends PendingScan { name: string; }
const PENDING_KEY = "mona.stock-vibe.strategy-scan-pending.v1", SELECTED_KEY = "mona.stock-vibe.selected-strategy.v1";
const DELETE_PENDING_KEY = "mona.stock-vibe.strategy-delete-pending.v1";
const REQUEST_ID = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const STATUS: Record<string, string> = { queued: "等待开始", running: "运行中", completed: "已完成", failed: "未完成", interrupted: "已中断", cancelled: "已停止" };
const MARKET = { china_a: "中国A股", options: "期权", multi_asset: "多资产" };
const STYLE_LABEL = { ultrashort: "超短线", swing: "波段", medium: "中短线" } as const;
const PARAMETER: Record<string, string> = { top_n: "持股数", momentum_window: "动量观察期", vol_window: "波动观察期", volatility_window: "波动观察期", rebalance_period: "调仓间隔", rebalance_days: "调仓间隔", rebalance_freq: "调仓间隔" };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const format = (value: unknown) => value === null || value === undefined || value === "" ? "未提供" : typeof value === "object" ? JSON.stringify(value) : String(value);
function historyTime(value?: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : undefined; }
function storedSelection() { try { const value = localStorage.getItem(SELECTED_KEY); return validStockVibeStrategyId(value) ? value : null; } catch { return null; } }
function storedScan(): PendingScan | null {
  try { const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null"); return object(value) && typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)
    && validStockVibeStrategyId(value.strategyId) && typeof value.version === "string" && /^[a-f\d]{64}$/i.test(value.version)
    && (value.operationId === undefined || typeof value.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operationId)) ? value as unknown as PendingScan : null; } catch { return null; }
}
function saveScan(value: PendingScan | null) { if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value)); else localStorage.removeItem(PENDING_KEY); }
function storedDelete(): PendingDelete | null {
  try { const value = JSON.parse(localStorage.getItem(DELETE_PENDING_KEY) ?? "null"); return object(value) && typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)
    && validStockVibeStrategyId(value.strategyId) && value.strategyId.startsWith("sdm:") && typeof value.version === "string" && /^[a-f\d]{64}$/i.test(value.version)
    && typeof value.name === "string" && (value.operationId === undefined || typeof value.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operationId)) ? value as unknown as PendingDelete : null; } catch { return null; }
}
function saveDelete(value: PendingDelete | null) { if (value) localStorage.setItem(DELETE_PENDING_KEY, JSON.stringify(value)); else localStorage.removeItem(DELETE_PENDING_KEY); }
function operationStrategy(row: StockVibeStrategyOperation) { return row.references?.strategy_id ?? row.payload?.strategy_id; }
function operationVersion(row: StockVibeStrategyOperation) { return row.references?.strategy_version ?? row.payload?.strategy_version; }
function strategyParameters(strategy: StockVibeLibraryStrategyDetail | null) { return Object.fromEntries((strategy?.parameters ?? []).filter((item) => item.editable && typeof item.value === "number").map((item) => [item.name, item.value as number])); }
function initialStrategySelection() {
  const saved = storedSelection();
  if (saved?.startsWith("sdm:")) return { id: saved, detail: null };
  const rows = stockVibeBuiltinStrategies();
  const detail = rows.find((item) => item.strategy_id === saved) ?? rows.find((item) => item.can_scan) ?? rows[0] ?? null;
  return { id: detail?.strategy_id ?? null, detail };
}

function OldResearch({ onError, onOpenRun }: { onError: (message: string) => void; onOpenRun: (id: string) => void }) {
  const [rows, setRows] = useState<Array<{ id: string; preset_name: string; created_at?: string }>>([]), [selected, setSelected] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const error = useRef(onError); error.current = onError;
  useEffect(() => { let active = true; void listStockVibeSwarmRuns(100).then(({ native }) => { const items = Array.isArray(native) ? native : object(native) && Array.isArray(native.runs) ? native.runs : []; if (active) setRows(items.filter((row): row is typeof rows[number] => object(row) && typeof row.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.id) && typeof row.preset_name === "string")); }).catch(() => { if (active) error.current("旧研究记录暂时无法读取，请稍后重新打开。"); }).finally(() => { if (active) setLoaded(true); }); return () => { active = false; }; }, []);
  return selected ? <><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>返回旧研究记录</Button><StockVibeNativeResearchDetails swarmId={selected} onError={onError} onOpenBacktestRun={onOpenRun} /></> : <div className="space-y-2"><p className="text-muted-foreground">最近100条旧研究记录，查看不会重新执行。</p>{!loaded ? <p role="status">正在读取旧研究…</p> : !rows.length ? <p>没有旧研究记录。</p> : rows.map((row) => <Button type="button" variant="ghost" className="w-full justify-between" key={row.id} onClick={() => setSelected(row.id)}><span>研究记录</span><span>{historyTime(row.created_at) ?? "日期未提供"}</span></Button>)}</div>;
}

export function StockVibeStrategyLibrary({ symbols, enabled, mode = "ultrashort", catalogRevision, focusStrategyId, onError, onAdd, onMarket, onResearch, onCreateStrategy, onModifyStrategy, onOpenDataSettings, onOpenWorkbench }: StockVibeStrategyLibraryProps) {
  const [initialSelection] = useState(initialStrategySelection);
  const [customPage, setCustomPage] = useState<{ items: StockVibeLibraryStrategy[]; total: number; key: string }>({ items: [], total: 0, key: "" }), [offset, setOffset] = useState(0), [loading, setLoading] = useState(false), [catalogFailed, setCatalogFailed] = useState(false);
  const [q, setQ] = useState(""), [catalogQuery, setCatalogQuery] = useState(""), [source, setSource] = useState<"all" | "builtin" | "custom">("all"), [market, setMarket] = useState<"china_a" | "all">("china_a");
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection.id), [detail, setDetail] = useState<StockVibeLibraryStrategyDetail | null>(initialSelection.detail), [detailLoading, setDetailLoading] = useState(initialSelection.id?.startsWith("sdm:") ?? false);
  const [detailFailed, setDetailFailed] = useState(false), [detailRequest, setDetailRequest] = useState(0);
  const [tab, setTab] = useState("selection"), [backtestVisited, setBacktestVisited] = useState(false), [backtestRunId, setBacktestRunId] = useState<string | undefined>();
  const [defaults, setDefaults] = useState<StockVibeBacktestDefaults | null>(null), [parameters, setParameters] = useState<Record<string, number>>(() => strategyParameters(initialSelection.detail)), [scanSource, setScanSource] = useState("");
  const [cutoff, setCutoff] = useState("latest"), [date, setDate] = useState(""), [fieldError, setFieldError] = useState("");
  const [scopeKind, setScopeKind] = useState<StockVibeStrategyScope["kind"]>("all_a"), [industryCode, setIndustryCode] = useState(""), [industrySearch, setIndustrySearch] = useState("");
  const [industries, setIndustries] = useState<StockVibeStrategyIndustries | null>(null), [industriesLoading, setIndustriesLoading] = useState(false), [industryRequest, setIndustryRequest] = useState(0);
  const [industriesFailed, setIndustriesFailed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StockVibeLibraryStrategyDetail | null>(null);
  const [deletePending, setDeletePending] = useState<PendingDelete | null>(storedDelete), [catalogRefresh, setCatalogRefresh] = useState(0);
  const [pending, setPending] = useState<PendingScan | null>(storedScan), [submitting, setSubmitting] = useState(false), [operations, setOperations] = useState<Record<string, StockVibeStrategyOperation>>({}), [revision, setRevision] = useState(0), [viewedScan, setViewedScan] = useState<StockVibeStrategyOperation | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [historyScope, setHistoryScope] = useState("current"), [historyPane, setHistoryPane] = useState("runs"), [historyOffset, setHistoryOffset] = useState(0), [history, setHistory] = useState<StockVibeStrategyOperation[]>([]), [historyTotal, setHistoryTotal] = useState(0), [historyLoaded, setHistoryLoaded] = useState(false);
  const errorsSeen = useRef(new Set<string>()), error = useRef(onError), dispatching = useRef(false), focused = useRef<string | null>(null); error.current = onError;
  const historyTarget = useRef<{ strategyId: string; runId?: string; scan?: StockVibeStrategyOperation } | null>(null);
  const loadedStrategyVersion = useRef(initialSelection.detail ? `${initialSelection.detail.strategy_id}:${initialSelection.detail.version}` : "");
  const mounted = useRef(false), defaultsRequest = useRef<Promise<StockVibeBacktestDefaults> | null>(null);
  const deleteDispatching = useRef(false), confirmedDeleted = useRef(new Set<string>());
  const notify = useCallback((key: string, message: string) => { if (!errorsSeen.current.has(key)) { errorsSeen.current.add(key); error.current(message); } }, []);
  const fixedStrategy = useMemo(() => selectedId?.startsWith("builtin:") ? stockVibeBuiltinStrategy(selectedId) : null, [selectedId]);
  const strategy = fixedStrategy ?? (detail?.strategy_id === selectedId ? detail : null);
  const deletingThis = Boolean(strategy && deletePending?.strategyId === strategy.strategy_id);
  const selectionKey = strategy ? `${strategy.strategy_id}:${strategy.version}` : "";
  const launchableSelection = useRef<string | null>(null);
  launchableSelection.current = strategy?.can_scan && !strategy.deleted && !deletingThis && enabled && !pending ? selectionKey : null;
  const queryPending = q.trim() !== catalogQuery.trim(), pageOffset = queryPending ? 0 : offset;
  const builtinRows = useMemo(() => source === "custom" ? [] : stockVibeBuiltinStrategies({ q, market }), [q, market, source]);
  const requestBuiltinCount = useMemo(() => source === "custom" ? 0 : stockVibeBuiltinStrategies({ q: catalogQuery, market }).length, [catalogQuery, market, source]);
  const customOffset = Math.max(0, offset - requestBuiltinCount);
  const catalogKey = JSON.stringify([catalogQuery.trim(), market, customOffset, catalogRevision ?? 0, catalogRefresh]);
  const customReady = source !== "builtin" && customPage.key === catalogKey && !queryPending;
  const items = useMemo(() => {
    const fixed = builtinRows.slice(pageOffset, pageOffset + 20);
    const custom = customReady ? customPage.items.filter((item) => item.source === "custom" && !item.deleted && !confirmedDeleted.current.has(item.strategy_id)) : [];
    return [...fixed, ...custom.slice(0, 20 - fixed.length)];
  }, [builtinRows, pageOffset, customReady, customPage, catalogRefresh]);
  const total = builtinRows.length + (customReady ? customPage.total : 0);
  const catalogComplete = source === "builtin" || customReady;
  const loadDefaults = useCallback(() => {
    if (defaults) return Promise.resolve(defaults);
    if (!defaultsRequest.current) defaultsRequest.current = getStockVibeBacktestDefaults().then((value) => { if (mounted.current) setDefaults(value); return value; }).finally(() => { defaultsRequest.current = null; });
    return defaultsRequest.current;
  }, [defaults]);
  const selectedIndustry = industries?.items.find((item) => item.code === industryCode);
  const filteredIndustries = (industries?.items ?? []).filter((item) => item.name.toLowerCase().includes(industrySearch.trim().toLowerCase()));
  const scopeSelection: StockVibeStrategyScope = scopeKind === "industry" ? { kind: "industry", industry_code: industryCode } : scopeKind === "watchlist" ? { kind: "watchlist", codes: [...symbols] } : { kind: "all_a" };
  const scopeLabel = scopeKind === "industry" ? selectedIndustry ? `行业 · ${selectedIndustry.name}` : "行业（未选择）" : scopeKind === "watchlist" ? `我的自选（${symbols.length}只）` : "全A股";
  const scopeIssue = scopeKind === "industry" && !selectedIndustry ? "请选择具体行业。" : scopeKind === "watchlist" && !symbols.length ? "请先到投资工作台添加自选股票。" : "";
  const industryUnavailable = scopeKind === "industry" && (industriesLoading || industriesFailed);
  const operation = viewedScan && operationStrategy(viewedScan) === selectedId ? viewedScan : operations[selectionKey], result = operation ? stockVibeStrategyScanResult(operation) : null;
  const resultScope = result?.scope ?? operation?.references?.scope, coverage = result?.coverage ?? operation?.references?.coverage;
  const historicalCodes = operation?.payload?.settings?.codes ?? operation?.references?.effective_config?.codes;
  const resultScopeLabel = resultScope ? `${resultScope.kind === "all_a" ? "全A股" : resultScope.kind === "industry" ? `行业 · ${resultScope.industry_name ?? "名称未记录"}` : "我的自选"}（${resultScope.count}只）` : historicalCodes?.length ? `历史记录范围（${historicalCodes.length}只）` : "历史范围未记录";
  const scope = strategy && operation ? { strategy_id: strategy.strategy_id, strategy_version: result?.strategy_version ?? strategy.version, operation_id: operation.operation_id } : undefined;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!focusStrategyId || focused.current === focusStrategyId) return; focused.current = focusStrategyId; setSelectedId(focusStrategyId); setQ(""); setCatalogQuery(""); setSource("all"); setMarket("all"); setOffset(0); }, [focusStrategyId]);
  useEffect(() => {
    if (q === catalogQuery) return;
    const timer = window.setTimeout(() => { setCatalogQuery(q); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [q, catalogQuery]);
  useEffect(() => {
    if (source === "builtin") { setLoading(false); return; }
    let active = true; setLoading(true); setCatalogFailed(false);
    void getStockVibeStrategyLibrary({ q: catalogQuery, source: "custom", market, offset: customOffset, limit: 20 }).then((page) => { if (!active) return; const combinedTotal = requestBuiltinCount + page.total; if (offset > 0 && offset >= combinedTotal) { setOffset(Math.max(0, Math.floor((combinedTotal - 1) / 20) * 20)); return; } setCustomPage({ items: page.items, total: page.total, key: catalogKey }); })
      .catch(() => { if (active) { setCatalogFailed(true); if (source === "custom") notify(`catalog:${catalogKey}`, "自定义策略暂时无法读取，可点击“重新读取自定义策略”重试。"); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [catalogQuery, source, market, offset, customOffset, requestBuiltinCount, catalogKey, notify]);
  useEffect(() => {
    if (focused.current === selectedId && focused.current !== null || items.some((item) => item.strategy_id === selectedId)) return;
    if (!catalogComplete && (selectedId?.startsWith("sdm:") || !items.length)) return;
    setSelectedId((items.find((item) => item.can_scan) ?? items[0])?.strategy_id ?? null);
  }, [items, selectedId, catalogComplete, source]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailFailed(false); return; }
    try { localStorage.setItem(SELECTED_KEY, selectedId); } catch { /* Display preference is optional; execution recovery is persisted separately. */ }
    let active = true; setDetailLoading(!selectedId.startsWith("builtin:") && detail?.strategy_id !== selectedId); setDetailFailed(false);
    const applyDetail = (value: StockVibeLibraryStrategyDetail) => {
      if (!active) return;
      const identity = `${value.strategy_id}:${value.version}`;
      if (loadedStrategyVersion.current !== identity) {
        loadedStrategyVersion.current = identity; setFieldError(""); setBacktestRunId(undefined); setBacktestVisited(false); setViewedScan(null); setTab("selection"); setScanSource("");
        setParameters(strategyParameters(value));
      }
      setDetail(value);
      const target = historyTarget.current;
      if (target?.strategyId === selectedId) {
        if (target.runId) { setBacktestRunId(target.runId); setBacktestVisited(true); setTab("backtest"); }
        else if (target.scan) { setViewedScan(target.scan); setTab("selection"); }
        historyTarget.current = null;
      }
    };
    const fixed = stockVibeBuiltinStrategy(selectedId);
    if (fixed) { applyDetail(fixed); setDetailLoading(false); }
    else void getStockVibeLibraryStrategy(selectedId).then(applyDetail).catch(() => { if (active) { setDetail(null); setDetailFailed(true); notify(`detail:${selectedId}:${detailRequest}`, "这套策略的规则或代码暂时无法读取，可点击“重新读取策略”重试。"); } }).finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId, catalogRevision, catalogRefresh, detailRequest, notify]);
  useEffect(() => {
    if (scopeKind !== "industry" || industries) return;
    let active = true; setIndustriesLoading(true);
    void getStockVibeStrategyIndustries().then((value) => { if (active) { setIndustries(value); setIndustriesFailed(false); } }).catch(() => { if (active) { setIndustriesFailed(true); notify(`industries:${industryRequest}`, "行业目录暂时无法读取，可点击“重试加载行业”再次读取。"); } }).finally(() => { if (active) setIndustriesLoading(false); });
    return () => { active = false; };
  }, [scopeKind, industries, industryRequest, notify]);
  useEffect(() => {
    if (!strategy || revision === 0) return;
    let active = true;
    void getStockVibeStrategyHistory({ strategy_id: strategy.strategy_id, operation: "strategy_scan", limit: 20 }).then(async (page) => {
      const latest = page.items.find((row) => row.operation === "strategy_scan" && operationVersion(row) === strategy.version);
      if (!latest) return;
      const row = parseStockVibeStrategyOperation((await getStockVibeOperation(latest.operation_id)).native);
      if (active && row && operationStrategy(row) === strategy.strategy_id && operationVersion(row) === strategy.version) setOperations((current) => ({ ...current, [`${strategy.strategy_id}:${strategy.version}`]: row }));
    }).catch(() => { if (active) notify(`latest:${strategy.strategy_id}`, "这套策略的最近选股记录暂时无法读取，已有任务没有重新执行。"); });
    return () => { active = false; };
  }, [selectionKey, revision, notify]);

  const accept = useCallback((receipt: StockVibeRequestRecord, current: PendingScan) => {
    if (receipt.request_id?.replace(/-/g, "").toLowerCase() !== current.requestId.replace(/-/g, "").toLowerCase() || receipt.method !== "POST" || receipt.path !== "/mona/operations") return;
    const status = receipt.receipt?.status_code, signed = /^[a-f\d]{64}$/i.test(receipt.receipt_sha256 ?? "");
    if (receipt.status === "completed" && signed && status && status >= 200 && status < 300 && object(receipt.receipt?.body) && typeof receipt.receipt.body.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(receipt.receipt.body.operation_id)) {
      const next = { ...current, operationId: receipt.receipt.body.operation_id }; saveScan(next); setPending(next);
    } else if (receipt.status === "rejected" && ((receipt.error_category === "not_dispatched" && receipt.receipt === null && receipt.source === null) || signed && status && status >= 400 && status < 500)) {
      saveScan(null); setPending(null); notify(`rejected:${current.requestId}`, "本次选股未被接受，请核对策略条件和数据设置后重新发起。");
    }
  }, [notify]);
  useEffect(() => {
    if (!pending) return;
    let active = true, reading = false;
    const poll = async () => { if (reading || dispatching.current) return; reading = true;
      try {
        if (!pending.operationId) { const receipt = await getStockVibeRequest(pending.requestId); if (active) accept(receipt, pending); }
        else {
          const row = parseStockVibeStrategyOperation((await getStockVibeOperation(pending.operationId)).native);
          if (!row || row.operation_id !== pending.operationId || row.operation !== "strategy_scan" || operationStrategy(row) !== pending.strategyId || operationVersion(row) !== pending.version) throw new Error("scan_identity_mismatch");
          if (active) { setOperations((current) => ({ ...current, [`${pending.strategyId}:${pending.version}`]: row })); if (TERMINAL.has(row.status)) { saveScan(null); setPending(null); setRevision((value) => value + 1); if (row.status !== "completed") notify(`failed:${row.operation_id}`, "本次选股没有完成，已保留记录。请核对策略的数据要求和行情设置后重试。"); else if (!stockVibeStrategyScanResult(row)) notify(`invalid:${row.operation_id}`, "本次选股未取得可核实的结果，已有记录已保留。请从历史记录查看。"); } }
        }
      } catch { if (active) notify(`poll:${pending.requestId}`, "选股提交或运行结果仍在核对，请勿重复发起；原请求已保留。"); } finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [pending, accept, notify]);
  const acceptDelete = useCallback((receipt: StockVibeRequestRecord, current: PendingDelete) => {
    if (receipt.request_id?.replace(/-/g, "").toLowerCase() !== current.requestId.replace(/-/g, "").toLowerCase() || receipt.method !== "POST" || receipt.path !== "/mona/operations") return;
    const code = receipt.receipt?.status_code, signed = /^[a-f\d]{64}$/i.test(receipt.receipt_sha256 ?? "");
    if (receipt.status === "completed" && signed && code && code >= 200 && code < 300 && object(receipt.receipt?.body) && typeof receipt.receipt.body.operation_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(receipt.receipt.body.operation_id)) {
      const next = { ...current, operationId: receipt.receipt.body.operation_id }; saveDelete(next); setDeletePending(next);
    } else if (receipt.status === "rejected" && ((receipt.error_category === "not_dispatched" && receipt.receipt === null && receipt.source === null) || signed && code && code >= 400 && code < 500)) {
      saveDelete(null); setDeletePending(null); setCatalogRefresh((value) => value + 1);
      notify(`delete-rejected:${current.requestId}`, code === 409 ? "这套策略尚未删除。请重新查看当前版本，或等待相关任务结束后重试。" : "删除请求未被接受，策略尚未删除。请稍后重新打开策略后重试。");
    }
  }, [notify]);
  useEffect(() => {
    if (!deletePending) return;
    let active = true, reading = false, done = false;
    const poll = async () => {
      if (reading || done || deleteDispatching.current) return; reading = true;
      try {
        if (!deletePending.operationId) { const receipt = await getStockVibeRequest(deletePending.requestId); if (active) acceptDelete(receipt, deletePending); }
        else {
          const row = parseStockVibeStrategyDeleteOperation((await getStockVibeOperation(deletePending.operationId)).native);
          if (!row || row.operation_id !== deletePending.operationId || (row.references?.strategy_id ?? row.payload?.strategy_id) !== deletePending.strategyId || (row.references?.strategy_version ?? row.payload?.strategy_version) !== deletePending.version) throw new Error("delete_identity_mismatch");
          if (!active || !TERMINAL.has(row.status)) return;
          done = true;
          if (stockVibeStrategyDeleteConfirmed(row)) {
            confirmedDeleted.current.add(deletePending.strategyId); saveDelete(null); setDeletePending(null);
            if (focused.current === deletePending.strategyId) focused.current = null;
            setCustomPage((current) => ({ ...current, items: current.items.filter((item) => item.strategy_id !== deletePending.strategyId) }));
            setSelectedId((current) => current === deletePending.strategyId ? null : current);
            setCatalogRefresh((value) => value + 1); setRevision((value) => value + 1);
          } else if (row.status === "completed") notify(`delete-unverified:${row.operation_id}`, "删除结果尚未核实，已保留原请求。请稍后重新打开策略库核对，请勿重复删除。");
          else { saveDelete(null); setDeletePending(null); notify(`delete-failed:${row.operation_id}`, "本次删除没有确认完成，历史记录已保留。请稍后重新打开策略库核对后再操作。"); }
        }
      } catch { if (active) notify(`delete-check:${deletePending.requestId}`, "删除结果仍在核对，原请求已保留，请勿重复删除。"); }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000); return () => { active = false; window.clearInterval(timer); };
  }, [deletePending, acceptDelete, notify]);
  useEffect(() => {
    if (!historyOpen || historyPane !== "runs") return;
    let active = true; setHistoryLoaded(false);
    void getStockVibeStrategyHistory({ strategy_id: historyScope === "current" ? selectedId ?? undefined : undefined, offset: historyOffset, limit: 20 }).then((page) => { if (active) { setHistory(page.items); setHistoryTotal(page.total); } }).catch(() => { if (active) notify(`history:${historyScope}:${selectedId}:${historyOffset}`, "策略运行历史暂时无法读取，请稍后重新打开。"); }).finally(() => { if (active) setHistoryLoaded(true); });
    return () => { active = false; };
  }, [historyOpen, historyPane, historyScope, historyOffset, selectedId, revision, notify]);

  async function launch() {
    if (!strategy || !strategy.can_scan || strategy.deleted || deletingThis || pending || dispatching.current) return;
    if (scopeIssue) { setFieldError(scopeIssue); return; }
    if (cutoff === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { setFieldError("请选择数据截止日期。"); return; }
    if (Object.values(parameters).some((value) => !Number.isFinite(value) || value <= 0 || !Number.isInteger(value))) { setFieldError("策略参数应为大于0的整数。"); return; }
    if (!enabled) { onError("选股暂不可用，请检查功能资源后重试。"); return; }
    const identity = selectionKey;
    dispatching.current = true; setSubmitting(true);
    try {
      let actualDefaults: StockVibeBacktestDefaults;
      try { actualDefaults = await loadDefaults(); } catch { if (mounted.current) onError("行情设置暂时无法读取，本次选股没有提交。请稍后重试。"); return; }
      if (!mounted.current || launchableSelection.current !== identity) return;
      const settings: StockVibeBacktestSettings = { ...stockVibeBacktestSettings({ ...actualDefaults.defaults, ...strategy.effective_config }), interval: strategy.interval };
      delete settings.codes;
      if (scanSource) settings.source = scanSource;
      if (cutoff === "date") settings.end_date = date; else delete settings.end_date;
      const current = { requestId: createStockVibeRequestId(), strategyId: strategy.strategy_id, version: strategy.version };
      try { saveScan(current); } catch { onError("无法保存选股请求的核对信息，本次没有提交。请检查本机存储后重试。"); return; }
      setFieldError(""); setViewedScan(null); setPending(current);
      try { accept(await startStockVibeStrategyScan(current.requestId, { strategy_id: current.strategyId, strategy_version: current.version, scope: scopeSelection, settings, ...(Object.keys(parameters).length ? { strategy_parameters: parameters } : {}) }), current); }
      catch { notify(`submit:${current.requestId}`, "选股提交结果暂未确认，系统会核对原请求，请勿重复提交。"); }
    } finally { dispatching.current = false; if (mounted.current) setSubmitting(false); }
  }
  async function confirmDelete() {
    if (!deleteTarget || deleteTarget.source !== "custom" || deleteTarget.deleted || deletePending || deleteDispatching.current || !enabled) return;
    const current = { requestId: createStockVibeRequestId(), strategyId: deleteTarget.strategy_id, version: deleteTarget.version, name: deleteTarget.name };
    try { saveDelete(current); } catch { onError("无法保存删除请求的核对信息，本次没有提交。请检查本机存储后重试。"); return; }
    deleteDispatching.current = true; setDeletePending(current); setDeleteTarget(null);
    try { acceptDelete(await deleteStockVibeLibraryStrategy(current.requestId, { strategy_id: current.strategyId, strategy_version: current.version }), current); }
    catch { notify(`delete-submit:${current.requestId}`, "删除提交结果暂未确认，系统会核对原请求，请勿重复删除。"); }
    finally { deleteDispatching.current = false; }
  }
  async function openHistory(row: StockVibeStrategyOperation) {
    const strategyId = operationStrategy(row); if (!strategyId) return;
    if (row.operation === "backtest") { const id = row.references?.output_run_id ?? row.references?.run_id; if (typeof id === "string") { focused.current = strategyId; historyTarget.current = { strategyId, runId: id }; setSelectedId(strategyId); setHistoryOpen(false); if (selectedId === strategyId) { setBacktestRunId(id); setBacktestVisited(true); setTab("backtest"); historyTarget.current = null; } } else onError("这条回测记录尚未提供可读取的报告。"); }
    else { try { const value = parseStockVibeStrategyOperation((await getStockVibeOperation(row.operation_id)).native); if (!value || value.operation_id !== row.operation_id || operationStrategy(value) !== strategyId) throw new Error(); focused.current = strategyId; historyTarget.current = { strategyId, scan: value }; setSelectedId(strategyId); setHistoryOpen(false); if (selectedId === strategyId) { setViewedScan(value); setTab("selection"); historyTarget.current = null; } } catch { onError("这份选股结果暂时无法读取，请稍后重新打开。"); } }
  }
  const selectedParameters = strategy?.parameters.map((item) => item.name in parameters ? { ...item, value: parameters[item.name] } : item);
  const backtestConfig = stockVibeBacktestSettings(strategy?.effective_config ?? {});
  delete backtestConfig.codes;
  const heroFacts = (strategy?.parameters ?? []).filter((item) => item.editable).slice(0, 4);
  const countParameter = strategy?.parameters.find((item) => item.name === "top_n" && item.editable && typeof item.value === "number");
  const launchLabel = submitting ? "正在提交" : pending ? pending.strategyId !== strategy?.strategy_id ? "另一策略运行中" : pending.operationId ? "选股运行中" : "正在核对上次提交" : "开始选股";
  const resultStatus = result ? "已生成" : operation && !TERMINAL.has(operation.status) ? STATUS[operation.status] ?? "运行中" : operation && operation.status !== "completed" ? STATUS[operation.status] ?? "未完成" : "尚未运行";
  return <section className="stock-vibe-strategy-library" aria-label="策略库">
    <aside className="stock-vibe-strategy-panel" aria-label="选择策略">
      <header className="stock-vibe-strategy-toolbar">
        <div className="stock-vibe-strategy-heading">
          <h2 className="text-title-sm font-semibold">策略库</h2>
          <span className="stock-vibe-strategy-count">{catalogComplete ? `${total} 套` : `${builtinRows.length} 套`}</span>
        </div>
        <div className="stock-vibe-strategy-search">
          <Search className="size-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="搜索策略" placeholder="搜索策略名称或因子" value={q} onChange={(event) => { setQ(event.target.value); if (source === "builtin") { setCatalogQuery(event.target.value); setOffset(0); } focused.current = null; }} />
        </div>
        <div className="stock-vibe-strategy-filters">
          <div className="stock-vibe-strategy-sources" role="group" aria-label="策略来源">
            {([["all", "全部"], ["builtin", "内置"], ["custom", "自定义"]] as const).map(([value, label]) => <Button type="button" size="sm" variant="ghost" className="stock-vibe-strategy-source" key={value} aria-pressed={source === value} onClick={() => { setSource(value); if (value === "builtin") setCatalogQuery(q); setOffset(0); focused.current = null; }}>{label}</Button>)}
          </div>
          <Select aria-label="适用市场" className="stock-vibe-strategy-market" value={market} onValueChange={(value) => { setMarket(value as typeof market); setOffset(0); focused.current = null; }} options={[{ value: "china_a", label: "中国A股" }, { value: "all", label: "全部市场" }]} />
        </div>
      </header>
      {deletePending && <p role="status" className="stock-vibe-strategy-status">正在核对“{deletePending.name}”的删除结果，原请求已保留。</p>}
      <div className="stock-vibe-strategy-rows" aria-busy={source === "custom" && loading}>
        {!items.length && catalogComplete ? <p className="stock-vibe-strategy-empty">没有符合条件的策略。</p> : items.map((item) => <Button type="button" variant="ghost" className="stock-vibe-strategy-row" aria-pressed={selectedId === item.strategy_id} key={item.strategy_id} title={item.unavailable_reason ?? undefined} onClick={() => { focused.current = null; setSelectedId(item.strategy_id); }}><span className="stock-vibe-strategy-row-heading"><span className="stock-vibe-strategy-row-title">{item.name}</span><span className="stock-vibe-strategy-row-kind" data-unavailable={!item.can_scan || undefined}>{item.can_scan ? [item.source === "builtin" ? "内置" : "自定义", item.example ? "示例" : ""].filter(Boolean).join(" · ") : "暂不可用"}</span></span><span className="stock-vibe-strategy-row-meta">{MARKET[item.market]} · {item.interval === "1D" ? "日线" : item.interval}</span></Button>)}
      </div>
      {source !== "builtin" && !catalogComplete && !catalogFailed && <p role="status" className="stock-vibe-strategy-status">正在读取自定义策略…</p>}
      {source !== "builtin" && catalogFailed && <Button size="sm" variant="ghost" className="stock-vibe-strategy-retry" onClick={() => setCatalogRefresh((value) => value + 1)}>重新读取自定义策略</Button>}
      <footer className="stock-vibe-strategy-footer">
        <span>{catalogComplete ? `${total} 套策略` : `${builtinRows.length} 套内置策略`}</span>
        <div className="stock-vibe-strategy-footer-actions">
          {total > 20 && <><Button size="sm" variant="ghost" disabled={pageOffset === 0 || !catalogComplete || loading} onClick={() => setOffset(Math.max(0, pageOffset - 20))}>上一页</Button><Button size="sm" variant="ghost" disabled={pageOffset + 20 >= total || !catalogComplete || loading} onClick={() => setOffset(pageOffset + 20)}>下一页</Button></>}
          <Button type="button" variant="text" className="stock-vibe-strategy-manage" onClick={() => { setSource("custom"); setOffset(0); focused.current = null; }}>管理策略</Button>
        </div>
      </footer>
    </aside>
    <main className="stock-vibe-strategy-workspace" aria-label="策略工作区">
      {!strategy && detailLoading ? <p className="stock-vibe-strategy-state" role="status">正在读取自定义策略规则…</p> : !strategy ? selectedId && detailFailed ? <Button size="sm" variant="ghost" className="stock-vibe-strategy-state" onClick={() => setDetailRequest((value) => value + 1)}>重新读取策略</Button> : <p className="stock-vibe-strategy-state">选择一套策略，查看规则并开始使用。</p> : <>
        <header className="stock-vibe-opportunity-hero">
          <div className="stock-vibe-opportunity-hero-top">
            <div className="stock-vibe-opportunity-hero-title">
              <h2 className="stock-vibe-opportunity-name">{strategy.name}</h2>
              <span className="stock-vibe-opportunity-hero-tag">{strategy.source === "builtin" ? "内置" : "自定义"}</span>
              {strategy.example && <span className="stock-vibe-opportunity-hero-tag">示例</span>}
            </div>
            <div className="stock-vibe-opportunity-hero-actions">
              <Button size="sm" variant="ghost" className="stock-vibe-opportunity-hero-action" onClick={() => { setHistoryOpen(true); setHistoryOffset(0); }}><History className="size-4" aria-hidden="true" />历史记录</Button>
              <Button size="sm" variant="ghost" className="stock-vibe-opportunity-hero-action" disabled={!onCreateStrategy} onClick={onCreateStrategy}><Sparkles className="size-4" aria-hidden="true" />用 AI 创建策略</Button>
              {strategy.source === "custom" && <Button size="sm" variant="ghost" className="stock-vibe-opportunity-hero-action" disabled={!onModifyStrategy || strategy.deleted || deletingThis} onClick={() => onModifyStrategy?.(strategy)}>用 AI 修改</Button>}
              {strategy.source === "custom" && !strategy.deleted && <Button size="sm" variant="ghost" className="stock-vibe-opportunity-hero-action stock-vibe-opportunity-hero-delete" disabled={!enabled || Boolean(deletePending) || pending?.strategyId === strategy.strategy_id} onClick={() => setDeleteTarget(strategy)}>删除策略</Button>}
            </div>
          </div>
          <p className="stock-vibe-opportunity-description">{strategy.description}</p>
          <div className="stock-vibe-opportunity-facts">
            {heroFacts.map((item) => <span className="stock-vibe-opportunity-fact" key={item.name}>{PARAMETER[item.name] ?? item.name}</span>)}
            <span className="stock-vibe-opportunity-market-meta">{strategy.market === "china_a" ? "中国 A 股" : MARKET[strategy.market]} · {strategy.interval === "1D" ? "日线" : strategy.interval}{strategy.has_evidence && " · 有历史评估记录"}</span>
          </div>
        </header>
        {strategy.deleted && <p className="stock-vibe-opportunity-deleted" role="status">这套策略已删除，已有选股和回测记录仍可查看。</p>}
        <Tabs value={tab} onValueChange={(value) => { setTab(value); if (value === "backtest") setBacktestVisited(true); }} className="stock-vibe-opportunity-tabs">
          <div className="stock-vibe-opportunity-tabbar">
            <TabsList aria-label="策略使用" className="stock-vibe-strategy-tabs"><TabsTrigger value="selection">选股</TabsTrigger><TabsTrigger value="backtest">回测</TabsTrigger><TabsTrigger value="rules">规则</TabsTrigger></TabsList>
            <span className="stock-vibe-opportunity-tab-hint">内置示例 · 参数可调整</span>
          </div>
          <section className="stock-vibe-opportunity-config">
            <header className="stock-vibe-opportunity-config-header">
              <div className="stock-vibe-opportunity-config-heading">
                <h3>选股设置</h3>
                <p>已按{STYLE_LABEL[mode]}风格填入推荐参数</p>
              </div>
              <div className="stock-vibe-opportunity-config-actions">
                <StockVibeInfo title="本次选股参数" label={<><SlidersHorizontal className="size-4" aria-hidden="true" />参数与数据</>} className="stock-vibe-opportunity-config-info" onOpenChange={(open) => { if (open) void loadDefaults().catch(() => onError("行情设置暂时无法读取，请关闭后重试。")); }}>
                  <div className="space-y-3">{defaults && <label className="block space-y-1"><span>行情来源</span><Select aria-label="选股行情来源" value={scanSource} onValueChange={setScanSource} options={[{ value: "", label: "沿用策略配置" }, ...defaults.options.sources.map((value) => ({ value, label: ({ tushare: "Tushare", tencent: "腾讯行情", local: "本地行情", eastmoney: "东方财富行情" } as Record<string, string>)[value] ?? value }))]} /></label>}{strategy.parameters.map((item) => <label className="block space-y-1" key={item.name}><span>{PARAMETER[item.name] ?? item.name}</span>{item.editable && typeof item.value === "number" ? <Input aria-label={PARAMETER[item.name] ?? item.name} type="number" min="1" step="1" value={parameters[item.name] ?? item.value} onChange={(event) => setParameters((current) => ({ ...current, [item.name]: Number(event.target.value) }))} /> : <p>{format(item.value)}</p>}</label>)}{!strategy.parameters.length && <p>原策略未提供可识别的参数清单。{strategy.source === "custom" && "可通过“用 AI 修改”生成新版本。"}</p>}<p className="text-muted-foreground">参数只用于本次运行，策略原版和历史记录保持各自版本。</p>{onOpenDataSettings && <Button size="sm" variant="ghost" onClick={onOpenDataSettings}>数据设置</Button>}</div>
                </StockVibeInfo>
                <Button variant="default" size="sm" className="gap-1.5" disabled={!strategy.can_scan || strategy.deleted || deletingThis || !enabled || Boolean(scopeIssue) || Boolean(pending) || submitting} onClick={() => { void launch(); }}><Play className="size-4" aria-hidden="true" />{launchLabel}</Button>
              </div>
            </header>
            <div className="stock-vibe-opportunity-fields" aria-label="当前股票范围">
              <label className="stock-vibe-opportunity-field">
                <span>股票范围</span>
                <Select aria-label="股票范围" value={scopeKind} onValueChange={(value) => { setScopeKind(value as typeof scopeKind); setFieldError(""); if (value === "industry" && !industries) setIndustryRequest((current) => current + 1); }} options={[{ value: "all_a", label: "全A股" }, { value: "industry", label: "行业" }, { value: "watchlist", label: `我的自选（${symbols.length}只）` }]} />
              </label>
              <label className="stock-vibe-opportunity-field">
                <span>数据截止</span>
                <Select aria-label="数据截止" value={cutoff} onValueChange={(value) => { setCutoff(value); setFieldError(""); }} options={[{ value: "latest", label: "最近完整交易日" }, { value: "date", label: "指定日期" }]} />
              </label>
              {countParameter && <label className="stock-vibe-opportunity-field stock-vibe-opportunity-count-field">
                <span>选股数量</span>
                <span className="stock-vibe-opportunity-number"><Input aria-label="选股数量" type="number" min="1" step="1" value={parameters[countParameter.name] ?? countParameter.value} onChange={(event) => setParameters((current) => ({ ...current, [countParameter.name]: Number(event.target.value) }))} /><span>只</span></span>
              </label>}
              {cutoff === "date" && <label className="stock-vibe-opportunity-field"><span>截止日期</span><Input aria-label="截止日期" type="date" value={date} onChange={(event) => { setDate(event.target.value); setFieldError(""); }} /></label>}
            </div>
            {scopeKind === "industry" && <div className="stock-vibe-opportunity-subfields">
              <label className="stock-vibe-opportunity-field stock-vibe-opportunity-industry-search"><span>行业名称</span><Input aria-label="搜索行业" placeholder="输入行业名称" value={industrySearch} onChange={(event) => { setIndustrySearch(event.target.value); setIndustryCode(""); setFieldError(""); }} /></label>
              <label className="stock-vibe-opportunity-field"><span>具体行业</span><Select aria-label="具体行业" placeholder={industriesLoading ? "正在读取行业…" : industries && !filteredIndustries.length ? "没有匹配行业" : "请选择行业"} value={industryCode} disabled={industriesLoading || !filteredIndustries.length} onValueChange={(value) => { setIndustryCode(value); setFieldError(""); }} options={filteredIndustries.map((item) => ({ value: item.code, label: item.name }))} /></label>
              {industriesFailed && <Button size="sm" variant="ghost" disabled={industriesLoading} onClick={() => { setFieldError(""); setIndustryRequest((value) => value + 1); }}>{industriesLoading ? "正在读取行业…" : "重试加载行业"}</Button>}
            </div>}
            {scopeKind === "industry" && industries && <p className="stock-vibe-opportunity-field-note">行业分类：东方财富{industries.as_of ? ` · 数据日期 ${industries.as_of}` : ""}</p>}
            {scopeIssue && !fieldError && !industryUnavailable && <div className="stock-vibe-opportunity-field-message"><p>{scopeIssue}</p>{scopeKind === "watchlist" && onOpenWorkbench && <Button size="sm" variant="ghost" onClick={onOpenWorkbench}>添加自选股票</Button>}</div>}
            {fieldError && !industryUnavailable && <p className="stock-vibe-opportunity-field-error" role="alert">{fieldError}</p>}
          </section>
                    <TabsContent value="selection" className="stock-vibe-opportunity-tab-content">
            {strategy.unavailable_reason && <p className="stock-vibe-opportunity-unavailable">{strategy.unavailable_reason}</p>}
            <section className="stock-vibe-opportunity-result" aria-label="本次选股">
              <header className="stock-vibe-opportunity-result-header">
                <div className="stock-vibe-opportunity-result-title"><h3>{viewedScan ? "历史选股结果" : "选股结果"}</h3><span className="stock-vibe-opportunity-result-status">{resultStatus}</span></div>
                <span className="stock-vibe-opportunity-result-note">结果仅用于研究，不构成投资建议</span>
              </header>
              {result ? <>
                <div className="stock-vibe-opportunity-result-summary">
                  <p>本次范围：{resultScopeLabel}</p>
                  <p>实际行情截至 {result.data_as_of}</p>
                  {coverage && <p>可计算{coverage.evaluated} / 请求{coverage.requested}只{!coverage.complete ? `。数据不齐，结果仅覆盖${coverage.evaluated}只。` : ""}</p>}
                </div>
                {result.signals.length ? <div className="stock-vibe-opportunity-table-wrap"><table className="stock-vibe-strategy-table text-caption"><thead><tr><th>股票</th><th>信号 / 目标权重</th><th>信号日期</th><th>操作</th></tr></thead><tbody>{result.signals.map((signal) => <tr key={signal.symbol}><td>{signal.symbol.slice(0, 6)}</td><td>{typeof signal.target_weight === "number" ? `${(signal.target_weight * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%` : signal.signal.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}</td><td>{signal.signal_date}</td><td><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => onMarket(signal.symbol, scope)}>看行情</Button><Button size="sm" variant="ghost" disabled={symbols.includes(signal.symbol)} onClick={() => onAdd(signal.symbol)}>{symbols.includes(signal.symbol) ? "已自选" : "加自选"}</Button><Button size="sm" variant="ghost" disabled={strategy.deleted || deletingThis} onClick={() => onResearch(signal.symbol, scope)}>询问 AI</Button></div></td></tr>)}</tbody></table></div> : <p className="stock-vibe-opportunity-no-results">本次没有符合规则的股票。</p>}
                <p className="stock-vibe-opportunity-result-footnote">{result.note || "信号与目标持仓来自策略输出，不代表已成交。"}</p>
                <StockVibeInfo title="本次策略与数据依据" label="查看本次规则与数据依据"><p>{result.strategy_version === strategy.version ? strategy.description : "这份记录属于此前版本，规则以当次保存的代码与配置为准。"}</p><p>请求截止：{result.as_of}</p><p>实际行情截至：{result.data_as_of}</p><p>生效时点：{result.effective_at ?? "下一可交易时点，尚未确定具体日期"}</p><p>数据来源：{format(result.data_sources)}</p><p>本次范围：{resultScopeLabel}</p>{resultScope && <><p>范围数据日期：{resultScope.as_of}</p><p>范围成员使用当前快照，不代表历史时点的成员。</p><p className="break-all">范围快照：{resultScope.snapshot_sha256}</p></>}{result.missing.length > 0 && <p>缺失或跳过：{format(result.missing)}</p>}</StockVibeInfo>
              </> : <div className="stock-vibe-opportunity-empty" role="status">
                <span className="stock-vibe-opportunity-empty-icon"><Search className="size-6" aria-hidden="true" /></span>
                <h4>{operation && !TERMINAL.has(operation.status) ? "正在计算选股结果" : operation && operation.status !== "completed" ? "本次选股没有完成" : "准备寻找符合条件的机会"}</h4>
                <p>{operation && !TERMINAL.has(operation.status) ? "正在按这套策略计算信号，结果会显示在这里。" : operation && operation.status !== "completed" ? "可查看历史记录，或核对数据后重试。" : "确认上方参数后点击「开始选股」，结果会显示在这里。"}</p>
                {!operation && <span className="stock-vibe-opportunity-empty-context">{strategy.name} · {scopeLabel} · {countParameter ? `前 ${parameters[countParameter.name] ?? countParameter.value} 只` : "按策略参数"}</span>}
              </div>}
            </section>
          </TabsContent>
          <TabsContent value="rules" className="stock-vibe-opportunity-tab-content">
            <section className="stock-vibe-opportunity-rules">
              <dl className="space-y-3 text-body">{strategy.rules.filter((rule) => !["来源", "来源摘要"].includes(rule.label)).map((rule, index) => <div key={`${rule.label}:${index}`}><dt className="text-caption text-muted-foreground">{rule.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{format(rule.value)}</dd></div>)}</dl>
              {strategy.rules.some((rule) => ["来源", "来源摘要"].includes(rule.label)) && <StockVibeInfo title="策略技术来源" label="查看来源详情"><dl className="space-y-3">{strategy.rules.filter((rule) => ["来源", "来源摘要"].includes(rule.label)).map((rule, index) => <div key={index}><dt className="text-muted-foreground">{rule.label}</dt><dd className="break-all">{format(rule.value)}</dd></div>)}</dl></StockVibeInfo>}
              {!strategy.rules.length && <p className="text-caption text-muted-foreground">原记录尚未保存完整规则。</p>}
              <p className="text-caption text-muted-foreground">{strategy.unavailable_reason ?? "执行时沿用这套策略的真实规则与参数。"}</p>
            </section>
          </TabsContent>
          <TabsContent value="backtest" forceMount hidden={tab !== "backtest"} className="stock-vibe-opportunity-backtest">{backtestVisited && <StockVibeBacktest key={`${strategy.strategy_id}:${strategy.version}:${JSON.stringify(parameters)}:${backtestRunId ?? ""}`} selectedStrategy={{ ...strategy, can_backtest: strategy.can_backtest && !strategy.deleted && !deletingThis && !scopeIssue, unavailable_reason: strategy.unavailable_reason ?? (scopeIssue || null), parameters: selectedParameters, effective_config: backtestConfig, scope: scopeSelection, scope_label: scopeLabel }} symbols={symbols} onError={onError} initialRunId={backtestRunId} />}</TabsContent>
        </Tabs>
      </>}
    </main>
    <StockVibeInfo title="策略历史记录" open={historyOpen} onOpenChange={setHistoryOpen} label={<span className="sr-only">打开策略历史记录</span>}><div className="flex flex-wrap gap-3">{[["runs", "策略运行"], ["research", "旧研究记录"], ["archive", "早期选股档案"]].map(([value, label]) => <Button key={value} size="sm" variant="ghost" aria-pressed={historyPane === value} onClick={() => setHistoryPane(value)}>{label}</Button>)}</div>{historyPane === "runs" ? <><Select aria-label="历史策略范围" value={selectedId ? historyScope : "all"} onValueChange={(value) => { setHistoryScope(value); setHistoryOffset(0); }} options={[...(selectedId ? [{ value: "current", label: "当前策略" }] : []), { value: "all", label: "全部策略" }]} />{!historyLoaded ? <p role="status">正在读取策略运行记录…</p> : !history.length ? <p>暂无策略运行记录。</p> : <table className="stock-vibe-strategy-table text-caption"><thead><tr><th>类型</th><th>策略</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{history.map((row) => <tr key={row.operation_id}><td>{row.operation === "strategy_scan" ? "选股" : "回测"}</td><td>{typeof row.references?.strategy_name === "string" ? row.references.strategy_name : items.find((item) => item.strategy_id === operationStrategy(row))?.name ?? "策略来源待核对"}</td><td>{historyTime(row.created_at) ?? "未提供"}</td><td>{STATUS[row.status] ?? "状态待核对"}</td><td><Button size="sm" variant="ghost" onClick={() => { void openHistory(row); }}>查看</Button></td></tr>)}</tbody></table>}{historyTotal > 20 && <div className="flex justify-between"><Button size="sm" variant="ghost" disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}>上一页</Button><span>{Math.floor(historyOffset / 20) + 1} / {Math.ceil(historyTotal / 20)}</span><Button size="sm" variant="ghost" disabled={historyOffset + 20 >= historyTotal} onClick={() => setHistoryOffset(historyOffset + 20)}>下一页</Button></div>}</> : historyPane === "research" ? <OldResearch onError={onError} onOpenRun={(id) => { setBacktestRunId(id); setBacktestVisited(true); setTab("backtest"); setHistoryOpen(false); }} /> : <StockVibeOpportunityArchive onError={onError} onAdd={onAdd} onMarket={onMarket} />}</StockVibeInfo>
    <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}><AlertDialogContent className="scrollbar-scope"><AlertDialogHeader><AlertDialogTitle>确认删除“{deleteTarget?.name}”？</AlertDialogTitle><AlertDialogDescription>删除后，这套策略将从策略库移除，不能再用于选股、回测或修改。已有选股和回测记录会保留。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={Boolean(deletePending)} onClick={() => { void confirmDelete(); }}>删除策略</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
