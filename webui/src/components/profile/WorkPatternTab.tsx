/** 工作模式 Tab：真实行为证据看板。 */

import {
  Activity,
  CalendarDays,
  Clock,
  FileText,
  Link2,
  ListChecks,
  MessageSquare,
  Repeat2,
  Target,
  Wrench,
  Zap,
} from "lucide-react";

import type { RichProfile } from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { ActivityHeatmap } from "./charts/Heatmap";
import { SankeyChart } from "./charts/SankeyChart";
import { CARD_BASE, CARD_HOVER, PROFILE_COLORS, hourlyToHeatmap } from "./profile-theme";

interface WorkPatternTabProps {
  data?: RichProfile;
  loading: boolean;
}

export function WorkPatternTab({
  data,
  loading,
}: WorkPatternTabProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  const work = data?.work_patterns;

  const topTools = work?.evidence?.top_tools ?? [];
  const chains = work?.evidence?.tool_chains ?? [];
  const frequentTasks = work?.frequent_tasks ?? [];
  const preferredTools = work?.preferred_tools ?? [];
  const mainTask = frequentTasks[0] ?? "暂无";
  const mainTool = preferredTools[0] ?? "暂无";

  // 完成质量：从 tool_success 计算真实成功率
  const toolSuccess = work?.evidence?.tool_success ?? {};
  const successEntries = Object.values(toolSuccess);
  const totalSuccess = successEntries.reduce((sum, s) => sum + (s.success ?? 0), 0);
  const totalCalls = successEntries.reduce((sum, s) => sum + (s.total ?? 0), 0);
  const completionQuality = totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : null;

  // 活动热力图
  const heatmap = hourlyToHeatmap(work?.evidence?.hourly_distribution);

  // 工具使用分布：从 top_tools 真实计数生成
  const toolDistribution = topTools.slice(0, 6).map((t, i) => ({
    label: t.tool,
    value: t.count,
    color: [PROFILE_COLORS.amber, PROFILE_COLORS.emerald, PROFILE_COLORS.cyan, PROFILE_COLORS.emeraldSoft, PROFILE_COLORS.coral, "#94a3b8"][i % 6],
  }));

  // 活跃时段
  const activeHours = work?.active_hours ?? "暂无";

  // 效率洞察：数据驱动生成
  const hourly = work?.evidence?.hourly_distribution ?? {};
  const daily = work?.evidence?.daily_distribution ?? {};
  const peakHour = findPeakHour(hourly);
  const topChain = chains[0];
  const outputStyle = work?.output_style ?? "未知";
  const workFocus = work?.work_focus ?? "";

  // 工作日 vs 周末强度
  const weekdaySum = ["1", "2", "3", "4", "5"]
    .reduce((sum, d) => sum + (daily[d] ?? 0), 0);
  const weekendSum = ["0", "6"]
    .reduce((sum, d) => sum + (daily[d] ?? 0), 0);
  const totalDaily = weekdaySum + weekendSum;
  const weekdayRatio = totalDaily > 0 ? Math.round((weekdaySum / totalDaily) * 100) : null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<Clock className="h-5 w-5" />} label="活跃时段" value={activeHours} hint="日活跃峰值" color={PROFILE_COLORS.emerald} />
        <MetricCard icon={<FileText className="h-5 w-5" />} label="高频任务" value={mainTask} hint={frequentTasks.length > 0 ? `共 ${frequentTasks.length} 类任务` : "暂无"} color={PROFILE_COLORS.amber} />
        <MetricCard icon={<Wrench className="h-5 w-5" />} label="常用工具" value={mainTool} hint={preferredTools.length > 0 ? `共 ${preferredTools.length} 种工具` : "暂无"} color={PROFILE_COLORS.cyan} />
        <MetricCard icon={<Activity className="h-5 w-5" />} label="完成质量" value={completionQuality !== null ? `${completionQuality}%` : "暂无"} hint="工具调用成功率" color={PROFILE_COLORS.emerald} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_340px]">
        <div className="grid gap-3">
          <Panel className="p-4">
            <SectionTitle icon={<Activity className="h-4 w-4" />} title="活动热力" hint="按小时 × 星期" color={PROFILE_COLORS.emerald} />
            <div className="flex justify-center overflow-hidden">
              <ActivityHeatmap data={heatmap} />
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionTitle icon={<Link2 className="h-4 w-4" />} title="工具使用链路" hint={chains.length > 0 ? "基于工具链证据" : "暂无数据"} color={PROFILE_COLORS.cyan} />
            <div className="flex justify-center">
              {chains.length > 0
                ? <SankeyChart chains={chains} height={200} />
                : <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">暂无工具链数据</div>}
            </div>
          </Panel>
        </div>

        <Panel className="p-4">
          <SectionTitle icon={<Zap className="h-4 w-4" />} title="效率洞察" color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-3">
            <InsightItem
              icon={<Clock className="h-4 w-4" />}
              title="专注黄金段"
              body={peakHour ? `${peakHour}:00 时段活跃度最高，是深度工作的最佳时段。` : "暂无小时分布数据，蒸馏后生成。"}
              evidence="来自 hourly_distribution"
              color={PROFILE_COLORS.emerald}
            />
            <InsightItem
              icon={<MessageSquare className="h-4 w-4" />}
              title="工具切换"
              body={chains.length > 0 ? `共记录 ${chains.length} 条工具链，最常见链路使用 ${topChain?.count ?? 0} 次。` : "暂无工具链数据。"}
              evidence="来自 tool_chains"
              color={PROFILE_COLORS.amber}
            />
            <InsightItem
              icon={<Link2 className="h-4 w-4" />}
              title="工具链偏好"
              body={topChain ? `最常见链路：${topChain.chain}，占全部链路的 ${topChain.count} 次。` : "暂无链路数据。"}
              evidence="来自 tool_chains"
              color={PROFILE_COLORS.cyan}
            />
            <InsightItem
              icon={<FileText className="h-4 w-4" />}
              title="输出风格"
              body={outputStyle !== "未知" ? `输出风格：${outputStyle}，偏好结构化表达。` : "暂无输出风格数据。"}
              evidence="来自 output_style"
              color={PROFILE_COLORS.coral}
            />
            <InsightItem
              icon={<CalendarDays className="h-4 w-4" />}
              title="工作日强度"
              body={weekdayRatio !== null
                ? `工作日活跃度占 ${weekdayRatio}%，${weekdayRatio >= 80 ? "高度集中在工作日。" : weekdayRatio >= 60 ? "以工作日为主，偶有周末活动。" : "工作日与周末分布较均衡。"}`
                : "暂无每日分布数据。"}
              evidence="来自 daily_distribution"
              color={PROFILE_COLORS.amberSoft}
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[0.8fr_1fr_1fr]">
        <Panel className="p-4">
          <SectionTitle icon={<Target className="h-4 w-4" />} title="工具使用分布" hint={toolDistribution.length > 0 ? "基于真实调用次数" : "暂无数据"} color={PROFILE_COLORS.amber} />
          {toolDistribution.length > 0 ? <TaskDistribution items={toolDistribution} total={topTools.reduce((sum, t) => sum + t.count, 0)} /> : <span className="text-xs text-muted-foreground">暂无工具数据</span>}
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Repeat2 className="h-4 w-4" />} title="典型工作流" hint={chains.length > 0 ? "高频路径" : "暂无数据"} color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-3">
            {chains.length > 0 ? chains.slice(0, 3).map((chain, index) => (
              <WorkflowRow key={chain.chain} index={index + 1} chain={chain.chain} count={chain.count} />
            )) : <span className="text-xs text-muted-foreground">暂无工作流数据</span>}
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Wrench className="h-4 w-4" />} title="常用工具 Top 5" hint={topTools.length > 0 ? "使用次数" : "暂无数据"} color={PROFILE_COLORS.cyan} />
          <div className="flex flex-col gap-2">
            {topTools.length > 0 ? topTools.slice(0, 5).map((tool, index) => (
              <ToolRow key={tool.tool} rank={index + 1} label={tool.tool} value={tool.count} max={topTools[0]?.count ?? 1} />
            )) : preferredTools.length > 0 ? preferredTools.slice(0, 5).map((tool, index) => (
              <ToolRow key={tool} rank={index + 1} label={tool} value={5 - index} max={5} />
            )) : <span className="text-xs text-muted-foreground">暂无工具数据</span>}
          </div>
        </Panel>
      </div>

      <Panel className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[1fr_2fr]">
        <div>
          <SectionTitle icon={<ListChecks className="h-4 w-4" />} title="输出风格" color={PROFILE_COLORS.coral} />
          <div className="grid grid-cols-3 gap-3 text-center text-xs">
            <OutputMetric label="输出风格" value={outputStyle} />
            <OutputMetric label="工具数" value={`${preferredTools.length} 种`} />
            <OutputMetric label="任务类" value={`${frequentTasks.length} 类`} />
          </div>
        </div>
        <div>
          <SectionTitle icon={<SparklineIcon />} title="本期工作聚焦" color={PROFILE_COLORS.emerald} />
          <p className="text-sm leading-6 text-muted-foreground">{workFocus || "暂无工作聚焦数据，蒸馏后生成。"}</p>
        </div>
      </Panel>
    </div>
  );
}

/** 从 hourly_distribution 找活跃度最高的小时 */
function findPeakHour(hourly: Record<string, number>): number | null {
  const entries = Object.entries(hourly);
  if (entries.length === 0) return null;
  const peak = entries.reduce((max, [h, count]) => (count > max[1] ? [h, count] : max), entries[0]);
  const hour = Number(peak[0]);
  return Number.isInteger(hour) ? hour : null;
}

function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(CARD_BASE, CARD_HOVER, "profile-card rounded-lg bg-card/70", className)}>
      {children}
    </div>
  );
}

function SectionTitle({
  icon,
  title,
  hint,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  color: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <span style={{ color }}>{icon}</span>
        {title}
      </h3>
      {hint && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  hint: string;
  color: string;
}) {
  return (
    <Panel className="flex items-center gap-3 p-4">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}16`, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-bold tabular-nums" style={{ color }}>{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </Panel>
  );
}

function InsightItem({
  icon,
  title,
  body,
  evidence,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  evidence: string;
  color: string;
}) {
  return (
    <div className="flex gap-3 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: `${color}18`, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color }}>{title}</p>
        <p className="mt-1 text-xs leading-5 text-foreground">{body}</p>
        <span className="mt-2 inline-flex rounded-full px-2 py-0.5 text-[10px]" style={{ background: `${color}12`, color }}>
          {evidence}
        </span>
      </div>
    </div>
  );
}

function TaskDistribution({
  items,
  total,
}: {
  items: { label: string; value: number; color: string }[];
  total: number;
}) {
  // value 是原始计数，转为百分比用于饼图和展示
  const totalSum = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const percentItems = items.map((item) => ({
    ...item,
    percent: Math.round((item.value / totalSum) * 100),
  }));

  const gradient = `conic-gradient(${percentItems.map((item, index) => {
    const start = percentItems.slice(0, index).reduce((sum, entry) => sum + entry.percent, 0);
    const end = start + item.percent;
    return `${item.color} ${start}% ${end}%`;
  }).join(", ")})`;

  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-5">
      <div className="relative h-28 w-28 rounded-full" style={{ background: gradient }}>
        <div className="absolute inset-8 flex flex-col items-center justify-center rounded-full bg-card text-center">
          <span className="text-[10px] text-muted-foreground">总调用</span>
          <span className="text-sm font-bold tabular-nums">{total}</span>
        </div>
      </div>
      <div className="space-y-1.5">
        {percentItems.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: item.color }} />
            <span className="flex-1 truncate text-muted-foreground">{item.label}</span>
            <span className="tabular-nums">{item.value} 次</span>
            <span className="tabular-nums text-muted-foreground">({item.percent}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkflowRow({
  index,
  chain,
  count,
}: {
  index: number;
  chain: string;
  count: number;
}) {
  const steps = chain.split("→");

  return (
    <div className="grid grid-cols-[22px_1fr_44px] items-center gap-2 rounded-lg border bg-background/60 p-2 text-xs">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-medium text-white">{index}</span>
      <div className="flex min-w-0 items-center gap-1">
        {steps.map((step, stepIndex) => (
          <span key={`${step}-${stepIndex}`} className="flex min-w-0 items-center gap-1">
            <span className="truncate rounded-md bg-muted px-2 py-1">{step}</span>
            {stepIndex < steps.length - 1 && <span className="text-muted-foreground">→</span>}
          </span>
        ))}
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{count} 次</span>
    </div>
  );
}

function ToolRow({
  rank,
  label,
  value,
  max,
}: {
  rank: number;
  label: string;
  value: number;
  max: number;
}) {
  const ratio = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="grid grid-cols-[18px_90px_1fr_34px] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{rank}</span>
      <span className="truncate">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(ratio, 100)}%` }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}

function OutputMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border bg-background/60 px-3 py-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold text-foreground">{value}</p>
    </div>
  );
}

function SparklineIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
      <path
        d="M2 11.5 5.4 8l2.4 2.2L14 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
