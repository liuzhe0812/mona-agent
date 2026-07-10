/** 成长轨迹 Tab：mock 时间变化看板。 */

import {
  Award,
  BookOpen,
  CalendarDays,
  Crown,
  Layers,
  Rocket,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";

import type { GrowthComparison, RichProfile } from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { RadarChart } from "./charts/RadarChart";
import {
  CARD_BASE, CARD_HOVER, PROFILE_COLORS,
} from "./profile-theme";

interface TrajectoryTabProps {
  data?: RichProfile;
  loading: boolean;
}

const MOCK_COMPARISON: GrowthComparison = {
  current_radar: [
    { axis: "产品策略", key: "strategy", value: 88 },
    { axis: "用户洞察", key: "user", value: 85 },
    { axis: "数据分析", key: "data", value: 84 },
    { axis: "项目管理", key: "pm", value: 83 },
    { axis: "团队协作", key: "collab", value: 90 },
    { axis: "沟通表达", key: "comm", value: 86 },
    { axis: "问题解决", key: "solve", value: 89 },
    { axis: "创新思维", key: "creative", value: 81 },
  ],
  previous_radar: [
    { axis: "产品策略", key: "strategy", value: 72 },
    { axis: "用户洞察", key: "user", value: 73 },
    { axis: "数据分析", key: "data", value: 70 },
    { axis: "项目管理", key: "pm", value: 80 },
    { axis: "团队协作", key: "collab", value: 72 },
    { axis: "沟通表达", key: "comm", value: 83 },
    { axis: "问题解决", key: "solve", value: 78 },
    { axis: "创新思维", key: "creative", value: 75 },
  ],
  new_skills: ["数据洞察", "用户访谈", "增长实验", "需求拆解", "PRD 结构化", "方案复盘", "竞品分析"],
  skill_progression: [
    { skill: "团队协作", before: 72, after: 90, delta: 18 },
    { skill: "产品策略", before: 71, after: 88, delta: 17 },
    { skill: "数据分析", before: 70, after: 84, delta: 14 },
    { skill: "用户洞察", before: 73, after: 85, delta: 12 },
    { skill: "问题解决", before: 78, after: 89, delta: 11 },
    { skill: "创新思维", before: 75, after: 81, delta: 6 },
    { skill: "沟通表达", before: 83, after: 86, delta: 3 },
    { skill: "项目管理", before: 80, after: 83, delta: 3 },
  ],
  current_snapshot_date: "2026-06-10",
  previous_snapshot_date: "2026-05-11",
};

const GROWTH_POINTS = [
  { label: "5.12", value: 60, previous: 52 },
  { label: "5.16", value: 65, previous: 56 },
  { label: "5.20", value: 70, previous: 61 },
  { label: "5.24", value: 76, previous: 66 },
  { label: "5.28", value: 79, previous: 68 },
  { label: "6.01", value: 82, previous: 72 },
  { label: "6.05", value: 84, previous: 73 },
  { label: "6.10", value: 86, previous: 78 },
];

const MILESTONES = [
  { date: "5.18", title: "完成数据分析项目", type: "项目", body: "输出用户行为分析模型，推动洞察报告落地。" },
  { date: "5.29", title: "主导产品方案落地", type: "产品", body: "方案正式上线，获得用户正反馈。" },
  { date: "6.07", title: "知识库贡献突破", type: "知识", body: "知识库累计贡献内容突破 100 篇。" },
];

const FIELD_MATRIX = [
  { title: "新兴领域", items: ["用户洞察", "数据分析", "团队协作"], color: PROFILE_COLORS.emerald },
  { title: "稳定优势", items: ["产品策略", "问题解决"], color: PROFILE_COLORS.amber },
  { title: "稳步发展", items: ["项目管理", "沟通表达"], color: PROFILE_COLORS.cyan },
  { title: "放缓领域", items: ["创新思维"], color: PROFILE_COLORS.coral },
];

export function TrajectoryTab({ data, loading }: TrajectoryTabProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  const sourceNote = data ? "Mock 预览 - 已保留真实数据入口" : "Mock 数据";
  const currentScore = Math.round(
    MOCK_COMPARISON.current_radar.reduce((sum, item) => sum + item.value, 0) / MOCK_COMPARISON.current_radar.length,
  );
  const previousScore = Math.round(
    MOCK_COMPARISON.previous_radar.reduce((sum, item) => sum + item.value, 0) / MOCK_COMPARISON.previous_radar.length,
  );
  const delta = currentScore - previousScore;
  const fastest = [...MOCK_COMPARISON.skill_progression].sort((a, b) => b.delta - a.delta).slice(0, 3);
  const slowest = [...MOCK_COMPARISON.skill_progression].sort((a, b) => a.delta - b.delta).slice(0, 3);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700">
          {sourceNote}
        </span>
        <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5" />
          近 30 天（5.12 - 6.10） · 对比上期
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<TrendingUp className="h-5 w-5" />} label="当前评分" value={`${currentScore} /100`} hint={`较上期 +${delta} 分`} color={PROFILE_COLORS.emerald} />
        <MetricCard icon={<Rocket className="h-5 w-5" />} label="本期提升" value={`+${delta}`} hint="较上期增长 16.3%" color={PROFILE_COLORS.amber} />
        <MetricCard icon={<Sparkles className="h-5 w-5" />} label="新增技能" value={MOCK_COMPARISON.new_skills.length} hint="本期新增掌握的技能点" color={PROFILE_COLORS.cyan} />
        <MetricCard icon={<Crown className="h-5 w-5" />} label="里程碑" value={MILESTONES.length} hint="达成重要里程碑" color={PROFILE_COLORS.amber} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.25fr_320px]">
        <Panel className="p-4">
          <SectionTitle icon={<Sparkles className="h-4 w-4" />} title="能力对比" hint="本期 vs 上期" color={PROFILE_COLORS.emerald} />
          <div className="flex justify-center">
            <RadarChart current={MOCK_COMPARISON.current_radar} previous={MOCK_COMPARISON.previous_radar} size={330} />
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            多个维度提升，尤其在 <span className="text-emerald-600">团队协作</span>、<span className="text-emerald-600">产品策略</span> 方面进步明显
          </p>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<TrendingUp className="h-4 w-4" />} title="成长曲线" hint="综合评分" color={PROFILE_COLORS.emerald} />
          <GrowthLineChart points={GROWTH_POINTS} />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            本期整体趋势上升，有 <span className="text-emerald-600">3</span> 个关键里程碑推动成长
          </p>
        </Panel>

        <div className="grid gap-3">
          <Panel className="p-4">
            <SectionTitle icon={<BookOpen className="h-4 w-4" />} title="本期变化" color={PROFILE_COLORS.emerald} />
            <SummaryRow label="综合评分提升" value={`+${delta} 分`} />
            <SummaryRow label="活跃天数" value="26 天" />
            <SummaryRow label="新增技能点" value={`${MOCK_COMPARISON.new_skills.length} 个`} />
            <SummaryRow label="新增笔记" value="48 篇" />
          </Panel>
          <Panel className="p-4">
            <SectionTitle icon={<TrendingUp className="h-4 w-4" />} title="增长最快 Top 3" color={PROFILE_COLORS.emerald} />
            {fastest.map((item, index) => (
              <BarRow key={item.skill} rank={index + 1} label={item.skill} value={item.delta} color={PROFILE_COLORS.emerald} sign="+" />
            ))}
          </Panel>
          <Panel className="p-4">
            <SectionTitle icon={<TriangleAlert className="h-4 w-4" />} title="需要补强 Top 3" color={PROFILE_COLORS.coral} />
            {slowest.map((item, index) => (
              <BarRow key={item.skill} rank={index + 1} label={item.skill} value={Math.max(8 - item.delta, 2)} color={PROFILE_COLORS.coral} sign="-" />
            ))}
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_0.9fr_1.1fr]">
        <Panel className="p-4">
          <SectionTitle icon={<Layers className="h-4 w-4" />} title="技能提升" hint="按提升幅度" color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-2">
            {MOCK_COMPARISON.skill_progression.map((item) => (
              <ProgressRow key={item.skill} label={item.skill} before={item.before} after={item.after} delta={item.delta} />
            ))}
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Award className="h-4 w-4" />} title="里程碑时间线" color={PROFILE_COLORS.amber} />
          <div className="relative flex flex-col gap-4 pl-5">
            <div className="absolute bottom-2 left-[7px] top-2 w-px bg-border" />
            {MILESTONES.map((milestone, index) => (
              <div key={milestone.title} className="relative">
                <span
                  className="absolute -left-5 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-background"
                  style={{ background: [PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.cyan][index] }}
                />
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">{milestone.date}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{milestone.type}</span>
                </div>
                <p className="mt-1 text-xs font-medium">{milestone.title}</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{milestone.body}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Layers className="h-4 w-4" />} title="领域变化矩阵" hint="提升幅度 × 稳定性" color={PROFILE_COLORS.cyan} />
          <div className="grid grid-cols-2 gap-2">
            {FIELD_MATRIX.map((field) => (
              <div key={field.title} className="rounded-lg border p-3" style={{ background: `${field.color}10`, borderColor: `${field.color}24` }}>
                <p className="mb-2 text-sm font-semibold" style={{ color: field.color }}>{field.title}</p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {field.items.map((item) => <li key={item}>· {item}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="grid grid-cols-1 gap-3 p-4 text-xs text-muted-foreground md:grid-cols-5">
        <EvidenceItem label="数据快照" value="31 条" />
        <EvidenceItem label="技能进度记录" value="8 个维度" />
        <EvidenceItem label="月度记录" value="2 个月" />
        <EvidenceItem label="总笔记" value="248 篇" />
        <EvidenceItem label="关键词" value="36 个" />
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
        <p className="truncate text-2xl font-bold tabular-nums" style={{ color }}>{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </Panel>
  );
}

function GrowthLineChart({
  points,
}: {
  points: typeof GROWTH_POINTS;
}) {
  const w = 680;
  const h = 250;
  const pad = { top: 20, right: 24, bottom: 34, left: 36 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;
  const max = 100;
  const xs = points.map((_, index) => pad.left + (index / (points.length - 1)) * innerW);
  const yFor = (value: number) => pad.top + innerH - (value / max) * innerH;
  const currentPath = points.map((point, index) => `${index === 0 ? "M" : "L"}${xs[index]},${yFor(point.value)}`).join(" ");
  const previousPath = points.map((point, index) => `${index === 0 ? "M" : "L"}${xs[index]},${yFor(point.previous)}`).join(" ");
  const markerIndexes = [1, 3, 6];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full">
      <defs>
        <linearGradient id="growth-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PROFILE_COLORS.emerald} stopOpacity="0.26" />
          <stop offset="100%" stopColor={PROFILE_COLORS.emerald} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((tick) => {
        const y = yFor(tick);
        return (
          <g key={tick}>
            <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="currentColor" className="text-border" strokeDasharray="4 4" />
            <text x={pad.left - 8} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">{tick}</text>
          </g>
        );
      })}
      <path d={`${currentPath} L${xs[xs.length - 1]},${yFor(0)} L${xs[0]},${yFor(0)} Z`} fill="url(#growth-fill)" />
      <path d={previousPath} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="5 5" />
      <path d={currentPath} fill="none" stroke={PROFILE_COLORS.emerald} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, index) => (
        <g key={point.label}>
          <circle cx={xs[index]} cy={yFor(point.value)} r="4" fill="white" stroke={PROFILE_COLORS.emerald} strokeWidth="2" />
          <text x={xs[index]} y={h - 10} textAnchor="middle" className="fill-muted-foreground text-[10px]">{point.label}</text>
        </g>
      ))}
      {markerIndexes.map((index, markerIndex) => (
        <g key={index}>
          <line x1={xs[index]} y1={yFor(GROWTH_POINTS[index].value) + 10} x2={xs[index]} y2={h - pad.bottom - 2} stroke={PROFILE_COLORS.amber} strokeDasharray="3 3" />
          <circle cx={xs[index]} cy={yFor(GROWTH_POINTS[index].value) + 22} r="10" fill={[PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.cyan][markerIndex]} />
          <text x={xs[index]} y={yFor(GROWTH_POINTS[index].value) + 26} textAnchor="middle" className="fill-white text-[10px] font-bold">{markerIndex + 1}</text>
        </g>
      ))}
    </svg>
  );
}

function SummaryRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between border-b py-2 text-xs last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-emerald-600">{value}</span>
    </div>
  );
}

function BarRow({
  rank,
  label,
  value,
  color,
  sign,
}: {
  rank: number;
  label: string;
  value: number;
  color: string;
  sign: "+" | "-";
}) {
  return (
    <div className="grid grid-cols-[22px_80px_1fr_42px] items-center gap-2 py-1 text-xs">
      <span className="flex h-5 w-5 items-center justify-center rounded text-[10px] text-white" style={{ background: color }}>{rank}</span>
      <span className="truncate">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.min(value * 5, 100)}%`, background: color }} />
      </div>
      <span className="text-right tabular-nums" style={{ color }}>{sign}{value} 分</span>
    </div>
  );
}

function ProgressRow({
  label,
  before,
  after,
  delta,
}: {
  label: string;
  before: number;
  after: number;
  delta: number;
}) {
  return (
    <div className="grid grid-cols-[88px_1fr_38px_38px_38px] items-center gap-2 text-xs">
      <span className="truncate">{label}</span>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${after}%` }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{before}</span>
      <span className="text-right tabular-nums">{after}</span>
      <span className="text-right tabular-nums text-emerald-600">+{delta}</span>
    </div>
  );
}

function EvidenceItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-background/60 px-3 py-2">
      <span>{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
