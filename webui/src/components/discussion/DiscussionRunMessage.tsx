import { useMemo, useState } from "react";
import { MessagesSquare, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, fallbackAgentName, resolveAgentDisplayName } from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { DiscussionLaunchOptions, WorkflowRun } from "@/lib/types";
import { useClientContextOrNull } from "@/providers/ClientProvider";

function discussionSpec(run: WorkflowRun): DiscussionLaunchOptions | null {
  const value = run.inputs?.discussion;
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DiscussionLaunchOptions>;
  if (!Array.isArray(raw.participantIds) || typeof raw.maxRounds !== "number") return null;
  return {
    mode: raw.mode === "debate" ? "debate" : "discussion",
    maxRounds: raw.maxRounds,
    participantIds: raw.participantIds.filter((id): id is string => typeof id === "string"),
    positions: raw.positions && typeof raw.positions === "object" ? raw.positions : {},
    styles: raw.styles && typeof raw.styles === "object" ? raw.styles : {},
    summaryAgentId: typeof raw.summaryAgentId === "string" ? raw.summaryAgentId : null,
  };
}

export function DiscussionRunMessage({ run }: { run: WorkflowRun }) {
  const { t } = useTranslation();
  const context = useClientContextOrNull();
  const agentsById = useAgents(context?.token ?? null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = discussionSpec(run);
  const participantIds = spec?.participantIds ?? [];
  const speakerSteps = useMemo(
    () => run.workflow.steps.filter((step) => step.id.startsWith("round-")),
    [run.workflow.steps],
  );
  const completedSteps = speakerSteps.filter((step) => {
    const status = run.steps[step.id]?.status;
    return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped";
  }).length;
  const progress = speakerSteps.length > 0 ? Math.round((completedSteps / speakerSteps.length) * 100) : 0;
  const terminal = run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  const currentRound = terminal
    ? spec?.maxRounds ?? 1
    : Math.min(spec?.maxRounds ?? 1, Math.floor(completedSteps / Math.max(1, participantIds.length)) + 1);

  const endDiscussion = () => {
    if (!context?.client || terminal) return;
    setEnding(true);
    setError(null);
    context.client.cancelWorkflowRun(run.roomId, run.id)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setEnding(false));
  };

  return (
    <div className="w-full rounded-xl border border-border/70 bg-card px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-theme/10 p-2 text-theme">
          <MessagesSquare className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption font-medium text-muted-foreground">
              {spec?.mode === "debate" ? t("room.discussion.debate") : t("room.discussion.discussion")}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
              {terminal
                ? t(`room.discussion.status.${run.status}`)
                : t("room.discussion.roundProgress", { current: currentRound, total: spec?.maxRounds ?? 1 })}
            </span>
          </div>
          <h3 className="mt-1 break-words text-ui font-medium leading-6">{run.workflow.goal}</h3>
          {participantIds.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {participantIds.map((id) => {
                const agent = agentsById.get(id);
                const name = agent
                  ? resolveAgentDisplayName(agentsById, id)
                  : fallbackAgentName(id);
                return (
                  <span key={id} className="flex items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-1 text-micro text-muted-foreground">
                    <AgentAvatar agentId={id} displayName={name} avatarUrl={agent?.avatarUrl} className="h-4 w-4" />
                    {name}
                  </span>
                );
              })}
            </div>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <Progress value={terminal && run.status === "succeeded" ? 100 : progress} className="h-1.5 flex-1" />
            <span className="shrink-0 text-micro text-muted-foreground">{progress}%</span>
            {!terminal ? (
              <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-caption" disabled={ending} onClick={endDiscussion}>
                <Square className="h-3 w-3" />
                {ending ? t("room.discussion.ending") : t("room.discussion.end")}
              </Button>
            ) : null}
          </div>
          {error ? <p className="mt-2 text-caption text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
