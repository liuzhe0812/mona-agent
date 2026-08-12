import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 页内持续信息条（design §12.13 Alert）。
 * 用于需要持续展示的状态、警告和错误；短暂结果用 Toast，不用本组件。
 */
type StatusNoticeTone = "info" | "success" | "warning" | "danger";

const TONE_STYLES: Record<StatusNoticeTone, { container: string; icon: string; Icon: LucideIcon }> = {
  info: {
    container: "border-info/30 bg-info/5",
    icon: "text-info",
    Icon: Info,
  },
  success: {
    container: "border-success/30 bg-success/5",
    icon: "text-success",
    Icon: CheckCircle2,
  },
  warning: {
    container: "border-warning/30 bg-warning/5",
    icon: "text-warning",
    Icon: AlertTriangle,
  },
  danger: {
    container: "border-destructive/30 bg-destructive/5",
    icon: "text-destructive",
    Icon: XCircle,
  },
};

interface StatusNoticeProps {
  tone?: StatusNoticeTone;
  /** 标题（可选，加粗引导） */
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** 右侧动作（如重试按钮），持续信息最多一个动作 */
  action?: React.ReactNode;
  className?: string;
}

export function StatusNotice({ tone = "info", title, children, action, className }: StatusNoticeProps) {
  const { container, icon, Icon } = TONE_STYLES[tone];
  return (
    <div
      role="alert"
      className={cn("flex items-start gap-2 rounded-lg border p-3 text-ui", container, className)}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5", "text-muted-foreground")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
