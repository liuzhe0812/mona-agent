import { CheckCircle, Download, Loader2, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RuntimeDepKey = "node" | "ffmpeg" | "chrome";

interface RuntimeItem {
  ok: boolean;
  version?: string;
  path?: string;
}

interface VideoRuntimeDialogProps {
  open: boolean;
  onClose: () => void;
  runtimeStatus: Record<RuntimeDepKey, RuntimeItem>;
  /** Key of the dependency currently being installed, null when idle. */
  installing: RuntimeDepKey | null;
  /** Per-dependency install error messages, keyed by dep key. */
  installErrors: Partial<Record<RuntimeDepKey, string>>;
  /** Install all missing deps (no arg) or retry a single dep. */
  onInstall: (component?: RuntimeDepKey) => void;
}

const DEPS: Array<{ key: RuntimeDepKey; label: string }> = [
  { key: "node", label: "Node.js" },
  { key: "ffmpeg", label: "FFmpeg" },
  { key: "chrome", label: "Chrome" },
];

export function VideoRuntimeDialog({
  open,
  onClose,
  runtimeStatus,
  installing,
  installErrors,
  onInstall,
}: VideoRuntimeDialogProps) {
  const isInstalling = installing !== null;
  const hasMissing = DEPS.some((d) => !runtimeStatus[d.key].ok);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !isInstalling && onClose()}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>视频运行环境</DialogTitle>
          <DialogDescription>
            视频导出需要以下组件支持。缺失组件可一键下载安装。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {DEPS.map((dep) => {
            const status = runtimeStatus[dep.key];
            const isThisInstalling = installing === dep.key;
            const depError = installErrors[dep.key];

            return (
              <div
                key={dep.key}
                className="flex items-center gap-3 rounded-lg border border-border/70 p-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {isThisInstalling ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : status.ok ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium">{dep.label}</span>
                  {isThisInstalling ? (
                    <span className="text-[12px] text-muted-foreground">
                      正在安装，请稍候…
                    </span>
                  ) : status.ok ? (
                    <span className="truncate text-[12px] text-muted-foreground">
                      {status.version ?? "已安装"}
                    </span>
                  ) : depError ? (
                    <span className="text-[12px] text-destructive" role="alert">
                      {depError}
                    </span>
                  ) : (
                    <span className="text-[12px] text-destructive">未安装</span>
                  )}
                </div>
                {!status.ok && !isThisInstalling && depError ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[12px]"
                    onClick={() => onInstall(dep.key)}
                    disabled={isInstalling}
                    aria-label={`重试安装 ${dep.label}`}
                  >
                    <RefreshCw className="h-3 w-3" />
                    重试
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="secondary"
            onClick={() => onInstall()}
            disabled={isInstalling || !hasMissing}
            className="gap-1.5"
          >
            {isInstalling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {hasMissing ? "一键下载缺失组件" : "所有组件已就绪"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={isInstalling}>
            稍后再说
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
