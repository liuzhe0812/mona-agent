import type { InlineWidgetData, UIMessage } from "./types";

export function upsertInlineWidgetMessage(
  messages: UIMessage[],
  widget: InlineWidgetData,
  identity: { taskId?: string; authorId?: string },
): UIMessage[] {
  if (!widget || typeof widget.id !== "string" || !widget.id || typeof widget.code !== "string"
    || !["streaming", "complete", "error"].includes(widget.status)) return messages;
  const id = `widget:${identity.taskId ?? ""}:${widget.id}`;
  const index = messages.findIndex((message) => message.id === id);
  const previous = index >= 0 ? messages[index] : undefined;
  if (previous?.widget?.status === "complete" && widget.status === "streaming") return messages;
  const message: UIMessage = {
    id, role: "assistant", kind: "widget", content: "", widget,
    isStreaming: widget.status === "streaming",
    createdAt: previous?.createdAt ?? Date.now(),
    ...(identity.taskId ? { taskId: identity.taskId } : {}),
    ...(identity.authorId ? { authorId: identity.authorId, authorType: "agent" as const } : {}),
  };
  if (index < 0) return [...messages.filter((candidate) => !(
    candidate.role === "assistant" && candidate.kind !== "widget" && candidate.kind !== "trace"
    && candidate.isStreaming && !candidate.content && !candidate.reasoning
    && !candidate.media?.length && !candidate.deliveredFiles?.length
  )), message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

export function finishPendingWidgets(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => message.widget?.status === "streaming" ? {
    ...message, isStreaming: false,
    widget: { ...message.widget, status: "error", error: "图形生成已中断，请让 Mona 重新生成。" },
  } : message);
}
