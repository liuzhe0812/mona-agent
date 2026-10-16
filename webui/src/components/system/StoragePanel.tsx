import { Eraser, Globe, FileText, FolderOpen, HardDrive, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ProgressBar } from "./SystemUi";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { DirectoryTreeView, findPathChain } from "./storage/DirectoryTreeView";
import { LargeFileTable } from "./storage/LargeFileTable";
import { TreemapView } from "./storage/TreemapView";
import { formatPercent, formatStorage, useSystemOverview, type CleanupItem, type DirectorySize, type TopFileInfo, type useStorageScan } from "./useSystemData";

const diskActionClassName = "h-7 min-w-6 px-0 text-muted-foreground";

function findNode(nodes: DirectorySize[], path: string): DirectorySize | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = node.children && findNode(node.children, path);
    if (found) return found;
  }
  return null;
}

export function StoragePanel({ scan, onHandoff, onSelectionChange, onAnalyzeFile, analyzingFileId, onAnalyzeDirectory }: {
  scan: ReturnType<typeof useStorageScan>;
  onHandoff: (task: SystemAgentHandoffTask) => void;
  onSelectionChange?: (directory: DirectorySize | null) => void;
  onAnalyzeFile?: (file: TopFileInfo) => void;
  analyzingFileId?: string | null;
  onAnalyzeDirectory?: (directory: DirectorySize) => void;
}) {
  const { data: overview, error: overviewError } = useSystemOverview();
  const [breadcrumb, setBreadcrumb] = useState<Array<{ path: string; name: string }>>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [section, setSection] = useState("cleanup");
  const [cleanupTarget, setCleanupTarget] = useState<{ item: CleanupItem; drive: string; scanId: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState<{ title: string; detail: string; task?: SystemAgentHandoffTask } | null>(null);
  const directories = scan.result?.directories ?? [];
  const disks = overview?.disks ?? scan.result?.disks ?? [];
  const currentPath = breadcrumb.at(-1)?.path ?? null;
  const currentDirectory = currentPath ? findNode(directories, currentPath) : null;
  const selectedDirectory = useMemo(() => selectedPath ? findNode(directories, selectedPath) : null, [directories, selectedPath]);
  const cleanupItems = (scan.result?.cleanupItems ?? []).filter((item) => item.cleanable && item.sizeGb > 0);

  useEffect(() => { setBreadcrumb([]); setSelectedPath(null); }, [scan.selectedDrive, scan.result?.scanId]);
  useEffect(() => { onSelectionChange?.(selectedDirectory); }, [onSelectionChange, selectedDirectory]);
  useEffect(() => {
    if (disks.length && scan.status !== "scanning" && !disks.some((disk) => disk.driveLetter.startsWith(scan.selectedDrive))) {
      scan.selectDrive(disks[0].driveLetter.trim().slice(0, 2).toUpperCase());
    }
  }, [disks, scan.selectedDrive, scan.status, scan.selectDrive]);

  const openFolder = async (path: string) => {
    try { await invoke("system_open_in_explorer", { path }); }
    catch (error) { setFailure({ title: "无法打开位置", detail: String(error) }); }
  };
  const startScan = async (drive: string) => {
    if (!await scan.start(drive)) setFailure({ title: "磁盘扫描未完成", detail: "请重新扫描；已有扫描结果仍可查看。" });
  };
  const drillDown = (path: string) => {
    setSelectedPath(path);
    setBreadcrumb((findPathChain(directories, path) ?? [path]).map((entry) => ({ path: entry, name: entry.split("\\").filter(Boolean).at(-1) ?? entry })));
  };
  const analyzeDirectory = (path: string) => {
    const directory = findNode(directories, path);
    if (!directory) return;
    setSelectedPath(path);
    onAnalyzeDirectory?.(directory);
  };
  const confirmCleanup = async () => {
    if (!cleanupTarget || scan.cleaningIds.has(cleanupTarget.item.id)) return;
    const target = cleanupTarget.item;
    setCleanupTarget(null);
    if (cleanupTarget.drive !== scan.selectedDrive || cleanupTarget.scanId !== scan.result?.scanId) {
      setFailure({ title: "清理内容已变化", detail: "请查看当前清理项目后重新确认。" });
      return;
    }
    setNotice("");
    try {
      const result = await scan.clean([target.id]);
      if (result.failures.length) setFailure({
        title: "部分内容未能清理",
        detail: `实际释放 ${formatStorage(result.freedGb)}。\n${result.failures.join("\n")}`,
        task: { id: crypto.randomUUID(), title: `清理${target.name}`, action: "清理存储空间", target: target.name, arguments: { ids: [target.id] }, error: result.failures.join("；") },
      });
      else setNotice(`${cleanupTarget.drive} ${target.name}清理完成，实际释放 ${formatStorage(result.freedGb)}`);
    } catch (error) { setFailure({ title: "无法确认清理结果", detail: `请重新扫描确认剩余内容后再重试。\n${String(error)}` }); }
  };

  return <div className="space-y-6">
    <div role="group" aria-label="磁盘" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
      {disks.map((disk) => {
        const drive = disk.driveLetter.trim().slice(0, 2).toUpperCase();
        const selected = scan.selectedDrive === drive;
        const scanning = selected && scan.status === "scanning";
        const removable = scan.result?.disks.find((item) => item.driveLetter === disk.driveLetter)?.isRemovable;
        const low = disk.usagePercent >= 90;
        const scanLabel = scanning ? "正在扫描" : scan.result && selected ? "重新扫描" : "开始扫描";
        return <div key={drive} role="group" aria-label={`${drive} 磁盘`} style={{ containerType: "inline-size" }} className={cn("group relative flex min-w-0 flex-col rounded-lg p-3 transition-colors hover:bg-accent/30 focus-within:bg-accent/30", selected && "bg-accent/30")}>
          <Button type="button" variant="ghost" aria-label={`查看 ${drive} 磁盘`} aria-pressed={selected} disabled={scan.status === "scanning" && !selected} onClick={() => { scan.selectDrive(drive); setBreadcrumb([]); setSelectedPath(null); }} className="block h-auto w-full p-0 text-left font-normal hover:bg-transparent">
            <div className="flex items-center gap-3 pr-16 [@container(min-width:360px)]:pr-48">
              <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", selected ? "bg-info/10 text-info" : "bg-muted text-muted-foreground")}><HardDrive className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-caption font-medium">{drive} {drive === "C:" ? "系统盘" : removable ? "移动磁盘" : "磁盘"}</span>
                  {low && <span className="shrink-0 rounded-md bg-warning/10 px-1.5 py-0.5 text-micro text-warning">空间不足</span>}
                </div>
                <p className="text-title-sm font-semibold">{formatPercent(disk.usagePercent)}</p>
              </div>
            </div>
            <div className="mt-3"><ProgressBar value={disk.usagePercent} color={low ? "bg-warning" : "bg-info"} /></div>
            <p className="mt-2 text-micro text-muted-foreground">可用 {formatStorage(disk.availableGb)} / 共 {formatStorage(disk.totalGb)}</p>
          </Button>
          {scanning && <p role="status" className="mt-2 truncate text-micro text-muted-foreground" title={scan.progress?.currentPath}>正在扫描磁盘…{scan.progress ? `已处理 ${scan.progress.scannedDirs} 个区域` : ""}</p>}
          <div className={cn("absolute right-3 top-3 flex h-7 items-center justify-end gap-3 whitespace-nowrap transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", scanning ? "opacity-100" : "opacity-0")}>
            {!removable && <Button variant="text" size="sm" className={diskActionClassName} title={scanLabel} aria-label={`${selected ? "" : drive + " "}${scanLabel}`} aria-busy={scanning} disabled={scan.status === "scanning"} onClick={() => void startScan(drive)}>
              {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin [@container(min-width:360px)]:mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 [@container(min-width:360px)]:mr-1.5" />}<span className="hidden [@container(min-width:360px)]:inline">{scanLabel}</span>
            </Button>}
            {scanning ? <Button variant="text" size="sm" className={diskActionClassName} title="取消扫描" aria-label="取消扫描" onClick={() => void scan.cancel()}><X className="h-3.5 w-3.5 [@container(min-width:360px)]:mr-1.5" /><span className="hidden [@container(min-width:360px)]:inline">取消扫描</span></Button> : <Button variant="text" size="sm" className={diskActionClassName} title="打开磁盘" aria-label={`打开 ${drive} 磁盘`} onClick={() => void openFolder(`${drive}\\`)}><FolderOpen className="h-3.5 w-3.5 [@container(min-width:360px)]:mr-1.5" /><span className="hidden [@container(min-width:360px)]:inline">打开磁盘</span></Button>}
          </div>
        </div>;
      })}
      {disks.length === 0 && <p role="status" className="py-4 text-caption text-muted-foreground">{overviewError ? "暂时无法读取磁盘，请稍后重试。" : "正在读取磁盘…"}</p>}
    </div>

    <div id="storage-distribution">
      {directories.length ? <>
        <div className="flex flex-wrap items-start gap-6">
          <div className="h-72 min-w-0 flex-1 basis-64"><DirectoryTreeView directories={directories} currentPath={currentPath} selectedPath={selectedPath} onSelect={setSelectedPath} onDrillDown={drillDown} onAnalyze={onAnalyzeDirectory ? analyzeDirectory : undefined} /></div>
          <div className="min-w-0 flex-[1.5] basis-96"><TreemapView directories={currentDirectory?.children ?? directories} currentTotalGb={currentDirectory?.sizeGb ?? scan.result?.totalScannedGb} breadcrumb={breadcrumb} loading={false} error={null} selectedPath={selectedPath} onSelect={setSelectedPath} onDrillDown={drillDown} onAnalyze={onAnalyzeDirectory ? analyzeDirectory : undefined} onNavigate={(path) => {
            setBreadcrumb((previous) => path ? previous.slice(0, previous.findIndex((entry) => entry.path === path) + 1) : []);
            setSelectedPath(path);
          }} /></div>
        </div>
      </> : <div className="flex h-48 items-center justify-center text-caption text-muted-foreground">{scan.status === "scanning" ? "正在扫描磁盘…" : scan.status === "error" ? "扫描未完成，请重新扫描。" : "选择磁盘并开始扫描，查看目录占用和可清理内容。"}</div>}
    </div>

    <Tabs value={section} onValueChange={setSection}>
      <TabsList aria-label="存储文件操作" className="h-auto justify-start gap-2 rounded-none bg-transparent p-0 [&_[role=tab]]:shadow-none">
        <TabsTrigger id="storage-cleanup" value="cleanup" className="rounded-sm px-3 py-1.5 font-normal data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:shadow-none">清理空间</TabsTrigger>
        <TabsTrigger id="storage-large-files" value="files" className="rounded-sm px-3 py-1.5 font-normal data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:shadow-none">大文件</TabsTrigger>
      </TabsList>
      <TabsContent value="cleanup">
        {cleanupItems.length ? <table className="w-full table-fixed text-left text-caption">
          <colgroup><col /><col className="w-24" /><col className="w-16" /></colgroup>
          <thead className="text-muted-foreground [&_th:not(:last-child)]:border-r [&_th]:border-border/60"><tr className="h-8 bg-muted/60"><th scope="col" className="px-3 py-1 font-normal">项目</th><th scope="col" className="px-3 py-1 font-normal">预计释放</th><th scope="col" className="px-3 py-1 text-right font-normal">操作</th></tr></thead>
          <tbody>{cleanupItems.map((item) => {
            const busy = scan.cleaningIds.has(item.id);
            const Icon = item.id === "trash" ? Trash2 : /chrome|edge|browser/.test(item.id) ? Globe : FileText;
            return <tr key={item.id} className="border-b border-border/30 last:border-b-0">
              <td className="px-3 py-2.5"><div className="flex min-w-0 items-center gap-2.5"><Icon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate" title={item.name}>{item.name}</span></div></td>
              <td className="px-3 tabular-nums">{formatStorage(item.sizeGb)}</td>
              <td className="px-3 text-right"><Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" title={busy ? `正在清理${item.name}` : `清理${item.name}`} aria-label={busy ? `正在清理${item.name}` : `清理${item.name}`} aria-busy={busy} disabled={busy} onClick={() => { if (scan.result) setCleanupTarget({ item, drive: scan.selectedDrive, scanId: scan.result.scanId }); }}>{busy ? <Loader2 className="h-4 w-4 animate-spin text-info" aria-hidden="true" /> : <Eraser className="h-4 w-4" aria-hidden="true" />}</Button></td>
            </tr>;
          })}</tbody>
        </table> : <p className="py-4 text-caption text-muted-foreground">{scan.result ? "当前磁盘未发现可直接清理的项目。" : "扫描后显示可清理项目。"}</p>}
        {scan.cleaning && <p role="status" className="mt-2 text-micro text-muted-foreground">清理在后台进行，可继续操作其他内容。</p>}
        {notice && <p role="status" className="mt-2 text-caption text-muted-foreground">{notice}</p>}
      </TabsContent>
      <TabsContent value="files"><LargeFileTable files={scan.result?.topFiles ?? []} onTrash={scan.trashFiles} onAnalyze={onAnalyzeFile} analyzingFileId={analyzingFileId} /></TabsContent>
    </Tabs>

    <AlertDialog open={cleanupTarget !== null} onOpenChange={(open) => { if (!open) setCleanupTarget(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认清理</AlertDialogTitle><AlertDialogDescription>{cleanupTarget?.item.id === "trash" ? `将永久删除回收站中的文件，预计释放 ${formatStorage(cleanupTarget.item.sizeGb)}。清空后无法从回收站恢复。` : `将直接删除${cleanupTarget?.item.name}，预计释放 ${formatStorage(cleanupTarget?.item.sizeGb ?? 0)}，不经过回收站。正在使用的文件会自动跳过。`}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button variant="destructive" onClick={() => void confirmCleanup()}>确认清理</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={failure !== null} onOpenChange={(open) => { if (!open) setFailure(null); }}>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{failure?.title}</AlertDialogTitle><AlertDialogDescription>请检查当前内容后再重试。</AlertDialogDescription></AlertDialogHeader><details className="text-caption"><summary>查看详情</summary><pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{failure?.detail}</pre></details><AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel>{failure?.task && <Button variant="outline" onClick={() => { if (failure.task) onHandoff(failure.task); setFailure(null); }}>交给 Mona</Button>}</AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </div>;
}
