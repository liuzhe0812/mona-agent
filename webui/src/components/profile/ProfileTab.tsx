/** 人物画像 Tab：话题投入与关系总览看板（真实后端数据，可追溯到原始计数）。 */

import { useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Lightbulb,
  MessageSquareText,
  Sparkles,
  Star,
  Tags,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  type PainPoint,
  type ProfileData,
} from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { KnowledgeStarGraph } from "./charts/KnowledgeStarGraph";
import { RadarChart } from "./charts/RadarChart";
import { SkillMatrix } from "./charts/SkillMatrix";
import {
  CARD_BASE, CARD_HOVER, PROFILE_COLORS,
} from "./profile-theme";

interface ProfileTabProps {
  data?: ProfileData;
  loading: boolean;
  /** 带着上下文提示词开启一个 Mona 会话（行动出口）。 */
  onAskMona?: (prompt: string) => void;
}

export function ProfileTab({
  data,
  loading,
  onAskMona,
}: ProfileTabProps) {
  const [painOpen, setPainOpen] = useState(true);
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-body text-muted-foreground">
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
  const painPoints = data?.pain_points ?? [];
  const openQuestions = data?.open_questions ?? [];

  // 人际网络：真实邮件数（后端已过滤自己的邮箱）；frequent_contacts 无计数时只列名字
  const topSenders = evidence.top_senders ?? [];
  const maxCount = Math.max(1, ...topSenders.map((s) => s.count ?? 0));
  const contacts = topSenders.length > 0
    ? topSenders.slice(0, 5).map((s, i) => ({
        name: s.sender ?? s.address ?? `联系人 ${i + 1}`,
        count: s.count ?? 0,
        // 条形宽度按最大值归一，展示值是真实计数
        ratio: Math.round(((s.count ?? 0) / maxCount) * 100),
      }))
    : (data?.relationships?.frequent_contacts ?? []).slice(0, 5).map((name) => ({
        name,
        count: null as number | null,
        ratio: null as number | null,
      }));

  // 记录活跃月数（真实计数，替代原来的"综合评分"）
  const monthly = evidence.notes_monthly ?? {};
  const monthKeys = Object.keys(monthly).sort();
  const activeMonths = monthKeys.length;

  // 关键洞察：数据驱动生成
  const sortedRadar = [...radarScores].sort((a, b) => b.value - a.value);
  const strongest = sortedRadar[0];
  const weakest = sortedRadar[sortedRadar.length - 1];

  // 笔记月度趋势（最近两个月对比）
  const lastMonth = monthKeys[monthKeys.length - 1];
  const prevMonth = monthKeys[monthKeys.length - 2];
  const lastCount = lastMonth ? monthly[lastMonth] : 0;
  const prevCount = prevMonth ? monthly[prevMonth] : 0;
  const monthDelta = lastCount - prevCount;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <Panel className="border-info/20 bg-info/[0.025] p-5">
        <div className="grid gap-5 lg:grid-cols-[1fr_220px]">
          <div className="flex min-w-0 items-center gap-4">
            <div
              className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-info/20 bg-info/[0.08] text-info"
            >
              <UserRound className="h-8 w-8" />
              <span className="absolute right-2 top-2 h-3 w-3 rounded-full border-2 border-background bg-success-indicator" />
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="truncate text-title tracking-tight">
                  {identity.primary_role || "尚未确定角色"}
                </h2>
                <span className="rounded-full border border-info/25 bg-info/[0.07] px-2 py-0.5 text-caption font-medium text-info">
                  主角色
                </span>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(identity.secondary_roles ?? []).map((role) => (
                  <span key={role} className="rounded-full bg-muted/70 px-2.5 py-1 text-caption text-muted-foreground">
                    {role}
                  </span>
                ))}
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <MetricPill label="置信度" value={`${Math.round((data?.confidence ?? 0) * 100)}%`} color={PROFILE_COLORS.emerald} />
                <MetricPill label="笔记总数" value={`${totalNotes} 篇`} color={PROFILE_COLORS.cyan} />
              </div>
              <p className="max-w-3xl text-body leading-6 text-muted-foreground">
                {data?.relationships?.collaboration_pattern || "暂无画像摘要，蒸馏后生成。"}
              </p>
            </div>
          </div>
          <div className="flex flex-col justify-center border-t pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
            <div className="mb-1 flex items-center gap-1.5 text-body text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              记录活跃月数
            </div>
            <div className="flex items-end gap-2">
              <span className="text-display-sm font-semibold tabular-nums" style={{ color: PROFILE_COLORS.emerald }}>{activeMonths}</span>
              <span className="pb-1 text-body text-muted-foreground">个月</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (activeMonths / 12) * 100)}%`, background: PROFILE_COLORS.emerald }} />
            </div>
            <span className="mt-2 text-caption text-muted-foreground">有笔记记录的月份 · 共 {totalNotes} 篇</span>
          </div>
        </div>
      </Panel>

      {(painPoints.length > 0 || openQuestions.length > 0) && (
        <Panel className="p-4">
          <button
            type="button"
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-md px-1 text-left transition-colors hover:bg-accent",
              painOpen && "mb-3",
            )}
            onClick={() => setPainOpen((v) => !v)}
            aria-expanded={painOpen}
          >
            <h3 className="flex items-center gap-1.5 text-body font-semibold">
              <span style={{ color: PROFILE_COLORS.coral }}>
                <AlertTriangle className="h-4 w-4" />
              </span>
              近期痛点与开放问题
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {painPoints.length + openQuestions.length}
              </span>
            </h3>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="truncate text-caption">由蒸馏从对话中提炼</span>
              {painOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </button>
          {painOpen && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {painPoints.map((p) => (
                <PainPointCard key={p.topic} point={p} onAskMona={onAskMona} />
              ))}
              {openQuestions.map((q) => (
                <div key={q} className="flex gap-3 rounded-lg border bg-background/60 p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `${PROFILE_COLORS.cyan}18`, color: PROFILE_COLORS.cyan }}>
                    <CircleHelp className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-caption leading-5 text-foreground">{q}</p>
                    {onAskMona && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="mt-2 h-auto gap-1 rounded-full px-2 py-0.5 text-micro"
                        style={{ color: PROFILE_COLORS.cyan }}
                        onClick={() => onAskMona(`我正在探索这个问题：${q}。请结合你的工作记忆，帮我分析一下现状和可能的解法。`)}
                      >
                        <MessageSquareText className="h-3 w-3" />
                        和 Mona 探讨
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1.35fr_340px]">
        <Panel className="p-4">
          <SectionTitle icon={<Star className="h-4 w-4" />} title="话题投入分布" hint={radarScores.length > 0 ? "基于笔记/行为信号的绝对投入度" : "暂无数据"} color={PROFILE_COLORS.emerald} />
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
              title="投入最多"
              body={strongest ? `${strongest.axis} 相关话题投入度最高（信号量 ${Math.round(strongest.raw_signal ?? 0)}）。` : "暂无数据，蒸馏后生成。"}
              evidence="证据：话题投入分布"
              color={PROFILE_COLORS.emerald}
              onAskMona={strongest && onAskMona
                ? () => onAskMona(`我的话题投入分布显示「${strongest.axis}」投入最多。请结合你对我工作的了解，帮我分析这个投入是否合理、有没有可以提效的方向。`)
                : undefined}
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
              title="投入最少"
              body={weakest ? `${weakest.axis} 相关话题投入度最低（信号量 ${Math.round(weakest.raw_signal ?? 0)}）。` : "暂无数据，蒸馏后生成。"}
              evidence="证据：话题投入分布"
              color={PROFILE_COLORS.coral}
              onAskMona={weakest && onAskMona
                ? () => onAskMona(`我的话题投入分布显示「${weakest.axis}」投入最少。这是有意的取舍还是盲区？请结合你对我近期工作的了解给出判断。`)
                : undefined}
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
                className="rounded-full border px-2.5 py-1 text-caption font-medium"
                style={{
                  background: `${[PROFILE_COLORS.emerald, PROFILE_COLORS.amber, PROFILE_COLORS.coral, PROFILE_COLORS.cyan][index % 4]}14`,
                  color: [PROFILE_COLORS.emeraldDeep, PROFILE_COLORS.amberDeep, PROFILE_COLORS.coralDeep, PROFILE_COLORS.cyan][index % 4],
                }}
              >
                {tag.tag}
              </span>
            )) : <span className="text-caption text-muted-foreground">暂无标签</span>}
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Users className="h-4 w-4" />} title="人际网络" hint={contacts.length > 0 ? "按邮件数排序" : "暂无数据"} color={PROFILE_COLORS.coral} />
          <div className="flex flex-col gap-2">
            {contacts.length > 0 ? contacts.map((contact) => (
              <BarRow
                key={contact.name}
                label={contact.name}
                ratio={contact.ratio}
                value={contact.count !== null ? `${contact.count} 封` : ""}
                color={PROFILE_COLORS.emerald}
              />
            )) : <span className="text-caption text-muted-foreground">暂无联系人数据</span>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function PainPointCard({
  point,
  onAskMona,
}: {
  point: PainPoint;
  onAskMona?: (prompt: string) => void;
}) {
  return (
    <div className="flex gap-3 rounded-lg border bg-background/60 p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `${PROFILE_COLORS.coral}18`, color: PROFILE_COLORS.coralDeep }}>
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold" style={{ color: PROFILE_COLORS.coralDeep }}>{point.topic}</p>
        {point.detail && <p className="mt-1 text-caption leading-5 text-foreground">{point.detail}</p>}
        <div className="mt-2 flex items-center gap-2">
          {point.last_seen && (
            <span className="rounded-full px-2 py-0.5 text-micro" style={{ background: `${PROFILE_COLORS.coral}12`, color: PROFILE_COLORS.coralDeep }}>
              最近信号 {point.last_seen}
            </span>
          )}
          {onAskMona && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-auto gap-1 rounded-full px-2 py-0.5 text-micro"
              style={{ color: PROFILE_COLORS.coralDeep }}
              onClick={() => onAskMona(`我最近反复被这个问题困扰：${point.topic}${point.detail ? `（${point.detail}）` : ""}。请结合你的工作记忆，帮我梳理思路并给出可执行的下一步建议。`)}
            >
              <MessageSquareText className="h-3 w-3" />
              和 Mona 聊聊
            </Button>
          )}
        </div>
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
    <div className={cn(CARD_BASE, CARD_HOVER, "profile-card", className)}>
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
      <h3 className="flex items-center gap-1.5 text-body font-semibold">
        <span style={{ color }}>{icon}</span>
        {title}
      </h3>
      {hint && <span className="truncate text-caption text-muted-foreground">{hint}</span>}
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
    <span className="rounded-md border px-2.5 py-1 text-caption" style={{ background: `${color}12`, borderColor: `${color}33`, color }}>
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
  onAskMona,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  evidence: string;
  color: string;
  onAskMona?: () => void;
}) {
  return (
    <div className="flex gap-3 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: `${color}18`, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-body font-semibold" style={{ color }}>{title}</p>
        <p className="mt-1 text-caption leading-5 text-foreground">{body}</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-micro text-muted-foreground">{evidence}</span>
          {onAskMona && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-auto gap-1 rounded-full px-1.5 py-0.5 text-micro"
              style={{ color }}
              onClick={onAskMona}
            >
              <MessageSquareText className="h-3 w-3" />
              和 Mona 聊聊
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function BarRow({
  label,
  ratio,
  value,
  color,
}: {
  label: string;
  /** 条形宽度（0-100），null 表示无计数仅列名 */
  ratio: number | null;
  /** 右侧展示文本（真实计数） */
  value: string;
  color: string;
}) {
  return (
    <div className="grid grid-cols-[90px_1fr_52px] items-center gap-2 text-caption">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        {ratio !== null && (
          <div className="h-full rounded-full" style={{ width: `${ratio}%`, background: color }} />
        )}
      </div>
      <span className="text-right tabular-nums text-muted-foreground">{value}</span>
    </div>
  );
}
