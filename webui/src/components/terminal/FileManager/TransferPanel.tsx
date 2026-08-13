import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Upload,
  Download,
  X,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { TransferTask } from "./types";

interface TransferPanelProps {
  task: TransferTask | null;
  onCancel: () => void;
  onClear: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function TransferPanel({ task, onCancel, onClear }: TransferPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!task) return null;

  const isActive = task.status === "transferring" || task.status === "waiting";
  const isCompleted = task.status === "completed";
  const isError = task.status === "error";
  const isCancelled = task.status === "cancelled";
  const completedFiles = task.files.filter((f) => f.status === "completed").length;

  return (
    <div className="border-t bg-secondary/30">
      <div className="flex items-center justify-between px-3 py-1.5 border-b">
        <div className="flex items-center gap-2 text-caption">
          <span className="font-medium">传输任务</span>
          <span className="text-muted-foreground">
            ({completedFiles}/{task.totalFiles})
          </span>
        </div>
        <div className="flex items-center gap-1">
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-caption gap-1 text-destructive hover:text-destructive"
              onClick={onCancel}
            >
              <X className="h-3 w-3" />
              取消
            </Button>
          )}
          {(isCompleted || isError || isCancelled) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-caption gap-1"
              onClick={onClear}
            >
              清理
            </Button>
          )}
        </div>
      </div>

      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-caption min-w-0">
            {task.type === "upload" ? (
              <Upload className="h-3.5 w-3.5 text-primary shrink-0" />
            ) : (
              <Download className="h-3.5 w-3.5 text-primary shrink-0" />
            )}
            {isActive && <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />}
            {isCompleted && <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />}
            {isError && <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            {isCancelled && <XCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            <span className="truncate">
              {isCompleted
                ? task.type === "upload"
                  ? "上传完成"
                  : "下载完成"
                : isError
                  ? `失败: ${task.error || "未知错误"}`
                  : isCancelled
                    ? "已取消"
                    : task.status === "waiting"
                      ? `等待中: ${task.totalFiles} 个文件`
                      : task.currentFile}
            </span>
          </div>
          <div className="text-caption text-muted-foreground shrink-0 ml-2">
            {isActive && task.status === "transferring" ? task.speed : ""}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {task.totalBytes > 0 ? (
            <Progress
              value={task.progress}
              className={cn(
                "flex-1 h-1.5",
                isActive && "[&>div]:bg-theme",
                isCompleted && "[&>div]:bg-success",
                isError && "[&>div]:bg-destructive",
                isCancelled && "[&>div]:bg-muted-foreground",
              )}
            />
          ) : (
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              {isActive && (
                <div className="h-full bg-theme w-1/3 animate-[indeterminate_1.5s_infinite]" />
              )}
            </div>
          )}
          <span className="text-caption font-medium min-w-[2.5rem] text-right">
            {task.totalBytes > 0 ? `${task.progress}%` : ""}
          </span>
        </div>

        {task.totalBytes > 0 && isActive && (
          <div className="text-micro text-muted-foreground mt-1">
            {formatSize(task.bytesTransferred)} / {formatSize(task.totalBytes)}
          </div>
        )}

        {task.files.length > 1 && (
          <Button
            variant="ghost"
            size="xs"
            className="mt-1 h-auto gap-1 px-0 text-micro text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            文件列表
          </Button>
        )}

        {expanded && (
          <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {task.files.map((file, i) => (
              <div key={i} className="flex items-center gap-1.5 text-micro">
                {file.status === "completed" ? (
                  <CheckCircle className="h-3 w-3 text-success shrink-0" />
                ) : file.status === "transferring" ? (
                  <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
                ) : file.status === "error" ? (
                  <XCircle className="h-3 w-3 text-destructive shrink-0" />
                ) : (
                  <div className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate flex-1">{file.name}</span>
                {file.size > 0 && (
                  <span className="text-muted-foreground shrink-0">
                    {formatSize(file.size)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
