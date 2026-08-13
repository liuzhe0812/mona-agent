import { useState, useMemo } from "react";
import {
  ArrowLeft,
  Download,
  Search,
  X,
  Trash2,
  FolderOpen,
  Pause,
  Play,
  FileText,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useDownloads } from "@/hooks/useDownloads";
import type { DownloadInfo } from "@/lib/browser-ipc";

interface DownloadsPageProps {
  onBack: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond?: number): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatRemaining(received: number, total: number, speed?: number): string {
  if (!speed || speed <= 0 || total <= 0 || received >= total) return "";
  const seconds = Math.ceil((total - received) / speed);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes} 分 ${remain} 秒`;
}

function getFileName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function getFileExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

function getStatusLabel(state: string): string {
  switch (state) {
    case "in_progress":
      return "下载中";
    case "completed":
      return "已完成";
    case "interrupted":
      return "已中断";
    case "cancelled":
      return "已取消";
    default:
      return state;
  }
}

function DownloadItem({
  download,
  onCancel,
  onPause,
  onResume,
  onOpen,
  onReveal,
  onRemove,
}: {
  download: DownloadInfo;
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const filename = getFileName(download.savePath) || download.filename;
  const ext = getFileExt(filename);
  const isInProgress = download.state === "in_progress";
  const isInterrupted = download.state === "interrupted";
  const isCompleted = download.state === "completed";
  const progress = download.totalBytes > 0
    ? Math.min(100, (download.receivedBytes / download.totalBytes) * 100)
    : 0;

  return (
    <div className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent transition-colors">
      {/* 文件图标 */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/50">
        {isInProgress ? (
          <Loader2 className="h-4 w-4 animate-spin text-info" />
        ) : isCompleted ? (
          <FileText className="h-4 w-4 text-muted-foreground" />
        ) : (
          <FileText className="h-4 w-4 text-muted-foreground/50" />
        )}
      </div>

      {/* 文件信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui font-medium">{filename}</span>
          {ext && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-micro uppercase text-muted-foreground">
              {ext}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-micro text-muted-foreground">
          {isInProgress ? (
            <>
              <span>{formatBytes(download.receivedBytes)} / {formatBytes(download.totalBytes)}</span>
              {formatSpeed(download.bytesPerSecond) && (
                <>
                  <span>·</span>
                  <span>{formatSpeed(download.bytesPerSecond)}</span>
                </>
              )}
              {formatRemaining(download.receivedBytes, download.totalBytes, download.bytesPerSecond) && (
                <>
                  <span>·</span>
                  <span>剩余 {formatRemaining(download.receivedBytes, download.totalBytes, download.bytesPerSecond)}</span>
                </>
              )}
            </>
          ) : isCompleted ? (
            <>
              <span>{formatBytes(download.totalBytes || download.receivedBytes)}</span>
              <span>·</span>
              <span className="flex items-center gap-0.5">
                <CheckCircle2 className="h-3 w-3 text-success" />
                {getStatusLabel(download.state)}
              </span>
            </>
          ) : isInterrupted ? (
            <span className="flex items-center gap-0.5 text-warning">
              <AlertCircle className="h-3 w-3" />
              {getStatusLabel(download.state)}
            </span>
          ) : (
            <span>{getStatusLabel(download.state)}</span>
          )}
        </div>
        {/* 进度条 */}
        {isInProgress && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-info transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="flex shrink-0 items-center gap-1">
        {isInProgress && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="暂停"
              onClick={() => void onPause(download.id)}
            >
              <Pause className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="取消"
              onClick={() => void onCancel(download.id)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {isInterrupted && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="继续"
            onClick={() => void onResume(download.id)}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        )}
        {isCompleted && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="打开"
              onClick={() => void onOpen(download.id)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="在文件夹中显示"
              onClick={() => void onReveal(download.id)}
            >
              <FileText className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {!isInProgress && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
            title="从列表中移除"
            onClick={() => void onRemove(download.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export function DownloadsPage({ onBack }: DownloadsPageProps) {
  const {
    downloads,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    openDownload,
    revealDownload,
    removeDownload,
  } = useDownloads();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredDownloads = useMemo(() => {
    if (!searchQuery.trim()) return downloads;
    const q = searchQuery.toLowerCase();
    return downloads.filter(
      (d) =>
        getFileName(d.savePath).toLowerCase().includes(q) ||
        d.url.toLowerCase().includes(q) ||
        d.filename.toLowerCase().includes(q)
    );
  }, [downloads, searchQuery]);

  // 按状态分组：进行中在最前，然后是已中断，最后是已完成/已取消
  const sortedDownloads = useMemo(() => {
    const order = (state: string) => {
      if (state === "in_progress") return 0;
      if (state === "interrupted") return 1;
      if (state === "completed") return 2;
      return 3;
    };
    return [...filteredDownloads].sort((a, b) => {
      const r = order(a.state) - order(b.state);
      if (r !== 0) return r;
      // 同组内按最新在前（id 倒序，假设 id 是递增的）
      return b.id.localeCompare(a.id);
    });
  }, [filteredDownloads]);

  const inProgressCount = downloads.filter((d) => d.state === "in_progress").length;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack} title="返回">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Download className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-body font-semibold">下载记录</h1>
        {inProgressCount > 0 && (
          <span className="rounded-full bg-info/15 px-2 py-0.5 text-micro text-info">
            {inProgressCount} 个进行中
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 w-56 rounded-full border-0 bg-muted/50 pl-7 pr-7 text-caption"
              placeholder="搜索下载..."
            />
            {searchQuery && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 下载列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hover">
        <div className="mx-auto max-w-3xl px-4 py-4">
          {sortedDownloads.length === 0 ? (
            <EmptyState
              icon={<Download className="h-5 w-5" />}
              title={searchQuery ? "未找到匹配的下载" : "暂无下载记录"}
              className="h-32 py-0"
            />
          ) : (
            <div className="space-y-0.5">
              {sortedDownloads.map((download) => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  onCancel={cancelDownload}
                  onPause={pauseDownload}
                  onResume={resumeDownload}
                  onOpen={openDownload}
                  onReveal={revealDownload}
                  onRemove={removeDownload}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
