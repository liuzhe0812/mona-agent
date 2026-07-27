import { AlertTriangle, Boxes, RefreshCw, ShieldCheck } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { MetricCard, PanelCard, StatusPill, TaskFailureNotice, primaryButtonClass, secondaryButtonClass } from "./SystemUi";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { useMaintenanceHistory, useSoftwareManagement, type SoftwareFailure } from "./useSystemData";
import { WindowsAppsPanel } from "./WindowsAppsPanel";

type SoftwareSection = "updates" | "installed" | "windows-apps" | "uninstall-history";

const softwareSections: { id: SoftwareSection; label: string }[] = [
  { id: "updates", label: "软件更新" },
  { id: "installed", label: "已安装软件" },
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

function formatCheckTime(timestamp: number): string {
  if (!timestamp) return "尚未检查";
  return `最后检查 ${new Date(timestamp * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function failureKey(failure: SoftwareFailure): string {
  return `${failure.packageId}:${failure.action}:${failure.ts}`;
}

interface SoftwarePanelProps {
  onHandoff: (task: SystemAgentHandoffTask) => void;
}

export function SoftwarePanel({ onHandoff }: SoftwarePanelProps) {
  const { data, loading, error, workingIds, lastAction, lastUninstall, progressMap, refresh, upgrade, uninstall } = useSoftwareManagement();
  const maintenance = useMaintenanceHistory();
  const [activeSection, setActiveSection] = useState<SoftwareSection>("updates");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedInstalledId, setSelectedInstalledId] = useState("");
  const [installedQuery, setInstalledQuery] = useState("");
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const [handedOffFailures, setHandedOffFailures] = useState<Set<string>>(new Set());
  const [uninstallHandedOff, setUninstallHandedOff] = useState(false);
  const [uninstallDismissed, setUninstallDismissed] = useState(false);

  const updates = data?.updates ?? [];
  const installed = data?.installed ?? [];
  const selectedUpdates = updates.filter((software) => selected.has(software.id));
  const selectedInstalled = installed.find((software) => software.id === selectedInstalledId) ?? null;
  const filteredInstalled = useMemo(() => {
    const keyword = installedQuery.trim().toLocaleLowerCase();
    if (!keyword) return installed;
    return installed.filter((software) => `${software.name} ${software.publisher} ${software.version}`.toLocaleLowerCase().includes(keyword));
  }, [installed, installedQuery]);
  const uninstallEvents = (maintenance.data?.events ?? []).filter((event) => event.category === "卸载");
  const busy = workingIds.size > 0;
  const visibleFailures = (data?.failures ?? []).filter((failure) => !handedOffFailures.has(failureKey(failure)));
  const handedOffFailureCount = (data?.failures.length ?? 0) - visibleFailures.length;

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const toggleAll = () => setSelected((current) => {
    if (updates.length > 0 && updates.every((software) => current.has(software.id))) return new Set();
    return new Set(updates.map((software) => software.id));
  });

  const handleUninstall = async () => {
    if (!selectedInstalled) return;
    setUninstallHandedOff(false);
    setUninstallDismissed(false);
    await uninstall(selectedInstalled);
    setConfirmingUninstall(false);
    void maintenance.refresh();
  };

  const updateCount = data?.updates.length ?? 0;
  const installedCount = data?.installedCount ?? 0;
  const failedCount = visibleFailures.length;
  const knownSizeDetail = data
    ? `已知占用 ${formatBytes(data.knownSizeBytes)} · 覆盖 ${data.knownSizeCount}/${data.installedCount}`
    : "正在读取注册表";

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="可用更新"
          value={loading && !data ? "检查中" : `${updateCount} 项`}
          detail="来自 WinGet 实时检查"
          icon={<RefreshCw className="h-4 w-4" />}
          accent="violet"
        />
        <MetricCard
          label="已安装"
          value={loading && !data ? "读取中" : `${installedCount} 个`}
          detail={knownSizeDetail}
          icon={<Boxes className="h-4 w-4" />}
        />
        <MetricCard
          label="更新失败"
          value={`${failedCount} 项`}
          detail={handedOffFailureCount ? `${handedOffFailureCount} 项已交给 Mona` : failedCount ? "需要处理" : "暂无未解决失败"}
          icon={<AlertTriangle className="h-4 w-4" />}
          accent={failedCount ? "orange" : "green"}
        />
        <MetricCard
          label="WinGet"
          value={data?.wingetAvailable ? "状态正常" : "不可用"}
          detail={data?.wingetAvailable ? `${data.wingetVersion} · ${formatCheckTime(data.lastCheck)}` : "未检测到 WinGet"}
          icon={<ShieldCheck className="h-4 w-4" />}
          accent={data?.wingetAvailable ? "green" : "orange"}
        />
      </div>

      <div role="tablist" aria-label="软件管理" className="scrollbar-hover flex gap-5 overflow-x-auto border-b border-border/70 px-1">
        {softwareSections.map((section) => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={activeSection === section.id}
            onClick={() => setActiveSection(section.id)}
            className={`relative whitespace-nowrap px-1 pb-2.5 text-sm font-medium transition ${activeSection === section.id ? "text-blue-600" : "text-muted-foreground hover:text-foreground"}`}
          >
            {section.label}
            {activeSection === section.id && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-blue-600" />}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-xs text-red-700 dark:text-red-400">
          软件信息读取失败：{error}
        </div>
      )}

      {activeSection === "updates" && (
        <>
          {visibleFailures.length > 0 && (
            <PanelCard title="未解决失败">
              <div className="space-y-2">
                {visibleFailures.map((failure) => {
                  const update = updates.find((item) => item.id === failure.packageId);
                  return (
                    <TaskFailureNotice
                      key={failureKey(failure)}
                      title={`${failure.name} · ${failure.action === "upgrade" ? "更新失败" : "卸载失败"}`}
                      detail={`${failure.message || "安装器未返回详细原因"} · ${formatRecordTime(failure.ts)}`}
                      onRetry={update ? () => void upgrade([update]) : undefined}
                      onHandoff={() => {
                        setHandedOffFailures((current) => new Set(current).add(failureKey(failure)));
                        onHandoff({
                          id: crypto.randomUUID(),
                          title: `${failure.action === "uninstall" ? "卸载" : "更新"} ${failure.name}`,
                          action: failure.action === "uninstall" ? "卸载软件" : "更新软件",
                          target: failure.name,
                          arguments: { packageId: failure.packageId, action: failure.action },
                          error: failure.message || "安装器未返回详细原因",
                        });
                      }}
                      onDismiss={() => setHandedOffFailures((current) => new Set(current).add(failureKey(failure)))}
                    />
                  );
                })}
              </div>
            </PanelCard>
          )}

          <PanelCard
            title="可用更新"
            action={<button className={secondaryButtonClass} onClick={refresh} disabled={loading || busy}>重新扫描</button>}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="w-10 pb-2 font-medium">
                      <input
                        aria-label="选择全部可更新软件"
                        type="checkbox"
                        checked={updates.length > 0 && updates.every((software) => selected.has(software.id))}
                        onChange={toggleAll}
                        disabled={updates.length === 0 || busy}
                      />
                    </th>
                    <th className="pb-2 font-medium">软件</th>
                    <th>当前版本</th>
                    <th>新版本</th>
                    <th>状态</th>
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {updates.map((software) => {
                    const isWorking = workingIds.has(software.id);
                    const lines = progressMap[software.id] ?? [];
                    const latest = lines[lines.length - 1];
                    return (
                      <Fragment key={software.id}>
                        <tr className="border-t border-border/50">
                          <td className="py-2.5">
                            <input
                              aria-label={`选择 ${software.name}`}
                              type="checkbox"
                              checked={selected.has(software.id)}
                              onChange={() => toggle(software.id)}
                              disabled={isWorking}
                            />
                          </td>
                          <td className="font-medium">{software.name}</td>
                          <td>{software.currentVersion || "—"}</td>
                          <td>{software.nextVersion || "—"}</td>
                          <td><StatusPill tone={isWorking ? "orange" : "blue"}>{isWorking ? "更新中" : (software.status || "—")}</StatusPill></td>
                          <td className="text-right">
                            <button className={secondaryButtonClass} onClick={() => upgrade([software])} disabled={busy}>
                              {isWorking ? "更新中" : "更新"}
                            </button>
                          </td>
                        </tr>
                        {isWorking && latest && (
                          <tr>
                            <td colSpan={6} className="px-4 pb-2.5 pt-0">
                              <p className="truncate text-[11px] text-muted-foreground" title={latest}>{latest}</p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {!loading && updates.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">当前没有可用更新</p>}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/30 p-2.5 text-xs">
              <span>已选择 {selectedUpdates.length} 项</span>
              <button className={primaryButtonClass} onClick={() => upgrade(selectedUpdates)} disabled={selectedUpdates.length === 0 || busy}>
                {busy ? "处理中" : "更新所选"}
              </button>
            </div>
            {lastAction && <p role="status" className="mt-2 text-xs text-emerald-600">{lastAction}</p>}
          </PanelCard>
        </>
      )}

      {activeSection === "installed" && (
        <PanelCard
          title="已安装软件"
          action={(
            <input
              aria-label="搜索已安装软件"
              value={installedQuery}
              onChange={(event) => setInstalledQuery(event.target.value)}
              placeholder="搜索已安装软件"
              className="h-8 w-48 rounded-lg border bg-background px-3 text-xs"
            />
          )}
        >
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full min-w-[700px] table-fixed text-left text-xs">
              <colgroup><col className="w-[230px]" /><col className="w-[160px]" /><col className="w-[100px]" /><col className="w-[110px]" /><col className="w-[100px]" /><col className="w-[72px]" /></colgroup>
              <thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="pb-2 font-medium">已安装软件</th><th>发布者</th><th>版本</th><th>占用</th><th>安装日期</th><th /></tr></thead>
              <tbody>
                {filteredInstalled.map((software) => (
                  <tr key={software.id} className="border-t border-border/50">
                    <td className="truncate py-2.5 pr-3 font-medium" title={software.name}>{software.name}</td>
                    <td className="truncate pr-3 text-muted-foreground" title={software.publisher || undefined}>{software.publisher || "未知"}</td>
                    <td className="truncate pr-3" title={software.version || undefined}>{software.version || "未知"}</td>
                    <td>{software.estimatedSizeBytes != null ? formatBytes(software.estimatedSizeBytes) : "—"}</td>
                    <td>{software.installDate || "—"}</td>
                    <td><button className="text-blue-600 hover:underline" aria-label={`卸载 ${software.name}`} disabled={busy} onClick={() => { setSelectedInstalledId(software.id); setConfirmingUninstall(true); }}>卸载</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && filteredInstalled.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">没有匹配的已安装软件</p>}
          </div>

          {confirmingUninstall && selectedInstalled && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
              <AlertTriangle className="h-4 w-4 text-orange-600" />
              <span className="flex-1">将通过 WinGet 精确匹配并卸载“{selectedInstalled.name}”。卸载后仅展示检测到的残留候选，不会自动删除。</span>
              <button className={secondaryButtonClass} onClick={() => setConfirmingUninstall(false)}>取消</button>
              <button className={primaryButtonClass} onClick={handleUninstall} aria-label={`确认卸载 ${selectedInstalled.name}`}>确认卸载</button>
            </div>
          )}
        </PanelCard>
      )}

      {activeSection === "uninstall-history" && (
        <PanelCard title="卸载记录" action={<button className={secondaryButtonClass} onClick={maintenance.refresh} disabled={maintenance.loading}>刷新</button>}>
          {maintenance.error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">卸载记录读取失败：{maintenance.error}</p>}
          {!maintenance.error && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-xs">
                <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">时间</th><th>软件</th><th>状态</th><th>详情</th></tr></thead>
                <tbody>
                  {uninstallEvents.map((event) => (
                    <tr key={event.id} className="border-t border-border/50">
                      <td className="py-2.5 text-muted-foreground">{formatRecordTime(event.ts)}</td>
                      <td className="font-medium">{event.title}</td>
                      <td><StatusPill tone={event.status === "成功" ? "green" : "red"}>{event.status}</StatusPill></td>
                      <td className="text-muted-foreground">{event.detail || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!maintenance.loading && uninstallEvents.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">暂无卸载记录</p>}
            </div>
          )}
        </PanelCard>
      )}

      {activeSection === "windows-apps" && <WindowsAppsPanel onHandoff={onHandoff} />}

      {activeSection !== "windows-apps" && <PanelCard title="卸载与残留检测">
        {/* ponytail: WinGet only returns residual candidates after an uninstall completes. */}
        {!lastUninstall && <p className="text-xs text-muted-foreground">完成卸载后，将在此显示检测到的残留候选；系统不会自动删除任何文件。</p>}
        {lastUninstall?.success && lastUninstall.residuals.length === 0 && (
          <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">已确认卸载完成，未发现高置信度残留候选。</p>
        )}
        {lastUninstall?.success && lastUninstall.residuals.length > 0 && (
          <div role="status" className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-orange-700 dark:text-orange-400"><AlertTriangle className="h-4 w-4" />疑似残留，删除前需确认</div>
            {lastUninstall.residuals.map((candidate) => (
              <div key={candidate.path} className="flex flex-wrap items-center gap-2 rounded-md border border-orange-500/20 bg-orange-500/5 px-3 py-2 text-xs">
                <StatusPill tone="orange">{candidate.category}</StatusPill>
                <span className="min-w-0 flex-1 break-all">{candidate.path}</span>
                <span className="text-muted-foreground">{formatBytes(candidate.sizeBytes)}</span>
                <StatusPill tone="neutral">需确认</StatusPill>
              </div>
            ))}
          </div>
        )}
        {lastUninstall && !lastUninstall.success && !uninstallHandedOff && !uninstallDismissed && (
          <TaskFailureNotice
            title={`卸载 ${selectedInstalled?.name ?? "软件"} 失败`}
            detail={lastUninstall.message || "WinGet 未返回详细原因"}
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
                error: lastUninstall.message || "WinGet 未返回详细原因",
              });
            }}
            onDismiss={() => setUninstallDismissed(true)}
          />
        )}
      </PanelCard>}
    </div>
  );
}
