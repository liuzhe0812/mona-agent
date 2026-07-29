import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Archive,
  ArchiveRestore,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deriveTitle, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatSummary, SidebarDensity, SidebarSortMode } from "@/lib/types";

interface ChatSection {
  label: string;
  sessions: ChatSummary[];
  isDefault?: boolean;
  isProject?: boolean;
  workspace?: string;
}

const INITIAL_VISIBLE_SESSIONS = 160;
const VISIBLE_SESSIONS_INCREMENT = 160;

interface ChatListProps {
  sessions: ChatSummary[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onToggleArchive: (key: string) => void;
  pinnedKeys?: string[];
  archivedKeys?: string[];
  titleOverrides?: Record<string, string>;
  runningChatIds?: string[];
  completedChatIds?: string[];
  density?: SidebarDensity;
  showPreviews?: boolean;
  showTimestamps?: boolean;
  sort?: SidebarSortMode;
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
}

export const ChatList = memo(function ChatList({
  sessions,
  activeKey,
  onSelect,
  onRequestDelete,
  onTogglePin,
  onRequestRename,
  onToggleArchive,
  pinnedKeys = [],
  archivedKeys = [],
  titleOverrides = {},
  runningChatIds = [],
  completedChatIds = [],
  density = "comfortable",
  showPreviews = false,
  sort = "updated_desc",
  showArchived = false,
  loading,
  emptyLabel,
  defaultProjectExpanded = true,
  onOpenProjectFolder: _onOpenProjectFolder,
  onRemoveProject,
  onCreateTask,
}: ChatListProps) {
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_SESSIONS);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() =>
    new Set(defaultProjectExpanded ? ["__all__"] : [])
  );
  const { t } = useTranslation();
  const labels = useMemo(() => ({
    pinned: t("chat.groups.pinned"),
    conversations: t("chat.groups.conversations"),
    archived: t("chat.groups.archived"),
    fallbackTitle: t("chat.newChat"),
  }), [t]);
  const { defaultGroup, projectGroups, archivedGroup, pinnedGroup } = useMemo(
    () => groupSessions(sessions, labels, {
      pinnedKeys,
      archivedKeys,
      titleOverrides,
      showArchived,
      sort,
    }),
    [
      archivedKeys,
      labels,
      pinnedKeys,
      sessions,
      showArchived,
      sort,
      titleOverrides,
    ],
  );
  const groups = useMemo(
    () => [pinnedGroup, ...projectGroups, defaultGroup, archivedGroup].filter((g): g is ChatSection => !!g),
    [defaultGroup, projectGroups, pinnedGroup, archivedGroup],
  );
  const limitedGroups = useMemo(
    () => limitGroups(groups, visibleLimit, activeKey),
    [activeKey, groups, visibleLimit],
  );

  const toggleProject = useCallback((workspace: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  }, []);
  const totalSessionCount = useMemo(
    () => [defaultGroup, ...projectGroups, pinnedGroup, archivedGroup]
      .filter(Boolean)
      .reduce((total, group) => total + (group?.sessions.length ?? 0), 0),
    [defaultGroup, projectGroups, pinnedGroup, archivedGroup],
  );
  const visibleSessionCount = useMemo(
    () => limitedGroups.reduce((total, group) => total + group.sessions.length, 0),
    [limitedGroups],
  );
  const hiddenSessionCount = Math.max(0, totalSessionCount - visibleSessionCount);

  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_SESSIONS);
  }, [showArchived, sort]);

  if (loading && sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-[12px] text-muted-foreground">
        {t("chat.loading")}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-[12px] leading-5 text-muted-foreground/80">
        {emptyLabel ?? t("chat.noSessions")}
      </div>
    );
  }

  const pinned = new Set(pinnedKeys);
  const archived = new Set(archivedKeys);
  const running = new Set(runningChatIds);
  const completed = new Set(completedChatIds);
  const compact = density === "compact";

  return (
    <div className="scrollbar-hover h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="min-w-0 space-y-3 px-2 py-1.5">
        {limitedGroups.map((group) => {
          const isProject = group.isProject && group.workspace;
          const expanded = isProject ? expandedProjects.has(group.workspace!) : true;
          return (
          <section key={group.label} aria-label={group.label}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
            <div
              className={cn(
                "group/header flex items-center gap-1 px-2 pb-1 text-[12px] font-medium text-muted-foreground/65",
                isProject && "cursor-pointer select-none hover:text-muted-foreground",
              )}
              onClick={() => isProject && group.workspace && toggleProject(group.workspace)}
              role={isProject ? "button" : undefined}
              tabIndex={isProject ? 0 : undefined}
              aria-expanded={isProject ? expanded : undefined}
            >
              {isProject ? (
                expanded ? (
                  <FolderOpen className="mr-1 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Folder className="mr-1 h-3.5 w-3.5 shrink-0" />
                )
              ) : null}
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              {isProject && group.workspace ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground group-hover/header:opacity-100"
                      aria-label={t("common.more", "更多")}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                    <DropdownMenuItem onSelect={() => onCreateTask?.(group.workspace!)}>
                      <Plus className="mr-2 h-4 w-4" />
                      {t("chat.newTask", "创建新任务")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onRemoveProject?.(group.workspace!)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("common.delete", "删除")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
              </ContextMenuTrigger>
              {isProject && group.workspace ? (
                <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                  <ContextMenuItem onSelect={() => onCreateTask?.(group.workspace!)}>
                    <Plus className="mr-2 h-4 w-4" />
                    {t("chat.newTask", "创建新任务")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => onRemoveProject?.(group.workspace!)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("common.delete", "删除")}
                  </ContextMenuItem>
                </ContextMenuContent>
              ) : null}
            </ContextMenu>
            {expanded ? (
            <ul className="space-y-0.5">
              {group.sessions.map((s) => {
                const active = s.key === activeKey;
                const fallbackTitle = t("chat.fallbackTitle", {
                  id: s.chatId.slice(0, 6),
                });
                const generatedTitle = s.title?.trim() || "";
                const title = displayTitle(s, titleOverrides, t("chat.newChat"));
                const tooltipTitle =
                  titleOverrides[s.key]?.trim() ||
                  generatedTitle ||
                  deriveTitle(s.preview, fallbackTitle);
                const isPinned = pinned.has(s.key);
                const isArchived = archived.has(s.key);
                const preview = s.preview.trim();
                const showPreview = showPreviews && preview && preview !== title;
                const timestamp = relativeTime(s.updatedAt ?? s.createdAt);
                const activityState = running.has(s.chatId)
                  ? "running"
                  : completed.has(s.chatId)
                    ? "complete"
                    : null;
                return (
                  <li key={s.key} className="min-w-0">
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <div
                          className={cn(
                            "group flex min-w-0 max-w-full items-center gap-2 rounded-xl px-2 text-[13px] transition-colors",
                            compact ? "min-h-7" : "min-h-8",
                            active
                              ? "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-sidebar-foreground"
                              : "text-sidebar-foreground/82 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                          )}
                        >
                      <button
                        type="button"
                        onClick={() => onSelect(s.key)}
                        title={tooltipTitle}
                        className={cn(
                          "min-w-0 flex-1 overflow-hidden text-left",
                          compact ? "py-1" : "py-1.5",
                        )}
                      >
                        <span className="block w-full truncate font-medium leading-5">{title}</span>
                        {showPreview ? (
                          <span className="block w-full truncate text-[11.5px] leading-4 text-muted-foreground/72">
                            {preview}
                          </span>
                        ) : null}
                      </button>
                      <SessionActivityIndicator state={activityState} />
                      {timestamp ? (
                        <span className="shrink-0 text-[11px] leading-4 text-muted-foreground/58">
                          {timestamp}
                        </span>
                      ) : null}
                        </div>
                      </ContextMenuTrigger>
                    <ContextMenuContent
                      onCloseAutoFocus={(event) => event.preventDefault()}
                    >
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
                        onSelect={() => onRequestRename(s.key, title)}
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
                          window.setTimeout(() => onRequestDelete(s.key, title), 0);
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
              className="h-8 w-full rounded-full text-[12px] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
            >
              {t("chat.showMore", { count: hiddenSessionCount })}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function SessionActivityIndicator({
  state,
}: {
  state: "running" | "complete" | null;
}) {
  const { t } = useTranslation();

  if (state === "running") {
    const label = t("chat.activity.running");
    return (
      <span
        aria-label={label}
        title={label}
        className="grid h-4 w-4 shrink-0 place-items-center"
      >
        <span className="h-3 w-3 animate-spin rounded-full border border-blue-500/25 border-t-blue-500 [animation-duration:1.4s] motion-reduce:animate-none dark:border-blue-400/25 dark:border-t-blue-400" />
      </span>
    );
  }

  if (state === "complete") {
    const label = t("chat.activity.complete");
    return (
      <span
        aria-label={label}
        title={label}
        className="grid h-4 w-4 shrink-0 place-items-center"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)] dark:bg-blue-400 dark:shadow-[0_0_0_3px_rgba(96,165,250,0.18)]" />
      </span>
    );
  }

  return <span className="h-4 w-4 shrink-0" aria-hidden="true" />;
}

interface GroupSessionsResult {
  defaultGroup: ChatSection;
  projectGroups: ChatSection[];
  archivedGroup: ChatSection | null;
  pinnedGroup: ChatSection | null;
}

function groupSessions(
  sessions: ChatSummary[],
  labels: {
    pinned: string;
    conversations: string;
    archived: string;
    fallbackTitle: string;
  },
  options: {
    pinnedKeys: string[];
    archivedKeys: string[];
    titleOverrides: Record<string, string>;
    showArchived: boolean;
    sort: SidebarSortMode;
  },
): GroupSessionsResult {
  const pinned = new Set(options.pinnedKeys);
  const archived = new Set(options.archivedKeys);

  const pinnedSessions: ChatSummary[] = [];
  const archivedSessions: ChatSummary[] = [];

  // Partition non-pinned, non-archived sessions by workspace.
  // Default workspace (null/empty) → "会话" section.
  // Project workspace → "{basename} · {fullpath}" section.
  const workspaceOrder: string[] = [];
  const workspaceBuckets = new Map<string, ChatSummary[]>();
  const DEFAULT_KEY = "__default__";

  const bucketOf = (ws: string | null | undefined): string =>
    ws && ws.trim() ? ws : DEFAULT_KEY;

  const ensureBucket = (key: string) => {
    if (!workspaceBuckets.has(key)) {
      workspaceBuckets.set(key, []);
      workspaceOrder.push(key);
    }
  };

  for (const session of sessions) {
    if (archived.has(session.key)) {
      if (options.showArchived) archivedSessions.push(session);
      continue;
    }
    if (pinned.has(session.key)) {
      pinnedSessions.push(session);
      continue;
    }
    const bucketKey = bucketOf(session.workspace);
    ensureBucket(bucketKey);
    workspaceBuckets.get(bucketKey)!.push(session);
  }

  // Ensure the default "会话" section always exists.
  ensureBucket(DEFAULT_KEY);

  const defaultGroup: ChatSection = {
    label: labels.conversations,
    isDefault: true,
    sessions: sortSessions(workspaceBuckets.get(DEFAULT_KEY) ?? [], options.sort, options.titleOverrides),
  };

  const projectGroups: ChatSection[] = [];
  for (const bucketKey of workspaceOrder) {
    if (bucketKey === DEFAULT_KEY) continue;
    const list = workspaceBuckets.get(bucketKey) ?? [];
    projectGroups.push({
      label: workspaceLabel(bucketKey),
      isProject: true,
      workspace: bucketKey,
      sessions: sortSessions(list, options.sort, options.titleOverrides),
    });
  }

  const pinnedGroup: ChatSection | null = pinnedSessions.length
    ? {
        label: labels.pinned,
        sessions: sortSessions(pinnedSessions, options.sort, options.titleOverrides),
      }
    : null;

  const archivedGroup: ChatSection | null = archivedSessions.length
    ? {
        label: labels.archived,
        sessions: sortSessions(archivedSessions, options.sort, options.titleOverrides),
      }
    : null;

  return { defaultGroup, projectGroups, archivedGroup, pinnedGroup };
}

/** Render a workspace path as ``{basename} · {fullpath}`` for the section header. */
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

function sortSessions(
  sessions: ChatSummary[],
  sort: SidebarSortMode,
  titleOverrides: Record<string, string>,
): ChatSummary[] {
  const copy = [...sessions];
  copy.sort((a, b) => {
    if (sort === "title_asc") {
      const titleOrder = titleForSort(a, titleOverrides).localeCompare(
        titleForSort(b, titleOverrides),
        "en",
        { numeric: true, sensitivity: "base" },
      );
      if (titleOrder !== 0) return titleOrder;
      return sessionTime(b, "updatedAt") - sessionTime(a, "updatedAt");
    }
    const aTime = sessionTime(a, sort === "created_desc" ? "createdAt" : "updatedAt");
    const bTime = sessionTime(b, sort === "created_desc" ? "createdAt" : "updatedAt");
    return bTime - aTime;
  });
  return copy;
}

function titleForSort(
  session: ChatSummary,
  titleOverrides: Record<string, string>,
): string {
  return (
    titleOverrides[session.key]?.trim() ||
    session.title?.trim() ||
    deriveTitle(session.preview, "new chat")
  ).toLocaleLowerCase("en");
}

function displayTitle(
  session: ChatSummary,
  titleOverrides: Record<string, string>,
  fallbackTitle: string,
): string {
  return (
    titleOverrides[session.key]?.trim() ||
    session.title?.trim() ||
    deriveTitle(session.preview, fallbackTitle)
  );
}

function sessionTime(
  session: ChatSummary,
  field: "createdAt" | "updatedAt",
): number {
  const primary = Date.parse(session[field] ?? "");
  if (Number.isFinite(primary)) return primary;
  const fallback = Date.parse(session.updatedAt ?? session.createdAt ?? "");
  return Number.isFinite(fallback) ? fallback : 0;
}
