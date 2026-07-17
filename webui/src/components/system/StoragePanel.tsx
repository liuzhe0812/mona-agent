import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Database, Eraser, FolderSearch, HardDrive, Loader2, PieChart, RefreshCw } from "lucide-react";
import { useState } from "react";

import { MetricCard, PanelCard, ProgressBar, primaryButtonClass, secondaryButtonClass } from "./SystemUi";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import {
  formatGb,
  formatPercent,
  useStorageScan,
  useSystemOverview,
  type CleanupItem,
  type DirectorySize,
  type FileTypeSize,
  type ScanProgress,
  type StorageDiskInfo,
  type StorageScanResult,
} from "./useSystemData";

function formatStorage(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${formatGb(gb)} GB`;
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return "尚未扫描";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function AnalysisPlaceholder({
  status,
  progress,
  error,
}: {
  status: string;
  progress: ScanProgress | null;
  error: string | null;
}) {
  if (status === "scanning") {
    return (
      <div className="flex h-[154px] flex-col items-center justify-center gap-2 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <p className="text-xs font-medium">正在扫描磁盘...</p>
        <p className="max-w-full truncate text-[10px] text-muted-foreground" title={progress?.currentPath}>
          {progress?.currentPath ?? "正在准备扫描"}
        </p>
        {progress && <p className="text-[10px] text-muted-foreground">已处理 {progress.scannedDirs} 个扫描区域 · {progress.elapsedSecs.toFixed(1)} 秒</p>}
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex h-[154px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-xs text-red-600">扫描失败：{error}</p>
        <p className="text-[10px] text-muted-foreground">点击顶部"重新扫描"重试</p>
      </div>
    );
  }
  return (
    <div className="flex h-[154px] flex-col items-center justify-center gap-2 text-center">
      <FolderSearch className="h-7 w-7 text-blue-600" />
      <div>
        <p className="text-xs font-medium">等待深度空间分析</p>
        <p className="mt-1 text-[10px] text-muted-foreground">点击顶部"开始扫描"显示真实占用</p>
      </div>
    </div>
  );
}

function ScanStatusBar({
  status,
  result,
  lastScanAt,
  progress,
  error,
  onScan,
  onHandoff,
}: {
  status: string;
  result: StorageScanResult | null;
  lastScanAt: number | null;
  progress: ScanProgress | null;
  error: string | null;
  onScan: () => void;
  onHandoff: (task: SystemAgentHandoffTask) => void;
}) {
  const scanning = status === "scanning";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {scanning ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />
            <span className="truncate">
              正在扫描{progress ? ` · 已处理 ${progress.scannedDirs} 个区域 · ${progress.elapsedSecs.toFixed(0)} 秒` : ""}
            </span>
          </>
        ) : status === "error" ? (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
            <span role="alert" className="truncate">扫描失败：{error ?? "未知错误"}</span>
          </>
        ) : result ? (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate">
              上次扫描：{formatRelativeTime(lastScanAt)} · {result.directories.length} 个区域 · {formatStorage(result.totalScannedGb)}
            </span>
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
            <span>尚未扫描，点击右侧按钮开始分析磁盘占用</span>
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {status === "error" && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => onHandoff({
              id: crypto.randomUUID(),
              title: "扫描存储空间",
              action: "扫描存储空间",
              target: "本机磁盘",
              arguments: {},
              error: error ?? "未知错误",
            })}
          >交给 Mona</button>
        )}
        <button
          type="button"
          className={secondaryButtonClass}
          onClick={onScan}
          disabled={scanning}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
          {result ? "重新扫描" : "开始扫描"}
        </button>
      </div>
    </div>
  );
}

function DiskPartitionList({ disks }: { disks: StorageDiskInfo[] }) {
  return (
    <PanelCard title="磁盘分区" className="h-full">
      {disks.length === 0 ? (
        <div className="flex h-[154px] items-center justify-center text-xs text-muted-foreground">正在读取磁盘信息</div>
      ) : (
        <div className="space-y-5 text-xs">
          {disks.map((disk) => (
            <div key={disk.driveLetter}>
              <div className="mb-2 flex justify-between gap-2">
                <span className="truncate font-medium" title={disk.driveLetter}>{disk.driveLetter}</span>
                <span className="shrink-0 text-muted-foreground">{formatPercent(disk.usagePercent)} 已使用</span>
              </div>
              <ProgressBar value={disk.usagePercent} color={disk.usagePercent >= 90 ? "bg-red-500" : disk.usagePercent >= 80 ? "bg-orange-500" : "bg-blue-500"} />
              <p className="mt-1 text-[10px] text-muted-foreground">{formatStorage(disk.usedGb)} / {formatStorage(disk.totalGb)}</p>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

const TREEMAP_TONES = [
  "bg-blue-500/75",
  "bg-violet-500/70",
  "bg-emerald-500/65",
  "bg-amber-400/70",
  "bg-cyan-500/60",
  "bg-indigo-400/60",
];

function SpaceDistribution({
  directories,
  status,
  progress,
  error,
}: {
  directories: DirectorySize[];
  status: string;
  progress: ScanProgress | null;
  error: string | null;
}) {
  const handleOpen = (path: string) => {
    revealItemInDir(path).catch((err) => console.error("revealItemInDir failed:", err));
  };
  return (
    <PanelCard title="空间分布（扫描区域）" className="h-full">
      {directories.length === 0 ? (
        <AnalysisPlaceholder status={status} progress={progress} error={error} />
      ) : (
        <div className="grid h-[200px] grid-cols-2 grid-rows-3 gap-1 overflow-hidden rounded-lg text-white">
          {directories.slice(0, 4).map((directory, index) => (
            <button
              type="button"
              key={directory.path}
              onClick={() => handleOpen(directory.path)}
              title={`${directory.path} · ${formatStorage(directory.sizeGb)}（点击打开目录）`}
              className={`${TREEMAP_TONES[index]} flex min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 overflow-hidden rounded-md p-1.5 text-center transition hover:brightness-110 hover:ring-2 hover:ring-white/60 ${index === 0 ? "row-span-3" : index === 1 ? "row-span-2" : ""}`}
            >
              <span className="max-w-full truncate text-[11px] font-medium leading-tight">{directory.path.split("\\").filter(Boolean).pop() ?? directory.path}</span>
              <span className="text-[10px] leading-tight text-white/90">{formatStorage(directory.sizeGb)}</span>
            </button>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

function FileTypePanel({
  items,
  status,
  progress,
  error,
}: {
  items: FileTypeSize[];
  status: string;
  progress: ScanProgress | null;
  error: string | null;
}) {
  const max = Math.max(...items.map((item) => item.sizeGb), 0);
  const colors = ["bg-blue-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500", "bg-slate-500", "bg-slate-400"];
  return (
    <PanelCard title="文件类型（扫描区域）" className="h-full">
      {items.length === 0 ? (
        <AnalysisPlaceholder status={status} progress={progress} error={error} />
      ) : (
        <div className="space-y-3 text-xs">
          {items.map((item, index) => (
            <div key={item.category} className="grid grid-cols-[42px_minmax(0,1fr)_70px] items-center gap-2">
              <span>{item.category}</span>
              <ProgressBar value={max > 0 ? (item.sizeGb / max) * 100 : 0} color={colors[index]} />
              <span className="text-right text-[10px] text-muted-foreground">{formatStorage(item.sizeGb)}</span>
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

function DirectoryTable({
  directories,
  status,
  progress,
  error,
  onAnalyze,
}: {
  directories: DirectorySize[];
  status: string;
  progress: ScanProgress | null;
  error: string | null;
  onAnalyze?: (goal: string) => void;
}) {
  return (
    <PanelCard title="占用最大的目录（扫描区域）" className="h-full">
      {directories.length === 0 ? (
        <AnalysisPlaceholder status={status} progress={progress} error={error} />
      ) : (
        <div className="overflow-x-hidden">
          <table className="w-full table-fixed text-left text-[11px]">
            <colgroup><col /><col className="w-16" /><col className="w-16" /><col className="w-12" /></colgroup>
            <thead className="text-muted-foreground"><tr><th className="pb-2 font-medium">路径</th><th>大小</th><th>文件数</th><th>操作</th></tr></thead>
            <tbody>
              {directories.slice(0, 8).map((directory) => (
                <tr key={directory.path} className="border-t border-border/50">
                  <td className="truncate py-2.5 pr-3 font-medium" title={directory.path}>{directory.path}</td>
                  <td>{formatStorage(directory.sizeGb)}</td>
                  <td>{directory.fileCount.toLocaleString()}</td>
                  <td><button className="text-blue-600 hover:underline" onClick={() => onAnalyze?.(`分析目录「${directory.path}」的空间使用情况（当前占用 ${formatStorage(directory.sizeGb)}，共 ${directory.fileCount.toLocaleString()} 个文件）。请识别可安全清理的子目录、大文件类型、临时缓存和冗余数据，评估每项可释放的空间与风险等级，给出具体的空间优化建议。`)}>分析</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  );
}

function CleanupPanel({
  items,
  status,
  progress,
  error,
  onClean,
  cleaning,
  onHandoff,
}: {
  items: CleanupItem[];
  status: string;
  progress: ScanProgress | null;
  error: string | null;
  onClean: ReturnType<typeof useStorageScan>["clean"];
  cleaning: boolean;
  onHandoff: (task: SystemAgentHandoffTask) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(items.filter((item) => item.cleanable && item.recommended && item.sizeGb > 0).map((item) => item.id)));
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [failedTask, setFailedTask] = useState<SystemAgentHandoffTask | null>(null);
  const selectedItems = items.filter((item) => selected.has(item.id) && item.cleanable && item.sizeGb > 0);
  const selectedSize = selectedItems.reduce((sum, item) => sum + item.sizeGb, 0);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const clean = async () => {
    try {
      const result = await onClean(selectedItems.map((item) => item.id));
      setNotice(result.failures.length > 0 ? `已释放 ${formatStorage(result.freedGb)}，${result.failures.length} 项未完成` : `清理完成，实际释放 ${formatStorage(result.freedGb)}`);
      setFailedTask(result.failures.length > 0 ? {
        id: crypto.randomUUID(),
        title: "清理存储空间",
        action: "清理存储空间",
        target: selectedItems.map((item) => item.name).join("、"),
        arguments: { ids: selectedItems.map((item) => item.id) },
        error: result.failures.join("；"),
      } : null);
      setSelected(new Set());
    } catch (cleanupError) {
      const error = String(cleanupError);
      setNotice(`清理失败：${error}`);
      setFailedTask({
        id: crypto.randomUUID(),
        title: "清理存储空间",
        action: "清理存储空间",
        target: selectedItems.map((item) => item.name).join("、"),
        arguments: { ids: selectedItems.map((item) => item.id) },
        error,
      });
    } finally {
      setConfirming(false);
    }
  };

  return (
    <PanelCard title="安全清理" className="h-full">
      {items.length === 0 ? (
        <AnalysisPlaceholder status={status} progress={progress} error={error} />
      ) : (
        <>
          <div className="overflow-x-hidden">
            <table className="w-full table-fixed text-left text-[11px]">
              <colgroup><col className="w-8" /><col /><col className="w-20" /><col className="w-24" /></colgroup>
              <thead className="text-muted-foreground"><tr><th /><th className="pb-2 font-medium">项目</th><th>扫描结果</th><th>处理方式</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-border/50">
                    <td className="py-2.5"><input aria-label={`选择 ${item.name}`} type="checkbox" checked={selected.has(item.id)} disabled={!item.cleanable || item.sizeGb <= 0} onChange={() => toggle(item.id)} /></td>
                    <td className="truncate pr-2 font-medium" title={`${item.path} · ${item.reason}`}>{item.name}</td>
                    <td>{formatStorage(item.sizeGb)}</td>
                    <td className={item.cleanable ? "text-emerald-600" : "text-muted-foreground"}>{item.cleanable ? "可直接清理" : "交由 Windows"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs">
            <span className="text-muted-foreground">已选择 {selectedItems.length} 项 · 可释放 {formatStorage(selectedSize)}</span>
            <div className="flex gap-2">
              <button className={secondaryButtonClass} onClick={() => setNotice(selectedItems.length > 0 ? selectedItems.map((item) => `${item.name} ${formatStorage(item.sizeGb)}`).join("；") : "请先选择可清理项目")}>预览清单</button>
              <button className={primaryButtonClass} disabled={selectedItems.length === 0 || cleaning} onClick={() => setConfirming(true)}>安全清理</button>
            </div>
          </div>
          {confirming && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
              <span className="min-w-0 flex-1">确认删除所选缓存和临时文件？正在使用的文件会自动跳过。</span>
              <button className={secondaryButtonClass} onClick={() => setConfirming(false)}>取消</button>
              <button className={primaryButtonClass} onClick={() => void clean()} disabled={cleaning}>{cleaning ? "正在清理" : "确认清理"}</button>
            </div>
          )}
           {notice && (
             <div role={failedTask ? "alert" : "status"} className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
               <span>{notice}</span>
               {failedTask && <button type="button" className={secondaryButtonClass} onClick={() => onHandoff(failedTask)}>交给 Mona</button>}
             </div>
           )}
        </>
      )}
    </PanelCard>
  );
}

export function StoragePanel({ scan, onHandoff, onAnalyze }: { scan: ReturnType<typeof useStorageScan>; onHandoff: (task: SystemAgentHandoffTask) => void; onAnalyze?: (goal: string) => void }) {
  const { status, result, lastScanAt, progress, error, cleaning, start, clean } = scan;
  const { data: overview, error: overviewError } = useSystemOverview();
  const disks = result?.disks ?? overview?.disks ?? [];
  const directories = result?.directories ?? [];
  const fileTypes = result?.fileTypes ?? [];
  const cleanupItems = result?.cleanupItems ?? [];
  const totalUsed = disks.reduce((sum, disk) => sum + disk.usedGb, 0);
  const totalCapacity = disks.reduce((sum, disk) => sum + disk.totalGb, 0);
  const totalAvailable = disks.reduce((sum, disk) => sum + disk.availableGb, 0);
  const usedPercent = totalCapacity > 0 ? (totalUsed / totalCapacity) * 100 : 0;
  const cleanupTotal = cleanupItems.filter((item) => item.cleanable).reduce((sum, item) => sum + item.sizeGb, 0);

  return (
    <div className="space-y-3">
      <ScanStatusBar status={status} result={result} lastScanAt={lastScanAt} progress={progress} error={error} onScan={start} onHandoff={onHandoff} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="总容量" value={disks.length ? formatStorage(totalCapacity) : "—"} detail={disks.length ? `${disks.length} 个本地磁盘` : "正在读取实时信息"} icon={<HardDrive className="h-4 w-4" />} />
        <MetricCard label="已使用" value={disks.length ? formatStorage(totalUsed) : "—"} detail={disks.length ? formatPercent(usedPercent) : "实时磁盘数据"} icon={<PieChart className="h-4 w-4" />} accent="violet" />
        <MetricCard label="可用" value={disks.length ? formatStorage(totalAvailable) : "—"} detail={disks.length ? formatPercent(100 - usedPercent) : "无需深度扫描"} icon={<Database className="h-4 w-4" />} accent="green" />
        <MetricCard label="可安全释放" value={result ? formatStorage(cleanupTotal) : "待分析"} detail={result ? `${cleanupItems.filter((item) => item.cleanable && item.sizeGb > 0).length} 项可直接清理` : "深度扫描后计算"} icon={<Eraser className="h-4 w-4" />} accent="orange" />
      </div>

      {overviewError && <p role="alert" className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs text-orange-700">实时磁盘信息读取失败：{overviewError}</p>}

      <div className="grid gap-3 lg:grid-cols-[0.72fr_1.08fr_1.05fr]">
        <DiskPartitionList disks={disks} />
        <SpaceDistribution directories={directories} status={status} progress={progress} error={error} />
        <FileTypePanel items={fileTypes} status={status} progress={progress} error={error} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.08fr_1fr]">
        <DirectoryTable directories={directories} status={status} progress={progress} error={error} onAnalyze={onAnalyze} />
        <CleanupPanel items={cleanupItems} status={status} progress={progress} error={error} onClean={clean} cleaning={cleaning} onHandoff={onHandoff} />
      </div>
    </div>
  );
}
