import {
  Download,
  X,
  Pause,
  Play,
  FolderOpen,
  FileIcon,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDownloads } from "@/hooks/useDownloads";
import type { DownloadInfo } from "@/lib/browser-ipc";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(received: number, total: number): string {
  if (total > 0) {
    const percent = Math.round((received / total) * 100);
    return `${percent}%`;
  }
  return formatBytes(received);
}

function getStateLabel(state: string): string {
  switch (state) {
    case "in_progress":
      return "下载中";
    case "interrupted":
      return "已暂停";
    case "completed":
      return "已完成";
    case "cancelled":
      return "已取消";
    default:
      return state;
  }
}

function getStateIcon(state: string) {
  switch (state) {
    case "in_progress":
      return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />;
    case "interrupted":
      return <Pause className="h-3 w-3 text-amber-500" />;
    case "completed":
      return <CheckCircle2 className="h-3 w-3 text-green-500" />;
    case "cancelled":
      return <AlertCircle className="h-3 w-3 text-muted-foreground" />;
    default:
      return null;
  }
}

interface DownloadItemProps {
  download: DownloadInfo;
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
  onRemove: (id: string) => void;
}

function DownloadItem({
  download,
  onCancel,
  onPause,
  onResume,
  onOpen,
  onReveal,
  onRemove,
}: DownloadItemProps) {
  const { state, receivedBytes, totalBytes, filename } = download;
  const isInProgress = state === "in_progress";
  const isInterrupted = state === "interrupted";
  const isCompleted = state === "completed";
  const isCancelled = state === "cancelled";
  const isFinished = isCompleted || isCancelled;
  const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;

  return (
    <div className="group flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors">
      {/* 文件图标 */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* 文件信息 + 进度 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-medium" title={filename}>
            {filename}
          </span>
          {getStateIcon(state)}
        </div>
        <div className="mt-1 flex items-center gap-2">
          {isInProgress || isInterrupted ? (
            <Progress value={percent} className="h-1 flex-1" />
          ) : (
            <div className="h-1 flex-1" />
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {isFinished
              ? getStateLabel(state)
              : `${formatBytes(receivedBytes)} / ${totalBytes > 0 ? formatBytes(totalBytes) : "?"} · ${formatSpeed(receivedBytes, totalBytes)}`}
          </span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isInProgress && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="暂停"
            onClick={() => onPause(download.id)}
          >
            <Pause className="h-3 w-3" />
          </Button>
        )}
        {isInterrupted && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="恢复"
            onClick={() => onResume(download.id)}
          >
            <Play className="h-3 w-3" />
          </Button>
        )}
        {isInProgress && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="取消"
            onClick={() => onCancel(download.id)}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
        {isCompleted && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title="打开文件"
            onClick={() => onOpen(download.id)}
          >
            <FolderOpen className="h-3 w-3" />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" title="更多">
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {isCompleted && (
              <DropdownMenuItem onClick={() => onOpen(download.id)}>
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                打开文件
              </DropdownMenuItem>
            )}
            {(isCompleted || isCancelled) && (
              <DropdownMenuItem onClick={() => onReveal(download.id)}>
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                在文件夹中显示
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onRemove(download.id)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              从列表中移除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export interface DownloadBarProps {
  /** 是否展开面板（受控模式） */
  open: boolean;
  /** 切换展开/收起 */
  onOpenChange: (open: boolean) => void;
}

export function DownloadBar({ open, onOpenChange }: DownloadBarProps) {
  const {
    downloads,
    hasActiveDownloads,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    openDownload,
    revealDownload,
    removeDownload,
    clearCompleted,
  } = useDownloads();

  const activeCount = downloads.filter(
    (d) => d.state === "in_progress" || d.state === "interrupted"
  ).length;

  const completedCount = downloads.filter((d) => d.state === "completed").length;

  if (downloads.length === 0) return null;

  return (
    <div className="border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {/* 头部：标题 + 操作 */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="flex items-center gap-2 text-[12px] font-medium hover:opacity-80 transition-opacity"
        >
          <Download className="h-3.5 w-3.5" />
          <span>下载</span>
          {activeCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
              {activeCount}
            </span>
          )}
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          )}
        </button>

        <div className="flex items-center gap-1">
          {completedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={clearCompleted}
              title="清除已完成"
            >
              清除已完成
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={open ? "收起" : "展开"}
            onClick={() => onOpenChange(!open)}
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {/* 下载列表（展开时显示） */}
      {open && (
        <div className="max-h-64 border-t border-border">
          <ScrollArea className="h-full max-h-64">
            <div className="divide-y divide-border/50">
              {downloads.map((d) => (
                <DownloadItem
                  key={d.id}
                  download={d}
                  onCancel={cancelDownload}
                  onPause={pauseDownload}
                  onResume={resumeDownload}
                  onOpen={openDownload}
                  onReveal={revealDownload}
                  onRemove={removeDownload}
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* 收起时的进度摘要 */}
      {!open && hasActiveDownloads && (
        <div className="px-3 pb-1.5">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              {activeCount} 个下载进行中
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
