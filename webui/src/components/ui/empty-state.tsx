import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 空状态（design §12.14）。
 * - 说明为什么为空；
 * - 最多一个主要下一步动作；
 * - 不使用大面积插画填补空白。
 */
interface EmptyStateProps {
  /** 克制的小图标（建议 lucide，h-5 w-5 左右） */
  icon?: React.ReactNode;
  /** 一句话说明当前为空 */
  title: React.ReactNode;
  /** 补充说明/原因 */
  description?: React.ReactNode;
  /** 唯一的主要下一步动作 */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="mb-1 text-muted-foreground">{icon}</div> : null}
      <p className="text-body font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-caption text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}
