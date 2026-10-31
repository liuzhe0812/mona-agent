import type { CompactToolCallState } from "./tool-call-summary";
type ToolPart = { state: CompactToolCallState };

const statusMap: Record<string, ToolPart["state"]> = {
  pending: "input-streaming",
  in_progress: "input-available",
  completed: "output-available",
  failed: "output-error",
  stopped: "output-error",
  denied: "output-denied",
};

export function mapToolStatus(status: string): ToolPart["state"] {
  return statusMap[status] ?? "input-streaming";
}
