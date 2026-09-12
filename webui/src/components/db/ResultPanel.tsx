import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useDbStore } from "./store/dbStore";
import { DataGrid } from "./DataGrid";
import type { QueryTab } from "./types";

export function ResultPanel({ tab: explicitTab }: { tab?: QueryTab }) {
  const activeTab = useDbStore((s) => s.queryTabs.find((t) => t.id === s.activeTabId));
  const tab = explicitTab ?? activeTab;
  const [view, setView] = useState<"result" | "message">("result");
  useEffect(() => { setView(tab?.error || (tab?.result && !tab.result.columns.length) ? "message" : "result"); }, [tab?.error, tab?.result]);
  if (!tab) return <EmptyState title="选择或新建查询" />;
  return <div className="flex h-full min-h-0 flex-col bg-background">
    <div className="flex h-8 shrink-0 items-center border-b border-border">
      {(["result", "message"] as const).map((value) => <Button key={value} variant="ghost" className={cn("h-8 rounded-none border-b-2 px-3 text-caption", view === value ? "border-info" : "border-transparent text-muted-foreground")} onClick={() => setView(value)}>{value === "result" ? "结果集" : "消息"}</Button>)}
      {tab.error && tab.result && <span className="px-2 text-caption text-warning">上次成功结果</span>}
      <span role="status" className="ml-auto px-3 text-caption text-muted-foreground">{tab.isExecuting ? "正在执行…" : tab.result ? `${tab.result.rows.length} 行 · ${tab.result.execution_time_ms} ms` : ""}</span>
    </div>
    {view === "message" ? <div className="flex-1 overflow-auto p-3 text-caption">
      {tab.error ? <pre role="alert" className="select-text whitespace-pre-wrap break-words font-mono text-destructive">{tab.error}</pre>
        : <p className="select-text whitespace-pre-wrap">{tab.result?.message ?? `执行成功，影响 ${tab.result?.affected_rows ?? 0} 行。`}</p>}
    </div> : tab.result?.columns.length ? <DataGrid tab={tab} /> : <EmptyState className="flex-1" title="执行查询后，结果会显示在这里" />}
  </div>;
}
