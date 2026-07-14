import {
  Check,
  Circle,
  Database,
  FilePenLine,
  Mail,
  TerminalSquare,
} from "lucide-react";

import type { ScheduleItem } from "@/components/schedule/types";
import type { ChatSummary } from "@/lib/types";
import { deriveTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

interface NewChatDashboardProps {
  scheduleItems: ScheduleItem[];
  unreadCount: number;
  recentSession: ChatSummary | null;
  now?: Date;
  disabled?: boolean;
  onContinue?: (key: string) => void;
  onConnectHost?: () => void;
  onConnectDatabase?: () => void;
  onCreateNote?: () => void;
  onOpenEmail?: () => void;
}

function isSameDay(timestamp: number, day: Date): boolean {
  const value = new Date(timestamp);
  return value.getFullYear() === day.getFullYear()
    && value.getMonth() === day.getMonth()
    && value.getDate() === day.getDate();
}

export function selectTodayFocus(items: ScheduleItem[], now: Date): ScheduleItem[] {
  const today = items
    .filter((item) => item.enabled && isSameDay(item.startAtMs, now))
    .sort((a, b) => a.startAtMs - b.startAtMs);
  if (today.length <= 3) return today;

  const nextIndex = today.findIndex((item) => !item.done && item.startAtMs >= now.getTime());
  const anchor = nextIndex >= 0 ? nextIndex : today.findIndex((item) => !item.done);
  const start = Math.max(0, (anchor >= 0 ? anchor : today.length - 1) - 1);
  return today.slice(start, start + 3);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function formatRelativeTime(value: string | null, now: Date): string {
  const updatedAt = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(updatedAt)) return "最近";
  const minutes = Math.max(0, Math.floor((now.getTime() - updatedAt) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function focusState(item: ScheduleItem, nextItem: ScheduleItem | null): "done" | "next" | "upcoming" {
  if (item.done) return "done";
  return item.id === nextItem?.id ? "next" : "upcoming";
}

export function NewChatDashboard({
  scheduleItems,
  unreadCount,
  recentSession,
  now = new Date(),
  disabled = false,
  onContinue,
  onConnectHost,
  onConnectDatabase,
  onCreateNote,
  onOpenEmail,
}: NewChatDashboardProps) {
  const focusItems = selectTodayFocus(scheduleItems, now);
  const nextItem = focusItems.find((item) => !item.done && item.startAtMs >= now.getTime())
    ?? focusItems.find((item) => !item.done)
    ?? null;
  const recentTitle = recentSession
    ? recentSession.title?.trim() || deriveTitle(recentSession.preview, "未命名会话")
    : "暂无可继续的工作";

  return (
    <div className="mt-7 w-full max-w-[58rem] text-left">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.55fr)_minmax(15rem,0.9fr)]">
        <section className="rounded-lg border border-border/80 bg-card px-5 py-4 shadow-[0_8px_22px_rgba(15,23,42,0.035)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-foreground">今日焦点</h2>
            {nextItem ? (
              <span className="text-[12px] text-muted-foreground">
                下一项 <span className="font-medium text-[#4f9de8]">{formatTime(nextItem.startAtMs)}</span>
              </span>
            ) : null}
          </div>

          {focusItems.length > 0 ? (
            <ol className="relative space-y-1 before:absolute before:bottom-5 before:left-[13px] before:top-5 before:w-px before:bg-border">
              {focusItems.map((item) => {
                const state = focusState(item, nextItem);
                const isNext = state === "next";
                return (
                  <li
                    key={item.id}
                    className={cn(
                      "relative grid min-h-14 grid-cols-[28px_58px_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 py-1.5",
                      isNext && "bg-[#4f9de8]/[0.08]",
                    )}
                  >
                    <span
                      className={cn(
                        "relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 bg-card",
                        state === "done" && "border-muted bg-muted text-muted-foreground",
                        isNext && "border-[#4f9de8] text-[#4f9de8]",
                        state === "upcoming" && "border-muted-foreground/45 text-transparent",
                      )}
                    >
                      {state === "done" ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5 fill-current" />}
                    </span>
                    <time className={cn("text-[13px] tabular-nums text-muted-foreground", isNext && "font-medium text-[#4f9de8]")}>
                      {formatTime(item.startAtMs)}
                    </time>
                    <span className="min-w-0 truncate text-[14px] font-medium text-foreground">{item.title}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="flex h-[166px] items-center justify-center text-[13px] text-muted-foreground">
              今天暂无安排
            </div>
          )}
        </section>

        <div className="grid gap-3">
          <section className="flex min-h-[112px] flex-col justify-between rounded-lg border border-border/80 bg-card px-4 py-3.5 shadow-[0_8px_22px_rgba(15,23,42,0.035)]">
            <h2 className="text-[14px] font-semibold text-foreground">继续工作</h2>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-foreground">{recentTitle}</p>
                {recentSession ? (
                  <p className="mt-1 text-[12px] text-muted-foreground">{formatRelativeTime(recentSession.updatedAt, now)}</p>
                ) : null}
              </div>
              {recentSession && onContinue ? (
                <button
                  type="button"
                  onClick={() => onContinue(recentSession.key)}
                  disabled={disabled}
                  className="h-7 shrink-0 rounded-md border border-[#4f9de8]/35 bg-[#4f9de8]/[0.07] px-2 text-[12px] font-medium text-[#347fca] transition-colors hover:bg-[#4f9de8]/[0.13] disabled:pointer-events-none disabled:opacity-50"
                >
                  继续
                </button>
              ) : null}
            </div>
          </section>

          <section className="flex min-h-[112px] flex-col justify-between rounded-lg border border-border/80 bg-card px-4 py-3.5 shadow-[0_8px_22px_rgba(15,23,42,0.035)]">
            <h2 className="text-[14px] font-semibold text-foreground">待处理邮件</h2>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#eba45d]/15 text-[#d8852d]">
                  <Mail className="h-5 w-5" />
                </span>
                <p className="text-[14px] font-medium text-foreground">
                  {unreadCount > 0 ? <><span className="mr-1 text-[26px] leading-none text-[#d8852d]">{unreadCount}</span> 封未读</> : "收件箱已清空"}
                </p>
              </div>
              {unreadCount > 0 && onOpenEmail ? (
                <button
                  type="button"
                  onClick={onOpenEmail}
                  disabled={disabled}
                  className="h-7 shrink-0 rounded-md border border-[#eba45d]/35 bg-[#eba45d]/[0.07] px-2 text-[12px] font-medium text-[#d8852d] transition-colors hover:bg-[#eba45d]/[0.13] disabled:pointer-events-none disabled:opacity-50"
                >
                  查看
                </button>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      <div className="mt-3 grid overflow-hidden rounded-lg border border-border/80 bg-card shadow-[0_8px_22px_rgba(15,23,42,0.035)] sm:grid-cols-3">
        <DashboardAction label="连接主机" icon={<TerminalSquare className="h-5 w-5 text-[#4f9de8]" />} onClick={onConnectHost} disabled={disabled} />
        <DashboardAction label="连接数据库" icon={<Database className="h-5 w-5 text-[#4f9de8]" />} onClick={onConnectDatabase} disabled={disabled} />
        <DashboardAction label="新建笔记" icon={<FilePenLine className="h-5 w-5 text-[#d8852d]" />} onClick={onCreateNote} disabled={disabled} />
      </div>
    </div>
  );
}

function DashboardAction({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || disabled}
      className="flex h-14 items-center justify-center gap-2 border-b border-border/70 text-[14px] font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-45 sm:border-b-0 sm:border-r last:border-0"
    >
      {icon}
      {label}
    </button>
  );
}
