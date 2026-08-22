import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  fetchStockOutcomes,
  refreshStockOutcomes,
  type StockOutcomeAggregate,
  type StockOutcomeHorizon,
  type StockOutcomeObservation,
  type StockOutcomesResponse,
} from "@/lib/stock-api";
import { cn } from "@/lib/utils";

const HORIZONS: Array<{ key: StockOutcomeHorizon; label: string }> = [
  { key: "short_term", label: "短线" },
  { key: "medium_term", label: "中线" },
  { key: "long_term", label: "长线" },
];

const WINDOWS = [5, 10, 20, 60, 120, 250] as const;
const TIME_ZONE = "Asia/Shanghai";
const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeZone: TIME_ZONE,
});
const DATETIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: TIME_ZONE,
});

function formatTime(value: string | null | undefined): string {
  if (!value) return "未提供";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间格式无法识别" : DATETIME_FORMATTER.format(date);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "未提供";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期格式无法识别" : DATE_FORMATTER.format(date);
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "暂无数据";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatAccuracy(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "暂无数据";
  return `${(value * 100).toFixed(1)}%`;
}

function statusLabel(value: string | null | undefined): string {
  switch (value) {
    case "complete":
      return "数据完整";
    case "incomplete":
      return "数据不完整";
    case "pending":
      return "等待交易日数据";
    case "available":
      return "数据可用";
    default:
      return value ? "状态待确认" : "未提供";
  }
}

function statusTone(value: string | null | undefined): string {
  if (value === "complete" || value === "available") return "text-success";
  if (value === "incomplete") return "text-warning";
  return "text-muted-foreground";
}

function dataStatusLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    available: "数据可用",
    missing_date: "缺少交易日",
    market_missing_date: "公共基准交易日缺失",
    missing_volume: "缺少成交量",
    market_missing_volume: "公共基准成交量缺失",
    zero_volume: "成交量为零",
    market_zero_volume: "公共基准成交量为零",
    missing_price: "缺少价格",
    market_missing_price: "公共基准价格缺失",
  };
  return value ? labels[value] ?? "数据状态待确认" : "未提供";
}

function conditionSummary(row: StockOutcomeObservation): string {
  if (!row.conditions.length) return "无可回放条件";
  const labels: Record<string, string> = {
    manual: "人工观察（不会自动触发）",
    triggered: "当前已满足条件",
    not_triggered: "当前未满足条件",
    unsupported: "当前无法回放",
  };
  const counts = new Map<string, number>();
  row.conditions.forEach((condition) => {
    const label = labels[condition.status] ?? "条件状态待确认";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  });
  return Array.from(counts, ([label, count]) => `${label} ${count}`).join(" · ");
}

function declaredBenchmarkSummary(row: StockOutcomeObservation): string {
  if (!row.declared_benchmark_id) return "声明基准：未提供可核验代码/暂无结果";
  if (row.declared_benchmark_status !== "available") {
    return "声明基准：已记录，但当前收益不可核验";
  }
  return `声明基准收益：${formatPct(row.declared_benchmark_return_pct)}`;
}

function OutcomeWindowCard({
  row,
  pending,
  window,
}: {
  row: StockOutcomeObservation | undefined;
  pending: StockOutcomeObservation | undefined;
  window: number;
}) {
  return (
    <article className="rounded-md border bg-background px-2.5 py-2" data-testid={`outcome-window-${window}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-medium">第 {window} 个交易日</span>
        <span className={cn("text-micro", statusTone(row?.status ?? (pending ? "pending" : null)))}>
          {statusLabel(row?.status ?? (pending ? "pending" : null))}
        </span>
      </div>
      {row ? (
        <>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-micro tabular-nums">
            <span>绝对收益</span><span className="text-right">{formatPct(row.absolute_return_pct)}</span>
            <span>相对中证全指</span><span className="text-right">{formatPct(row.relative_market_return_pct)}</span>
            <span>最大有利波动（MFE：持有期间的最高有利收益）</span><span className="text-right">{formatPct(row.mfe_pct)}</span>
            <span>最大不利波动（MAE：持有期间的最大不利回撤）</span><span className="text-right">{formatPct(row.mae_pct)}</span>
          </div>
          <div className="mt-1 text-micro text-muted-foreground">
            {row.status === "complete" ? `区间：${formatDate(row.entry_date)} → ${formatDate(row.exit_date)}` : `数据状态：${dataStatusLabel(row.data_status)}`}
          </div>
          <div className="mt-1 text-micro text-muted-foreground">条件回放：{conditionSummary(row)}</div>
          <div className="mt-1 text-micro text-warning">{declaredBenchmarkSummary(row)}</div>
        </>
      ) : pending ? (
        <p className="mt-2 text-micro text-muted-foreground">等待第 {window} 个交易日数据到齐后再计算</p>
      ) : (
        <p className="mt-2 text-micro text-muted-foreground">暂无记录，点击“更新结果”补算</p>
      )}
    </article>
  );
}

function CalibrationSummary({
  aggregate,
}: {
  aggregate: StockOutcomesResponse["aggregate"];
}) {
  return (
    <section className="rounded-md border bg-muted/10 px-2.5 py-2.5" data-testid="outcome-calibration-summary">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-caption font-medium">历史结果校准（所有分周期投研报告）</h4>
        <span className="text-micro text-muted-foreground">完整度基于可复核结果</span>
      </div>
      <div className="mt-2 space-y-2">
        {HORIZONS.map(({ key, label }) => (
          <div key={key}>
            <div className="text-micro font-medium text-muted-foreground">{label}</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2 xl:grid-cols-6">
              {WINDOWS.filter((window) => [5, 10].includes(window) ? key === "short_term" : [20, 60].includes(window) ? key === "medium_term" : key === "long_term").map((window) => {
                const item = aggregate[key]?.[String(window)] as StockOutcomeAggregate | undefined;
                if (!item) return <div key={window} className="rounded border px-2 py-1 text-micro text-muted-foreground">第 {window} 个交易日：暂无样本</div>;
                return (
                  <div key={window} className="rounded border px-2 py-1 text-micro" data-testid={`outcome-aggregate-${key}-${window}`}>
                    <div className="flex justify-between gap-2"><span>第 {window} 个交易日</span><span>{item.complete_count}/{item.total_count} 个结果数据完整</span></div>
                    {item.sample_count < 30 ? (
                      <div className="mt-0.5 text-warning">样本不足（{item.sample_count}/30），不展示方向准确率</div>
                    ) : (
                      <div className="mt-0.5">方向准确率：{formatAccuracy(item.directional_accuracy)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function OutcomeCalibrationPanel({ reportId }: { reportId: string }) {
  const [data, setData] = useState<StockOutcomesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<"read" | "refresh">("read");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorAction("read");
    try {
      setData(await fetchStockOutcomes(reportId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "结果读取失败");
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    if (refreshing || loading) return;
    setRefreshing(true);
    setError(null);
    setErrorAction("refresh");
    try {
      setData(await refreshStockOutcomes(reportId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "结果更新失败");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="outcome-calibration-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-caption font-medium">窗口表现与样本校准</h3>
          <p className="mt-0.5 text-micro text-muted-foreground">只在点击更新时读取行情，页面打开仅读取本地记录。</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading || refreshing} onClick={() => void refresh()}>
          {refreshing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          {refreshing ? "更新中" : "更新结果"}
        </Button>
      </div>

      {loading && <div className="rounded border px-2.5 py-3 text-caption text-muted-foreground">正在读取本地追踪记录…</div>}
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-warning/40 bg-warning/5 px-2.5 py-2 text-caption">
          <span className="text-warning">{errorAction === "refresh" ? "结果更新失败：" : "结果读取失败："}{error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => errorAction === "refresh" ? void refresh() : void load()}>
            {errorAction === "refresh" ? "重试更新" : "重试读取"}
          </Button>
        </div>
      )}

      {!loading && data && (
        <>
          <div className="rounded-md border bg-muted/10 px-2.5 py-2 text-micro">
            <div className="grid gap-1 sm:grid-cols-2">
              <span>历史追踪记录：{data.tracking?.tracking_id ? "已建立" : "尚未建立"}</span>
              <span>报告截至：{formatTime(data.tracking?.report_as_of)}</span>
              <span>行情截至：{formatTime(data.tracking?.market_as_of)}</span>
              <span>公共市场基准：{data.publicMarketBenchmark.name || "未提供"}</span>
            </div>
           <div className="mt-1 text-warning">报告中的比较基准仅按原文核验；无法核验时不以中证全指替代。</div>
          </div>
          <div className="space-y-2">
            {HORIZONS.map(({ key, label }) => {
              const rows = data.observations.filter((row) => row.horizon === key);
              const pendingRows = data.pending.filter((row) => row.horizon === key);
              return (
                <section key={key} className="rounded-md border px-2.5 py-2" data-testid={`outcome-horizon-${key}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-caption font-medium">{label}</h4>
                    <span className="text-micro text-muted-foreground">{key === "short_term" ? "第 5、10 个交易日" : key === "medium_term" ? "第 20、60 个交易日" : "第 120、250 个交易日"}</span>
                  </div>
                  {key !== "short_term" && (
                    <p className="mt-1 text-micro text-warning">催化与基本面里程碑当前未提供结构化回放，需人工观察（不会自动触发）。</p>
                  )}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {WINDOWS.filter((window) => key === "short_term" ? window <= 10 : key === "medium_term" ? window >= 20 && window <= 60 : window >= 120).map((window) => (
                      <OutcomeWindowCard
                        key={window}
                        window={window}
                        row={rows.find((row) => row.window === window)}
                        pending={pendingRows.find((row) => row.window === window)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
          <CalibrationSummary aggregate={data.aggregate} />
        </>
      )}
    </section>
  );
}
