import { useEffect, useMemo, useState } from "react";
import { PanelRightClose, Target, Users, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, resolveAgentDisplayName, type AgentIdentity } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { WorkflowPanel } from "@/components/workflow/WorkflowPanel";
import { cn } from "@/lib/utils";
import type { ConversationMeta, RoomState } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

interface RoomContextPanelProps {
  chatId: string;
  conversation: ConversationMeta;
  /** Collapse the whole right-hand pane (shared with the workspace panel). */
  onCollapse: () => void;
  className?: string;
}

/**
 * Room context sidebar (multi-agent phase 2d): room goal, member roster and
 * a read-only workflow placeholder. Direct chats with a partner agent show
 * the partner profile instead of the workflow block.
 *
 * Live state comes from ``get_room_state`` plus ``room_updated`` pushes; the
 * session-carried ``conversation`` prop is the render fallback until the
 * first fetch resolves.
 */
export function RoomContextPanel({
  chatId,
  conversation,
  onCollapse,
  className,
}: RoomContextPanelProps) {
  const { t } = useTranslation();
  const { client, token } = useClient();
  const agentsById = useAgents(token);
  const isRoom = conversation.type === "room";
  const [room, setRoom] = useState<RoomState | null>(null);

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
  const directDescription = agentsById.get(directAgentId)?.description ?? "";

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
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
        <button
          type="button"
          onClick={onCollapse}
          title={t("room.panel.collapse")}
          aria-label={t("room.panel.collapse")}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
        {isRoom ? (
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
                      </div>
                      {member.description ? (
                        <div className="line-clamp-2 text-[11px] leading-4 text-muted-foreground/80">
                          {member.description}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Workflow className="h-3.5 w-3.5" />
                {t("room.panel.workflow")}
              </div>
              <WorkflowPanel chatId={chatId} members={members} className="mt-1.5" />
            </section>
          </>
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
                {directDescription ? (
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/85">
                    {directDescription}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
