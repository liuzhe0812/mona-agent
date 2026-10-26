import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getStockVibeRequest, StockVibeApiError, type StockVibeRequestRecord, type StockVibeWorkbenchReport } from "@/lib/stock-vibe-api";
import {
  commitStockVibePaperTrade, createStockVibePaperAccount, getStockVibePaperAccount,
  getStockVibePaperPreview, listStockVibePaperTrades, StockVibePaperApiError, stockVibePaperError,
  type StockVibePaperAccount, type StockVibePaperPreview, type StockVibePaperTrade,
} from "@/lib/stock-vibe-paper-api";
import { stockTime } from "@/lib/stock-vibe-workbench";
import type { StockVibeWorkbenchProps } from "./StockVibeWorkbench";

type Side = "buy" | "sell";
type Pending = { requestId: string; kind: "account" | "trade"; path: string; symbol?: string };
const PENDING_KEY = "mona.stock-vibe.paper.pending.v1";
const PAGE_SIZE = 10;
const QUOTE_SOURCES: Record<string, string> = { tencent: "腾讯行情", eastmoney: "东方财富行情", local: "本地行情" };
const amount = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
  ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const pnlClass = (value: number | null | undefined) => typeof value !== "number" ? "" : value > 0 ? "stock-vibe-up" : value < 0 ? "stock-vibe-down" : "";
const signed = (value: number | null | undefined) => `${typeof value === "number" && value > 0 ? "+" : ""}${amount(value)}`;
function readPending(): Pending | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
    return value && /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(value.requestId) && ["account", "trade"].includes(value.kind)
      && value.path === (value.kind === "account" ? "/mona/paper/account" : "/mona/paper/trades") ? value : null;
  } catch { return null; }
}

export function StockVibePaperTrading({ selectedSymbol, latest, onSelect, onResearch, onError, children }: {
  selectedSymbol: string | null; latest?: StockVibeWorkbenchReport | null;
  onSelect: (symbol: string) => void; onResearch: StockVibeWorkbenchProps["onResearch"];
  onError?: (message: string) => void;
  children: (parts: { panel: ReactNode; actions: ReactNode }) => ReactNode;
}) {
  const [data, setData] = useState<StockVibePaperAccount | null>(null), [failed, setFailed] = useState(false);
  const [setup, setSetup] = useState(false), [initialCash, setInitialCash] = useState("");
  const [side, setSide] = useState<Side | null>(null), [quantity, setQuantity] = useState("");
  const [note, setNote] = useState(""), [attachResearch, setAttachResearch] = useState(false);
  const [report, setReport] = useState<StockVibeWorkbenchReport | null>(null);
  const [preview, setPreview] = useState<StockVibePaperPreview | null>(null), [previewLoading, setPreviewLoading] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(readPending), [historyOpen, setHistoryOpen] = useState(false);
  const [trades, setTrades] = useState<StockVibePaperTrade[]>([]), [historyLoading, setHistoryLoading] = useState(false), [historyFailed, setHistoryFailed] = useState(false);
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [detail, setDetail] = useState<StockVibePaperTrade | null>(null);
  const accountRead = useRef(0), accountReadsInFlight = useRef(0), historyRead = useRef(0);
  const onErrorRef = useRef(onError), writing = useRef(false), nextSide = useRef<Side | null>(null), previewGeneration = useRef(0);
  onErrorRef.current = onError;
  const account = data?.account, position = data?.positions.find((item) => item.symbol === selectedSymbol);
  const locked = pending !== null;
  const previewValid = preview && preview.status === "ready" && preview.symbol === selectedSymbol && preview.side === side && preview.quantity === Number(quantity)
    && preview.account_version === account?.version && Date.parse(preview.expires_at) > now;
  const read = useCallback(async (automatic = false) => {
    if (automatic && accountReadsInFlight.current > 0) return;
    const generation = ++accountRead.current;
    accountReadsInFlight.current++;
    try {
      const result = await getStockVibePaperAccount();
      if (generation === accountRead.current) {
        setData((current) => (current?.account?.version ?? -1) > (result.account?.version ?? -1) ? current : result);
        setFailed(false);
      }
    } catch { if (generation === accountRead.current) setFailed(true); }
    finally { accountReadsInFlight.current--; }
  }, []);
  useEffect(() => {
    void read();
    const poll = () => { if (document.visibilityState !== "hidden") void read(true); };
    const timer = window.setInterval(poll, 15000);
    document.addEventListener("visibilitychange", poll);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [read]);
  useEffect(() => {
    if (!preview) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  useEffect(() => {
    previewGeneration.current++; setSide(null); setPreview(null); setPreviewLoading(false); setFieldError(null); setNotice(null); nextSide.current = null;
  }, [selectedSymbol]);
  const loadHistory = useCallback(async () => {
    const generation = ++historyRead.current;
    setHistoryLoading(true); setHistoryFailed(false);
    try { const result = await listStockVibePaperTrades({ limit: PAGE_SIZE, offset }); if (generation === historyRead.current) { setTrades(result.items); setTotal(result.total); } }
    catch { if (generation === historyRead.current) { setTrades([]); setHistoryFailed(true); onErrorRef.current?.("模拟交易记录读取失败，请稍后重新打开。"); } }
    finally { if (generation === historyRead.current) setHistoryLoading(false); }
  }, [offset]);
  useEffect(() => { if (historyOpen) void loadHistory(); }, [historyOpen, loadHistory]);
  const openTrade = (value: Side) => {
    if (locked || !selectedSymbol) return;
    setFieldError(null); setPreview(null); setNote(""); setAttachResearch(false); setReport(latest?.session_id && latest.attempt_id ? latest : null);
    if (!account) { nextSide.current = value; setInitialCash(String(data?.defaults.initial_cash ?? "")); setSetup(true); return; }
    previewGeneration.current++; setQuantity(String(data?.defaults.lot_size ?? "")); setSide(value);
  };
  const finish = useCallback(async (current: Pending, record: StockVibeRequestRecord) => {
    if (record.request_id.replace(/-/g, "") !== current.requestId.replace(/-/g, "") || record.method !== "POST" || record.path !== current.path) return false;
    const code = record.receipt?.status_code;
    const body = record.receipt?.body;
    const verified = /^[a-f\d]{64}$/i.test(record.receipt_sha256 ?? "");
    const result = body && typeof body === "object" ? body as Record<string, unknown> : null;
    if (record.status === "completed" && code && code >= 200 && code < 300 && verified && result
      && (current.kind === "account" ? result.account && typeof result.account === "object" : result.trade && typeof result.trade === "object" && typeof (result.trade as StockVibePaperTrade).trade_id === "string" && typeof (result.trade as StockVibePaperTrade).request_id === "string" && (result.trade as StockVibePaperTrade).request_id.replace(/-/g, "") === current.requestId.replace(/-/g, "") && (result.trade as StockVibePaperTrade).symbol === current.symbol)) {
      localStorage.removeItem(PENDING_KEY); setPending(null); writing.current = false;
      if (current.kind === "trade") { const trade = result.trade as StockVibePaperTrade; setNotice(`已模拟${trade.side === "buy" ? "买入" : "卖出"} ${trade.symbol.slice(0, 6)} · ${trade.quantity} 股`); }
      setPreview(null); setSide(null); setSetup(false); await read();
      if (current.kind === "account" && nextSide.current) {
        setSide(nextSide.current); nextSide.current = null; setQuantity(String(data?.defaults.lot_size ?? ""));
      }
      if (current.kind === "trade" && historyOpen) void loadHistory();
      return true;
    }
    if (record.status === "rejected" && ((record.error_category === "not_dispatched" && record.receipt === null && record.source === null)
      || (verified && code && code >= 400 && code < 500))) {
      localStorage.removeItem(PENDING_KEY); setPending(null); writing.current = false; setPreview(null);
      const message = record.receipt?.body ? stockVibePaperError(record.receipt.body).message : current.kind === "account" ? "模拟账户未创建，请核对初始资金后重试。" : "本次模拟交易未记入，请重新核对数量、资金和参考价。";
      if (side || setup) setFieldError(message); else onErrorRef.current?.(message);
      await read(); return true;
    }
    return false;
  }, [read, historyOpen, loadHistory, data?.defaults.lot_size, side, setup]);
  useEffect(() => {
    if (!pending) return;
    let active = true, reading = false;
    const poll = async () => {
      if (reading || writing.current) return;
      reading = true;
      try { const result = await getStockVibeRequest(pending.requestId); if (active) await finish(pending, result); }
      catch { /* The durable request remains unresolved; only its receipt is read. */ }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [pending, finish]);
  const write = async (kind: Pending["kind"], dispatch: (requestId: string) => Promise<StockVibeRequestRecord>) => {
    if (writing.current || pending) return;
    const current: Pending = { kind, requestId: crypto.randomUUID(), path: kind === "account" ? "/mona/paper/account" : "/mona/paper/trades", ...(kind === "trade" && selectedSymbol ? { symbol: selectedSymbol } : {}) };
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(current)); }
    catch { onErrorRef.current?.("无法保存本次操作状态，尚未提交。请检查本地存储后重试。"); return; }
    writing.current = true; setPending(current);
    try { await finish(current, await dispatch(current.requestId)); }
    catch (error) {
      if (error instanceof StockVibeApiError && ((error.status === 400 && error.code === "invalid_input") || [401, 403, 413].includes(error.status))) {
        localStorage.removeItem(PENDING_KEY); setPending(null); setPreview(null);
        const message = [401, 403].includes(error.status) ? "本次尚未提交，请检查应用访问权限后重试。" : "本次尚未提交，请修正输入后重试。";
        if (side || setup) setFieldError(message); else onErrorRef.current?.(message);
      } else onErrorRef.current?.("模拟操作结果尚未确认，系统会继续核对。请勿重复提交。");
    }
    finally { writing.current = false; }
  };
  const createAccount = () => {
    const cash = Number(initialCash);
    if (!initialCash.trim() || !Number.isFinite(cash) || cash <= 0 || cash > 1e9) { setFieldError("初始资金需大于 0 且不超过 10 亿元。"); return; }
    setFieldError(null); void write("account", (id) => createStockVibePaperAccount(id, { initial_cash: cash }));
  };
  const check = async () => {
    if (!selectedSymbol || !side || locked) return;
    const qty = Number(quantity), lot = data?.defaults.lot_size;
    if (!Number.isSafeInteger(qty) || qty <= 0 || (side === "buy" && lot && qty % lot !== 0)) {
      setFieldError(side === "buy" && lot ? `请输入 ${lot} 股的整数倍。` : "请输入大于 0 的整数股数。"); return;
    }
    const generation = ++previewGeneration.current;
    setPreview(null); setFieldError(null); setPreviewLoading(true);
    try {
      const result = await getStockVibePaperPreview({ symbol: selectedSymbol, side, quantity: qty });
      if (generation === previewGeneration.current) { setPreview(result); setNow(Date.now()); void read(); }
    } catch (error) { if (generation === previewGeneration.current) {
      if (error instanceof StockVibePaperApiError) setFieldError(error.message);
      else onErrorRef.current?.("暂时无法核对这笔模拟交易，请检查可用资金、持仓数量与行情后重试。");
    } }
    finally { if (generation === previewGeneration.current) setPreviewLoading(false); }
  };
  const confirm = () => {
    if (!previewValid || !preview || Date.parse(preview.expires_at) <= Date.now()) { setFieldError("参考价已变化或核对已过期，请重新核对。"); return; }
    void write("trade", (id) => commitStockVibePaperTrade(id, { preview_id: preview.preview_id, ...(note.trim() ? { note: note.trim() } : {}),
      ...(attachResearch && report ? { research: { session_id: report.session_id, attempt_id: report.attempt_id } } : {}) }));
  };
  const panel = <div className="stock-vibe-paper-panel flex min-h-0 flex-1 flex-col gap-3" aria-label="模拟持仓">
    {locked && <p role="status" className="text-caption text-muted-foreground">正在核对模拟操作结果…</p>}
    {!data ? !failed && <p role="status" className="text-caption text-muted-foreground">正在读取模拟持仓…</p> : !account ? <div className="space-y-3 py-3 text-caption text-muted-foreground">
      <p>还没有模拟持仓。</p><Button variant="secondary" size="sm" disabled={locked} onClick={() => { nextSide.current = null; setInitialCash(String(data.defaults.initial_cash)); setFieldError(null); setSetup(true); }}>设置模拟资金</Button>
    </div> : <>
      <dl className="space-y-2 text-caption tabular-nums" aria-label="模拟资金">
        {[["初始资金", account.initial_cash], ["总资产", account.equity], ["可用资金", account.cash], ["持仓浮动盈亏", account.unrealized_pnl], ["累计盈亏", account.total_pnl]].map(([label, value]) =>
          <div key={String(label)} className="flex justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className={String(label).includes("盈亏") ? pnlClass(value as number | null) : ""}>{String(label).includes("盈亏") ? signed(value as number | null) : amount(value as number | null)}</dd></div>)}
      </dl>
      {data.valuation.cached && <p className="text-micro text-muted-foreground">估值暂用上次模拟交易的参考报价，时点见各持仓。</p>}
      {!data.valuation.complete && <p className="text-caption text-muted-foreground">部分持仓缺少现价，总资产和浮动盈亏暂不完整。</p>}
      {data.positions.length ? <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto" aria-label="模拟持仓股票">{data.positions.map((item) => <li key={item.symbol}>
        <Button variant={selectedSymbol === item.symbol ? "secondary" : "ghost"} className="h-auto w-full flex-col items-stretch gap-1 px-2 py-2.5 text-left font-normal" aria-pressed={selectedSymbol === item.symbol} onClick={() => onSelect(item.symbol)}>
          <span className="flex justify-between gap-2"><span className="truncate font-medium">{item.name || item.symbol.slice(0, 6)}</span><span className={pnlClass(item.unrealized_pnl)}>{signed(item.unrealized_pnl)}</span></span>
          <span className="text-micro text-muted-foreground">{item.symbol.slice(0, 6)} · {item.quantity} 股</span>
          <span className="flex justify-between gap-2 text-micro text-muted-foreground"><span>成本 {amount(item.average_cost)}</span><span>现价 {amount(item.mark_price)}</span></span>
          <span className="text-micro text-muted-foreground">{item.mark_as_of ? `${QUOTE_SOURCES[item.quote_source ?? ""] ?? item.quote_source ?? "来源未报告"} · ${stockTime(item.mark_as_of)}${item.mark_status === "last_recorded_quote" ? " · 上次模拟交易价" : ""}` : "现价尚未取得"}</span>
        </Button>
      </li>)}</ul> : <p className="py-3 text-caption text-muted-foreground">尚未买入。选择一只股票后点击“模拟买入”。</p>}
      <div className="mt-auto flex items-center justify-between gap-1 border-t border-border pt-2 text-micro text-muted-foreground"><span>人民币 · 参考价记账</span><Button size="sm" variant="ghost" onClick={() => { setOffset(0); setHistoryOpen(true); }}>交易记录</Button></div>
    </>}
  </div>;
  const actions = <div className="flex flex-wrap items-center justify-end gap-2"><div className="flex shrink-0 gap-1" role="group" aria-label="模拟交易操作">
    <Button size="sm" variant="secondary" disabled={!selectedSymbol || !data || locked || failed} onClick={() => openTrade("buy")}>模拟买入</Button>
    <Button size="sm" variant="ghost" disabled={!selectedSymbol || !account || !position?.available_quantity || locked || failed} onClick={() => openTrade("sell")}>模拟卖出</Button>
  </div>{failed && <div role="status" className="flex items-center gap-1 text-caption text-muted-foreground"><span>模拟持仓暂未取得{data ? "，保留上次结果。" : "。"}</span><Button variant="ghost" size="sm" onClick={() => void read()}>重试读取</Button></div>}{locked && <span role="status" className="text-caption text-muted-foreground">正在核对模拟操作结果…</span>}{notice && <div className="flex items-center gap-1 text-caption text-muted-foreground"><span role="status">{notice}</span><Button variant="ghost" size="sm" onClick={() => { setOffset(0); setHistoryOpen(true); }}>查看记录</Button></div>}</div>;
  return <>
    {children({ panel, actions })}
    <Dialog open={setup} onOpenChange={(value) => { setSetup(value); setFieldError(null); if (!value) nextSide.current = null; }}><DialogContent aria-describedby={undefined} className="scrollbar-scope stock-vibe-workbench max-w-md">
      <DialogHeader><DialogTitle>设置模拟资金</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">使用虚拟资金，按行情参考价记录买卖。创建后保留这笔初始资金。</p>
      <label className="space-y-2 text-caption">初始资金（元）<Input type="number" min="0.01" max="1000000000" step="0.01" value={initialCash} disabled={locked} onChange={(event) => { setInitialCash(event.target.value); setFieldError(null); }} /></label>
      {fieldError && <p role="alert" className="text-caption text-destructive">{fieldError}</p>}
      {locked && <p role="status" className="text-caption text-muted-foreground">正在核对账户创建结果…</p>}
      <DialogFooter><Button variant="ghost" disabled={locked} onClick={() => setSetup(false)}>取消</Button><Button variant="secondary" disabled={locked} onClick={createAccount}>创建模拟账户</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={side !== null} onOpenChange={(value) => { if (!value) { previewGeneration.current++; setSide(null); setPreview(null); setPreviewLoading(false); } }}><DialogContent aria-describedby={undefined} className="scrollbar-scope stock-vibe-workbench max-h-[88dvh] max-w-lg overflow-y-auto">
      <DialogHeader><DialogTitle>{side === "sell" ? "模拟卖出" : "模拟买入"} · {preview?.name || position?.name || selectedSymbol?.slice(0, 6)}{(preview?.name || position?.name) && ` ${selectedSymbol?.slice(0, 6)}`}</DialogTitle></DialogHeader>
      <div className="flex justify-between gap-3 text-caption text-muted-foreground"><span>可用资金 {amount(account?.cash)} 元</span>{side === "sell" && <span>可卖 {position?.available_quantity ?? "—"} 股</span>}</div>
      <label className="space-y-2 text-caption">数量（股）<Input type="number" min="1" step={side === "buy" ? data?.defaults.lot_size : 1} disabled={locked} value={quantity} onChange={(event) => { previewGeneration.current++; setQuantity(event.target.value); setPreview(null); setPreviewLoading(false); setFieldError(null); }} /></label>
      {data?.defaults.lot_size && side === "buy" && <p className="text-caption text-muted-foreground">本次模拟按 {data.defaults.lot_size} 股的整数倍买入</p>}
      {fieldError && <p role="alert" className="text-caption text-destructive">{fieldError}</p>}
      {preview && <div className="space-y-3 border-y border-border py-3" aria-label="模拟交易核对">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-caption tabular-nums"><dt>参考价</dt><dd className="text-right">{amount(preview.price)} 元</dd><dt>交易金额</dt><dd className="text-right">{amount(preview.notional)} 元</dd><dt>费用</dt><dd className="text-right">{amount(preview.fee)} 元</dd><dt>{side === "sell" ? "到账资金" : "所需资金"}</dt><dd className="text-right">{amount(Math.abs(preview.cash_delta))} 元</dd><dt>记录后可用资金</dt><dd className="text-right">{amount(preview.cash_after)} 元</dd></dl>
        <p className="text-caption text-muted-foreground">按 {stockTime(preview.quote.as_of)} 的参考价记账 · {QUOTE_SOURCES[preview.quote.source] ?? preview.quote.source}。不代表实际成交。</p>
        <p className="text-micro text-muted-foreground">{previewValid ? `核对有效至 ${stockTime(preview.expires_at)}` : "核对已过期或账户已更新，请重新核对。"}</p>
      </div>}
      <label className="space-y-2 text-caption">{side === "sell" ? "卖出理由（选填）" : "买入理由（选填）"}<Textarea value={note} maxLength={500} disabled={locked} rows={2} onChange={(event) => setNote(event.target.value)} placeholder="记下这次判断，之后可以回看" /></label>
      {report && <label className="flex items-start gap-2 text-caption"><Checkbox className="mt-0.5" checked={attachResearch} disabled={locked} onCheckedChange={(value) => setAttachResearch(value === true)} /><span>关联最近研究<span className="block text-micro text-muted-foreground">{stockTime(report.completed_at ?? report.created_at)} · 保存这次报告快照</span></span></label>}
      {locked && <p role="status" className="text-caption text-muted-foreground">正在核对模拟交易结果，请勿重复提交。</p>}
      <DialogFooter><Button variant="ghost" disabled={locked} onClick={() => { setSide(null); setPreview(null); }}>取消</Button><Button variant="secondary" disabled={locked || previewLoading} onClick={() => void check()}>{previewLoading ? "核对中…" : preview ? "重新核对" : "核对参考价与费用"}</Button>{preview && <Button variant="secondary" disabled={locked || !previewValid} onClick={confirm}>{side === "sell" ? "确认模拟卖出" : "确认模拟买入"}</Button>}</DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={historyOpen} onOpenChange={(value) => { setHistoryOpen(value); if (!value) setDetail(null); }}><DialogContent aria-describedby={undefined} className="scrollbar-scope stock-vibe-workbench max-h-[88dvh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{detail ? "模拟交易详情" : "模拟交易记录"}</DialogTitle></DialogHeader>
      {!detail && <>{historyLoading ? <p role="status" className="text-caption text-muted-foreground">正在读取记录…</p> : trades.length ? <ul className="divide-y divide-border">{trades.map((trade) => <li key={trade.trade_id} className="flex items-center gap-3 py-3">
        <div className="min-w-0 flex-1"><p className="text-caption">{trade.side === "buy" ? "买入" : "卖出"} {trade.name || trade.symbol.slice(0, 6)} · {trade.quantity} 股 × {amount(trade.price)}</p><p className="text-micro text-muted-foreground">{stockTime(trade.recorded_at)}{trade.side === "sell" && <> · 已实现盈亏 <span className={pnlClass(trade.realized_pnl)}>{signed(trade.realized_pnl)}</span></>}</p></div><Button variant="ghost" size="sm" onClick={() => setDetail(trade)}>查看详情</Button>
      </li>)}</ul> : <p className="text-caption text-muted-foreground">{historyFailed ? "记录暂未取得，请关闭后重新打开。" : "还没有模拟交易记录。"}</p>}
      <DialogFooter><span className="mr-auto text-caption text-muted-foreground">共 {total} 笔</span><Button variant="ghost" size="sm" disabled={historyLoading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>上一页</Button><Button variant="ghost" size="sm" disabled={historyLoading || offset + PAGE_SIZE >= total} onClick={() => setOffset((value) => value + PAGE_SIZE)}>下一页</Button></DialogFooter></>}
      {detail && <div className="space-y-4 text-caption"><Button variant="ghost" size="sm" onClick={() => setDetail(null)}>← 返回记录</Button><p>{detail.name || detail.symbol.slice(0, 6)} · {detail.symbol.slice(0, 6)} · {detail.side === "buy" ? "买入" : "卖出"}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2"><dt>数量与参考价</dt><dd>{detail.quantity} 股 × {amount(detail.price)} 元</dd><dt>费用</dt><dd>{amount(detail.fee)} 元</dd><dt>记录后资金</dt><dd>{amount(detail.cash_after)} 元</dd><dt>记录后持股</dt><dd>{detail.quantity_after} 股</dd>{detail.side === "sell" && <><dt>已实现盈亏</dt><dd className={pnlClass(detail.realized_pnl)}>{signed(detail.realized_pnl)} 元</dd></>}</dl>
        <p className="text-muted-foreground">参考行情：{QUOTE_SOURCES[detail.quote.source] ?? detail.quote.source} · {stockTime(detail.quote.as_of)}<br />记录时间：{stockTime(detail.recorded_at)}</p>
        <section className="space-y-2"><h3 className="font-medium">当时的理由</h3><p className="whitespace-pre-wrap break-words">{detail.note || "本次没有填写理由。"}</p></section>
        {detail.research && <section className="space-y-2 border-t border-border pt-3"><h3 className="font-medium">关联研究</h3><p>{detail.research.title}</p><p className="whitespace-pre-wrap break-words text-muted-foreground">{detail.research.summary}</p><Button variant="ghost" size="sm" onClick={() => {
          onResearch(detail.symbol, detail.research?.task, { sessionId: detail.research!.session_id, attemptId: detail.research!.attempt_id, mode: detail.research?.mode, readOnly: true });
          setDetail(null); setHistoryOpen(false);
        }}>查看当时的报告 →</Button></section>}
      </div>}
    </DialogContent></Dialog>
  </>;
}
