import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, LibraryBig, LoaderCircle, Plus, Search, Settings2, UsersRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChatList } from "@/components/ChatList";
import {
  AgentAvatar,
  MONA_AGENT_ID,
  MONA_AVATAR_IMAGE,
} from "@/components/room/AgentAvatar";
import { invalidateAgents, useAgents } from "@/components/room/useAgents";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { filterSessionsByQuery } from "@/lib/session-search";
import { fetchExpertCatalog, fetchExpertInstallJob, startExpertInstall } from "@/lib/api";
import type { AgentSummary, ChatSummary, ExpertCatalogItem } from "@/lib/types";
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
  error?: string | null;
  onRetry?: () => void | Promise<void>;
  onSelect: (key: string) => void;
  onRequestDelete: (key: string, label: string) => void;
  onTogglePin: (key: string) => void;
  onRequestRename: (key: string, label: string) => void;
  onToggleArchive: (key: string) => void;
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
  /** 直接发起与指定 agent 的私聊。 */
  onStartDirect: (agentId: string) => void;
  /** 打开指定 Agent 的设置页面。 */
  onSelectAgent: (agentId: string) => void;
  onOpenExpertLibrary: () => void;
  onNewRoom: () => void;
}

export function SessionListPanel(props: SessionListPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [createQuery, setCreateQuery] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [expertUpdates, setExpertUpdates] = useState<ReadonlyMap<string, ExpertCatalogItem>>(
    () => new Map(),
  );
  const [updatingAgentId, setUpdatingAgentId] = useState<string | null>(null);
  const [failedUpdateAgentId, setFailedUpdateAgentId] = useState<string | null>(null);
  const mounted = useRef(true);
  const clientContext = useClientContextOrNull();
  const token = clientContext?.token ?? null;
  const agentsById = useAgents(token);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const loadExpertUpdates = useCallback(async () => {
    if (!token) return;
    try {
      const catalog = await fetchExpertCatalog(token);
      const updates = new Map(
        catalog.installEnabled
          ? catalog.experts
            .filter((expert) => expert.installed && expert.updateAvailable && expert.compatible)
            .map((expert) => [expert.id, expert] as const)
          : [],
      );
      if (mounted.current) setExpertUpdates(updates);
    } catch {
      if (mounted.current) setExpertUpdates(new Map());
    }
  }, [token]);

  useEffect(() => {
    if (createMenuOpen) void loadExpertUpdates();
  }, [createMenuOpen, loadExpertUpdates]);

  const updateExpert = useCallback(async (expert: ExpertCatalogItem) => {
    if (!token || updatingAgentId) return;
    setUpdatingAgentId(expert.id);
    setFailedUpdateAgentId(null);
    try {
      let job = (await startExpertInstall(token, expert.id, expert.version)).job;
      while (job.state === "queued" || job.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
        job = (await fetchExpertInstallJob(token, job.jobId)).job;
      }
      if (job.state !== "completed") throw new Error(job.error || "expert update failed");
      invalidateAgents();
      await loadExpertUpdates();
    } catch {
      if (mounted.current) setFailedUpdateAgentId(expert.id);
    } finally {
      if (mounted.current) setUpdatingAgentId(null);
    }
  }, [loadExpertUpdates, token, updatingAgentId]);
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
  const availableAgents = useMemo(() => {
    const visible = [...agentsById.values()].filter(
      (agent) => agent.enabled && agent.visibility !== "internal",
    );
    if (!visible.some((agent) => agent.id === MONA_AGENT_ID)) {
      visible.push({ id: MONA_AGENT_ID, displayName: "Mona", enabled: true });
    }
    return visible.sort((left, right) => {
      if (left.id === MONA_AGENT_ID) return -1;
      if (right.id === MONA_AGENT_ID) return 1;
      return left.displayName.localeCompare(right.displayName);
    });
  }, [agentsById]);
  const createCandidates = useMemo(() => {
    const normalized = createQuery.trim().toLocaleLowerCase();
    if (!normalized) return availableAgents;
    return availableAgents.filter((agent) =>
      `${agent.displayName} ${agent.id}`.toLocaleLowerCase().includes(normalized),
    );
  }, [availableAgents, createQuery]);

  return (
    <section
      aria-label={t("rail.messages")}
      className={cn(
        "flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-border/45 bg-transparent lg:w-[264px] xl:w-[272px]",
        props.className,
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/35 px-3">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border/55 bg-muted/45 px-2.5 transition-colors focus-within:border-primary/35 focus-within:bg-background focus-within:ring-1 focus-within:ring-primary/20">
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
        <DropdownMenu
          open={createMenuOpen}
          onOpenChange={(open) => {
            setCreateMenuOpen(open);
            if (!open) setCreateQuery("");
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("chat.createConversation")}
              title={t("chat.createConversation")}
              className="shrink-0 border-border/55 bg-muted/35 text-muted-foreground"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64 p-1.5">
            <DropdownMenuLabel className="px-2 pb-1 pt-0.5 text-muted-foreground">
              {t("chat.chooseAgent")}
            </DropdownMenuLabel>
            <div
              className="relative mb-1"
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
            >
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                value={createQuery}
                onChange={(event) => setCreateQuery(event.target.value)}
                placeholder={t("chat.searchAgents")}
                aria-label={t("chat.searchAgents")}
                className="h-8 bg-muted/35 pl-7 pr-2 text-caption placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {createCandidates.length > 0 ? createCandidates.map((agent) => (
                <AgentConversationItem
                  key={agent.id}
                  agent={agent}
                  onSelect={() => props.onStartDirect(agent.id)}
                  onOpenSettings={() => {
                    setCreateMenuOpen(false);
                    props.onSelectAgent(agent.id);
                  }}
                  settingsLabel={t("chat.agentSettingsFor", { name: agent.displayName })}
                  update={expertUpdates.get(agent.id)}
                  updating={updatingAgentId === agent.id}
                   updateFailed={failedUpdateAgentId === agent.id}
                   onUpdate={(expert) => void updateExpert(expert)}
                   updateLabel={`${t("experts.update")} ${agent.displayName}`}
                   retryLabel={t("experts.retry")}
                 />
              )) : (
                <p className="px-2 py-5 text-center text-caption text-muted-foreground">
                  {t("chat.noMatchingAgents")}
                </p>
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setCreateMenuOpen(false);
                props.onOpenExpertLibrary();
              }}
              className="h-9"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <LibraryBig className="h-3.5 w-3.5" aria-hidden />
              </span>
              {t("chat.expertLibrary")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onNewRoom} className="h-9">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                <UsersRound className="h-3.5 w-3.5" aria-hidden />
              </span>
              {t("chat.newRoom")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden pb-2 pt-1.5">
        <ChatList
          sessions={filteredSessions}
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
          onMarkAllRead={props.onMarkAllRead}
          pinnedKeys={props.pinnedKeys}
          archivedKeys={props.archivedKeys}
          titleOverrides={props.titleOverrides}
          runningChatIds={props.runningChatIds}
          unreadKeys={props.unreadKeys}
          showArchived={props.showArchived}
          onCreateTask={props.onCreateTask}
          onRemoveProject={props.onRemoveProject}
          projectNames={props.projectNames}
          onRequestProjectRename={props.onRequestProjectRename}
          onOpenProjectFolder={props.onOpenProjectFolder}
        />
      </div>
    </section>
  );
}

function AgentConversationItem({
  agent,
  onSelect,
  onOpenSettings,
  settingsLabel,
  update,
  updating,
  updateFailed,
  onUpdate,
  updateLabel,
  retryLabel,
}: {
  agent: AgentSummary;
  onSelect: () => void;
  onOpenSettings: () => void;
  settingsLabel: string;
  update?: ExpertCatalogItem;
  updating: boolean;
  updateFailed: boolean;
  onUpdate: (expert: ExpertCatalogItem) => void;
  updateLabel: string;
  retryLabel: string;
}) {
  const actionLabel = updateFailed ? `${retryLabel} ${agent.displayName}` : updateLabel;
  return (
    <div className="flex items-center">
      <DropdownMenuItem onSelect={onSelect} className="h-9 min-w-0 flex-1">
        <AgentAvatar
          agentId={agent.id}
          displayName={agent.displayName}
          avatarUrl={agent.avatarUrl ?? (agent.id === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)}
          className="h-6 w-6"
        />
        <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
      </DropdownMenuItem>
      {update ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={actionLabel}
          title={actionLabel}
          disabled={updating}
          onClick={() => onUpdate(update)}
          className="h-7 w-7 shrink-0 p-0 text-primary hover:text-primary"
        >
          {updating ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={settingsLabel}
        title={settingsLabel}
        onClick={onOpenSettings}
        className="h-8 w-8 shrink-0 text-muted-foreground/70 hover:text-foreground"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
