import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  FileCog,
  Filter,
  Gamepad2,
  Loader2,
  LayoutGrid,
  LockKeyhole,
  MonitorCog,
  Palette,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import {
  applyConfigurationItem,
  getConfigurationAudit,
  type ConfigurationAudit,
  type ConfigurationAuditItem,
  type ConfigurationGroup,
  type ConfigurationRisk,
  type ConfigurationStatus,
} from "./systemOptimizationApi";
import { fallbackCategories, featureImpact, featureTitle, groupTitle, optionLabel } from "./systemOptimizationCatalog";
import { MetricCard, StatusPill, secondaryButtonClass } from "./SystemUi";

const categoryIcons: Record<string, typeof ShieldCheck> = {
  "隐私与建议内容": ShieldCheck,
  系统: MonitorCog,
  "开始菜单与搜索": LayoutGrid,
  "AI 功能": Sparkles,
  "Windows 更新": RefreshCw,
  任务栏: SlidersHorizontal,
  外观: Palette,
  文件资源管理器: FileCog,
  游戏: Gamepad2,
  多任务: MonitorCog,
  "可选 Windows 功能": WandSparkles,
  其他: CircleHelp,
};

const statusMeta: Record<ConfigurationStatus, { label: string; tone: "green" | "blue" | "orange" | "red" | "neutral" }> = {
  configured: { label: "已生效", tone: "green" },
  available: { label: "未设置", tone: "blue" },
  attention: { label: "需关注", tone: "red" },
  unavailable: { label: "不适用", tone: "neutral" },
  unknown: { label: "状态未知", tone: "orange" },
};

const riskMeta: Record<ConfigurationRisk, { label: string; tone: "green" | "orange" | "red" }> = {
  low: { label: "低风险", tone: "green" },
  medium: { label: "需确认", tone: "orange" },
  high: { label: "高风险", tone: "red" },
};

type PendingAction = { item: ConfigurationAuditItem; mode: "recommended" | "restore" };

function displayDescription(item: ConfigurationAuditItem) {
  const title = featureTitle(item.id, item.title);
  if (item.operationKind === "optionalFeature") return `安装或移除 Windows 的“${title.replace(/^启用 /, "")}”可选组件。`;
  if (item.operationKind === "action") return `执行“${title}”，操作前会显示影响和恢复能力。`;
  return `调整 Windows 的“${title}”行为；不会与其他设置打包执行。`;
}

function itemMatches(item: ConfigurationAuditItem, query: string) {
  if (!query) return true;
  return `${featureTitle(item.id, item.title)} ${item.title} ${item.description} ${item.category}`.toLocaleLowerCase().includes(query);
}

function groupRisk(group: ConfigurationGroup, itemById: Map<string, ConfigurationAuditItem>): ConfigurationRisk {
  const risks = group.values.flatMap((value) => value.featureIds.map((id) => itemById.get(id)?.risk));
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function SettingSwitch({ item, onAction }: { item: ConfigurationAuditItem; onAction: (action: PendingAction) => void }) {
  const enabled = item.status === "configured";
  const mode = enabled ? "restore" : "recommended";
  const canChange = enabled ? item.canRestore : item.canApply;
  if (item.operationKind === "action" || item.disableWhenApplied) {
    return (
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={!item.canApply || enabled}
        onClick={(event) => { event.stopPropagation(); onAction({ item, mode: "recommended" }); }}
      >
        {enabled ? <><Check className="mr-1 h-3.5 w-3.5" />已执行</> : "执行"}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "恢复" : "应用"}${featureTitle(item.id, item.title)}`}
      disabled={!canChange}
      onClick={(event) => { event.stopPropagation(); onAction({ item, mode }); }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? "bg-blue-600 shadow-sm shadow-blue-500/25" : "bg-muted-foreground/25"}`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-300 ${enabled ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

export function SystemOptimizationPanel({ onAdvisory }: { onAdvisory?: (item: ConfigurationAuditItem) => void }) {
  const [audit, setAudit] = useState<ConfigurationAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("全部设置");
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<"all" | ConfigurationRisk>("all");
  const [status, setStatus] = useState<"all" | ConfigurationStatus>("all");
  const [compatibleOnly, setCompatibleOnly] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [applying, setApplying] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [details, setDetails] = useState<ConfigurationAuditItem | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try { setAudit(await getConfigurationAudit()); }
    catch (nextError) { setError(String(nextError)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  const items = audit?.items ?? [];
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const categoryCounts = useMemo(() => new Map((audit?.categories ?? []).map((item) => [item.label, item.count])), [audit]);
  const categories = fallbackCategories;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(() => items.filter((item) => {
    if (item.groupId) return false;
    if (category !== "全部设置" && item.category !== category) return false;
    if (!itemMatches(item, normalizedQuery)) return false;
    if (risk !== "all" && item.risk !== risk) return false;
    if (status !== "all" && item.status !== status) return false;
    return !compatibleOnly || item.status !== "unavailable";
  }), [items, category, normalizedQuery, risk, status, compatibleOnly]);
  const visibleGroups = useMemo(() => (audit?.groups ?? []).filter((group) => {
    if (category !== "全部设置" && group.category !== category) return false;
    const groupItems = group.values.flatMap((value) => value.featureIds.map((id) => itemById.get(id))).filter(Boolean) as ConfigurationAuditItem[];
    if (compatibleOnly && groupItems.every((item) => item.status === "unavailable")) return false;
    if (risk !== "all" && groupRisk(group, itemById) !== risk) return false;
    if (status !== "all" && !groupItems.some((item) => item.status === status)) return false;
    if (!normalizedQuery) return true;
    return `${groupTitle(group.id, group.label)} ${group.label} ${group.description}`.toLocaleLowerCase().includes(normalizedQuery)
      || groupItems.some((item) => itemMatches(item, normalizedQuery));
  }), [audit, category, itemById, compatibleOnly, risk, status, normalizedQuery]);

  const configuredCount = items.filter((item) => item.status === "configured").length;
  const unavailableCount = items.filter((item) => item.status === "unavailable").length;
  const attentionCount = items.filter((item) => item.risk === "high" && item.status !== "configured" && item.status !== "unavailable").length;
  const shownCount = visibleItems.length + visibleGroups.length;

  const confirm = async () => {
    if (!pending) return;
    setApplying(true);
    setActionError("");
    setNotice(null);
    try {
      const result = await applyConfigurationItem(pending.item.id, pending.mode);
      setNotice({ tone: "success", text: `${result.detail}${result.requiresRestart ? "；重启后完全生效" : ""}` });
      setPending(null);
      setAcknowledged(false);
      await refresh();
    } catch (applyError) {
      setActionError(`未能完成：${String(applyError)}`);
    } finally { setApplying(false); }
  };

  const openPending = (action: PendingAction) => { setAcknowledged(false); setActionError(""); setPending(action); };

  return (
    <div className="space-y-3 pb-4">
      <section className="relative overflow-hidden rounded-2xl border border-blue-500/15 bg-gradient-to-r from-blue-500/[0.08] via-card to-violet-500/[0.06] px-5 py-4 shadow-sm">
        <div className="pointer-events-none absolute -right-8 -top-16 h-36 w-36 rounded-full bg-blue-400/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-lg shadow-blue-500/20"><SlidersHorizontal className="h-5 w-5" /></span>
          <h2 className="text-lg font-semibold tracking-tight">Windows 系统优化</h2>
          <div className="ml-auto flex items-center gap-2">
            {audit?.windowsBuild ? <StatusPill tone="neutral">Build {audit.windowsBuild}</StatusPill> : null}
            <button type="button" className={secondaryButtonClass} onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />重新检测
            </button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-4 gap-3">
        <MetricCard
          label="Windows 设置"
          value={loading ? "—" : String(items.length || 93)}
          detail="12 个功能分类"
          icon={<SlidersHorizontal className="h-4 w-4" />}
          onClick={() => { setStatus("all"); setRisk("all"); setCompatibleOnly(true); }}
          active={status === "all" && risk === "all" && compatibleOnly}
        />
        <MetricCard
          label="已应用"
          value={loading ? "—" : String(configuredCount)}
          detail="与内置规则完全匹配"
          icon={<CheckCircle2 className="h-4 w-4" />}
          accent="green"
          onClick={() => { setStatus("configured"); setRisk("all"); setCompatibleOnly(true); }}
          active={status === "configured" && risk === "all" && compatibleOnly}
        />
        <MetricCard
          label="当前不可用"
          value={loading ? "—" : String(unavailableCount)}
          detail="受 Windows 版本限制"
          icon={<LockKeyhole className="h-4 w-4" />}
          accent="violet"
          onClick={() => { setStatus("unavailable"); setRisk("all"); setCompatibleOnly(false); }}
          active={status === "unavailable" && risk === "all" && !compatibleOnly}
        />
        <MetricCard
          label="高风险待确认"
          value={loading ? "—" : String(attentionCount)}
          detail="不会由 AI 自动修改"
          icon={<AlertTriangle className="h-4 w-4" />}
          accent="orange"
          onClick={() => { setRisk("high"); setStatus("all"); setCompatibleOnly(true); }}
          active={risk === "high" && status === "all" && compatibleOnly}
        />
      </div>

      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-xs ${notice.tone === "error" ? "border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-400" : "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"}`}>
          {notice.tone === "error" ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}{notice.text}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input role="searchbox" aria-label="搜索 Windows 设置" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Windows 设置" className="h-9 w-full rounded-lg border border-border/70 bg-background pl-9 pr-3 text-xs outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10" />
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground"><Filter className="h-3.5 w-3.5" /></div>
          <select aria-label="风险筛选" value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)} className="h-9 rounded-lg border border-border/70 bg-background px-2.5 text-xs">
            <option value="all">全部风险</option><option value="low">低风险</option><option value="medium">需确认</option><option value="high">高风险</option>
          </select>
          <select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="h-9 rounded-lg border border-border/70 bg-background px-2.5 text-xs">
            <option value="all">全部状态</option><option value="configured">已生效</option><option value="available">未设置</option><option value="unknown">状态未知</option><option value="unavailable">不适用</option>
          </select>
          <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background px-3 text-xs">
            <input type="checkbox" checked={compatibleOnly} onChange={(event) => setCompatibleOnly(event.target.checked)} />仅当前设备可用
          </label>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 lg:hidden">
          {["全部设置", ...categories].map((label) => <button key={label} type="button" aria-label={`${label}（紧凑导航）`} onClick={() => setCategory(label)} className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs ${category === label ? "bg-blue-600 text-white" : "text-muted-foreground hover:bg-muted"}`}>{label}</button>)}
        </div>

        <div className="grid min-h-[470px] lg:grid-cols-[190px_minmax(0,1fr)]">
          <nav aria-label="Windows 设置分类" className="hidden border-r border-border/60 bg-muted/[0.18] p-2 lg:block">
            {["全部设置", ...categories].map((label) => {
              const Icon = label === "全部设置" ? SlidersHorizontal : (categoryIcons[label] ?? CircleHelp);
              const count = label === "全部设置" ? items.length : (categoryCounts.get(label) ?? items.filter((item) => item.category === label).length);
              return <button key={label} type="button" aria-label={label} onClick={() => setCategory(label)} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${category === label ? "bg-blue-600 text-white shadow-sm" : "text-muted-foreground hover:bg-background hover:text-foreground"}`}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{label}</span><span className={`text-[10px] ${category === label ? "text-blue-100" : "text-muted-foreground/70"}`}>{count}</span></button>;
            })}
          </nav>

          <div className="min-w-0 p-3">
            <div className="mb-2 flex items-center justify-between px-1"><p className="text-xs font-medium">{category}</p><span className="text-[11px] text-muted-foreground">显示 {shownCount} 个配置控件</span></div>
            {loading && <div className="space-y-2">{[0, 1, 2, 3, 4].map((value) => <div key={value} className="h-[78px] animate-pulse rounded-xl border border-border/50 bg-muted/30" />)}</div>}
            {!loading && error && <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/5 p-4 text-xs text-red-700 dark:text-red-400">无法读取 Windows 设置：{error}</div>}
            {!loading && !error && shownCount === 0 && <div className="rounded-xl border border-dashed border-border/70 py-16 text-center text-xs text-muted-foreground">没有符合当前筛选条件的设置</div>}
            {!loading && !error && shownCount > 0 && (
              <div className="space-y-2">
                {visibleGroups.map((group) => {
                  const groupItems = group.values.flatMap((value) => value.featureIds.map((id) => itemById.get(id))).filter(Boolean) as ConfigurationAuditItem[];
                  const disabled = groupItems.every((item) => !item.canApply);
                  const current = group.activeFeatureId ?? "";
                  const groupRiskValue = groupRisk(group, itemById);
                  return <article key={group.id} className="group rounded-xl border border-border/65 bg-background/70 px-3.5 py-3 transition hover:border-blue-500/25 hover:shadow-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600"><SlidersHorizontal className="h-4 w-4" /></span>
                      <div className="min-w-[180px] flex-1"><div className="flex items-center gap-2"><h3 className="text-xs font-semibold">{groupTitle(group.id, group.label)}</h3><StatusPill tone={riskMeta[groupRiskValue].tone}>{riskMeta[groupRiskValue].label}</StatusPill></div><p className="mt-1 truncate text-[11px] text-muted-foreground">从互斥选项中选择一个 Windows 行为</p></div>
                      <select aria-label={groupTitle(group.id, group.label)} value={current} disabled={disabled || applying} onChange={(event) => { const item = itemById.get(event.target.value); if (item) openPending({ item, mode: "recommended" }); }} className="h-8 min-w-[190px] max-w-[280px] rounded-lg border border-border/70 bg-card px-2.5 text-xs">
                        <option value="">{disabled ? "当前版本不适用" : "选择配置"}</option>
                        {group.values.map((value) => <option key={value.featureIds.join(":")} value={value.featureIds[0]}>{optionLabel(value.label)}</option>)}
                      </select>
                    </div>
                  </article>;
                })}
                {visibleItems.map((item) => {
                  const meta = statusMeta[item.status];
                  const riskInfo = riskMeta[item.risk];
                  return <article key={item.id} tabIndex={0} role="button" onClick={() => setDetails(item)} onKeyDown={(event) => { if (event.key === "Enter") setDetails(item); }} className={`group rounded-xl border px-3.5 py-3 outline-none transition hover:-translate-y-px hover:border-blue-500/25 hover:shadow-sm focus:border-blue-500/40 ${item.status === "unavailable" ? "border-border/50 bg-muted/20 opacity-70" : "border-border/65 bg-background/70"}`}>
                    <div className="flex items-center gap-3">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.risk === "high" ? "bg-red-500/10 text-red-600" : item.status === "configured" ? "bg-emerald-500/10 text-emerald-600" : "bg-blue-500/10 text-blue-600"}`}>{item.status === "configured" ? <Check className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}</span>
                      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><h3 className="truncate text-xs font-semibold">{featureTitle(item.id, item.title)}</h3><StatusPill tone={meta.tone}>{meta.label}</StatusPill><StatusPill tone={riskInfo.tone}>{riskInfo.label}</StatusPill>{item.requiresRestart && <StatusPill tone="violet">需重启</StatusPill>}{item.requiresAdministrator && <StatusPill tone="orange">管理员</StatusPill>}</div><p className="mt-1 truncate text-[11px] text-muted-foreground">{displayDescription(item)}</p></div>
                      <SettingSwitch item={item} onAction={openPending} />
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-blue-600" />
                    </div>
                  </article>;
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <Sheet open={Boolean(details)} onOpenChange={(open) => { if (!open) setDetails(null); }}>
        <SheetContent side="right" className="w-[440px] max-w-[92vw] overflow-y-auto p-0 sm:max-w-[440px]">
          {details && <>
            <div className="border-b border-border/60 bg-gradient-to-br from-blue-500/[0.08] to-violet-500/[0.05] p-5"><SheetHeader><SheetTitle className="pr-8 text-left text-base">{featureTitle(details.id, details.title)}</SheetTitle></SheetHeader><div className="mt-3 flex flex-wrap gap-1.5"><StatusPill tone={statusMeta[details.status].tone}>{statusMeta[details.status].label}</StatusPill><StatusPill tone={riskMeta[details.risk].tone}>{riskMeta[details.risk].label}</StatusPill>{details.requiresAdministrator && <StatusPill tone="orange">需要管理员权限</StatusPill>}{details.requiresRestart && <StatusPill tone="violet">重启后生效</StatusPill>}</div></div>
            <div className="space-y-4 p-5 text-xs leading-5">
              <section><h4 className="font-semibold">当前状态</h4><p className="mt-1 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-muted-foreground">{details.currentValue}</p></section>
              <section><h4 className="font-semibold">功能影响</h4><p className="mt-1 text-muted-foreground">{featureImpact(details.id) || displayDescription(details)}</p></section>
              {onAdvisory && <button type="button" className={`${secondaryButtonClass} w-full justify-center`} onClick={() => { const item = details; setDetails(null); onAdvisory(item); }}><Sparkles className="mr-1.5 h-3.5 w-3.5" />Mona 建议</button>}
              <section className="grid grid-cols-2 gap-2"><div className="rounded-lg border border-border/60 p-3"><p className="text-muted-foreground">恢复能力</p><p className="mt-1 font-medium">{details.reversible ? "支持自动恢复" : "需要手动恢复"}</p></div><div className="rounded-lg border border-border/60 p-3"><p className="text-muted-foreground">兼容范围</p><p className="mt-1 font-medium">{details.minVersion ? `Build ${details.minVersion}+` : "Windows 10/11"}</p></div></section>
              {details.risk === "high" && <div className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-red-700 dark:text-red-400"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>此设置可能影响安全、恢复或系统组件。Mona 不会自动替你选择。</span></div>}
              <p className="text-[11px] text-muted-foreground">{details.note}</p>
              <div className="flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setDetails(null)}>关闭</button>{details.canRestore && details.status === "configured" && <button type="button" className={secondaryButtonClass} onClick={() => { setDetails(null); openPending({ item: details, mode: "restore" }); }}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />恢复</button>}<button type="button" disabled={!details.canApply || details.status === "configured"} onClick={() => { setDetails(null); openPending({ item: details, mode: "recommended" }); }} className="inline-flex h-8 items-center rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-40">应用设置</button></div>
            </div>
          </>}
        </SheetContent>
      </Sheet>

      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !applying) { setPending(null); setAcknowledged(false); setActionError(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>{pending?.mode === "restore" ? "恢复 Windows 默认设置？" : `应用“${pending ? featureTitle(pending.item.id, pending.item.title) : ""}”？`}</AlertDialogTitle><AlertDialogDescription>{pending?.item ? `${displayDescription(pending.item)}${pending.item.requiresAdministrator ? " Windows 可能要求管理员权限。" : ""}${pending.item.requiresRestart ? " 完成后需要重启。" : ""}${!pending.item.reversible ? " 此项目无法由 Mona 自动恢复。" : ""}` : ""}</AlertDialogDescription></AlertDialogHeader>
          {actionError && <div role="alert" className="flex gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs text-red-700 dark:text-red-400"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{actionError}</span></div>}
          {pending?.item.risk === "high" && <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs leading-5"><input className="mt-1" type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span><strong className="text-red-700 dark:text-red-400">我已了解这是高风险设置</strong><br /><span className="text-muted-foreground">可能影响系统组件、安全策略或恢复能力，我确认继续。</span></span></label>}
          <AlertDialogFooter><AlertDialogCancel disabled={applying}>取消</AlertDialogCancel><AlertDialogAction disabled={applying || (pending?.item.risk === "high" && !acknowledged)} onClick={(event) => { event.preventDefault(); void confirm(); }} className={pending?.item.risk === "high" ? "bg-red-600 text-white hover:bg-red-700" : "bg-blue-600 text-white hover:bg-blue-700"}>{applying && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{pending?.mode === "restore" ? "确认恢复" : "确认应用"}</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
