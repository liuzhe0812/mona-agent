import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getStockVibeNativeStrategy, type StockVibeNativeStrategy } from "@/lib/stock-vibe-native-research-api";
import { StockVibeInfo } from "./StockVibeInfo";

export interface StockVibeSavedStrategiesProps {
  strategies: StockVibeNativeStrategy[];
  total: number;
  offset: number;
  onPageChange: (offset: number) => void;
  onError: (message: string) => void;
  onReuseStrategy?: (id: string) => void;
  onOpenBacktestRun?: (runId: string) => void;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const recordedText = (value: unknown): string => typeof value === "string" ? value.trim() : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("；") : "";
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%` : "未记录";
const returnColor = (value: unknown) => typeof value === "number" && value !== 0 ? value > 0 ? "stock-vibe-opportunity-up" : "stock-vibe-opportunity-down" : "";
const RULES = [["signal_definition", "选股依据"], ["entry_rules", "买入规则"], ["exit_rules", "卖出规则"], ["position_sizing", "仓位规则"], ["universe", "适用范围"]] as const;

function SavedMethodDetails({ detail }: { detail: Record<string, unknown> }) {
  const description = isObject(detail.description) ? detail.description : {};
  const rows = Array.isArray(detail.rows) ? detail.rows.filter(isObject) : [];
  return <div className="space-y-4 text-caption">
    <dl className="space-y-3">{RULES.map(([key, label]) => <div key={key}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words">{recordedText(description[key]) || "原记录未保存"}</dd>
    </div>)}</dl>
    <section className="space-y-2" aria-label="方法的历史评估记录">
      <h3 className="font-medium">历史评估记录</h3>
      {rows.length ? <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>
        {["行情环境", "历史收益", "同期对照", "超额收益", "最大回撤", "记录时效"].map((label) => <th key={label} className="whitespace-nowrap border-b border-border p-2 font-medium">{label}</th>)}
      </tr></thead><tbody>{rows.map((row, index) => <tr key={index}>
        <td className="border-b border-border p-2">{({ bear_market: "下跌行情", bull_market: "上涨行情", structural: "结构性行情" } as Record<string, string>)[String(row.regime)] ?? "原记录未分类"}</td>
        <td className={`border-b border-border p-2 ${returnColor(row.return_in_regime)}`}>{percent(row.return_in_regime)}</td>
        <td className={`border-b border-border p-2 ${returnColor(row.benchmark_in_regime)}`}>{percent(row.benchmark_in_regime)}</td>
        <td className={`border-b border-border p-2 ${returnColor(row.excess_in_regime)}`}>{percent(row.excess_in_regime)}</td>
        <td className="border-b border-border p-2">{percent(row.max_drawdown_in_regime)}</td>
        <td className="border-b border-border p-2">{({ fresh: "近期记录", aging: "记录较早", stale: "记录已过期" } as Record<string, string>)[String(row.decay_status)] ?? "日期待核对"}</td>
      </tr>)}</tbody></table></div> : <p className="text-muted-foreground">暂未查到历史评估记录。这不代表从未回测，已有回测报告会单独列出。</p>}
      <StockVibeInfo title="历史评估记录是什么" label="如何理解这些记录？"><p>这里展示原方法保存的历史评估数据。有记录不代表评估通过，也不保证未来表现；没有记录也不能据此判断是否做过单次回测。</p></StockVibeInfo>
    </section>
    <StockVibeInfo title="方法的完整原始记录" label="查看完整原始记录"><pre className="whitespace-pre-wrap break-words">{JSON.stringify(detail, null, 2)}</pre></StockVibeInfo>
  </div>;
}

export function StockVibeSavedStrategies({ strategies, total, offset, onPageChange, onError, onReuseStrategy, onOpenBacktestRun }: StockVibeSavedStrategiesProps) {
  const [selected, setSelected] = useState<StockVibeNativeStrategy | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  const errorRef = useRef(onError); errorRef.current = onError;
  useEffect(() => {
    setDetail(null); setFailed(false);
    if (!selected) return;
    let active = true;
    void getStockVibeNativeStrategy(selected.strategy_id).then((value) => {
      if (value.strategy_id !== selected.strategy_id) throw new Error("strategy_source_mismatch");
      if (active) setDetail(value);
    }).catch(() => {
      if (active) { setFailed(true); errorRef.current("这份方法记录暂时无法读取，请稍后重新打开。"); }
    });
    return () => { active = false; };
  }, [selected]);
  const selectedDetail = detail?.strategy_id === selected?.strategy_id ? detail : null;
  const linked = selectedDetail && isObject(selectedDetail.linked_run) ? selectedDetail.linked_run.run_id : null;
  const runId = typeof linked === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(linked) ? linked : null;
  return <>
    <div className="stock-vibe-saved-methods stock-vibe-opportunity-history-list space-y-2" aria-label="我的方法列表">
      {strategies.length ? strategies.map((item) => <button key={item.strategy_id} type="button" className="stock-vibe-saved-method-card stock-vibe-opportunity-history border border-border" onClick={() => setSelected(item)}>
        <strong className="line-clamp-2 break-words font-medium">{item.name}</strong>
        <span className="line-clamp-2 text-caption">{recordedText(item.description) || "未记录选股依据，可打开查看已保存内容。"}</span>
        <span className="text-caption text-muted-foreground">{recordedText(item.universe) ? `适用范围：${recordedText(item.universe)}` : "未记录适用范围"}</span>
        <span className="text-caption text-muted-foreground">{item.has_evidence ? "有历史评估记录" : "暂未查到历史评估记录"}</span>
      </button>) : <p className="text-caption text-muted-foreground">还没有保存的方法。完成策略研发后，可保存方法与已有报告。</p>}
    </div>
    {total > 20 && <div className="flex items-center justify-between text-caption" aria-label="我的方法分页">
      <Button type="button" variant="ghost" size="sm" disabled={offset === 0} onClick={() => onPageChange(Math.max(0, offset - 20))}>上一页</Button>
      <span>{Math.floor(offset / 20) + 1} / {Math.ceil(total / 20)}</span>
      <Button type="button" variant="ghost" size="sm" disabled={offset + 20 >= total} onClick={() => onPageChange(offset + 20)}>下一页</Button>
    </div>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="scrollbar-scope flex max-h-[80vh] max-w-3xl flex-col">
        <DialogHeader className="pr-8"><DialogTitle>{selected?.name ?? "方法详情"}</DialogTitle></DialogHeader>
        <DialogClose asChild><Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="关闭方法详情"><X className="h-4 w-4" aria-hidden="true" /></Button></DialogClose>
        <div className="min-h-0 overflow-y-auto">{selectedDetail ? <SavedMethodDetails detail={selectedDetail} /> : <p role="status" className="text-caption text-muted-foreground">{failed ? "这份方法记录暂时无法读取。" : "正在读取方法规则与已有记录…"}</p>}</div>
        {selectedDetail && <div className="flex shrink-0 flex-wrap gap-2 border-t border-border pt-3">
          {runId && onOpenBacktestRun && <Button type="button" variant="secondary" onClick={() => { setSelected(null); onOpenBacktestRun(runId); }}>查看已有回测</Button>}
          {selected?.strategy_id.startsWith("sdm:") && onReuseStrategy && <Button type="button" variant="secondary" onClick={() => { onReuseStrategy(selected.strategy_id); setSelected(null); }}>基于此方法继续研究</Button>}
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
