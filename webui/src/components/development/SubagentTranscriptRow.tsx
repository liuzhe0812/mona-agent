import type { DevCollaboration } from "@/lib/development-api";
import { useDevelopmentStreamContext } from "./DevelopmentStreamContext";
import { SubagentAvatar } from "./subagent-tasks";
import { useDevelopmentStore } from "./store";
import type { TaskChatToolCall } from "./zcode/tools/shared";

export const isSubagentTool = (name: string) => ["development_collaboration", "mcp__mona_development__development_collaboration"].includes(name);

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return readObject(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readSubagentTask(value: unknown): Partial<DevCollaboration> | undefined {
  const object = readObject(value);
  if (typeof object?.childSessionId === "string") return object as unknown as Partial<DevCollaboration>;
  if (Array.isArray(object?.content)) {
    for (const block of object.content) {
      const task = readSubagentTask(readObject(block)?.text);
      if (task) return task;
    }
  }
  return undefined;
}

function resultLabel(record?: Partial<DevCollaboration>) {
  const status = record?.latestRun?.status;
  if (status === "succeeded") return "已完成";
  if (status === "failed" || record?.state === "failed") return "未完成";
  if (status === "interrupted") return "已中断";
  if (status === "unknown" || status === "closed_unknown" || record?.state === "unknown") return "结果待核对";
  if (["queued", "preparing", "running", "waiting_user", "waiting_children", "interrupting"].includes(status ?? "") || record?.state === "submitted") return "开始工作";
  return "结果已返回";
}

export function SubagentTranscriptRow({ childId, title, label, rowId }: {
  childId?: string; title?: string; label?: string; rowId: string;
}) {
  const host = useDevelopmentStreamContext();
  const record = host?.subagents?.find((item) => item.childSessionId === childId);
  const cachedTitle = useDevelopmentStore((state) => childId ? state.snapshots[childId]?.session.title : undefined);
  const name = record?.title || title || cachedTitle || record?.goal || "子智能体任务";
  const caption = label ?? resultLabel(record);
  const content = <><SubagentAvatar id={childId ?? rowId} className="h-4 w-4" /><span className="min-w-0 truncate">{name}{caption}</span></>;
  const className = "flex w-full min-w-0 items-center gap-2 py-1 text-left text-ui-base text-foreground-subtle";
  return childId && host?.openSubagent
    ? <button type="button" data-subagent-id={childId} aria-label={`查看子智能体任务：${name}`} title={`${name}${caption}`} className={`${className} hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`} onClick={() => host.openSubagent!(childId)}>{content}</button>
    : <div className={className}>{content}</div>;
}

export function SubagentToolRow({ toolCall }: { toolCall: TaskChatToolCall }) {
  const host = useDevelopmentStreamContext();
  const input = readObject(toolCall.input);
  const failed = toolCall.status === "failed";
  if (input?.action && input.action !== "start") {
    const labels: Record<string, string> = { wait: "等待子任务", read_result: "读取子任务结果", list: "查询子任务", presets: "读取子智能体配置", stop: "停止子任务" };
    const action = labels[String(input.action)];
    return failed ? <div className="py-1 text-ui-base text-foreground-subtle">{action ?? "子任务操作"}未成功</div> : null;
  }
  const task = readSubagentTask(toolCall.output);
  const currentTask = task?.childSessionId
    ? host?.subagents?.find((item) => item.childSessionId === task.childSessionId) ?? task
    : task;
  const title = typeof task?.title === "string" ? task.title : typeof input?.title === "string" ? input.title
    : typeof input?.goal === "string" ? input.goal : undefined;
  const outcome = readObject(toolCall.output);
  const uncertain = task?.state === "unknown" || task?.latestRun?.status === "unknown" || outcome?.error === "host_collaboration_unknown";
  const label = uncertain ? "状态待核对" : failed ? "调用未完成" : task?.childSessionId ? resultLabel(currentTask) : "准备中";
  return <SubagentTranscriptRow childId={task?.childSessionId} title={title} label={label} rowId={toolCall.toolId} />;
}
