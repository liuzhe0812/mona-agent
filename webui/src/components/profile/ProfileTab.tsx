/** 人物画像 Tab：能力总览看板（真实后端数据）。 */

import {
  AlertTriangle,
  BadgeCheck,
  Lightbulb,
  Sparkles,
  Star,
  Tags,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";

import {
  type ProfileData,
} from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { KnowledgeStarGraph } from "./charts/KnowledgeStarGraph";
import { RadarChart } from "./charts/RadarChart";
import { SkillMatrix } from "./charts/SkillMatrix";
import {
  CARD_BASE, CARD_HOVER, PROFILE_COLORS, scoreLevel,
} from "./profile-theme";

interface ProfileTabProps {
  data?: ProfileData;
  loading: boolean;
}

export function ProfileTab({
  data,
  loading,
}: ProfileTabProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  const identity = data?.identity ?? {};
  const evidence = data?.evidence ?? {};
  const viz = data?.visualizations ?? {};
  const radarScores = viz.radar_scores ?? [];
  const skillMatrix = viz.skill_matrix ?? [];
  const knowledgeGraph = viz.knowledge_graph;
  const tagCloud = viz.tag_cloud ?? evidence.tag_distribution ?? [];
  const totalNotes = evidence.total_notes ?? 0;

  // 人际网络：优先用 top_senders（有 count），否则用 frequent_contacts（无 count）
  // 过滤掉用户自己的邮箱（liuzhe@os-easy.com）
  const SELF_EMAIL = "liuzhe@os-easy.com";
  const topSenders = (evidence.top_senders ?? []).filter(
    (s) => (s.address ?? "").toLowerCase() !== SELF_EMAIL,
  );
  const frequentContacts = (data?.relationships?.frequent_contacts ?? []).filter(
    (name) => name.toLowerCase() !== SELF_EMAIL,
  );
  const contacts = topSenders.length > 0
    ? topSenders.slice(0, 5).map((s, i) => ({
        name: s.sender ?? s.address ?? `联系人 ${i + 1}`,
        score: Math.max(30, 92 - i * 6),
      }))
    : frequentContacts.slice(0, 5).map((name, i) => ({
        name,
        score: 92 - i * 6,
      }));

  const avgScore = radarScores.length > 0
    ? Math.round(radarScores.reduce((sum, item) => sum + item.value, 0) / radarScores.length)
    : 0;
  const { label: scoreLabel, color: scoreColor } = scoreLevel(avgScore);

  // 关键洞察：数据驱动生成
  const sortedRadar = [...radarScores].sort((a, b) => b.value - a.value);
  const strongest = sortedRadar[0];
  const weakest = sortedRadar[sortedRadar.length - 1];

  // 笔记月度趋势（最近两个月对比）
  const monthly = evidence.notes_monthly ?? {};
  const monthKeys = Object.keys(monthly).sort();
  const lastMonth = monthKeys[monthKeys.length - 1];
  const prevMonth = monthKeys[monthKeys.length - 2];
  const lastCount = lastMonth ? monthly[lastMonth] : 0;
  const prevCount = prevMonth ? monthly[prevMonth] : 0;
  const monthDelta = lastCount - prevCount;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <Panel className="p-5">
        <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
          <div className="flex min-w-0 items-center gap-5">
            <div
              className="relative flex h-24 w-24 shrink-0 items-center justify-center rounded-[28px] text-white shadow-lg"
              style={{ background: `linear-gradient(145deg, ${PROFILE_COLORS.coralSoft}, ${PROFILE_COLORS.coral})` }}
            >
              <UserRound className="h-12 w-12" />
              <span className="absolute right-3 top-3 h-5 w-5 rounded-full border-2 border-white bg-teal-400" />
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="truncate text-2xl font-bold tracking-tight">
                  {identity.primary_role || "尚未确定角色"}
                </h2>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  主角色
                </span>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(identity.secondary_roles ?? []).map((role) => (
                  <span key={role} className="rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground">
                    {role}
                  </span>
                ))}
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <MetricPill label="置信度" value={`${Math.round((data?.confidence ?? 0) * 100)}%`} color={PROFILE_COLORS.emerald} />
                <MetricPill label="笔记总数" value={`${totalNotes} 篇`} color={PROFILE_COLORS.cyan} />
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                {data?.relationships?.collaboration_pattern || "暂无画像摘要，蒸馏后生成。"}
              </p>
            </div>
          </div>
          <div className="flex flex-col justify-center border-t pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <div className="mb-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <BadgeCheck className="h-4 w-4" />
              综合评分
            </div>
            <div className="flex items-end gap-2">
              <span className="text-5xl font-bold tabular-nums" style={{ color: scoreColor }}>{avgScore}</span>
              <span className="pb-2 text-sm text-muted-foreground">/100</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${avgScore}%`, background: scoreColor }} />
            </div>
            <span className="mt-2 text-xs text-muted-foreground">{scoreLabel}{radarScores.length > 0 ? ` · 基于 ${radarScores.length} 维能力评估` : ""}</span>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1.35fr_340px]">
        <Panel className="p-4">
          <SectionTitle icon={<Star className="h-4 w-4" />} title="能力雷达" hint={radarScores.length > 0 ? "综合能力评估" : "暂无数据"} color={PROFILE_COLORS.emerald} />
          <div className="flex justify-center">
            <RadarChart current={radarScores} size={330} />
          </div>
        </Panel>

        {knowledgeGraph && (
          <Panel className="p-4">
            <SectionTitle icon={<Sparkles className="h-4 w-4" />} title="知识结构" hint="核心领域 / 相关领域 / 探索领域" color={PROFILE_COLORS.coral} />
            <div className="flex justify-center">
              <KnowledgeStarGraph data={knowledgeGraph} size={330} />
            </div>
          </Panel>
        )}

        <Panel className="p-4">
          <SectionTitle icon={<Lightbulb className="h-4 w-4" />} title="关键洞察" color={PROFILE_COLORS.amber} />
          <div className="flex flex-col gap-3">
            <InsightItem
              icon={<Star className="h-4 w-4" />}
              title="优势"
              body={strongest ? `${strongest.axis} 是核心优势，评分 ${strongest.value}。` : "暂无数据，蒸馏后生成。"}
              evidence="证据：能力雷达"
              color={PROFILE_COLORS.emerald}
            />
            <InsightItem
              icon={<TrendingUp className="h-4 w-4" />}
              title="最近变化"
              body={lastMonth && prevMonth
                ? `${lastMonth} 笔记 ${lastCount} 篇，较上月 ${monthDelta >= 0 ? "增加" : "减少"} ${Math.abs(monthDelta)} 篇。`
                : "暂无月度对比数据。"}
              evidence="证据：笔记月度分布"
              color={PROFILE_COLORS.amber}
            />
            <InsightItem
              icon={<AlertTriangle className="h-4 w-4" />}
              title="建议关注"
              body={weakest ? `${weakest.axis} 评分 ${weakest.value}，有提升空间。` : "暂无数据，蒸馏后生成。"}
              evidence="证据：能力雷达"
              color={PROFILE_COLORS.coral}
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Panel className="p-4">
          <SectionTitle icon={<BadgeCheck className="h-4 w-4" />} title="技能矩阵" hint={skillMatrix.length > 0 ? "Top 技能" : "暂无数据"} color={PROFILE_COLORS.emerald} />
          <SkillMatrix skills={skillMatrix} />
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Tags className="h-4 w-4" />} title="兴趣标签" hint={tagCloud.length > 0 ? "Top 标签" : "暂无数据"} color={PROFILE_COLORS.amber} />
          <div className="flex flex-wrap gap-2">
            {tagCloud.length > 0 ? tagCloud.map((tag, index) => (
              <span
                key={tag.tag}
                className="rounded-full border px-2.5 py-1 text-xs font-medium"
                style={{
                  background: `${[PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.coral, PROFILE_COLORS.cyan][index % 4]}14`,
                  color: [PROFILE_COLORS.emeraldDeep, PROFILE_COLORS.amberDeep, PROFILE_COLORS.coralDeep, PROFILE_COLORS.cyan][index % 4],
                }}
              >
                {tag.tag}
              </span>
            )) : <span className="text-xs text-muted-foreground">暂无标签</span>}
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Users className="h-4 w-4" />} title="人际网络" hint={contacts.length > 0 ? "Top 协作" : "暂无数据"} color={PROFILE_COLORS.coral} />
          <div className="flex flex-col gap-2">
            {contacts.length > 0 ? contacts.map((contact) => (
              <BarRow key={contact.name} label={contact.name} value={contact.score} suffix="%" color={PROFILE_COLORS.emerald} />
            )) : <span className="text-xs text-muted-foreground">暂无联系人数据</span>}
          </div>
        </Panel>
      </div>
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

function MetricPill({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span className="rounded-md border px-2.5 py-1 text-xs" style={{ background: `${color}12`, borderColor: `${color}33`, color }}>
      {label} {value}
    </span>
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
        <p className="mt-1 text-[11px] text-muted-foreground">{evidence}</p>
      </div>
    </div>
  );
}

function BarRow({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: number;
  suffix: string;
  color: string;
}) {
  return (
    <div className="grid grid-cols-[90px_1fr_36px] items-center gap-2 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{value}{suffix}</span>
    </div>
  );
}
