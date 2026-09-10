import { cn } from "@/lib/utils";
import type { AgentSummary, ConversationMeta } from "@/lib/types";

/** Reserved ID of the built-in main assistant (mirrors ``mona/agent/partners.py``). */
export const MONA_AGENT_ID = "mona";

/** Static brand mark for Mona's default avatar in the session list. */
export const MONA_AVATAR_IMAGE = "/brand/mona_avatar_human.png";

const BUILTIN_AGENT_AVATAR_IMAGES: Readonly<Record<string, string>> = {
  "com.mona.xhs-operator": "/brand/agents/xhs-operator.png",
  "com.mona.academic-researcher": "/brand/agents/academic-researcher.png",
  "com.mona.a-share-analyst": "/brand/agents/a-share-analyst.png",
};

const BUILTIN_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "com.mona.academic-researcher": "学者",
  "com.mona.xhs-operator": "种草家",
  "com.mona.a-share-analyst": "股神",
};

/** Minimal identity needed to render an agent avatar/name. */
export interface AgentIdentity {
  id: string;
  displayName: string;
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
  if (BUILTIN_AGENT_DISPLAY_NAMES[agentId]) return BUILTIN_AGENT_DISPLAY_NAMES[agentId];
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
  avatarUrl?: string | null;
  className?: string;
}

/** Small circular avatar for an agent. Mona and built-in partners use bundled
 *  portraits; installed partners fall back to a deterministic tinted initial. */
export function AgentAvatar({ agentId, displayName, avatarUrl, className }: AgentAvatarProps) {
  const resolvedAvatarUrl = avatarUrl
    ?? (agentId === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : BUILTIN_AGENT_AVATAR_IMAGES[agentId]);
  if (resolvedAvatarUrl) {
    return (
      <img
        src={resolvedAvatarUrl}
        alt=""
        className={cn("inline-flex shrink-0 rounded-full object-cover", className)}
      />
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
  /** Mona task title; shown as a quiet initial instead of repeating the brand avatar. */
  taskTitle?: string;
  /** Per-member avatar classes; defaults to the compact ``h-4 w-4``. */
  avatarClassName?: string;
}

/** Session-list avatar: a single agent avatar for direct chats, a stacked
 *  two-member cluster (with overflow count) for rooms. */
export function ConversationAvatar({
  conversation,
  agentsById,
  className,
  taskTitle,
  avatarClassName,
}: ConversationAvatarProps) {
  const agents = agentsById ?? EMPTY_AGENTS;
  const memberCls = avatarClassName ?? "h-4 w-4";
  if (conversation?.type === "room") {
    const memberIds = conversation.agentIds;
    const visible = memberIds.slice(0, 2);
    const overflow = memberIds.length - visible.length;
    return (
      <span className={cn("flex shrink-0 items-center bg-muted/35", className)} aria-hidden>
        {visible.map((id, index) => (
          <AgentAvatar
            key={id}
            agentId={id}
            displayName={resolveAgentDisplayName(agents, id)}
            avatarUrl={agents.get(id)?.avatarUrl ?? (id === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)}
            className={cn(
              memberCls,
              "ring-1 ring-background",
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
  if (directId === MONA_AGENT_ID && taskTitle) {
    return (
      <span
        role="img"
        aria-label="Mona"
        className={cn(
          "relative inline-flex shrink-0 select-none items-center justify-center bg-muted/55 text-sm font-medium text-muted-foreground",
          className,
        )}
      >
        {Array.from(taskTitle.trim())[0]?.toUpperCase() ?? "M"}
        <AgentAvatar
          agentId={MONA_AGENT_ID}
          avatarUrl={MONA_AVATAR_IMAGE}
          className="absolute bottom-0.5 right-0.5 h-4 w-4 rounded-sm bg-background ring-1 ring-background"
        />
      </span>
    );
  }
  return (
    <AgentAvatar
      agentId={directId}
      displayName={resolveAgentDisplayName(agents, directId)}
      avatarUrl={agents.get(directId)?.avatarUrl ?? (directId === MONA_AGENT_ID ? MONA_AVATAR_IMAGE : null)}
      className={cn(memberCls, className)}
    />
  );
}
