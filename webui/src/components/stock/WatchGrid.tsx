import { useState } from "react";
import { Plus, Search, Star, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  StockDashboardItem,
  StockQuote,
  StockSearchResult,
  StockWatchlistAddInput,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";
import { LeftSidebarToggleIcon } from "@/components/notes/LeftSidebarToggleIcon";
import { Sparkline } from "./Sparkline";
import { stanceLabel } from "./labels";

/** 自选观察列表：首屏用于扫描价格、量能、技术趋势和最近研究动态。 */

export interface StockWatchSignal {
  closes: number[];
  trendLabel: string;
  volumeLabel: string;
}

interface WatchGridProps {
  items: StockDashboardItem[];
  quotes: Record<string, StockQuote>;
  /** 由同一次 30 日 K 线请求计算的列表信号，不额外增加网络调用。 */
  signals: Record<string, StockWatchSignal>;
  selectedId: string | null;
  onSelect: (instrumentId: string) => void;
  onToggleFocus: (instrumentId: string, focus: boolean) => void;
  onRemove: (instrumentId: string) => void;
  onAdd: (input: StockWatchlistAddInput) => void;
  /** 拖动排序：回传完整有序 id 列表（由调用方持久化）。 */
  onReorder: (instrumentIds: string[]) => void;
  onSearch: (keyword: string) => Promise<StockSearchResult[]>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function formatPrice(v: number | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function horizonBrief(latest: StockDashboardItem["latest"]): string | null {
  if (!latest || latest.schemaVersion !== 4 || !latest.horizonStances) return null;
  const { shortTerm, mediumTerm, longTerm } = latest.horizonStances;
  return `短${stanceLabel(shortTerm.stance)} · 中${stanceLabel(mediumTerm.stance)} · 长${stanceLabel(longTerm.stance)}`;
}

export function WatchGrid({
  items,
  quotes,
  signals,
  selectedId,
  onSelect,
  onToggleFocus,
  onRemove,
  onAdd,
  onReorder,
  onSearch,
  collapsed,
  onToggleCollapsed,
}: WatchGridProps) {
  const [addOpen, setAddOpen] = useState(false);
  const focusCount = items.filter((item) => item.focus).length;

  // --- 拖动排序（原生 DnD，无额外依赖） ---
  // dragId = 被拖行；dropTarget = 悬停行 + 前/后插入位（指示线位置）。
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(
    null,
  );
  const clearDrag = () => {
    setDragId(null);
    setDropTarget(null);
  };
  const handleDrop = () => {
    if (dragId && dropTarget && dragId !== dropTarget.id) {
      const ids = items.map((i) => i.instrumentId);
      ids.splice(ids.indexOf(dragId), 1);
      const insertAt = ids.indexOf(dropTarget.id) + (dropTarget.before ? 0 : 1);
      ids.splice(insertAt, 0, dragId);
      onReorder(ids);
    }
    clearDrag();
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r bg-background">
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b", collapsed ? "justify-center px-1" : "px-3.5")}>
        {!collapsed && (
          <>
            <h2 className="text-title-sm">自选观察</h2>
            <span className="text-caption text-muted-foreground">{items.length}</span>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={collapsed ? "展开自选观察" : "收起自选观察"}
          title={collapsed ? "展开自选观察" : "收起自选观察"}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
          className="h-7 w-7 shrink-0"
        >
          <LeftSidebarToggleIcon open={!collapsed} className="h-3.5 w-3.5" />
        </Button>
      </div>
      {!collapsed && (
        <div className="grid h-9 shrink-0 grid-cols-[minmax(68px,1fr)_48px_64px_40px_60px_64px_56px] items-center gap-x-1 border-b px-2 text-caption text-muted-foreground">
          <span>名称/代码</span>
          <span className="text-right">现价</span>
          <span className="text-right">涨跌幅</span>
          <span className="text-center">量能</span>
          <span className="text-center">30日趋势</span>
          <span className="text-center">最新事件</span>
          <span className="text-right">观点</span>
        </div>
      )}
      <div
        className="scrollbar-hover min-h-0 flex-1 overflow-y-auto"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        {items.map((item) => (
          <WatchRow
            key={item.instrumentId}
            item={item}
            quote={quotes[item.instrumentId]}
            signal={signals[item.instrumentId]}
            selected={item.instrumentId === selectedId}
            dragging={item.instrumentId === dragId}
            dropEdge={
              dropTarget?.id === item.instrumentId
                ? dropTarget.before
                  ? "before"
                  : "after"
                : null
            }
            onSelect={() => onSelect(item.instrumentId)}
            onToggleFocus={() =>
              onToggleFocus(item.instrumentId, !item.focus)
            }
            onRemove={() => onRemove(item.instrumentId)}
            onDragStart={(e) => {
              setDragId(item.instrumentId);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", item.instrumentId);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (item.instrumentId === dragId) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const before = e.clientY < rect.top + rect.height / 2;
              setDropTarget((prev) =>
                prev?.id === item.instrumentId && prev.before === before
                  ? prev
                  : { id: item.instrumentId, before },
              );
            }}
            onDrop={handleDrop}
            onDragEnd={clearDrag}
            collapsed={collapsed}
          />
        ))}
        {items.length === 0 && (
          <div className="flex h-36 flex-col items-center justify-center gap-2 text-caption text-muted-foreground">
            暂无自选标的
            <Button variant="outline" size="xs" onClick={() => setAddOpen(true)}>
              添加标的
            </Button>
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="flex h-10 shrink-0 items-center justify-between border-t px-3 text-caption text-muted-foreground">
          <span>共 {items.length} 只股票</span>
          <Button variant="ghost" size="xs" className="gap-1" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3" />添加自选股
          </Button>
          <span>重点 {focusCount} 只</span>
        </div>
      )}
      <AddInstrumentDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSearch={onSearch}
        onPick={(input) => {
          onAdd(input);
          setAddOpen(false);
        }}
      />
    </section>
  );
}

function WatchRow({
  item,
  quote,
  signal,
  selected,
  dragging,
  dropEdge,
  onSelect,
  onToggleFocus,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  collapsed,
}: {
  item: StockDashboardItem;
  quote: StockQuote | undefined;
  signal: StockWatchSignal | undefined;
  selected: boolean;
  dragging: boolean;
  /** 拖动悬停时的插入指示：目标行上方/下方一条线；null 不显示。 */
  dropEdge: "before" | "after" | null;
  onSelect: () => void;
  onToggleFocus: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  collapsed: boolean;
}) {
  const pct = quote?.changePct;
  const trend = pct == null ? "flat" : pct >= 0 ? "up" : "down";
  const latestDate = item.latest?.asOf?.slice(5, 10) ?? null;
  const latestHorizonBrief = horizonBrief(item.latest);
  const latestActivity = item.latest
    ? `${item.latest.kind === "daily_review" ? "复盘" : "报告"}${latestDate ? `·${latestDate}` : ""}`
    : "无新事件";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={collapsed ? item.name : undefined}
      title={collapsed ? item.name : undefined}
      data-selected={selected ? "true" : "false"}
      data-instrument-id={item.instrumentId}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group relative h-14 cursor-pointer border-b text-left text-caption transition-colors duration-instant",
        collapsed
          ? "flex items-center justify-center px-1"
          : "grid grid-cols-[minmax(68px,1fr)_48px_64px_40px_60px_64px_56px] items-center gap-x-1 px-2",
        selected ? "bg-info-strong/[0.09]" : "hover:bg-accent/55",
        dragging && "opacity-40",
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-info-strong" aria-hidden />}
      {dropEdge && (
        <span
          className={cn(
            "absolute left-0 right-0 z-10 h-0.5 bg-info-strong",
            dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
          aria-hidden
        />
      )}
      {collapsed ? (
        <span className="truncate text-ui font-medium">{item.name.slice(0, 1)}</span>
      ) : (
        <>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-ui font-medium">{item.name}</span>
              {item.focus && <Star className="h-3 w-3 shrink-0 fill-current text-warning" aria-label="重点" />}
            </div>
            <div className="mt-0.5 truncate text-caption text-muted-foreground">{item.instrumentId.split(":")[1]}</div>
          </div>
          <div className="min-w-0 text-right tabular-nums">
            <div className="truncate tabular-nums">{formatPrice(quote?.price)}</div>
          </div>
          <div className={cn("min-w-0 whitespace-nowrap text-right tabular-nums", pct == null ? "text-muted-foreground" : pct >= 0 ? "text-stock-up" : "text-stock-down")}>
            {pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
          </div>
          <div className="truncate text-center text-muted-foreground">
            {signal?.volumeLabel?.replace("成交", "") ?? "待更新"}
          </div>
          <div className="min-w-0">
            <Sparkline
              closes={signal?.closes ?? []}
              className={cn(
                "mx-auto h-6 w-14",
                trend === "up" && "text-stock-up",
                trend === "down" && "text-stock-down",
                trend === "flat" && "text-muted-foreground",
              )}
            />
          </div>
          <div className="truncate text-center text-muted-foreground" title={latestActivity}>{latestActivity}</div>
          <div className={cn("whitespace-nowrap text-right", latestHorizonBrief || item.latest?.stance ? "text-info" : "text-muted-foreground")}>
            {latestHorizonBrief ?? (item.latest?.stance ? stanceLabel(item.latest.stance) : "待更新")}
          </div>
        </>
      )}
      {!collapsed && <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-background/90 p-0.5 shadow-surface group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          size="icon"
          aria-label={item.focus ? "取消重点" : "标为重点"}
          aria-pressed={item.focus}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFocus();
          }}
          className={cn("h-5 w-5", item.focus ? "text-warning" : "text-muted-foreground")}
        >
          <Star className={cn("h-3 w-3", item.focus && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="移除自选"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="h-5 w-5 text-muted-foreground"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>}
    </div>
  );
}

function AddInstrumentDialog({
  open,
  onOpenChange,
  onSearch,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSearch: (keyword: string) => Promise<StockSearchResult[]>;
  onPick: (input: StockWatchlistAddInput) => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const runSearch = (kw: string) => {
    setKeyword(kw);
    const q = kw.trim();
    if (!q) {
      setResults([]);
      return;
    }
    setSearching(true);
    void onSearch(q)
      .then(setResults)
      .catch(() => setResults([]))
      .finally(() => setSearching(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加标的</DialogTitle>
          <DialogDescription>
            输入股票名称或代码，从搜索结果加入自选观察。
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={keyword}
            onChange={(e) => runSearch(e.target.value)}
            placeholder="搜索代码或名称"
            className="h-9 pl-9 text-ui"
          />
        </div>
        <div className="scrollbar-thin max-h-72 overflow-y-auto">
          {searching && results.length === 0 ? (
            <p className="py-6 text-center text-caption text-muted-foreground">
              搜索中…
            </p>
          ) : results.length === 0 && keyword.trim() ? (
            <p className="py-6 text-center text-caption text-muted-foreground">
              未找到匹配的 A 股股票或交易型开放式指数基金
            </p>
          ) : (
            results.map((r) => (
              <Button
                key={r.instrumentId}
                type="button"
                variant="ghost"
                onClick={() =>
                  onPick({
                    symbol: r.symbol,
                    exchange: r.exchange,
                    name: r.name,
                    instrumentType: r.instrumentType,
                  })
                }
                className="h-9 w-full justify-between rounded-md px-2.5 text-left text-ui font-normal hover:bg-accent"
              >
                <span className="truncate">{r.name}</span>
                <span className="text-micro text-muted-foreground">
                  {r.instrumentId}
                  {r.instrumentType === "etf" ? " · 交易型开放式指数基金（ETF）" : ""}
                </span>
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
