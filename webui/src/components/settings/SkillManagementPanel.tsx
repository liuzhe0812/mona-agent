import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Hourglass,
  Loader2,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useClientOptional } from "@/providers/ClientProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  archiveSkill,
  getSkillLifecycleConfig,
  listSkills,
  pruneSkills,
  restoreSkill,
  setSkillPinned,
  updateSkillLifecycleConfig,
  type SkillLifecycleConfig,
  type SkillUsageRow,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type SortKey = "recent" | "name" | "access";

function fmtShort(value: string | null): string {
  if (!value) return "—";
  try {
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return value;
    return dt.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function relativeDays(value: string | null): string {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  const diffMs = Date.now() - dt.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

function provenanceLabel(p: SkillUsageRow["provenance"]): string {
  if (p === "agent") return "自进化";
  if (p === "bundled") return "内置";
  return "用户";
}

export function SkillManagementPanel() {
  const { t } = useTranslation();
  const tx = (
    key: string,
    fallback: string,
    options?: Record<string, unknown>,
  ) => t(key, { defaultValue: fallback, ...(options ?? {}) });
  const { token } = useClientOptional();

  const [skills, setSkills] = useState<SkillUsageRow[]>([]);
  const [config, setConfig] = useState<SkillLifecycleConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [showArchived, setShowArchived] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [prunePreview, setPrunePreview] = useState<string[] | null>(null);
  const [pruneMsg, setPruneMsg] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  // 数字配置输入草稿：输入过程不触发保存，blur/Enter 时校验提交
  const [archiveDaysDraft, setArchiveDaysDraft] = useState<string | null>(null);
  const [maxActiveDraft, setMaxActiveDraft] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    setError(null);
    try {
      const [listRes, cfg] = await Promise.all([
        listSkills(token),
        getSkillLifecycleConfig(token),
      ]);
      setSkills(listRes.skills);
      setConfig(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    let rows = skills;
    if (!showArchived) rows = rows.filter((r) => r.location === "active");
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    const sorted = [...rows];
    if (sort === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "access") {
      sorted.sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0));
    } else {
      sorted.sort((a, b) => {
        const ta = a.last_accessed_at ? Date.parse(a.last_accessed_at) : 0;
        const tb = b.last_accessed_at ? Date.parse(b.last_accessed_at) : 0;
        return tb - ta;
      });
    }
    return sorted;
  }, [skills, showArchived, query, sort]);

  const activeCount = useMemo(
    () => skills.filter((r) => r.location === "active").length,
    [skills],
  );
  const archivedCount = useMemo(
    () => skills.filter((r) => r.location === "archived").length,
    [skills],
  );
  const agentActiveCount = useMemo(
    () =>
      skills.filter(
        (r) => r.location === "active" && r.provenance === "agent",
      ).length,
    [skills],
  );

  const handlePin = async (row: SkillUsageRow) => {
    if (!token || busyName) return;
    setBusyName(row.name);
    try {
      await setSkillPinned(token, row.name, !row.pinned);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const handleArchive = async (row: SkillUsageRow) => {
    if (!token || busyName) return;
    setBusyName(row.name);
    try {
      await archiveSkill(token, row.name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const handleRestore = async (row: SkillUsageRow) => {
    if (!token || busyName) return;
    setBusyName(row.name);
    try {
      await restoreSkill(token, row.name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  const handlePrunePreview = async () => {
    if (!token || pruning) return;
    setPruning(true);
    setPruneMsg(null);
    try {
      const res = await pruneSkills(token, { apply: false });
      setPrunePreview(res.candidates);
      if (res.candidates.length === 0) {
        setPruneMsg(tx("settings.skill.prune.empty", "当前没有闲置 skill 需要归档。"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPruning(false);
    }
  };

  const handlePruneApply = async () => {
    if (!token || pruning || !prunePreview || prunePreview.length === 0) return;
    setPruning(true);
    setPruneMsg(null);
    try {
      const res = await pruneSkills(token, { apply: true });
      const failed = res.archived.filter((r) => !r.ok);
      if (failed.length === 0) {
        setPruneMsg(
          tx("settings.skill.prune.applied", "已归档 {{n}} 个 skill。", {
            n: res.archived.length,
          }),
        );
      } else {
        setPruneMsg(
          tx("settings.skill.prune.partial", "归档 {{ok}} 个，失败 {{fail}} 个。", {
            ok: res.archived.length - failed.length,
            fail: failed.length,
          }),
        );
      }
      setPrunePreview(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPruning(false);
    }
  };

  const handleUpdateConfig = async (patch: Partial<SkillLifecycleConfig>) => {
    if (!token || savingConfig) return;
    setSavingConfig(true);
    setError(null);
    try {
      const update: Record<string, unknown> = {};
      if (patch.skillPruneEnabled !== undefined) {
        update.skillPruneEnabled = patch.skillPruneEnabled;
      }
      if (patch.archiveAfterDays !== undefined) {
        update.archiveAfterDays = patch.archiveAfterDays;
      }
      if (patch.maxActiveUserSkills !== undefined) {
        update.maxActiveUserSkills = patch.maxActiveUserSkills;
      }
      await updateSkillLifecycleConfig(token, update);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingConfig(false);
    }
  };

  // blur/Enter 时提交数字配置：仅当值合法且发生变化才发请求
  const commitNumberConfig = (
    draft: string | null,
    current: number | undefined,
    apply: (v: number) => void,
    clearDraft: () => void,
  ) => {
    if (draft === null) return;
    clearDraft();
    const v = Number(draft);
    if (!Number.isFinite(v) || v < 1 || v === current) return;
    apply(v);
  };

  if (!token) {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-sm">
        {tx("settings.skill.unavailable", "需要登录后才能管理 skill。")}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-sm">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading…")}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-destructive/70 hover:text-destructive"
          >
            ×
          </button>
        </div>
      ) : null}

      <section>
        <SectionTitle>{tx("settings.skill.overview.title", "概览")}</SectionTitle>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard
            label={tx("settings.skill.overview.active", "活跃 skill")}
            value={activeCount}
            hint={tx("settings.skill.overview.active.hint", "包含内置与用户")}
          />
          <StatCard
            label={tx("settings.skill.overview.agent", "自进化活跃")}
            value={agentActiveCount}
            hint={tx("settings.skill.overview.agent.hint", "Dream 创建")}
          />
          <StatCard
            label={tx("settings.skill.overview.archived", "已归档")}
            value={archivedCount}
            hint={tx("settings.skill.overview.archived.hint", "可恢复")}
          />
          <StatCard
            label={tx("settings.skill.overview.cap", "容量上限")}
            value={config?.maxActiveUserSkills ?? "—"}
            hint={tx("settings.skill.overview.cap.hint", "硬上限")}
          />
        </div>
      </section>

      <section>
        <SectionTitle>{tx("settings.skill.config.title", "生命周期配置")}</SectionTitle>
        <SettingsGroup>
          <Row>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {tx("settings.skill.config.autoArchive", "自动归档")}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {tx(
                  "settings.skill.config.autoArchive.desc",
                  "Dream 每 2 小时扫描一次，将超过阈值的自进化 skill 移入归档。默认关闭，建议先 dry-run 观察。",
                )}
              </div>
            </div>
            <Checkbox
              checked={config?.skillPruneEnabled ?? false}
              onCheckedChange={(v) => {
                if (typeof v === "boolean") {
                  void handleUpdateConfig({ skillPruneEnabled: v });
                }
              }}
              disabled={savingConfig}
            />
          </Row>
          <Row>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {tx("settings.skill.config.archiveAfterDays", "归档阈值（天）")}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {tx(
                  "settings.skill.config.archiveAfterDays.desc",
                  "自进化 skill 在此天数未被访问时进入归档候选。",
                )}
              </div>
            </div>
            <Input
              type="number"
              min={1}
              value={archiveDaysDraft ?? String(config?.archiveAfterDays ?? 90)}
              className="h-8 w-24 rounded-full text-[13px]"
              onChange={(e) => setArchiveDaysDraft(e.target.value)}
              onBlur={() =>
                commitNumberConfig(
                  archiveDaysDraft,
                  config?.archiveAfterDays,
                  (v) => void handleUpdateConfig({ archiveAfterDays: v }),
                  () => setArchiveDaysDraft(null),
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={savingConfig}
            />
          </Row>
          <Row>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {tx("settings.skill.config.maxActive", "容量上限")}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {tx(
                  "settings.skill.config.maxActive.desc",
                  "活跃用户 skill 数量上限。达到后 Dream 拒绝创建新 skill。",
                )}
              </div>
            </div>
            <Input
              type="number"
              min={1}
              value={maxActiveDraft ?? String(config?.maxActiveUserSkills ?? 100)}
              className="h-8 w-24 rounded-full text-[13px]"
              onChange={(e) => setMaxActiveDraft(e.target.value)}
              onBlur={() =>
                commitNumberConfig(
                  maxActiveDraft,
                  config?.maxActiveUserSkills,
                  (v) => void handleUpdateConfig({ maxActiveUserSkills: v }),
                  () => setMaxActiveDraft(null),
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={savingConfig}
            />
          </Row>
        </SettingsGroup>
      </section>

      <section>
        <SectionTitle>{tx("settings.skill.prune.title", "归档工具")}</SectionTitle>
        <SettingsGroup>
          <Row>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {tx("settings.skill.prune.dryRun", "扫描闲置 skill")}
              </div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {tx(
                  "settings.skill.prune.dryRun.desc",
                  "按当前阈值列出归档候选，不实际执行。",
                )}
              </div>
              {prunePreview ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {prunePreview.length === 0 ? (
                    <span className="text-[12px] text-muted-foreground">
                      {tx("settings.skill.prune.empty", "无候选")}
                    </span>
                  ) : (
                    prunePreview.map((n) => (
                      <span
                        key={n}
                        className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {n}
                      </span>
                    ))
                  )}
                </div>
              ) : null}
              {pruneMsg ? (
                <div className="mt-2 text-[12px] text-emerald-600 dark:text-emerald-400">
                  {pruneMsg}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handlePrunePreview()}
                disabled={pruning}
              >
                {pruning ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="mr-1.5 h-3.5 w-3.5" />
                )}
                {tx("settings.skill.prune.scan", "扫描")}
              </Button>
              <Button
                size="sm"
                onClick={() => void handlePruneApply()}
                disabled={
                  pruning || !prunePreview || prunePreview.length === 0
                }
              >
                <Archive className="mr-1.5 h-3.5 w-3.5" />
                {tx("settings.skill.prune.apply", "执行归档")}
              </Button>
            </div>
          </Row>
        </SettingsGroup>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <SectionTitle className="mb-0">
            {tx("settings.skill.list.title", "Skill 列表")}
          </SectionTitle>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {tx("settings.skill.list.refresh", "刷新")}
            </Button>
          </div>
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx("settings.skill.list.search", "按名称搜索…")}
            className="h-8 w-56 rounded-full text-[13px]"
          />
          <SortMenu sort={sort} onChange={setSort} tx={tx} />
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Checkbox
              checked={showArchived}
              onCheckedChange={(v) => setShowArchived(v === true)}
            />
            {tx("settings.skill.list.showArchived", "显示已归档")}
          </label>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-border/45 bg-card/75 px-4 py-8 text-center text-[12px] text-muted-foreground shadow-sm">
            {tx("settings.skill.list.empty", "没有匹配的 skill。")}
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/45 bg-card/86 shadow-sm backdrop-blur-xl dark:border-white/10">
            <div className="divide-y divide-border/45">
              {filtered.map((row) => (
                <SkillRow
                  key={`${row.name}-${row.location}`}
                  row={row}
                  busy={busyName === row.name}
                  onPin={() => void handlePin(row)}
                  onArchive={() => void handleArchive(row)}
                  onRestore={() => void handleRestore(row)}
                  tx={tx}
                />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn(
        "mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85",
        className,
      )}
    >
      {children}
    </h2>
  );
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/45 bg-card/86 shadow-sm backdrop-blur-xl dark:border-white/10">
      <div className="divide-y divide-border/45">{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full items-center gap-3 px-4 py-3.5 sm:px-5">
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/45 bg-card/86 px-3 py-3 shadow-sm backdrop-blur-xl dark:border-white/10">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-[20px] font-semibold leading-none text-foreground">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-[11px] text-muted-foreground/80">{hint}</div>
      ) : null}
    </div>
  );
}

function SortMenu({
  sort,
  onChange,
  tx,
}: {
  sort: SortKey;
  onChange: (k: SortKey) => void;
  tx: (key: string, fallback: string, options?: Record<string, unknown>) => string;
}) {
  const options: { key: SortKey; label: string }[] = [
    { key: "recent", label: tx("settings.skill.sort.recent", "最近访问") },
    { key: "access", label: tx("settings.skill.sort.access", "访问次数") },
    { key: "name", label: tx("settings.skill.sort.name", "名称") },
  ];
  return (
    <div className="flex items-center gap-1 rounded-full border border-border/45 bg-card/60 p-0.5 text-[12px]">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => onChange(opt.key)}
          className={cn(
            "rounded-full px-2.5 py-1 transition-colors",
            sort === opt.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SkillRow({
  row,
  busy,
  onPin,
  onArchive,
  onRestore,
  tx,
}: {
  row: SkillUsageRow;
  busy: boolean;
  onPin: () => void;
  onArchive: () => void;
  onRestore: () => void;
  tx: (key: string, fallback: string, options?: Record<string, unknown>) => string;
}) {
  const provStyle =
    row.provenance === "agent"
      ? "bg-primary/10 text-primary"
      : row.provenance === "bundled"
        ? "bg-muted text-muted-foreground"
        : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {row.name}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
              provStyle,
            )}
          >
            {provenanceLabel(row.provenance)}
          </span>
          {row.pinned ? (
            <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <Pin className="h-2.5 w-2.5" />
              {tx("settings.skill.row.pinned", "置顶")}
            </span>
          ) : null}
          {row.location === "archived" ? (
            <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Hourglass className="h-2.5 w-2.5" />
              {tx("settings.skill.row.archived", "已归档")}
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            {tx("settings.skill.row.access", "访问")}
            <span className="ml-1 text-foreground/80">{row.access_count}</span>
          </span>
          <span>
            {tx("settings.skill.row.lastAccess", "最近")}
            <span className="ml-1 text-foreground/80">
              {relativeDays(row.last_accessed_at)}
            </span>
          </span>
          <span className="hidden sm:inline">
            {tx("settings.skill.row.created", "创建")}
            <span className="ml-1 text-foreground/80">
              {fmtShort(row.created_at)}
            </span>
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={onPin}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : row.pinned ? (
                  <PinOff className="h-3.5 w-3.5" />
                ) : (
                  <Pin className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {row.pinned
                ? tx("settings.skill.row.unpin", "取消置顶")
                : tx("settings.skill.row.pin", "置顶（永不被自动归档）")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {row.location === "active" ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onArchive}
                  disabled={busy}
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tx("settings.skill.row.archive", "归档（可恢复）")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={onRestore}
                  disabled={busy}
                >
                  <ArchiveRestore className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {tx("settings.skill.row.restore", "恢复")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}
