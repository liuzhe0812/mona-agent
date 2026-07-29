import {
  ArrowRight,
  Check,
  Database,
  FilePenLine,
  TerminalSquare,
} from "lucide-react";

import type { ScheduleItem } from "@/components/schedule/types";
import type { ChatSummary } from "@/lib/types";
import { deriveTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface UnreadMailPreview {
  sender: string;
  subject: string;
}

interface NewChatDashboardProps {
  scheduleItems: ScheduleItem[];
  unreadCount: number;
  unreadMails?: UnreadMailPreview[];
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

const sectionClass = "border-t border-border/50 py-5 first:border-t-0 first:pt-0";
const sectionTitleClass = "text-[12px] font-semibold tracking-[0.16em] text-muted-foreground/75";

export function NewChatDashboard({
  scheduleItems,
  unreadCount,
  unreadMails,
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
  const recentExcerpt = recentSession?.preview?.replace(/\s+/g, " ").trim() ?? "";

  return (
    <div className="w-full animate-in fill-mode-backwards fade-in-0 slide-in-from-bottom-2 text-left duration-500 [animation-delay:140ms] md:border-l md:border-border/40 md:pl-14">
      <section className={sectionClass}>
        <header className="flex items-baseline justify-between gap-3">
          <h2 className={sectionTitleClass}>今日焦点</h2>
          {nextItem ? (
            <span className="text-[11.5px] text-muted-foreground">
              下一项 <span className="font-medium tabular-nums text-[#347fca] dark:text-[#7cb8f0]">{formatTime(nextItem.startAtMs)}</span>
            </span>
          ) : null}
        </header>

        {focusItems.length > 0 ? (
          <ol className="mt-3 space-y-0.5">
            {focusItems.map((item) => {
              const state = focusState(item, nextItem);
              const isNext = state === "next";
              return (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent",
                    isNext && "bg-[#4f9de8]/[0.07] hover:bg-[#4f9de8]/[0.1]",
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {state === "done" ? (
                      <Check className="h-3.5 w-3.5 text-[#10b981]" />
                    ) : (
                      <span
                        className={cn(
                          "h-2 w-2 rounded-full",
                          isNext
                            ? "bg-[#4f9de8] ring-4 ring-[#4f9de8]/15"
                            : "border border-muted-foreground/40",
                        )}
                      />
                    )}
                  </span>
                  <time className={cn(
                    "w-10 shrink-0 text-[12.5px] tabular-nums text-muted-foreground",
                    isNext && "font-medium text-[#347fca] dark:text-[#7cb8f0]",
                  )}>
                    {formatTime(item.startAtMs)}
                  </time>
                  <span className={cn(
                    "min-w-0 truncate text-[13.5px]",
                    state === "done"
                      ? "text-muted-foreground line-through decoration-muted-foreground/40"
                      : "font-medium text-foreground",
                  )}>
                    {item.title}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="mt-3 px-1.5 text-[13px] text-muted-foreground">今天暂无安排</p>
        )}
      </section>

      <section className={sectionClass}>
        <header className="flex items-baseline justify-between gap-3">
          <h2 className={sectionTitleClass}>待处理邮件</h2>
          <div className="flex items-baseline gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              {unreadCount > 0 ? (
                <><span className="font-medium tabular-nums text-[#d8852d] dark:text-[#f0b273]">{unreadCount}</span> 封未读</>
              ) : "收件箱已清空"}
            </span>
            {unreadCount > 0 && onOpenEmail ? (
              <button
                type="button"
                onClick={onOpenEmail}
                disabled={disabled}
                className="group inline-flex items-center gap-1 text-[12px] font-medium text-[#d8852d] transition-colors hover:text-[#c2741f] disabled:pointer-events-none disabled:opacity-50 dark:text-[#f0b273]"
              >
                查看
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </button>
            ) : null}
          </div>
        </header>
        {unreadMails && unreadMails.length > 0 ? (
          <ul className="mt-3 space-y-0.5">
            {unreadMails.map((mail, index) => (
              <li key={index} className="flex items-baseline gap-2.5 rounded-md px-1.5 py-1.5">
                <span className="max-w-[38%] shrink-0 truncate text-[13px] font-medium text-foreground">
                  {mail.sender}
                </span>
                <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                  {mail.subject}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={sectionClass}>
        <header className="flex items-baseline justify-between gap-3">
          <h2 className={sectionTitleClass}>继续工作</h2>
          <div className="flex items-baseline gap-3">
            {recentSession ? (
              <span className="text-[11.5px] text-muted-foreground">
                {formatRelativeTime(recentSession.updatedAt, now)}
              </span>
            ) : null}
            {recentSession && onContinue ? (
              <button
                type="button"
                onClick={() => onContinue(recentSession.key)}
                disabled={disabled}
                className="group inline-flex items-center gap-1 text-[12px] font-medium text-[#0e9f6e] transition-colors hover:text-[#0b8a5e] disabled:pointer-events-none disabled:opacity-50 dark:text-[#34d399]"
              >
                继续
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </button>
            ) : null}
          </div>
        </header>
        <div className="mt-3 px-1.5">
          <p className="truncate text-[13.5px] font-medium text-foreground">{recentTitle}</p>
          {recentExcerpt ? (
            <p className="mt-1 truncate text-[12.5px] text-muted-foreground">{recentExcerpt}</p>
          ) : null}
        </div>
      </section>

      <div className="flex items-center gap-1.5 border-t border-border/50 pt-4">
        <QuietAction label="连接主机" icon={<TerminalSquare className="h-3.5 w-3.5" />} onClick={onConnectHost} disabled={disabled} />
        <QuietAction label="连接数据库" icon={<Database className="h-3.5 w-3.5" />} onClick={onConnectDatabase} disabled={disabled} />
        <QuietAction label="新建笔记" icon={<FilePenLine className="h-3.5 w-3.5" />} onClick={onCreateNote} disabled={disabled} />
      </div>
    </div>
  );
}

function QuietAction({
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
      className="group inline-flex h-8 items-center gap-2 rounded-full pl-2 pr-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
    >
      <span className="flex h-5 w-5 items-center justify-center opacity-70 transition-transform group-hover:scale-110">
        {icon}
      </span>
      {label}
    </button>
  );
}
