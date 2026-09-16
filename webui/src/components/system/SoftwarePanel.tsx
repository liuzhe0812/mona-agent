import { AlertTriangle, CircleArrowUp, FolderOpen, Loader2, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusNotice } from "@/components/ui/status-notice";

import { PanelCard, StatusPill, TaskFailureNotice } from "./SystemUi";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import {
  useMaintenanceHistory,
  useSoftwareManagement,
  type InstalledSoftware,
  type SoftwareFailure,
  type SoftwareResidualDeleteResult,
  type SoftwareUpdate,
} from "./useSystemData";
import { WindowsAppsPanel } from "./WindowsAppsPanel";
import { AppStorePanel } from "./AppStorePanel";

const DISMISSED_FAILURES_KEY = "system.softwareDismissedFailures";

function loadDismissedFailures(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_FAILURES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissedFailures(set: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_FAILURES_KEY, JSON.stringify([...set]));
  } catch {
    // 配额不足或序列化失败时静默跳过，不影响功能
  }
}

type SoftwareSection = "store" | "mine" | "windows-apps" | "uninstall-history";
type MineFilter = "all" | "updates" | "failed";

interface MySoftwareRow {
  key: string;
  name: string;
  publisher: string;
  installed: InstalledSoftware | null;
  update: SoftwareUpdate | null;
  failure: SoftwareFailure | null;
}

const softwareSections: { id: SoftwareSection; label: string }[] = [
  { id: "store", label: "应用商店" },
  { id: "mine", label: "我的软件" },
  { id: "windows-apps", label: "Windows 预装应用" },
  { id: "uninstall-history", label: "卸载记录" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dismissKey(failure: SoftwareFailure): string {
  return `${failure.packageId}:${failure.action}`;
}

function displaySoftwareText(value: string): string {
  return value.replace(/winget/gi, "安装服务");
}

function normalizedSoftwareName(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s._\-()（）]+/g, "");
}

interface SoftwarePanelProps {
  onHandoff: (task: SystemAgentHandoffTask) => void;
  showUpdatesRequest?: number;
  showStoreDetails?: boolean;
}

export function SoftwarePanel({ onHandoff, showUpdatesRequest = 0, showStoreDetails = true }: SoftwarePanelProps) {
  const {
    data,
    loading,
    error,
    workingIds,
    lastAction,
    lastUninstall,
    progressMap,
    refresh,
    upgrade,
    uninstall,
    deleteResiduals,
    revealInExplorer,
  } = useSoftwareManagement();
  const maintenance = useMaintenanceHistory();
  const [activeSection, setActiveSection] = useState<SoftwareSection>("store");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedInstalledId, setSelectedInstalledId] = useState("");
  const [mineQuery, setMineQuery] = useState("");
  const [mineFilter, setMineFilter] = useState<MineFilter>("all");
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [handedOffFailures, setHandedOffFailures] = useState<Set<string>>(() => loadDismissedFailures());
  const [uninstallHandedOff, setUninstallHandedOff] = useState(false);
  const [uninstallDismissed, setUninstallDismissed] = useState(false);
  const [selectedResidualIds, setSelectedResidualIds] = useState<Set<string>>(new Set());
  const [removedResidualIds, setRemovedResidualIds] = useState<Set<string>>(new Set());
  const [residualDeleteDialogOpen, setResidualDeleteDialogOpen] = useState(false);
  const [residualDeleting, setResidualDeleting] = useState(false);
  const [residualDeleteResult, setResidualDeleteResult] = useState<SoftwareResidualDeleteResult | null>(null);
  const [residualActionError, setResidualActionError] = useState<string | null>(null);

  useEffect(() => {
    if (showUpdatesRequest > 0) {
      setActiveSection("mine");
      setMineFilter("updates");
    }
  }, [showUpdatesRequest]);

  useEffect(() => {
    const candidates = lastUninstall?.success ? lastUninstall.residuals : [];
    setSelectedResidualIds(new Set(candidates.filter((candidate) => candidate.recommended && candidate.canDelete).map((candidate) => candidate.id)));
    setRemovedResidualIds(new Set());
    setResidualDeleteResult(null);
    setResidualActionError(null);
  }, [lastUninstall]);

  const dismissFailure = (failure: SoftwareFailure) => {
    setHandedOffFailures((current) => {
      const next = new Set(current).add(dismissKey(failure));
      saveDismissedFailures(next);
      return next;
    });
  };

  const updates = data?.updates ?? [];
  const installed = data?.installed ?? [];
  const selectedUpdates = updates.filter((software) => selected.has(software.id));
  const selectedInstalled = installed.find((software) => software.id === selectedInstalledId) ?? null;
  const uninstallEvents = (maintenance.data?.events ?? []).filter((event) => event.category === "卸载");
  const busy = workingIds.size > 0;
  const visibleFailures = (data?.failures ?? []).filter((failure) => !handedOffFailures.has(dismissKey(failure)));
  const softwareRows = useMemo<MySoftwareRow[]>(() => {
    const matchedUpdateIds = new Set<string>();
    const rows: MySoftwareRow[] = installed.map((software) => {
      const update = updates.find((candidate) => (
        candidate.id.toLocaleLowerCase() === software.id.toLocaleLowerCase()
        || normalizedSoftwareName(candidate.name) === normalizedSoftwareName(software.name)
      )) ?? null;
      if (update) matchedUpdateIds.add(update.id);
      const failure = visibleFailures.find((candidate) => (
        candidate.packageId === software.id
        || candidate.packageId === update?.id
        || normalizedSoftwareName(candidate.name) === normalizedSoftwareName(software.name)
      )) ?? null;
      return {
        key: software.id,
        name: software.name,
        publisher: software.publisher,
        installed: software,
        update,
        failure,
      };
    });
    for (const update of updates) {
      if (matchedUpdateIds.has(update.id)) continue;
      rows.push({
        key: `update:${update.id}`,
        name: update.name,
        publisher: update.publisher,
        installed: null,
        update,
        failure: visibleFailures.find((candidate) => candidate.packageId === update.id) ?? null,
      });
    }
    for (const failure of visibleFailures) {
      if (rows.some((row) => row.failure === failure)) continue;
      rows.push({
        key: `failure:${failure.packageId}:${failure.action}`,
        name: failure.name,
        publisher: "",
        installed: null,
        update: null,
        failure,
      });
    }
    return rows.sort((left, right) => (
      Number(Boolean(right.failure)) - Number(Boolean(left.failure))
      || Number(Boolean(right.update)) - Number(Boolean(left.update))
      || left.name.localeCompare(right.name, "zh-CN")
    ));
  }, [installed, updates, visibleFailures]);
  const filteredSoftwareRows = useMemo(() => {
    const keyword = mineQuery.trim().toLocaleLowerCase();
    return softwareRows.filter((row) => {
      if (mineFilter === "updates" && !row.update) return false;
      if (mineFilter === "failed" && !row.failure) return false;
      if (!keyword) return true;
      return `${row.name} ${row.publisher} ${row.installed?.version ?? ""} ${row.update?.nextVersion ?? ""}`
        .toLocaleLowerCase()
        .includes(keyword);
    });
  }, [mineFilter, mineQuery, softwareRows]);
  const visibleUpdates = filteredSoftwareRows.flatMap((row) => row.update ? [row.update] : []);
  const residuals = lastUninstall?.success ? lastUninstall.residuals : [];
  const visibleResiduals = residuals.filter((candidate) => !removedResidualIds.has(candidate.id));
  const recommendedResiduals = visibleResiduals.filter((candidate) => candidate.recommended && candidate.canDelete);
  const selectedResiduals = visibleResiduals.filter((candidate) => candidate.canDelete && selectedResidualIds.has(candidate.id));
  const allRecommendedSelected = recommendedResiduals.length > 0 && recommendedResiduals.every((candidate) => selectedResidualIds.has(candidate.id));
  const residualGroups = [
    { id: "recommended", label: "建议清理", candidates: visibleResiduals.filter((candidate) => candidate.recommended && candidate.canDelete) },
    { id: "confirm", label: "需要确认", candidates: visibleResiduals.filter((candidate) => !candidate.recommended && candidate.canDelete) },
    { id: "detect", label: "仅检测", candidates: visibleResiduals.filter((candidate) => !candidate.canDelete) },
  ].filter((group) => group.candidates.length > 0);
  const selectedResidualBytes = selectedResiduals.reduce((total, candidate) => total + candidate.sizeBytes, 0);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleAll = () => setSelected((current) => {
    if (visibleUpdates.length > 0 && visibleUpdates.every((software) => current.has(software.id))) return new Set();
    return new Set(visibleUpdates.map((software) => software.id));
  });

  const handleUninstall = async () => {
    if (!selectedInstalled) return;
    setUninstallHandedOff(false);
    setUninstallDismissed(false);
    await uninstall(selectedInstalled);
    setConfirmingUninstall(false);
    void maintenance.refresh();
  };

  const toggleResidual = (id: string) => setSelectedResidualIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleRecommendedResiduals = () => setSelectedResidualIds((current) => {
    const next = new Set(current);
    if (allRecommendedSelected) {
      recommendedResiduals.forEach((candidate) => next.delete(candidate.id));
    } else {
      recommendedResiduals.forEach((candidate) => next.add(candidate.id));
    }
    return next;
  });

  const handleRevealResidual = async (path: string) => {
    setResidualActionError(null);
    try {
      await revealInExplorer(path);
    } catch (error) {
      setResidualActionError(`打开位置失败：${String(error)}`);
    }
  };

  const handleDeleteResiduals = async () => {
    if (selectedResiduals.length === 0 || residualDeleting) return;
    setResidualDeleting(true);
    setResidualActionError(null);
    try {
      const result = await deleteResiduals(selectedResiduals.map((candidate) => candidate.id));
      setResidualDeleteResult(result);
      setRemovedResidualIds((current) => new Set([...current, ...result.deletedIds]));
      setSelectedResidualIds((current) => {
        const next = new Set(current);
        result.deletedIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (error) {
      setResidualActionError(`删除残留失败：${String(error)}`);
    } finally {
      setResidualDeleting(false);
      setResidualDeleteDialogOpen(false);
    }
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="软件管理" className="scrollbar-hover flex gap-5 overflow-x-auto border-b border-border/70 px-1">
        {softwareSections.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            onClick={() => setActiveSection(section.id)}
            className={`relative whitespace-nowrap px-1 pb-2.5 text-caption font-medium transition ${activeSection === section.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {section.label}
            {activeSection === section.id && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[hsl(var(--brand-red))]" />}
          </button>
        ))}
      </div>

      {error && activeSection !== "store" && (
        <StatusNotice tone="danger">软件信息读取失败：{error}</StatusNotice>
      )}

      {activeSection === "store" && <AppStorePanel installed={installed} onInstalled={refresh} showDetails={showStoreDetails} />}

      {activeSection === "mine" && (
        <PanelCard
          title="我的软件"
          action={(
            <div className="flex items-center gap-2">
              <Input
                aria-label="搜索我的软件"
                value={mineQuery}
                onChange={(event) => setMineQuery(event.target.value)}
                placeholder="搜索我的软件"
                className="w-48"
              />
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading || busy}>重新扫描</Button>
            </div>
          )}
        >
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {([
              ["all", `全部 ${softwareRows.length}`],
              ["updates", `可更新 ${updates.length}`],
              ["failed", `处理失败 ${visibleFailures.length}`],
            ] as const).map(([id, label]) => (
              <Button
                key={id}
                variant={mineFilter === id ? "interaction" : "ghost"}
                size="sm"
                onClick={() => setMineFilter(id)}
              >{label}</Button>
            ))}
          </div>
          <div className="max-h-[470px] overflow-auto">
            <table className="w-full min-w-[920px] table-fixed text-left text-caption">
              <colgroup><col className="w-10" /><col className="w-[210px]" /><col className="w-[145px]" /><col className="w-[105px]" /><col className="w-[105px]" /><col className="w-[90px]" /><col className="w-[90px]" /><col className="w-[145px]" /></colgroup>
              <thead className="sticky top-0 z-10 bg-card text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">
                    <Checkbox
                      aria-label="选择当前可更新软件"
                      checked={visibleUpdates.length > 0 && visibleUpdates.every((software) => selected.has(software.id))}
                      onCheckedChange={toggleAll}
                      disabled={visibleUpdates.length === 0 || busy}
                    />
                  </th>
                  <th className="pb-2 font-medium">软件</th><th>发布者</th><th>当前版本</th><th>新版本</th><th>占用</th><th>状态</th><th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSoftwareRows.map((row) => {
                  const isWorking = Boolean(row.update && workingIds.has(row.update.id));
                  const latest = row.update ? (progressMap[row.update.id] ?? []).at(-1) : undefined;
                  return (
                    <Fragment key={row.key}>
                      <tr className="border-t border-border/50 transition-colors hover:bg-accent/40">
                        <td className="py-2.5">
                          {row.update ? <Checkbox aria-label={`选择 ${row.name}`} checked={selected.has(row.update.id)} onCheckedChange={() => toggle(row.update!.id)} disabled={busy} /> : null}
                        </td>
                        <td className="truncate pr-3 font-medium" title={row.name}>{row.name}</td>
                        <td className="truncate pr-3 text-muted-foreground" title={row.publisher || undefined}>{row.publisher || "未知"}</td>
                        <td>{row.update?.currentVersion || row.installed?.version || "未知"}</td>
                        <td>{row.update?.nextVersion || "—"}</td>
                        <td>{row.installed?.estimatedSizeBytes != null ? formatBytes(row.installed.estimatedSizeBytes) : "—"}</td>
                        <td><StatusPill tone={row.failure ? "red" : isWorking ? "orange" : row.update ? "brand" : "neutral"}>{row.failure ? "处理失败" : isWorking ? "更新中" : row.update ? "可更新" : "已安装"}</StatusPill></td>
                        <td className="text-right">
                          <span className="inline-flex items-center justify-end gap-1">
                            {row.update ? <Button
                              variant="interaction"
                              size="icon"
                              aria-label={`${isWorking ? "正在更新" : "更新"} ${row.name}`}
                              title={`${isWorking ? "正在更新" : "更新"} ${row.name}`}
                              onClick={() => upgrade([row.update!])}
                              disabled={busy}
                            >
                              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CircleArrowUp className="h-4 w-4" aria-hidden="true" />}
                            </Button> : null}
                            {row.installed ? <Button
                              variant="dangerSoft"
                              size="icon"
                              aria-label={`卸载 ${row.installed.name}`}
                              aria-disabled={busy || !row.installed.canUninstall}
                              title={row.installed.canUninstall ? `卸载 ${row.installed.name}` : "该软件未提供卸载方式"}
                              disabled={busy || !row.installed.canUninstall}
                              onClick={() => { setSelectedInstalledId(row.installed!.id); setConfirmingUninstall(true); }}
                            ><Trash2 className="h-4 w-4" aria-hidden="true" /></Button> : null}
                          </span>
                        </td>
                      </tr>
                      {(latest || row.failure) ? (
                        <tr><td colSpan={8} className="pb-2.5">
                          {row.failure ? <TaskFailureNotice
                            title={`${row.failure.name} · ${row.failure.action === "upgrade" ? "更新失败" : "卸载失败"}`}
                            detail={`${displaySoftwareText(row.failure.message) || "安装器未返回详细原因"} · ${formatRecordTime(row.failure.ts)}`}
                            onRetry={row.failure.action === "upgrade" && row.update ? () => void upgrade([row.update!]) : undefined}
                            onHandoff={() => {
                              dismissFailure(row.failure!);
                              onHandoff({ id: crypto.randomUUID(), title: `${row.failure!.action === "uninstall" ? "卸载" : "更新"} ${row.failure!.name}`, action: row.failure!.action === "uninstall" ? "卸载软件" : "更新软件", target: row.failure!.name, arguments: { packageId: row.failure!.packageId, action: row.failure!.action }, error: displaySoftwareText(row.failure!.message) || "安装器未返回详细原因" });
                            }}
                            onDismiss={() => dismissFailure(row.failure!)}
                          /> : <p className="truncate px-3 text-micro text-muted-foreground" title={latest}>{latest}</p>}
                        </td></tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!loading && filteredSoftwareRows.length === 0 && <p className="py-8 text-center text-caption text-muted-foreground">当前筛选下没有软件</p>}
          </div>

          {updates.length > 0 && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/30 p-2.5 text-caption">
            <span>已选择 {selectedUpdates.length} 项更新</span>
            <Button size="sm" onClick={() => upgrade(selectedUpdates)} disabled={selectedUpdates.length === 0 || busy}>{busy ? "处理中" : "更新所选"}</Button>
          </div>}
          {lastAction && <p role="status" className="mt-2 text-caption text-success">{lastAction}</p>}

          {confirmingUninstall && selectedInstalled && <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption">
            <AlertTriangle className="h-4 w-4 text-warning" /><span className="flex-1">将精确匹配并卸载“{selectedInstalled.name}”。卸载后仅展示检测到的残留候选，不会自动删除。</span>
            <Button variant="outline" size="sm" onClick={() => setConfirmingUninstall(false)}>取消</Button>
            <Button variant="destructive" size="sm" onClick={handleUninstall} aria-label={`确认卸载 ${selectedInstalled.name}`}>确认卸载</Button>
          </div>}
        </PanelCard>
      )}

      {activeSection === "uninstall-history" && (
        <PanelCard title="卸载记录" action={<Button variant="outline" size="sm" onClick={maintenance.refresh} disabled={maintenance.loading}>刷新</Button>}>
          {maintenance.error && <StatusNotice tone="danger" className="mb-3">卸载记录读取失败：{maintenance.error}</StatusNotice>}
          {!maintenance.error && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-caption">
                <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">时间</th><th>软件</th><th>状态</th><th>详情</th></tr></thead>
                <tbody>
                  {uninstallEvents.map((event) => (
                    <tr key={event.id} className="border-t border-border/50">
                      <td className="py-2.5 text-muted-foreground">{formatRecordTime(event.ts)}</td>
                      <td className="font-medium">{event.title}</td>
                      <td><StatusPill tone={event.status === "成功" ? "green" : "red"}>{event.status}</StatusPill></td>
                      <td className="text-muted-foreground">{displaySoftwareText(event.detail) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!maintenance.loading && uninstallEvents.length === 0 && <p className="py-8 text-center text-caption text-muted-foreground">暂无卸载记录</p>}
            </div>
          )}
        </PanelCard>
      )}

      {activeSection === "windows-apps" && <WindowsAppsPanel onHandoff={onHandoff} />}

      {activeSection === "mine" && <PanelCard title="卸载与残留检测">
        {!lastUninstall && <p className="text-caption text-muted-foreground">完成卸载后，将在此显示检测到的残留候选；系统不会自动删除任何文件。</p>}
        {lastUninstall?.success && residuals.length === 0 && !residualDeleteResult && (
          <p role="status" className="text-caption text-success">已确认卸载完成，未发现高置信度残留候选。</p>
        )}
        {lastUninstall?.success && visibleResiduals.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-caption font-medium text-warning">
              <AlertTriangle className="h-4 w-4" />
              <span>疑似残留，删除前需确认</span>
              <span className="ml-auto text-muted-foreground">{visibleResiduals.length} 项 · {formatBytes(visibleResiduals.reduce((total, candidate) => total + candidate.sizeBytes, 0))}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-caption">
              <label className="inline-flex items-center gap-2">
                <Checkbox
                  aria-label="选择建议项"
                  checked={allRecommendedSelected}
                  onCheckedChange={toggleRecommendedResiduals}
                  disabled={recommendedResiduals.length === 0 || residualDeleting || busy}
                />
                <span>选择建议项</span>
              </label>
              <span className="text-muted-foreground">已选择 {selectedResiduals.length} 项</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`删除所选残留（${selectedResiduals.length} 项）`}
                onClick={() => setResidualDeleteDialogOpen(true)}
                disabled={selectedResiduals.length === 0 || residualDeleting || busy}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                删除所选
              </Button>
            </div>
            {residualGroups.map((group) => (
              <div key={group.id} className="space-y-2 pt-2">
                <div className="flex items-center gap-2 text-caption font-medium text-foreground">
                  <span>{group.label}</span>
                  <span className="text-muted-foreground">{group.candidates.length} 项</span>
                </div>
                {group.candidates.map((candidate) => (
                  <div key={candidate.id} className="flex flex-wrap items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-caption">
                    <Checkbox
                      aria-label={`选择残留 ${candidate.path}`}
                      checked={selectedResidualIds.has(candidate.id)}
                      onCheckedChange={() => toggleResidual(candidate.id)}
                      disabled={residualDeleting || busy || !candidate.canDelete}
                    />
                    <StatusPill tone="neutral">{candidate.category}</StatusPill>
                    <StatusPill tone={candidate.confidence === "high" ? "green" : "orange"}>
                      {candidate.confidence === "high" ? "高置信度" : "中置信度"}
                    </StatusPill>
                    <div className="min-w-0 flex-1">
                      <div className="break-all" title={candidate.path}>{candidate.path}</div>
                      {candidate.reason && <div className="mt-0.5 text-micro text-muted-foreground">{candidate.reason}</div>}
                    </div>
                    <span className="text-muted-foreground">
                      {candidate.sizeBytes > 0 || ["directory", "file", "shortcut"].includes(candidate.kind) ? formatBytes(candidate.sizeBytes) : "—"}
                    </span>
                    {["directory", "file", "shortcut"].includes(candidate.kind) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        aria-label={`打开 ${candidate.path}`}
                        onClick={() => void handleRevealResidual(candidate.path)}
                        disabled={residualDeleting || busy}
                      >
                        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                        打开位置
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {residualDeleteResult && (
          <StatusNotice
            tone={residualDeleteResult.failures.length === 0 && visibleResiduals.length === 0 ? "success" : (residualDeleteResult.deletedIds.length > 0 ? "warning" : "danger")}
            title={residualDeleteResult.failures.length === 0
              ? (visibleResiduals.length === 0 ? "残留清理完成" : "已清理所选，仍有项目需要查看")
              : "部分残留未能删除"}
            className="mt-3"
          >
            {residualDeleteResult.deletedIds.length > 0 && <p>已删除 {residualDeleteResult.deletedIds.length} 项，释放 {formatBytes(residualDeleteResult.freedBytes)}。</p>}
            {residualDeleteResult.failures.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {residualDeleteResult.failures.map((failure) => <li key={failure.id}>{failure.message || "删除失败"}</li>)}
              </ul>
            )}
          </StatusNotice>
        )}
        {residualActionError && <StatusNotice tone="danger" className="mt-3">{residualActionError}</StatusNotice>}
        {lastUninstall && !lastUninstall.success && !uninstallHandedOff && !uninstallDismissed && (
          <TaskFailureNotice
            title={`卸载 ${selectedInstalled?.name ?? "软件"} 失败`}
            detail={displaySoftwareText(lastUninstall.message) || "安装服务未返回详细原因"}
            onRetry={() => void handleUninstall()}
            onHandoff={() => {
              setUninstallHandedOff(true);
              onHandoff({
                id: crypto.randomUUID(),
                title: `卸载 ${selectedInstalled?.name ?? "软件"}`,
                action: "卸载软件",
                target: selectedInstalled?.name ?? "软件",
                arguments: {
                  id: selectedInstalled?.id ?? null,
                  name: selectedInstalled?.name ?? null,
                  installLocation: selectedInstalled?.installLocation || null,
                },
                error: displaySoftwareText(lastUninstall.message) || "安装服务未返回详细原因",
              });
            }}
            onDismiss={() => setUninstallDismissed(true)}
          />
        )}
      </PanelCard>}

      <AlertDialog
        open={residualDeleteDialogOpen}
        onOpenChange={(open) => { if (!residualDeleting) setResidualDeleteDialogOpen(open); }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除残留？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-caption">
                <p>将删除选中的 {selectedResiduals.length} 项残留，共 {formatBytes(selectedResidualBytes)}。</p>
                <ul className="max-h-40 space-y-1 overflow-auto rounded-md border border-border/70 bg-muted/20 p-2 text-muted-foreground">
                  {selectedResiduals.map((candidate) => <li key={candidate.id} className="break-all">{candidate.path}</li>)}
                </ul>
                <p className="text-warning">删除后无法恢复，请确认这些路径不再需要。</p>
                <p className="text-muted-foreground">部分系统目录可能会请求管理员权限。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={residualDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={residualDeleting || selectedResiduals.length === 0}
              onClick={(event) => { event.preventDefault(); void handleDeleteResiduals(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {residualDeleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {residualDeleting ? "删除中" : "确认删除残留"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
