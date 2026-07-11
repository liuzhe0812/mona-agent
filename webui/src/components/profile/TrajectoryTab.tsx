/** 成长轨迹 Tab：真实成长对比看板。 */

import { useEffect, useState } from "react";
import {
  Award,
  BookOpen,
  Crown,
  Layers,
  Rocket,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";

import {
  fetchGrowthComparison, type GrowthComparison, type RichProfile,
} from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { RadarChart } from "./charts/RadarChart";
import {
  CARD_BASE, CARD_HOVER, PROFILE_COLORS,
} from "./profile-theme";

interface TrajectoryTabProps {
  data?: RichProfile;
  loading: boolean;
}

interface GrowthPoint {
  label: string;
  value: number;
  previous: number;
}

export function TrajectoryTab({ data, loading }: TrajectoryTabProps) {
  const [comparison, setComparison] = useState<GrowthComparison | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGrowthComparison()
      .then((res) => {
        if (!cancelled) setComparison(res.comparison);
      })
      .catch(() => {
        if (!cancelled) setComparison(null);
      });
    return () => {
      cancelled = true;
    };
  }, [data?.last_distilled_at]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  // 里程碑：从 profile.visualizations.milestones 取
  const milestones = (data?.profile?.visualizations?.milestones ?? []).slice(0, 3);
  const milestoneCount = (data?.profile?.visualizations?.milestones ?? []).length;

  // 能力对比数据
  const currentRadar = comparison?.current_radar ?? data?.profile?.visualizations?.radar_scores ?? [];
  const previousRadar = comparison?.previous_radar ?? [];
  const newSkills = comparison?.new_skills ?? [];
  const skillProgression = comparison?.skill_progression ?? [];

  const hasComparison = !!comparison;

  // 综合评分
  const currentScore = currentRadar.length > 0
    ? Math.round(currentRadar.reduce((sum, item) => sum + item.value, 0) / currentRadar.length)
    : 0;
  const previousScore = previousRadar.length > 0
    ? Math.round(previousRadar.reduce((sum, item) => sum + item.value, 0) / previousRadar.length)
    : 0;
  const delta = currentScore - previousScore;

  // 成长曲线：技能积累时间线（基于 keyword_first_seen 真实数据）
  const keywordFirstSeen = data?.profile?.evidence?.keyword_first_seen ?? {};
  const skillTimeline = Object.entries(keywordFirstSeen)
    .sort(([, a], [, b]) => a.localeCompare(b));
  // 按月累计技能数
  const monthSkillCount: Record<string, number> = {};
  let cumulative = 0;
  for (const [, month] of skillTimeline) {
    cumulative += 1;
    monthSkillCount[month] = cumulative;
  }
  const growthPoints: GrowthPoint[] = Object.entries(monthSkillCount)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({ label: month.slice(5), value: count, previous: 0 }));
  // 参考线：上期技能数（若有对比）
  const refScore = previousScore || Math.max(0, currentScore - 10);
  const growthPointsWithPrev = growthPoints.map((p) => ({
    ...p,
    previous: refScore,
  }));

  // 增长最快 / 需要补强
  const sortedByDelta = [...skillProgression].sort((a, b) => b.delta - a.delta);
  const fastest = sortedByDelta.slice(0, 3);
  const slowest = sortedByDelta.slice(-3).reverse();

  // 领域变化矩阵：从 skill_progression 推导
  const fieldMatrix = buildFieldMatrix(skillProgression, currentRadar);

  // 底部证据统计
  const totalNotes = data?.profile?.evidence?.total_notes ?? 0;
  const keywordCount = (data?.profile?.evidence?.title_keywords ?? []).length;
  const radarDimCount = currentRadar.length;
  const monthCount = Object.keys(monthSkillCount).length;
  const snapshotCount = hasComparison ? 2 : 1;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={<TrendingUp className="h-5 w-5" />} label="当前评分" value={`${currentScore} /100`} hint={hasComparison ? `较上期 ${delta >= 0 ? "+" : ""}${delta} 分` : "暂无对比"} color={PROFILE_COLORS.emerald} />
        <MetricCard icon={<Rocket className="h-5 w-5" />} label="本期提升" value={hasComparison ? `${delta >= 0 ? "+" : ""}${delta}` : "—"} hint={hasComparison ? "综合能力变化" : "需两次蒸馏"} color={PROFILE_COLORS.amber} />
        <MetricCard icon={<Sparkles className="h-5 w-5" />} label="新增技能" value={newSkills.length} hint="本期新增掌握的技能点" color={PROFILE_COLORS.cyan} />
        <MetricCard icon={<Crown className="h-5 w-5" />} label="里程碑" value={milestoneCount} hint="达成重要里程碑" color={PROFILE_COLORS.amber} />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_1.25fr_320px]">
        <Panel className="p-4">
          <SectionTitle icon={<Sparkles className="h-4 w-4" />} title="能力对比" hint={hasComparison ? "本期 vs 上期" : "仅本期"} color={PROFILE_COLORS.emerald} />
          <div className="flex justify-center">
            <RadarChart current={currentRadar} previous={previousRadar.length > 0 ? previousRadar : undefined} size={330} />
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {hasComparison && fastest.length > 0
              ? <>多个维度提升，尤其在 <span className="text-emerald-600">{fastest[0].skill}</span> 方面进步明显</>
              : "蒸馏两次后可查看能力对比"}
          </p>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<TrendingUp className="h-4 w-4" />} title="技能积累" hint={growthPointsWithPrev.length > 0 ? "累计掌握技能数" : "暂无数据"} color={PROFILE_COLORS.emerald} />
          {growthPointsWithPrev.length > 0
            ? <GrowthLineChart points={growthPointsWithPrev} />
            : <div className="flex h-[250px] items-center justify-center text-xs text-muted-foreground">暂无月度数据</div>}
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {milestoneCount > 0
              ? <>本期有 <span className="text-emerald-600">{milestoneCount}</span> 个里程碑推动成长</>
              : "暂无里程碑记录"}
          </p>
        </Panel>

        <div className="grid gap-3">
          <Panel className="p-4">
            <SectionTitle icon={<BookOpen className="h-4 w-4" />} title="本期变化" color={PROFILE_COLORS.emerald} />
            <SummaryRow label="综合评分变化" value={hasComparison ? `${delta >= 0 ? "+" : ""}${delta} 分` : "—"} />
            <SummaryRow label="月度记录" value={`${monthCount} 个月`} />
            <SummaryRow label="新增技能点" value={`${newSkills.length} 个`} />
            <SummaryRow label="累计笔记" value={`${totalNotes} 篇`} />
          </Panel>
          <Panel className="p-4">
            <SectionTitle icon={<TrendingUp className="h-4 w-4" />} title="增长最快 Top 3" color={PROFILE_COLORS.emerald} />
            {fastest.length > 0 ? fastest.map((item, index) => (
              <BarRow key={item.skill} rank={index + 1} label={item.skill} value={item.delta} color={PROFILE_COLORS.emerald} sign="+" />
            )) : <span className="text-xs text-muted-foreground">需两次蒸馏对比</span>}
          </Panel>
          <Panel className="p-4">
            <SectionTitle icon={<TriangleAlert className="h-4 w-4" />} title="需要补强 Top 3" color={PROFILE_COLORS.coral} />
            {slowest.length > 0 ? slowest.map((item, index) => (
              <BarRow key={item.skill} rank={index + 1} label={item.skill} value={Math.max(8 - item.delta, 2)} color={PROFILE_COLORS.coral} sign="-" />
            )) : <span className="text-xs text-muted-foreground">需两次蒸馏对比</span>}
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_0.9fr_1.1fr]">
        <Panel className="p-4">
          <SectionTitle icon={<Layers className="h-4 w-4" />} title="技能提升" hint={skillProgression.length > 0 ? "按提升幅度" : "暂无对比"} color={PROFILE_COLORS.emerald} />
          <div className="flex flex-col gap-2">
            {skillProgression.length > 0 ? skillProgression.map((item) => (
              <ProgressRow key={item.skill} label={item.skill} before={item.before} after={item.after} delta={item.delta} />
            )) : <span className="text-xs text-muted-foreground">蒸馏两次后显示技能提升对比</span>}
          </div>
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Award className="h-4 w-4" />} title="里程碑时间线" color={PROFILE_COLORS.amber} />
          {milestones.length > 0 ? (
            <div className="relative flex flex-col gap-4 pl-5">
              <div className="absolute bottom-2 left-[7px] top-2 w-px bg-border" />
              {milestones.map((milestone, index) => (
                <div key={`${milestone.title}-${index}`} className="relative">
                  <span
                    className="absolute -left-5 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-background"
                    style={{ background: [PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.cyan][index % 3] }}
                  />
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">{milestone.date || milestone.type}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{milestone.icon}</span>
                  </div>
                  <p className="mt-1 text-xs font-medium">{milestone.title}</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{milestone.description}</p>
                </div>
              ))}
            </div>
          ) : <span className="text-xs text-muted-foreground">暂无里程碑</span>}
        </Panel>

        <Panel className="p-4">
          <SectionTitle icon={<Layers className="h-4 w-4" />} title="领域变化矩阵" hint="提升幅度 × 稳定性" color={PROFILE_COLORS.cyan} />
          <div className="grid grid-cols-2 gap-2">
            {fieldMatrix.map((field) => (
              <div key={field.title} className="rounded-lg border p-3" style={{ background: `${field.color}10`, borderColor: `${field.color}24` }}>
                <p className="mb-2 text-sm font-semibold" style={{ color: field.color }}>{field.title}</p>
                {field.items.length > 0 ? (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {field.items.map((item) => <li key={item}>· {item}</li>)}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">暂无</p>}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="grid grid-cols-1 gap-3 p-4 text-xs text-muted-foreground md:grid-cols-5">
        <EvidenceItem label="数据快照" value={`${snapshotCount} 份`} />
        <EvidenceItem label="技能维度" value={`${radarDimCount} 个`} />
        <EvidenceItem label="月度记录" value={`${monthCount} 个月`} />
        <EvidenceItem label="累计笔记" value={`${totalNotes} 篇`} />
        <EvidenceItem label="关键词" value={`${keywordCount} 个`} />
      </Panel>
    </div>
  );
}

/** 从 skill_progression + radar_scores 推导领域变化矩阵 */
function buildFieldMatrix(
  progression: GrowthComparison["skill_progression"],
  radar: GrowthComparison["current_radar"],
): { title: string; items: string[]; color: string }[] {
  if (progression.length === 0 && radar.length === 0) {
    return [
      { title: "新兴领域", items: [], color: PROFILE_COLORS.emerald },
      { title: "稳定优势", items: [], color: PROFILE_COLORS.amber },
      { title: "稳步发展", items: [], color: PROFILE_COLORS.cyan },
      { title: "放缓领域", items: [], color: PROFILE_COLORS.coral },
    ];
  }

  if (progression.length > 0) {
    const sorted = [...progression].sort((a, b) => b.delta - a.delta);
    const emerging = sorted.slice(0, 3).map((s) => s.skill);
    const stable = sorted.filter((s) => s.after >= 70 && s.delta >= 5).slice(0, 3).map((s) => s.skill);
    const steady = sorted.filter((s) => s.delta >= 2 && s.delta < 8).slice(0, 3).map((s) => s.skill);
    const slowing = sorted.slice(-3).reverse().filter((s) => s.delta < 3).slice(0, 3).map((s) => s.skill);
    return [
      { title: "新兴领域", items: emerging, color: PROFILE_COLORS.emerald },
      { title: "稳定优势", items: stable, color: PROFILE_COLORS.amber },
      { title: "稳步发展", items: steady, color: PROFILE_COLORS.cyan },
      { title: "放缓领域", items: slowing, color: PROFILE_COLORS.coral },
    ];
  }

  // 无 progression 时从 radar 取
  const sorted = [...radar].sort((a, b) => b.value - a.value);
  return [
    { title: "新兴领域", items: sorted.slice(-3).map((s) => s.axis), color: PROFILE_COLORS.emerald },
    { title: "稳定优势", items: sorted.slice(0, 3).map((s) => s.axis), color: PROFILE_COLORS.amber },
    { title: "稳步发展", items: sorted.slice(3, 6).map((s) => s.axis), color: PROFILE_COLORS.cyan },
    { title: "放缓领域", items: [], color: PROFILE_COLORS.coral },
  ];
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
  points: GrowthPoint[];
}) {
  const w = 680;
  const h = 250;
  const pad = { top: 20, right: 24, bottom: 34, left: 36 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;
  const max = Math.max(10, ...points.map((p) => p.value), ...points.map((p) => p.previous));
  const xs = points.map((_, index) => pad.left + (points.length <= 1 ? innerW / 2 : (index / (points.length - 1)) * innerW));
  const yFor = (value: number) => pad.top + innerH - (value / max) * innerH;
  const currentPath = points.map((point, index) => `${index === 0 ? "M" : "L"}${xs[index]},${yFor(point.value)}`).join(" ");
  const previousPath = points.map((point, index) => `${index === 0 ? "M" : "L"}${xs[index]},${yFor(point.previous)}`).join(" ");
  const markerIndexes = points.length > 6 ? [1, 3, 6] : points.length > 3 ? [1, 2, 3] : [];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full">
      <defs>
        <linearGradient id="growth-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PROFILE_COLORS.emerald} stopOpacity="0.26" />
          <stop offset="100%" stopColor={PROFILE_COLORS.emerald} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, Math.ceil(max * 0.25), Math.ceil(max * 0.5), Math.ceil(max * 0.75), max].map((tick) => {
        const y = yFor(tick);
        return (
          <g key={tick}>
            <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="currentColor" className="text-border" strokeDasharray="4 4" />
            <text x={pad.left - 8} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">{tick}</text>
          </g>
        );
      })}
      {points.length > 1 && (
        <path d={`${currentPath} L${xs[xs.length - 1]},${yFor(0)} L${xs[0]},${yFor(0)} Z`} fill="url(#growth-fill)" />
      )}
      {points.length > 1 && (
        <path d={previousPath} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="5 5" />
      )}
      {points.length > 1 && (
        <path d={currentPath} fill="none" stroke={PROFILE_COLORS.emerald} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {points.map((point, index) => (
        <g key={point.label}>
          <circle cx={xs[index]} cy={yFor(point.value)} r="4" fill="white" stroke={PROFILE_COLORS.emerald} strokeWidth="2" />
          <text x={xs[index]} y={h - 10} textAnchor="middle" className="fill-muted-foreground text-[10px]">{point.label}</text>
        </g>
      ))}
      {markerIndexes.map((index, markerIndex) => {
        if (index >= points.length) return null;
        return (
          <g key={index}>
            <line x1={xs[index]} y1={yFor(points[index].value) + 10} x2={xs[index]} y2={h - pad.bottom - 2} stroke={PROFILE_COLORS.amber} strokeDasharray="3 3" />
            <circle cx={xs[index]} cy={yFor(points[index].value) + 22} r="10" fill={[PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.cyan][markerIndex]} />
            <text x={xs[index]} y={yFor(points[index].value) + 26} textAnchor="middle" className="fill-white text-[10px] font-bold">{markerIndex + 1}</text>
          </g>
        );
      })}
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
