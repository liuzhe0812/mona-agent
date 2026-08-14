import { Archive, MessageSquarePlus, Plus, Search, UserRound, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatList } from "@/components/ChatList";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ChatSummary, SidebarViewState } from "@/lib/types";

/**
 * 消息 Tab 的会话列表列（阶段 4.5）：顶部搜索 + 「+」新建菜单，
 * 下方为 Mona 私聊 / 伙伴私聊 / 协作房间混排列表（复用 ChatList）。
 */
interface SessionListPanelProps {
  sessions: ChatSummary[];
  activeKey: string | null;
  loading: boolean;
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
  viewState?: SidebarViewState;
  showArchived?: boolean;
  archivedCount?: number;
  onToggleArchived: () => void;
  onRemoveProject?: (workspace: string) => void;
  onCreateTask?: (workspace: string) => void;
  onOpenSearch: () => void;
  onNewChat: () => void;
  onNewDirect: () => void;
  onNewRoom: () => void;
}

export function SessionListPanel(props: SessionListPanelProps) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={0}>
      <section
        aria-label={t("rail.messages")}
        className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-border/45 bg-transparent"
      >
        <div className="flex items-center gap-1 px-3 pb-1.5 pt-3">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-sidebar-foreground">
            {t("rail.messages")}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("sidebar.searchAria")}
                onClick={props.onOpenSearch}
                className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
              >
                <Search className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("sidebar.searchAria")}</TooltipContent>
          </Tooltip>
          {props.archivedCount ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={props.showArchived ? t("chat.hideArchived") : t("chat.showArchived")}
                  onClick={props.onToggleArchived}
                  className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {props.showArchived ? t("chat.hideArchived") : t("chat.showArchived")}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("chat.createMenu")}
                    className="h-7 w-7 rounded-lg text-muted-foreground/85 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("chat.createMenu")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-[180px]">
              <DropdownMenuItem
                className="gap-2 px-2.5 py-1.5 text-[13px]"
                onSelect={props.onNewChat}
              >
                <MessageSquarePlus className="h-4 w-4" />
                <span>{t("chat.newChat")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 px-2.5 py-1.5 text-[13px]"
                onSelect={props.onNewDirect}
              >
                <UserRound className="h-4 w-4" />
                <span>{t("chat.newDirect")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 px-2.5 py-1.5 text-[13px]"
                onSelect={props.onNewRoom}
              >
                <UsersRound className="h-4 w-4" />
                <span>{t("chat.newRoom")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
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
            onRemoveProject={props.onRemoveProject}
            onCreateTask={props.onCreateTask}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}
