import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  getStockVibeAnalysisHistory,
  type StockVibeAnalysisHistory as HistoryData, type StockVibeAnalysisRecord, type StockVibeResearchTask,
} from "@/lib/stock-vibe-api";
import { STOCK_RESEARCH_MODES, STOCK_RESEARCH_TASKS, stockTime } from "@/lib/stock-vibe-workbench";

const PAGE_SIZE = 10;
const STATUS: Record<string, string> = {
  idle: "尚未开始", pending: "等待分析", running: "分析中", waiting_user: "等待补充",
  completed: "已完成", failed: "未完成", cancelled: "已取消", interrupted: "已中断",
};
type StateFilter = "all" | "completed" | "active" | "unfinished";

export function StockVibeAnalysisHistory({ symbol, name, open, onOpenChange, onContinue }: {
  symbol: string; name?: string; open: boolean; onOpenChange: (open: boolean) => void;
  onContinue: (record: StockVibeAnalysisRecord) => void;
}) {
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [task, setTask] = useState<StockVibeResearchTask | "all">("all");
  const [state, setState] = useState<StateFilter>("all"), [offset, setOffset] = useState(0);
  const [data, setData] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(false), [failed, setFailed] = useState(false), [revision, setRevision] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setFailed(false);
    void getStockVibeAnalysisHistory(symbol, { q: query, task, state, offset, limit: PAGE_SIZE }).then(({ native }) => {
      if (native.symbol !== symbol || native.offset !== offset || native.limit !== PAGE_SIZE
        || !Array.isArray(native.items) || !Number.isSafeInteger(native.total) || native.total < 0) throw new Error("invalid analysis history");
      if (active) setData(native);
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, symbol, query, task, state, offset, revision]);

  const next = (record: StockVibeAnalysisRecord) => { onOpenChange(false); onContinue(record); };
  const total = data?.total ?? 0;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} className="scrollbar-scope relative flex h-[min(40rem,85dvh)] max-w-4xl flex-col gap-3">
      <DialogHeader>
        <DialogTitle>分析记录</DialogTitle>
        <DialogDescription>{name ? `${name} · ` : ""}{symbol.slice(0, 6)} · 查看已有分析与报告</DialogDescription>
      </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="搜索分析标题" placeholder="搜索分析标题" value={search} maxLength={120} className="pl-8" onChange={(event) => setSearch(event.target.value)} /></div>
          <Select aria-label="分析类型" className="w-36 shrink-0" value={task} onValueChange={(value) => { setTask(value as typeof task); setOffset(0); }}
            options={[{ value: "all", label: "全部类型" }, ...Object.entries(STOCK_RESEARCH_TASKS).map(([value, item]) => ({ value, label: item.label }))]} />
          <Select aria-label="分析状态" className="w-36 shrink-0" value={state} onValueChange={(value) => { setState(value as StateFilter); setOffset(0); }}
            options={[{ value: "all", label: "全部状态" }, { value: "completed", label: "已完成" }, { value: "active", label: "进行中" }, { value: "unfinished", label: "未完成" }]} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading}>
          {failed ? <div className="space-y-2 py-6 text-center"><p role="status" className="text-caption text-muted-foreground">暂时无法读取分析记录。</p>
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>重新读取</Button></div>
            : loading ? <p role="status" className="py-6 text-center text-caption text-muted-foreground">正在读取分析记录…</p>
              : !data?.items.length ? <p className="py-6 text-center text-caption text-muted-foreground">{query || task !== "all" || state !== "all" ? "没有符合条件的分析记录。" : "还没有这只股票的分析记录。"}</p>
                : <table className="w-full text-left text-caption">
                  <thead className="sticky top-0 bg-background text-muted-foreground"><tr><th className="py-2 font-medium">分析内容</th><th className="px-3 py-2 font-medium">状态</th><th className="px-3 py-2 font-medium">发起时间</th><th className="py-2 font-medium"><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>{data.items.map((record) => <tr key={`${record.session_id}:${record.attempt_id ?? "idle"}`} className="border-t border-border/60">
                    <td className="max-w-72 py-2"><p className="truncate font-medium" title={record.title}>{record.title || STOCK_RESEARCH_TASKS[record.task].label}</p>
                      <p className="text-muted-foreground">{STOCK_RESEARCH_TASKS[record.task].label} · {STOCK_RESEARCH_MODES[record.mode]}</p></td>
                    <td className="whitespace-nowrap px-3 py-2">{STATUS[record.status] ?? "状态待确认"}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{stockTime(record.created_at)}</td>
                    <td className="py-2 text-right"><Button variant="ghost" size="sm" onClick={() => next(record)}>
                      {record.status === "completed" && record.attempt_id ? "查看报告" : "查看进度"}</Button></td>
                  </tr>)}</tbody>
                </table>}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3 text-caption">
          <span className="text-muted-foreground">共 {total} 条记录</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="上一页分析记录" disabled={loading || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}><ChevronLeft size={16} /></Button>
            <span className="tabular-nums">{Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
            <Button variant="ghost" size="icon" aria-label="下一页分析记录" disabled={loading || offset + PAGE_SIZE >= total} onClick={() => setOffset((value) => value + PAGE_SIZE)}><ChevronRight size={16} /></Button>
          </div>
        </div>
    </DialogContent>
  </Dialog>;
}
