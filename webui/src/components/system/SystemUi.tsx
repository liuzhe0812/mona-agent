import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  detail,
  icon,
  accent = "blue",
  onClick,
  active = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  accent?: "blue" | "violet" | "green" | "orange";
  onClick?: () => void;
  active?: boolean;
}) {
  const tones = {
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    orange: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  };
  const className = cn(
    "min-w-0 rounded-lg border bg-card p-3.5 text-left transition",
    active ? "border-primary/60 ring-2 ring-primary/15" : "border-border/70 shadow-sm",
    onClick && !active && "cursor-pointer hover:border-primary/40 hover:shadow",
  );
  const content = (
    <div className="flex items-start gap-3">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", tones[accent])}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-0.5 truncate text-xl font-semibold tracking-tight">{value}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

export function PanelCard({
  title,
  children,
  className,
  bodyClassName,
  action,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  action?: ReactNode;
}) {
  return (
    <section className={cn("min-w-0 rounded-lg border border-border/70 bg-card shadow-sm", className)}>
      <div className="flex min-h-11 items-center justify-between border-b border-border/60 px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "blue" | "green" | "orange" | "red" | "violet";
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    green: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    orange: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
    red: "bg-red-500/10 text-red-700 dark:text-red-400",
    violet: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  };
  return <span className={cn("inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium", tones[tone])}>{children}</span>;
}

export function ProgressBar({ value, color = "bg-blue-500" }: { value: number; color?: string }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${value}%` }} />
    </div>
  );
}

export function TaskFailureNotice({
  title,
  detail,
  onRetry,
  onHandoff,
  onDismiss,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
  onHandoff?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div data-testid="system-task-failure" role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs">
      <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-red-700 dark:text-red-400">{title}</p>
        <p className="mt-1 break-words text-muted-foreground">{detail}</p>
      </div>
      {onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>}
      {onHandoff && <Button type="button" variant="outline" size="sm" onClick={onHandoff}>交给 Mona</Button>}
      {onDismiss && <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>关闭</Button>}
    </div>
  );
}
