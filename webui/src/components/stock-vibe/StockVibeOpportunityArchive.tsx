import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getStockVibeAttempt, getStockVibeOperation } from "@/lib/stock-vibe-api";
import { getStockVibeOpportunitySession, parseStockVibeOpportunityResult, type StockVibeOpportunityResult } from "@/lib/stock-vibe-opportunity-api";
import { getStockVibeOpportunityRecords, type StockVibeOpportunitySelectionRecord } from "@/lib/stock-vibe-opportunity-records-api";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeReport } from "./StockVibeReport";

export function StockVibeOpportunityArchive({ onError, onMarket, onAdd }: { onError: (message: string) => void; onMarket: (symbol: string) => void; onAdd: (symbol: string) => void }) {
  const [offset, setOffset] = useState(0), [records, setRecords] = useState<StockVibeOpportunitySelectionRecord[]>([]), [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<StockVibeOpportunitySelectionRecord | null>(null), [result, setResult] = useState<StockVibeOpportunityResult | null>(null), [report, setReport] = useState("");
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    let active = true; setLoading(true);
    void getStockVibeOpportunityRecords(20, offset).then((value) => { if (active) { setRecords(value.items); setTotal(value.total); } }).catch(() => { if (active) errorRef.current("此前的选股记录读取失败，请重新打开档案查看。"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [offset]);
  useEffect(() => {
    if (!selected) return;
    let active = true; setResult(null); setReport(""); setReading(true);
    void (async () => {
      if (selected.operationId) { const value = await getStockVibeOperation(selected.operationId), native = value.native as Record<string, unknown>; if (native.operation_id !== selected.operationId || native.operation !== "opportunity_screen") throw new Error(); if (active) { const parsed = parseStockVibeOpportunityResult(native.tool_result); setResult(parsed); setReport(parsed?.report_markdown ?? ""); } }
      else if (selected.sessionId && selected.attemptId) { const [projection, attempt] = await Promise.all([getStockVibeOpportunitySession(selected.sessionId, selected.attemptId), getStockVibeAttempt(selected.sessionId, selected.attemptId)]); if (attempt.native.session_id !== selected.sessionId || attempt.native.attempt_id !== selected.attemptId) throw new Error(); if (active) { const parsed = parseStockVibeOpportunityResult(projection); setResult(parsed); setReport(parsed?.report_markdown || attempt.native.summary || ""); } }
    })().catch(() => { if (active) errorRef.current("这份早期选股档案暂时无法读取，系统没有重新执行。请稍后重新打开。"); }).finally(() => { if (active) setReading(false); });
    return () => { active = false; };
  }, [selected]);
  return <div className="space-y-3"><p className="text-muted-foreground">此前方法的只读存档，查看不会重新选股。</p>{selected ? <><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>返回档案列表</Button><h3 className="font-medium">{selected.title}</h3>{result && <><p className="text-muted-foreground">{result.candidates.length} 只候选{result.as_of ? ` · ${result.as_of}` : ""}</p><div className="space-y-3">{result.candidates.map((candidate) => <div key={candidate.symbol} className="border-b border-border pb-3"><div className="flex items-center justify-between"><strong>{candidate.name || candidate.symbol.slice(0, 6)}</strong><div><Button size="sm" variant="ghost" onClick={() => onMarket(candidate.symbol)}>看行情</Button><Button size="sm" variant="ghost" onClick={() => onAdd(candidate.symbol)}>加自选</Button></div></div><p>{candidate.support.join("；") || "原记录未提供入选依据。"}</p><p className="text-muted-foreground">{candidate.risks.join("；") || "原记录未提供完整风险资料。"}</p></div>)}</div><StockVibeInfo title="原档案的计算与验证记录" label="查看原计算记录"><pre className="whitespace-pre-wrap break-words">{JSON.stringify({ method: result.method, factor_audit: result.factor_audit, backtests: result.backtests, coverage: result.coverage, limitations: result.limitations }, null, 2)}</pre></StockVibeInfo></>}{report && <StockVibeInfo title="原选股研究报告" label="查看原研究报告"><StockVibeReport>{report}</StockVibeReport></StockVibeInfo>}{!result && !report && <p role="status">{reading ? "正在读取已有产物…" : "原档案没有可读取的候选或研究报告。"}</p>}</> : <>{loading ? <p role="status">正在读取选股档案…</p> : !records.length ? <p>没有此前的选股档案。</p> : records.map((row) => <button type="button" key={row.id} className="stock-vibe-opportunity-history" onClick={() => setSelected(row)}><span>{row.title}</span><span className="text-muted-foreground">{row.createdAt.slice(0, 16).replace("T", " ")}</span></button>)}{total > 20 && <div className="flex items-center justify-between"><Button size="sm" variant="ghost" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</Button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}</span><Button size="sm" variant="ghost" disabled={offset + 20 >= total || loading} onClick={() => setOffset(offset + 20)}>下一页</Button></div>}</>}</div>;
}
