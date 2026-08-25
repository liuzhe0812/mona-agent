import { useEffect, useMemo, useState } from "react";
import {
  FileCode,
  FileImage,
  FileText,
  Info,
  Package,
  RefreshCw,
  Target,
  Users,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, resolveAgentDisplayName, type AgentIdentity } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { useArtifacts } from "@/hooks/useArtifacts";
import { WorkflowPanel } from "@/components/workflow/WorkflowPanel";
import { cn } from "@/lib/utils";
import type { ConversationMeta, DeliveredFile, RoomState } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

interface RoomContextPanelProps {
  chatId: string;
  conversation: ConversationMeta;
  className?: string;
}

/** Lightweight artifact row for the room info tab. */
function RoomArtifactRow({ file, onOpen }: { file: DeliveredFile; onOpen: () => void }) {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const Icon = file.mime.startsWith("image/")
    ? FileImage
    : [".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".json"].includes(`.${ext}`)
      ? FileCode
      : FileText;
  return (
    <button
      type="button"
      onClick={file.missing ? undefined : onOpen}
      disabled={file.missing}
      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent/60 disabled:cursor-default disabled:opacity-60"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-5">{file.name}</span>
      <span className="shrink-0 text-micro text-muted-foreground">
        {file.missing ? "文件已移除" : file.size_human}
      </span>
    </button>
  );
}

/**
 * Room context sidebar: icon-tabbed panel — the info tab holds the room
 * goal, member roster and this room's flat artifact projection (references
 * from all room members are shown together), the
 * workflow tab holds the orchestration summary and the compact run
 * progress. Canvas editing lives in the full-screen dialog opened from the
 * workflow tab. Direct chats with a partner agent show the partner profile
 * instead (no tabs).
 *
 * Live state comes from ``get_room_state`` plus ``room_updated`` pushes; the
 * session-carried ``conversation`` prop is the render fallback until the
 * first fetch resolves.
 */
export function RoomContextPanel({
  chatId,
  conversation,
  className,
}: RoomContextPanelProps) {
  const { t } = useTranslation();
  const { client, token } = useClient();
  const agentsById = useAgents(token);
  const isRoom = conversation.type === "room";
  const [room, setRoom] = useState<RoomState | null>(null);
  const [tab, setTab] = useState<"info" | "workflow">("info");
  const [artifactsTick, setArtifactsTick] = useState(0);
  const openPreview = useFilePreviewStore((s) => s.open);

  // Room artifacts refresh on server broadcasts plus a manual refresh button.
  useEffect(
    () => client.onArtifactsChanged((updatedChatId) => {
      if (!updatedChatId || updatedChatId === chatId) {
        setArtifactsTick((n) => n + 1);
      }
    }),
    [chatId, client],
  );

  const artifacts = useArtifacts(token, artifactsTick, {
    scope: "room",
    room: chatId,
  });

  useEffect(() => {
    setRoom(null);
    if (!isRoom) return;
    let cancelled = false;
    client
      .getRoomState(chatId)
      .then((state) => {
        if (!cancelled) setRoom(state);
      })
      .catch(() => {
        // The session metadata fallback below keeps the panel usable.
      });
    return () => {
      cancelled = true;
    };
  }, [client, chatId, isRoom]);

  useEffect(() => {
    if (!isRoom) return;
    return client.onRoomUpdated((updatedChatId, state) => {
      if (updatedChatId === chatId) setRoom(state);
    });
  }, [client, chatId, isRoom]);

  const effectiveConversation = room?.conversation ?? conversation;
  const goal = effectiveConversation.goal?.trim() ?? "";
  const members: AgentIdentity[] = useMemo(() => {
    if (room) return room.agents;
    return effectiveConversation.agentIds.map((id) => ({
      id,
      displayName: resolveAgentDisplayName(agentsById, id),
    }));
  }, [room, effectiveConversation, agentsById]);

  const directAgentId = effectiveConversation.directAgentId ?? "mona";
  const directAgent: AgentIdentity = {
    id: directAgentId,
    displayName: resolveAgentDisplayName(agentsById, directAgentId),
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {isRoom ? t("room.panel.title") : t("room.panel.partner")}
        </span>
        {isRoom ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {members.length}
          </span>
        ) : null}
        <div className="flex-1" />
        {isRoom ? (
          <div className="flex items-center gap-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "info"}
              onClick={() => setTab("info")}
              title={t("room.panel.info")}
              aria-label={t("room.panel.info")}
              className={cn(
                "relative rounded-md p-1 transition-colors after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-transparent after:content-['']",
                tab === "info"
                  ? "text-foreground after:bg-[hsl(var(--brand-red))]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Info className="h-4 w-4" />
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "workflow"}
              onClick={() => setTab("workflow")}
              title={t("room.panel.workflow")}
              aria-label={t("room.panel.workflow")}
              className={cn(
                "relative rounded-md p-1 transition-colors after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-transparent after:content-['']",
                tab === "workflow"
                  ? "text-foreground after:bg-[hsl(var(--brand-red))]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Workflow className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
        {isRoom ? (
          tab === "info" ? (
            <>
              <section className="border-b border-border/45 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Target className="h-3.5 w-3.5" />
                  {t("room.panel.goal")}
                </div>
                <p
                  className={cn(
                    "mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed",
                    goal ? "text-foreground" : "text-muted-foreground/70",
                  )}
                >
                  {goal || t("room.panel.goalEmpty")}
                </p>
              </section>

              <section className="border-b border-border/45 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Users className="h-3.5 w-3.5" />
                  {t("room.panel.members")}
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {members.map((member) => (
                    <li
                      key={member.id}
                      className="flex items-start gap-2 rounded-lg px-1.5 py-1.5"
                    >
                      <AgentAvatar
                        agentId={member.id}
                        displayName={member.displayName}
                        className="mt-0.5 h-5 w-5"
                      />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium leading-5">
                          {member.displayName}
                          {agentsById.get(member.id)?.visibility === "internal" ? (
                            <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 align-middle text-micro text-muted-foreground">
                              {t("room.panel.builtin")}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Package className="h-3.5 w-3.5" />
                  {t("room.panel.artifacts")}
                  {artifacts.files.length > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                      {artifacts.files.length}
                    </span>
                  ) : null}
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={artifacts.refresh}
                    disabled={artifacts.loading}
                    title={t("room.panel.refresh")}
                    aria-label={t("room.panel.refresh")}
                    className="rounded-sm p-0.5 text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", artifacts.loading && "animate-spin")}
                    />
                  </button>
                </div>
                {artifacts.error ? (
                  <p className="mt-1.5 text-[11px] text-destructive">{artifacts.error}</p>
                ) : artifacts.files.length === 0 && !artifacts.loading ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground/70">
                    {t("room.panel.artifactsEmpty")}
                  </p>
                ) : (
                  <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto scrollbar-hover">
                    {artifacts.files.map((file) => (
                      <li key={file.absolute_path || file.path}>
                        <RoomArtifactRow
                          file={file}
                          onOpen={() => openPreview(file, "room", null, chatId)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <section className="px-3 py-2.5">
              <WorkflowPanel chatId={chatId} members={members} />
            </section>
          )
        ) : (
          <section className="px-3 py-3">
            <div className="flex items-start gap-2.5">
              <AgentAvatar
                agentId={directAgent.id}
                displayName={directAgent.displayName}
                className="mt-0.5 h-8 w-8"
              />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium leading-5">
                  {directAgent.displayName}
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
