import type { MetricComparison, ProfileCharts, RichProfile } from "@/lib/profile-api";
import { PROFILE_COLORS } from "./profile-theme";

interface TrajectoryTabProps { data?: RichProfile; loading: boolean }

const METRICS = [
  { key: "active_conversations", label: "对话" },
  { key: "generated_artifacts", label: "生成成果" },
  { key: "active_dates", label: "活跃日期" },
  { key: "user_messages", label: "真实消息" },
] as const;

export function TrajectoryTab({ data, loading }: TrajectoryTabProps) {
  if (loading) return <div className="flex h-full items-center justify-center text-body text-muted-foreground">加载中…</div>;
  const dashboard = data?.dashboard;
  const charts = dashboard?.profile_charts;
  const metrics = dashboard?.metrics ?? {};
  const topics = normalizeTopicComparison(charts?.topic_comparison ?? dashboard?.topic_records);
  const trends = normalizeTopicTrends(charts?.topic_trends);
  const newTopics = normalizeNewTopics(charts?.new_topics);
  const daily = dashboard?.daily_activity ?? [];
  const currentDimensions = normalizeDimensions(charts?.profile_dimensions);
  const previousDimensions = normalizeDimensions(charts?.previous_profile_dimensions);
  const activeDayCount = daily.filter((item) => item.user_messages > 0).length;
  const hasComparison = METRICS.some(({ key }) => metrics[key]?.comparison_available);
  return <div className="flex h-full min-h-0 w-full flex-col text-foreground">
    <div className="grid grid-cols-2 border-b border-border/70 py-3 sm:grid-cols-4">
      {METRICS.map(({ key, label }) => <MetricRibbon key={key} label={label} metric={metrics[key]} />)}
    </div>
    {!hasComparison ? <p className="border-b border-border/70 py-2 text-center text-caption text-muted-foreground">尚无可比较的记录</p> : null}
    <div className="grid min-h-0 flex-[1.1] grid-cols-1 border-b border-border/70 py-4 lg:grid-cols-[1.6fr_0.9fr]">
      <section className="flex min-h-0 flex-col overflow-hidden border-b border-border/70 pb-4 lg:border-b-0 lg:border-r lg:border-border/70 lg:pr-6"><SectionTitle title="话题变化趋势" subtitle="记录数" />{trends.length ? <TrendPlot trends={trends} labels={charts?.topic_trends?.labels ?? []} /> : <ChartEmpty text="暂无话题趋势记录" />}</section>
      <section className="flex min-h-0 flex-col pt-5 lg:pl-6 lg:pt-0"><SectionTitle title="本期与上期" />{topics.length ? <ComparisonBars topics={topics} /> : <ChartEmpty text="暂无可比较的主题" />}</section>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 border-b border-border/70 py-4 lg:grid-cols-[0.95fr_1.2fr_0.85fr]">
      <section className="flex min-h-0 flex-col overflow-hidden border-b border-border/70 pb-4 lg:border-b-0 lg:border-r lg:border-border/70 lg:pr-6"><SectionTitle title="关注结构对比" subtitle="话题记录数" />{currentDimensions.length ? <MiniRadar current={currentDimensions} previous={previousDimensions} /> : <ChartEmpty text="暂无关注结构" />}</section>
      <section className="flex min-h-0 flex-col border-b border-border/70 py-5 lg:border-b-0 lg:border-r lg:border-border/70 lg:px-6 lg:py-0"><SectionTitle title="活动日历" subtitle={`${activeDayCount} 个活跃日期`} /><div className="flex flex-1 items-center justify-center">{dashboard?.window_start && dashboard.window_end ? <ActivityCalendar daily={daily} start={dashboard.window_start} end={dashboard.window_end} /> : <ChartEmpty text="暂无活动日期" />}</div></section>
      <section className="flex min-h-0 flex-col pt-5 lg:pl-6 lg:pt-0"><SectionTitle title="本期新接触" />{newTopics.length ? <div className="space-y-3 pt-2">{newTopics.slice(0, 3).map((item) => <div key={item.topic} className="flex items-center justify-between border-b border-border/60 pb-3 text-caption"><span>{item.topic}</span><span className="text-micro text-muted-foreground">{item.first_seen_at ? item.first_seen_at.slice(5, 10) : "日期未知"} · {item.count ?? "—"} 条</span></div>)}</div> : <ChartEmpty text="暂无新接触主题" />}</section>
    </div>
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 py-2 text-micro text-muted-foreground"><span>{dashboard?.window_start && dashboard.window_end ? `${dashboard.window_start.slice(0, 10)} 至 ${dashboard.window_end.slice(0, 10)}` : "近 30 天"}</span><span>数据覆盖：{dashboard?.coverage?.map((item) => `${coverageLabel(item.source)} ${coverageStatus(item.status)}`).join(" · ") || "暂无"}</span><span>真实记录 · 近 30 天</span></div>
  </div>;
}

function MetricRibbon({ label, metric }: { label: string; metric?: MetricComparison }) {
  const delta = metric?.delta;
  const comparable = metric?.comparison_available === true && typeof delta === "number";
  return <div className="flex items-baseline justify-center gap-2 border-r border-border/70 px-2 last:border-r-0"><span className="text-caption text-muted-foreground">{label}</span><strong className="text-title-sm font-medium leading-none tabular-nums">{metric?.current.value ?? "暂无"}</strong><span className="text-micro text-muted-foreground">{comparable ? `${delta! >= 0 ? "+" : ""}${delta}` : "—"}</span></div>;
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) { return <div className="mb-2 flex items-baseline gap-2"><h3 className="text-body font-semibold">{title}</h3>{subtitle ? <span className="text-micro text-muted-foreground">{subtitle}</span> : null}</div>; }
function ChartEmpty({ text }: { text: string }) { return <div className="flex min-h-0 flex-1 items-center justify-center text-caption text-muted-foreground">{text}</div>; }

function TrendPlot({ trends, labels }: { trends: Array<{ topic: string; points: number[] }>; labels: string[] }) {
  const width = 700; const height = 220; const max = Math.max(...trends.flatMap((item) => item.points), 1); const colors = [PROFILE_COLORS.emerald, PROFILE_COLORS.cyan, PROFILE_COLORS.amber];
  return <div className="flex min-h-0 flex-1 flex-col"><svg viewBox={`0 0 ${width} ${height}`} className="min-h-[210px] flex-1 w-full" aria-label="话题变化趋势"><line x1="42" y1="175" x2="680" y2="175" className="stroke-border" /><line x1="42" y1="24" x2="42" y2="175" className="stroke-border" />{trends.slice(0, 3).map((trend, trendIndex) => { const step = trend.points.length > 1 ? 638 / (trend.points.length - 1) : 638; const path = trend.points.map((point, index) => `${index === 0 ? "M" : "L"}${42 + step * index},${175 - (point / max) * 135}`).join(" "); return <g key={trend.topic}><path d={path} fill="none" stroke={colors[trendIndex % colors.length]} strokeWidth="2" />{trend.points.map((point, index) => <circle key={`${trend.topic}-${index}`} cx={42 + step * index} cy={175 - (point / max) * 135} r="2.5" fill={colors[trendIndex % colors.length]} />)}</g>; })}{labels.slice(0, 6).map((label, index) => <text key={`${label}-${index}`} x={42 + (labels.length > 1 ? (638 / (labels.length - 1)) * index : 319)} y="205" textAnchor="middle" className="fill-muted-foreground text-micro">{label}</text>)}</svg><div className="flex flex-wrap gap-4 text-micro text-muted-foreground">{trends.slice(0, 3).map((trend, index) => <span key={trend.topic} className="flex items-center gap-1"><i className="h-2 w-2 rounded-full" style={{ background: colors[index % colors.length] }} />{trend.topic}</span>)}</div></div>;
}

function ComparisonBars({ topics }: { topics: Array<{ topic: string; count: number; previous_count?: number; delta?: number }> }) { const max = Math.max(...topics.map((item) => Math.max(item.count, item.previous_count ?? 0)), 1); return <div className="space-y-4 py-2">{topics.slice(0, 4).map((item) => <div key={item.topic}><div className="mb-1.5 flex justify-between gap-2 text-caption"><span>{item.topic}</span><span className="text-muted-foreground">{item.previous_count ?? "—"} → {item.count}</span></div><div className="flex gap-1.5"><div className="h-2 flex-1 bg-muted"><div className="h-full bg-muted-foreground/40" style={{ width: `${((item.previous_count ?? 0) / max) * 100}%` }} /></div><div className="h-2 flex-1 bg-muted"><div className="h-full bg-success-indicator" style={{ width: `${(item.count / max) * 100}%` }} /></div></div></div>)}</div>; }

function MiniRadar({ current, previous }: { current: Array<{ axis: string; value: number }>; previous: Array<{ axis: string; value: number }> }) {
  const size = 230; const center = size / 2; const radius = 72;
  const values = current.slice(0, 6);
  const previousByAxis = new Map(previous.map((item) => [item.axis, item.value]));
  const max = Math.max(10, ...values.map((item) => item.value), ...previous.map((item) => item.value));
  const pointsFor = (read: (item: { axis: string; value: number }) => number) => values.map((item, index, all) => {
    const angle = -Math.PI / 2 + index / all.length * Math.PI * 2;
    const value = read(item);
    return { ...item, angle, x: center + Math.cos(angle) * radius * value / max, y: center + Math.sin(angle) * radius * value / max };
  });
  const currentPoints = pointsFor((item) => item.value);
  const previousPoints = pointsFor((item) => previousByAxis.get(item.axis) ?? 0);
  return <div className="flex flex-1 flex-col justify-center"><svg viewBox={`0 0 ${size} ${size}`} className="mx-auto min-h-[185px] w-full max-w-[260px] flex-1" aria-label="关注结构对比"><polygon points={values.map((_, index, all) => { const angle = -Math.PI / 2 + index / all.length * Math.PI * 2; return `${center + Math.cos(angle) * radius},${center + Math.sin(angle) * radius}`; }).join(" ")} fill="none" className="stroke-border" /><polygon points={previousPoints.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeDasharray="4 4" /><polygon points={currentPoints.map((point) => `${point.x},${point.y}`).join(" ")} fill={`${PROFILE_COLORS.emerald}18`} stroke={PROFILE_COLORS.emerald} strokeWidth="2" />{currentPoints.map((point) => <text key={point.axis} x={center + Math.cos(point.angle) * (radius + 18)} y={center + Math.sin(point.angle) * (radius + 18)} textAnchor="middle" className="fill-muted-foreground text-micro">{point.axis}</text>)}</svg><div className="flex justify-center gap-4 text-micro text-muted-foreground"><span>— 本期</span><span>┄ 上期</span></div></div>;
}

function ActivityCalendar({ daily, start, end }: { daily: Array<{ date: string; user_messages: number }>; start: string; end: string }) {
  const counts = new Map(daily.map((item) => [item.date, item.user_messages]));
  const days: Array<{ date: string; user_messages: number }> = [];
  const cursor = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const finish = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  while (cursor < finish && days.length < 35) {
    const date = cursor.toISOString().slice(0, 10);
    days.push({ date, user_messages: counts.get(date) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const max = Math.max(...days.map((item) => item.user_messages), 1);
  const firstWeekday = days.length ? (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  return <div className="mx-auto w-fit"><div className="mb-1 grid grid-cols-7 gap-1 text-center text-micro text-muted-foreground">{"一二三四五六日".split("").map((day) => <span key={day} className="w-3">{day}</span>)}</div><div className="grid grid-cols-7 gap-1">{Array.from({ length: firstWeekday }, (_, index) => <span key={`blank-${index}`} className="h-3 w-3" />)}{days.map((item) => <span key={item.date} title={`${item.date} · ${item.user_messages} 条`} className="h-3 w-3 bg-muted" style={item.user_messages > 0 ? { background: `${PROFILE_COLORS.emerald}${Math.round((0.16 + item.user_messages / max * 0.72) * 255).toString(16).padStart(2, "0")}` } : undefined} />)}</div></div>;
}

function normalizeTopicComparison(raw: unknown): Array<{ topic: string; count: number; previous_count?: number; delta?: number }> { if (!Array.isArray(raw)) return []; return raw.map((item) => item as { topic?: string; current?: number; count?: number; previous?: number; previous_count?: number; delta?: number }).map((item) => ({ topic: item.topic ?? "", count: Number(item.current ?? item.count ?? 0), previous_count: item.previous ?? item.previous_count, delta: item.delta })).filter((item) => item.topic); }
function normalizeTopicTrends(raw: ProfileCharts["topic_trends"] | undefined): Array<{ topic: string; points: number[] }> { return raw?.series?.map((item) => ({ topic: item.topic, points: item.values.filter((value) => Number.isFinite(value)) })) ?? []; }
function normalizeNewTopics(raw: ProfileCharts["new_topics"] | undefined) { return raw ?? []; }
function normalizeDimensions(raw: ProfileCharts["profile_dimensions"] | undefined): Array<{ axis: string; value: number }> { return raw?.map((item) => ({ axis: item.axis, value: item.count })) ?? []; }
function coverageLabel(source: string): string { return { sessions: "会话", notes: "笔记", artifacts: "成果", agent_execution: "Agent 执行" }[source] ?? source; }
function coverageStatus(status: string): string { return status === "available" ? "完整" : status === "partial" ? "部分" : "不可用"; }
