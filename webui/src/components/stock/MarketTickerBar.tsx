import { RefreshCw, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import type { StockQuote } from "@/lib/stock-api";
import { cn } from "@/lib/utils";
import { DECISION_SUMMARY_PANEL_ID } from "./InstrumentStage";

/** 顶栏（design §12 工作台第一区）：模块标题 + 大盘指数行情条，
 *  让自选股涨跌有参照系；右侧给复盘设置入口与自选数量。 */

/** 指数 id 固定（quote API 支持指数 secid；搜索过滤不影响行情查询）。 */
const INDEX_DEFS = [
  { id: "XSHG:000001", label: "上证" },
  { id: "XSHE:399001", label: "深成" },
  { id: "XSHE:399006", label: "创业板" },
] as const;

/** 顶栏指数 id 列表：StockView 将其并入行情轮询。 */
export const INDEX_IDS: string[] = INDEX_DEFS.map((d) => d.id);

function formatPrice(v: number | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(v: number | undefined): string {
  if (v == null) return "";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

interface MarketTickerBarProps {
  quotes: Record<string, StockQuote>;
  watchCount: number;
  activeView: "watch" | "opportunity";
  onViewChange: (view: "watch" | "opportunity") => void;
  /** 行情请求进行中：刷新图标旋转提示。 */
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** 关注雷达面板开关与切换（原面板头部按钮上移到顶栏）。 */
  decisionSummaryOpen: boolean;
  onToggleDecisionSummary: () => void;
}

export function MarketTickerBar({
  quotes,
  watchCount,
  activeView,
  onViewChange,
  refreshing,
  onRefresh,
  onOpenSettings,
  decisionSummaryOpen,
  onToggleDecisionSummary,
}: MarketTickerBarProps) {
  const latestAsOf = INDEX_DEFS.map((def) => quotes[def.id]?.asOf)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return (
    <header className="flex h-12 shrink-0 items-center gap-5 border-b bg-background px-4">
      <h1 className="shrink-0 text-title-sm font-semibold">股票研究</h1>
      <div
        className="flex h-full shrink-0 items-center gap-3"
        role="tablist"
        aria-label="股票研究视图"
      >
        <Button
          type="button"
          role="tab"
          variant="ghost"
          aria-selected={activeView === "watch"}
          onClick={() => onViewChange("watch")}
          className={cn(
            "h-full rounded-none border-b-2 border-transparent px-1.5 text-caption hover:bg-transparent",
            activeView === "watch"
              ? "border-info text-foreground"
              : "text-muted-foreground",
          )}
        >
          自选观察
        </Button>
        <Button
          type="button"
          role="tab"
          variant="ghost"
          aria-selected={activeView === "opportunity"}
          onClick={() => onViewChange("opportunity")}
          className={cn(
            "h-full rounded-none border-b-2 border-transparent px-1.5 text-caption hover:bg-transparent",
            activeView === "opportunity"
              ? "border-info text-foreground"
              : "text-muted-foreground",
          )}
        >
          机会发现
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-7 overflow-hidden">
        {INDEX_DEFS.map((def) => {
          const quote = quotes[def.id];
          const pct = quote?.changePct;
          return (
            <div
              key={def.id}
              className="flex shrink-0 items-center gap-1.5"
              data-testid={`index-${def.id}`}
            >
              <span className="text-ui text-muted-foreground">
                {def.label}
              </span>
              <span className="text-ui font-medium tabular-nums">
                {formatPrice(quote?.price)}
              </span>
              {pct != null && (
                <span
                  className={cn(
                    "text-ui font-medium tabular-nums",
                    pct >= 0 ? "text-stock-up" : "text-stock-down",
                  )}
                >
                  {formatPct(pct)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className="hidden items-center gap-1.5 text-caption text-muted-foreground lg:flex">
          {latestAsOf
            ? `数据更新 ${latestAsOf.slice(11, 19)}`
            : "等待行情"}
        </span>
        <span className="hidden text-caption text-muted-foreground xl:inline">自选 {watchCount} 只</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新行情"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
            aria-hidden
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="复盘设置"
          onClick={onOpenSettings}
          className="h-7 w-7"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={decisionSummaryOpen ? "收起关注雷达" : "展开关注雷达"}
          title={decisionSummaryOpen ? "收起关注雷达" : "展开关注雷达"}
          aria-expanded={decisionSummaryOpen}
          aria-controls={DECISION_SUMMARY_PANEL_ID}
          onClick={onToggleDecisionSummary}
          className="h-7 w-7"
        >
          <RightSidebarToggleIcon open={decisionSummaryOpen} className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
    </header>
  );
}
