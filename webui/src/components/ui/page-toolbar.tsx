import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 页面主工具栏（design §12.9）。
 * 固定 44px 高；左侧放导航/对象，中央放视图或上下文，右侧放动作和状态。
 * 功能组之间用 8px（gap-2）间距，分隔用一条短分隔线。
 */
interface PageToolbarProps {
  /** 左侧：导航/对象 */
  leading?: React.ReactNode;
  /** 中央：视图切换或上下文（不传入时左侧自然延展） */
  children?: React.ReactNode;
  /** 右侧：动作和状态 */
  actions?: React.ReactNode;
  className?: string;
}

export function PageToolbar({ leading, children, actions, className }: PageToolbarProps) {
  return (
    <div className={cn("flex h-11 items-center gap-2 text-caption [&_button]:text-caption", className)}>
      {leading ? <div className="flex min-w-0 items-center gap-2">{leading}</div> : null}
      {children ? (
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">{children}</div>
      ) : (
        <div className="flex-1" />
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
