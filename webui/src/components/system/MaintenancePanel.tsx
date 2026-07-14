import { AlertTriangle, CheckCircle2, Database, History, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { MetricCard, PanelCard, StatusPill, secondaryButtonClass } from "./SystemUi";
import { useMaintenanceHistory, type MaintenanceEvent } from "./useSystemData";

const filters = ["全部", "清理", "更新", "启动项", "卸载"];

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function eventTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusTone(status: string): "green" | "orange" | "red" {
  if (status === "成功") return "green";
  return status === "部分成功" ? "orange" : "red";
}

export function MaintenancePanel() {
  const { data, loading, error, restoringId, refresh, restore } = useMaintenanceHistory();
  const [filter, setFilter] = useState("全部");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const events = data?.events ?? [];
  const now = new Date();
  const monthEvents = events.filter((event) => {
    const date = new Date(event.ts * 1000);
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
  const releasedBytes = monthEvents.filter((event) => event.category === "清理" && event.status !== "失败").reduce((sum, event) => sum + event.bytesChanged, 0);
  const completedUpdates = monthEvents.filter((event) => event.category === "更新" && event.status === "成功").length;
  const failedCount = events.filter((event) => event.status === "失败" || event.status === "部分成功").length;
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return events.filter((event) => (filter === "全部" || event.category === filter) && (!keyword || `${event.title} ${event.detail} ${event.source}`.toLocaleLowerCase().includes(keyword)));
  }, [events, filter, query]);
  const selected = filtered.find((event) => event.id === selectedId) ?? filtered[0] ?? null;
  const recoverable = events.filter((event) => event.reversible && event.relatedId && event.restoreEnabled !== null).slice(0, 5);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="本月维护" value={loading ? "—" : `${monthEvents.length} 次`} detail="Mona 已记录的系统操作" icon={<History className="h-4 w-4" />} accent="violet" />
        <MetricCard label="释放空间" value={loading ? "—" : formatBytes(releasedBytes)} detail="按清理前后实测" icon={<Database className="h-4 w-4" />} />
        <MetricCard label="完成更新" value={loading ? "—" : `${completedUpdates} 项`} detail="WinGet 返回成功" icon={<CheckCircle2 className="h-4 w-4" />} accent="green" />
        <MetricCard label="失败操作" value={loading ? "—" : `${failedCount} 项`} detail={failedCount ? "保留原始失败信息" : "暂无失败"} icon={<AlertTriangle className="h-4 w-4" />} accent={failedCount ? "orange" : "green"} />
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-700">维护记录读取失败：{error}<button className="ml-2 underline" onClick={refresh}>重试</button></div>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">{filters.map((item) => <button key={item} onClick={() => setFilter(item)} className={item === filter ? "h-8 rounded-lg bg-blue-600 px-3 text-xs text-white" : secondaryButtonClass}>{item}</button>)}</div>
        <input aria-label="搜索维护记录" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索维护记录" className="h-8 w-48 rounded-lg border bg-background px-3 text-xs" />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.8fr)]">
        <PanelCard title="维护时间线" className="h-full">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">正在读取维护记录...</div>
          ) : filtered.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">没有匹配的维护记录</div>
          ) : (
            <div className="relative space-y-1 before:absolute before:bottom-4 before:left-[78px] before:top-4 before:w-px before:bg-border">
              {filtered.map((event) => (
                <button key={event.id} type="button" onClick={() => setSelectedId(event.id)} className={`relative flex w-full items-center gap-3 rounded-lg p-2 text-left transition ${selected?.id === event.id ? "bg-blue-500/5" : "hover:bg-muted/40"}`}>
                  <span className="w-16 shrink-0 text-[10px] text-muted-foreground">{eventTime(event.ts)}</span>
                  <span className={`z-10 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-background ${event.status === "成功" ? "bg-emerald-500" : "bg-orange-500"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" title={event.title}>{event.title}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground" title={event.detail}>{event.detail}</span>
                  </span>
                  <StatusPill tone={statusTone(event.status)}>{event.status}</StatusPill>
                </button>
              ))}
            </div>
          )}
        </PanelCard>

        <div className="space-y-3">
          <PanelCard title="执行详情">
            {selected ? (
              <div className="space-y-3 text-xs">
                <div><p className="text-[10px] text-muted-foreground">操作</p><p className="mt-1 font-medium">{selected.title}</p></div>
                <div className="grid grid-cols-2 gap-3"><div><p className="text-[10px] text-muted-foreground">来源</p><p className="mt-1">{selected.source}</p></div><div><p className="text-[10px] text-muted-foreground">结果</p><p className="mt-1">{selected.status}</p></div></div>
                <div><p className="text-[10px] text-muted-foreground">依据</p><p className="mt-1 break-words leading-5">{selected.detail}</p></div>
                {selected.bytesChanged > 0 && <div><p className="text-[10px] text-muted-foreground">空间变化</p><p className="mt-1 text-emerald-600">释放 {formatBytes(selected.bytesChanged)}</p></div>}
              </div>
            ) : <p className="py-8 text-center text-xs text-muted-foreground">选择一条记录查看详情</p>}
          </PanelCard>

          <PanelCard title="可恢复操作">
            {recoverable.length === 0 ? <p className="py-8 text-center text-xs text-muted-foreground">暂无可恢复操作</p> : (
              <div className="space-y-2 text-xs">
                {recoverable.map((event: MaintenanceEvent) => (
                  <div key={event.id} className="flex items-center gap-2 rounded-lg border p-2.5">
                    <span className="min-w-0 flex-1 truncate" title={event.title}>{event.title}</span>
                    <button className={secondaryButtonClass} disabled={restoringId === event.id} onClick={() => void restore(event)}><RotateCcw className="mr-1 h-3 w-3" />{restoringId === event.id ? "恢复中" : "恢复"}</button>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground">卸载、更新和文件清理不支持自动回滚。</p>
              </div>
            )}
          </PanelCard>
        </div>
      </div>
    </div>
  );
}
