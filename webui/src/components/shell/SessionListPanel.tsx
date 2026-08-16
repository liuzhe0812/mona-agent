import { useMemo, useState } from "react";
import { Archive, MessageSquarePlus, Plus, Search, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatList } from "@/components/ChatList";
import { AgentAvatar, MONA_AGENT_ID } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { filterSessionsByQuery } from "@/lib/session-search";
import type { ChatSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useClientContextOrNull } from "@/providers/ClientProvider";

/**
 * 消息 Tab 的会话列表列（阶段 4.5）：顶部搜索 + 「+」新建菜单，
 * 下方为 Mona 私聊 / 伙伴私聊 / 协作房间混排列表（复用 ChatList）。
 */
interface SessionListPanelProps {
  className?: string;
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
  unreadKeys?: string[];
  showArchived?: boolean;
  archivedCount?: number;
  onToggleArchived: () => void;
  onRemoveProject?: (workspace: string) => void;
  onCreateTask?: (workspace: string) => void;
  onNewChat: () => void;
  /** 直接发起与指定 agent 的私聊。 */
  onStartDirect: (agentId: string) => void;
  onNewRoom: () => void;
}

export function SessionListPanel(props: SessionListPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const clientContext = useClientContextOrNull();
  const agentsById = useAgents(clientContext?.token ?? null);
  // 「+」菜单的私聊对象：Mona 的私聊即普通新会话，由「新建对话」承载，这里只列伙伴。
  // internal 股票 Agent（visibility=internal）只对房间/工作流可见，不出现在全局新建菜单。
  const directAgents = useMemo(
    () =>
      [...agentsById.values()].filter(
        (agent) => agent.id !== MONA_AGENT_ID && agent.enabled && agent.visibility !== "internal",
      ),
    [agentsById],
  );
  const filteredSessions = useMemo(
    () => filterSessionsByQuery(
      props.sessions,
      query,
      props.titleOverrides,
      agentsById,
    ),
    [agentsById, props.sessions, props.titleOverrides, query],
  );
  const hasQuery = query.trim().length > 0;

  return (
    <TooltipProvider delayDuration={0}>
      <section
        aria-label={t("rail.messages")}
        className={cn(
          "flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-border/45 bg-transparent lg:w-[280px] xl:w-[288px]",
          props.className,
        )}
      >
        <div className="flex h-[60px] shrink-0 items-center gap-2 border-b border-border/35 px-3">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/55 bg-muted/45 px-2.5 transition-colors focus-within:border-primary/35 focus-within:bg-background focus-within:ring-1 focus-within:ring-primary/20">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("sidebar.searchPlaceholder")}
              aria-label={t("sidebar.searchAria")}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/75 [&::-webkit-search-cancel-button]:hidden"
            />
            {hasQuery ? (
              <button
                type="button"
                aria-label={t("sidebar.clearSearch")}
                onClick={() => setQuery("")}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("chat.createMenu")}
                    className="h-9 w-9 shrink-0 rounded-md bg-muted/45 text-muted-foreground/85 hover:bg-muted/70 hover:text-sidebar-foreground"
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
              {directAgents.map((agent) => (
                <DropdownMenuItem
                  key={agent.id}
                  className="gap-2 px-2.5 py-1.5 text-ui"
                  onSelect={() => props.onStartDirect(agent.id)}
                >
                  <AgentAvatar
                    agentId={agent.id}
                    displayName={agent.displayName}
                    className="h-4 w-4"
                  />
                  <span className="truncate">
                    {t("chat.chatWith", { name: agent.displayName })}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2 px-2.5 py-1.5 text-[13px]"
                onSelect={props.onNewRoom}
              >
                <UsersRound className="h-4 w-4" />
                <span>{t("chat.newRoom")}</span>
              </DropdownMenuItem>
              {props.archivedCount ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="gap-2 px-2.5 py-1.5 text-[13px]"
                    onSelect={props.onToggleArchived}
                  >
                    <Archive className="h-4 w-4" />
                    <span>
                      {props.showArchived ? t("chat.hideArchived") : t("chat.showArchived")}
                    </span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden pb-2 pt-1.5">
          <ChatList
            sessions={filteredSessions}
            activeKey={props.activeKey}
            loading={props.loading}
            emptyLabel={hasQuery ? t("sidebar.noSearchResults") : t("chat.noSessions")}
            onSelect={props.onSelect}
            onRequestDelete={props.onRequestDelete}
            onTogglePin={props.onTogglePin}
            onRequestRename={props.onRequestRename}
            onToggleArchive={props.onToggleArchive}
            pinnedKeys={props.pinnedKeys}
            archivedKeys={props.archivedKeys}
            titleOverrides={props.titleOverrides}
            runningChatIds={props.runningChatIds}
            unreadKeys={props.unreadKeys}
            showArchived={props.showArchived}
            onRemoveProject={props.onRemoveProject}
            onCreateTask={props.onCreateTask}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}
