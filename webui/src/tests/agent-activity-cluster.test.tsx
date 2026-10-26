import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import i18n from "@/i18n";
import type { UIMessage } from "@/lib/types";

function activityMessages(extraReasoning = "", extraTool?: UIMessage): UIMessage[] {
  const rows: UIMessage[] = [
    {
      id: "r1",
      role: "assistant",
      content: "",
      reasoning: `thinking${extraReasoning}`,
      reasoningStreaming: true,
      isStreaming: true,
      createdAt: 1,
    },
    {
      id: "t1",
      role: "tool",
      kind: "trace",
      content: "search()",
      traces: ["search()"],
      createdAt: 2,
    },
  ];
  if (extraTool) rows.push(extraTool);
  return rows;
}

function toolTraceMessage(
  id: string,
  calls: Array<{ name: string; arguments: Record<string, unknown>; phase?: string; error?: string }>,
  createdAt: number,
): UIMessage {
  const traces = calls.map(({ name, arguments: args }) => `${name}(${JSON.stringify(args)})`);
  return {
    id,
    role: "tool",
    kind: "trace",
    content: traces.join("\n"),
    traces,
    toolEvents: calls.map(({ name, arguments: args, phase, error }, index) => ({
      call_id: `${id}-${index}`,
      name,
      arguments: args,
      phase,
      error,
    })),
    createdAt,
  };
}

function installReducedMotion() {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
  };
}

describe("AgentActivityCluster", () => {
  function expectRenderedText(text: string): void {
    const matches = screen.getAllByText(text, { exact: true });
    expect(matches.some((element) => !element.closest('[aria-hidden="true"]'))).toBe(true);
  }

  it("shows elapsed seconds from the supplied run start while streaming", () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.UTC(2026, 9, 24, 8, 0, 0);
      vi.setSystemTime(startedAt);
      render(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming
          hasBodyBelow={false}
          runStartedAt={startedAt / 1000}
        />,
      );

      expectRenderedText("Working for 0s");
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expectRenderedText("Working for 1s");
      act(() => {
        vi.advanceTimersByTime(59_000);
      });
      expectRenderedText("Working for 1m 0s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the completed latency without continuing to count, and does not invent unknown history", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 24, 8, 0, 0));
      const { rerender } = render(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming={false}
          hasBodyBelow={false}
          latencyMs={468_000}
        />,
      );

      expectRenderedText("Worked for 7m 48s");
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expectRenderedText("Worked for 7m 48s");

      rerender(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming={false}
          hasBodyBelow={false}
        />,
      );
      expectRenderedText("Completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders elapsed and completed activity timing in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    vi.useFakeTimers();
    try {
      const now = Date.UTC(2026, 9, 24, 8, 0, 0);
      vi.setSystemTime(now);
      const runStartedAt = Math.floor(now / 1000) - 12;
      const { rerender } = render(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming
          hasBodyBelow={false}
          runStartedAt={runStartedAt}
        />,
      );

      expectRenderedText("已处理 12秒");
      rerender(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming
          hasBodyBelow={false}
          runStartedAt={Math.floor(now / 1000) - 75}
        />,
      );
      expectRenderedText("已处理 1分钟 15秒");

      rerender(
        <AgentActivityCluster
          messages={activityMessages()}
          isTurnStreaming={false}
          hasBodyBelow={false}
          latencyMs={468_000}
        />,
      );
      expectRenderedText("用时 7分钟 48秒");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps plain timing above a collapsible command and file group", async () => {
    const restoreMotion = installReducedMotion();
    try {
      const commandLine = 'exec_command({"cmd":"pnpm test"})';
      const absolutePath = "/Users/renxubin/project/src/app.tsx";
      render(
        <AgentActivityCluster
          messages={[{
            id: "t-activity",
            role: "tool",
            kind: "trace",
            content: commandLine,
            traces: [commandLine],
            toolEvents: [{
              call_id: "call-command",
              name: "exec_command",
              arguments: { cmd: "pnpm test" },
              phase: "end",
            }],
            fileEdits: [{
              call_id: "call-edit",
              tool: "edit_file",
              path: "src/app.tsx",
              absolute_path: absolutePath,
              phase: "end",
              added: 12,
              deleted: 3,
              approximate: false,
              status: "done",
            }],
            createdAt: 3,
          }]}
          isTurnStreaming={false}
          hasBodyBelow={false}
          latencyMs={468_000}
        />,
      );

      const timing = screen.getByText("Worked for 7m 48s");
      const group = screen.getByRole("button", { name: "Edited files and ran commands" });
      expect(timing.closest("button")).toBeNull();
      expect(timing.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("agent-activity-details")).not.toBeInTheDocument();

      fireEvent.click(group);
      expect(group).toHaveAttribute("aria-expanded", "true");
      const details = screen.getByTestId("agent-activity-details");
      expect(details).not.toHaveClass("border");
      expect(details).not.toHaveClass("rounded-md");
      expect(details).not.toHaveClass("bg-muted/25");
      expect(details).not.toHaveClass("max-h-52");
      expect(details).not.toHaveClass("overflow-y-auto");
      expect(details.querySelector(".overflow-y-auto")).toBeNull();

      const command = screen.getByRole("button", { name: "Ran command" });
      const fileStatus = screen.getByText("Edited");
      const fileRef = screen.getByTestId("activity-file-reference");
      expect(command).toHaveAttribute("aria-expanded", "false");
      expect(fileRef).toHaveTextContent("app.tsx");
      expect(fileRef).toHaveAttribute("aria-label", absolutePath);
      expect(fileRef.querySelector("svg")).toBeNull();
      expect(fileStatus.compareDocumentPosition(fileRef) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(fileRef.closest("li")).toHaveTextContent("Edited");
      await waitFor(() => {
        expect(screen.getAllByText("+12").length).toBeGreaterThan(0);
        expect(screen.getAllByText("-3").length).toBeGreaterThan(0);
      });

      fireEvent.click(group);
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("agent-activity-details")).not.toBeInTheDocument();
    } finally {
      restoreMotion();
    }
  });

  it("labels command and tool rows using their live, completed, and failed states", () => {
    const commandLine = 'exec_command({"cmd":"pnpm test"})';
    const toolLine = 'web_search({"query":"Mona"})';
    const makeActivity = (
      commandPhase: "start" | "end" | "error",
      toolPhase: "start" | "end" | "error",
      fileStatus: "editing" | "done" | "error",
    ): UIMessage[] => [{
      id: "t-status",
      role: "tool",
      kind: "trace",
      content: commandLine,
      traces: [commandLine, toolLine],
      toolEvents: [
        {
          call_id: "call-command",
          name: "exec_command",
          arguments: { cmd: "pnpm test" },
          phase: commandPhase,
          error: commandPhase === "error" ? "exit status 1" : undefined,
        },
        {
          call_id: "call-tool",
          name: "web_search",
          arguments: { query: "Mona" },
          phase: toolPhase,
          error: toolPhase === "error" ? "service unavailable" : undefined,
        },
      ],
      fileEdits: [{
        call_id: "call-edit",
        tool: "edit_file",
        path: "src/app.tsx",
        phase: fileStatus === "editing" ? "start" : fileStatus === "error" ? "error" : "end",
        added: 2,
        deleted: 1,
        approximate: false,
        status: fileStatus,
        error: fileStatus === "error" ? "patch failed" : undefined,
      }],
      createdAt: 3,
    }];
    const runStartedAt = Math.floor(Date.now() / 1000);
    const { rerender } = render(
      <AgentActivityCluster
        messages={makeActivity("start", "start", "editing")}
        isTurnStreaming
        runStartedAt={runStartedAt}
        hasBodyBelow={false}
      />,
    );

    const group = screen.getByRole("button", { name: "Edited files and ran commands" });
    fireEvent.click(group);
    expect(screen.getByText("Running command")).toBeInTheDocument();
    expect(screen.getByText("Using tool")).toBeInTheDocument();
    expect(screen.getByText("Editing")).toBeInTheDocument();

    rerender(
      <AgentActivityCluster
        messages={makeActivity("end", "end", "done")}
        isTurnStreaming={false}
        hasBodyBelow={false}
      />,
    );
    expect(screen.getByText("Ran command")).toBeInTheDocument();
    expect(screen.getByText("Used tool")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();

    rerender(
      <AgentActivityCluster
        messages={makeActivity("error", "error", "error")}
        isTurnStreaming={false}
        hasBodyBelow={false}
      />,
    );
    expect(screen.getByText("Command failed")).toBeInTheDocument();
    expect(screen.getByText("Tool failed")).toBeInTheDocument();
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  });

  it("merges same-phase calls across messages and expands every original call", async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage("en");
    try {
      const firstCalls = [
        { name: "web_search", arguments: { query: "alpha" }, phase: "start" },
        { name: "fetch_page", arguments: { url: "https://example.test/a" }, phase: "start" },
      ];
      const secondCalls = [
        { name: "fetch_page", arguments: { url: "https://example.test/b" }, phase: "start" },
      ];
      const { rerender } = render(
        <AgentActivityCluster
          messages={[
            toolTraceMessage("t-merge-1", firstCalls, 1),
            toolTraceMessage("t-merge-2", secondCalls, 2),
          ]}
          isTurnStreaming
          hasBodyBelow={false}
          showTiming={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      const merged = screen.getByRole("button", { name: "Using tools (3 calls)" });
      fireEvent.click(merged);

      const originalCalls = [...firstCalls, ...secondCalls].map(
        ({ name, arguments: args }) => `${name}(${JSON.stringify(args)})`,
      );
      const expandedCalls = screen.getByText((_content, element) => element?.tagName === "PRE");
      expect(expandedCalls.textContent).toBe(originalCalls.join("\n"));
      expect(merged.closest("li")?.querySelectorAll("button")).toHaveLength(1);

      const appendedCalls = [
        ...secondCalls,
        { name: "fetch_page", arguments: { url: "https://example.test/c" }, phase: "start" },
      ];
      rerender(
        <AgentActivityCluster
          messages={[
            toolTraceMessage("t-merge-1", firstCalls, 1),
            toolTraceMessage("t-merge-2", appendedCalls, 2),
          ]}
          isTurnStreaming
          hasBodyBelow={false}
          showTiming={false}
        />,
      );

      expect(screen.getByRole("button", { name: "Using tools (4 calls)" })).toBeInTheDocument();
      const updatedCalls = [...firstCalls, ...appendedCalls].map(
        ({ name, arguments: args }) => `${name}(${JSON.stringify(args)})`,
      );
      expect(expandedCalls.textContent).toBe(updatedCalls.join("\n"));
    } finally {
      await act(async () => i18n.changeLanguage(previousLanguage));
    }
  });

  it("keeps thinking, commands, progress, phase changes, and failures as group boundaries", async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage("en");
    try {
      render(
        <AgentActivityCluster
          messages={[
            toolTraceMessage("t-end-1", [{ name: "search", arguments: { q: "a" }, phase: "end" }], 1),
            toolTraceMessage("t-end-2", [{ name: "search", arguments: { q: "b" }, phase: "end" }], 2),
            {
              id: "r-boundary",
              role: "assistant",
              content: "",
              reasoning: "Compare the results before continuing.",
              createdAt: 3,
            },
            toolTraceMessage("t-after-thinking", [{ name: "search", arguments: { q: "c" }, phase: "end" }], 4),
            toolTraceMessage("t-phase-change", [{ name: "search", arguments: { q: "d" }, phase: "start" }], 5),
            toolTraceMessage("t-command", [{ name: "exec_command", arguments: { cmd: "pnpm test" }, phase: "end" }], 6),
            toolTraceMessage("t-after-command", [{ name: "search", arguments: { q: "e" }, phase: "end" }], 7),
            {
              id: "t-progress",
              role: "tool",
              kind: "trace",
              content: "Checking indexed sources",
              traces: ["Checking indexed sources"],
              createdAt: 8,
            },
            toolTraceMessage("t-after-progress", [{ name: "search", arguments: { q: "f" }, phase: "end" }], 9),
            toolTraceMessage("t-error-1", [{ name: "search", arguments: { q: "g" }, phase: "error", error: "failed" }], 10),
            toolTraceMessage("t-error-2", [{ name: "search", arguments: { q: "h" }, phase: "error", error: "failed" }], 11),
            toolTraceMessage("t-after-error", [{ name: "search", arguments: { q: "i" }, phase: "end" }], 12),
          ]}
          isTurnStreaming={false}
          hasBodyBelow={false}
          showTiming={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Ran commands" }));
      fireEvent.click(screen.getByRole("button", { name: "Thinking" }));

      expect(screen.getByText("Compare the results before continuing.")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Used tools 2 times" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Used tool" })).toHaveLength(4);
      expect(screen.getAllByRole("button", { name: "Using tool" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Ran command" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Checking indexed sources" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "Tool failed" })).toHaveLength(2);
    } finally {
      await act(async () => i18n.changeLanguage(previousLanguage));
    }
  });

  it("shows merged completed and running tool counts in Simplified Chinese", async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage("zh-CN");
    try {
      const completedCalls = [
        { name: "search", arguments: { q: "a" } },
        { name: "search", arguments: { q: "b" } },
      ];
      const { rerender } = render(
        <AgentActivityCluster
          messages={[toolTraceMessage("t-zh", completedCalls, 1)]}
          isTurnStreaming={false}
          hasBodyBelow={false}
          showTiming={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "处理过程" }));
      expect(screen.getByRole("button", { name: "使用了 2 次工具" })).toBeInTheDocument();

      rerender(
        <AgentActivityCluster
          messages={[toolTraceMessage("t-zh", completedCalls.map((call) => ({ ...call, phase: "start" })), 1)]}
          isTurnStreaming
          hasBodyBelow={false}
          showTiming={false}
        />,
      );
      expect(screen.getByRole("button", { name: "正在使用工具（2 次）" })).toBeInTheDocument();
    } finally {
      await act(async () => i18n.changeLanguage(previousLanguage));
    }
  });

  it("does not render zero diff counters for completed edits", () => {
    render(
      <AgentActivityCluster
        messages={activityMessages("", {
          id: "t2",
          role: "tool",
          kind: "trace",
          content: "edit_file()",
          traces: ["edit_file()"],
          fileEdits: [{
            call_id: "call-edit",
            tool: "edit_file",
            path: "src/app.tsx",
            phase: "end",
            added: 0,
            deleted: 0,
            approximate: false,
            status: "done",
          }],
          createdAt: 3,
        })}
        isTurnStreaming={false}
        hasBodyBelow={false}
      />,
    );

    expect(screen.getByRole("button", { name: /edited app\.tsx/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("-0")).not.toBeInTheDocument();
  });

  it("drops stale pathless pending edits after the turn completes", () => {
    render(
      <AgentActivityCluster
        messages={[{
          id: "t1",
          role: "tool",
          kind: "trace",
          content: "",
          traces: [],
          fileEdits: [{
            call_id: "call-edit",
            tool: "edit_file",
            path: "",
            phase: "start",
            added: 98,
            deleted: 0,
            approximate: true,
            status: "editing",
            pending: true,
          }],
          createdAt: 1,
        }]}
        isTurnStreaming={false}
        hasBodyBelow={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /preparing edit/i })).not.toBeInTheDocument();
    expect(screen.queryByText("+98")).not.toBeInTheDocument();
    expect(screen.queryByText("0 tool calls")).not.toBeInTheDocument();
  });

  it("renders pending file edit placeholders before the path is known", () => {
    render(
      <AgentActivityCluster
        messages={activityMessages("", {
          id: "t2",
          role: "tool",
          kind: "trace",
          content: "",
          traces: [],
          fileEdits: [{
            call_id: "call-edit",
            tool: "edit_file",
            path: "",
            phase: "start",
            added: 0,
            deleted: 0,
            approximate: true,
            status: "editing",
            pending: true,
          }],
          createdAt: 3,
        })}
        isTurnStreaming
        hasBodyBelow={false}
        runStartedAt={Math.floor(Date.now() / 1000)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /preparing edit/i }));
    expect(screen.getByText("Preparing file edit…")).toBeInTheDocument();
  });

  it("merges repeated edits for the same path and lets successful edits win over failures", async () => {
    const restoreMotion = installReducedMotion();
    try {
      render(
        <AgentActivityCluster
          messages={activityMessages("", {
            id: "t2",
            role: "tool",
            kind: "trace",
            content: "edit_file()",
            traces: ["edit_file()"],
            fileEdits: [
              {
                call_id: "call-edit-1",
                tool: "edit_file",
                path: "minecraft-fps/index.html",
                phase: "end",
                added: 2,
                deleted: 1,
                approximate: false,
                status: "done",
              },
              {
                call_id: "call-edit-2",
                tool: "edit_file",
                path: "minecraft-fps/index.html",
                phase: "error",
                added: 0,
                deleted: 0,
                approximate: false,
                status: "error",
                error: "patch failed",
              },
              {
                call_id: "call-edit-3",
                tool: "edit_file",
                path: "minecraft-fps/index.html",
                phase: "end",
                added: 6,
                deleted: 6,
                approximate: false,
                status: "done",
              },
            ],
            createdAt: 3,
          })}
          isTurnStreaming={false}
          hasBodyBelow={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /edited index\.html/i }));

      const fileRefs = screen.getAllByTestId("activity-file-reference");
      expect(fileRefs).toHaveLength(1);
      expect(fileRefs[0]).toHaveTextContent("index.html");
      expect(fileRefs[0]).toHaveAttribute("aria-label", "minecraft-fps/index.html");
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getAllByText("+8").length).toBeGreaterThan(0);
        expect(screen.getAllByText("-7").length).toBeGreaterThan(0);
      });
    } finally {
      restoreMotion();
    }
  });
});
