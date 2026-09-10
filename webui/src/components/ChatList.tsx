import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CheckCheck,
  Clock3,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Folder,
  FolderOpen,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import {
  ConversationAvatar,
  MONA_AGENT_ID,
  resolveAgentDisplayName,
} from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { conversationListStatus } from "@/hooks/useSessions";
import { deriveTitle, sessionListTime } from "@/lib/format";
import { cleanSessionPreview, isGenericMonaTitle } from "@/lib/session-preview";
import { cn } from "@/lib/utils";
import type {
  ChatSummary,
  ConversationListStatus,
} from "@/lib/types";
import { useClientContextOrNull } from "@/providers/ClientProvider";

interface ChatSection {
  label: string;
  sessions: ChatSummary[];
  kind: "pinned" | "project" | "recent" | "archived";
  workspace?: string;
}

const INITIAL_VISIBLE_SESSIONS = 160;
const VISIBLE_SESSIONS_INCREMENT = 160;
const MIN_OVERLAY_THUMB_HEIGHT = 32;

export function overlayScrollbarGeometry(
  viewportHeight: number,
  scrollHeight: number,
  scrollTop: number,
): { height: number; offset: number } | null {
  if (scrollHeight <= viewportHeight || viewportHeight <= 0) return null;
  const height = Math.max(
    MIN_OVERLAY_THUMB_HEIGHT,
    viewportHeight * viewportHeight / scrollHeight,
  );
  const offset = scrollTop / (scrollHeight - viewportHeight) * (viewportHeight - height);
  return { height, offset };
}

interface ChatListProps {
  sessions: ChatSummary[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onToggleArchive: (key: string) => void;
  onMarkAllRead?: () => void;
  pinnedKeys?: string[];
  archivedKeys?: string[];
  titleOverrides?: Record<string, string>;
  runningChatIds?: string[];
  unreadKeys?: string[];
  showArchived?: boolean;
  actionMenuPortalContainer?: HTMLElement | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  emptyLabel?: string;
  /** Controls whether project sections default to expanded. */
  defaultProjectExpanded?: boolean;
  /** Called when the user opens a project folder from the context menu. */
  onOpenProjectFolder?: (workspace: string) => void;
  /** Called when the user removes a project from the sidebar. */
  onRemoveProject?: (workspace: string) => void;
  /** Called when the user creates a new task/chat in a project. */
  onCreateTask?: (workspace: string) => void;
  projectNames?: Record<string, string>;
  onRequestProjectRename?: (workspace: string, label: string) => void;
}

export const ChatList = memo(function ChatList({
  sessions,
  activeKey,
  onSelect,
  onRequestDelete,
  onTogglePin,
  onRequestRename,
  onToggleArchive,
  onMarkAllRead,
  pinnedKeys = [],
  archivedKeys = [],
  titleOverrides = {},
  runningChatIds = [],
  unreadKeys = [],
  showArchived = false,
  defaultProjectExpanded = true,
  loading,
  error,
  onRetry,
  emptyLabel,
  onCreateTask,
  onRemoveProject,
  projectNames = {},
  onRequestProjectRename,
  onOpenProjectFolder,
}: ChatListProps) {
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_SESSIONS);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [projectExpansionOverrides, setProjectExpansionOverrides] = useState<Set<string>>(
    () => new Set(),
  );
  const { t } = useTranslation();
  const clientCtx = useClientContextOrNull();
  const agentsById = useAgents(clientCtx?.token ?? null);
  const labels = useMemo(() => ({
    pinned: t("chat.groups.pinned"),
    archived: t("chat.groups.archived"),
    recent: t("chat.groups.recent"),
  }), [t]);
  const groups = useMemo(
    () => groupConversationSessions(sessions, labels, {
      pinnedKeys,
      archivedKeys,
      showArchived,
    }),
    [
      archivedKeys,
      labels,
      pinnedKeys,
      sessions,
      showArchived,
    ],
  );
  const limitedGroups = useMemo(
    () => limitGroups(groups, visibleLimit, activeKey),
    [activeKey, groups, visibleLimit],
  );

  const toggleGroup = useCallback((groupKey: string, project = false) => {
    if (project) {
      setProjectExpansionOverrides((prev) => {
        const next = new Set(prev);
        if (next.has(groupKey)) next.delete(groupKey);
        else next.add(groupKey);
        return next;
      });
      return;
    }
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);
  const totalSessionCount = useMemo(
    () => groups.reduce((total, group) => total + group.sessions.length, 0),
    [groups],
  );
  const visibleSessionCount = useMemo(
    () => limitedGroups.reduce((total, group) => total + group.sessions.length, 0),
    [limitedGroups],
  );
  const hiddenSessionCount = Math.max(0, totalSessionCount - visibleSessionCount);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const scrollThumbRef = useRef<HTMLSpanElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollDragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number; thumbHeight: number } | null>(null);

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const viewport = scrollViewportRef.current;
    const thumb = scrollThumbRef.current;
    if (!viewport || !thumb) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    scrollDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
      thumbHeight: thumb.offsetHeight,
    };
  }, []);

  const handleThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const viewport = scrollViewportRef.current;
    const drag = scrollDragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const maxThumbOffset = viewport.clientHeight - drag.thumbHeight;
    if (maxScrollTop <= 0 || maxThumbOffset <= 0) return;
    const nextScrollTop = drag.startScrollTop + (event.clientY - drag.startY) * maxScrollTop / maxThumbOffset;
    viewport.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  }, []);

  const handleThumbPointerUp = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (scrollDragRef.current?.pointerId !== event.pointerId) return;
    scrollDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const syncOverlayScrollbar = useCallback(() => {
    const viewport = scrollViewportRef.current;
    const thumb = scrollThumbRef.current;
    if (!viewport || !thumb) return;
    const geometry = overlayScrollbarGeometry(
      viewport.clientHeight,
      viewport.scrollHeight,
      viewport.scrollTop,
    );
    thumb.style.display = geometry ? "block" : "none";
    if (!geometry) return;
    thumb.style.height = `${geometry.height}px`;
    thumb.style.transform = `translateY(${geometry.offset}px)`;
  }, []);

  const scheduleOverlayScrollbarSync = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      syncOverlayScrollbar();
    });
  }, [syncOverlayScrollbar]);

  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_SESSIONS);
  }, [showArchived]);

  useEffect(() => {
    syncOverlayScrollbar();
    const viewport = scrollViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncOverlayScrollbar);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [expandedGroups, limitedGroups, syncOverlayScrollbar]);

  if (error && sessions.length === 0) {
    return (
      <SessionListError
        error={error}
        loading={loading}
        onRetry={onRetry}
        className="px-5 py-6"
      />
    );
  }

  if (loading && sessions.length === 0) {
    return (
      <div className="px-5 py-6 text-caption text-muted-foreground">
        {t("chat.loading")}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-5 py-6 text-caption leading-5 text-muted-foreground/80">
        {emptyLabel ?? t("chat.noSessions")}
      </div>
    );
  }

  const pinned = new Set(pinnedKeys);
  const archived = new Set(archivedKeys);
  const running = new Set(runningChatIds);
  const unread = new Set(unreadKeys);

  return (
    <div className="group/session-list relative h-full min-h-0 min-w-0">
      {error ? (
        <SessionListError
          error={error}
          loading={loading}
          onRetry={onRetry}
          className="mx-3 my-2"
        />
      ) : null}
      <div
        ref={scrollViewportRef}
        onScroll={scheduleOverlayScrollbarSync}
        className="session-list-scrollbar h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
      <div className="min-w-0 space-y-2 py-1.5">
        {limitedGroups.map((group) => {
          const groupKey = group.workspace ? `project:${group.workspace}` : group.kind;
          const collapsible = group.kind === "project" || group.kind === "archived";
          const projectExpanded = defaultProjectExpanded
            ? !projectExpansionOverrides.has(groupKey)
            : projectExpansionOverrides.has(groupKey);
          const expanded = group.kind === "project"
            ? projectExpanded
            : !collapsible || expandedGroups.has(groupKey);
          const projectLabel = group.workspace
            ? projectNames[group.workspace]?.trim() || group.label
            : group.label;
          const allProjectPinned = group.kind === "project"
            && group.sessions.length > 0
            && group.sessions.every((session) => pinned.has(session.key));
          const isProjectGroup = group.kind === "project" && Boolean(group.workspace);
          return (
          <section key={groupKey} aria-label={projectLabel}>
            <ContextMenu>
              <ContextMenuTrigger asChild disabled={!isProjectGroup}>
            <div className="group/header flex min-h-9 items-center gap-1 px-3 pb-1 pt-1 text-caption font-medium text-muted-foreground/75">
              {collapsible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleGroup(groupKey, group.kind === "project")}
                  className="h-auto min-w-0 flex-1 justify-start gap-1 px-1 py-1 text-left font-medium hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                  aria-expanded={expanded}
                  aria-label={group.kind === "project" ? projectLabel : group.label}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  {group.kind === "project" ? (
                    expanded
                      ? <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      : <Folder className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{projectLabel}</span>
                </Button>
              ) : (
                <span className="min-w-0 flex-1 truncate px-1 py-1">{projectLabel}</span>
              )}
              {group.kind === "project" && group.workspace ? (
                <button
                  type="button"
                  onClick={() => onCreateTask?.(group.workspace!)}
                  aria-label={t("chat.newProjectChat")}
                  title={t("chat.newProjectChat")}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[hsl(var(--sidebar-hover-surface)/0.06)] hover:text-sidebar-foreground group-hover/header:opacity-100 focus-visible:opacity-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
              </ContextMenuTrigger>
              {group.kind === "project" && group.workspace ? (
                <ContextMenuContent className="w-52" onCloseAutoFocus={(event) => event.preventDefault()}>
                  <ContextMenuItem onSelect={() => {
                    const shouldPin = !allProjectPinned;
                    for (const session of group.sessions) {
                      if (pinned.has(session.key) !== shouldPin) onTogglePin(session.key);
                    }
                  }}>
                    {allProjectPinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
                    {allProjectPinned ? "取消置顶" : "置顶"}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onRequestProjectRename?.(group.workspace!, projectLabel)}>
                    <Pencil className="mr-2 h-4 w-4" />重命名
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onOpenProjectFolder?.(group.workspace!)}>
                    <FolderOpen className="mr-2 h-4 w-4" />在资源管理器中打开
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => {
                    for (const session of group.sessions) onToggleArchive(session.key);
                  }}>
                    <Archive className="mr-2 h-4 w-4" />归档项目
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onRemoveProject?.(group.workspace!)} className="text-destructive focus:text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />移除项目
                  </ContextMenuItem>
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
            {expanded ? (
            <ul>
              {group.sessions.map((s) => {
                const active = s.key === activeKey;
                const generatedTitle = s.title?.trim() || "";
                const isPinned = pinned.has(s.key);
                const isArchived = archived.has(s.key);
                const isUnread = unread.has(s.key);
                const cleanedPreview = cleanSessionPreview(s.preview);
                const timestamp = sessionListTime(s.previewAt ?? s.updatedAt ?? s.createdAt);
                const persistedStatus = conversationListStatus(s);
                // 已完成不保留永久状态图标（§8.2），行内只展示进行态
                const activityState = persistedStatus ?? (
                  running.has(s.chatId) ? "running" : null
                );
                // 显示标题优先级（§6.4）：手动重命名 → 房间名称 → 会话生成
                // 标题（任务主题）→ Agent 显示名称 → 首条有效消息 → 兜底标题。
                // 无 conversation 的旧会话按 Mona 私聊处理。
                const conv = s.conversation ?? null;
                const isRoom = conv?.type === "room";
                const agentName = isRoom
                  ? ""
                  : resolveAgentDisplayName(agentsById, conv?.directAgentId ?? MONA_AGENT_ID);
                const taskTitle = !isRoom && (
                  isGenericMonaTitle(generatedTitle, agentName)
                  || generatedTitle.trim().toLocaleLowerCase() === agentName.trim().toLocaleLowerCase()
                )
                  ? ""
                  : generatedTitle;
                const rowTitle =
                  titleOverrides[s.key]?.trim() ||
                  (isRoom ? conv?.title?.trim() || "" : "") ||
                  taskTitle ||
                  deriveTitle(cleanedPreview, t("chat.newChat"));
                const tooltipTitle = rowTitle;
                // 协作群摘要标出最后发言者；私聊摘要标出所属 Agent。
                let speakerPrefix = "";
                if (isRoom) {
                  const authorId = s.previewAuthorId;
                  if (authorId && s.previewAuthorType !== "user") {
                    speakerPrefix = `${resolveAgentDisplayName(agentsById, authorId)}：`;
                  }
                }
                const statusLabel = activityState
                  ? t(`chat.activity.${activityState === "waiting_approval" ? "waitingApproval" : activityState}`)
                  : "";
                const previewText = cleanedPreview.trim() === rowTitle.trim()
                  ? ""
                  : cleanedPreview;
                const summaryTextWithStatus = activityState
                  ? [statusLabel, previewText].filter(Boolean).join(" · ")
                  : [
                      s.workspace ? workspaceLabel(s.workspace) : "",
                      isRoom ? `${speakerPrefix}${previewText}` : agentName,
                      isRoom ? "" : previewText,
                    ].filter(Boolean).join(" · ");
                const summaryText = summaryTextWithStatus.trim();
                return (
                  <li key={s.key} className="min-w-0 px-2">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          title={tooltipTitle}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "group relative flex h-16 w-full min-w-0 items-center gap-3 px-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
                            active
                              ? "rounded-md bg-[hsl(var(--sidebar-active-surface)/0.09)] text-sidebar-foreground"
                              : "text-sidebar-foreground/82 hover:rounded-md hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                          )}
                        >
                      {/* 极浅底部分隔线：与头像左沿对齐，悬停/选中时隐藏。 */}
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute bottom-0 left-2 right-2 h-px bg-sidebar-border/50",
                          "group-hover:opacity-0",
                          active && "opacity-0",
                        )}
                      />
                      <span className="relative flex h-10 w-10 shrink-0 self-center rounded-md">
                        <ConversationAvatar
                          conversation={conv}
                          agentsById={agentsById}
                          className="h-10 w-10 justify-center overflow-hidden rounded-md"
                          avatarClassName="h-6 w-6 rounded-md text-micro"
                        />
                        {isUnread ? (
                          <span
                            aria-label={t("chat.unread")}
                            title={t("chat.unread")}
                            className={cn(
                              "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border bg-destructive",
                              "border-background",
                            )}
                          />
                        ) : null}
                      </span>
                      <span className="flex h-full min-w-0 flex-1 flex-col justify-center overflow-hidden py-2 text-left">
                        <span className="flex w-full items-baseline gap-2">
                          <span className={cn(
                            "min-w-0 flex-1 truncate !text-body",
                            isUnread ? "font-medium" : "font-normal",
                            isUnread && "text-sidebar-foreground",
                          )}>
                            {rowTitle}
                          </span>
                          {timestamp ? (
                            <span className={cn(
                              "shrink-0 !text-micro",
                              "text-muted-foreground/70",
                            )}>
                              {timestamp}
                            </span>
                          ) : null}
                        </span>
                        {summaryText ? (
                          <span className={cn(
                            "flex w-full items-center gap-1 truncate !text-caption",
                            "text-muted-foreground/75",
                          )}>
                            {activityState ? (
                              <ActivityStatusIcon state={activityState} />
                            ) : null}
                            <span className="min-w-0 truncate">{summaryText}</span>
                          </span>
                        ) : null}
                      </span>
                        </button>
                      </ContextMenuTrigger>
                    <ContextMenuContent
                      onCloseAutoFocus={(event) => event.preventDefault()}
                    >
                      {onMarkAllRead ? (
                        <>
                          <ContextMenuItem
                            disabled={unread.size === 0}
                            onSelect={onMarkAllRead}
                          >
                            <CheckCheck className="mr-2 h-4 w-4" />
                            {t("chat.markAllRead")}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                        </>
                      ) : null}
                      <ContextMenuItem
                        onSelect={() => onTogglePin(s.key)}
                      >
                        {isPinned ? (
                          <PinOff className="mr-2 h-4 w-4" />
                        ) : (
                          <Pin className="mr-2 h-4 w-4" />
                        )}
                        {isPinned ? t("chat.unpin") : t("chat.pin")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => onRequestRename(s.key, rowTitle)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        {t("chat.rename")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => onToggleArchive(s.key)}
                      >
                        {isArchived ? (
                          <ArchiveRestore className="mr-2 h-4 w-4" />
                        ) : (
                          <Archive className="mr-2 h-4 w-4" />
                        )}
                        {isArchived ? t("chat.unarchive") : t("chat.archive")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => {
                          window.setTimeout(() => onRequestDelete(s.key, rowTitle), 0);
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t("chat.delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  </li>
                );
              })}
            </ul>
            ) : null}
          </section>
        );
        })}
        {hiddenSessionCount > 0 ? (
          <div className="px-2 pb-2 pt-1">
            <button
              type="button"
              onClick={() =>
                setVisibleLimit((limit) =>
                  Math.min(totalSessionCount, limit + VISIBLE_SESSIONS_INCREMENT),
                )
              }
              className="h-8 w-full rounded-full text-caption font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
            >
              {t("chat.showMore", { count: hiddenSessionCount })}
            </button>
          </div>
        ) : null}
      </div>
      </div>
      <span
        ref={scrollThumbRef}
        aria-hidden
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={handleThumbPointerUp}
        onPointerCancel={handleThumbPointerUp}
        className="session-list-scrollbar-thumb pointer-events-auto absolute right-3 top-0 z-20 hidden w-1 touch-none select-none rounded-full bg-muted-foreground/40 opacity-0 transition-opacity duration-75 group-hover/session-list:opacity-100"
      />
    </div>
  );
});

function SessionListError({
  error,
  loading,
  onRetry,
  className,
}: {
  error: string;
  loading?: boolean;
  onRetry?: () => void | Promise<void>;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-caption text-destructive",
        className,
      )}
    >
      <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("app.error.title")}</p>
        <p className="mt-0.5 break-words text-destructive/80">{error}</p>
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={loading}
          onClick={() => void onRetry()}
          className="shrink-0 border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          {loading ? t("chat.loading") : t("app.error.retry")}
        </Button>
      ) : null}
    </div>
  );
}

/** 第二行摘要区的任务状态图标（§8.2）：执行中为主题色旋转图标。 */
function ActivityStatusIcon({
  state,
}: {
  state: ConversationListStatus;
}) {
  if (state === "running") {
    return (
      <span
        aria-hidden
        className="h-3 w-3 shrink-0 animate-spin rounded-full border border-theme/25 border-t-theme [animation-duration:1.4s] motion-reduce:animate-none"
      />
    );
  }
  if (state === "waiting_approval") {
    return <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
  }
  if (state === "failed") {
    return <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  if (state === "scheduled") {
    return <Clock3 aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
  return null;
}

function groupConversationSessions(
  sessions: ChatSummary[],
  labels: {
    pinned: string;
    archived: string;
    recent: string;
  },
  options: {
    pinnedKeys: string[];
    archivedKeys: string[];
    showArchived: boolean;
  },
): ChatSection[] {
  const pinned = new Set(options.pinnedKeys);
  const archived = new Set(options.archivedKeys);
  const pinnedSessions: ChatSummary[] = [];
  const projectBuckets = new Map<string, ChatSummary[]>();
  const archivedSessions: ChatSummary[] = [];
  const recentSessions: ChatSummary[] = [];

  for (const session of sessions) {
    if (archived.has(session.key)) {
      if (options.showArchived) archivedSessions.push(session);
      continue;
    }
    const workspace = session.workspace?.trim();
    if (workspace) {
      const rows = projectBuckets.get(workspace) ?? [];
      rows.push(session);
      projectBuckets.set(workspace, rows);
      continue;
    }
    if (pinned.has(session.key)) {
      pinnedSessions.push(session);
      continue;
    }
    recentSessions.push(session);
  }

  const groups: ChatSection[] = [];
  if (pinnedSessions.length) {
    groups.push({ label: labels.pinned, kind: "pinned", sessions: sortSessions(pinnedSessions) });
  }
  for (const [workspace, rows] of projectBuckets) {
    groups.push({
      label: workspaceLabel(workspace),
      kind: "project",
      workspace,
      sessions: sortSessions(rows),
    });
  }
  if (recentSessions.length) {
    groups.push({ label: labels.recent, kind: "recent", sessions: sortSessions(recentSessions) });
  }
  if (archivedSessions.length) {
    groups.push({ label: labels.archived, kind: "archived", sessions: sortSessions(archivedSessions) });
  }
  return groups;
}

/** Render a workspace path as its basename for the section header. */
function workspaceLabel(workspacePath: string): string {
  // Normalize Windows backslashes.
  const normalized = workspacePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? workspacePath;
}

function limitGroups(
  groups: ChatSection[],
  limit: number,
  activeKey: string | null,
): ChatSection[] {
  let remaining = Math.max(0, limit);
  let activeVisible = !activeKey;
  const out: ChatSection[] = [];

  for (const group of groups) {
    const visible = remaining > 0
      ? group.sessions.slice(0, remaining)
      : [];
    remaining -= visible.length;
    if (activeKey && visible.some((session) => session.key === activeKey)) {
      activeVisible = true;
    }
    if (visible.length > 0) {
      out.push({ ...group, sessions: visible });
    }
  }

  if (activeVisible || !activeKey) return out;

  for (const group of groups) {
    const active = group.sessions.find((session) => session.key === activeKey);
    if (!active) continue;
    const existing = out.find((item) => item.label === group.label);
    if (existing) {
      existing.sessions = [...existing.sessions, active];
    } else {
      out.push({ ...group, sessions: [active] });
    }
    return out;
  }

  return out;
}

/** 固定按最近有效活动时间倒序（§3.1）：最后一条用户可见消息时间，
 *  缺失时依次回退到更新时间和创建时间。 */
function sortSessions(sessions: ChatSummary[]): ChatSummary[] {
  const copy = [...sessions];
  copy.sort((a, b) => activityTime(b) - activityTime(a));
  return copy;
}

function activityTime(session: ChatSummary): number {
  const primary = Date.parse(session.previewAt ?? "");
  if (Number.isFinite(primary)) return primary;
  const fallback = Date.parse(session.updatedAt ?? session.createdAt ?? "");
  return Number.isFinite(fallback) ? fallback : 0;
}
