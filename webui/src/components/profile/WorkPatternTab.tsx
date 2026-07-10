/** 工作模式 Tab：mock 行为证据看板。 */

import {
  Activity,
  CalendarClock,
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

import type { RichProfile, WorkPatterns } from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { ActivityHeatmap } from "./charts/Heatmap";
import { SankeyChart } from "./charts/SankeyChart";
import { CARD_BASE, CARD_HOVER, PROFILE_COLORS } from "./profile-theme";

interface WorkPatternTabProps {
  data?: RichProfile;
  loading: boolean;
  hasData: boolean;
}

const MOCK_WORK = {
  frequent_tasks: ["写作 & 文档处理", "数据分析", "研究收集", "会议沟通", "项目管理"],
  preferred_tools: ["Mona 对话", "知识库", "表格分析", "文档编辑", "笔记", "代码/脚本", "任务管理", "思维导图"],
  tool_chains: [
    "文档→Mona 对话→文档",
    "数据表→表格分析→数据表",
    "想法/笔记→知识库→文档",
  ],
  active_hours: "09:00 - 12:00",
  output_style: "structured",
  work_focus: "偏好结构化写作、数据验证和跨团队沟通，上午是最稳定的深度工作时段。",
  confidence: 0.89,
  evidence: {
    top_tools: [
      { tool: "Mona 对话", count: 36 },
      { tool: "知识库", count: 22 },
      { tool: "表格分析", count: 16 },
      { tool: "文档编辑", count: 14 },
      { tool: "笔记", count: 9 },
    ],
    tool_chains: [
      { chain: "文档→Mona 对话→文档", count: 36 },
      { chain: "数据表→表格分析→数据表", count: 18 },
      { chain: "想法/笔记→知识库→文档", count: 12 },
      { chain: "会议记录→Mona 对话→任务清单", count: 10 },
      { chain: "网页→知识库→报告", count: 8 },
    ],
    hourly_distribution: {},
    daily_distribution: {},
  },
} satisfies WorkPatterns;

const MOCK_HEATMAP = Array.from({ length: 7 }, (_, day) =>
  Array.from({ length: 24 }, (_, hour) => {
    const morning = hour >= 9 && hour <= 12 ? 10 : 0;
    const afternoon = hour >= 13 && hour <= 17 ? 7 : 0;
    const evening = hour >= 20 && hour <= 22 ? 2 : 0;
    const weekdayFactor = day < 5 ? 1 : 0.45;
    const wave = (day + hour) % 4;
    return Math.round((morning + afternoon + evening + wave) * weekdayFactor);
  }),
);

const TASK_DISTRIBUTION = [
  { label: "写作 & 文档处理", value: 42, color: PROFILE_COLORS.amber },
  { label: "数据分析", value: 18, color: PROFILE_COLORS.emerald },
  { label: "研究收集", value: 15, color: PROFILE_COLORS.cyan },
  { label: "会议沟通", value: 10, color: PROFILE_COLORS.emeraldSoft },
  { label: "项目管理", value: 8, color: PROFILE_COLORS.coral },
  { label: "其他", value: 7, color: "#94a3b8" },
];

export function WorkPatternTab({
  data,
  loading,
  hasData,
}: WorkPatternTabProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  const sourceNote = hasData && data ? "Mock 预览 - 已保留真实数据入口" : "Mock 数据";
  const topTools = MOCK_WORK.evidence.top_tools ?? [];
  const chains = MOCK_WORK.evidence.tool_chains ?? [];
  const mainTask = MOCK_WORK.frequent_tasks?.[0] ?? "暂无";
  const mainTool = MOCK_WORK.preferred_tools?.[0] ?? "暂无";
  const completionQuality = 87;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700">
          {sourceNote}
        </span>
        <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5" />
          近 30 天（5.12 - 6.10）
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<Clock className="h-5 w-5" />} label="活跃时段" value={MOCK_WORK.active_hours ?? "暂无"} hint="日活跃峰值" color={PROFILE_COLORS.emerald} />
        <MetricCard icon={<FileText className="h-5 w-5" />} label="高频任务" value={mainTask} hint="占全部任务 42%" color={PROFILE_COLORS.amber} />
        <MetricCard icon={<Wrench className="h-5 w-5" />} label="常用工具" value={mainTool} hint="使用时长占比 36%" color={PROFILE_COLORS.cyan} />
        <MetricCard icon={<Activity className="h-5 w-5" />} label="完成质量" value={`${completionQuality}%`} hint="基于可用工具统计" color={PROFILE_COLORS.emerald} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.05fr_1.1fr_340px]">
        <Panel className="p-4">
          <SectionTitle icon={<Activity className="h-4 w-4" />} title="活动热力" hint="按小时 × 星期" color={PROFILE_COLORS.emerald} />
          <div className="overflow-hidden">
            <ActivityHeatmap data={MOCK_HEATMAP} />
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Link2 className="h-4 w-4" />} title="工具使用链路" hint="基于工具链证据" color={PROFILE_COLORS.cyan} />
          <SankeyChart chains={chains} height={300} />
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Zap className="h-4 w-4" />} title="效率洞察" color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-3">
            <InsightItem
              icon={<Clock className="h-4 w-4" />}
              title="专注黄金段"
              body="09:00-12:00 活跃度最高，期间完成的任务占全天 38%。"
              evidence="来自 hourly_distribution"
              color={PROFILE_COLORS.emerald}
            />
            <InsightItem
              icon={<MessageSquare className="h-4 w-4" />}
              title="会议 / 切换成本"
              body="13:00-15:00 会议占比 27%，同时工具切换频次上升。"
              evidence="来自 hourly_distribution / tool_chains"
              color={PROFILE_COLORS.amber}
            />
            <InsightItem
              icon={<Link2 className="h-4 w-4" />}
              title="工具链偏好"
              body="最常见链路是：文档 → Mona 对话 → 文档，占全部链路的 36%。"
              evidence="来自 tool_chains"
              color={PROFILE_COLORS.cyan}
            />
            <InsightItem
              icon={<FileText className="h-4 w-4" />}
              title="输出风格"
              body="文档输出占比高，结构化表达为主，偏好清单与分步说明。"
              evidence="来自 output_style"
              color={PROFILE_COLORS.coral}
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[0.8fr_1fr_1fr]">
        <Panel className="p-4">
          <SectionTitle icon={<Target className="h-4 w-4" />} title="任务分布" hint="基于 frequent_tasks" color={PROFILE_COLORS.amber} />
          <TaskDistribution />
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Repeat2 className="h-4 w-4" />} title="典型工作流" hint="高频路径" color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-3">
            {chains.slice(0, 3).map((chain, index) => (
              <WorkflowRow key={chain.chain} index={index + 1} chain={chain.chain} count={chain.count} />
            ))}
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Wrench className="h-4 w-4" />} title="常用工具 Top 5" hint="使用时长占比" color={PROFILE_COLORS.cyan} />
          <div className="flex flex-col gap-2">
            {topTools.map((tool, index) => (
              <ToolRow key={tool.tool} rank={index + 1} label={tool.tool} value={tool.count} />
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[1fr_2fr]">
        <div>
          <SectionTitle icon={<ListChecks className="h-4 w-4" />} title="输出风格" color={PROFILE_COLORS.coral} />
          <div className="grid grid-cols-3 gap-3 text-center text-xs">
            <OutputMetric label="平均字数" value="1,286 字" />
            <OutputMetric label="平均段落" value="12 段" />
            <OutputMetric label="逻辑层级" value="12 段" />
          </div>
        </div>
        <div>
          <SectionTitle icon={<SparklineIcon />} title="本期工作聚焦" color={PROFILE_COLORS.emerald} />
          <p className="text-sm leading-6 text-muted-foreground">{MOCK_WORK.work_focus}</p>
        </div>
      </Panel>
    </div>
  );
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

function TaskDistribution() {
  const gradient = `conic-gradient(${TASK_DISTRIBUTION.map((item, index) => {
    const start = TASK_DISTRIBUTION.slice(0, index).reduce((sum, entry) => sum + entry.value, 0);
    const end = start + item.value;
    return `${item.color} ${start}% ${end}%`;
  }).join(", ")})`;

  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-5">
      <div className="relative h-28 w-28 rounded-full" style={{ background: gradient }}>
        <div className="absolute inset-8 flex flex-col items-center justify-center rounded-full bg-card text-center">
          <span className="text-[10px] text-muted-foreground">总任务</span>
          <span className="text-sm font-bold tabular-nums">1,248</span>
        </div>
      </div>
      <div className="space-y-1.5">
        {TASK_DISTRIBUTION.map((item) => (
          <div key={item.label} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: item.color }} />
            <span className="flex-1 truncate text-muted-foreground">{item.label}</span>
            <span className="tabular-nums">{item.value}%</span>
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
      <span className="text-right tabular-nums text-muted-foreground">{count}%</span>
    </div>
  );
}

function ToolRow({
  rank,
  label,
  value,
}: {
  rank: number;
  label: string;
  value: number;
}) {
  return (
    <div className="grid grid-cols-[18px_90px_1fr_34px] items-center gap-2 text-xs">
      <span className="text-muted-foreground">{rank}</span>
      <span className="truncate">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(value * 2.2, 100)}%` }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{value}%</span>
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
