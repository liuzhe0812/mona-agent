import { ArrowRight, RotateCw, SunMedium } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { StockReportListItem } from "@/lib/stock-api";
import type { WorkflowRun } from "@/lib/types";
import { stanceLabel } from "./labels";

/** 紧凑复盘条：只承担状态和简报入口，不与标的研究争夺首屏空间。 */

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"]);

interface ReviewHeroCardProps {
  /** 最新一份 daily_review 报告（全局时间倒序取首条），无则 null。 */
  latestReview: StockReportListItem | null;
  /** 今日（Asia/Shanghai 视角，调用方已判定）是否已有复盘简报。 */
  reviewedToday: boolean;
  /** 复盘运行（仅当它是 cron 触发时视为复盘进行中）。 */
  run: WorkflowRun | null;
  /** 自动复盘独立开关；关闭且没有当日结果时不占用工作台首屏。 */
  autoReviewEnabled: boolean;
  watchCount: number;
  focusCount: number;
  reviewTime: string;
  reviewScope: "all" | "focus";
  onOpenReport: (reportId: string) => void;
}

export function ReviewHeroCard({
  latestReview,
  reviewedToday,
  run,
  autoReviewEnabled,
  watchCount,
  focusCount,
  reviewTime,
  reviewScope,
  onOpenReport,
}: ReviewHeroCardProps) {
  const reviewRun = run?.triggerType === "cron";
  const reviewing =
    run != null &&
    reviewRun &&
    ACTIVE_RUN_STATUSES.has(run.status) &&
    run.triggerType === "cron";
  const failed = reviewRun && run?.status === "failed" && !reviewedToday;

  if (!autoReviewEnabled && !reviewedToday && !reviewing && !failed) return null;

  const covered = reviewedToday ? (latestReview?.symbols.length ?? 0) : 0;
  const state = reviewing
    ? "running"
    : reviewedToday
      ? "done"
      : failed
        ? "failed"
        : "pending";

  return (
    <section className="flex h-11 shrink-0 items-center gap-2.5 border-b bg-muted/[0.12] px-4">
      <SunMedium className="h-3.5 w-3.5 shrink-0 text-info" aria-hidden />
      <span className="shrink-0 text-ui font-medium text-info">今日复盘</span>
      {state === "running" && (
        <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-micro">
          <RotateCw className="h-2.5 w-2.5 animate-spin" />
          复盘中
        </Badge>
      )}
      {state === "failed" && (
        <Badge variant="destructive" className="px-1.5 py-0 text-micro">
          失败
        </Badge>
      )}
      <span className="min-w-0 truncate text-ui text-muted-foreground">
        {state === "done" && (
          <>
            <span className="text-foreground">今日复盘简报</span>
            <span className="ml-1.5">已覆盖 {covered} 只 · 重点 {focusCount} 只</span>
          </>
        )}
        {state === "running" &&
          `3 位分析师与主审正在复盘 ${watchCount} 只自选股`}
        {state === "failed" && "本次复盘未完成，下一交易日自动重试"}
        {state === "pending" &&
          `自选 ${watchCount} 只 · 今日 ${reviewTime} 自动生成 · ${reviewScope === "focus" ? "仅重点标的" : "全部自选"}`}
      </span>
      {reviewedToday && latestReview && (
        <>
          {latestReview.stance && (
            <Badge variant="secondary" className="hidden px-1.5 py-0 text-micro lg:inline-flex">
              {stanceLabel(latestReview.stance)}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto shrink-0 gap-1 text-caption text-info"
            onClick={() => onOpenReport(latestReview.reportId)}
          >
            查看今日复盘
            <ArrowRight className="h-3 w-3" />
          </Button>
        </>
      )}
    </section>
  );
}
