import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Download,
  LogIn,
  LogOut,
  Menu,
  MoreHorizontal,
  LockKeyhole,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Sparkles,
  Trash2,
  User,
  UserCog,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { ChatList } from "@/components/ChatList";
import { useEmailStore } from "@/components/email/store/emailStore";
import { useTodoStore } from "@/components/schedule/todoStore";

import sidebarMonaIcon from "@/assets/icons/sidebar-mona.png";
import sidebarNoteIcon from "@/assets/icons/sidebar-note.png";
import sidebarTerminalIcon from "@/assets/icons/sidebar-terminal.png";
import sidebarDatabaseIcon from "@/assets/icons/sidebar-database.png";
import sidebarDocIcon from "@/assets/icons/sidebar-doc.png";
import sidebarEmailIcon from "@/assets/icons/sidebar-email.png";
import sidebarScheduleIcon from "@/assets/icons/sidebar-schedule.png";
import sidebarSystemIcon from "@/assets/icons/sidebar-system.png";
import sidebarProfileIcon from "@/assets/icons/sidebar-profile.png";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import type { SidebarModuleConfig } from "@/lib/tauri";
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
  onOpenEmail?: () => void;
  onOpenSchedule?: () => void;
  onOpenSystem?: () => void;
  onOpenProfile?: () => void;
  onOpenSearch: () => void;
  onToggleArchived: () => void;
  onUpdateView: (view: Partial<SidebarViewState>) => void;
  onCollapse: () => void;
  onExpand?: () => void;
  onGoHome?: () => void;
  containActionMenus?: boolean;
  collapsed?: boolean;
  updateAvailable?: boolean;
  onStartUpdate?: () => void;
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
  modules?: SidebarModuleConfig[];
}

export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const { loggedIn, licenseInfo, licenseActive, serverTrial, logout } =
    useLicense();
  const [menuPortalContainer, setMenuPortalContainer] =
    useState<HTMLElement | null>(null);
  const collapsed = Boolean(props.collapsed);
  const toggleLabel = t("thread.header.toggleSidebar");
  const agentLogoState = props.runningChatIds?.length ? "working" : "idle";
  // 订阅邮件总未读数，用于邮件图标角标（全局初始化时已从 SQLite 加载）
  const emailUnreadCount = useEmailStore((s) => s.totalUnreadCount);
  // 订阅计划收集箱数量（待确认建议 + 未分类待办 + 待确认邮件日程）
  const planInboxCount = useTodoStore((s) => s.inboxCount);

  return (
    <TooltipProvider delayDuration={0}>
    <nav
      ref={props.containActionMenus ? setMenuPortalContainer : undefined}
      aria-label={t("sidebar.navigation")}
      className="flex h-full w-full min-w-0 flex-col bg-transparent text-sidebar-foreground"
    >
      <div
        className={cn(
          "flex items-center px-3 pb-2.5 pt-3",
          collapsed ? "w-14 justify-start" : "justify-between",
        )}
      >
        <CollapsedTooltip label={toggleLabel} collapsed={collapsed}>
          <button
            type="button"
            aria-label={collapsed ? toggleLabel : undefined}
            aria-hidden={collapsed ? undefined : true}
            onClick={collapsed ? props.onExpand : undefined}
            tabIndex={collapsed ? 0 : -1}
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-colors",
              collapsed
                ? "-ml-0.5 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]"
                : "-ml-0.5",
            )}
          >
            <AgentLogo state={agentLogoState} className="h-8 w-8" />
          </button>
        </CollapsedTooltip>
        {!collapsed && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("sidebar.collapse")}
            onClick={props.onCollapse}
            className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
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
        onOpenEmail={props.onOpenEmail ?? (() => {})}
        onOpenSchedule={props.onOpenSchedule ?? (() => {})}
        onOpenSystem={props.onOpenSystem ?? (() => {})}
        onOpenProfile={props.onOpenProfile ?? (() => {})}
        onGoHome={props.onGoHome ?? (() => {})}
        emailUnreadCount={emailUnreadCount}
        planInboxCount={planInboxCount}
        modules={props.modules}
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
            runningChatIds={props.runningChatIds}
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
            <DropdownMenu>
              <CollapsedTooltip label={licenseInfo?.account ?? licenseInfo?.email ?? t("sidebar.account", "账号")} collapsed={collapsed}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={licenseInfo?.account ?? licenseInfo?.email ?? t("sidebar.account", "账号")}
                    className={cn(
                      "group relative h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                      "transition-[width,padding,border-radius,color,background-color] duration-300 ease-out",
                      collapsed
                        ? "flex w-9 shrink-0 items-center justify-center gap-0 rounded-xl px-0"
                        : "flex w-full shrink-0 items-center justify-start gap-2 px-3 text-[12.5px]",
                    )}
                  >
                    <span className="flex shrink-0 items-center justify-center" aria-hidden>
                      <User className="h-4 w-4" />
                    </span>
                    <span
                      className={cn(
                        "min-w-0 overflow-hidden truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-200 ease-out",
                        collapsed
                          ? "max-w-0 -translate-x-0 opacity-0"
                          : "max-w-[10rem] translate-x-0 opacity-100",
                      )}
                    >
                      {licenseInfo?.account ?? licenseInfo?.email ?? t("sidebar.account", "账号")}
                    </span>
                    {collapsed && props.updateAvailable && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          props.onStartUpdate?.();
                        }}
                        className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-blue-500 text-white shadow-sm ring-2 ring-sidebar transition-colors hover:bg-blue-600"
                        aria-label="发现新版本，点击立即更新"
                      >
                        <Download className="h-2 w-2" />
                      </button>
                    )}
                  </button>
                </DropdownMenuTrigger>
              </CollapsedTooltip>
              <DropdownMenuContent
                side="top"
                align={collapsed ? "center" : "start"}
                sideOffset={8}
                className="min-w-[200px]"
              >
                <DropdownMenuLabel className="px-2.5 py-2 font-normal">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400">
                      <User className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-foreground">
                          {licenseInfo?.account ?? licenseInfo?.email ?? t("sidebar.account", "账号")}
                        </span>
                        {licenseActive && !serverTrial && (
                          <span className="shrink-0 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-1 py-px text-[8px] font-bold leading-tight text-white">
                            Pro
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px]"
                  onSelect={() => props.onOpenLogin?.()}
                >
                  <UserCog className="h-4 w-4" />
                  <span>管理账户</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px]"
                  onSelect={() => props.onOpenSettings()}
                >
                  <Settings className="h-4 w-4" />
                  <span>设置</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(!licenseActive || serverTrial) && (
                  <>
                    <DropdownMenuItem
                      className="gap-2 px-2.5 py-1.5 text-[13px]"
                      onSelect={() => (props.onOpenSubscribe ?? props.onOpenLogin)?.()}
                    >
                      <Sparkles className="h-4 w-4 text-amber-500" />
                      <span>升级 Pro</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem
                  className="gap-2 px-2.5 py-1.5 text-[13px] text-destructive focus:text-destructive"
                  onSelect={() => void logout()}
                >
                  <LogOut className="h-4 w-4" />
                  <span>退出登录</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {!collapsed && props.updateAvailable && (
              <button
                type="button"
                onClick={() => props.onStartUpdate?.()}
                className="group flex h-5 shrink-0 items-center gap-1 rounded-full bg-gradient-to-r from-blue-500 to-blue-400 px-2 text-[10px] font-medium text-white shadow-sm transition-colors hover:from-blue-600 hover:to-blue-500"
              >
                <Sparkles className="h-2.5 w-2.5 animate-pulse [animation-duration:2s] [animation-timing-function:ease-in-out]" />
                更新
              </button>
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
            {collapsed ? (
              <SidebarActionButton
                collapsed={collapsed}
                label="设置"
                onClick={() => props.onOpenSettings()}
                icon={<Settings className="h-4 w-4" />}
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="设置"
                    onClick={() => props.onOpenSettings()}
                    className="h-8 w-8 shrink-0 rounded-full text-sidebar-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                  >
                    <Settings className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">设置</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </nav>
    </TooltipProvider>
  );
}

function CollapsedTooltip({
  label,
  collapsed,
  side = "right",
  children,
}: {
  label: string;
  collapsed: boolean;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
}) {
  if (!collapsed || !label) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-[200px] truncate">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type ToolboxItem = {
  key: string;
  label: string;
  icon: ReactNode;
  windowsOnly?: boolean;
};

function isMacOS() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad");
}

// 模块元信息表：key 与 ShellView 一致；label/icon 用于侧栏渲染和设置页展示
export const MODULE_DEFS: ToolboxItem[] = [
  { key: "chat", label: "新会话", icon: <img src={sidebarMonaIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "note", label: "笔记", icon: <img src={sidebarNoteIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "doc", label: "AI文档", icon: <img src={sidebarDocIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "ssh", label: "终端", icon: <img src={sidebarTerminalIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "email", label: "邮件", icon: <img src={sidebarEmailIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "schedule", label: "计划", icon: <img src={sidebarScheduleIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "db", label: "数据库", icon: <img src={sidebarDatabaseIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
  { key: "system", label: "系统", icon: <img src={sidebarSystemIcon} className="h-5 w-5 object-contain" alt="" draggable={false} />, windowsOnly: true },
  { key: "profile", label: "画像", icon: <img src={sidebarProfileIcon} className="h-5 w-5 object-contain" alt="" draggable={false} /> },
];

// 默认顺序与可见性（与后端 default_sidebar_modules 对齐）
export const DEFAULT_SIDEBAR_MODULES: SidebarModuleConfig[] = MODULE_DEFS.map((m, i) => ({
  key: m.key,
  visible: true,
  order: i,
}));

// 「新会话」入口锁定不可隐藏
const LOCKED_MODULE_KEYS = new Set(["chat"]);

// 主区域直接展示的最多模块数；超出收纳到「更多」菜单
const PRIMARY_MAX = 6;

// 将用户配置与默认值合并，补齐缺失模块，过滤未知 key
export function mergeSidebarModules(
  userModules?: SidebarModuleConfig[] | null,
): SidebarModuleConfig[] {
  const userMap = new Map<string, SidebarModuleConfig>();
  if (userModules && Array.isArray(userModules)) {
    for (const m of userModules) {
      if (m && typeof m.key === "string" && MODULE_DEFS.some((d) => d.key === m.key)) {
        userMap.set(m.key, {
          key: m.key,
          visible: LOCKED_MODULE_KEYS.has(m.key) ? true : Boolean(m.visible),
          order: typeof m.order === "number" ? m.order : 0,
        });
      }
    }
  }
  const merged: SidebarModuleConfig[] = MODULE_DEFS.map((d, i) => {
    const u = userMap.get(d.key);
    return u
      ? { key: d.key, visible: u.visible, order: u.order }
      : { key: d.key, visible: true, order: i };
  });
  return merged.sort((a, b) => a.order - b.order);
}

function getToolboxHandler(key: string, handlers: {
  onNewChat: () => void;
  onOpenNote: () => void;
  onOpenDoc: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenEmail: () => void;
  onOpenSchedule: () => void;
  onOpenSystem: () => void;
  onOpenProfile: () => void;
  onGoHome: () => void;
}): () => void {
  switch (key) {
    case "chat": return handlers.onNewChat;
    case "note": return handlers.onOpenNote;
    case "doc": return handlers.onOpenDoc;
    case "ssh": return handlers.onOpenSSH;
    case "db": return handlers.onOpenDb;
    case "email": return handlers.onOpenEmail;
    case "schedule": return handlers.onOpenSchedule;
    case "system": return handlers.onOpenSystem;
    case "profile": return handlers.onOpenProfile;
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
  onOpenEmail,
  onOpenSchedule,
  onOpenSystem,
  onOpenProfile,
  onGoHome,
  emailUnreadCount,
  planInboxCount,
  modules,
}: {
  collapsed: boolean;
  onNewChat: () => void;
  onOpenNote: () => void;
  onOpenDoc: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenEmail: () => void;
  onOpenSchedule: () => void;
  onOpenSystem: () => void;
  onOpenProfile: () => void;
  onGoHome: () => void;
  emailUnreadCount: number;
  planInboxCount: number;
  modules?: SidebarModuleConfig[];
}) {
  const { licenseActive } = useLicense();
  const LICENSE_REQUIRED = new Set(["doc"]);
  const handlers = {
    onNewChat,
    onOpenNote,
    onOpenDoc,
    onOpenSSH,
    onOpenDb,
    onOpenEmail,
    onOpenSchedule,
    onOpenSystem,
    onOpenProfile,
    onGoHome,
  };
  const merged = mergeSidebarModules(modules);
  const defMap = new Map(MODULE_DEFS.map((d) => [d.key, d]));
  // 应用运行时过滤：macOS 不显示 windowsOnly 模块
  const filtered = merged
    .filter((m) => m.visible)
    .map((m) => defMap.get(m.key))
    .filter((d): d is ToolboxItem => Boolean(d))
    .filter((d) => !isMacOS() || !d.windowsOnly);
  const visiblePrimary = filtered.slice(0, PRIMARY_MAX);
  const visibleSecondary = filtered.slice(PRIMARY_MAX);

  return (
    <div
      className={cn(
        "space-y-1 px-2 pb-2",
        collapsed && "flex w-14 flex-col items-center px-0",
      )}
    >
      {visiblePrimary.map((item) => {
        const onClick = getToolboxHandler(item.key, handlers);
        // 邮件图标显示未读数角标；计划图标显示收集箱数量（待确认建议+未分类待办+待确认邮件日程）
        const badge =
          item.key === "email" && emailUnreadCount > 0
            ? emailUnreadCount
            : item.key === "schedule" && planInboxCount > 0
              ? planInboxCount
              : undefined;
        return (
          <SidebarActionButton
            key={item.key}
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
          <CollapsedTooltip label="更多" collapsed={collapsed}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="更多"
                className={cn(
                  "group relative h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
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
          </CollapsedTooltip>
          <DropdownMenuContent
            side={collapsed ? "right" : "right"}
            align={collapsed ? "center" : "start"}
            sideOffset={8}
            className="min-w-[160px]"
          >
            {visibleSecondary.map((item) => {
              const locked = !licenseActive && LICENSE_REQUIRED.has(item.key);
              return (
                <DropdownMenuItem
                  key={item.key}
                  className="gap-2 px-2.5 py-1.5 text-[13px]"
                  onSelect={() => getToolboxHandler(item.key, handlers)()}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {locked && <LockKeyhole className="ml-auto h-3.5 w-3.5 text-muted-foreground" />}
                </DropdownMenuItem>
              );
            })}
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
    <CollapsedTooltip label={label} collapsed={collapsed}>
      <Button
        type="button"
        variant="ghost"
        aria-label={label}
        onClick={onClick}
        className={cn(
          "group relative h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
          "transition-[width,padding,border-radius,color,background-color] duration-300 ease-out",
          active &&
            "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-sidebar-foreground",
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
    </CollapsedTooltip>
  );
}

function CollapsedChatList({
  sessions,
  activeKey,
  onSelect,
  titleOverrides,
  pinnedKeys,
  archivedKeys,
  runningChatIds,
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
  runningChatIds?: string[];
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
  const running = new Set(runningChatIds ?? []);

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
    <div className="relative flex h-full min-h-0 flex-col items-center">
        {canScrollUp && (
          <button
            type="button"
            onClick={() => scrollBy(-108)}
            aria-label={t("common.scrollUp", "向上滚动")}
            className="absolute top-0 z-10 flex h-5 w-9 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-sidebar-foreground"
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
            const isRunning = running.has(s.chatId);
            return (
              <ContextMenu key={s.key}>
                <ContextMenuTrigger asChild>
                  <div className="relative">
                    {isRunning && (
                      <svg
                        aria-hidden
                        className="pointer-events-none absolute inset-0 h-full w-full animate-spin text-blue-500 [animation-duration:1.4s] motion-reduce:animate-none dark:text-blue-400"
                        viewBox="0 0 36 36"
                        fill="none"
                      >
                        <circle cx="18" cy="18" r="17" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.5" />
                        <circle
                          cx="18"
                          cy="18"
                          r="17"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeDasharray="22 88"
                        />
                      </svg>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(s.key)}
                          className={cn(
                            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-medium transition-colors",
                            active
                              ? "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-sidebar-foreground"
                              : "text-muted-foreground/70 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
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
            className="absolute bottom-0 z-10 flex h-5 w-9 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-sidebar-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
  );
}
