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
  Settings2,
  TriangleAlert,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AgentAvatar,
  ConversationAvatar,
  MONA_AGENT_ID,
  MONA_AVATAR_IMAGE,
  resolveAgentDisplayName,
} from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { conversationListStatus } from "@/hooks/useSessions";
import { deriveTitle, sessionListTime } from "@/lib/format";
import { cleanSessionPreview, isGenericMonaTitle } from "@/lib/session-preview";
import { cn } from "@/lib/utils";
import type {
  AgentSummary,
  ChatSummary,
  ConversationListStatus,
} from "@/lib/types";
import { useClientContextOrNull } from "@/providers/ClientProvider";

interface ChatSection {
  label: string;
  sessions: ChatSummary[];
  kind: "pinned" | "project" | "agent" | "rooms" | "archived";
  agentId?: string;
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
  emptyLabel?: string;
  /** Controls whether project sections default to expanded. */
  defaultProjectExpanded?: boolean;
  /** Called when the user opens a project folder from the context menu. */
  onOpenProjectFolder?: (workspace: string) => void;
  /** Called when the user removes a project from the sidebar. */
  onRemoveProject?: (workspace: string) => void;
  /** Called when the user creates a new task/chat in a project. */
  onCreateTask?: (workspace: string) => void;
  /** Opens the selected Agent's management surface. */
  onSelectAgent?: (agentId: string) => void;
  /** Starts a new direct conversation from an Agent group header. */
  onStartDirect?: (agentId: string) => void;
  /** Creates a new room from the rooms group header. */
  onNewRoom?: () => void;
  /** Search result mode deliberately suppresses empty Agent groups. */
  searchMode?: boolean;
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
  emptyLabel,
  onSelectAgent,
  onStartDirect,
  onNewRoom,
  onCreateTask,
  searchMode = false,
}: ChatListProps) {
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_SESSIONS);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(["mona", "rooms"]),
  );
  const [projectExpansionOverrides, setProjectExpansionOverrides] = useState<Set<string>>(
    () => new Set(),
  );
  const { t } = useTranslation();
  const clientCtx = useClientContextOrNull();
  const agentsById = useAgents(clientCtx?.token ?? null);
  const labels = useMemo(() => ({
    pinned: t("chat.groups.pinned"),
    archived: t("chat.groups.archived"),
    rooms: t("chat.groups.rooms"),
  }), [t]);
  const groups = useMemo(
    () => groupAgentSessions(sessions, labels, agentsById, {
      pinnedKeys,
      archivedKeys,
      showArchived,
      includeEmptyAgents: !searchMode,
    }),
    [
      archivedKeys,
      agentsById,
      labels,
      pinnedKeys,
      searchMode,
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

  if (loading && sessions.length === 0) {
    return (
      <div className="px-5 py-6 text-caption text-muted-foreground">
        {t("chat.loading")}
      </div>
    );
  }

  if (sessions.length === 0 && (searchMode || agentsById.size === 0)) {
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
      <div
        ref={scrollViewportRef}
        onScroll={scheduleOverlayScrollbarSync}
        className="session-list-scrollbar h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
      <div className="min-w-0 space-y-2 py-1.5">
        {limitedGroups.map((group) => {
          const groupKey = group.workspace ? `project:${group.workspace}` : group.agentId ?? group.kind;
          const collapsible = group.kind === "project" || group.kind === "agent" || group.kind === "rooms" || group.kind === "archived";
          const projectExpanded = defaultProjectExpanded
            ? !projectExpansionOverrides.has(groupKey)
            : projectExpansionOverrides.has(groupKey);
          const expanded = group.kind === "project"
            ? projectExpanded
            : !collapsible || expandedGroups.has(groupKey);
          const agent = group.agentId ? agentsById.get(group.agentId) : null;
          return (
          <section key={groupKey} aria-label={group.label}>
            <div className="group/header flex min-h-9 items-center gap-1 px-3 pb-1 pt-1 text-caption font-medium text-muted-foreground/75">
              {group.kind === "agent" && group.agentId ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                  aria-label={group.label}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  <AgentAvatar agentId={group.agentId} displayName={agent?.displayName ?? group.label} avatarUrl={agent?.avatarUrl ?? (group.agentId === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)} className="h-5 w-5" />
                  <span className="min-w-0 shrink truncate">{group.label}</span>
                  {group.sessions.filter((session) => unread.has(session.key)).length > 0 ? (
                    <span className="shrink-0 rounded-full bg-destructive px-1.5 text-[10px] leading-4 text-white">
                      {group.sessions.filter((session) => unread.has(session.key)).length}
                    </span>
                  ) : null}
                  {agent?.enabled === false ? <span className="text-micro text-muted-foreground/65">{t("common.disabled", "已停用")}</span> : null}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => collapsible && toggleGroup(groupKey, group.kind === "project")}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left",
                    collapsible && "hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                  )}
                  aria-expanded={collapsible ? expanded : undefined}
                >
                  {collapsible ? (
                    expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  {group.kind === "project" ? (
                    expanded
                      ? <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      : <Folder className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  {group.kind === "rooms" ? <UsersRound className="h-3.5 w-3.5 shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                </button>
              )}
              {group.kind === "agent" && group.agentId && agent?.enabled !== false ? (
                <>
                  <button
                    type="button"
                    onClick={() => onSelectAgent?.(group.agentId!)}
                    aria-label={t("chat.agentSettings", "Agent 设置")}
                    title={t("chat.agentSettings", "Agent 设置")}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[hsl(var(--sidebar-hover-surface)/0.06)] hover:text-sidebar-foreground group-hover/header:opacity-100 focus-visible:opacity-100"
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onStartDirect?.(group.agentId!)}
                    aria-label={t("chat.newChat")}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[hsl(var(--sidebar-hover-surface)/0.06)] hover:text-sidebar-foreground group-hover/header:opacity-100 focus-visible:opacity-100"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : null}
              {group.kind === "rooms" ? (
                <button
                  type="button"
                  onClick={() => onNewRoom?.()}
                  aria-label={t("chat.newRoom")}
                  title={t("chat.newRoom")}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-[hsl(var(--sidebar-hover-surface)/0.06)] hover:text-sidebar-foreground group-hover/header:opacity-100 focus-visible:opacity-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              ) : null}
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
                const isMonaTask = !isRoom
                  && (conv?.directAgentId ?? MONA_AGENT_ID) === MONA_AGENT_ID;
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
                // 私聊头像已经表达身份，只有协作房间需要最后发言者前缀。
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
                const projectPrefix = s.workspace ? `${workspaceLabel(s.workspace)} · ` : "";
                const summaryTextWithStatus = activityState
                  ? [statusLabel, cleanedPreview].filter(Boolean).join(" · ")
                  : `${projectPrefix}${speakerPrefix}${cleanedPreview}`;
                const summaryText = summaryTextWithStatus.trim() === rowTitle.trim()
                  ? ""
                  : summaryTextWithStatus;
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
                      {isRoom || group.kind === "pinned" ? (
                        <span className="relative flex h-10 w-10 shrink-0 self-center rounded-md">
                          <ConversationAvatar
                            conversation={conv}
                            agentsById={agentsById}
                            taskTitle={isMonaTask ? rowTitle : undefined}
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
                      ) : <span className="h-8 w-1 shrink-0" aria-hidden />}
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

function groupAgentSessions(
  sessions: ChatSummary[],
  labels: {
    pinned: string;
    archived: string;
    rooms: string;
  },
  agentsById: ReadonlyMap<string, AgentSummary>,
  options: {
    pinnedKeys: string[];
    archivedKeys: string[];
    showArchived: boolean;
    includeEmptyAgents: boolean;
  },
): ChatSection[] {
  const pinned = new Set(options.pinnedKeys);
  const archived = new Set(options.archivedKeys);
  const pinnedSessions: ChatSummary[] = [];
  const projectBuckets = new Map<string, ChatSummary[]>();
  const archivedSessions: ChatSummary[] = [];
  const directBuckets = new Map<string, ChatSummary[]>();
  const roomSessions: ChatSummary[] = [];

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
    const conversation = session.conversation;
    if (conversation?.type === "room") {
      roomSessions.push(session);
      continue;
    }
    const agentId = conversation?.directAgentId ?? MONA_AGENT_ID;
    const rows = directBuckets.get(agentId) ?? [];
    rows.push(session);
    directBuckets.set(agentId, rows);
  }

  const visibleAgents = [...agentsById.values()]
    .filter((agent) => agent.visibility !== "internal")
    .sort((left, right) => {
      if (left.id === MONA_AGENT_ID) return -1;
      if (right.id === MONA_AGENT_ID) return 1;
      return left.displayName.localeCompare(right.displayName);
    });
  if (!visibleAgents.some((agent) => agent.id === MONA_AGENT_ID)) {
    visibleAgents.unshift({
      id: MONA_AGENT_ID,
      displayName: "Mona",
      enabled: true,
    });
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
  for (const agent of visibleAgents) {
    const rows = directBuckets.get(agent.id) ?? [];
    if (!options.includeEmptyAgents && rows.length === 0) continue;
    groups.push({
      label: agent.displayName,
      kind: "agent",
      agentId: agent.id,
      sessions: sortSessions(rows),
    });
    directBuckets.delete(agent.id);
  }
  // A package can be removed after a conversation was created. Keep those
  // sessions reachable rather than silently dropping them from the sidebar.
  for (const [agentId, rows] of directBuckets) {
    groups.push({ kind: "agent", agentId, label: agentId, sessions: sortSessions(rows) });
  }
  if (roomSessions.length) {
    groups.push({ label: labels.rooms, kind: "rooms", sessions: sortSessions(roomSessions) });
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
    if (visible.length > 0 || group.kind === "agent") {
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
