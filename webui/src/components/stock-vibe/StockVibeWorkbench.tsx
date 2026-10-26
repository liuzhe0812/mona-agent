import { useEffect, useRef, useState } from "react";
import { FileText, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import {
  getStockVibeForecast, getStockVibeWorkbench, getStockVibeWorkbenchMarket, StockVibeApiError,
  type StockVibeChartInterval, type StockVibeForecast, type StockVibeRead, type StockVibeResearchTask,
  type StockVibeScenarioMode, type StockVibeWorkbenchData,
} from "@/lib/stock-vibe-api";
import { stockNumber, workbenchMarket } from "@/lib/stock-vibe-market";
import { readStockVibeQuoteSnapshots, saveStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";
import { STOCK_RESEARCH_MODES, STOCK_RESEARCH_TASKS, stockReportExcerpt, stockTime } from "@/lib/stock-vibe-workbench";
import { StockVibeChart } from "./StockVibeChart";
import { StockVibeAnalysisHistory } from "./StockVibeAnalysisHistory";
import { StockVibeQuoteSummary } from "./StockVibeQuoteSummary";
import { StockVibeFollowup } from "./StockVibeFollowup";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeNativeResearchDetails } from "./StockVibeNativeResearch";
import { StockVibeWatchlist } from "./StockVibeWatchlist";
import { StockVibePaperTrading } from "./StockVibePaperTrading";
import "./stock-vibe-workbench.css";

export interface StockVibeWorkbenchProps {
  nativeOrigin?: import("@/lib/stock-vibe-api").StockVibeNativeResearchOrigin;
  onOpenBacktestRun?: (runId: string) => void;
  symbols: string[]; selectedSymbol: string | null; interval: StockVibeChartInterval;
  market: StockVibeRead | null; loading: boolean; researchRevision?: number; mode?: StockVibeScenarioMode; marketNotice?: string | null;
  onSelect: (symbol: string) => void; onAdd: (symbol: string) => void; onRemove: (symbol: string) => void;
  onReorder: (symbols: string[]) => void;
  onInterval: (interval: StockVibeChartInterval) => void; onRefresh?: () => void;
  onResearch: (symbol: string, task?: StockVibeResearchTask, resume?: { sessionId: string; attemptId?: string; mode?: StockVibeScenarioMode; readOnly?: boolean }) => void;
  onAsk?: (symbol: string, question: string) => void;
  onAccount?: () => void; onError?: (message: string) => void;
}
const PREDICTION_KEY = "mona.stock-vibe.forecast-display.v1";

export function StockVibeWorkbench({
  symbols, selectedSymbol, interval, market, loading, researchRevision, mode = "swing", marketNotice,
  onSelect, onAdd, onRemove, onReorder, onInterval, onRefresh, onResearch, onAsk, onError,
  nativeOrigin, onOpenBacktestRun,
}: StockVibeWorkbenchProps) {
  const [data, setData] = useState<StockVibeWorkbenchData | null>(null);
  const [ask, setAsk] = useState("");
  const [dataFailed, setDataFailed] = useState(false), [revision, setRevision] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [forecast, setForecast] = useState<StockVibeForecast | null>(null), [forecastLoading, setForecastLoading] = useState(false);
  const forecastRead = useRef<Promise<StockVibeRead<StockVibeForecast>> | null>(null);
  const [prediction, setPrediction] = useState<{ intraday: boolean; "1D": boolean }>(() => {
    try { const p = JSON.parse(localStorage.getItem(PREDICTION_KEY) || "{}"); return { intraday: p.intraday === true, "1D": p["1D"] === true }; }
    catch { return { intraday: false, "1D": false }; }
  });
  const [quotes, setQuotes] = useState<Record<string, NonNullable<ReturnType<typeof workbenchMarket>>>>(readStockVibeQuoteSnapshots);
  const [quoteFailed, setQuoteFailed] = useState(false);
  const current = workbenchMarket(market, selectedSymbol);
  const quote = current ?? (selectedSymbol ? quotes[selectedSymbol] : null);
  const supportsPrediction = interval === "intraday" || interval === "1D";
  const predictionOn = supportsPrediction && prediction[interval];
  const selectedData = data?.symbol === selectedSymbol ? data : null;
  const latest = selectedData?.latest_report;
  const fail = (reason: unknown) => onError?.(reason instanceof StockVibeApiError ? reason.message : typeof reason === "string" ? reason : "股票操作未能完成，请稍后重试。");

  useEffect(() => setHistoryOpen(false), [selectedSymbol]);
  useEffect(() => { if (current && selectedSymbol) setQuotes((values) => ({ ...values, [selectedSymbol]: current })); }, [market, selectedSymbol]);
  useEffect(() => {
    setQuoteFailed(false);
    if (!selectedSymbol || interval === "intraday" || interval === "1D") return;
    let active = true;
    void getStockVibeWorkbenchMarket(selectedSymbol, "intraday").then((result) => {
      const value = workbenchMarket(result, selectedSymbol);
      if (!value || value.status !== "ok") throw new Error("quote unavailable");
      if (active) {
        setQuotes((values) => ({ ...values, [selectedSymbol]: value }));
        saveStockVibeMarketSnapshot(selectedSymbol, "intraday", result);
      }
    }).catch(() => { if (active) setQuoteFailed(true); });
    return () => { active = false; };
  }, [selectedSymbol, interval, market]);
  useEffect(() => { try { localStorage.setItem(PREDICTION_KEY, JSON.stringify(prediction)); } catch { /* Only presentation preferences. */ } }, [prediction]);
  useEffect(() => {
    setData(null); setDataFailed(false);
    if (!selectedSymbol) return;
    let active = true, reading = false;
    const read = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const { native } = await getStockVibeWorkbench(selectedSymbol);
        if (native.symbol !== selectedSymbol || !Array.isArray(native.sessions)) throw new StockVibeApiError(0, "invalid_response");
        if (active) { setData(native); setDataFailed(false); }
      } catch { if (active) setDataFailed(true); }
      finally { reading = false; }
    };
    void read();
    const timer = window.setInterval(() => void read(), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedSymbol, revision, researchRevision]);
  useEffect(() => {
    setForecast(null); setForecastLoading(false);
    if (!selectedSymbol || !supportsPrediction || !predictionOn || !current || current.status !== "ok" || current.interval !== interval) return;
    let active = true;
    let timer: number | undefined;
    setForecastLoading(true);
    const read = async () => {
      await forecastRead.current?.catch(() => undefined);
      if (!active) return;
      const request = getStockVibeForecast(selectedSymbol, interval);
      forecastRead.current = request;
      try {
        const { native } = await request;
        if (!active) return;
        if (native.symbol !== selectedSymbol || native.interval !== interval || !["ok", "pending", "unavailable"].includes(native.status))
          throw new StockVibeApiError(0, "invalid_response");
        setForecast(native);
        if (native.status === "pending") timer = window.setTimeout(() => void read(), stockNumber(native.retry_after_ms) ? Math.max(1000, native.retry_after_ms) : 2000);
        else setForecastLoading(false);
      } catch (reason) {
        if (active) { setForecastLoading(false); fail(reason); }
      } finally { if (forecastRead.current === request) forecastRead.current = null; }
    };
    void read();
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedSymbol, interval, predictionOn, market]);

  const openTask = (task: StockVibeResearchTask) => selectedSymbol && onResearch(selectedSymbol, task);

  return <StockVibePaperTrading selectedSymbol={selectedSymbol} latest={latest} onSelect={onSelect} onResearch={onResearch} onError={onError}>
    {({ panel, actions }) => <div className="stock-vibe-workbench-viewport" role="region" aria-label="投资工作台内容">
    <div className="stock-vibe-workbench stock-vibe-workbench-layout">
    <StockVibeWatchlist symbols={symbols} paperTrading={panel} selectedSymbol={selectedSymbol}
      currentMarket={current} knownQuotes={quotes}
      onSelect={onSelect} onAdd={onAdd} onRemove={onRemove} onReorder={onReorder} />
    <section className="stock-vibe-market-pane" aria-label="行情图">
      <StockVibeQuoteSummary symbol={selectedSymbol} market={quote} stale={Boolean(marketNotice) || quoteFailed} loading={loading}
        intervalControl={<div className="flex flex-wrap items-center gap-3" role="group" aria-label="行情周期">
          {([["intraday", "分时"], ["1D", "日K"], ["1W", "周K"], ["1M", "月K"]] as const).map(([value, label]) =>
            <Button key={value} size="sm" variant={interval === value ? "secondary" : "ghost"} className="stock-vibe-interval-tab" aria-pressed={interval === value} onClick={() => onInterval(value)}>{label}</Button>)}
          <select aria-label="分钟K周期" className="stock-vibe-interval-select text-caption" value={["1m", "5m", "15m", "30m", "1H"].includes(interval) ? interval : ""}
            onChange={(event) => event.target.value && onInterval(event.target.value as StockVibeChartInterval)}>
            <option value="" disabled>分钟K</option><option value="1m">1分钟</option><option value="5m">5分钟</option><option value="15m">15分钟</option><option value="30m">30分钟</option><option value="1H">1小时</option>
          </select>
        </div>}
        tradeActions={actions} />
      <div className="stock-vibe-chart-toolbar flex flex-wrap items-center justify-end gap-3">
        <Button variant="ghost" size="sm" disabled={!selectedSymbol || loading} onClick={onRefresh}>刷新行情</Button>
        {supportsPrediction && <label className="flex items-center gap-2 text-caption">走势预测
          <Switch checked={predictionOn} disabled={!selectedSymbol} aria-label={interval === "intraday" ? "分时走势预测" : "日K走势预测"}
            onCheckedChange={(checked) => setPrediction((value) => ({ ...value, [interval]: checked }))} />
        </label>}
      </div>
      {selectedSymbol ? <StockVibeChart symbol={selectedSymbol} result={market} loading={loading} interval={interval}
        forecast={predictionOn ? forecast : null} forecastLoading={forecastLoading} />
        : <EmptyState className="stock-vibe-chart-empty" title="添加 A 股代码以查看行情" description="默认显示最近交易日分时，也可以切换日K或其他周期。" />}
      {selectedSymbol && <form className="stock-vibe-ask" onSubmit={(event) => {
        event.preventDefault();
        const question = ask.trim();
        if (!question || !onAsk) return;
        // 问题随对话直接派发，输入框清空，避免同一句被重复提交。
        onAsk(selectedSymbol, question);
        setAsk("");
      }}>
        <Input aria-label="就这只股票继续追问" value={ask} onChange={(event) => setAsk(event.target.value)}
          placeholder="就这只股票继续追问，例如：这波放量能撑住吗？" />
        <Button type="submit" size="sm" className="stock-vibe-ask-send" disabled={!ask.trim() || !onAsk}>追问</Button>
      </form>}
    </section>
    <aside className="stock-vibe-research-pane" aria-label="股票研究侧栏">
      <section className="space-y-3"><SectionHeader title="研究这只股票" description="已带入当前股票与投资风格" className="items-start"
        actions={<Button variant="ghost" size="sm" disabled={!selectedSymbol} onClick={() => setHistoryOpen(true)}><History size={14} className="mr-1" />分析记录</Button>} />
        <Button className="stock-vibe-primary w-full gap-2" disabled={!selectedSymbol} onClick={() => openTask("comprehensive")}>
          <FileText size={16} />{STOCK_RESEARCH_TASKS.comprehensive.label}</Button>
        <div className="stock-vibe-analysis-row flex flex-wrap items-center gap-x-4 gap-y-1">
          {(["fundamental", "technical", "risk"] as const).map((task) =>
            <Button key={task} variant="ghost" className="stock-vibe-analysis-action" disabled={!selectedSymbol} onClick={() => openTask(task)}>
              {STOCK_RESEARCH_TASKS[task].label}</Button>)}
        </div>
      </section>
      <section className="stock-vibe-research-summary space-y-2 rounded-lg p-3" aria-label="最近研究">
        <SectionHeader title="最近研究" />
        {dataFailed || selectedData?.errors.some((item) => item.section === "sessions") ? <p className="text-caption text-muted-foreground">最近报告暂未取得，可打开分析记录重试。</p> : latest ? <>
          <p className="text-caption text-muted-foreground">{STOCK_RESEARCH_TASKS[latest.task]?.label ?? "研究"} · {stockTime(latest.completed_at ?? latest.created_at)}</p>
          <p className="line-clamp-3 whitespace-pre-wrap text-body">{stockReportExcerpt(latest.summary)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => selectedSymbol && onResearch(selectedSymbol, latest.task, { sessionId: latest.session_id, attemptId: latest.attempt_id, mode: latest.mode, readOnly: true })}>查看完整报告 →</Button>
          </div>
          <StockVibeInfo title="依据与数据范围" label="依据与数据范围" className="text-caption text-muted-foreground">
            <p className="mt-2">研究周期：{STOCK_RESEARCH_MODES[latest.mode]}。报告生成于 {stockTime(latest.completed_at ?? latest.created_at)}。数据时点、来源与缺项见报告正文。</p>
            <p>{latest.grounding_validation?.valid === true ? "报告数字与已记录证据的匹配检查通过，结论仍需复核。" : "请结合报告中的原始引用核查结论。"}</p>
          </StockVibeInfo>
        </> : <p className="text-caption text-muted-foreground">{selectedSymbol && !selectedData ? "正在读取…" : "还没有这只股票的已完成研究。选择上方分析内容开始。"}</p>}
      </section>
      {nativeOrigin?.swarm_id && onError && <StockVibeInfo title="来自选股研究" label="查看这只股票在选股研究里的依据">
        <StockVibeNativeResearchDetails swarmId={nativeOrigin.swarm_id} onError={onError} onOpenBacktestRun={onOpenBacktestRun} />
      </StockVibeInfo>}
      {selectedSymbol && <StockVibeFollowup key={selectedSymbol} symbol={selectedSymbol} mode={mode}
        jobs={selectedData?.scheduled_jobs ?? []} scheduler={selectedData?.scheduler ?? null}
        readState={dataFailed || selectedData?.errors.some((item) => item.section === "scheduled") ? "unavailable" : !selectedData ? "loading" : "ready"}
        onChanged={() => setRevision((v) => v + 1)} onError={fail} />}
    </aside>
    {selectedSymbol && <StockVibeAnalysisHistory key={selectedSymbol} symbol={selectedSymbol} name={quote?.quote.name} open={historyOpen} onOpenChange={setHistoryOpen}
      onContinue={(record) => onResearch(selectedSymbol, record.task, { sessionId: record.session_id, attemptId: record.attempt_id ?? undefined, mode: record.mode, readOnly: record.status === "completed" })} />}
    </div>
  </div>}
  </StockVibePaperTrading>;
}
