import {
  CheckCircle,
  Download,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

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
import type { VideoRuntimeComponent } from "@/lib/api";
import { useVideoRuntimeDownloadStore } from "@/lib/video-runtime-download-store";

export type RuntimeDepKey = VideoRuntimeComponent | "chrome";

interface RuntimeItem {
  ok: boolean;
  version?: string;
  path?: string;
}

interface VideoRuntimeDialogProps {
  open: boolean;
  onClose: () => void;
  runtimeStatus: Record<RuntimeDepKey, RuntimeItem>;
  /** Install all missing deps (no arg) or retry a single dep. */
  onInstall: (component?: RuntimeDepKey) => void;
}

const DEPS: Array<{ key: RuntimeDepKey; label: string }> = [
  { key: "node", label: "Node.js" },
  { key: "ffmpeg", label: "FFmpeg" },
  { key: "chrome", label: "系统浏览器（Edge / Chrome）" },
];

const DOWNLOADABLE_DEPS: VideoRuntimeComponent[] = ["node", "ffmpeg"];

function isDownloadableDep(key: RuntimeDepKey): key is VideoRuntimeComponent {
  return key !== "chrome";
}

export function VideoRuntimeDialog({
  open,
  onClose,
  runtimeStatus,
  onInstall,
}: VideoRuntimeDialogProps) {
  const jobs = useVideoRuntimeDownloadStore((state) => state.jobs);
  const latestJob = jobs[0];
  const isInstalling = latestJob?.state === "running";
  const hasMissing = DEPS.some((d) => !runtimeStatus[d.key].ok);
  const hasDownloadableMissing = DOWNLOADABLE_DEPS.some(
    (key) => !runtimeStatus[key].ok,
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>视频运行环境</DialogTitle>
          <DialogDescription>
            视频导出会检查 Node.js、FFmpeg 和系统 Edge / Chrome。Node.js 与
            FFmpeg 可由 Mona 下载，浏览器请使用系统已安装的版本。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {DEPS.map((dep) => {
            const status = runtimeStatus[dep.key];
            const download = isDownloadableDep(dep.key)
              ? latestJob?.components[dep.key]
              : undefined;
            const isThisInstalling = download?.state === "downloading";
            const isWaiting = download?.state === "pending";
            const completed = status.ok || download?.state === "completed";
            const depError = download?.error;

            return (
              <div
                key={dep.key}
                className="relative flex items-center gap-3 rounded-lg border border-border/70 p-3 pb-4"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {isThisInstalling ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : completed ? (
                    <CheckCircle className="h-4 w-4 text-green-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ui font-medium">{dep.label}</span>
                  {isThisInstalling ? (
                    <span className="text-caption text-muted-foreground">
                      正在安装，请稍候…
                    </span>
                  ) : completed ? (
                    <span className="truncate text-caption text-muted-foreground">
                      {status.version ?? "已安装"}
                    </span>
                  ) : isWaiting ? (
                    <span className="text-caption text-muted-foreground">
                      等待下载…
                    </span>
                  ) : depError ? (
                    <span
                      className="text-caption text-destructive"
                      role="alert"
                    >
                      {depError}
                    </span>
                  ) : (
                    <span className="text-caption text-destructive">
                      {dep.key === "chrome"
                        ? "请安装系统 Edge 或 Chrome 后再导出"
                        : "未安装"}
                    </span>
                  )}
                </div>
                {isThisInstalling ? (
                  <span className="text-caption tabular-nums text-muted-foreground">
                    {download?.progress === null
                      ? "处理中"
                      : `${download?.progress ?? 0}%`}
                  </span>
                ) : !completed && !isWaiting && depError ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-caption"
                    onClick={() => onInstall(dep.key)}
                    disabled={isInstalling}
                    aria-label={`重试安装 ${dep.label}`}
                  >
                    <RefreshCw className="h-3 w-3" />
                    重试
                  </Button>
                ) : null}
                {isThisInstalling ? (
                  <div className="absolute inset-x-3 bottom-1">
                    <Progress value={download?.progress ?? 0} className="h-1" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {hasDownloadableMissing ? (
            <Button
              variant="secondary"
              onClick={() => onInstall()}
              disabled={isInstalling}
              className="gap-1.5"
            >
              {isInstalling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              一键下载缺失组件
            </Button>
          ) : !hasMissing ? (
            <Button
              variant="secondary"
              disabled
              className="gap-1.5"
            >
              <CheckCircle className="h-3.5 w-3.5" />
              所有组件已就绪
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {isInstalling
              ? "关闭，后台继续"
              : hasDownloadableMissing || !hasMissing
                ? "稍后再说"
                : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
