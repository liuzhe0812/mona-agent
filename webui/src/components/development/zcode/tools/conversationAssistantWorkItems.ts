import type { Activity } from "../../DevelopmentActivity";
import type { WorkRow as ConversationWorkRow } from "../types";
import { isExecuteToolCall, isExploreToolCall, isShellToolCallAwaitingCommand } from "../exploreToolCall";
import { resolveToolCallIdentity } from "./toolIdentity";
import { buildZCodeStreamingToolInputPreview } from "./streaming-tool-input-preview";
import type { TaskChatToolCallTreeNode } from "./shared";

export type ToolCallRow = ConversationWorkRow & { kind: "toolCall"; activity: Activity };
type AssistantWorkRow = ConversationWorkRow;

export type ConversationAssistantWorkRenderItem =
  | { kind: "row"; key: string; row: AssistantWorkRow }
  | {
      kind: "exploreGroup";
      key: string;
      rowId: string;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "executeGroup";
      key: string;
      rowId: string;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    }
  | {
      kind: "changesGroup";
      key: string;
      rowId: string;
      rows: ToolCallRow[];
      node: TaskChatToolCallTreeNode;
    };

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = false;

interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

function isToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  return row.kind === "toolCall" && row.activity !== undefined;
}

function getToolInput(activity: Activity): unknown {
  return activity.inputStreaming
    ? buildZCodeStreamingToolInputPreview(activity.inputText ?? "").input
    : activity.input ?? {};
}

export function getZCodeToolName(activity: Activity): string {
  const nativeName = (activity.kind ?? activity.label).trim();
  if (activity.kind !== "file") {
    const canonicalByMonaName: Record<string, string> = {
      apply_patch: "ApplyPatch",
      bash: "Bash",
      command: "Bash",
      commandexecution: "Bash",
      edit: "Edit",
      edit_file: "Edit",
      exec: "Bash",
      execute: "Bash",
      find_files: "Glob",
      glob: "Glob",
      grep: "Grep",
      list_dir: "Glob",
      list_exec_sessions: "Bash",
      multiedit: "Edit",
      multi_edit: "Edit",
      read: "Read",
      read_file: "Read",
      search: "WebSearch",
      shell: "Bash",
      todo_read: "TodoRead",
      todo_write: "TodoWrite",
      update_plan: "TodoWrite",
      webfetch: "WebFetch",
      web_search: "WebSearch",
      websearch: "WebSearch",
      write: "Write",
      write_file: "Write",
      write_stdin: "Bash",
    };
    return canonicalByMonaName[nativeName.toLowerCase()] ?? nativeName;
  }
  const changes = Array.isArray(activity.raw?.changes) ? activity.raw.changes : [];
  const operations = changes.flatMap((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) return [];
    const record = change as Record<string, unknown>;
    const operation = typeof record.kind === "string" ? record.kind : typeof record.type === "string" ? record.type : "";
    return [operation.toLowerCase()];
  });
  return operations.length > 0 && operations.every((operation) => /^(add|create|new)$/.test(operation))
    ? "Write"
    : "Edit";
}

function toolCallRaw(activity: Activity): unknown {
  if (activity.kind !== "file" || !Array.isArray(activity.raw?.changes)) {
    return activity.raw ? { ...activity.raw, activityId: activity.id } : { activityId: activity.id };
  }
  const nativeChanges = activity.raw.changes;
  const changes: Record<string, Record<string, unknown>> = {};
  for (const change of nativeChanges) {
    if (!change || typeof change !== "object" || Array.isArray(change)) continue;
    const record = change as Record<string, unknown>;
    if (typeof record.path !== "string" || !record.path.trim()) continue;
    const originalKind = typeof record.kind === "string" ? record.kind : typeof record.type === "string" ? record.type : "update";
    const normalizedKind = originalKind.toLowerCase();
    const type = /^(add|create|new)$/.test(normalizedKind)
      ? "add"
      : /^(delete|remove|removed)$/.test(normalizedKind)
        ? "delete"
        : "update";
    changes[record.path] = {
      ...record,
      type,
      ...(typeof record.diff === "string" ? { patch: record.diff } : {}),
    };
  }
  return { ...activity.raw, activityId: activity.id, nativeChanges, changes };
}

function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return isExploreToolCall({ kind: getZCodeToolName(row.activity), input: getToolInput(row.activity) });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return isExecuteToolCall({ kind: getZCodeToolName(row.activity), input: getToolInput(row.activity) });
}

function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  return resolveToolCallIdentity({ toolName: getZCodeToolName(row.activity), kind: row.activity.kind, input: getToolInput(row.activity) }).family === "file-write";
}

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.activity.state !== "waiting" && row.activity.state !== "pending")) {
    return false;
  }
  return isShellToolCallAwaitingCommand({
    kind: getZCodeToolName(row.activity),
    input: getToolInput(row.activity),
  });
}

function resolveToolStatus(activity: Activity): string {
  if (activity.state === "failed") return "failed";
  if (activity.state === "cancelled") return "stopped";
  if (activity.state === "returned") return "completed";
  return activity.state === "pending" ? "in_progress" : "pending";
}

function resolveGroupStageStatus(rows: readonly ToolCallRow[], stageTailIsRunning: boolean): string {
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.activity.state === "cancelled") ? "stopped" : "completed";
}

export function toToolCallTreeNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const activity = row.activity;
  return {
    toolCall: {
      toolId: row.rowId,
      toolName: getZCodeToolName(activity),
      kind: activity.kind ?? activity.label,
      title: activity.description || (activity.kind === "file" ? activity.paths.join(", ") : activity.label),
      input: getToolInput(activity),
      output: activity.output,
      status: resolveToolStatus(activity),
      startedAt: activity.startedAt,
      raw: toolCallRaw(activity),
      error: activity.state === "failed" ? activity.output : undefined,
    },
    childToolCalls: [],
  };
}

function buildExploreGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "exploreGroup" as const,
    // 固定锚定首个真实工具调用，流式追加子工具时不重建父卡片或展开状态。
    key: `explore:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `explore:${firstRow.rowId}`,
        toolName: "Explore",
        kind: "Explore",
        title: "Explore",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: firstRow.activity.startedAt,
      },
      childToolCalls: rows.map(toToolCallTreeNode),
    },
  };
}

function buildExecuteGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "executeGroup" as const,
    // Execute 与 Explore 共用首行身份，后续命令只更新 children。
    key: `execute:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `execute:${firstRow.rowId}`,
        toolName: "ExecuteGroup",
        kind: "executeGroup",
        title: "Execute",
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: firstRow.activity.startedAt,
      },
      childToolCalls: rows.map(toToolCallTreeNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.rowId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        status: stageTailIsRunning ? "in_progress" : "completed",
        startedAt: firstRow.activity.startedAt,
      },
      childToolCalls: rows.map(toToolCallTreeNode),
    },
  };
}

export function buildAssistantWorkRenderItems(
  rows: readonly ConversationWorkRow[],
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableTerminalGrouping = options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // Wait for the shell command before it occupies a visible position or closes the previous group.
  const visibleRows = rows.filter((row) => {
    if (row.kind === "reasoning" && !row.activity?.reasoningText?.trim()) return false;
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  let index = 0;

  while (index < visibleRows.length) {
    const row = visibleRows[index];
    if (!row) {
      index += 1;
      continue;
    }

    const isExploreRow = isExploreToolCallRow(row);
    if (!isExploreRow) {
      if (enableChangesGrouping && isChangesToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < visibleRows.length) {
          const nextRow = visibleRows[index];
          if (!nextRow || !isChangesToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(buildChangesGroup(groupRows, options?.stageTailIsRunning === true && index === visibleRows.length));
        continue;
      }
      if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
        const groupRows: ToolCallRow[] = [row];
        index += 1;
        while (index < visibleRows.length) {
          const nextRow = visibleRows[index];
          if (!nextRow || !isExecuteToolCallRow(nextRow)) break;
          groupRows.push(nextRow);
          index += 1;
        }
        if (groupRows.length === 1) {
          const singleRow = groupRows[0]!;
          items.push({ kind: "row", key: `row:${singleRow.rowId}`, row: singleRow });
          continue;
        }
        items.push(buildExecuteGroup(groupRows, options?.stageTailIsRunning === true && index === visibleRows.length));
        continue;
      }
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      index += 1;
      continue;
    }

    if (!enableExploreGrouping) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      index += 1;
      continue;
    }

    const groupRows: ToolCallRow[] = [row];
    index += 1;
    while (index < visibleRows.length) {
      const nextRow = visibleRows[index];
      if (!nextRow || !isExploreToolCallRow(nextRow)) break;
      groupRows.push(nextRow);
      index += 1;
    }
    if (groupRows.length === 1) {
      items.push({ kind: "row", key: `row:${row.rowId}`, row });
      continue;
    }
    items.push(buildExploreGroup(groupRows, options?.stageTailIsRunning === true && index === visibleRows.length));
  }

  return items;
}
