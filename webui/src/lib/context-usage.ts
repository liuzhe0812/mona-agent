import type { DevEvent, DevSession } from "./development-api";
import type { UIMessage } from "./types";

export type ContextUsage = { used: number; total: number | null };
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const windowSize = (value: unknown): number | null => (count(value) ?? 0) > 0 ? value as number : null;

export function workContextUsage(messages: UIMessage[], total: number | null, model?: string | null, live?: UIMessage["tokenUsage"], provider?: string): ContextUsage | null {
  const sameRoute = (usage: NonNullable<UIMessage["tokenUsage"]>) => usage.contextModel === model && usage.contextProvider === provider;
  if (live && count(live.contextTokens) !== null) return { used: live.contextTokens!, total: sameRoute(live) ? windowSize(live.contextWindowTokens) ?? total : total };
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || message.jobId) continue;
    const usage = message.tokenUsage;
    if (!usage) continue;
    // Billing totals can span many model requests and cannot measure occupancy.
    const used = count(usage.contextTokens);
    if (used === null) return null;
    return { used, total: sameRoute(usage) ? windowSize(usage.contextWindowTokens) ?? total : total };
  }
  return null;
}

export function developmentContextUsage(events: DevEvent[], session: DevSession, total: number | null): ContextUsage | null {
  let latest: ContextUsage | null = null;
  let knownWindow = total;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const data = event.payload;
    if (event.type === "context.compacted") { latest = null; continue; }
    if (event.type !== "usage.updated") continue;
    if ((data.executor !== undefined && data.executor !== session.executor)
      || ("selectedModel" in data && data.selectedModel !== session.model)
      || ("modelProvider" in data && data.modelProvider !== (session.modelProvider ?? null))) continue;
    const used = count(data.contextTokens);
    if (used === null) continue;
    if ("contextWindow" in data) knownWindow = windowSize(data.contextWindow) ?? total;
    latest = { used, total: knownWindow };
  }
  return latest;
}
