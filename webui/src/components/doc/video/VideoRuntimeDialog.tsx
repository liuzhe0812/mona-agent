import { CheckCircle, Download, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

interface RuntimeItem {
  ok: boolean;
  version?: string;
  path?: string;
}

interface VideoRuntimeDialogProps {
  open: boolean;
  onClose: () => void;
  runtimeStatus: {
    node: RuntimeItem;
    ffmpeg: RuntimeItem;
    chrome: RuntimeItem;
  };
  onDownload: () => void;
  downloadProgress?: {
    component: string;
    progress: number;
  } | null;
}

const DEPS: Array<{ key: "node" | "ffmpeg" | "chrome"; label: string }> = [
  { key: "node", label: "Node.js" },
  { key: "ffmpeg", label: "FFmpeg" },
  { key: "chrome", label: "Chrome" },
];

export function VideoRuntimeDialog({
  open,
  onClose,
  runtimeStatus,
  onDownload,
  downloadProgress,
}: VideoRuntimeDialogProps) {
  const isDownloading = !!downloadProgress;
  const hasMissing =
    !runtimeStatus.node.ok || !runtimeStatus.ffmpeg.ok || !runtimeStatus.chrome.ok;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>视频运行环境</DialogTitle>
          <DialogDescription>
            视频生成需要以下组件支持。缺失组件可一键下载安装。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {DEPS.map((dep) => {
            const status = runtimeStatus[dep.key];
            const isThisDownloading =
              isDownloading && downloadProgress!.component === dep.key;

            return (
              <div
                key={dep.key}
                className="flex items-center gap-3 rounded-lg border border-border/70 p-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {isThisDownloading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : status.ok ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium">{dep.label}</span>
                  {isThisDownloading ? (
                    <span className="text-[11px] text-muted-foreground">
                      下载中 {Math.round(downloadProgress!.progress)}%
                    </span>
                  ) : status.ok ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {status.version ?? "已安装"}
                    </span>
                  ) : (
                    <span className="text-[11px] text-destructive">未安装</span>
                  )}
                </div>
                {isThisDownloading ? (
                  <Progress
                    value={downloadProgress!.progress}
                    className="h-1.5 w-20"
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {isDownloading ? (
          <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>正在下载 {downloadProgress!.component}…</span>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="secondary"
            onClick={onDownload}
            disabled={isDownloading || !hasMissing}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {hasMissing ? "一键下载缺失组件" : "所有组件已就绪"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isDownloading}>
            稍后再说
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
