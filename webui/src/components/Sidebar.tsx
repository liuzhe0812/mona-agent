import { useState, type ReactNode } from "react";
import {
  Archive,
  BookOpen,
  Bot,
  Database,
  FileText,
  ListFilter,
  LogIn,
  Menu,
  Presentation,
  Search,
  Terminal,
  User,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { ChatList } from "@/components/ChatList";
import { NotificationCenter } from "@/components/NotificationCenter";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useLicense } from "@/hooks/useLicense";
import type {
  ChatSummary,
  SidebarSortMode,
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
  onOpenSettings: () => void;
  onOpenLogin?: () => void;
  onOpenNote?: () => void;
  onOpenPpt?: () => void;
  onOpenSSH?: () => void;
  onOpenDb?: () => void;
  onOpenKb?: () => void;
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
}

export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const { loggedIn, licenseInfo, localTrial, localTrialExpired, remainingDays } = useLicense();
  const [menuPortalContainer, setMenuPortalContainer] =
    useState<HTMLElement | null>(null);
  const collapsed = Boolean(props.collapsed);
  const toggleLabel = t("thread.header.toggleSidebar");
  const agentLogoState = props.runningChatIds?.length ? "working" : "idle";

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
          <div className="flex items-center gap-0.5">
            <NotificationCenter onOpenSubscribe={props.onOpenLogin} />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("sidebar.collapse")}
              onClick={props.onCollapse}
              className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground"
            >
              <Menu className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      <ToolboxNavigation
        collapsed={collapsed}
        onNewChat={props.onNewChat}
        onOpenNote={props.onOpenNote ?? (() => {})}
        onOpenPpt={props.onOpenPpt ?? (() => {})}
        onOpenSSH={props.onOpenSSH ?? (() => {})}
        onOpenDb={props.onOpenDb ?? (() => {})}
        onOpenKb={props.onOpenKb ?? (() => {})}
        onGoHome={props.onGoHome ?? (() => {})}
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
        <SidebarViewMenu
          compact={collapsed}
          view={props.viewState}
          onUpdateView={props.onUpdateView}
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
          collapsed && "pointer-events-none opacity-0",
        )}
      >
        {!collapsed && (
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
        {localTrial && !localTrialExpired ? (
          <SidebarActionButton
            collapsed={collapsed}
            label={`试用剩余 ${remainingDays} 天`}
            onClick={props.onOpenLogin ?? (() => {})}
            className={collapsed ? undefined : "flex-1"}
            icon={<User className="h-4 w-4" />}
          />
        ) : loggedIn ? (
          <SidebarActionButton
            collapsed={collapsed}
            label={licenseInfo?.email ?? t("sidebar.settings")}
            onClick={props.onOpenLogin ?? (() => {})}
            className={collapsed ? undefined : "flex-1"}
            icon={<User className="h-4 w-4" />}
          />
        ) : (
          <SidebarActionButton
            collapsed={collapsed}
            label={t("sidebar.login", "登录")}
            onClick={props.onOpenLogin ?? (() => {})}
            className={collapsed ? undefined : "flex-1"}
            icon={<LogIn className="h-4 w-4" />}
          />
        )}
      </div>
    </nav>
  );
}

const TOOLBOX_ITEMS: Array<{
  label: string;
  icon: ReactNode;
}> = [
  { label: "Mona", icon: <Bot className="h-4 w-4" /> },
  { label: "笔记", icon: <FileText className="h-4 w-4" /> },
  { label: "终端", icon: <Terminal className="h-4 w-4" /> },
  { label: "数据库", icon: <Database className="h-4 w-4" /> },
  { label: "知识库", icon: <BookOpen className="h-4 w-4" /> },
  { label: "PPT制作", icon: <Presentation className="h-4 w-4" /> },
];

function ToolboxNavigation({
  collapsed,
  onNewChat,
  onOpenNote,
  onOpenPpt,
  onOpenSSH,
  onOpenDb,
  onOpenKb,
  onGoHome,
}: {
  collapsed: boolean;
  onNewChat: () => void;
  onOpenNote: () => void;
  onOpenPpt: () => void;
  onOpenSSH: () => void;
  onOpenDb: () => void;
  onOpenKb: () => void;
  onGoHome: () => void;
}) {
  const { licenseActive } = useLicense();
  const LICENSE_REQUIRED = new Set(["知识库", "PPT制作"]);
  const visibleItems = licenseActive
    ? TOOLBOX_ITEMS
    : TOOLBOX_ITEMS.filter((item) => !LICENSE_REQUIRED.has(item.label));

  return (
    <div
      className={cn(
        "space-y-1 px-2 pb-2",
        collapsed && "flex w-14 flex-col items-center px-0",
      )}
    >
      {visibleItems.map((item) => {
        const onClick = item.label === "Mona"
          ? onNewChat
          : item.label === "笔记"
            ? onOpenNote
          : item.label === "PPT制作"
            ? onOpenPpt
          : item.label === "终端"
            ? onOpenSSH
          : item.label === "数据库"
            ? onOpenDb
          : item.label === "知识库"
            ? onOpenKb
          : onGoHome;
        return (
          <SidebarActionButton
            key={item.label}
            collapsed={collapsed}
            label={item.label}
            onClick={onClick}
            icon={item.icon}
          />
        );
      })}
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
}: {
  collapsed: boolean;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={cn(
        "group h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground",
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
    </Button>
  );
}

function SidebarViewMenu({
  compact = false,
  view,
  onUpdateView,
}: {
  compact?: boolean;
  view?: SidebarViewState;
  onUpdateView: (view: Partial<SidebarViewState>) => void;
}) {
  const { t } = useTranslation();
  const sort = view?.sort ?? "updated_desc";
  const setSort = (value: string) => {
    if (isSidebarSortMode(value)) onUpdateView({ sort: value });
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          aria-label={t("sidebar.viewOptions")}
          title={compact ? t("sidebar.viewOptions") : undefined}
          className={cn(
            "h-8 min-w-0 overflow-hidden font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent/75 hover:text-sidebar-foreground",
            "transition-[width,padding,border-radius,color,background-color] duration-300 ease-out",
            compact
              ? "w-9 justify-center gap-0 rounded-xl px-0"
              : "w-full justify-start gap-2 rounded-full px-3 text-[12.5px]",
          )}
          variant="ghost"
        >
          <ListFilter className="h-4 w-4 shrink-0" aria-hidden />
          <span
            className={cn(
              "min-w-0 overflow-hidden truncate whitespace-nowrap transition-[max-width,opacity,transform] duration-200 ease-out",
              compact
                ? "max-w-0 -translate-x-1 opacity-0"
                : "max-w-[12rem] translate-x-0 opacity-100",
            )}
          >
            {t("sidebar.viewOptions")}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("sidebar.viewOptions")}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={view?.density === "compact"}
          onCheckedChange={(checked) =>
            onUpdateView({ density: checked ? "compact" : "comfortable" })
          }
          onSelect={(event) => event.preventDefault()}
        >
          {t("sidebar.compactList")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={Boolean(view?.show_previews)}
          onCheckedChange={(checked) =>
            onUpdateView({ show_previews: Boolean(checked) })
          }
          onSelect={(event) => event.preventDefault()}
        >
          {t("sidebar.showPreviews")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={Boolean(view?.show_timestamps)}
          onCheckedChange={(checked) =>
            onUpdateView({ show_timestamps: Boolean(checked) })
          }
          onSelect={(event) => event.preventDefault()}
        >
          {t("sidebar.showTimestamps")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("sidebar.sortLabel")}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="updated_desc">
            {t("sidebar.sortUpdated")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created_desc">
            {t("sidebar.sortCreated")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title_asc">
            {t("sidebar.sortTitle")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isSidebarSortMode(value: string): value is SidebarSortMode {
  return value === "updated_desc" || value === "created_desc" || value === "title_asc";
}
