/** 人物画像 Tab：mock 总览看板。 */

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  Clock3,
  Lightbulb,
  Pencil,
  Sparkles,
  Star,
  Tags,
  TrendingUp,
  UserRound,
  Users,
  Wrench,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchUserMd, updateUserSection, type ProfileData,
} from "@/lib/profile-api";
import { cn } from "@/lib/utils";

import { ActivityHeatmap } from "./charts/Heatmap";
import { KnowledgeStarGraph } from "./charts/KnowledgeStarGraph";
import { RadarChart } from "./charts/RadarChart";
import { SkillMatrix } from "./charts/SkillMatrix";
import {
  CARD_BASE, CARD_HOVER, PROFILE_COLORS, scoreLevel,
} from "./profile-theme";

interface ProfileTabProps {
  data?: ProfileData;
  loading: boolean;
  hasData: boolean;
  onReload: () => void;
}

const MOCK_PROFILE: ProfileData = {
  identity: {
    primary_role: "产品经理",
    secondary_roles: ["产品运营", "数据分析师", "项目负责人"],
    timezone_hint: "Asia/Shanghai",
  },
  relationships: {
    frequent_contacts: ["Leo（设计）", "Sunny（运营）", "Wayne（开发）", "Yolanda（数据）", "Kevin（市场）"],
    collaboration_pattern: "跨团队推进，偏好用数据验证方案。",
  },
  work_rhythm: {
    active_hours: "09:00 - 12:00",
    intensity: "heavy",
  },
  confidence: 0.92,
  evidence: {
    note_distribution: [
      { notebook: "产品策略", count: 88 },
      { notebook: "用户研究", count: 85 },
      { notebook: "数据分析", count: 84 },
      { notebook: "项目管理", count: 83 },
      { notebook: "团队协作", count: 90 },
    ],
    tag_distribution: [
      { tag: "用户体验", count: 42 },
      { tag: "数据驱动", count: 36 },
      { tag: "产品设计", count: 32 },
      { tag: "增长", count: 24 },
      { tag: "AI 工具", count: 22 },
      { tag: "效率提升", count: 18 },
      { tag: "SaaS", count: 16 },
      { tag: "团队协作", count: 14 },
    ],
    top_senders: [
      { sender: "Leo", count: 28 },
      { sender: "Sunny", count: 24 },
      { sender: "Wayne", count: 19 },
      { sender: "Yolanda", count: 16 },
    ],
  },
  visualizations: {
    radar_scores: [
      { axis: "产品策略", key: "strategy", value: 88 },
      { axis: "用户洞察", key: "user", value: 85 },
      { axis: "数据分析", key: "data", value: 84 },
      { axis: "项目管理", key: "pm", value: 83 },
      { axis: "跨团队协作", key: "collab", value: 90 },
      { axis: "沟通表达", key: "comm", value: 86 },
      { axis: "问题解决", key: "solve", value: 89 },
      { axis: "创新思维", key: "creative", value: 81 },
    ],
    skill_matrix: [
      { area: "产品策略", level: 4, score: 88, note_count: 48 },
      { area: "用户研究", level: 4, score: 85, note_count: 42 },
      { area: "数据分析", level: 4, score: 84, note_count: 39 },
      { area: "项目管理", level: 4, score: 83, note_count: 35 },
      { area: "跨团队协作", level: 5, score: 90, note_count: 51 },
    ],
    knowledge_graph: {
      nodes: [
        { id: "user", label: "产品设计", group: 0, size: 34 },
        { id: "need", label: "需求分析", group: 1, size: 24 },
        { id: "data", label: "数据分析", group: 1, size: 20 },
        { id: "collab", label: "团队协作", group: 1, size: 20 },
        { id: "growth", label: "增长黑客", group: 1, size: 18 },
        { id: "research", label: "用户研究", group: 2, size: 16 },
        { id: "plan", label: "产品规划", group: 2, size: 16 },
        { id: "proto", label: "原型设计", group: 2, size: 16 },
        { id: "market", label: "市场洞察", group: 2, size: 16 },
        { id: "operation", label: "运营策略", group: 2, size: 16 },
      ],
      links: [
        { source: "user", target: "need", weight: 3 },
        { source: "user", target: "data", weight: 2 },
        { source: "user", target: "collab", weight: 2 },
        { source: "user", target: "growth", weight: 1 },
        { source: "need", target: "research", weight: 1 },
        { source: "need", target: "plan", weight: 1 },
        { source: "data", target: "market", weight: 1 },
        { source: "collab", target: "operation", weight: 1 },
        { source: "growth", target: "proto", weight: 1 },
      ],
    },
    tag_cloud: [
      { tag: "用户体验", count: 42 },
      { tag: "数据驱动", count: 36 },
      { tag: "产品设计", count: 32 },
      { tag: "增长", count: 24 },
      { tag: "AI 工具", count: 22 },
      { tag: "效率提升", count: 18 },
      { tag: "SaaS", count: 16 },
      { tag: "团队协作", count: 14 },
    ],
    knowledge_structure_bar: [
      { notebook: "产品策略", count: 88 },
      { notebook: "用户研究", count: 85 },
      { notebook: "数据分析", count: 84 },
      { notebook: "项目管理", count: 83 },
      { notebook: "团队协作", count: 90 },
    ],
  },
};

const MOCK_TOOLS = ["文档", "表格", "PPT", "Figma", "Notion", "流程图"];
const MOCK_TASKS = ["需求分析", "方案撰写", "数据分析", "产品规划", "项目跟进"];
const MOCK_HEATMAP = Array.from({ length: 7 }, (_, day) =>
  Array.from({ length: 24 }, (_, hour) => {
    const morning = hour >= 9 && hour <= 12 ? 8 : 0;
    const afternoon = hour >= 14 && hour <= 17 ? 5 : 0;
    const weekday = day < 5 ? 1 : 0.35;
    return Math.round((morning + afternoon + ((day + hour) % 3)) * weekday);
  }),
);

export function ProfileTab({
  data,
  loading,
  hasData,
  onReload,
}: ProfileTabProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = useCallback(async () => {
    setEditing(true);
    setEditError(null);
    try {
      const full = await fetchUserMd();
      const lines = full.split("\n");
      let inSection = false;
      const sectionLines: string[] = [];
      for (const line of lines) {
        if (/^##\s+/.test(line)) {
          if (inSection) break;
          if (/^##\s+Profile\s*$/.test(line)) inSection = true;
        } else if (inSection) sectionLines.push(line);
      }
      setDraft(sectionLines.join("\n").trim() || full);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setDraft("");
    setEditError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    setSaving(true);
    setEditError(null);
    try {
      await updateUserSection("Profile", draft);
      setEditing(false);
      onReload();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, onReload]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    );
  }

  const viewData = MOCK_PROFILE;
  const sourceNote = hasData && data ? "Mock 预览 - 已保留真实数据入口" : "Mock 数据";
  const identity = viewData.identity ?? {};
  const evidence = viewData.evidence ?? {};
  const viz = viewData.visualizations ?? {};
  const radarScores = viz.radar_scores ?? [];
  const skillMatrix = viz.skill_matrix ?? [];
  const knowledgeGraph = viz.knowledge_graph;
  const tagCloud = viz.tag_cloud ?? evidence.tag_distribution ?? [];
  const contacts = (viewData.relationships?.frequent_contacts ?? [])
    .map((name, index) => ({ name, score: 92 - index * 6 }))
    .slice(0, 5);
  const avgScore = Math.round(
    radarScores.reduce((sum, item) => sum + item.value, 0) / radarScores.length,
  );
  const { label: scoreLabel, color: scoreColor } = scoreLevel(avgScore);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-700">
          {sourceNote}
        </span>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void cancelEdit()} disabled={saving}>
                <X className="mr-1 h-3.5 w-3.5" />取消
              </Button>
              <Button variant="default" size="sm" className="h-7 text-xs" onClick={() => void saveEdit()} disabled={saving}>
                <Check className="mr-1 h-3.5 w-3.5" />{saving ? "保存中…" : "保存"}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void startEdit()}>
              <Pencil className="mr-1 h-3.5 w-3.5" />编辑画像
            </Button>
          )}
        </div>
      </div>

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
                  {identity.primary_role}
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
                <MetricPill label="置信度" value={`${Math.round((viewData.confidence ?? 0) * 100)}%`} color={PROFILE_COLORS.emerald} />
                <MetricPill label="新鲜度" value="2 小时前更新" color={PROFILE_COLORS.cyan} />
              </div>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                你擅长复杂问题结构化，推动跨团队协作与落地，并持续通过数据验证优化产品体验。
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
            <span className="mt-2 text-xs text-muted-foreground">{scoreLabel} · 超过 86% 的同类用户</span>
          </div>
        </div>
      </Panel>

      {editing && (
        <Panel className="flex flex-col gap-2 p-4">
          <p className="text-xs text-muted-foreground">编辑 USER.md 的 Profile 段落（Markdown 格式）</p>
          {editError && <p className="text-xs text-destructive">{editError}</p>}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[260px] font-mono text-[13px]"
            disabled={saving}
          />
        </Panel>
      )}

      <div className={cn("grid grid-cols-1 gap-3 xl:grid-cols-[1.1fr_1.35fr_340px]", editing && "pointer-events-none opacity-40")}>
        <Panel className="p-4">
          <SectionTitle icon={<Star className="h-4 w-4" />} title="能力雷达" hint="你的能力 vs 同岗均值" color={PROFILE_COLORS.emerald} />
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
              body="结构化思维与跨团队协作是核心优势，能高效推动复杂项目落地。"
              evidence="证据：能力雷达、任务完成质量"
              color={PROFILE_COLORS.emerald}
            />
            <InsightItem
              icon={<TrendingUp className="h-4 w-4" />}
              title="最近变化"
              body="数据分析和商业分析活跃度提升明显，知识结构更均衡。"
              evidence="证据：技能矩阵、知识结构"
              color={PROFILE_COLORS.amber}
            />
            <InsightItem
              icon={<Clock3 className="h-4 w-4" />}
              title="工作习惯"
              body="上午专注度最高，偏好深度工作，周三输出最多。"
              evidence="证据：工作节奏、任务分布"
              color={PROFILE_COLORS.cyan}
            />
            <InsightItem
              icon={<AlertTriangle className="h-4 w-4" />}
              title="建议关注"
              body="原型设计与用户洞察仍有提升空间，建议加强用户访谈与验证。"
              evidence="证据：能力雷达、笔记记录"
              color={PROFILE_COLORS.coral}
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Panel className="p-4">
          <SectionTitle icon={<BadgeCheck className="h-4 w-4" />} title="技能矩阵" hint="Top 技能" color={PROFILE_COLORS.emerald} />
          <SkillMatrix skills={skillMatrix} />
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Tags className="h-4 w-4" />} title="兴趣标签" hint="Top 标签" color={PROFILE_COLORS.amber} />
          <div className="flex flex-wrap gap-2">
            {tagCloud.map((tag, index) => (
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
            ))}
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Clock3 className="h-4 w-4" />} title="工作节奏" hint="近 4 周" color={PROFILE_COLORS.cyan} />
          <div className="scale-[0.82] origin-top-left">
            <ActivityHeatmap data={MOCK_HEATMAP} />
          </div>
        </Panel>
        <Panel className="p-4">
          <SectionTitle icon={<Users className="h-4 w-4" />} title="人际网络" hint="Top 协作" color={PROFILE_COLORS.coral} />
          <div className="flex flex-col gap-2">
            {contacts.map((contact) => (
              <BarRow key={contact.name} label={contact.name} value={contact.score} suffix="%" color={PROFILE_COLORS.emerald} />
            ))}
          </div>
        </Panel>
      </div>

      <Panel className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_1fr_260px]">
        <div className="flex min-w-0 items-center gap-3">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <span className="shrink-0 text-sm font-medium">常用工具</span>
          <div className="flex min-w-0 flex-wrap gap-2">
            {MOCK_TOOLS.map((tool) => (
              <span key={tool} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">{tool}</span>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="shrink-0 text-sm font-medium">高频任务</span>
          <div className="flex min-w-0 flex-wrap gap-2">
            {MOCK_TASKS.map((task) => (
              <span key={task} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">{task}</span>
            ))}
          </div>
        </div>
        <div className="border-t pt-3 text-sm lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <span className="text-muted-foreground">本月工作聚焦</span>
          <p className="mt-1 font-medium">用户增长 · 数据验证 · 产品迭代</p>
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
