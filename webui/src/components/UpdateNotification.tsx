import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
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
import { DOWNLOAD_URL } from "@/lib/constants";
import {
  isTauri,
  checkForUpdates,
  performUpdate,
  type UpdateCheckResult,
  type UpdateProgress,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

type UpdateView =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; info: UpdateCheckResult }
  | { kind: "upToDate" }
  | { kind: "error"; message: string }
  | { kind: "updating"; progress: UpdateProgress | null }
  | { kind: "done" };

interface UpdateNotificationProps {
  /**
   * Controlled badge visibility. When an update is available, the parent can
   * render a badge somewhere (e.g. on the settings button) by reading this
   * ref-backed state. We expose it via a callback.
   */
  onUpdateAvailable?: (info: UpdateCheckResult | null) => void;
}

const STAGE_LABELS: Record<string, string> = {
  downloading: "下载更新包",
  extracting: "解压更新包",
  stopping: "停止网关",
  installing: "安装更新",
  restarting: "重启应用",
};

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function UpdateNotification({
  onUpdateAvailable,
}: UpdateNotificationProps) {
  const [toastVisible, setToastVisible] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useState<UpdateView>({ kind: "idle" });
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackMessage, setFallbackMessage] = useState<string>("");
  const toastTimerRef = useRef<number | null>(null);

  // Load current version on mount
  useEffect(() => {
    if (!isTauri()) return;
    (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setCurrentVersion(await getVersion());
      } catch {
        // ignore
      }
    })();
  }, []);

  // Listen for auto-check "update-available" events from the backend
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenAvailable: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenAvailable = await listen<UpdateCheckResult>(
          "update-available",
          (event) => {
            const info = event.payload;
            if (info?.has_update) {
              setView({ kind: "available", info });
              onUpdateAvailable?.(info);
              // Show toast notification (non-intrusive)
              setToastVisible(true);
              // Auto-dismiss toast after 12 seconds if user doesn't interact
              if (toastTimerRef.current) {
                window.clearTimeout(toastTimerRef.current);
              }
              toastTimerRef.current = window.setTimeout(() => {
                setToastVisible(false);
              }, 12_000);
            }
          },
        );
        unlistenProgress = await listen<UpdateProgress>(
          "update-progress",
          (event) => {
            setView({ kind: "updating", progress: event.payload });
          },
        );
        unlistenFailed = await listen<{ message: string; download_url: string }>(
          "update-download-failed",
          (event) => {
            setView({ kind: "error", message: event.payload.message });
            setFallbackMessage(event.payload.message);
            setFallbackOpen(true);
          },
        );
      } catch {
        // ignore
      }
    })();

    return () => {
      unlistenAvailable?.();
      unlistenProgress?.();
      unlistenFailed?.();
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, [onUpdateAvailable]);

  const dismissToast = useCallback(() => {
    setToastVisible(false);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setView({ kind: "checking" });
    try {
      const result = await checkForUpdates();
      if (result.has_update) {
        setView({ kind: "available", info: result });
        onUpdateAvailable?.(result);
      } else {
        setView({ kind: "upToDate" });
      }
    } catch (e) {
      setView({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [onUpdateAvailable]);

  const handlePerformUpdate = useCallback(async () => {
    setView({ kind: "updating", progress: null });
    try {
      await performUpdate();
      // performUpdate calls process::exit(0), so this may not be reached
      setView({ kind: "done" });
    } catch (e) {
      setView({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const openDialogFromToast = useCallback(() => {
    dismissToast();
    setDialogOpen(true);
  }, [dismissToast]);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      // Don't allow closing during update
      if (view.kind === "updating") return;
      setDialogOpen(open);
      if (!open && view.kind === "idle") {
        // Reset to idle when closing if no action taken
      }
    },
    [view.kind],
  );

  const isUpdating = view.kind === "updating";
  const availableInfo = view.kind === "available" ? view.info : null;

  return (
    <>
      {/* Toast notification (auto-show on startup detection) */}
      {toastVisible && availableInfo ? (
        <div className="fixed bottom-5 right-5 z-50 w-[360px] max-w-[calc(100vw-2.5rem)] animate-in slide-in-from-bottom-4 fade-in-0 duration-300">
          <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-popover/95 p-4 shadow-[0_18px_55px_rgba(15,23,42,0.18)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_22px_55px_rgba(0,0,0,0.45)]">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
                <Sparkles className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-5 text-foreground">
                  发现新版本 v{availableInfo.latest_version}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
                  当前版本 v{availableInfo.current_version}
                  {availableInfo.size
                    ? ` · ${formatSize(availableInfo.size)}`
                    : ""}
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={openDialogFromToast}
                    className="h-7 rounded-full px-3 text-[12px]"
                  >
                    <Download className="mr-1 h-3 w-3" aria-hidden />
                    立即更新
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={dismissToast}
                    className="h-7 rounded-full px-3 text-[12px] text-muted-foreground"
                  >
                    稍后
                  </Button>
                </div>
              </div>
              <button
                type="button"
                onClick={dismissToast}
                aria-label="关闭"
                className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Progress bar accent at bottom */}
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-blue-500/0 via-blue-500/60 to-blue-500/0" />
          </div>
        </div>
      ) : null}

      {/* Fallback dialog when auto-download fails */}
      <Dialog open={fallbackOpen} onOpenChange={setFallbackOpen}>
        <DialogContent className="max-w-[420px] gap-0 p-0">
          <DialogHeader className="px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-destructive/10 text-destructive">
                <AlertCircle className="h-5 w-5" />
              </span>
              <div>
                <DialogTitle className="text-[17px] font-semibold tracking-[-0.01em]">
                  自动下载失败
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-[12px]">
                  无法从更新服务器下载安装包
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="px-6 pb-4">
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3">
              <p className="text-[13px] leading-5 text-destructive">
                {fallbackMessage}
              </p>
            </div>
            <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
              你可以前往官网手动下载最新版安装包进行重装。
            </p>
          </div>
          <DialogFooter className="flex-row items-center justify-end gap-2 px-6 pb-6 pt-2">
            <Button
              variant="outline"
              onClick={() => setFallbackOpen(false)}
              className="rounded-full"
            >
              取消
            </Button>
            <Button
              onClick={() => {
                setFallbackOpen(false);
                window.open(DOWNLOAD_URL, "_blank");
              }}
              className="rounded-full"
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              前往官网下载
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Update dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          showCloseButton={!isUpdating}
          className="max-w-[440px] gap-0 p-0"
        >
          <DialogHeader className="px-6 pt-6 pb-4">
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-2xl",
                  view.kind === "upToDate"
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                    : view.kind === "error"
                      ? "bg-destructive/10 text-destructive"
                      : view.kind === "done"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                        : "bg-blue-500/10 text-blue-600 dark:text-blue-300",
                )}
              >
                {view.kind === "checking" ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : view.kind === "upToDate" ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : view.kind === "error" ? (
                  <AlertCircle className="h-5 w-5" />
                ) : view.kind === "done" ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <Sparkles className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-[17px] font-semibold tracking-[-0.01em]">
                  {view.kind === "checking"
                    ? "正在检查更新"
                    : view.kind === "available"
                      ? "发现新版本"
                      : view.kind === "upToDate"
                        ? "已是最新版本"
                        : view.kind === "error"
                          ? "更新失败"
                          : view.kind === "updating"
                            ? "正在更新"
                            : view.kind === "done"
                              ? "更新完成"
                              : "软件更新"}
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-[12px]">
                  {view.kind === "available"
                    ? `v${view.info.current_version} → v${view.info.latest_version}`
                    : currentVersion
                      ? `当前版本 v${currentVersion}`
                      : "Mona Desktop"}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Body */}
          <div className="px-6 pb-2">
            {view.kind === "idle" ? (
              <p className="text-[13px] leading-5 text-muted-foreground">
                检查是否有新版本可用，新版本包含功能改进和问题修复。
              </p>
            ) : null}

            {view.kind === "checking" ? (
              <p className="text-[13px] leading-5 text-muted-foreground">
                正在从更新服务器获取版本信息...
              </p>
            ) : null}

            {view.kind === "available" ? (
              <div className="space-y-3">
                <div className="rounded-xl border border-border/55 bg-muted/30 p-3">
                  <div className="mb-1.5 flex items-center justify-between text-[12px]">
                    <span className="font-medium text-muted-foreground">
                      版本信息
                    </span>
                    {view.info.size ? (
                      <span className="text-muted-foreground">
                        {formatSize(view.info.size)}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="text-muted-foreground">
                      v{view.info.current_version}
                    </span>
                    <span className="text-muted-foreground/60">→</span>
                    <span className="font-semibold text-foreground">
                      v{view.info.latest_version}
                    </span>
                  </div>
                </div>
                {view.info.notes ? (
                  <div className="max-h-[180px] overflow-y-auto rounded-xl border border-border/55 bg-muted/20 p-3">
                    <p className="mb-1 text-[12px] font-medium text-muted-foreground">
                      更新内容
                    </p>
                    <p className="whitespace-pre-wrap text-[13px] leading-5 text-foreground/90">
                      {view.info.notes}
                    </p>
                  </div>
                ) : null}
                <p className="text-[12px] leading-4 text-muted-foreground">
                  更新过程中将短暂停止网关服务，更新完成后应用会自动重启。
                </p>
              </div>
            ) : null}

            {view.kind === "upToDate" ? (
              <p className="text-[13px] leading-5 text-muted-foreground">
                你已经在使用最新版本，无需更新。
              </p>
            ) : null}

            {view.kind === "error" ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                <p className="text-[13px] leading-5 text-destructive">
                  {view.message}
                </p>
                <p className="mt-1.5 text-[12px] leading-4 text-muted-foreground">
                  请检查网络连接后重试，或稍后再试。
                </p>
              </div>
            ) : null}

            {view.kind === "updating" ? (
              <UpdateProgressView progress={view.progress} />
            ) : null}

            {view.kind === "done" ? (
              <p className="text-[13px] leading-5 text-muted-foreground">
                更新已完成，应用即将重启。
              </p>
            ) : null}
          </div>

          {/* Footer */}
          <DialogFooter className="flex-row items-center justify-end gap-2 px-6 pb-6 pt-3">
            {view.kind === "idle" || view.kind === "upToDate" || view.kind === "error" || view.kind === "done" ? (
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                className="rounded-full"
                disabled={isUpdating}
              >
                关闭
              </Button>
            ) : null}
            {view.kind === "idle" || view.kind === "error" || view.kind === "upToDate" || view.kind === "checking" ? (
              <Button
                onClick={handleCheckUpdate}
                disabled={view.kind === "checking"}
                className="rounded-full"
              >
                {view.kind === "checking" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {view.kind === "checking" ? "检查中..." : "检查更新"}
              </Button>
            ) : null}
            {view.kind === "available" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  className="rounded-full"
                >
                  稍后再说
                </Button>
                <Button
                  onClick={handlePerformUpdate}
                  className="rounded-full"
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  立即更新
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UpdateProgressView({ progress }: { progress: UpdateProgress | null }) {
  const percent = progress?.percent ?? 0;
  const stage = progress?.stage ?? "";
  const message = progress?.message ?? "准备中...";
  const stageLabel = STAGE_LABELS[stage] ?? "处理中";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-300" />
        <span className="text-[13px] font-medium text-foreground">
          {stageLabel}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-300 ease-out"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-muted-foreground">{message}</span>
        <span className="font-medium tabular-nums text-foreground">
          {percent}%
        </span>
      </div>
      <p className="text-[12px] leading-4 text-muted-foreground">
        请勿关闭应用，更新完成后将自动重启。
      </p>
    </div>
  );
}
