import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SubsectionLabel } from "@/components/ui/page-header";
import {
  getSkillLifecycleConfig,
  updateSkillLifecycleConfig,
  type SkillLifecycleConfig,
} from "@/lib/api";
import { useClientOptional } from "@/providers/ClientProvider";

export function SkillManagementPanel() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const { token } = useClientOptional();
  const [config, setConfig] = useState<SkillLifecycleConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveDaysDraft, setArchiveDaysDraft] = useState<string | null>(null);
  const [maxActiveDraft, setMaxActiveDraft] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      setConfig(await getSkillLifecycleConfig(token));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateConfig = async (patch: Partial<SkillLifecycleConfig>) => {
    if (!token || saving) return;
    setSaving(true);
    try {
      await updateSkillLifecycleConfig(token, patch);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const commitNumber = (
    draft: string | null,
    current: number | undefined,
    apply: (value: number) => void,
    clear: () => void,
  ) => {
    if (draft === null) return;
    clear();
    const value = Number(draft);
    if (Number.isFinite(value) && value >= 1 && value !== current) apply(value);
  };

  if (!token) {
    return <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-body text-muted-foreground">需要登录后才能管理自进化策略。</div>;
  }

  if (loading) {
    return <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-body text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{tx("settings.status.loading", "Loading…")}</div>;
  }

  return (
    <div className="space-y-6">
      {error ? <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="flex-1 break-words">{error}</span><Button type="button" variant="ghost" size="icon" onClick={() => setError(null)} className="h-5 w-5 text-destructive/70 hover:bg-transparent hover:text-destructive">×</Button></div> : null}

      <section className="rounded-lg border border-info/25 bg-info/5 px-4 py-3">
        <h2 className="text-ui font-medium text-foreground">全局自进化策略</h2>
        <p className="mt-1 text-caption leading-5 text-muted-foreground">这里的配置适用于所有 Agent，但每个 Agent 的记忆、技能、使用统计、置顶和归档状态完全隔离。具体技能请进入对应 Agent 的“技能”页面管理。</p>
        <dl className="mt-3 grid gap-2 text-caption sm:grid-cols-2">
          <div><dt className="text-muted-foreground">策略作用域</dt><dd className="mt-0.5 text-foreground">所有 Agent</dd></div>
          <div><dt className="text-muted-foreground">数据作用域</dt><dd className="mt-0.5 text-foreground">每个 Agent 独立</dd></div>
        </dl>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">自进化与生命周期</SubsectionLabel>
        <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
          <div className="divide-y divide-border/50">
            <SettingRow title="Dream 执行计划" description="每个 Agent 按同一计划独立整理自己的记忆与技能。"><span className="text-caption text-muted-foreground">{config?.dreamSchedule ?? "每 2 小时"}</span></SettingRow>
            <SettingRow title="自动归档" description="仅归档各 Agent 自己长期未使用的自我学习技能。"><Checkbox checked={config?.skillPruneEnabled ?? false} onCheckedChange={(value) => { if (typeof value === "boolean") void updateConfig({ skillPruneEnabled: value }); }} disabled={saving} /></SettingRow>
            <SettingRow title="归档阈值（天）" description="每个 Agent 分别计算技能的最后访问时间。"><Input type="number" min={1} value={archiveDaysDraft ?? String(config?.archiveAfterDays ?? 90)} className="h-8 w-24 rounded-full text-ui" onChange={(event) => setArchiveDaysDraft(event.target.value)} onBlur={() => commitNumber(archiveDaysDraft, config?.archiveAfterDays, (value) => void updateConfig({ archiveAfterDays: value }), () => setArchiveDaysDraft(null))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} disabled={saving} /></SettingRow>
            <SettingRow title="每个 Agent 的容量上限" description="达到上限后，只阻止该 Agent 创建新技能，不影响其他 Agent。"><Input type="number" min={1} value={maxActiveDraft ?? String(config?.maxActiveUserSkills ?? 100)} className="h-8 w-24 rounded-full text-ui" onChange={(event) => setMaxActiveDraft(event.target.value)} onBlur={() => commitNumber(maxActiveDraft, config?.maxActiveUserSkills, (value) => void updateConfig({ maxActiveUserSkills: value }), () => setMaxActiveDraft(null))} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} disabled={saving} /></SettingRow>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="flex items-center gap-4 px-4 py-3.5 sm:px-5"><div className="min-w-0 flex-1"><div className="text-ui font-medium text-foreground">{title}</div><div className="mt-0.5 text-caption leading-5 text-muted-foreground">{description}</div></div><div className="shrink-0">{children}</div></div>;
}
