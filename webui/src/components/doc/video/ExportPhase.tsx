import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  Download,
  Film,
  Loader2,
  RefreshCw,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import {
  buildVideoDownloadUrl,
  buildVideoPreviewFullUrl,
  exportVideoProject,
  fetchVideoExportStatus,
  getApiBase,
  type VideoExportStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type ExportQuality = "draft" | "standard" | "high";

interface ExportPhaseProps {
  projectName: string;
}

const QUALITY_OPTIONS: Array<{ value: ExportQuality; label: string; hint: string }> = [
  { value: "draft", label: "Draft", hint: "24fps · 半分辨率" },
  { value: "standard", label: "Standard", hint: "30fps · 原分辨率" },
  { value: "high", label: "High", hint: "60fps · 原分辨率" },
];

export function ExportPhase({ projectName }: ExportPhaseProps) {
  const { token } = useClient();
  const [quality, setQuality] = useState<ExportQuality>("standard");
  const [status, setStatus] = useState<VideoExportStatus>({
    stage: "idle",
    progress: 0,
  });
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build preview URL on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await getApiBase();
      if (cancelled) return;
      setPreviewUrl(buildVideoPreviewFullUrl(base, token, projectName));
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  // Initial status fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchVideoExportStatus(token, projectName);
        if (cancelled) return;
        setStatus(s);
        if (s.hasVideo) {
          const base = await getApiBase();
          if (cancelled) return;
          setDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  // Poll while rendering
  useEffect(() => {
    if (status.stage !== "rendering") {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await fetchVideoExportStatus(token, projectName);
        if (cancelled) return;
        setStatus(s);
        if (s.stage === "done" && s.hasVideo) {
          const base = await getApiBase();
          if (cancelled) return;
          setDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
          return;
        }
        if (s.stage === "error") {
          setError(s.message ?? "渲染失败");
          return;
        }
      } catch {
        // ignore transient errors
      }
      if (!cancelled) {
        pollTimerRef.current = setTimeout(poll, 2000);
      }
    };
    pollTimerRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [status.stage, token, projectName]);

  const handleExport = useCallback(async () => {
    setError(null);
    setActionLoading(true);
    try {
      const res = await exportVideoProject(token, projectName, { quality });
      if (!res.ok) {
        setError(res.error ?? "导出失败");
        return;
      }
      setStatus({ stage: "rendering", progress: 0, message: "准备渲染..." });
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
    }
  }, [token, projectName, quality]);

  const handleDownload = useCallback(async () => {
    if (!downloadUrl) return;
    // Use the existing download URL (handled by VideoMakerView's chrome-style download
    // for Tauri; in browser, fall back to anchor with download attribute).
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `${projectName}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [downloadUrl, projectName]);

  const isRendering = status.stage === "rendering";
  const isDone = status.stage === "done" && status.hasVideo;
  const hasError = status.stage === "error";

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧:整片预览 */}
      <div className="min-w-0 flex-1 bg-muted/30">
        {previewUrl ? (
          <iframe
            src={previewUrl}
            title={`${projectName} 整片预览`}
            className="h-full w-full border-0 bg-background"
            sandbox="allow-scripts allow-same-origin"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载预览...
          </div>
        )}
      </div>

      {/* 右侧:导出控制面板 */}
      <div className="flex w-[360px] shrink-0 flex-col border-l border-border/70 bg-background">
        <div className="shrink-0 border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <Film className="h-4 w-4" />
            导出视频
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            将所有场景合成为 MP4
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hover p-4">
          {/* 质量选择 */}
          <div className="mb-4">
            <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
              质量
            </div>
            <div className="grid grid-cols-3 gap-1">
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={isRendering || actionLoading}
                  onClick={() => setQuality(opt.value)}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-[11px] transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    quality === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/50 hover:bg-muted text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {QUALITY_OPTIONS.find((o) => o.value === quality)?.hint}
            </div>
          </div>

          {/* 渲染状态 */}
          {isRendering && (
            <div className="mb-4 rounded-md border border-border/70 bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                渲染中
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.min(status.progress, 100)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{status.message ?? "处理中..."}</span>
                <span>{Math.round(status.progress)}%</span>
              </div>
            </div>
          )}

          {/* 错误状态 */}
          {hasError && (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                渲染失败
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {error ?? status.message}
              </div>
              {status.needDownload && (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  请在视频模块首页下载 Chrome Headless Shell 与 FFmpeg 后重试
                </div>
              )}
            </div>
          )}

          {/* 完成状态 */}
          {isDone && (
            <div className="mb-4 rounded-md border border-green-500/30 bg-green-500/5 p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-green-700">
                <CheckCircle className="h-3.5 w-3.5" />
                渲染完成
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                {status.duration && (
                  <>
                    <span>时长</span>
                    <span className="text-foreground">{status.duration}s</span>
                  </>
                )}
                {status.fps && (
                  <>
                    <span>帧率</span>
                    <span className="text-foreground">{status.fps}fps</span>
                  </>
                )}
                {status.totalFrames && (
                  <>
                    <span>总帧数</span>
                    <span className="text-foreground">{status.totalFrames}</span>
                  </>
                )}
                {status.resolution && (
                  <>
                    <span>分辨率</span>
                    <span className="text-foreground">
                      {status.resolution[0]}×{status.resolution[1]}
                    </span>
                  </>
                )}
                <span>音轨</span>
                <span className="text-foreground">
                  {status.audio ? "已合成旁白" : "无"}
                </span>
              </div>
            </div>
          )}

          {error && !hasError && (
            <div className="mb-4 text-[11px] text-destructive">{error}</div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="shrink-0 space-y-2 border-t border-border/70 p-3">
          {!isDone && (
            <Button
              className="w-full text-[12px]"
              onClick={handleExport}
              disabled={isRendering || actionLoading}
            >
              {isRendering || actionLoading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : hasError ? (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Film className="mr-1.5 h-3.5 w-3.5" />
              )}
              {hasError ? "重新导出" : isRendering ? "渲染中..." : "开始导出 MP4"}
            </Button>
          )}
          {isDone && (
            <>
              <Button
                className="w-full text-[12px]"
                onClick={handleDownload}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                下载 MP4
              </Button>
              <Button
                variant="ghost"
                className="w-full text-[12px]"
                onClick={handleExport}
                disabled={isRendering || actionLoading}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                重新导出
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
