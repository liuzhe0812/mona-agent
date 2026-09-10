import { useCallback, useEffect, useState } from "react";
import { BarChart3, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getGatewayHttpBase } from "@/lib/api";
import { getCreditUsage, httpFetch, type ManagedCreditUsage } from "@/lib/tauri";
import { formatBalanceAmount } from "@/lib/money";

interface UsageDailyPoint {
  date: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

interface UsageModelItem {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  request_count: number;
}

interface UsageRecentItem {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface UsageResponse {
  period_days: number;
  today_tokens: number;
  period_tokens: number;
  request_count: number;
  model_count: number;
  provider_count: number;
  daily: UsageDailyPoint[];
  by_model: UsageModelItem[];
  recent: UsageRecentItem[];
  updated_at: string;
}

export function formatTokens(value: number): string {
  const absolute = Math.abs(value);
  const formatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
  if (absolute >= 100_000_000) return `${formatter.format(value / 100_000_000)}亿`;
  if (absolute >= 10_000) return `${formatter.format(value / 10_000)}万`;
  return formatter.format(value);
}

function formatDate(value: string, withTime = false): string {
  const localDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!withTime && localDay) {
    return `${Number(localDay[2])}月${Number(localDay[3])}日`;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { month: "numeric", day: "numeric" }
  ).format(timestamp);
}

function parseLocalDay(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatLocalDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDay(value: Date, amount: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

type ActivityDay = UsageDailyPoint & { placeholder?: boolean };

function buildActivityDays(daily: UsageDailyPoint[]): ActivityDay[] {
  const byDate = new Map(daily.map((item) => [item.date, item]));
  const end = parseLocalDay(daily.at(-1)?.date ?? formatLocalDay(new Date()));
  const start = shiftDay(end, -(19 * 7 + end.getDay()));
  return Array.from({ length: 20 * 7 }, (_, index) => {
    const date = formatLocalDay(shiftDay(start, index));
      return byDate.get(date) ?? {
        date,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
        total_tokens: 0,
        placeholder: date > formatLocalDay(end),
      };
  });
}

function activityLevel(value: number, max: number): number {
  if (value <= 0) return 0;
  const ratio = value / max;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.8) return 3;
  return 4;
}

function tokenTicks(max: number): number[] {
  if (!(max > 0)) return [];
  const rawStep = max / 4;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((value) => value >= rawStep) ?? 10 * power;
  const ticks: number[] = [];
  for (let value = step; value <= max * 0.95 && ticks.length < 3; value += step) ticks.push(value);
  return ticks;
}

function formatAxisDate(value: string): string {
  const localDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return localDay ? String(Number(localDay[3])) : value;
}

const ACTIVITY_CELL_CLASSES = [
  "bg-muted/65",
  "bg-foreground/15",
  "bg-foreground/30",
  "bg-foreground/50",
  "bg-foreground/75",
];

export function UsageSettings() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [managedUsage, setManagedUsage] = useState<ManagedCreditUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (background = false) => {
    background ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const base = await getGatewayHttpBase();
      if (!base) throw new Error("本机用量服务未启动");
      const timezoneOffset = -new Date().getTimezoneOffset();
      const [response, managed] = await Promise.all([
        httpFetch(`${base}/api/usage?tz_offset_minutes=${timezoneOffset}`),
        getCreditUsage(timezoneOffset).catch(() => null),
      ]);
      if (!response.ok) throw new Error("本机用量服务暂不可用");
      setUsage(await response.json() as UsageResponse);
      setManagedUsage(managed);
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center" aria-label="正在加载用量统计">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-title-lg">用量统计</h1>
          <p className="mt-1 text-body text-muted-foreground">查看本机近 30 天所有模型调用的 Token。余额与费用以余额与充值页面为准。</p>
        </header>
        <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-5 text-body text-destructive">
          {error || "用量服务暂不可用"}
        </div>
      </div>
    );
  }

  const maxDailyTokens = Math.max(...usage.daily.map((item) => item.total_tokens), 1);
  const maxModelTokens = Math.max(...usage.by_model.map((item) => item.total_tokens), 1);
  const activityDays = buildActivityDays(usage.daily);
  const maxActivityTokens = Math.max(...activityDays.map((item) => item.total_tokens), 1);
  const mediaRecent = managedUsage?.recent.filter((item) => item.billing_type !== "token") ?? [];
  const generatedImages = mediaRecent.reduce((total, item) => total + Number(item.usage?.output_image_count ?? 0), 0);
  const generatedVideoSeconds = mediaRecent.reduce((total, item) => total + Number(item.usage?.duration ?? 0), 0);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-title-lg">用量统计</h1>
          <p className="mt-1 text-body text-muted-foreground">本机统计所有模型调用，包含我的 API Key 和 Mona AI。</p>
        </div>
        <Button variant="outline" className="rounded-full" disabled={refreshing} onClick={() => void load(true)}>
          {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          刷新
        </Button>
      </header>

      <section aria-labelledby="usage-overview-title" className="rounded-xl border border-border/70 bg-card p-3.5">
        <h2 id="usage-overview-title" className="text-caption font-medium text-muted-foreground">概览</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [formatTokens(usage.today_tokens), "今日 Token"],
            [formatTokens(usage.period_tokens), "近 30 天 Token"],
            [String(usage.request_count), "模型调用"],
            [String(usage.model_count), "用到的模型"],
            [String(usage.provider_count), "模型供应商"],
            ...(managedUsage ? [
              [`¥${formatBalanceAmount(managedUsage.period_spent_amount)}`, "Mona AI 近30天消费"],
              [String(generatedImages), "生成图片"],
              [`${generatedVideoSeconds}秒`, "生成视频"],
            ] : []),
          ].map(([value, label]) => (
            <div key={label} className="rounded-lg bg-muted/55 px-3 py-2.5">
              <p className="whitespace-nowrap text-[16px] font-semibold tabular-nums">{value}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {mediaRecent.length > 0 ? (
        <section aria-labelledby="media-usage-title" className="overflow-hidden rounded-xl border border-border/70 bg-card">
          <div className="p-3.5">
            <h2 id="media-usage-title" className="text-heading">图片与视频用量</h2>
            <p className="mt-1 text-caption text-muted-foreground">按百炼最终返回的实际张数、秒数和分辨率结算。</p>
          </div>
          <div className="overflow-x-auto border-t border-border/60">
            <table className="w-full min-w-[620px] text-left text-caption">
              <thead className="bg-muted/30 text-muted-foreground">
                <tr><th className="px-3.5 py-2.5 font-medium">时间</th><th className="px-3 py-2.5 font-medium">模型</th><th className="px-3 py-2.5 font-medium">类型</th><th className="px-3 py-2.5 font-medium">实际用量</th><th className="px-3 py-2.5 text-right font-medium">金额</th><th className="px-3 py-2.5 font-medium">状态</th></tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {mediaRecent.map((item) => {
                  const rawResolution = String(item.usage?.SR ?? item.usage?.sr ?? "-");
                  const resolution = rawResolution === "-" || rawResolution.toUpperCase().endsWith("P") ? rawResolution : `${rawResolution}P`;
                  const quantity = item.billing_type === "image"
                    ? `${Number(item.usage?.output_image_count ?? 0)} 张 · ${String(item.usage?.output_image_type ?? "-")}`
                    : `${Number(item.usage?.duration ?? 0)} 秒 · ${resolution}`;
                  return <tr key={item.request_id}>
                    <td className="px-3.5 py-2.5 text-muted-foreground">{formatDate(item.created_at, true)}</td>
                    <td className="px-3 py-2.5 font-medium">{item.model}</td>
                    <td className="px-3 py-2.5">{item.billing_type === "image" ? "图片" : "视频"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{quantity}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{item.spent_amount ? `¥${formatBalanceAmount(item.spent_amount)}` : `预留 ¥${formatBalanceAmount(item.reserved_amount)}`}</td>
                    <td className="px-3 py-2.5">{item.status}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="usage-trends-title" className="rounded-xl border border-border/70 bg-card p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h2 id="usage-trends-title" className="text-caption font-medium text-muted-foreground">用量趋势</h2>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>少</span>
            {ACTIVITY_CELL_CLASSES.map((className) => <i key={className} className={`h-3 w-3 rounded-[3px] ${className}`} />)}
            <span>多</span>
          </div>
        </div>
        <TooltipProvider delayDuration={200} skipDelayDuration={100}>
        <div className="mt-3.5 flex flex-wrap items-start gap-5">
          <div className="min-w-[300px] shrink-0">
            <div className="mb-1.5 text-[11px] text-muted-foreground">活跃热力图 <span className="ml-1 font-normal text-muted-foreground/70">近 20 周</span></div>
            <div className="overflow-x-auto pb-1">
              <div className="flex w-fit flex-col gap-1.5">
                <div className="relative h-[14px]" style={{ width: 20 * 15 - 3 }}>
                  {Array.from({ length: 20 }, (_, column) => {
                    const item = activityDays[column * 7];
                    const previous = column > 0 ? activityDays[(column - 1) * 7] : null;
                    const showMonth = column === 0 || item.date.slice(0, 7) !== previous?.date.slice(0, 7);
                    return showMonth ? <span key={column} className="absolute top-0 text-[10px] text-muted-foreground" style={{ left: column * 15 }}>{`${Number(item.date.slice(5, 7))}月`}</span> : null;
                  })}
                </div>
                <div className="flex gap-[3px]" role="img" aria-label="近 20 周活跃热力图">
                  {Array.from({ length: 20 }, (_, column) => (
                    <div key={column} className="flex flex-col gap-[3px]">
                      {activityDays.slice(column * 7, column * 7 + 7).map((item) => (
                        item.placeholder ? (
                          <span key={item.date} className="block h-3 w-3 rounded-[3px] bg-transparent" />
                        ) : (
                          <Tooltip key={item.date}>
                            <TooltipTrigger asChild>
                              <span
                                className={`relative z-10 block h-3 w-3 rounded-[3px] ${ACTIVITY_CELL_CLASSES[activityLevel(item.total_tokens, maxActivityTokens)]}`}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={6}>
                              {formatDate(item.date)} · {item.total_tokens > 0 ? `${formatTokens(item.total_tokens)} Token` : "无活动"}
                            </TooltipContent>
                          </Tooltip>
                        )
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="min-w-[300px] flex-1 self-stretch border-l border-border/60 pl-5">
            <div className="mb-1.5 text-[11px] text-muted-foreground">近 30 天每日 Token</div>
            <div role="img" aria-label="近 30 天 Token 柱状图">
              <div className="relative flex h-24 items-end gap-[3px] border-b border-border/60 pl-8">
                {tokenTicks(maxDailyTokens).map((tick) => (
                  <div key={tick} className="absolute left-8 right-0 border-t border-border/50" style={{ bottom: `${(tick / maxDailyTokens) * 100}%` }}>
                    <span className="absolute -left-8 -top-1.5 w-7 whitespace-nowrap text-right text-[9px] tabular-nums text-muted-foreground">{formatTokens(tick)}</span>
                  </div>
                ))}
            {usage.daily.map((item) => {
              const height = item.total_tokens === 0 ? 2 : Math.max(6, (item.total_tokens / maxDailyTokens) * 100);
              const inputShare = item.total_tokens === 0 ? 0 : (item.prompt_tokens / item.total_tokens) * 100;
              return (
                <Tooltip key={item.date}>
                  <TooltipTrigger asChild>
                    <div className="group relative flex h-full min-w-0 flex-1 items-end">
                      <div
                        className="relative w-full overflow-hidden rounded-sm bg-muted transition-opacity hover:opacity-75"
                        style={{ height: `${height}%` }}
                      >
                        {item.total_tokens > 0 ? (
                          <>
                            <div className="absolute inset-x-0 bottom-0 bg-foreground/80" style={{ height: `${inputShare}%` }} />
                            <div className="absolute inset-x-0 top-0 bg-foreground/35" style={{ height: `${100 - inputShare}%` }} />
                          </>
                        ) : null}
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    {formatDate(item.date)} · {formatTokens(item.total_tokens)} Token
                  </TooltipContent>
                </Tooltip>
              );
            })}
              </div>
              <div className="mt-1.5 grid grid-cols-[30px_repeat(30,minmax(0,1fr))] gap-[3px] text-[9px] text-muted-foreground">
                <span />
                {usage.daily.map((item, index) => {
                  const showLabel = index === 0 || index === usage.daily.length - 1 || index % 5 === 0;
                  return <span key={item.date} className="min-w-0 truncate text-center">{showLabel ? formatAxisDate(item.date) : ""}</span>;
                })}
              </div>
            </div>
          </div>
        </div>
        </TooltipProvider>
      </section>

      <section aria-labelledby="model-usage-title" className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="p-3.5">
          <h2 id="model-usage-title" className="text-heading">按模型</h2>
          <p className="mt-1 text-caption text-muted-foreground">近 30 天本机记录的 Token 用量。</p>
        </div>
        {usage.by_model.length === 0 ? (
          <div className="border-t border-border/60 px-3.5 py-6 text-center">
            <BarChart3 className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-caption text-muted-foreground">近 30 天暂无模型用量</p>
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border/60">
            <table className="w-full min-w-[700px] text-left text-caption">
              <thead className="bg-muted/30 text-caption text-muted-foreground">
                <tr>
                  <th className="px-3.5 py-2.5 font-medium">供应商</th>
                  <th className="px-3 py-2.5 font-medium">模型</th>
                  <th className="px-3 py-2.5 font-medium">占比</th>
                  <th className="px-3 py-2.5 text-right font-medium">总 Token</th>
                  <th className="px-3 py-2.5 text-right font-medium">输入</th>
                  <th className="px-3 py-2.5 text-right font-medium">输出</th>
                  <th className="px-3 py-2.5 text-right font-medium">缓存读取</th>
                  <th className="px-3 py-2.5 text-right font-medium">调用</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {usage.by_model.map((item) => (
                  <tr key={`${item.provider}:${item.model}`}>
                    <td className="px-3.5 py-2.5 text-muted-foreground">{item.provider}</td>
                    <td className="px-3 py-2.5 font-medium">{item.model}</td>
                    <td className="w-36 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-foreground/75" style={{ width: `${Math.max(2, (item.total_tokens / maxModelTokens) * 100)}%` }} />
                        </div>
                        <span className="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{Math.round((item.total_tokens / Math.max(usage.period_tokens, 1)) * 100)}%</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatTokens(item.total_tokens)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatTokens(item.prompt_tokens)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatTokens(item.completion_tokens)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted-foreground">{formatTokens(item.cached_tokens)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{item.request_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-right text-micro text-muted-foreground">数据更新于 {formatDate(usage.updated_at, true)}</p>
      {error ? <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-body text-destructive">{error}</div> : null}
    </div>
  );
}
