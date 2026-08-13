import { AgentLogo } from "@/components/AgentLogo";
import { cn } from "@/lib/utils";
import type { AgentSummary, ConversationMeta } from "@/lib/types";

/** Reserved ID of the built-in main assistant (mirrors ``mona/agent/partners.py``). */
export const MONA_AGENT_ID = "mona";

/** Minimal identity needed to render an agent avatar/name. */
export interface AgentIdentity {
  id: string;
  displayName: string;
  description?: string;
}

/** Deterministic accent palette for partner agents (Mona keeps its brand logo). */
const AVATAR_PALETTE = [
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Display name for an agent when the registry entry is unavailable: the last
 *  dotted ID segment (``com.mona.a-share-analyst`` → ``A-share-analyst``). */
export function fallbackAgentName(agentId: string): string {
  if (agentId === MONA_AGENT_ID) return "Mona";
  const leaf = agentId.split(".").pop() ?? agentId;
  if (!leaf) return agentId;
  const first = Array.from(leaf)[0];
  return first ? first.toUpperCase() + leaf.slice(first.length) : leaf;
}

export function resolveAgentDisplayName(
  agentsById: ReadonlyMap<string, AgentSummary>,
  agentId: string,
): string {
  return agentsById.get(agentId)?.displayName ?? fallbackAgentName(agentId);
}

interface AgentAvatarProps {
  agentId: string;
  displayName?: string;
  className?: string;
}

/** Small circular avatar for an agent. Mona renders the brand owl; partner
 *  agents render an initial on a deterministic accent tint until agent
 *  packages expose HTTP-loadable avatars. */
export function AgentAvatar({ agentId, displayName, className }: AgentAvatarProps) {
  if (agentId === MONA_AGENT_ID) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
          className,
        )}
      >
        <AgentLogo state="welcome" className="h-full w-full" />
      </span>
    );
  }
  const tint = AVATAR_PALETTE[hashString(agentId) % AVATAR_PALETTE.length];
  const initial = Array.from((displayName ?? fallbackAgentName(agentId)).trim())[0] ?? "?";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full",
        "text-[10px] font-semibold leading-none",
        tint,
        className,
      )}
    >
      {initial.toUpperCase()}
    </span>
  );
}

const EMPTY_AGENTS: ReadonlyMap<string, AgentSummary> = new Map();

interface ConversationAvatarProps {
  /** Conversation shape; ``null``/``undefined`` renders the legacy Mona direct avatar. */
  conversation?: ConversationMeta | null;
  agentsById?: ReadonlyMap<string, AgentSummary>;
  className?: string;
}

/** Session-list avatar: a single agent avatar for direct chats, a stacked
 *  two-member cluster (with overflow count) for rooms. */
export function ConversationAvatar({
  conversation,
  agentsById,
  className,
}: ConversationAvatarProps) {
  const agents = agentsById ?? EMPTY_AGENTS;
  if (conversation?.type === "room") {
    const memberIds = conversation.agentIds;
    const visible = memberIds.slice(0, 2);
    const overflow = memberIds.length - visible.length;
    return (
      <span className={cn("flex shrink-0 items-center", className)} aria-hidden>
        {visible.map((id, index) => (
          <AgentAvatar
            key={id}
            agentId={id}
            displayName={resolveAgentDisplayName(agents, id)}
            className={cn(
              "h-4 w-4 ring-1 ring-background",
              index > 0 && "-ml-1.5",
            )}
          />
        ))}
        {overflow > 0 ? (
          <span className="-ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-medium leading-none text-muted-foreground ring-1 ring-background">
            +{overflow}
          </span>
        ) : null}
      </span>
    );
  }
  const directId = conversation?.directAgentId ?? MONA_AGENT_ID;
  return (
    <AgentAvatar
      agentId={directId}
      displayName={resolveAgentDisplayName(agents, directId)}
      className={cn("h-4 w-4", className)}
    />
  );
}
