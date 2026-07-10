import { CheckCircle, Download, Loader2, Workflow, XCircle } from "lucide-react";

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

interface FlowchartRuntimeDialogProps {
  open: boolean;
  onClose: () => void;
  runtimeOk: boolean;
  onDownload: () => void;
  downloadProgress: number | null; // 0-100, null 表示未在下载
}

export function FlowchartRuntimeDialog({
  open,
  onClose,
  runtimeOk,
  onDownload,
  downloadProgress,
}: FlowchartRuntimeDialogProps) {
  const isDownloading = downloadProgress !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>draw.io 运行环境</DialogTitle>
          <DialogDescription>
            流程图生成需要 draw.io 组件支持。组件缺失时可一键下载安装。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-lg border border-border/70 p-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              {isDownloading ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : runtimeOk ? (
                <CheckCircle className="h-4 w-4 text-green-600" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center gap-1.5">
                <Workflow className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[13px] font-medium">draw.io</span>
              </div>
              {isDownloading ? (
                <span className="text-[11px] text-muted-foreground">
                  下载中 {Math.round(downloadProgress!)}%
                </span>
              ) : runtimeOk ? (
                <span className="text-[11px] text-muted-foreground">已就绪</span>
              ) : (
                <span className="text-[11px] text-destructive">未安装</span>
              )}
            </div>
            {isDownloading ? (
              <Progress value={downloadProgress!} className="h-1.5 w-20" />
            ) : null}
          </div>
        </div>

        {isDownloading ? (
          <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>正在下载 draw.io…</span>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="secondary"
            onClick={onDownload}
            disabled={isDownloading || runtimeOk}
            className="gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            {runtimeOk ? "组件已就绪" : "立即下载"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isDownloading}>
            稍后再说
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
