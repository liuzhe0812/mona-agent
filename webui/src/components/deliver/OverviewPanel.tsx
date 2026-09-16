import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Circle,
  ExternalLink,
  Globe2,
  Play,
  Search,
  Sparkles,
} from "lucide-react";

import { openExternalUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { TaskPlanWsPayload, ToolProgressEvent, UIMessage } from "@/lib/types";

export interface OverviewTodoItem {
  id: string;
  text: string;
  status: string;
}

export type OverviewReference =
  | { id: string; kind: "skill"; label: string }
  | { id: string; kind: "web"; label: string; url: string }
  | { id: string; kind: "search"; label: string };

function toolArguments(event: ToolProgressEvent): Record<string, unknown> {
  if (event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments)) {
    return event.arguments as Record<string, unknown>;
  }
  if (typeof event.arguments !== "string") return {};
  try {
    const parsed = JSON.parse(event.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function firstResultUrl(event: ToolProgressEvent): string {
  const text = typeof event.result === "string"
    ? event.result
    : event.result ? JSON.stringify(event.result) : "";
  return text.match(/https?:\/\/[^\s)"'<>]+/)?.[0].replace(/[.,;!?。，；！？]+$/, "") ?? "";
}

function messageToolEvents(messages: UIMessage[]): ToolProgressEvent[] {
  return messages.flatMap((message) => message.toolEvents ?? []);
}

function currentTaskStartIndex(messages: UIMessage[]): number {
  let latestUserIndex = -1;
  let taskId = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    latestUserIndex = index;
    taskId = messages[index].taskId?.trim() ?? "";
    break;
  }
  if (!taskId) return latestUserIndex;
  let firstTaskUserIndex = latestUserIndex;
  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].taskId === taskId) {
      firstTaskUserIndex = index;
    }
  }
  return firstTaskUserIndex;
}

export function collectOverviewTodo(
  messages: UIMessage[],
  taskPlan?: TaskPlanWsPayload,
): OverviewTodoItem[] {
  if (taskPlan?.source === "ai") {
    return taskPlan.steps.map((item) => ({
      id: item.id,
      text: item.step,
      status: item.status,
    }));
  }
  const taskStartIndex = currentTaskStartIndex(messages);
  for (let index = messages.length - 1; index > taskStartIndex; index -= 1) {
    const snapshot = messages[index].taskPlan;
    if (snapshot?.source === "ai") {
      return snapshot.steps.map((item) => ({
        id: item.id,
        text: item.step,
        status: item.status,
      }));
    }
  }
  return [];
}

export function collectOverviewReferences(messages: UIMessage[]): OverviewReference[] {
  const references: OverviewReference[] = [];
  const seen = new Set<string>();
  const push = (reference: OverviewReference) => {
    if (seen.has(reference.id)) return;
    seen.add(reference.id);
    references.push(reference);
  };
  const taskStartIndex = currentTaskStartIndex(messages);
  for (const event of messageToolEvents(messages.slice(Math.max(0, taskStartIndex)))) {
    const name = event.name ?? "";
    const args = toolArguments(event);
    if (["skill_read", "skill_reference_read", "load_skill"].includes(name)) {
      const label = String(args.skill_name ?? args.skill ?? args.name ?? "").trim();
      if (label) push({ id: `skill:${label}`, kind: "skill", label });
      continue;
    }
    if (["web_search", "search_query"].includes(name)) {
      const label = String(args.query ?? args.q ?? "").trim();
      if (label) push({ id: `search:${label}`, kind: "search", label });
      continue;
    }
    if (
      ["web_fetch", "browser_open", "browser_navigate", "open"].includes(name)
      || (name === "browser_act" && ["open", "navigate"].includes(String(args.kind ?? "")))
    ) {
      const url = String(args.url ?? args.ref_id ?? "").trim() || firstResultUrl(event);
      if (/^https?:\/\//i.test(url)) {
        let label = url;
        try {
          label = new URL(url).hostname;
        } catch {
          // Keep the original URL label.
        }
        push({ id: `web:${url}`, kind: "web", label, url });
      }
    }
  }
  return references;
}

function OverviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="border-b border-border/45 py-1.5 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-ui font-medium text-foreground hover:bg-muted/35"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        {title}
      </button>
      {expanded ? children : null}
    </section>
  );
}

function TodoList({ items }: { items: OverviewTodoItem[] }) {
  if (items.length === 0) {
    return <p className="px-7 py-2 text-micro text-muted-foreground">AI 制定任务计划后会显示在这里。</p>;
  }
  return (
    <ul className="grid gap-1 px-3 pb-2">
      {items.map((item) => {
        const completed = item.status === "completed";
        const active = item.status === "in_progress";
        return (
          <li key={item.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-muted/35">
            {completed ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : active ? (
              <Play className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-primary text-primary" />
            ) : (
              <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("leading-5", completed && "text-muted-foreground line-through")}>{item.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ReferenceList({ references }: { references: OverviewReference[] }) {
  if (references.length === 0) {
    return <p className="px-7 py-2 text-micro text-muted-foreground">任务使用的技能、搜索和网页会显示在这里。</p>;
  }
  return (
    <ul className="grid gap-1 px-3 pb-2">
      {references.map((reference) => {
        const icon = reference.kind === "skill"
          ? <Sparkles className="h-3.5 w-3.5 text-primary" />
          : reference.kind === "search"
            ? <Search className="h-3.5 w-3.5 text-muted-foreground" />
            : <Globe2 className="h-3.5 w-3.5 text-muted-foreground" />;
        const row = (
          <>
            {icon}
            <span className="min-w-0 flex-1 truncate">{reference.label}</span>
            <span className="shrink-0 text-micro text-muted-foreground">
              {reference.kind === "skill" ? "技能" : reference.kind === "search" ? "搜索" : "网页"}
            </span>
            {reference.kind !== "skill" ? <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
          </>
        );
        return (
          <li key={reference.id}>
            {reference.kind !== "skill" ? (
              <button
                type="button"
                title={reference.kind === "web" ? reference.url : reference.label}
                onClick={() => void openExternalUrl(
                  reference.kind === "web"
                    ? reference.url
                    : `https://www.bing.com/search?q=${encodeURIComponent(reference.label)}`,
                )}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-muted/35"
              >
                {row}
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-ui">{row}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function OverviewPanel({
  messages,
  deliverables,
  processArtifacts,
  taskPlan,
}: {
  messages: UIMessage[];
  deliverables: ReactNode;
  processArtifacts: ReactNode;
  taskPlan?: TaskPlanWsPayload;
}) {
  const todo = useMemo(() => collectOverviewTodo(messages, taskPlan), [messages, taskPlan]);
  const references = useMemo(() => collectOverviewReferences(messages), [messages]);
  return (
    <div className="scrollbar-hover h-full overflow-y-auto bg-card">
      <OverviewSection title="计划"><TodoList items={todo} /></OverviewSection>
      <OverviewSection title="交付物">{deliverables}</OverviewSection>
      <OverviewSection title="当前过程产物">{processArtifacts}</OverviewSection>
      <OverviewSection title="参考资料"><ReferenceList references={references} /></OverviewSection>
    </div>
  );
}
