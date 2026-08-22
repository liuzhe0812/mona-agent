import type { AgentSummary, ChatSummary } from "@/lib/types";
import { cleanSessionPreview } from "@/lib/session-preview";

type AgentNameMap = ReadonlyMap<string, Pick<AgentSummary, "displayName">>;

export function filterSessionsByQuery(
  sessions: ChatSummary[],
  query: string,
  titleOverrides: Record<string, string> = {},
  agentsById?: AgentNameMap,
): ChatSummary[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;

  return sessions.filter((session) => {
    const conversation = session.conversation;
    const agentNames = conversation?.agentIds
      .map((agentId) => agentsById?.get(agentId)?.displayName ?? agentId)
      .join(" ");
    const directAgentName = conversation?.directAgentId
      ? agentsById?.get(conversation.directAgentId)?.displayName
      : undefined;
    const haystack = [
      titleOverrides[session.key],
      session.title,
      // Match against the same display-cleaned preview the list renders
      // (session-list redesign §9.2), so Markdown noise never blocks a query.
      cleanSessionPreview(session.preview),
      conversation?.title,
      conversation?.goal,
      agentNames,
      directAgentName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
}
