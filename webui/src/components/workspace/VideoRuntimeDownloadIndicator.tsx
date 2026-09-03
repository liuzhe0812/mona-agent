import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Square,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import type {
  VideoRuntimeComponent,
  VideoRuntimeDownloadComponent,
} from "@/lib/api";
import {
  cancelVideoRuntimeDownloads,
  refreshVideoRuntimeDownloads,
  useVideoRuntimeDownloadStore,
} from "@/lib/video-runtime-download-store";
import { useClientContextOrNull } from "@/providers/ClientProvider";

const DOWNLOADABLE_COMPONENTS: VideoRuntimeComponent[] = ["node", "ffmpeg"];

const LABELS: Partial<Record<VideoRuntimeComponent, string>> = {
  node: "Node.js",
  ffmpeg: "FFmpeg",
};

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function componentStatus(component: VideoRuntimeDownloadComponent) {
  if (component.state === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  }
  if (component.state === "failed") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  if (component.state === "downloading") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />;
  }
  return <Download className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function VideoRuntimeDownloadIndicator() {
  const token = useClientContextOrNull()?.token ?? "";
  const jobs = useVideoRuntimeDownloadStore((state) => state.jobs);
  const error = useVideoRuntimeDownloadStore((state) => state.error);
  const clearFinished = useVideoRuntimeDownloadStore(
    (state) => state.clearFinished,
  );
  const active = jobs.some(
    (job) =>
      job.state === "running" &&
      DOWNLOADABLE_COMPONENTS.some((name) => {
        const component = job.components[name];
        return (
          component?.state === "pending" || component?.state === "downloading"
        );
      }),
  );
  const latest =
    jobs.find((job) =>
      DOWNLOADABLE_COMPONENTS.some((name) => Boolean(job.components[name])),
    ) ?? jobs[0];
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    void refreshVideoRuntimeDownloads(token);
  }, [token]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void refreshVideoRuntimeDownloads(token);
    }, 650);
    return () => window.clearInterval(timer);
  }, [active, token]);

  const components = useMemo(() => {
    const latestByName = new Map<
      VideoRuntimeComponent,
      VideoRuntimeDownloadComponent
    >();
    for (const job of jobs) {
      for (const name of DOWNLOADABLE_COMPONENTS) {
        const component = job.components[name];
        if (component && !latestByName.has(name)) {
          latestByName.set(name, component);
        }
      }
    }
    return [...latestByName.values()];
  }, [jobs]);

  if (components.length === 0 && !error) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          aria-label={
            active
              ? `视频组件下载中 ${latest?.progress ?? 0}%`
              : "查看视频组件下载"
          }
          title="视频组件下载"
          className="relative h-9 w-10 rounded-none text-muted-foreground hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-foreground"
        >
          <Download className="h-3.5 w-3.5" />
          {active ? (
            <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <div className="text-ui font-medium">视频组件下载</div>
            <div className="text-micro text-muted-foreground">
              {active
                ? `后台下载中 · ${latest?.progress ?? 0}%`
                : "下载任务已结束"}
            </div>
          </div>
          {active && latest ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-micro text-destructive hover:text-destructive"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void cancelVideoRuntimeDownloads(token, latest.jobId)
                  .catch((cancelError: unknown) => {
                    useVideoRuntimeDownloadStore
                      .getState()
                      .setError(
                        cancelError instanceof Error
                          ? cancelError.message
                          : String(cancelError),
                      );
                  })
                  .finally(() => setCancelling(false));
              }}
            >
              {cancelling ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Square className="mr-1 h-3 w-3" />
              )}
              停止
            </Button>
          ) : !active && jobs.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              title="清除记录"
              onClick={clearFinished}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <div className="space-y-1 p-2">
          {components.map((component) => {
            const percent = component.progress ?? 0;
            return (
              <div
                key={component.component}
                className="rounded-md px-2 py-2 hover:bg-muted/40"
              >
                <div className="flex items-center gap-2">
                  {componentStatus(component)}
                  <span className="text-caption font-medium">
                    {LABELS[component.component]}
                  </span>
                  <span className="ml-auto text-micro text-muted-foreground">
                    {component.state === "completed"
                      ? "已安装"
                      : component.state === "failed"
                        ? "失败"
                        : component.state === "pending"
                          ? "等待中"
                          : component.progress === null
                            ? "处理中"
                            : `${percent}%`}
                  </span>
                </div>
                {component.state === "downloading" ? (
                  <div className="mt-1.5">
                    <Progress value={percent} className="h-1" />
                    <div className="mt-1 text-micro text-muted-foreground tabular-nums">
                      {component.totalBytes > 0
                        ? `${formatBytes(component.receivedBytes)} / ${formatBytes(component.totalBytes)}`
                        : "正在安装组件…"}
                    </div>
                  </div>
                ) : null}
                {component.error ? (
                  <div className="mt-1 text-micro text-destructive">
                    {component.error}
                  </div>
                ) : null}
              </div>
            );
          })}
          {error ? (
            <div className="px-2 py-1 text-micro text-destructive">{error}</div>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
