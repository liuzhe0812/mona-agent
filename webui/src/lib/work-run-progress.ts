import type { ToolProgressEvent, UIMessage, WorkRequestStats } from "@/lib/types";

export function activeRunTools(
  messages: UIMessage[],
  taskId: string | null,
  startedAt: number | null,
): ToolProgressEvent[] {
  const active = new Map<string, ToolProgressEvent>();
  const finished = new Set<string>();
  for (const message of messages) {
    const afterTurnStart = startedAt !== null && message.createdAt >= startedAt * 1000;
    const current = taskId && message.taskId
      ? message.taskId === taskId && (startedAt === null || afterTurnStart)
      : afterTurnStart;
    if (!current) continue;
    for (const event of message.toolEvents ?? []) {
      if (!event.call_id) continue;
      if (event.phase === "start" && !finished.has(event.call_id)) active.set(event.call_id, event);
      if (event.phase === "end" || event.phase === "error") {
        finished.add(event.call_id);
        active.delete(event.call_id);
      }
    }
  }
  return [...active.values()];
}

export function canStartDesktopInput(event: ToolProgressEvent): boolean {
  if (event.name !== "computer_act" || event.phase !== "start") return false;
  if (!event.arguments || typeof event.arguments !== "object" || Array.isArray(event.arguments)) return false;
  const { action, arguments: nested, ...flat } = event.arguments as Record<string, unknown>;
  const flatKeys = Object.keys(flat);
  if (flatKeys.length && (action !== "launch" || nested != null
    || flatKeys.some((key) => key !== "name" && key !== "urls"))) return false;
  const args = flatKeys.length ? flat : nested;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (action !== "launch") return Object.keys(args).length > 0;
  const target = args as Record<string, unknown>;
  return [target.bundle_id, target.name, target.aumid, target.path, target.launch_path].some((value) =>
    typeof value === "string" && !!value.trim(),
  ) || (Array.isArray(target.urls) && target.urls.some((url) => typeof url === "string" && !!url.trim()));
}

export function workToolStatus(name: string): string {
  if (name.startsWith("browser_")) return "browser";
  switch (name) {
    case "web_search": return "search";
    case "web_fetch": return "fetch";
    case "computer_observe": return "observe";
    case "computer_act": return "computer";
    case "exec":
    case "exec_command":
    case "write_stdin": return "command";
    case "read_file": return "readFile";
    case "apply_patch":
    case "edit_file":
    case "write_file": return "editFile";
    case "load_capability": return "preparing";
    default: return "tool";
  }
}

export interface WorkRequestSeries {
  turnKey: string;
  requests: readonly WorkRequestStats[];
  finished?: boolean;
}

export function appendWorkRequest(
  previous: WorkRequestSeries | null,
  turnKey: string,
  request: WorkRequestStats,
): WorkRequestSeries | null {
  if (!Number.isInteger(request.index) || request.index < 0
    || !Number.isFinite(request.elapsed_ms) || request.elapsed_ms <= 0
    || !Number.isInteger(request.output_tokens) || request.output_tokens <= 0) return previous;
  const sameTurn = previous?.turnKey === turnKey ? previous : null;
  const lastIndex = sameTurn?.requests.at(-1)?.index ?? -1;
  if (request.index <= lastIndex || sameTurn?.finished) return previous;
  return { turnKey, requests: [...(sameTurn?.requests ?? []), request] };
}

function reportedCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function summarizeWorkRequests(series: WorkRequestSeries | null) {
  if (!series || series.requests.length === 0) return undefined;
  let outputTokens = 0, elapsedMs = 0, reasoning = 0;
  let reasoningRequests = 0, reasoningOutput = 0, peakRate = 0;
  const rates = series.requests.map((sample) => {
    outputTokens += sample.output_tokens;
    elapsedMs += sample.elapsed_ms;
    const rate = sample.output_tokens * 1000 / sample.elapsed_ms;
    peakRate = Math.max(peakRate, rate);
    if (reportedCount(sample.reasoning_tokens) && sample.reasoning_tokens <= sample.output_tokens) {
      reasoning += sample.reasoning_tokens;
      reasoningOutput += sample.output_tokens;
      reasoningRequests += 1;
    }
    return rate;
  });
  const total = series.requests.length;
  const reasoningPartial = reasoningRequests > 0 && reasoningRequests < total;
  return {
    latestRate: rates[rates.length - 1],
    averageRate: outputTokens * 1000 / elapsedMs,
    outputTokens,
    peakRate,
    reasoningRatio: reasoningOutput > 0 ? reasoning / reasoningOutput : undefined,
    samples: rates.slice(-12),
    ...(reasoningPartial ? { coverage: {
      total,
      reasoning: reasoningRequests,
    } } : {}),
  };
}
