import { ArrowDown, ArrowUp, ArrowUpDown, Ban, CheckCircle2, Clock3, Loader2, Rocket, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { useBootHistory, useStartupChanges, useStartupItems, type StartupItem } from "./useSystemData";
import { MetricCard, PanelCard, StatusPill } from "./SystemUi";

type StartupSortKey = "name" | "publisher" | "source" | "scope" | "enabled" | "added";
type StartupSort = { key: StartupSortKey; direction: "asc" | "desc" };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function formatDelta(deltaMs: number | null): string {
  if (deltaMs === null) return "—";
  if (deltaMs === 0) return "无变化";
  return deltaMs > 0 ? `慢 ${formatDeltaAbs(deltaMs)}` : `快 ${formatDeltaAbs(-deltaMs)}`;
}

function formatDeltaAbs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function buildSparklinePoints(values: number[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return "300,55";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const width = 590;
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = 10 + i * step;
      const y = 100 - ((v - min) / range) * 80;
      return `${x.toFixed(0)},${y.toFixed(0)}`;
    })
    .join(" ");
}

function scopeLabel(scope: string): string {
  return scope === "user" ? "用户级" : "系统级";
}

function itemSortValue(item: StartupItem, key: StartupSortKey): string | number {
  if (key === "enabled") return Number(item.enabled);
  if (key === "scope") return item.scope;
  if (key === "added") return item.added ?? "";
  return item[key] ?? "";
}

function SortableHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: StartupSortKey;
  sort: StartupSort | null;
  onSort: (column: StartupSortKey) => void;
}) {
  const active = sort?.key === column;
  const direction = active ? sort.direction : null;
  return (
    <th aria-sort={!direction ? "none" : direction === "asc" ? "ascending" : "descending"}>
      <button
        type="button"
        aria-label={`按${label}排序`}
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 py-2 text-left font-medium transition hover:text-foreground"
      >
        {label}
        {!direction ? <ArrowUpDown className="h-3 w-3" /> : direction === "asc" ? <ArrowUp className="h-3 w-3 text-blue-600" /> : <ArrowDown className="h-3 w-3 text-blue-600" />}
      </button>
    </th>
  );
}

export function StartupPanel() {
  const { data, loading, error, toggling, refresh, toggle } = useStartupItems();
  const { data: bootHistory } = useBootHistory();
  const { data: changes } = useStartupChanges();
  const [notice, setNotice] = useState("");
  const [sort, setSort] = useState<StartupSort | null>(null);

  const items = data?.items ?? [];
  const weekAgo = useMemo(() => Date.now() / 1000 - 7 * 24 * 3600, []);
  const recentCount = useMemo(
    () => items.filter((i) => i.firstSeenAt !== null && i.firstSeenAt > weekAgo).length,
    [items, weekAgo],
  );
  const sortedItems = useMemo(() => {
    if (!sort) return items;
    const multiplier = sort.direction === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const aValue = itemSortValue(a, sort.key);
      const bValue = itemSortValue(b, sort.key);
      const result = typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : String(aValue).localeCompare(String(bValue), "zh-CN", { numeric: true, sensitivity: "base" });
      return result * multiplier;
    });
  }, [items, sort]);

  const toggleItem = async (item: StartupItem) => {
    const newEnabled = !item.enabled;
    await toggle(item.id, newEnabled);
    setNotice(`${item.name} ${newEnabled ? "已恢复" : "已禁用，可随时恢复"}`);
  };

  const toggleSort = (key: StartupSortKey) => {
    setSort((current) => current?.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };

  const sparklinePoints = bootHistory ? buildSparklinePoints(bootHistory.points.map((p) => p.durationMs)) : "";
  const sparklineCoords = sparklinePoints ? sparklinePoints.split(" ").map((p) => p.split(",").map(Number)) : [];

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
          {error}
          <button onClick={refresh} className="ml-2 underline">重试</button>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="启动项" value={loading ? "—" : String(data?.total ?? 0)} detail={`已启用 ${data?.enabledCount ?? 0}`} icon={<Rocket className="h-4 w-4" />} />
        <MetricCard label="本周新发现" value={loading ? "—" : String(recentCount)} detail={recentCount > 0 ? "需关注" : "暂无变化"} icon={<Sparkles className="h-4 w-4" />} accent="violet" />
        <MetricCard label="已禁用" value={loading ? "—" : String(data?.disabledCount ?? 0)} detail="可随时恢复" icon={<Ban className="h-4 w-4" />} accent="orange" />
        <MetricCard label="最近启动" value={bootHistory?.lastDurationMs ? formatDuration(bootHistory.lastDurationMs) : "—"} detail={bootHistory?.lastDeltaMs !== null ? formatDelta(bootHistory?.lastDeltaMs ?? null) : "暂无记录"} icon={<Clock3 className="h-4 w-4" />} accent="green" />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <PanelCard title="启动耗时趋势（最近 7 次启动）">
          {bootHistory && bootHistory.points.length > 0 ? (
            <div className="h-28">
              <svg viewBox="0 0 610 110" className="h-full w-full" preserveAspectRatio="none" aria-label="启动耗时趋势图">
                <polyline points={sparklinePoints} fill="none" stroke="#3b82f6" strokeWidth="3" />
                {sparklineCoords.map(([x, y]) => <circle key={x} cx={x} cy={y} r="5" fill="#3b82f6" />)}
              </svg>
            </div>
          ) : (
            <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">暂无启动耗时记录（Windows 会在每次启动时自动记录）</div>
          )}
        </PanelCard>

        <PanelCard title="启动项变化">
          {changes.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-xs text-muted-foreground">暂无变更记录</div>
          ) : (
            <div className="h-28 space-y-2.5 overflow-y-auto pr-1 text-xs">
              {changes.slice(0, 5).map((change) => {
                const isEnable = change.action === "enable";
                return (
                  <div key={`${change.ts}-${change.itemId}`}>
                    <StatusPill tone={isEnable ? "green" : "orange"}>{isEnable ? "已恢复" : "已禁用"}</StatusPill>
                    <p className="mt-0.5 truncate font-medium" title={change.itemName}>{change.itemName}</p>
                    <p className="text-muted-foreground">{new Date(change.ts * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })}</p>
                  </div>
                );
              })}
            </div>
          )}
        </PanelCard>
      </div>

      <PanelCard title="启动应用">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> 正在扫描启动项...</div>
        ) : items.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">未发现启动项</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[210px]" />
                <col className="w-[140px]" />
                <col className="w-[96px]" />
                <col className="w-[68px]" />
                <col className="w-[68px]" />
                <col className="w-[104px]" />
                <col className="w-12" />
              </colgroup>
              <thead className="text-muted-foreground">
                <tr>
                  <SortableHeader label="名称" column="name" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="发布者" column="publisher" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="来源" column="source" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="范围" column="scope" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="状态" column="enabled" sort={sort} onSort={toggleSort} />
                  <SortableHeader label="添加时间" column="added" sort={sort} onSort={toggleSort} />
                  <th className="py-2 text-right font-medium">启动</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr key={item.id} className="border-t border-border/50">
                    <td className="py-2.5 pr-3 font-medium"><div className="flex min-w-0 items-center"><span className="truncate" title={item.name}>{item.name}</span>{item.signed && <CheckCircle2 className="ml-1 h-3 w-3 shrink-0 text-emerald-500" />}</div></td>
                    <td className="pr-3"><div className="truncate" title={item.publisher || undefined}>{item.publisher || "—"}</div></td>
                    <td className="pr-3"><div className="truncate" title={item.source}>{item.source}</div></td>
                    <td><StatusPill tone={item.scope === "user" ? "blue" : "violet"}>{scopeLabel(item.scope)}</StatusPill></td>
                    <td>{item.enabled ? <StatusPill tone="green">已启用</StatusPill> : <StatusPill tone="neutral">已禁用</StatusPill>}</td>
                    <td className="truncate" title={item.added || undefined}>{item.added ?? "—"}</td>
                    <td className="text-right"><button role="switch" aria-checked={item.enabled} aria-label={`切换 ${item.name} 启动状态`} disabled={toggling} onClick={() => toggleItem(item)} className={`relative h-5 w-9 rounded-full transition disabled:opacity-50 ${item.enabled ? "bg-blue-600" : "bg-muted"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${item.enabled ? "left-[18px]" : "left-0.5"}`} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelCard>

      {notice && <p role="status" className="text-xs text-emerald-600">{notice}</p>}
    </div>
  );
}
