import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  buildDisplayUnits,
  ThreadMessages,
} from "@/components/thread/ThreadMessages";
import type { UIMessage } from "@/lib/types";

function visibleTextMatches(text: string | RegExp): HTMLElement[] {
  return screen.queryAllByText(text).filter((element) => !element.closest('[aria-hidden="true"]'));
}

describe("ThreadMessages", () => {
  it("keeps question previews in their original process position and folds them after completion", () => {
    const media = ["A", "B", "C"].map((name) => ({ kind: "image" as const, name, url: `https://example.com/${name}.jpg` }));
    const messages: UIMessage[] = [
      { id: "u", role: "user", content: "制作产品 PPT", createdAt: 1 },
      { id: "search", role: "tool", kind: "trace", content: "search()", traces: ["search()"], createdAt: 2 },
      { id: "previews", role: "tool", kind: "trace", content: "", traces: [], media, createdAt: 3 },
      { id: "write", role: "tool", kind: "trace", content: "office()", traces: ["office()"], createdAt: 4 },
      { id: "answer", role: "assistant", content: "PPT 已完成", createdAt: 5 },
    ];
    const { rerender } = render(<ThreadMessages messages={messages} isStreaming />);
    expect(screen.getByRole("img", { name: "A" })).toBeVisible();
    const units = buildDisplayUnits(messages);
    expect(units[1].type === "cluster" && units[1].messages.map((message) => message.id)).toEqual(["search", "previews", "write"]);
    rerender(<ThreadMessages messages={messages} isStreaming={false} />);
    expect(screen.queryByRole("img", { name: "A" })).not.toBeInTheDocument();
    expect(screen.getByText("PPT 已完成")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Expand process" }));
    const image = screen.getByRole("img", { name: "A" });
    expect(image).toBeVisible();
    expect(image.compareDocumentPosition(screen.getByText("PPT 已完成")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("groups consecutive reasoning and tool rows into one cluster before the answer", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "thinking",
        reasoningStreaming: false,
        isStreaming: true,
        createdAt: Date.now(),
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "search()",
        traces: ["search()"],
        createdAt: Date.now(),
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "more thinking",
        reasoningStreaming: false,
        isStreaming: true,
        createdAt: Date.now(),
      },
      {
        id: "a1",
        role: "assistant",
        content: "final answer",
        createdAt: Date.now(),
      },
    ];

    const { container } = render(
      <ThreadMessages messages={messages} isStreaming={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand process" }));
    const rows = Array.from(container.firstElementChild?.children ?? []);

    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveClass("mt-2", "mt-4", "mt-5");
    expect(rows[1]).toHaveClass("mt-1");
  });

  it("starts a new activity cluster when the activity segment changes", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first pass",
        activitySegmentId: "seg-1",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        fileEdits: [{
          call_id: "call-edit",
          tool: "edit_file",
          path: "foo.txt",
          phase: "end",
          added: 2,
          deleted: 1,
          status: "done",
        }],
        activitySegmentId: "seg-1",
        createdAt: 2,
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second pass",
        activitySegmentId: "seg-2",
        createdAt: 3,
      },
    ];

    const units = buildDisplayUnits(messages);

    expect(units).toHaveLength(2);
    expect(units[0].type === "cluster" ? units[0].messages.map((m) => m.id) : []).toEqual([
      "r1",
      "t1",
    ]);
    expect(units[1].type === "cluster" ? units[1].messages.map((m) => m.id) : []).toEqual([
      "r2",
    ]);
  });

  it("does not split ordinary tool activity just because segment ids changed", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first pass",
        activitySegmentId: "seg-1",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "read_file()",
        traces: ["read_file()"],
        activitySegmentId: "seg-1",
        createdAt: 2,
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second pass",
        activitySegmentId: "seg-2",
        createdAt: 3,
      },
      {
        id: "t2",
        role: "tool",
        kind: "trace",
        content: "grep()",
        traces: ["grep()"],
        activitySegmentId: "seg-2",
        createdAt: 4,
      },
    ];

    const units = buildDisplayUnits(messages);

    expect(units).toHaveLength(1);
    expect(units[0].type === "cluster" ? units[0].messages.map((m) => m.id) : []).toEqual([
      "r1",
      "t1",
      "r2",
      "t2",
    ]);
  });

  it("only marks the current activity cluster as live while streaming", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first pass",
        reasoningStreaming: true,
        activitySegmentId: "seg-1",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        fileEdits: [{
          call_id: "call-edit",
          tool: "edit_file",
          path: "foo.txt",
          phase: "start",
          added: 4,
          deleted: 1,
          approximate: true,
          status: "editing",
        }],
        activitySegmentId: "seg-1",
        createdAt: 2,
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second pass",
        reasoningStreaming: true,
        activitySegmentId: "seg-2",
        createdAt: 3,
      },
      {
        id: "t2",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        fileEdits: [{
          call_id: "call-edit-2",
          tool: "edit_file",
          path: "bar.txt",
          phase: "start",
          added: 4,
          deleted: 1,
          approximate: true,
          status: "editing",
        }],
        activitySegmentId: "seg-2",
        createdAt: 4,
      },
    ];

    render(
      <ThreadMessages
        messages={messages}
        isStreaming
        runStartedAt={Math.floor(Date.now() / 1000)}
      />,
    );

    expect(screen.getByRole("button", { name: /edited foo\.txt/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /editing bar\.txt/i })).toBeInTheDocument();
  });

  it("passes a completed assistant turn duration to the preceding activity cluster", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "search plan",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "web_search()",
        traces: ["web_search()"],
        createdAt: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "final answer",
        createdAt: 3,
        latencyMs: 468_000,
      },
    ];

    render(<ThreadMessages messages={messages} isStreaming={false} />);

    expect(visibleTextMatches("Worked for 7m 48s")).toHaveLength(1);
  });

  it("keeps the activity cluster immediately before a streaming final answer live", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "search plan",
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "web_search()",
        traces: ["web_search()"],
        createdAt: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "partial final answer",
        isStreaming: true,
        createdAt: 3,
      },
    ];

    const runStartedAt = Math.floor(Date.now() / 1000) - 12;
    render(
      <ThreadMessages
        messages={messages}
        isStreaming
        runStartedAt={runStartedAt}
      />,
    );

    expect(visibleTextMatches(/^Working for \d+s$/)).toHaveLength(1);
  });

  it("shows one timing header for multiple activity clusters in a user task", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "Inspect and update the project.",
        createdAt: 1,
      },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first pass",
        activitySegmentId: "segment-1",
        createdAt: 2,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        activitySegmentId: "segment-1",
        fileEdits: [{
          call_id: "edit-1",
          tool: "edit_file",
          path: "src/first.ts",
          phase: "end",
          added: 1,
          deleted: 0,
          approximate: false,
          status: "done",
        }],
        createdAt: 3,
      },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second pass",
        activitySegmentId: "segment-2",
        createdAt: 4,
      },
      {
        id: "t2",
        role: "tool",
        kind: "trace",
        content: "edit_file()",
        traces: ["edit_file()"],
        activitySegmentId: "segment-2",
        fileEdits: [{
          call_id: "edit-2",
          tool: "edit_file",
          path: "src/second.ts",
          phase: "end",
          added: 2,
          deleted: 0,
          approximate: false,
          status: "done",
        }],
        createdAt: 5,
      },
      {
        id: "a1",
        role: "assistant",
        content: "The update is ready.",
        isStreaming: true,
        createdAt: 6,
      },
    ];

    const runStartedAt = Math.floor(Date.now() / 1000) - 12;
    render(
      <ThreadMessages
        messages={messages}
        isStreaming
        runStartedAt={runStartedAt}
      />,
    );

    expect(visibleTextMatches(/^Working for \d+s$/)).toHaveLength(1);
  });

  it("folds final answer reasoning into the preceding activity cluster", () => {
    const messages: UIMessage[] = [
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "search plan",
        reasoningStreaming: false,
        createdAt: 1,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "web_search()",
        traces: ["web_search()"],
        createdAt: 2,
      },
      {
        id: "a1",
        role: "assistant",
        content: "final answer",
        reasoning: "summarize results",
        reasoningStreaming: false,
        createdAt: 3,
      },
    ];

    const units = buildDisplayUnits(messages);

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ type: "cluster" });
    expect(units[0].type === "cluster" ? units[0].messages.map((m) => m.id) : []).toEqual([
      "r1",
      "t1",
      "a1-reasoning",
    ]);
    expect(units[1]).toMatchObject({
      type: "single",
      message: {
        id: "a1",
        content: "final answer",
      },
    });
    if (units[1].type === "single") {
      expect(units[1].message).not.toHaveProperty("reasoning");
    }

    render(<ThreadMessages messages={messages} isStreaming={false} />);
    expect(screen.queryByRole("button", { name: /^thinking$/i })).not.toBeInTheDocument();
    expect(screen.getByText("final answer")).toBeInTheDocument();
  });

  it("folds completed task processing while keeping the final answer visible", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "Inspect this project.", createdAt: 1 },
      { id: "progress", role: "assistant", content: "Intermediate update", createdAt: 2 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "review the project",
        createdAt: 3,
      },
      {
        id: "t1",
        role: "tool",
        kind: "trace",
        content: "inspect()",
        traces: ["inspect()"],
        createdAt: 4,
      },
      { id: "a1", role: "assistant", content: "Final answer", createdAt: 5 },
    ];

    const { rerender } = render(
      <ThreadMessages messages={messages} isStreaming={false} />,
    );

    expect(screen.getByRole("button", { name: "Expand process" })).toHaveTextContent("Completed");
    expect(screen.queryByText("Expand process", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Intermediate update")).not.toBeInTheDocument();
    expect(screen.getByText("Final answer")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Completed"));
    expect(screen.getByText("Intermediate update")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse process" }));
    expect(screen.queryByText("Intermediate update")).not.toBeInTheDocument();
    rerender(
      <ThreadMessages
        messages={messages}
        isStreaming={false}
        focusMessage={{ id: "progress", requestId: 1 }}
      />,
    );
    expect(screen.getByText("Intermediate update")).toBeInTheDocument();
  });

  it("automatically folds on completion and expands again when the same task runs", () => {
    const base: UIMessage[] = [
      { id: "u1", role: "user", content: "Run the task.", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "working through it",
        createdAt: 2,
      },
      { id: "progress", role: "assistant", content: "Still working", createdAt: 3 },
    ];
    const running: UIMessage[] = [
      ...base,
      {
        id: "a1",
        role: "assistant",
        content: "Partial answer",
        isStreaming: true,
        createdAt: 4,
      },
    ];
    const completed: UIMessage[] = [
      ...base,
      { id: "a1", role: "assistant", content: "Completed answer", createdAt: 4 },
    ];

    const { rerender } = render(
      <ThreadMessages messages={running} isStreaming runStartedAt={1} />,
    );
    expect(screen.getByText("Still working")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse process" }));
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand process" }));
    expect(screen.getByText("Still working")).toBeInTheDocument();

    rerender(<ThreadMessages messages={completed} isStreaming={false} />);
    expect(screen.queryByText("Still working")).not.toBeInTheDocument();
    expect(screen.getByText("Completed answer")).toBeInTheDocument();

    rerender(
      <ThreadMessages messages={running} isStreaming runStartedAt={5} />,
    );
    expect(screen.getByText("Still working")).toBeInTheDocument();
  });

  it("shows actions only on the completed answer, including when the process is expanded", async () => {
    const running: UIMessage[] = [
      { id: "u1", role: "user", content: "Start the task", createdAt: 1 },
      { id: "p1", role: "assistant", content: "First update", createdAt: 2 },
      { id: "injected", role: "user", content: "Add this detail", isInjected: true, createdAt: 3 },
      { id: "p2", role: "assistant", content: "Second update", createdAt: 4 },
      { id: "t1", role: "tool", kind: "trace", content: "inspect()", traces: ["inspect()"], createdAt: 5 },
      { id: "a1", role: "assistant", content: "Partial answer", isStreaming: true, createdAt: 6 },
    ];
    const completed: UIMessage[] = [
      ...running.slice(0, -1),
      { id: "a1", role: "assistant", content: "Final answer", createdAt: 6 },
    ];
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      const { rerender } = render(<ThreadMessages messages={running} isStreaming runStartedAt={1} />);
      expect(screen.getByText("First update")).toBeInTheDocument();
      expect(screen.getByText("Second update")).toBeInTheDocument();
      expect(screen.getByText("Add this detail")).toBeInTheDocument();
      expect(screen.getByText("Partial answer")).toBeInTheDocument();
      expect(screen.queryByTestId("direct-message-actions")).not.toBeInTheDocument();

      rerender(<ThreadMessages messages={completed} isStreaming={false} />);
      expect(screen.getAllByTestId("direct-message-actions")).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Expand process" }));
      for (const id of ["p1", "p2"]) {
        expect(within(screen.getByTestId(`message-bubble-${id}`)).queryByTestId("direct-message-actions")).not.toBeInTheDocument();
      }
      const finalReply = screen.getByTestId("message-bubble-a1");
      expect(within(finalReply).getByTestId("direct-message-actions")).toBeInTheDocument();
      expect(screen.getAllByTestId("direct-message-actions")).toHaveLength(1);
      fireEvent.click(within(finalReply).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(copy).toHaveBeenCalledWith("Final answer"));
    } finally {
      copy.mockRestore();
    }
  });

  it("keeps earlier completed actions while the next task has only progress or a streaming reply", () => {
    const running: UIMessage[] = [
      { id: "u1", role: "user", content: "First request", createdAt: 1 },
      { id: "a1", role: "assistant", content: "First answer", createdAt: 2 },
      { id: "u2", role: "user", content: "Second request", createdAt: 3 },
      { id: "p2", role: "assistant", content: "Second update", createdAt: 4 },
      { id: "t2", role: "tool", kind: "trace", content: "inspect()", traces: ["inspect()"], createdAt: 5 },
    ];
    const { rerender } = render(<ThreadMessages messages={running} isStreaming runStartedAt={1} />);
    const firstReply = screen.getByTestId("message-bubble-a1");
    expect(within(firstReply).getByTestId("direct-message-actions")).toBeInTheDocument();
    expect(within(screen.getByTestId("message-bubble-p2")).queryByTestId("direct-message-actions")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("direct-message-actions")).toHaveLength(1);

    const partial: UIMessage = { id: "a2", role: "assistant", content: "Partial answer", isStreaming: true, createdAt: 6 };
    rerender(<ThreadMessages messages={[...running, partial]} isStreaming runStartedAt={1} />);
    expect(within(screen.getByTestId("message-bubble-a2")).queryByTestId("direct-message-actions")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("direct-message-actions")).toHaveLength(1);

    const answer: UIMessage = { ...partial, content: "Second answer", isStreaming: false };
    rerender(<ThreadMessages messages={[...running, answer]} isStreaming={false} />);
    expect(within(screen.getByTestId("message-bubble-a1")).getByTestId("direct-message-actions")).toBeInTheDocument();
    expect(within(screen.getByTestId("message-bubble-a2")).getByTestId("direct-message-actions")).toBeInTheDocument();
    expect(screen.getAllByTestId("direct-message-actions")).toHaveLength(2);
  });

  it("keeps process controls independent across user tasks and preserves injected messages and deliveries", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "First request", createdAt: 1 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "first task reasoning",
        createdAt: 2,
      },
      { id: "p1", role: "assistant", content: "First internal update", createdAt: 3 },
      {
        id: "injected",
        role: "user",
        content: "Add this detail",
        isInjected: true,
        createdAt: 4,
      },
      {
        id: "delivery",
        role: "assistant",
        content: "Files and media",
        deliveredFiles: [{
          path: "summary.txt",
          absolute_path: "/workspace/summary.txt",
          name: "summary.txt",
          size: 8,
          size_human: "8 B",
          mime: "text/plain",
        }],
        media: [{ kind: "file", name: "report.csv", url: "data:text/csv,a,b" }],
        createdAt: 5,
      },
      {
        id: "widget-message",
        role: "assistant",
        kind: "widget",
        content: "",
        widget: {
          id: "widget-1",
          title: "Preview title",
          code: "document.body.textContent = 'ready';",
          loadingMessages: [],
          status: "complete",
        },
        createdAt: 6,
      },
      { id: "a1", role: "assistant", content: "First answer", createdAt: 7 },
      { id: "u2", role: "user", content: "Second request", createdAt: 8 },
      {
        id: "r2",
        role: "assistant",
        content: "",
        reasoning: "second task reasoning",
        createdAt: 9,
      },
      { id: "p2", role: "assistant", content: "Second internal update", createdAt: 10 },
      { id: "a2", role: "assistant", content: "Second answer", createdAt: 11 },
    ];

    const { rerender } = render(
      <ThreadMessages messages={messages} isStreaming={false} />,
    );

    expect(screen.getAllByRole("button", { name: "Expand process" })).toHaveLength(2);
    expect(screen.getByText("First request")).toBeInTheDocument();
    expect(screen.getByText("Add this detail")).toBeInTheDocument();
    expect(screen.getByText("Second request")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summary\.txt/ })).toBeInTheDocument();
    expect(screen.getByText("report.csv")).toBeInTheDocument();
    expect(screen.getByTitle("Preview title")).toBeInTheDocument();
    expect(screen.queryByText("First internal update")).not.toBeInTheDocument();
    expect(screen.queryByText("Second internal update")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Expand process" })[0]);
    expect(screen.getByText("First internal update")).toBeInTheDocument();
    expect(screen.queryByText("Second internal update")).not.toBeInTheDocument();

    const withPlainTask: UIMessage[] = [
      ...messages,
      { id: "u3", role: "user", content: "Third request", createdAt: 12 },
      { id: "a3", role: "assistant", content: "Third plain reply", createdAt: 13 },
    ];
    rerender(<ThreadMessages messages={withPlainTask} isStreaming={false} />);

    expect(screen.getByText("First internal update")).toBeInTheDocument();
    expect(screen.queryByText("Second internal update")).not.toBeInTheDocument();
    expect(screen.getByText("Third plain reply")).toBeInTheDocument();
  });

  it("keeps the existing expanded process display in group chats", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", content: "Group request", createdAt: 1 },
      { id: "p1", role: "assistant", content: "Group progress", createdAt: 2 },
      {
        id: "r1",
        role: "assistant",
        content: "",
        reasoning: "group reasoning",
        createdAt: 3,
      },
      { id: "a1", role: "assistant", content: "Group answer", createdAt: 4 },
    ];

    render(<ThreadMessages messages={messages} isStreaming={false} isGroupChat />);

    expect(screen.getByText("Group progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand process" })).not.toBeInTheDocument();
  });

});
