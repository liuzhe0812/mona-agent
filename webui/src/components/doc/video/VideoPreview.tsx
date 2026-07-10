import { CheckCircle, Film, Loader2, Pause, Play } from "lucide-react";

import { cn } from "@/lib/utils";

interface VideoPreviewProps {
  projectName: string;
  previewPort: number | null;
  renderStatus: {
    stage: "idle" | "lint" | "validate" | "inspect" | "render" | "complete" | "error";
    progress: number;
    message?: string;
  };
  videoUrl: string | null;
}

const STAGES: Array<{ key: string; label: string }> = [
  { key: "lint", label: "Lint" },
  { key: "validate", label: "Validate" },
  { key: "inspect", label: "Inspect" },
  { key: "render", label: "Render" },
];

const STAGE_INDEX: Record<string, number> = {
  idle: -1,
  lint: 0,
  validate: 1,
  inspect: 2,
  render: 3,
  complete: 4,
  error: -1,
};

/** Progress thresholds (0–100) at which each stage is considered done. */
const STAGE_THRESHOLDS = [25, 50, 75, 100];

type StageStatus = "done" | "active" | "pending" | "error";

function getStageStatus(
  renderStage: string,
  progress: number,
  targetKey: string,
): StageStatus {
  if (renderStage === "complete") return "done";
  if (renderStage === "idle") return "pending";

  const targetIdx = STAGES.findIndex((s) => s.key === targetKey);

  if (renderStage === "error") {
    return progress >= STAGE_THRESHOLDS[targetIdx] ? "done" : "error";
  }

  const currentIdx = STAGE_INDEX[renderStage] ?? -1;
  if (targetIdx < currentIdx) return "done";
  if (targetIdx === currentIdx) return "active";
  return "pending";
}

export function VideoPreview({ projectName, previewPort, renderStatus, videoUrl }: VideoPreviewProps) {
  const previewUrl = previewPort ? `http://localhost:${previewPort}` : null;
  const showVideo = !!videoUrl;
  const showIframe = !showVideo && !!previewUrl;
  const { stage, progress, message } = renderStatus;

  return (
    <div className="flex h-full flex-col">
      {/* Preview area */}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
        {showVideo ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2">
            <video
              src={videoUrl!}
              controls
              autoPlay
              loop
              className="max-h-full max-w-full rounded shadow-md"
            >
              您的浏览器不支持视频播放。
            </video>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Play className="h-3 w-3" />
              <span>{projectName}</span>
            </div>
          </div>
        ) : showIframe ? (
          <iframe
            src={previewUrl!}
            title={`${projectName} 预览`}
            className="h-full w-full border-0 bg-background"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground">
            <Film className="h-6 w-6" />
            <span>
              {stage === "idle" ? "开始生成后将在此展示预览" : "正在准备预览..."}
            </span>
            {stage !== "idle" && stage !== "complete" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-t border-border/70 px-3 text-[12px]">
        {STAGES.map((s, idx) => {
          const status = getStageStatus(stage, progress, s.key);
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              {idx > 0 ? <span className="text-border">→</span> : null}
              {status === "done" ? (
                <CheckCircle className="h-3.5 w-3.5 text-green-600" />
              ) : status === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : status === "error" ? (
                <span className="grid h-3.5 w-3.5 place-items-center text-[11px] font-bold text-destructive">×</span>
              ) : (
                <Pause className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span
                className={cn(
                  status === "pending" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {s.label}
              </span>
            </div>
          );
        })}

        {/* Progress / message */}
        <div className="ml-auto flex items-center gap-2 text-muted-foreground">
          {stage === "error" ? (
            <span className="text-destructive">{message ?? "渲染失败"}</span>
          ) : stage === "complete" ? (
            <>
              <CheckCircle className="h-3.5 w-3.5 text-green-600" />
              <span>渲染完成</span>
            </>
          ) : stage !== "idle" ? (
            <>
              <span>{Math.round(progress)}%</span>
              {message ? <span className="text-muted-foreground">· {message}</span> : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
