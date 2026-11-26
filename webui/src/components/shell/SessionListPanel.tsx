import { useEffect, useId, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, Copy, Eye, EyeOff, LayoutGrid, LayoutList, LoaderCircle, MessagesSquare, Pin, PinOff, Plus, Search, SquarePen, Trash2, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatList } from "@/components/ChatList";
import { CloudHistoryDialog } from "@/components/account/CloudHistoryDialog";
import { AgentAvatar, MONA_AGENT_ID } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sessionListTime } from "@/lib/format";
import { filterSessionsByQuery } from "@/lib/session-search";
import { cleanSessionPreview } from "@/lib/session-preview";
import type { ChatSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useClientContextOrNull } from "@/providers/ClientProvider";

type PartnerLayout = "list" | "icons";
const PARTNER_VIEW_KEY = "mona-webui.sidebar.partner-view";
const CONVERSATIONS_COLLAPSED_KEY = "mona-webui.sidebar.conversations-collapsed";
const SECTION_HEADER = "group/section-header flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2 hover:bg-foreground/5 focus-within:bg-foreground/5";
const SECTION_TOGGLE = "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-full pr-1.5 text-left text-caption font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const SECTION_ACTION = "[@media(hover:hover)]:opacity-0 group-hover/section-header:opacity-100 group-focus-within/section-header:opacity-100 data-[state=open]:opacity-100";
const SECTION_ACTION_BUTTON = cn("h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground", SECTION_ACTION);

/**
 * 伙伴的长期私聊和任务会话共用搜索，但在侧栏分别展示。
 */
interface SessionListPanelProps {
  className?: string;
  actionMenuPortalContainer?: HTMLElement | null;
  sessions: ChatSummary[];
  activeKey: string | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  onSelect: (key: string) => void;
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onRequestPartnerAlias?: (key: string, alias: string) => void;
  onToggleArchive: (key: string) => void;
  onBatchPin?: (keys: string[], pinned: boolean) => void;
  onBatchArchive?: (keys: string[], archived: boolean) => void;
  onRequestBatchDelete?: (keys: string[]) => void;
  onMarkAllRead: () => void;
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
  projectNames?: Record<string, string>;
  onRequestProjectRename?: (workspace: string, label: string) => void;
  onOpenProjectFolder?: (workspace: string) => void;
  onNewTask: () => void;
  /** 直接发起与指定 agent 的私聊。 */
  onStartDirect: (agentId: string) => void;
  /** 已打开但尚未发送第一条消息的伙伴私聊。 */
  pendingPartnerId?: string | null;
  openingPartnerId?: string | null;
  partnerPinnedKeys?: string[];
  partnerHiddenKeys?: string[];
  onTogglePartnerPin?: (key: string) => void;
  onTogglePartnerHidden?: (key: string) => void;
  onCopyPartner?: (agentId: string) => void;
  copyingPartner?: boolean;
  onRequestDeletePartner?: (agentId: string, label: string, copyKey?: string) => void;
  onOpenExpertLibrary: () => void;
  onNewRoom: () => void;
}

export function SessionListPanel(props: SessionListPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [historyTarget, setHistoryTarget] = useState<{ key: string; title: string } | null>(null);
  const partnerListId = useId();
  const hiddenPartnerListId = useId();
  const conversationListId = useId();
  const [conversationsCollapsed, setConversationsCollapsed] = useState(() => {
    try { return localStorage.getItem(CONVERSATIONS_COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(CONVERSATIONS_COLLAPSED_KEY, String(conversationsCollapsed)); } catch { /* kept for this window */ }
  }, [conversationsCollapsed]);
  const ConversationChevron = conversationsCollapsed ? ChevronRight : ChevronDown;
  const [partnerView, setPartnerView] = useState<{ collapsed: boolean; hiddenCollapsed: boolean; layout: PartnerLayout }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PARTNER_VIEW_KEY) ?? "null");
      return {
        collapsed: saved?.collapsed === true,
        hiddenCollapsed: saved?.hiddenCollapsed === true,
        layout: saved?.layout === "icons" ? "icons" : "list",
      };
    } catch {
      return { collapsed: false, hiddenCollapsed: false, layout: "list" };
    }
  });
  useEffect(() => {
    try { localStorage.setItem(PARTNER_VIEW_KEY, JSON.stringify(partnerView)); } catch { /* kept for this window */ }
  }, [partnerView]);
  const agentsById = useAgents(useClientContextOrNull()?.token ?? null);
  const iconLayout = partnerView.layout === "icons";
  const HiddenPartnerChevron = partnerView.hiddenCollapsed ? ChevronRight : ChevronDown;
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
  const partners = useMemo(
    () => [...agentsById.values()]
      .filter((agent) => agent.id !== MONA_AGENT_ID && agent.enabled && agent.visibility !== "internal")
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [agentsById],
  );
  const partnerRows = useMemo(() => {
    const byAgent = new Map<string, ChatSummary[]>();
    for (const session of props.sessions) {
      const conversation = session.conversation;
      const agentId = conversation?.directAgentId;
      if (!conversation?.partnerConversation || !agentId) continue;
      const rows = byAgent.get(agentId) ?? [];
      rows.push(session);
      byAgent.set(agentId, rows);
    }
    return partners.flatMap((agent) => {
      const sessions = byAgent.get(agent.id) ?? [];
      return [
        { key: agent.id, agent, session: sessions.find((session) => !session.conversation?.partnerConversationCopy), copy: false },
        ...sessions.filter((session) => session.conversation?.partnerConversationCopy)
          .map((session) => ({ key: session.key, agent, session, copy: true })),
      ];
    });
  }, [partners, props.sessions]);
  const taskSessions = useMemo(
    () => {
      const partnerSessionKeys = new Set(partnerRows.map((row) => row.session?.key));
      return filteredSessions.filter((session) => !partnerSessionKeys.has(session.key));
    },
    [filteredSessions, partnerRows],
  );
  const matchingPartners = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return partnerRows;
    const matchingSessions = new Set(filteredSessions.map((session) => session.key));
    return partnerRows.filter(({ agent, session }) => {
      const name = `${agent.displayName} ${agent.id}`.toLocaleLowerCase();
      return terms.every((term) => name.includes(term)) || (!!session && matchingSessions.has(session.key));
    });
  }, [filteredSessions, partnerRows, query]);
  const hiddenPartners = matchingPartners.filter(({ key }) => props.partnerHiddenKeys?.includes(key));
  const isPinned = (key: string) => Boolean(props.partnerPinnedKeys?.includes(key));
  const visiblePartners = matchingPartners
    .filter(({ key }) => !props.partnerHiddenKeys?.includes(key))
    .sort((left, right) => Number(isPinned(right.key)) - Number(isPinned(left.key)));
  const partnerLabel = (name: string, copy: boolean, key: string) =>
    copy ? props.titleOverrides?.[key] || t("sidebar.partnerCopyName", { name }) : name;

  return (
    <section
      aria-label={t("rail.messages")}
      className={cn(
        "flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-border/45 bg-transparent lg:w-[264px] xl:w-[272px]",
        props.className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md bg-muted/35 px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.searchAria")}
            className="h-auto min-w-0 flex-1 border-0 bg-transparent px-0 py-0 text-caption shadow-none focus-visible:ring-0 [&::-webkit-search-cancel-button]:hidden"
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("sidebar.newTask")}
          title={t("sidebar.newTask")}
          onClick={props.onNewTask}
          className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col pb-2">
        <section className="flex max-h-[40%] shrink-0 flex-col px-2 pb-2 pt-1.5">
          <div className={SECTION_HEADER}>
            <button
              type="button"
              aria-expanded={!partnerView.collapsed}
              aria-controls={partnerListId}
              onClick={() => setPartnerView((current) => ({ ...current, collapsed: !current.collapsed }))}
              className={SECTION_TOGGLE}
            >
              <UsersRound className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{t("rail.partners")}</span>
              {partnerView.collapsed
                ? <ChevronRight className={cn("h-3.5 w-3.5 shrink-0", SECTION_ACTION)} aria-hidden />
                : <ChevronDown className={cn("h-3.5 w-3.5 shrink-0", SECTION_ACTION)} aria-hidden />}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("sidebar.partnerCreateMenu")}
                  title={t("sidebar.partnerCreateMenu")}
                  className={SECTION_ACTION_BUTTON}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" portalContainer={props.actionMenuPortalContainer}>
                <DropdownMenuItem onSelect={props.onOpenExpertLibrary}>
                  <Bot className="h-4 w-4" aria-hidden />
                  {t("sidebar.newPartner")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onNewRoom}>
                  <UsersRound className="h-4 w-4" aria-hidden />
                  {t("sidebar.newPartnerRoom")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("sidebar.partnerDisplay")}
                  title={t("sidebar.partnerDisplay")}
                  className={SECTION_ACTION_BUTTON}
                >
                  {iconLayout ? <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> : <LayoutList className="h-3.5 w-3.5" aria-hidden />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" portalContainer={props.actionMenuPortalContainer}>
                <DropdownMenuRadioGroup
                  value={partnerView.layout}
                  onValueChange={(layout) => setPartnerView((current) => ({ ...current, layout: layout === "icons" ? "icons" : "list" }))}
                >
                  <DropdownMenuRadioItem value="icons" endIndicator className="gap-2">
                    <LayoutGrid className="h-4 w-4" aria-hidden />
                    {t("sidebar.partnerIcons")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="list" endIndicator className="gap-2">
                    <LayoutList className="h-4 w-4" aria-hidden />
                    {t("sidebar.partnerList")}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div id={partnerListId} hidden={partnerView.collapsed} className="scrollbar-thin min-h-0 overflow-y-auto overscroll-contain">
            <div className={iconLayout ? "flex flex-wrap gap-2 px-2 py-1.5" : undefined}>
              {visiblePartners.map(({ key, agent, session, copy }) => {
                const label = partnerLabel(agent.displayName, copy, key);
                const pinned = isPinned(key);
                const PinAction = pinned ? PinOff : Pin;
                const active = session?.key === props.activeKey || (!copy && props.pendingPartnerId === agent.id);
                const unread = !!session && props.unreadKeys?.includes(session.key);
                const opening = !copy && props.openingPartnerId === agent.id;
                const running = !!session && props.runningChatIds?.includes(session.chatId);
                const indicator = opening || running ? (
                  <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" aria-label={t(opening ? "sidebar.openingPartner" : "chat.activity.running")} />
                ) : null;
                const preview = cleanSessionPreview(session?.preview) || t("sidebar.startPartnerConversation");
                const timestamp = session ? sessionListTime(session.previewAt ?? session.updatedAt ?? session.createdAt) : "";
                return (
                  <ContextMenu key={key}>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-current={active ? "page" : undefined}
                        aria-label={iconLayout ? label : undefined}
                        title={iconLayout ? label : undefined}
                        onClick={() => copy && session ? props.onSelect(session.key) : props.onStartDirect(agent.id)}
                        onKeyDown={(event) => {
                          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                          event.preventDefault();
                          const { left, bottom } = event.currentTarget.getBoundingClientRect();
                          event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                            bubbles: true, cancelable: true, clientX: left, clientY: bottom,
                          }));
                        }}
                        className={cn(
                          "relative flex min-w-0 items-center text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
                          iconLayout ? "h-10 w-10 justify-center rounded-full" : "h-16 w-full gap-3 rounded-md px-2",
                          active ? "bg-[hsl(var(--sidebar-active-surface)/0.09)] text-sidebar-foreground" : "text-sidebar-foreground/82 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                          active && iconLayout && "ring-1 ring-ring/45",
                        )}
                      >
                        <span className="relative shrink-0">
                          <AgentAvatar agentId={agent.id} displayName={agent.displayName} avatarUrl={agent.avatarUrl} className={iconLayout ? "h-9 w-9" : "h-10 w-10"} />
                          {unread ? <span aria-label={t("chat.unread")} className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background bg-destructive" /> : null}
                          {iconLayout && indicator ? <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-background p-0.5">{indicator}</span> : null}
                          {iconLayout && copy ? <Copy className="absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-sm bg-background text-muted-foreground" aria-hidden /> : null}
                          {iconLayout && pinned ? <Pin className="absolute -left-0.5 -top-0.5 h-3 w-3 rounded-sm bg-background text-muted-foreground" aria-hidden /> : null}
                        </span>
                        {!iconLayout ? (
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-baseline gap-2">
                              {pinned ? <Pin className="h-3 w-3 shrink-0 self-center text-muted-foreground" aria-hidden /> : null}
                              <span className="min-w-0 flex-1 truncate text-ui font-medium">{label}</span>
                              {timestamp ? <span className="shrink-0 text-micro text-muted-foreground/70">{timestamp}</span> : null}
                            </span>
                            <span className="mt-1 flex min-w-0 items-center gap-1 text-caption text-muted-foreground/75">
                              {indicator}
                              <span className="truncate">{preview}</span>
                            </span>
                          </span>
                        ) : null}
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent portalContainer={props.actionMenuPortalContainer} className="w-44 rounded-xl border-border/70 shadow-float">
                      <ContextMenuItem className="min-h-8" onSelect={() => props.onTogglePartnerPin?.(key)}>
                        <PinAction className="h-4 w-4" aria-hidden />
                        {t(pinned ? "chat.unpin" : "chat.pin")}
                      </ContextMenuItem>
                      <ContextMenuItem className="min-h-8" onSelect={() => props.onTogglePartnerHidden?.(key)}>
                        <EyeOff className="h-4 w-4" aria-hidden />
                        {t("sidebar.hidePartner")}
                      </ContextMenuItem>
                      <ContextMenuSeparator className="bg-border/70" />
                      {copy && props.onRequestPartnerAlias ? (
                        <ContextMenuItem className="min-h-8" onSelect={() => props.onRequestPartnerAlias?.(key, props.titleOverrides?.[key] ?? "")}>
                          <SquarePen className="h-4 w-4" aria-hidden />
                          {t("sidebar.partnerAlias")}
                        </ContextMenuItem>
                      ) : null}
                      <ContextMenuItem className="min-h-8" disabled={props.copyingPartner} onSelect={() => props.onCopyPartner?.(agent.id)}>
                        <Copy className="h-4 w-4" aria-hidden />
                        {t("sidebar.copyPartner")}
                      </ContextMenuItem>
                      <ContextMenuSeparator className="bg-border/70" />
                      <ContextMenuItem className="min-h-8 text-destructive focus:text-destructive" onSelect={() => props.onRequestDeletePartner?.(agent.id, label, copy ? session?.key : undefined)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                        {t("sidebar.deletePartner")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
            {hiddenPartners.length > 0 ? (
              <div className="mx-2 mt-2 border-t border-border/70 pt-2">
                <button
                  type="button"
                  aria-expanded={!partnerView.hiddenCollapsed}
                  aria-controls={hiddenPartnerListId}
                  onClick={() => setPartnerView((current) => ({ ...current, hiddenCollapsed: !current.hiddenCollapsed }))}
                  className={cn(SECTION_TOGGLE, "w-full px-2 font-normal hover:bg-foreground/5")}
                >
                  <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{t("sidebar.hiddenPartners", { count: hiddenPartners.length })}</span>
                  <HiddenPartnerChevron className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
                <div id={hiddenPartnerListId} hidden={partnerView.hiddenCollapsed}>
                  {hiddenPartners.map(({ key, agent, session, copy }) => {
                    const label = partnerLabel(agent.displayName, copy, key);
                    const showLabel = t("sidebar.showPartner", { name: label });
                    const deleteLabel = t("sidebar.deletePartnerLabel", { name: label });
                    return (
                      <div key={key} className="flex min-h-10 items-center gap-1 px-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
                          <AgentAvatar agentId={agent.id} displayName={agent.displayName} avatarUrl={agent.avatarUrl} className="h-7 w-7 opacity-60" />
                          <span className="truncate text-ui">{label}</span>
                        </div>
                        <Button type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label={showLabel} title={showLabel} onClick={() => props.onTogglePartnerHidden?.(key)}>
                          <Eye className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" className="shrink-0 text-destructive hover:text-destructive" aria-label={deleteLabel} title={deleteLabel} onClick={() => props.onRequestDeletePartner?.(agent.id, label, copy ? session?.key : undefined)}>
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        </section>
        <div className={cn(SECTION_HEADER, "mx-2 mt-2")}>
          <button
            type="button"
            aria-expanded={!conversationsCollapsed}
            aria-controls={conversationListId}
            onClick={() => setConversationsCollapsed((collapsed) => !collapsed)}
            className={SECTION_TOGGLE}
          >
            <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{t("sidebar.conversations")}</span>
            <ConversationChevron className={cn("h-3.5 w-3.5 shrink-0", SECTION_ACTION)} aria-hidden />
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("sidebar.newChat")}
            title={t("sidebar.newChat")}
            onClick={props.onNewTask}
            className={SECTION_ACTION_BUTTON}
          >
            <SquarePen className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <div id={conversationListId} hidden={conversationsCollapsed} className="min-h-0 flex-1">
          <ChatList
            sessions={taskSessions}
            compactTaskRows
            activeKey={props.activeKey}
            loading={props.loading}
            error={props.error}
            onRetry={props.onRetry}
            emptyLabel={hasQuery ? t("sidebar.noSearchResults") : t("chat.noSessions")}
            onSelect={props.onSelect}
            onRequestDelete={props.onRequestDelete}
            onTogglePin={props.onTogglePin}
            onRequestRename={props.onRequestRename}
            onToggleArchive={props.onToggleArchive}
            onBatchPin={props.onBatchPin}
            onBatchArchive={props.onBatchArchive}
            onRequestBatchDelete={props.onRequestBatchDelete}
            onMarkAllRead={props.onMarkAllRead}
            pinnedKeys={props.pinnedKeys}
            archivedKeys={props.archivedKeys}
            titleOverrides={props.titleOverrides}
            runningChatIds={props.runningChatIds}
            unreadKeys={props.unreadKeys}
            showArchived={props.showArchived}
            actionMenuPortalContainer={props.actionMenuPortalContainer}
            onCreateTask={props.onCreateTask}
            onRemoveProject={props.onRemoveProject}
            projectNames={props.projectNames}
            onRequestProjectRename={props.onRequestProjectRename}
            onOpenProjectFolder={props.onOpenProjectFolder}
            onOpenHistory={(key, title) => setHistoryTarget({ key, title })}
          />
        </div>
      </div>
      {historyTarget && <CloudHistoryDialog key={historyTarget.key} sessionKey={historyTarget.key} title={historyTarget.title}
        onClose={() => setHistoryTarget(null)} onRestored={() => { void props.onRetry?.(); }} />}
    </section>
  );
}
