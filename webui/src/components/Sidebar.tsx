import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  LogIn,
  Menu,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { ChatList } from "@/components/ChatList";
import { useEmailStore } from "@/components/email/store/emailStore";

import sidebarMonaIcon from "@/assets/icons/sidebar-mona.png";
import sidebarNoteIcon from "@/assets/icons/sidebar-note.png";
import sidebarTerminalIcon from "@/assets/icons/sidebar-terminal.png";
import sidebarDatabaseIcon from "@/assets/icons/sidebar-database.png";
import sidebarKnowledgeIcon from "@/assets/icons/sidebar-knowledge.png";
import sidebarDocIcon from "@/assets/icons/sidebar-doc.png";
import sidebarEmailIcon from "@/assets/icons/sidebar-email.png";
import sidebarScheduleIcon from "@/assets/icons/sidebar-schedule.png";
import sidebarProfileIcon from "@/assets/icons/sidebar-profile.png";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLicense } from "@/hooks/useLicense";
import { deriveTitle } from "@/lib/format";
import type {
  ChatSummary,
  SidebarViewState,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface SidebarProps {
  sessions: ChatSummary[];
  activeKey: string | null;
  loading: boolean;
  onNewChat: () => void;
  onSelect: (key: string) => void;
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onToggleArchive: (key: string) => void;
  onOpenSettings: (section?: string) => void;
  onOpenLogin?: () => void;
  onOpenSubscribe?: () => void;
  onOpenNote?: () => void;
  onOpenDoc?: () => void;
  onOpenSSH?: () => void;
  onOpenDb?: () => void;
  onOpenKb?: () => void;
  onOpenEmail?: () => void;
  onOpenSchedule?: () => void;
  onOpenProfile?: () => void;
  onOpenSearch: () => void;
  onToggleArchived: () => void;
  onUpdateView: (view: Partial<SidebarViewState>) => void;
  onCollapse: () => void;
  onExpand?: () => void;
  onGoHome?: () => void;
  containActionMenus?: boolean;
  collapsed?: boolean;
  pinnedKeys?: string[];
  archivedKeys?: string[];
  titleOverrides?: Record<string, string>;
  runningChatIds?: string[];
  completedChatIds?: string[];
  viewState?: SidebarViewState;
  showArchived?: boolean;
  archivedCount?: number;
  onRemoveProject?: (workspace: string) => void;
  onCreateTask?: (workspace: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const { loggedIn, licenseInfo, licenseActive, localTrial, localTrialExpired, serverTrial, remainingDays } =
    useLicense();
  const [menuPortalContainer, setMenuPortalContainer] =
    useState<HTMLElement | null>(null);
  const collapsed = Boolean(props.collapsed);
  const toggleLabel = t("thread.header.toggleSidebar");
  const agentLogoState = props.runningChatIds?.length ? "working" : "idle";
  // 订阅邮件总未读数，用于邮件图标角标（全局初始化时已从 SQLite 加载）
  const emailUnreadCount = useEmailStore((s) => s.totalUnreadCount);

  return (
    <nav
      ref={props.containActionMenus ? setMenuPortalContainer : undefined}
      aria-label={t("sidebar.navigation")}
      className="flex h-full w-full min-w-0 flex-col border-r border-sidebar-border/60 bg-sidebar text-sidebar-foreground"
    >
      <div
        className={cn(
          "flex items-center px-3 pb-2.5 pt-3",
          collapsed ? "w-14 justify-start" : "justify-between",
        )}
      >
        <button
          type="button"
          aria-label={collapsed ? toggleLabel : undefined}
          aria-hidden={collapsed ? undefined : true}
          title={collapsed ? toggleLabel : undefined}
          onClick={collapsed ? props.onExpand : undefined}
          tabIndex={collapsed ? 0 : -1}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-colors",
            collapsed
              ? "-ml-0.5 hover:bg-sidebar-accent/75"
              : "-ml-0.5",
          )}
        >
          <AgentLogo state={agentLogoState} className="h-8 w-8" />
        </button>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("sidebar.collapse")}
            onClick={props.onCollapse}
            className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground"
          >
            <Menu className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <ToolboxNavigation
        collapsed={collapsed}
        onNewChat={props.onNewChat}
        onOpenNote={props.onOpenNote ?? (() => {})}
        onOpenDoc={props.onOpenDoc ?? (() => {})}
        onOpenSSH={props.onOpenSSH ?? (() => {})}
        onOpenDb={props.onOpenDb ?? (() => {})}
        onOpenKb={props.onOpenKb ?? (() => {})}
        onOpenEmail={props.onOpenEmail ?? (() => {})}
        onOpenSchedule={props.onOpenSchedule ?? (() => {})}
        onOpenProfile={props.onOpenProfile ?? (() => {})}
        onGoHome={props.onGoHome ?? (() => {})}
        emailUnreadCount={emailUnreadCount}
      />
      <Separator className="mx-2 mb-2 bg-sidebar-border/50" />

      <div
        className={cn(
          "space-y-1.5 px-2 pb-2",
          collapsed && "flex w-14 flex-col items-center px-0",
        )}
      >
        <SidebarActionButton
          collapsed={collapsed}
          label={t("sidebar.searchAria")}
          onClick={props.onOpenSearch}
          icon={<Search className="h-4 w-4" />}
        />
        {props.archivedCount ? (
          <SidebarActionButton
            collapsed={collapsed}
            label={props.showArchived ? t("chat.hideArchived") : t("chat.showArchived")}
            onClick={props.onToggleArchived}
            icon={<Archive className="h-4 w-4" />}
          />
        ) : null}
      </div>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-opacity duration-200",
        )}
      >
        {collapsed ? (
          <CollapsedChatList
            sessions={props.sessions}
            activeKey={props.activeKey}
            onSelect={props.onSelect}
            titleOverrides={props.titleOverrides ?? {}}
            pinnedKeys={props.pinnedKeys ?? []}
            archivedKeys={props.archivedKeys ?? []}
            onRequestDelete={props.onRequestDelete}
            onTogglePin={props.onTogglePin}
            onRequestRename={props.onRequestRename}
            onToggleArchive={props.onToggleArchive}
          />
        ) : (
          <ChatList
            sessions={props.sessions}
            activeKey={props.activeKey}
            loading={props.loading}
            emptyLabel={t("chat.noSessions")}
            onSelect={props.onSelect}
            onRequestDelete={props.onRequestDelete}
            onTogglePin={props.onTogglePin}
            onRequestRename={props.onRequestRename}
            onToggleArchive={props.onToggleArchive}
            pinnedKeys={props.pinnedKeys}
            archivedKeys={props.archivedKeys}
            titleOverrides={props.titleOverrides}
            runningChatIds={props.runningChatIds}
            completedChatIds={props.completedChatIds}
            density={props.viewState?.density}
            showPreviews={props.viewState?.show_previews}
            showTimestamps={props.viewState?.show_timestamps}
            sort={props.viewState?.sort}
            showArchived={props.showArchived}
            actionMenuPortalContainer={
              props.containActionMenus ? menuPortalContainer : undefined
            }
            onRemoveProject={props.onRemoveProject}
            onCreateTask={props.onCreateTask}
          />
        )}
      </div>
      <Separator className="bg-sidebar-border/50" />
      <div
        className={cn(
          "flex items-center gap-1 px-2.5 py-2.5 text-xs",
          collapsed && "w-14 flex-col px-0",
        )}
      >
        {loggedIn ? (
          <div className={cn("flex items-center gap-1", collapsed ? "w-14 flex-col px-0" : "w-full")}>
            <SidebarActionButton
              collapsed={collapsed}
              label={licenseInfo?.email ?? t("sidebar.settings")}
              onClick={props.onOpenLogin ?? (() => {})}
              className={collapsed ? undefined : "flex-1"}
              icon={<User className="h-4 w-4" />}
            />
            {!collapsed && (!licenseActive || serverTrial || localTrial) && (
              <Button
                size="sm"
                onClick={props.onOpenSubscribe ?? props.onOpenLogin}
                className="h-5 shrink-0 rounded-full bg-blue-500/15 px-1.5 text-[10px] font-medium text-blue-600 hover:bg-blue-500/25 dark:text-blue-400"
              >
                升级 Pro
              </Button>
            )}
          </div>
        ) : localTrial && !localTrialExpired ? (
          <div className={cn("flex items-center gap-1", collapsed ? "w-14 flex-col px-0" : "w-full")}>
            <SidebarActionButton
              collapsed={collapsed}
              label={`试用剩余 ${remainingDays} 天`}
              onClick={props.onOpenLogin ?? (() => {})}
              className={collapsed ? undefined : "flex-1"}
              icon={<User className="h-4 w-4" />}
            />
            {!collapsed && (
              <Button
                size="sm"
                onClick={props.onOpenSubscribe ?? props.onOpenLogin}
                className="h-5 shrink-0 rounded-full bg-blue-500/15 px-1.5 text-[10px] font-medium text-blue-600 hover:bg-blue-500/25 dark:text-blue-400"
              >
                升级 Pro
              </Button>
            )}
          </div>
        ) : (
          <div className={cn("flex items-center gap-1", collapsed ? "w-14 flex-col px-0" : "w-full")}>
            <SidebarActionButton
              collapsed={collapsed}
              label={t("sidebar.login", "登录")}
              onClick={props.onOpenLogin ?? (() => {})}
              className={collapsed ? undefined : "flex-1"}
              icon={<LogIn className="h-4 w-4" />}
            />
            {!collapsed && (
              <Button
                size="sm"
                onClick={props.onOpenSubscribe ?? props.onOpenLogin}
                className="h-5 shrink-0 rounded-full bg-blue-500/15 px-1.5 text-[10px] font-medium text-blue-600 hover:bg-blue-500/25 dark:text-blue-400"
              >
                购买订阅
              </Button>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}

type ToolboxItem = {
  label: string;
  icon: ReactNode;
};

// 一级主入口（始终展示在侧边栏）
const PRIMARY_ITEMS: ToolboxItem[] = [
  { label: "Mona", icon: <img src={sidebarMonaIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "笔记", icon: <img src={sidebarNoteIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "终端", icon: <img src={sidebarTerminalIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "邮件", icon: <img src={sidebarEmailIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "日程", icon: <img src={sidebarScheduleIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
];

// 二级入口（收纳在"更多"菜单中）
const SECONDARY_ITEMS: ToolboxItem[] = [
  { label: "数据库", icon: <img src={sidebarDatabaseIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "知识库", icon: <img src={sidebarKnowledgeIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "AI文档", icon: <img src={sidebarDocIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { label: "画像", icon: <img src={sidebarProfileIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
];

function getToolboxHandler(label: string, handlers: {
  onNewChat: () => void;
  onOpenNote: () => void;
  onOpenDoc: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenKb: () => void;
  onOpenEmail: () => void;
  onOpenSchedule: () => void;
  onOpenProfile: () => void;
  onGoHome: () => void;
}): () => void {
  switch (label) {
    case "Mona": return handlers.onNewChat;
    case "笔记": return handlers.onOpenNote;
    case "AI文档": return handlers.onOpenDoc;
    case "终端": return handlers.onOpenSSH;
    case "数据库": return handlers.onOpenDb;
    case "知识库": return handlers.onOpenKb;
    case "邮件": return handlers.onOpenEmail;
    case "日程": return handlers.onOpenSchedule;
    case "画像": return handlers.onOpenProfile;
    default: return handlers.onGoHome;
  }
}

function ToolboxNavigation({
  collapsed,
  onNewChat,
  onOpenNote,
  onOpenDoc,
  onOpenSSH,
  onOpenDb,
  onOpenKb,
  onOpenEmail,
  onOpenSchedule,
  onOpenProfile,
  onGoHome,
  emailUnreadCount,
}: {
  collapsed: boolean;
  onNewChat: () => void;
  onOpenNote: () => void;
  onOpenDoc: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenKb: () => void;
  onOpenEmail: () => void;
  onOpenSchedule: () => void;
  onOpenProfile: () => void;
  onGoHome: () => void;
  emailUnreadCount: number;
}) {
  const { licenseActive } = useLicense();
  const LICENSE_REQUIRED = new Set(["知识库", "AI文档", "邮件"]);
  const handlers = {
    onNewChat,
    onOpenNote,
    onOpenDoc,
    onOpenSSH,
    onOpenDb,
    onOpenKb,
    onOpenEmail,
    onOpenSchedule,
    onOpenProfile,
    onGoHome,
  };
  const visibleSecondary = licenseActive
    ? SECONDARY_ITEMS
    : SECONDARY_ITEMS.filter((item) => !LICENSE_REQUIRED.has(item.label));

  return (
    <div
      className={cn(
        "space-y-1 px-2 pb-2",
        collapsed && "flex w-14 flex-col items-center px-0",
      )}
    >
      {PRIMARY_ITEMS.map((item) => {
        const onClick = getToolboxHandler(item.label, handlers);
        // 邮件图标显示未读数角标
        const badge = item.label === "邮件" && emailUnreadCount > 0 ? emailUnreadCount : undefined;
        return (
          <SidebarActionButton
            key={item.label}
            collapsed={collapsed}
            label={item.label}
            onClick={onClick}
            icon={item.icon}
            badge={badge}
          />
        );
      })}
      {visibleSecondary.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              aria-label="更多"
              title={collapsed ? "更多" : undefined}
              className={cn(
                "group relative h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground",
                "transition-[width,padding,border-radius,color,background-color] duration-300 ease-out",
                collapsed
                  ? "w-9 justify-center gap-0 rounded-xl px-0"
                  : "w-full justify-start gap-2 px-3 text-[12.5px]",
              )}
            >
              <span className="flex shrink-0 items-center justify-center" aria-hidden>
                <MoreHorizontal className="h-5 w-5" />
              </span>
              <span
                className={cn(
                  "min-w-0 overflow-hidden truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-200 ease-out",
                  collapsed
                    ? "max-w-0 -translate-x-1 opacity-0"
                    : "max-w-[12rem] translate-x-0 opacity-100",
                )}
              >
                更多
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={collapsed ? "right" : "right"}
            align={collapsed ? "center" : "start"}
            sideOffset={8}
            className="min-w-[160px]"
          >
            {visibleSecondary.map((item) => (
              <DropdownMenuItem
                key={item.label}
                className="gap-2 px-2.5 py-1.5 text-[13px]"
                onSelect={() => getToolboxHandler(item.label, handlers)()}
              >
                {item.icon}
                <span>{item.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function SidebarActionButton({
  collapsed,
  label,
  icon,
  onClick,
  className,
  active = false,
  badge,
}: {
  collapsed: boolean;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
  active?: boolean;
  /** 未读数角标（>0 时显示，>99 显示 99+） */
  badge?: number;
}) {
  const badgeText = badge != null && badge > 0 ? (badge > 99 ? "99+" : String(badge)) : null;
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={cn(
        "group relative h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground",
        "transition-[width,padding,border-radius,color,background-color] duration-300 ease-out",
        active &&
          "bg-sidebar-accent/80 text-sidebar-foreground shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border)/0.35)]",
        collapsed
          ? "w-9 justify-center gap-0 rounded-xl px-0"
          : "w-full justify-start gap-2 px-3 text-[12.5px]",
        className,
      )}
    >
      {icon && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center transition-transform duration-300 ease-out",
            collapsed ? "translate-x-0" : "translate-x-0",
          )}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 overflow-hidden truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-200 ease-out",
          collapsed
            ? "max-w-0 -translate-x-1 opacity-0"
            : "max-w-[12rem] translate-x-0 opacity-100",
        )}
      >
        {label}
      </span>
      {badgeText && (
        <span
          className={cn(
            "pointer-events-none absolute flex items-center justify-center bg-red-500 font-medium text-white",
            collapsed
              ? "right-0.5 top-0.5 min-w-[16px] h-[16px] rounded-full px-1 text-[9px] leading-none"
              : "right-1.5 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] rounded-full px-1 text-[10px] leading-none",
          )}
          aria-hidden
        >
          {badgeText}
        </span>
      )}
    </Button>
  );
}

function CollapsedChatList({
  sessions,
  activeKey,
  onSelect,
  titleOverrides,
  pinnedKeys,
  archivedKeys,
  onRequestDelete,
  onTogglePin,
  onRequestRename,
  onToggleArchive,
}: {
  sessions: ChatSummary[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  titleOverrides: Record<string, string>;
  pinnedKeys: string[];
  archivedKeys: string[];
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onToggleArchive: (key: string) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  const pinned = new Set(pinnedKeys);
  const archived = new Set(archivedKeys);

  const sorted = [...sessions].sort((a, b) => {
    const at = Date.parse(a.updatedAt ?? a.createdAt ?? "");
    const bt = Date.parse(b.updatedAt ?? b.createdAt ?? "");
    return bt - at;
  });
  const recent = sorted.slice(0, 30);

  const updateScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 4);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  };

  useEffect(() => {
    updateScrollState();
  }, [recent.length]);

  if (recent.length === 0) {
    return null;
  }

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ top: delta, behavior: "smooth" });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex h-full min-h-0 flex-col items-center">
        {canScrollUp && (
          <button
            type="button"
            onClick={() => scrollBy(-108)}
            aria-label={t("common.scrollUp", "向上滚动")}
            className="absolute top-0 z-10 flex h-5 w-9 items-center justify-center rounded-full bg-sidebar/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-sidebar-foreground"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          className="flex h-full flex-col items-center gap-1 overflow-y-auto overflow-x-hidden px-0 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {recent.map((s) => {
            const active = s.key === activeKey;
            const title =
              titleOverrides[s.key]?.trim() ||
              s.title?.trim() ||
              deriveTitle(s.preview, t("chat.newChat"));
            const initial = title.charAt(0).toUpperCase() || "?";
            const isPinned = pinned.has(s.key);
            const isArchived = archived.has(s.key);
            return (
              <ContextMenu key={s.key}>
                <ContextMenuTrigger asChild>
                  <div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-medium transition-colors",
                            active
                              ? "bg-sidebar-accent/80 text-sidebar-foreground shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border)/0.35)]"
                              : "text-muted-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                          )}
                        >
                          {initial}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-[200px] truncate">
                        {title}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                  <ContextMenuItem onSelect={() => onTogglePin(s.key)}>
                    {isPinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
                    {isPinned ? t("chat.unpin") : t("chat.pin")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onRequestRename(s.key, title)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("chat.rename")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onToggleArchive(s.key)}>
                    {isArchived ? <ArchiveRestore className="mr-2 h-4 w-4" /> : <Archive className="mr-2 h-4 w-4" />}
                    {isArchived ? t("chat.unarchive") : t("chat.archive")}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => window.setTimeout(() => onRequestDelete(s.key, title), 0)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("chat.delete")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        {canScrollDown && (
          <button
            type="button"
            onClick={() => scrollBy(108)}
            aria-label={t("common.scrollDown", "向下滚动")}
            className="absolute bottom-0 z-10 flex h-5 w-9 items-center justify-center rounded-full bg-sidebar/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-sidebar-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </TooltipProvider>
  );
}
