import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  OverviewPanel,
  collectOverviewReferences,
  collectOverviewTodo,
} from "@/components/deliver/OverviewPanel";
import type { UIMessage } from "@/lib/types";

function message(overrides: Partial<UIMessage>): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("OverviewPanel", () => {
  it("renders plan, deliverables, process artifacts and references as flat modules", () => {
    render(
      <OverviewPanel
        messages={[]}
        deliverables={<div>delivered.png</div>}
        processArtifacts={<div>draft.py</div>}
      />,
    );

    expect(screen.getByRole("button", { name: "计划" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "交付物" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前过程产物" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "参考资料" })).toBeInTheDocument();
    expect(screen.getByText("AI 制定任务计划后会显示在这里。")).toBeInTheDocument();
    expect(screen.getByText("delivered.png")).toBeInTheDocument();
    expect(screen.getByText("draft.py")).toBeInTheDocument();
  });

  it("does not infer a plan from update_plan trace arguments", () => {
    const messages = [
      message({ role: "user", content: "new task" }),
      message({
        role: "tool",
        kind: "trace",
        toolEvents: [{ name: "update_plan", arguments: { plan: [{ step: "unconfirmed", status: "in_progress" }] } }],
      }),
    ];
    expect(collectOverviewTodo(messages)).toEqual([]);
  });

  it("prefers the authoritative backend plan snapshot over inferred tool history", () => {
    const messages = [message({
      toolEvents: [{ name: "update_plan", arguments: { plan: [{ step: "stale", status: "pending" }] } }],
    })];
    expect(collectOverviewTodo(messages, {
      task_id: "task-2",
      revision: 3,
      steps: [{ id: "verify", step: "Verify final output", status: "in_progress" }],
      source: "ai",
    })).toEqual([
      { id: "verify", text: "Verify final output", status: "in_progress" },
    ]);
  });

  it("restores the latest plan snapshot attached to assistant history", () => {
    const messages = [
      message({ role: "user", content: "new task" }),
      message({
        taskPlan: {
          task_id: "task-history",
          revision: 2,
          steps: [{ id: "deliver", step: "Deliver report", status: "completed" }],
          source: "ai",
        },
      }),
    ];
    expect(collectOverviewTodo(messages)).toEqual([
      { id: "deliver", text: "Deliver report", status: "completed" },
    ]);
  });

  it("does not present seeded prompt clauses as an AI plan", () => {
    const messages = [message({ role: "user", content: "重新生成，测试一下" })];
    expect(collectOverviewTodo(messages, {
      task_id: "task-seeded",
      revision: 1,
      steps: [
        { id: "one", step: "重新生成", status: "completed" },
        { id: "two", step: "测试一下", status: "skipped" },
      ],
      source: "legacy",
    })).toEqual([]);
  });

  it("collects and deduplicates skills, searches and web pages", () => {
    const messages = [message({
      toolEvents: [
        { name: "skill_read", arguments: { skill_name: "documents" } },
        { name: "web_search", arguments: { q: "Mona" } },
        { name: "web_fetch", arguments: { url: "https://example.com/report" } },
        { name: "web_fetch", arguments: { url: "https://example.com/report" } },
      ],
    })];

    expect(collectOverviewReferences(messages)).toEqual([
      { id: "skill:documents", kind: "skill", label: "documents" },
      { id: "search:Mona", kind: "search", label: "Mona" },
      { id: "web:https://example.com/report", kind: "web", label: "example.com", url: "https://example.com/report" },
    ]);
  });

  it("collects references from current-task progress traces only", () => {
    const messages = [
      message({ role: "user", content: "old" }),
      message({ toolEvents: [{ name: "web_fetch", arguments: { url: "https://old.example" } }] }),
      message({ role: "user", content: "new" }),
      message({
        role: "tool",
        kind: "trace",
        toolEvents: [
          { name: "skill_read", arguments: { name: "doc-writing-guide" } },
          { name: "web_fetch", arguments: { url: "https://github.com/trending" } },
        ],
      }),
    ];
    expect(collectOverviewReferences(messages)).toEqual([
      { id: "skill:doc-writing-guide", kind: "skill", label: "doc-writing-guide" },
      { id: "web:https://github.com/trending", kind: "web", label: "github.com", url: "https://github.com/trending" },
    ]);
  });

  it("keeps references when the user adds a follow-up to the same task", () => {
    const messages = [
      message({ role: "user", content: "build report", taskId: "task-report" }),
      message({ toolEvents: [{ name: "web_fetch", arguments: { url: "https://github.com/trending" } }] }),
      message({ role: "user", content: "only top five", taskId: "task-report" }),
      message({ toolEvents: [{ name: "skill_read", arguments: { name: "html-report" } }] }),
    ];
    expect(collectOverviewReferences(messages)).toEqual([
      { id: "web:https://github.com/trending", kind: "web", label: "github.com", url: "https://github.com/trending" },
      { id: "skill:html-report", kind: "skill", label: "html-report" },
    ]);
  });

  it("recovers a web reference from a legacy tool result without arguments", () => {
    const messages = [message({
      toolEvents: [{ name: "web_fetch", result: '{"url":"https://example.com/legacy"}' }],
    })];
    expect(collectOverviewReferences(messages)).toEqual([
      { id: "web:https://example.com/legacy", kind: "web", label: "example.com", url: "https://example.com/legacy" },
    ]);
  });
});
