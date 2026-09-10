import { useEffect, useMemo, useState } from "react";
import {
  FileCode,
  FileImage,
  FileText,
  ListChecks,
  Package,
  RefreshCw,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, resolveAgentDisplayName, type AgentIdentity } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { useArtifacts } from "@/hooks/useArtifacts";
import { WorkflowPanel } from "@/components/workflow/WorkflowPanel";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ConversationMeta, DeliveredFile, RoomState, WorkflowRun } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

interface RoomContextPanelProps {
  chatId: string;
  conversation: ConversationMeta;
  discussionRun?: WorkflowRun | null;
  workflowRun?: WorkflowRun | null;
  className?: string;
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const COMPLETED_STEP_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

function RoomTaskProgress({
  chatId,
  discussionRun,
  workflowRun,
  members,
}: {
  chatId: string;
  discussionRun?: WorkflowRun | null;
  workflowRun?: WorkflowRun | null;
  members: AgentIdentity[];
}) {
  const { t } = useTranslation();
  const { client } = useClient();
  const [stopping, setStopping] = useState(false);
  const activeDiscussion = discussionRun && !TERMINAL_RUN_STATUSES.has(discussionRun.status)
    ? discussionRun
    : null;
  const activeWorkflow = workflowRun && !TERMINAL_RUN_STATUSES.has(workflowRun.status)
    ? workflowRun
    : null;
  const run = activeDiscussion ?? activeWorkflow;
  if (!run) {
    return (
      <p className="mt-1.5 text-caption leading-5 text-muted-foreground/70">
        {t("room.panel.currentTask.empty")}
      </p>
    );
  }

  const stepDefinitions = run.workflow.steps;
  const totalSteps = stepDefinitions.length;
  const completedSteps = stepDefinitions.filter((step) => (
    COMPLETED_STEP_STATUSES.has(run.steps[step.id]?.status)
  )).length;
  const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const currentStep = stepDefinitions.find((step) => (
    run.steps[step.id]?.status === "running"
    || run.steps[step.id]?.status === "waiting_approval"
  )) ?? stepDefinitions.find((step) => run.steps[step.id]?.status === "queued");
  const currentAgent = currentStep?.agentId
    ? members.find((member) => member.id === currentStep.agentId)?.displayName ?? currentStep.agentId
    : null;

  const stopTask = () => {
    setStopping(true);
    void client.cancelWorkflowRun(chatId, run.id)
      .catch(() => {})
      .finally(() => setStopping(false));
  };

  let kindLabel = t("room.panel.currentTask.workflow");
  let stageLabel = t("room.panel.currentTask.stepProgress", {
    completed: completedSteps,
    total: totalSteps,
  });
  if (activeDiscussion) {
    const rawDiscussion = activeDiscussion.inputs?.discussion;
    const discussion = rawDiscussion && typeof rawDiscussion === "object"
      ? rawDiscussion as {
          mode?: unknown;
          maxRounds?: unknown;
          participantIds?: unknown;
        }
      : {};
    const isDebate = discussion.mode === "debate";
    kindLabel = t(isDebate ? "room.discussion.debate" : "room.discussion.discussion");
    const maxRounds = typeof discussion.maxRounds === "number" ? discussion.maxRounds : 1;
    const participantCount = Array.isArray(discussion.participantIds)
      ? discussion.participantIds.length
      : 1;
    const speakerSteps = stepDefinitions.filter((step) => step.id.startsWith("round-"));
    const completedSpeakerSteps = speakerSteps.filter((step) => (
      COMPLETED_STEP_STATUSES.has(activeDiscussion.steps[step.id]?.status)
    )).length;
    const currentRound = Math.min(
      maxRounds,
      Math.floor(completedSpeakerSteps / Math.max(1, participantCount)) + 1,
    );
    stageLabel = currentStep?.id === "summary"
      ? t(isDebate ? "room.panel.currentTask.judging" : "room.panel.currentTask.summarizing")
      : t("room.panel.currentTask.roundProgress", {
          current: currentRound,
          total: maxRounds,
        });
  }

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-background/55 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
          {kindLabel}
        </span>
        <span className="ml-auto text-micro text-muted-foreground">{progress}%</span>
      </div>
      <p className="mt-2 break-words text-ui font-medium leading-5">{run.workflow.goal}</p>
      <p className="mt-1 text-caption text-muted-foreground">
        {stageLabel}
        {currentAgent ? ` · ${t("room.panel.currentTask.currentAgent", { agent: currentAgent })}` : ""}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Progress value={progress} className="h-1.5 flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={stopping}
          onClick={stopTask}
          className="h-6 shrink-0 px-1.5 text-micro text-muted-foreground"
        >
          {stopping
            ? t("room.discussion.ending")
            : t(activeDiscussion ? "room.discussion.end" : "room.workflow.cancelRun")}
        </Button>
      </div>
    </div>
  );
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
 * Room context sidebar: one compact vertical page containing current task
 * progress, members, artifacts and a secondary workflow entry. Workflow
 * editing stays in the existing full-screen dialog; it is no longer a
 * persistent sidebar tab. Direct chats show the partner profile instead.
 *
 * Live state comes from ``get_room_state`` plus ``room_updated`` pushes; the
 * session-carried ``conversation`` prop is the render fallback until the
 * first fetch resolves.
 */
export function RoomContextPanel({
  chatId,
  conversation,
  discussionRun,
  workflowRun,
  className,
}: RoomContextPanelProps) {
  const { t } = useTranslation();
  const { client, token } = useClient();
  const agentsById = useAgents(token);
  const isRoom = conversation.type === "room";
  const [room, setRoom] = useState<RoomState | null>(null);
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
        {isRoom ? (
          <>
              <section className="border-b border-border/45 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5" />
                  {t("room.panel.currentTask.title")}
                </div>
                <RoomTaskProgress
                  chatId={chatId}
                  discussionRun={discussionRun}
                  workflowRun={workflowRun}
                  members={members}
                />
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

              <section className="border-b border-border/45 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Package className="h-3.5 w-3.5" />
                  {t("room.panel.artifacts")}
                  {artifacts.files.length > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
                      {artifacts.files.length}
                    </span>
                  ) : null}
                  <div className="flex-1" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={artifacts.refresh}
                    disabled={artifacts.loading}
                    title={t("room.panel.refresh")}
                    aria-label={t("room.panel.refresh")}
                    className="h-5 w-5 rounded-sm text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", artifacts.loading && "animate-spin")}
                    />
                  </Button>
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
            <section className="px-1.5 py-1.5">
              <WorkflowPanel chatId={chatId} members={members} className="w-full" />
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
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
