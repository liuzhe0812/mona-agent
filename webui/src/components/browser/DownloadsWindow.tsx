import { useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
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
  ExternalLink,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/useTheme";
import { useDownloads } from "@/hooks/useDownloads";
import { browserHideDownloads } from "@/lib/browser-ipc";
import type { DownloadInfo } from "@/lib/browser-ipc";

const WIDTH = 360;
const MAX_HEIGHT = 480;
const COMPACT_COUNT = 5;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时`;
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

interface DownloadCardItemProps {
  download: DownloadInfo;
  onCancel: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onOpen: (id: string) => void;
  onReveal: (id: string) => void;
  onRemove: (id: string) => void;
}

function DownloadCardItem({
  download,
  onCancel,
  onPause,
  onResume,
  onOpen,
  onReveal,
  onRemove,
}: DownloadCardItemProps) {
  const { state, receivedBytes, totalBytes, filename, bytesPerSecond } = download;
  const isInProgress = state === "in_progress";
  const isInterrupted = state === "interrupted";
  const isCompleted = state === "completed";
  const isCancelled = state === "cancelled";
  const isFinished = isCompleted || isCancelled;
  const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
  const eta =
    isInProgress && totalBytes > 0 && (bytesPerSecond ?? 0) > 0
      ? formatEta((totalBytes - receivedBytes) / (bytesPerSecond ?? 1))
      : "";

  return (
    <div className="group flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
      </div>

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
              : `${formatBytes(receivedBytes)} / ${totalBytes > 0 ? formatBytes(totalBytes) : "?"} · ${percent}%${eta ? ` · 剩余 ${eta}` : ""}`}
          </span>
        </div>
      </div>

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
              <ExternalLink className="h-3 w-3" />
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

export function DownloadsWindow() {
  useTheme();
  const {
    downloads,
    cancelDownload,
    pauseDownload,
    resumeDownload,
    openDownload,
    revealDownload,
    removeDownload,
  } = useDownloads();
  const [fullMode, setFullMode] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // 悬浮窗不可聚焦（无焦点事件）；鼠标移入时通知主窗口取消自动隐藏
  const handleMouseEnter = () => {
    void emit("browser-downloads-interacted");
  };

  // 根据内容自适应窗口高度
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const height = Math.ceil(el.getBoundingClientRect().height);
    const clamped = Math.min(MAX_HEIGHT, Math.max(140, height));
    void getCurrentWindow()
      .setSize(new LogicalSize(WIDTH, clamped))
      .catch(() => {});
  }, [downloads.length, fullMode]);

  const visibleDownloads = fullMode ? downloads : downloads.slice(0, COMPACT_COUNT);

  return (
    <div
      ref={contentRef}
      onMouseEnter={handleMouseEnter}
      className="flex max-h-[480px] flex-col overflow-hidden rounded-xl border border-border bg-popover"
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-2">
        <span className="text-[13px] font-medium">
          {fullMode ? "下载记录" : "近期的下载记录"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => void browserHideDownloads()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 下载列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {visibleDownloads.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Download className="mb-2 h-8 w-8 opacity-50" />
            <span className="text-[12px]">暂无下载记录</span>
          </div>
        ) : (
          visibleDownloads.map((download) => (
            <DownloadCardItem
              key={download.id}
              download={download}
              onCancel={cancelDownload}
              onPause={pauseDownload}
              onResume={resumeDownload}
              onOpen={openDownload}
              onReveal={revealDownload}
              onRemove={removeDownload}
            />
          ))
        )}
      </div>

      {/* 底部：完整的下载记录 */}
      {!fullMode && downloads.length > 0 && (
        <button
          type="button"
          className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px] text-foreground transition-colors hover:bg-muted/40"
          onClick={() => setFullMode(true)}
        >
          <span>完整的下载记录</span>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
