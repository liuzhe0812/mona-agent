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
    blue: "bg-info/10 text-info",
    violet: "bg-primary/10 text-primary",
    green: "bg-success/10 text-success",
    orange: "bg-warning/10 text-warning",
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
        <p className="text-caption text-muted-foreground">{label}</p>
        <p className="mt-0.5 truncate text-title-sm tracking-tight">{value}</p>
        <p className="mt-0.5 truncate text-micro text-muted-foreground">{detail}</p>
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
    <section className={cn("min-w-0 rounded-lg border border-border/70 bg-card", className)}>
      <div className="flex min-h-11 items-center justify-between border-b border-border/60 px-4 py-2.5">
        <h2 className="text-body font-semibold">{title}</h2>
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
    blue: "bg-info/10 text-info",
    green: "bg-success/10 text-success",
    orange: "bg-warning/10 text-warning",
    red: "bg-destructive/10 text-destructive",
    violet: "bg-primary/10 text-primary",
  };
  return <span className={cn("inline-flex rounded-md px-2 py-0.5 text-micro font-medium", tones[tone])}>{children}</span>;
}

export function ProgressBar({ value, color = "bg-info" }: { value: number; color?: string }) {
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
    <div data-testid="system-task-failure" role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-caption">
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">{title}</p>
        <p className="mt-1 break-words text-muted-foreground">{detail}</p>
      </div>
      {onRetry && <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>}
      {onHandoff && <Button type="button" variant="outline" size="sm" onClick={onHandoff}>交给 Mona</Button>}
      {onDismiss && <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>关闭</Button>}
    </div>
  );
}
