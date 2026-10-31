import { useMemo, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { ArchiveIcon, ShieldAlertIcon } from "zcode-lucide-react";
import type { DevEvent, RunStatus } from "@/lib/development-api";
import { useMarkdownContext } from "@/components/markdown/MarkdownContext";
import { useThemeValue } from "@/hooks/useTheme";
import { useDevelopmentStreamContext } from "./DevelopmentStreamContext";
import { ToolCallBlock } from "./zcode/tools/ToolCallBlock";
import { buildAssistantWorkRenderItems, toToolCallTreeNode, type ConversationAssistantWorkRenderItem } from "./zcode/tools/conversationAssistantWorkItems";
import type { TaskChatToolCallTreeNode } from "./zcode/tools/shared";
import type { WorkRow } from "./zcode/types";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./zcode/primitives/reasoning";
import { ZCodeSurface } from "./zcode/Surface";
import { MarkerDividerRow } from "./zcode/MarkerDividerRow";
import { isSubagentTool, SubagentToolRow } from "./SubagentTranscriptRow";
import { useZCodeIntl } from "./zcode/primitives/intl";

const names: Record<string, string> = {
  "command.started": "运行命令", "command.output": "命令输出", "command.completed": "命令结果",
  "file.changed": "文件修改", "file.change_proposed": "准备修改文件", "file.change_failed": "文件修改未完成",
  "tool.started": "使用开发工具", "tool.input.delta": "使用开发工具", "tool.completed": "工具结果", "run.plan": "更新计划",
  "policy.violation": "执行权限异常", "decision.expired": "确认已失效", "context.compacted": "整理会话上下文",
  "reasoning.started": "思考", "reasoning.delta": "思考", "reasoning.completed": "思考",
};
const toolNames: Record<string, string> = {
  development_collaboration: "子智能体协作",
  mcp__mona_development__development_collaboration: "子智能体协作",
};
const toolLabels: Record<string, string> = { Read: "读取", Write: "写入", Edit: "修改", MultiEdit: "修改", Grep: "搜索", Glob: "查找" };
export interface Activity {
  id: string; sequence: number; label: string; description: string; output: string; paths: string[];
  state: "waiting" | "pending" | "returned" | "failed" | "cancelled"; exitCode?: number; truncated: boolean;
  kind?: string; input?: unknown; durationMs?: number; startedAt?: number;
  reasoningText?: string; summaryParts?: Record<number, string>;
  inputText?: string; inputStreaming?: boolean;
  raw?: Record<string, unknown>;
}
const text = (value: unknown) => typeof value === "string" ? value : "";

export function developmentActivity(events: DevEvent[], runId?: string): Activity[] {
  const rows = new Map<string, Activity>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!runId || event.runId !== runId || !names[event.type] || seen.has(event.id)) continue;
    const data = event.payload;
    if ((event.type === "tool.started" || event.type === "tool.completed") && data.kind === "userMessage") continue;
    seen.add(event.id);
    const item = text(data.itemId) || text(data.id);
    const kind = event.type.split(".")[0];
    // Only an explicit native item identity joins start/output/completion events.
    const key = item ? `${kind}:${item}` : event.id;
    const old = rows.get(key);
    const output = typeof data.aggregatedOutput === "string" ? data.aggregatedOutput
      : typeof data.content === "string" ? data.content
      : event.type === "command.output" ? (old?.output ?? "") + text(data.delta) : old?.output ?? "";
    const failed = data.isError === true || (typeof data.exitCode === "number" && data.exitCode !== 0)
      || ["failed", "declined", "error"].includes(text(data.status)) || ["file.change_failed", "policy.violation", "decision.expired"].includes(event.type);
    const returned = event.type.endsWith(".completed") || ["file.changed", "run.plan", "context.compacted"].includes(event.type);
    const paths = Array.isArray(data.changes) ? data.changes.flatMap((change) =>
      change && typeof change === "object" && "path" in change && typeof change.path === "string" ? [change.path] : []) : old?.paths ?? [];
    const input = data.arguments ?? old?.input ?? (event.type === "run.plan" ? { plan: data.plan } : data.command ? { command: data.command } : {});
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const at = event.timestamp ? Date.parse(event.timestamp) : NaN;
    const startedAt = old?.startedAt ?? (event.type.endsWith(".started") && Number.isFinite(at) ? at : undefined);
    const summaryParts = { ...old?.summaryParts };
    if (event.type === "reasoning.delta" && typeof data.summaryIndex === "number") summaryParts[data.summaryIndex] = (summaryParts[data.summaryIndex] ?? "") + text(data.delta);
    const reasoningText = typeof data.text === "string" ? data.text : event.type === "reasoning.delta"
      ? typeof data.summaryIndex === "number" ? Object.keys(summaryParts).map(Number).sort((a, b) => a - b).map((key) => summaryParts[key]).join("\n\n") : (old?.reasoningText ?? "") + text(data.delta)
      : old?.reasoningText;
    rows.set(key, { id: key, sequence: old?.sequence ?? event.sequence, label: old?.label ?? toolLabels[text(data.name)] ?? names[event.type], description: text(data.command) || text(args.command) || text(args.file_path) || text(args.path) || text(args.pattern) || toolNames[text(data.name)] || text(data.name) || old?.description || "",
      kind: old?.kind ?? (event.type === "run.plan" ? "TodoWrite" : kind === "reasoning" ? "reasoning" : kind === "command" ? "exec" : text(data.name) || kind), input,
      inputText: event.type === "tool.input.delta" ? (old?.inputText ?? "") + text(data.delta) : old?.inputText,
      inputStreaming: typeof data.inputStreaming === "boolean" ? data.inputStreaming : data.arguments !== undefined ? false : old?.inputStreaming,
      raw: { ...old?.raw, ...data },
      reasoningText, summaryParts, startedAt, durationMs: typeof data.durationMs === "number" ? data.durationMs : old?.durationMs ?? (returned && startedAt !== undefined && Number.isFinite(at) ? Math.max(0, at - startedAt) : undefined),
      output, truncated: !!data.truncated || (!returned && !!old?.truncated), paths,
      state: ["cancelled", "interrupted", "stopped"].includes(text(data.status)) ? "cancelled" : failed ? "failed" : returned ? "returned" : old?.state ?? "pending",
      exitCode: typeof data.exitCode === "number" ? data.exitCode : old?.exitCode });
  }
  return [...rows.values()];
}

export function DevelopmentActivityRow({ row, running = false, detail, rowId = row.id }: { row: Activity; running?: boolean; detail?: ReactNode; rowId?: string }) {
  const { intl } = useZCodeIntl();
  const working = running && row.state === "pending";
  if (row.kind === "context") return <MarkerDividerRow rowId={rowId} markerType="compact" markerStatus="completed" markerOrigin="auto"
    icon={<ArchiveIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtle" />}
    label={intl.formatMessage({ id: "chat.contextCompaction.completedAuto" })} />;
  if (row.kind === "reasoning") {
    if (!row.reasoningText?.trim()) return null;
    const durationSeconds = row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
    return <div data-native-operation={row.id}>
      <Reasoning className="w-full" isStreaming={working} autoCollapseKey={working ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}>
        <ReasoningTrigger streamingText={row.reasoningText} />
        <div data-conversation-selectable="true"><ReasoningContent>{row.reasoningText}</ReasoningContent></div>
      </Reasoning>
    </div>;
  }
  return <DevelopmentToolNode node={toToolCallTreeNode({ rowId, kind: "toolCall", activity: row })} running={running} fullOutputContent={detail} operationId={row.id} />;
}

function DevelopmentToolNode({ node, running, fullOutputContent, getFullOutputContent, operationId }: {
  node: TaskChatToolCallTreeNode; running: boolean; fullOutputContent?: ReactNode;
  getFullOutputContent?: (toolId: string) => ReactNode; operationId?: string;
}) {
  const markdown = useMarkdownContext();
  const host = useDevelopmentStreamContext();
  const theme = useThemeValue();
  if (isSubagentTool(node.toolCall.toolName ?? node.toolCall.kind)) return <SubagentToolRow toolCall={node.toolCall} />;
  if (node.toolCall.kind === "decision" && node.toolCall.raw && typeof node.toolCall.raw === "object"
    && "decisionId" in node.toolCall.raw) return <MarkerDividerRow rowId={node.toolCall.toolId} markerType="decision" markerStatus={node.toolCall.status}
    icon={<ShieldAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-foreground-subtle" />}
    label={node.toolCall.title ?? "确认状态"} />;
  return <div data-native-operation={operationId}>
    <ToolCallBlock context={{ toolCallNode: node, workspacePath: markdown?.rootPath ?? "", theme,
      runActive: running,
      onOpenCodeViewer: host?.openCodeViewer,
      onOpenFileLink: host ? (target) => host.openCodeViewer({ type: "file", title: target.label, path: target.path }) : undefined,
      fullOutputContent, getFullOutputContent,
    }} renderUnhandled={(fallback) => <DevelopmentToolNode node={{ ...fallback, toolCall: { ...fallback.toolCall, kind: "other", toolName: "other" } }} running={running} getFullOutputContent={getFullOutputContent} />} />
  </div>;
}

export function DevelopmentWorkItems({ rows, items, running }: {
  rows: WorkRow[]; items: ConversationAssistantWorkRenderItem[]; running: boolean;
}) {
  const getFullOutputContent = (id: string) => rows.find((row) => row.rowId === id)?.fullOutputContent;
  if (!items.length) return null;
  return <div className="flex flex-col gap-4" aria-label="执行步骤">{items.map((item) => {
    if (item.kind === "row") {
      const row = item.row;
      return row.kind === "reasoning" || row.activity?.kind === "context" ? <div key={item.key}>{row.content ?? (row.activity && <DevelopmentActivityRow row={row.activity} running={running} rowId={row.rowId} />)}</div>
        : row.activity ? <DevelopmentToolNode key={item.key} node={toToolCallTreeNode({ ...row, kind: "toolCall", activity: row.activity })}
          running={running} fullOutputContent={row.fullOutputContent} getFullOutputContent={getFullOutputContent} operationId={row.activity.id} /> : <div key={item.key}>{row.content}</div>;
    }
    return <div key={item.key} data-activity-group={item.key}><DevelopmentToolNode node={item.node} running={running} getFullOutputContent={getFullOutputContent} /></div>;
  })}</div>;
}

export function DevelopmentActivityRows({ rows, running }: { rows: Activity[]; running: boolean }) {
  const work: WorkRow[] = rows.map((row) => ({ rowId: row.id, kind: row.kind === "reasoning" ? "reasoning" : "toolCall", activity: row }));
  const items = buildAssistantWorkRenderItems(work, { stageTailIsRunning: running });
  return <DevelopmentWorkItems rows={work} items={items} running={running} />;
}

export function DevelopmentActivity({ events, runId, runStatus }: { events: DevEvent[]; runId?: string; runStatus?: RunStatus }) {
  const rows = useMemo(() => developmentActivity(events, runId), [events, runId]);
  const running = runStatus === "running" || runStatus === "preparing";
  const latest = running ? rows.slice().reverse().find((row) => row.state === "pending") : undefined;
  if (!rows.length) return null;
  return <ZCodeSurface><div className="mx-auto max-w-3xl space-y-2 text-caption" aria-label="原生执行过程">
    {latest && <div role="status" className="flex min-w-0 items-center gap-2 text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span className="shrink-0">{latest.label}</span><span className="truncate font-mono">{latest.description}</span></div>}
    <details className="group/activity">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronRight className="h-3 w-3 transition-transform group-open/activity:rotate-90" />执行过程 · 最近 {rows.length} 项</summary>
      <div className="ml-1.5 space-y-1 border-l border-border/60 pl-3">{rows.map((row) => <DevelopmentActivityRow key={row.id} row={row} rowId={`${runId}:${row.id}`} running={running} />)}</div>
    </details>
  </div></ZCodeSurface>;
}
