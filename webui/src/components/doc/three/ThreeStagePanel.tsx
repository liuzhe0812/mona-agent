/**
 * 白盒阶段卡片：显示阶段名称、状态、阻塞原因与最新评审结论。
 * 数据全部来自服务端聚合状态（spec 推导），前端不维护阶段真相。
 */

import { cn } from "@/lib/utils";

import { STATUS_LABELS, stageLabel, type ThreeReviewEntry, type ThreeStage, type ThreeStageStatus } from "./threeState";

const STATUS_STYLES: Record<ThreeStageStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-primary",
  review: "text-amber-600 dark:text-amber-400",
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  blocked: "text-destructive",
};

interface ThreeStagePanelProps {
  stages: ThreeStage[];
  blockedReason: string;
  lastReview: ThreeReviewEntry | null;
}

export function ThreeStagePanel({ stages, blockedReason, lastReview }: ThreeStagePanelProps) {
  return (
    <div className="flex flex-col gap-1">
      {stages.map((stage) => (
        <div
          key={stage.id}
          className="flex items-center justify-between rounded-lg px-2.5 py-2"
        >
          <span className="text-[13px]">{stageLabel(stage.id)}</span>
          <span className={cn("text-[11px] font-medium", STATUS_STYLES[stage.status])}>
            {STATUS_LABELS[stage.status]}
          </span>
        </div>
      ))}
      {blockedReason && (
        <div className="mt-1 rounded-lg bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
          阻塞原因：{blockedReason}
        </div>
      )}
      {lastReview?.summary && (
        <div className="mt-1 rounded-lg bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
          最新评审（{lastReview.passId ?? "-"} · {lastReview.action ?? "-"}）：{lastReview.summary}
        </div>
      )}
    </div>
  );
}
