import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getStockVibeOperation, getStockVibeRequest, type StockVibeRequestRecord } from "@/lib/stock-vibe-api";
import {
  getStockVibeOpportunityHistory, getStockVibeOpportunityHistoryBatch,
  parseStockVibeOpportunityHistory, parseStockVibeOpportunityHistoryRange,
  type StockVibeOpportunityHistoryOutput, type StockVibeOpportunityHistoryPage, type StockVibeOpportunityHistoryRecord,
  type StockVibeOpportunityHistoryRequest, type StockVibeOpportunityHistoryResult, type StockVibeOpportunityHistoryRangeResult, type StockVibeOpportunityInput,
} from "@/lib/stock-vibe-opportunity-api";
import { StockVibeInfo } from "./StockVibeInfo";

const STORAGE = "mona.stock-vibe.opportunity-history-pending.v2";
const LEGACY_STORAGE = "mona.stock-vibe.opportunity-history.v1";
const RECORDS_CHANGED = "stock-vibe-opportunity-history-changed";
const UUID = /^(?:[\da-f]{32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL = new Set(["completed", "failed", "interrupted", "rejected"]);
const STATUS: Record<string, string> = {
  checking: "正在确认提交", unknown: "正在核对提交结果", queued: "排队中", running: "回测中",
  completed: "已完成", failed: "未完成", interrupted: "已中断", rejected: "未接受",
};
interface PendingRun { id: string; title: string; }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percent = (value: number | null) => finite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%` : "—";
const color = (value: number | null) => finite(value) && value !== 0 ? value > 0 ? "stock-vibe-opportunity-up" : "stock-vibe-opportunity-down" : "";
const relative = (value: number | null) => finite(value) ? value === 0 ? "与对照持平" : `${value > 0 ? "跑赢" : "落后"}${(Math.abs(value) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}个百分点` : "暂不能比较";
const price = (value: number | null) => finite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: 4 }) : "缺少价格";

function readPending(): PendingRun | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
    if (object(saved) && typeof saved.id === "string" && UUID.test(saved.id) && typeof saved.title === "string") return saved as unknown as PendingRun;
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_STORAGE) ?? "[]");
    const unresolved = Array.isArray(legacy) ? legacy.find((row) => object(row) && !row.operationId && typeof row.pending === "string" && UUID.test(row.pending)) : undefined;
    return unresolved ? { id: unresolved.pending, title: String(unresolved.title || "选股方法回测") } : null;
  } catch { return null; }
}

function receiptMatches(response: StockVibeRequestRecord, run: PendingRun): boolean {
  return response.request_id.replace(/-/g, "").toLowerCase() === run.id.replace(/-/g, "").toLowerCase()
    && response.method === "POST" && response.path === "/mona/operations";
}

function HistoryResult({ result }: { result: StockVibeOpportunityHistoryResult }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(result.candidates.length / 5));
  const currentPage = Math.min(page, pages - 1);
  const { summary, window: interval, benchmark } = result;
  const currentScope = object(result.coverage.roster) && result.coverage.roster.scope === "current_scope_historical_check";
  return <div className="space-y-3" aria-label="历史选股表现">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{result.selection_date} {result.status === "unavailable" ? "的回测记录" : "选出的股票"}</p><StockVibeInfo title="这次回测怎么算的" label="怎么算的">
      <p>本次设置：以{result.selection_date}收盘为选股时点，最多选前{result.top_n}只股票，观察之后{result.horizon}个交易日。历史选股只使用当时已知的资料；无法还原时会说明缺项。</p>
      <p>从{interval.start_date ?? "选股后下一市场交易日"}开盘，看到{interval.end_date ?? `选后第${result.horizon}个市场交易日`}收盘。每只股票的涨跌＝结束价÷起始价−1。</p>
      <p>每只股票起初占相同金额，把各只股票的涨跌幅取平均，期间不换股、不调仓。这里展示选后价格表现，未扣交易费用。</p>
      <p>大盘对照为{benchmark.name || "暂缺"}{benchmark.symbol ? `（${benchmark.symbol}）` : ""}，使用同一观察窗口。股票平均涨跌减去大盘涨跌，就是跑赢或落后的百分点。分红等计算口径不一致时不比较。</p>
      <p>行业对照按选股时各股票所属行业匹配，按这批股票的初始行业占比汇总；缺少行业归属或同期行业行情时，不计算完整行业对比。</p>
      <p>实际可观察{summary.observed}只／入选{summary.selected}只。缺少起止价格的股票不填零收益。原入选名单保留；资料不齐时不计算整批平均。</p>
      <p className="text-muted-foreground">下表股票为复权价格，指数为点位，用于比较价格变化，不代表实际成交价格。</p>
      <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr className="border-b border-border"><th className="py-2 font-medium">股票或指数</th><th className="py-2 text-right font-medium">起始开盘值</th><th className="py-2 text-right font-medium">结束收盘值</th></tr></thead><tbody>{result.candidates.map((item) => <tr key={item.symbol} className="border-b border-border"><td className="py-2">{item.name || item.symbol.slice(0, 6)}</td><td className="text-right">{price(item.start_price)}</td><td className="text-right">{price(item.end_price)}</td></tr>)}<tr><td className="py-2">{benchmark.name || "大盘对照"}</td><td className="text-right">{price(benchmark.start_price)}</td><td className="text-right">{price(benchmark.end_price)}</td></tr></tbody></table></div>
      <p className="text-muted-foreground">分红送转口径：{result.calculation.adjustment}。</p>
      <StockVibeInfo title="计算与资料详情" label="查看计算与资料详情"><div className="space-y-2"><p>起点：{result.calculation.start_basis}</p><p>终点：{result.calculation.end_basis}</p><p>平均方式：{result.calculation.weighting}</p><p>费用：{result.calculation.fees}</p>{result.limitations.map((item, index) => <p key={index}>{item}</p>)}<pre className="whitespace-pre-wrap break-words text-caption">{JSON.stringify({ method: result.method, coverage: result.coverage, benchmark: result.benchmark }, null, 2)}</pre></div></StockVibeInfo>
    </StockVibeInfo></div>
    {currentScope && <StockVibeInfo title="这次检验的股票范围" label="范围：当前成分的历史检验"><p>本次使用当前成分股票回看历史，尚未取得当年完整成分名单，可能遗漏当时在范围内、后来已退出的股票。因此，这次结果只反映当前成分在所选历史时点的表现。</p></StockVibeInfo>}
    <p className="text-muted-foreground">{interval.start_date ?? "起始日期待确认"} 至 {interval.end_date ?? "观察期尚未结束"} · {result.horizon}个交易日 · 未扣交易费用</p>
    <div className="stock-vibe-opportunity-history-metrics">
      <div><p className="text-muted-foreground">选后平均涨跌</p><p className={`text-ui font-semibold ${color(summary.average_return)}`}>{percent(summary.average_return)}</p><p className="text-muted-foreground">有效{summary.observed}只／入选{summary.selected}只</p></div>
      <div><p className="text-muted-foreground">同期大盘</p><p className={`text-ui font-semibold ${color(summary.market_return)}`}>{percent(summary.market_return)}</p><p className={color(summary.excess_market)}>{relative(summary.excess_market)}</p></div>
      <div><p className="text-muted-foreground">同期行业</p><p className={`text-ui font-semibold ${color(summary.industry_return)}`}>{percent(summary.industry_return)}</p><p className={color(summary.excess_industry)}>{relative(summary.excess_industry)}</p></div>
    </div>
    {(result.status !== "completed" || summary.selected === 0 || !finite(summary.industry_return) || !finite(summary.market_return)) && <p role="status" className="text-muted-foreground">{result.status === "unavailable" ? result.limitations[0] || "这次回测所需的历史资料不足。" : summary.selected === 0 ? "该历史日没有符合所选规则的入选股票。" : summary.observed < summary.selected ? "原入选名单保留；资料不齐时不计算整批平均。" : !finite(summary.industry_return) ? "缺少选股时的行业归属或同期行业行情，暂不能比较行业表现。" : benchmark.reason || "大盘对照资料不足，暂不能比较。"}</p>}
    {benchmark.name && <p className="text-muted-foreground">大盘对照：{benchmark.name}</p>}
    {result.candidates.length > 0 && <><div className="overflow-x-auto"><table className="w-full text-left" aria-label="历史入选名单"><thead><tr className="border-b border-border"><th className="py-2 font-medium">当时入选</th><th className="py-2 text-right font-medium">选后涨跌</th><th className="py-2 text-right font-medium">对比大盘</th><th className="py-2 text-right font-medium">对比行业</th></tr></thead><tbody>{result.candidates.slice(currentPage * 5, currentPage * 5 + 5).map((item) => <tr key={item.symbol} className="border-b border-border"><td className="py-2"><span className="mr-2 text-muted-foreground">{item.rank}</span>{item.name || item.symbol.slice(0, 6)}{item.name && <span className="ml-2 text-muted-foreground">{item.symbol.slice(0, 6)}</span>}{item.status !== "observed" && <p className="text-muted-foreground">{item.reason || (item.status === "pending" ? "观察期尚未结束" : "缺少完整行情")}</p>}</td><td className={`text-right ${color(item.return)}`}>{percent(item.return)}</td><td className={`text-right ${color(item.market_excess)}`}>{relative(item.market_excess)}{item.market_comparison_reason && <StockVibeInfo title={`${item.name || item.symbol.slice(0, 6)}的大盘对比`} label="查看原因">{item.market_comparison_reason}</StockVibeInfo>}</td><td className={`text-right ${color(item.industry?.excess ?? null)}`}><span>{relative(item.industry?.excess ?? null)}</span>{item.industry?.name && <span className="block text-muted-foreground">{item.industry.name}</span>}{item.industry?.reason && <StockVibeInfo title={`${item.name || item.symbol.slice(0, 6)}的行业对比`} label="查看缺项">{item.industry.reason}</StockVibeInfo>}</td></tr>)}</tbody></table></div>
    <div className="flex items-center justify-end gap-2" aria-label="历史名单分页"><Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><span>{currentPage + 1} / {pages}</span><Button variant="ghost" size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</Button></div></>}
  </div>;
}

const modeDays = { ultrashort: 1, swing: 5, medium: 20 };
const planNames: Record<string, string> = { multifactor: "多因子精选", low_volatility: "低波动量价", fundamental: "经营质量与估值", sector: "行业景气与资金", event: "公告与事件催化" };
const planTitle = (input: StockVibeOpportunityInput) => (input.plan_ids ?? [input.plan_id]).map((id) => planNames[id] || id).join(" + ");
function resultLabel(status: string, result?: StockVibeOpportunityHistoryOutput | null): string {
  if (!TERMINAL.has(status)) return STATUS[status] || "正在读取";
  if (status !== "completed") return STATUS[status] || "未完成";
  if (!result) return "正在读取";
  if (result.status === "unavailable") return "资料不足";
  if (awaitsObservation(result)) return "待观察";
  if (result.kind === "opportunity_history" && result.summary.selected > 0 && (!finite(result.summary.market_return) || !finite(result.summary.industry_return))) return "价格观察完成 · 对照资料缺失";
  return result.status === "incomplete" ? "部分资料缺失" : "已完成";
}
function awaitsObservation(result: StockVibeOpportunityHistoryOutput): boolean {
  if (result.status !== "incomplete") return false;
  if (result.kind === "opportunity_history_range") return result.batches.some((batch) => batch.summary.selected > 0 && (batch.window.available_trading_days < result.horizon || batch.summary.observed < batch.summary.selected));
  return result.candidates.length > 0 && (result.candidates.some((item) => item.status === "pending") || result.summary.observed < result.summary.selected || result.window.available_trading_days < result.horizon);
}

function matchesRequest(result: StockVibeOpportunityHistoryOutput, input: StockVibeOpportunityHistoryRequest): boolean {
  const plans = input.plan_ids ?? [input.plan_id];
  return result.horizon === input.horizon && result.top_n === input.top_n && result.universe === input.universe
    && result.plan_ids.length === plans.length && result.plan_ids.every((plan) => plans.includes(plan))
    && (result.kind === "opportunity_history" ? "selection_date" in input && result.selection_date === input.selection_date
      : "start_date" in input && result.start_date === input.start_date && result.end_date === input.end_date);
}

function useHistoryRecovery(onError: (message: string) => void, onAccepted: (id: string) => void) {
  const [pending, setPending] = useState(readPending);
  const errorRef = useRef(onError), acceptedRef = useRef(onAccepted);
  errorRef.current = onError; acceptedRef.current = onAccepted;
  const clear = useCallback((id: string) => {
    setPending(null);
    try {
      localStorage.removeItem(STORAGE);
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE) ?? "null");
      if (Array.isArray(legacy)) localStorage.setItem(LEGACY_STORAGE, JSON.stringify(legacy.filter((row) => !object(row) || row.operationId || row.pending !== id)));
    } catch { /* Older records remain read-only; they are never submitted again. */ }
  }, []);
  const confirm = useCallback((response: StockVibeRequestRecord, run: PendingRun) => {
    const code = response.receipt?.status_code, signed = /^[a-f0-9]{64}$/i.test(response.receipt_sha256 ?? ""), body = response.receipt?.body;
    if (receiptMatches(response, run) && response.status === "completed" && Number.isInteger(code) && code! >= 200 && code! < 300 && signed && object(body) && typeof body.operation_id === "string" && ID.test(body.operation_id)) {
      clear(run.id); acceptedRef.current(body.operation_id); window.dispatchEvent(new Event(RECORDS_CHANGED));
    } else if (receiptMatches(response, run) && response.status === "rejected" && ((response.error_category === "not_dispatched" && response.receipt === null && response.source === null) || (Number.isInteger(code) && code! >= 400 && code! < 500 && signed))) {
      clear(run.id); errorRef.current("上次回测请求未被接受，没有重新提交。");
    }
  }, [clear]);
  useEffect(() => {
    if (!pending) return;
    let disposed = false, reading = false, alerted = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try { const receipt = await getStockVibeRequest(pending.id); if (!disposed) confirm(receipt, pending); }
      catch { if (!disposed && !alerted) { alerted = true; errorRef.current("暂时无法核对上次回测提交，原请求已保留，没有重新提交。"); } }
      finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [confirm, pending]);
  return { pending };
}

function useHistoryOperation(id: string | undefined, onError: (message: string) => void, expected?: StockVibeOpportunityHistoryRequest) {
  const [state, setState] = useState<{ id?: string; status: string; result?: StockVibeOpportunityHistoryOutput; input?: StockVibeOpportunityHistoryRequest; progress?: { completed: number; total: number } }>({ status: "queued" });
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const expectedIdentity = JSON.stringify(expected ?? null);
  useEffect(() => {
    if (!id) return;
    let disposed = false, reading = false, done = false, alerted = false;
    setState({ id, status: "queued" });
    const poll = async () => {
      if (reading || done) return;
      reading = true;
      try {
        const { native } = await getStockVibeOperation(id);
        if (disposed) return;
        if (!object(native) || native.operation_id !== id || !["opportunity_history", "opportunity_history_range", "opportunity_history_continue"].includes(String(native.operation)) || !["queued", "running", "completed", "failed", "interrupted"].includes(String(native.status))) throw new Error("invalid_response");
        const result = parseStockVibeOpportunityHistory(native.tool_result) ?? parseStockVibeOpportunityHistoryRange(native.tool_result);
        if (native.status === "completed" && !result) throw new Error("invalid_response");
        const original = expected ?? (object(native.payload) && typeof native.payload.plan_id === "string" ? native.payload as unknown as StockVibeOpportunityHistoryRequest : undefined);
        if (result && original && !matchesRequest(result, original)) throw new Error("invalid_response");
        const progress = object(native.references) && object(native.references.progress) ? native.references.progress : null;
        setState({ id, status: String(native.status), result: result ?? undefined, input: object(native.payload) ? native.payload as unknown as StockVibeOpportunityHistoryRequest : undefined,
          progress: progress?.stage === "history_batches" && Number.isInteger(progress.completed) && Number.isInteger(progress.total) && Number(progress.completed) >= 0 && Number(progress.total) >= Number(progress.completed) ? { completed: Number(progress.completed), total: Number(progress.total) } : undefined });
        done = TERMINAL.has(String(native.status));
        if (done) window.dispatchEvent(new Event(RECORDS_CHANGED));
      } catch {
        if (!disposed && !alerted) { alerted = true; onErrorRef.current("暂时无法读取这次回测，系统没有重新提交。可以稍后重新打开查看。"); }
      } finally { reading = false; }
    };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [id, expectedIdentity]);
  return state.id === id ? state : { status: "queued" };
}

function HistoryConditions({ result, input }: { result: StockVibeOpportunityHistoryOutput; input?: StockVibeOpportunityHistoryRequest }) {
  const request = result.request ?? input;
  return <div className="space-y-1 text-muted-foreground" aria-label="本次回测条件"><p>{request ? planTitle(request) : result.plan_ids.map((id) => planNames[id] || id).join(" + ")} · {result.universe === "watchlist" ? `原自选范围${request?.symbols ? `（${request.symbols.length}只）` : ""}` : "沪深300"} · 前{result.top_n}只</p><p>{request ? `按${modeDays[request.mode]}日目标选股，` : ""}观察{result.horizon}个交易日{result.kind === "opportunity_history_range" ? result.sampling === "all_market_days_v1" ? " · 每个市场交易日重新选股" : ` · 每${result.frequency_trading_days}个交易日检验一批` : ""}</p>{result.observation_cutoff && <p>后续行情观察截至{result.observation_cutoff}，原选股日期与名单保留。</p>}{request?.conditions && <StockVibeInfo title="本次选股条件" label="查看原选股条件">{request.conditions}</StockVibeInfo>}</div>;
}

function RangeResult({ result, operationId, onError }: { result: StockVibeOpportunityHistoryRangeResult; operationId: string; onError: (message: string) => void }) {
  const [page, setPage] = useState(0), [batch, setBatch] = useState<StockVibeOpportunityHistoryResult | null>(null), [loading, setLoading] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil(result.batches.length / 10)), currentPage = Math.min(page, pages - 1), summary = result.summary;
  const daily = result.sampling === "all_market_days_v1";
  const showBatch = async (id: string, day: string) => {
    if (loading) return;
    setLoading(id);
    try {
      const selected = await getStockVibeOpportunityHistoryBatch(operationId, id);
      if (selected.selection_date !== day || selected.horizon !== result.horizon || selected.top_n !== result.top_n) throw new Error("invalid_response");
      setBatch(selected);
    } catch { onError("这批历史选股详情暂时无法读取，请稍后再试。"); }
    finally { setLoading(null); }
  };
  return <div className="space-y-3" aria-label="区间回测结果">
    <div className="flex items-center justify-between gap-2"><p className="font-medium">{result.start_date} 至 {result.end_date}</p><StockVibeInfo title="区间回测怎么算的" label="怎么算的"><p>{daily ? `每个市场交易日用当时已知的信息重新选前${result.top_n}只股票，再观察选后${result.horizon}个交易日。邻近选股日的观察期可能重叠，批次数不代表独立检验次数。` : `每隔${result.frequency_trading_days}个市场交易日，用当时已知的信息重新选前${result.top_n}只股票，再观察选后${result.horizon}个交易日。每批观察窗口不重叠。`}</p><p>汇总是每批选后平均表现的平均值，不是把资金连续投入的累计收益。尚未走完观察期、资料不齐和没有入选股票的批次分别保留，不填零表现。</p><p>大盘、行业均按各批相同的观察日期比较；只在计算口径一致且资料完整的批次中比较，具体对照和起止价格可点开每批详情查看。</p>{result.calculation.range_end && <p>{result.calculation.range_end}</p>}<p>{result.calculation.fees}；{result.calculation.adjustment}。</p>{result.limitations.map((item, index) => <p key={index}>{item}</p>)}</StockVibeInfo></div>
    <div className="stock-vibe-opportunity-history-metrics"><div><p className="text-muted-foreground">各批平均涨跌</p><p className={`font-semibold ${color(summary.average_return)}`}>{percent(summary.average_return)}</p><p className="text-muted-foreground">完整{summary.complete_batches}批／共{summary.total_batches}批</p></div><div><p className="text-muted-foreground">同期大盘平均</p><p className={color(summary.market_return)}>{percent(summary.market_return)}</p><p className={color(summary.excess_market)}>{relative(summary.excess_market)}</p></div><div><p className="text-muted-foreground">同期行业平均</p><p className={color(summary.industry_return)}>{percent(summary.industry_return)}</p><p className={color(summary.excess_industry)}>{relative(summary.excess_industry)}</p></div></div>
    {result.roster_scopes?.includes("current_scope_historical_check") && <StockVibeInfo title="这次检验的股票范围" label="范围：当前成分的历史检验"><p>本次使用当前成分股票回看历史，尚未取得当年完整成分名单，可能遗漏当时在范围内、后来已退出的股票。因此，这次结果只反映当前成分在所选历史时点的表现。</p></StockVibeInfo>}
    {result.roster_scopes?.includes("user_specified_scope") && <StockVibeInfo title="这次检验的自选范围" label="按本次自选范围检验"><p>这次按提交时固定的自选范围检验。历史自选名单尚未还原，结果只覆盖本次指定的股票。</p></StockVibeInfo>}
    <p className="text-muted-foreground">每批选后平均表现的平均值，未扣交易费用。跑赢大盘{summary.outperform_market_count}批／可比较{summary.comparable_market_batches}批。</p>
    {(daily || summary.evaluated_start_date !== undefined) && <p className="text-muted-foreground" aria-label="实际完成覆盖">实际完成覆盖：{summary.evaluated_start_date && summary.evaluated_end_date ? `${summary.evaluated_start_date} 至 ${summary.evaluated_end_date}` : summary.complete_batches === 0 ? "尚无完整批次" : "完整批次覆盖日期暂缺"}{summary.incomplete_batches !== undefined && ` · 待观察或待补资料${summary.incomplete_batches}批`}{summary.unavailable_batches !== undefined && ` · 无法重建${summary.unavailable_batches}批`}{summary.empty_batches !== undefined && ` · 无入选${summary.empty_batches}批`}</p>}
    {daily && <p className="text-muted-foreground">逐日选股的观察期可能重叠，批次数不代表独立检验次数。</p>}
    {!!result.period_summaries?.length && <div className="overflow-x-auto"><table className="w-full text-left" aria-label="分段历史表现"><thead><tr className="border-b border-border"><th className="py-2 font-medium">时段</th><th className="text-right font-medium">平均涨跌</th><th className="text-right font-medium">对比大盘</th><th className="text-right font-medium">对比行业</th><th className="text-right font-medium">完整／总批次</th></tr></thead><tbody>{result.period_summaries.map((period) => <tr className="border-b border-border" key={`${period.label}-${period.start_date}-${period.end_date}`}><td className="py-2">{period.label}</td><td className={`text-right ${color(period.average_return)}`}>{percent(period.average_return)}</td><td className={`text-right ${color(period.excess_market)}`}>{relative(period.excess_market)}</td><td className={`text-right ${color(period.excess_industry)}`}>{relative(period.excess_industry)}</td><td className="text-right text-muted-foreground">{period.complete_batches}／{period.total_batches}</td></tr>)}</tbody></table></div>}
    {!!result.offset_stability?.groups.length && <StockVibeInfo title="不同起点下的表现" label="不同起点会影响结果吗"><p>把相隔{result.horizon}个交易日的选股日放在同一组，比较各组完整批次的平均涨跌，看看更换起点是否影响结果。各组共享同一段历史资料，不代表上涨概率或准确率。</p><p>各组平均涨跌范围：<span className={color(result.offset_stability.min_average_return)}>{percent(result.offset_stability.min_average_return)}</span> 至 <span className={color(result.offset_stability.max_average_return)}>{percent(result.offset_stability.max_average_return)}</span>。</p><div className="overflow-x-auto"><table className="w-full text-left" aria-label="不同起点分组表现"><thead><tr className="border-b border-border"><th className="py-2 font-medium">起点</th><th className="text-right font-medium">平均涨跌</th><th className="text-right font-medium">对比大盘</th><th className="text-right font-medium">完整／总批次</th></tr></thead><tbody>{result.offset_stability.groups.map((group) => <tr key={group.offset} className="border-b border-border"><td className="py-2">{group.offset === 0 ? "首个交易日" : `延后${group.offset}个交易日`}</td><td className={`text-right ${color(group.average_return)}`}>{percent(group.average_return)}</td><td className={`text-right ${color(group.excess_market)}`}>{relative(group.excess_market)}</td><td className="text-right text-muted-foreground">{group.complete_batches}／{group.total_batches}</td></tr>)}</tbody></table></div></StockVibeInfo>}
    <div className="overflow-x-auto"><table className="w-full text-left" aria-label="历史回测批次"><thead><tr className="border-b border-border"><th className="py-2 font-medium">历史选股日</th><th className="text-right font-medium">选后平均涨跌</th><th className="text-right font-medium">对比大盘</th><th className="text-right font-medium">状态</th></tr></thead><tbody>{result.batches.slice(currentPage * 10, currentPage * 10 + 10).map((item) => <tr key={item.batch_id} className="border-b border-border"><td><Button variant="ghost" size="sm" disabled={!!loading} onClick={() => { void showBatch(item.batch_id, item.selection_date); }}>{loading === item.batch_id ? "读取中…" : item.selection_date}</Button></td><td className={`text-right ${color(item.summary.average_return)}`}>{percent(item.summary.average_return)}</td><td className={`text-right ${color(item.summary.excess_market)}`}>{relative(item.summary.excess_market)}</td><td className="text-right text-muted-foreground">{item.status === "unavailable" ? "资料不足" : item.summary.selected > 0 && item.window.available_trading_days < result.horizon ? "待观察" : item.status === "incomplete" ? "部分资料缺失" : item.summary.selected === 0 ? "无入选股票" : "已完成"}</td></tr>)}</tbody></table></div>
    {pages > 1 && <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一批次页</Button><span>{currentPage + 1} / {pages}</span><Button variant="ghost" size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一批次页</Button></div>}
    <Dialog open={!!batch} onOpenChange={(open) => { if (!open) setBatch(null); }}><DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[80vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>历史批次详情</DialogTitle></DialogHeader>{batch && <HistoryResult result={batch} />}</DialogContent></Dialog>
  </div>;
}

function HistoryDetail({ operationId, input, onError }: { operationId: string; input?: StockVibeOpportunityHistoryRequest; onError: (message: string) => void }) {
  const state = useHistoryOperation(operationId, onError, input), result = state.result;
  return <div className="space-y-3 text-caption"><p role="status" className="text-muted-foreground">{resultLabel(state.status, result)}{!TERMINAL.has(state.status) && state.progress && ` · 已检验 ${state.progress.completed} / ${state.progress.total} 个交易日`}{!TERMINAL.has(state.status) && " · 可关闭此浮窗，稍后在历史记录查看。"}</p>{result && <><HistoryConditions result={result} input={input ?? state.input} />{result.kind === "opportunity_history" ? <HistoryResult key={operationId} result={result} /> : <RangeResult key={operationId} result={result} operationId={operationId} onError={onError} />}</>}{["failed", "interrupted"].includes(state.status) && <p className="text-muted-foreground">本次未完整结束，已有结果保留；系统不会重新执行选股。</p>}</div>;
}

export function StockVibeOpportunityHistoryRecords({ onError }: { onError: (message: string) => void }) {
  const [offset, setOffset] = useState(0), [page, setPage] = useState<StockVibeOpportunityHistoryPage>({ items: [], total: 0, limit: 20, offset: 0 }), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [selected, setSelected] = useState<string>();
  const [readFailed, setReadFailed] = useState(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const recovery = useHistoryRecovery(onError, setSelected);
  useEffect(() => { const changed = () => setRevision((value) => value + 1); window.addEventListener(RECORDS_CHANGED, changed); return () => window.removeEventListener(RECORDS_CHANGED, changed); }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    getStockVibeOpportunityHistory(20, offset).then((result) => {
      if (!disposed) { setReadFailed(false); setPage(result); if (offset >= result.total && offset > 0) setOffset(Math.max(0, Math.floor((result.total - 1) / 20) * 20)); }
    }).catch(() => { if (!disposed) { setReadFailed(true); onErrorRef.current("回测记录暂时无法读取，请稍后重新打开。已有记录不会丢失。"); } }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [offset, revision]);
  useEffect(() => {
    if (!page.items.some((item) => !TERMINAL.has(item.status))) return;
    const timer = window.setInterval(() => setRevision((value) => value + 1), 3000);
    return () => window.clearInterval(timer);
  }, [page.items]);
  const selectedRecord = page.items.find((item) => item.operation_id === selected);
  const recordStatus = (row: StockVibeOpportunityHistoryRecord) => row.status !== "completed" ? STATUS[row.status] || "未完成" : row.result_status === "unavailable" ? "资料不足" : row.result_status === "pending" || row.result_status === "awaiting_observation" ? "待观察" : row.result_status === "incomplete" ? "资料缺失" : row.summary?.selected === 0 ? "无入选股票" : row.summary && (row.summary.selected ?? 0) > 0 && (!finite(row.summary.market_return) || !finite(row.summary.industry_return)) ? "对照资料缺失" : "已完成";
  return <div className="flex min-h-0 flex-1 flex-col gap-2" aria-label="回测历史记录">
    {recovery.pending && <p role="status" className="text-caption text-muted-foreground">正在核对上次提交，不会重复执行。</p>}
    {loading && page.items.length === 0 && <p role="status" className="text-caption text-muted-foreground">正在读取回测记录…</p>}
    {!loading && !readFailed && page.items.length === 0 && <p className="text-caption text-muted-foreground">还没有已保存的回测记录。</p>}
    <div className="stock-vibe-opportunity-history-list space-y-1">{page.items.map((row) => <Button type="button" variant="ghost" className="stock-vibe-opportunity-record h-auto whitespace-normal font-normal" key={row.operation_id} onClick={() => setSelected(row.operation_id)}><span className="block font-medium">{planTitle(row.input)}</span><span className="block text-caption text-muted-foreground">{"selection_date" in row.input ? row.input.selection_date : `${row.input.start_date} 至 ${row.input.end_date}`}</span><span className="block text-caption text-muted-foreground">前{row.input.top_n}只 · {row.input.horizon}个交易日 · {recordStatus(row)}</span>{row.source_operation_id && <span className="block text-caption text-muted-foreground">继续观察记录</span>}</Button>)}</div>
    {page.total > 20 && <div className="flex shrink-0 items-center gap-1 text-caption"><Button variant="ghost" size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><Select aria-label="回测记录页码" value={String(offset / 20)} onValueChange={(value) => setOffset(Number(value) * 20)} options={Array.from({ length: Math.ceil(page.total / 20) }, (_, index) => ({ value: String(index), label: `${index + 1} / ${Math.ceil(page.total / 20)}` }))} /><Button variant="ghost" size="sm" disabled={offset + 20 >= page.total || loading} onClick={() => setOffset(offset + 20)}>下一页</Button></div>}
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(undefined); }}><DialogContent aria-describedby={undefined} className="scrollbar-scope flex max-h-[85vh] max-w-3xl flex-col"><DialogHeader><DialogTitle>选股方法回测详情</DialogTitle></DialogHeader><div className="min-h-0 overflow-y-auto">{selected && <HistoryDetail key={selected} operationId={selected} input={selectedRecord?.input} onError={onError} />}</div></DialogContent></Dialog>
  </div>;
}
