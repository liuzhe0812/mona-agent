import { describe, expect, it } from "vitest";
import type { InlineWidgetData, UIMessage } from "./types";
import { finishPendingWidgets, upsertInlineWidgetMessage } from "./inline-widget-events";
import { isAgentActivityMember } from "@/components/thread/AgentActivityCluster";

const visual: InlineWidgetData = {
  id: "diagram", title: "流程图", code: "<svg />", loadingMessages: [], status: "streaming",
};

describe("inline widget messages", () => {
  it("updates in place between prose and stays outside collapsed activity", () => {
    const before: UIMessage = { id: "before", role: "assistant", content: "先看流程。", createdAt: 1 };
    const pending = upsertInlineWidgetMessage([before], visual, { taskId: "task", authorId: "mona" });
    const after: UIMessage = { id: "after", role: "assistant", content: "再看细节。", createdAt: 2 };
    const completed = upsertInlineWidgetMessage([...pending, after], {
      ...visual, code: "<svg><text>完整图形</text></svg>", status: "complete",
    }, { taskId: "task", authorId: "mona" });
    expect(completed.map((message) => message.id)).toEqual(["before", "widget:task:diagram", "after"]);
    expect(completed[1].widget?.code).toContain("完整图形");
    expect(isAgentActivityMember(pending[1])).toBe(false);
    expect(isAgentActivityMember(completed[1])).toBe(false);
    expect(upsertInlineWidgetMessage(completed, visual, { taskId: "task" })).toBe(completed);
  });

  it("isolates reused tool IDs across user tasks", () => {
    const first = upsertInlineWidgetMessage([], visual, { taskId: "first" });
    const second = upsertInlineWidgetMessage(first, visual, { taskId: "second" });
    expect(second).toHaveLength(2);
  });

  it("marks interrupted previews as failed without finalizing their scripts", () => {
    const pending = upsertInlineWidgetMessage([], visual, {});
    const finished = finishPendingWidgets(pending);
    expect(finished[0].isStreaming).toBe(false);
    expect(finished[0].widget?.status).toBe("error");
    expect(finished[0].widget?.error).toContain("中断");
  });
});
