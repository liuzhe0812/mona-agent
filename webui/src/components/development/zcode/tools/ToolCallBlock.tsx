import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { mapToolStatus } from "../mapToolStatus";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "../tool-call-summary";
import { useZCodeIntl } from "../primitives/intl";
import { resolveToolCallIdentity } from "./toolIdentity";
import { readRawToolCallFileSummaries } from "./fileSummaries";
import { getToolCallErrorText } from "./toolError";
import { buildToolDisplayModel } from "./toolDisplay";
import { ExecuteGroupToolCallBlock } from "./renderers/execute-group";
import { ExecuteToolCallBlock } from "./renderers/execute";
import { EditToolCallBlock } from "./renderers/edit";
import { ExploreToolCallBlock } from "./renderers/explore";
import { FallbackToolCallBlock } from "./renderers/fallback";
import { ReadToolCallBlock } from "./renderers/read";
import { SearchToolCallBlock } from "./renderers/search";
import { TodoToolCallBlock } from "./renderers/todo";
import type { TaskChatToolCallTreeNode, ToolCallBlockRenderContext } from "./shared";

export type ToolCallContext = Omit<
  ToolCallBlockRenderContext,
  | "displayModel"
  | "viewerSource"
  | "rawFileSummaries"
  | "childToolList"
  | "renderChildToolCall"
  | "isRunning"
  | "statusLabel"
>;

export function ToolCallBlock({
  context,
  renderUnhandled,
}: {
  context: ToolCallContext;
  renderUnhandled: (node: TaskChatToolCallTreeNode) => ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const toolState = mapToolStatus(toolCall.status);
  const isRunning = isCompactToolCallRunningState(toolState) && context.runActive !== false;
  const statusLabel = intl.formatMessage({
    id: getCompactToolCallStatusMessageId(toolState, toolCall.status),
  });
  const displayModel = useMemo(
    () => buildToolDisplayModel(toolCall, context.workspacePath),
    [context.workspacePath, toolCall],
  );
  const errorText = context.errorText ?? getToolCallErrorText(toolCall);
  const rawFileSummaries = useMemo(
    () =>
      readRawToolCallFileSummaries(toolCall.raw, {
        toolName: toolCall.toolName,
        kind: toolCall.kind,
        title: toolCall.title,
        input: toolCall.input,
        output: toolCall.output,
        raw: toolCall.raw,
      }),
    [toolCall.input, toolCall.kind, toolCall.output, toolCall.raw, toolCall.title, toolCall.toolName],
  );
  const renderChildToolCall = useCallback(
    (node: TaskChatToolCallTreeNode, options?: { showIcon?: boolean }) => (
      <ToolCallBlock
        context={{
          ...context,
          toolCallNode: node,
          showIcon: options?.showIcon ?? false,
          fullOutputContent: context.getFullOutputContent?.(node.toolCall.toolId),
        }}
        renderUnhandled={renderUnhandled}
      />
    ),
    [context, renderUnhandled],
  );
  const childToolList = useMemo(
    () =>
      childToolCalls.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5">
          {childToolCalls.map((child) => (
            <div key={child.toolCall.toolId}>
              {renderChildToolCall(child, { showIcon: false })}
            </div>
          ))}
        </div>
      ) : null,
    [childToolCalls, renderChildToolCall],
  );
  const childContext: ToolCallBlockRenderContext = {
    ...context,
    displayModel,
    viewerSource: displayModel.viewerSource,
    rawFileSummaries,
    childToolList,
    errorText,
    isRunning,
    statusLabel,
    renderChildToolCall,
  };

  if (toolCall.kind === "executeGroup") {
    return <ExecuteGroupToolCallBlock context={childContext} />;
  }
  if (toolCall.kind === "Explore" || toolCall.toolName === "Explore") {
    return <ExploreToolCallBlock context={childContext} />;
  }

  if (toolCall.kind === "changesGroup") return renderUnhandled(context.toolCallNode);

  switch (resolveToolCallIdentity(toolCall).family) {
    case "shell":
      return <ExecuteToolCallBlock context={childContext} />;
    case "file-read":
      return <ReadToolCallBlock context={childContext} />;
    case "search":
      return <SearchToolCallBlock context={childContext} />;
    case "todo":
      return <TodoToolCallBlock context={childContext} />;
    case "file-write":
      return <EditToolCallBlock context={childContext} />;
    default:
      return <FallbackToolCallBlock context={childContext} />;
  }
}
