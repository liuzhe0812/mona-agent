import { useMemo } from "react";

import { TraceGroup } from "@/components/MessageBubble";
import { formatToolCallTrace } from "@/lib/tool-traces";
import type { ToolProgressEvent, UIMessage } from "@/lib/types";

const ERROR_TAIL_MAX = 120;

function activityLines(events: ToolProgressEvent[]): string[] {
  const lines: string[] = [];
  for (const ev of events) {
    const base = formatToolCallTrace(ev);
    if (!base) continue;
    if (ev.phase === "error") {
      const err = typeof ev.error === "string" ? ev.error.trim() : "";
      if (err) {
        const tail = err.length > ERROR_TAIL_MAX ? `${err.slice(0, ERROR_TAIL_MAX)}…` : err;
        lines.push(`${base} — ${tail}`);
        continue;
      }
    }
    lines.push(base);
  }
  return lines;
}

/** Collapsible tool trail of one workflow step — one row per call, failed
 *  calls carry their error inline. Used both for the live run card (events
 *  streamed while the step runs) and for persisted step messages (events
 *  stored with the step result so the trail survives a reload). */
export function StepActivityTrace({ events }: { events: ToolProgressEvent[] }) {
  const message = useMemo<UIMessage | null>(() => {
    const lines = activityLines(events);
    if (lines.length === 0) return null;
    return {
      id: "step-activity",
      role: "tool",
      kind: "trace",
      content: lines[lines.length - 1],
      traces: lines,
      createdAt: 0,
    };
  }, [events]);
  if (!message) return null;
  return <TraceGroup message={message} animClass="" />;
}
