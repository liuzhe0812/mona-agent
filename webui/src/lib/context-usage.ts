import type { DevEvent, DevSession } from "./development-api";
import type { UIMessage } from "./types";

export type ContextUsage = { used: number; total: number | null; isBudget?: boolean };
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const windowSize = (value: unknown): number | null => (count(value) ?? 0) > 0 ? value as number : null;

export function workContextUsage(
  messages: UIMessage[], total: number | null, model?: string | null, live?: UIMessage["tokenUsage"],
  provider?: string, budget?: number | null,
): ContextUsage | null {
  const measure = (usage: NonNullable<UIMessage["tokenUsage"]>): ContextUsage | null => {
    const used = count(usage.contextTokens);
    if (used === null) return null;
    const sameRoute = usage.contextModel === model && usage.contextProvider === provider;
    const window = sameRoute ? windowSize(usage.contextWindowTokens) : null;
    if (window !== null) return { used, total: window };
    const runningBudget = sameRoute ? windowSize(usage.contextBudgetTokens) : null;
    if (runningBudget !== null) return { used, total: runningBudget, isBudget: true };
    const modelWindow = windowSize(total);
    if (modelWindow !== null) return { used, total: modelWindow };
    const configuredBudget = windowSize(budget);
    return configuredBudget === null ? { used, total: null } : { used, total: configuredBudget, isBudget: true };
  };
  if (live) {
    const measurement = measure(live);
    if (measurement) return measurement;
  }
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || message.jobId) continue;
    const usage = message.tokenUsage;
    if (!usage) continue;
    // Billing totals can span many model requests and cannot measure occupancy.
    return measure(usage);
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
