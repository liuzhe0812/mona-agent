import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DevCollaboration, DevEvent, DevMessage, DevRun } from "@/lib/development-api";
import { TooltipProvider } from "./zcode/primitives/tooltip";
import { DevelopmentTranscript, pairTranscriptTools, nativeTimeline } from "./DevelopmentTranscript";
import { DevelopmentActivity, DevelopmentWorkItems, developmentActivity } from "./DevelopmentActivity";
import { DevelopmentStreamContext } from "./DevelopmentStreamContext";
import { buildAssistantWorkRenderItems } from "./zcode/tools/conversationAssistantWorkItems";
import type { WorkRow } from "./zcode/types";

vi.mock("./zcode/markdown", () => ({ ZCodeMarkdown: ({ children }: { children: string }) => <div>{children}</div> }));
afterEach(cleanup);
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
const message = (id: string, patch: Partial<DevMessage> = {}): DevMessage => ({ id, role: "assistant", content: "", toolCalls: [], queued: false, truncated: false, runId: "run_a", ...patch });
const call = { id: "call_a", function: { name: "read_file", arguments: '{"path":"src/main.ts"}' } };
const run: DevRun = { id: "run_a", sessionId: "dev_a", executor: "mona", status: "running", revision: 1, createdAt: "2026-09-25T00:00:00Z" };
const event = (id: string, type: string, payload: Record<string, unknown>, runId = "run_a"): DevEvent => ({ id, sequence: Number(id.replace(/\D/g, "")) || 1, type, runId, payload });

describe("development transcript", () => {
  it("keeps queued inputs out of the transcript until they are delivered", () => {
    const initial = message("request", { role: "user", content: "执行当前任务" });
    const queued = message("queued", { role: "user", content: "怎么卡住了", queued: true, runId: undefined });
    const view = render(<DevelopmentTranscript messages={[initial, queued]} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(screen.getByText("执行当前任务")).toBeVisible();
    expect(screen.queryByText("怎么卡住了")).toBeNull();
    expect(screen.queryByText("后续消息")).toBeNull();

    view.rerender(<DevelopmentTranscript messages={[initial, { ...queued, id: "guided", queued: false, sourceKind: "steering", runId: run.id }]}
      events={[]} runs={[run]} sessionId="dev_a" />);
    expect(screen.getAllByText("怎么卡住了")).toHaveLength(1);
    expect(screen.getByText("怎么卡住了")).toBeVisible();
    expect(screen.queryByText("后续消息")).toBeNull();
  });
  it("shows an expired confirmation as a status without empty parameters or internal JSON", () => {
    const activity = developmentActivity([event("e_expired", "decision.expired", { decisionId: "decision_expired" })], run.id)[0];
    const rows: WorkRow[] = [{ rowId: "expired", kind: "toolCall", activity }];
    const { container } = render(<DevelopmentWorkItems rows={rows} items={buildAssistantWorkRenderItems(rows)} running={false} />);
    expect(screen.getByText("确认已失效")).toBeVisible();
    expect(container.querySelector('[data-marker-type="decision"]')).toHaveAttribute("data-status", "failed");
    expect(screen.queryByText(/Parameters|调用参数/)).toBeNull();
    expect(container.textContent).not.toMatch(/decisionId|decision_expired|\{\}|Decision/);
    expect(container.querySelector("pre")).toBeNull();
  });
  it.each(["development_collaboration", "mcp__mona_development__development_collaboration"])("labels native host tool %s without leaking transport names", (name) => {
    const rows = developmentActivity([event("e1", "tool.started", { itemId: "host-call", name }), event("e2", "tool.completed", { itemId: "host-call", content: "actual result", isError: false })], run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: "子智能体协作", output: "actual result", state: "returned" });
  });
  it("folds long user evidence without truncating history or the expanded content", () => {
    const text = "资料开头。" + "完整资料，不改变历史。".repeat(140) + "END_SENTINEL";
    const row = message("long-evidence", { role: "user", content: text });
    const original = JSON.stringify(row);
    const { container } = render(<DevelopmentTranscript messages={[row]} events={[]} runs={[run]} sessionId="dev_a" />);
    const details = container.querySelector('article[data-message-id="long-evidence"] details')!;
    expect(details).not.toHaveAttribute("open");
    expect(details.querySelector("summary")).toHaveAttribute("aria-label", "长消息详情");
    expect(screen.getByText("展开完整内容")).toBeInTheDocument();
    expect(details.textContent).toContain("END_SENTINEL");
    details.setAttribute("open", "");
    expect(screen.getByText(text)).toBeVisible();
    expect(JSON.stringify(row)).toBe(original);
  });
  it("keeps long collaboration evidence inside folded execution history without truncating it", () => {
    const text = "完整协作资料。".repeat(160) + "END_SENTINEL";
    const row = message("long-collaboration", { sourceKind: "collaboration", content: text });
    const original = JSON.stringify(row);
    const completed: DevRun = { ...run, status: "succeeded", startedAt: run.createdAt,
      finishedAt: "2026-09-25T00:00:10Z", resultMessageId: "final-reply" };
    render(<DevelopmentTranscript messages={[row, message("final-reply", { content: "最终回答" })]}
      events={[]} runs={[completed]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText("最终回答")).toBeVisible();
    expect(screen.queryByText(text)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "工作过程" }));
    expect(screen.getByText(text)).toBeVisible();
    expect(JSON.stringify(row)).toBe(original);
  });
  it("keeps ordinary assistant answers expanded regardless of length", () => {
    const text = "解释与结论。".repeat(260);
    const { container } = render(<DevelopmentTranscript messages={[message("answer", { content: text })]} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(container.querySelector("article details")).toBeNull();
    expect(screen.getByText(text)).toBeVisible();
  });
  it("offers forking only for the successful run's final assistant body and returns through its source marker", () => {
    const completed = { ...run, status: "succeeded" as const, resultMessageId: "final" };
    const messages = [message("earlier", { content: "较早回复" }), message("final", { content: "最终回复" }),
      message("legacy", { content: "无运行记录的旧消息", runId: undefined })];
    const source = { sourceSessionId: "dev_parent", sourceMessageId: "final", sourceTitle: "实现登录", requestId: "fork_source", messageCount: 2 };
    const onFork = vi.fn().mockResolvedValue(undefined);
    const onReturnToForkSource = vi.fn();
    const view = render(<TooltipProvider><DevelopmentTranscript messages={messages} events={[]} runs={[completed]} sessionId="dev_a"
      canFork onFork={onFork} onForkError={vi.fn()} forkSource={source} onReturnToForkSource={onReturnToForkSource} /></TooltipProvider>);

    expect(view.getByTestId("v4-fork-final")).toBeInTheDocument();
    expect(view.queryByTestId("v4-fork-earlier")).toBeNull();
    expect(view.queryByTestId("v4-fork-legacy")).toBeNull();
    const text = view.container.textContent!;
    expect(text.indexOf("最终回复")).toBeLessThan(text.indexOf("从对话中派生"));
    expect(text.indexOf("从对话中派生")).toBeLessThan(text.indexOf("无运行记录的旧消息"));
    fireEvent.click(screen.getByRole("button", { name: "从对话中派生" }));
    expect(onReturnToForkSource).toHaveBeenCalledWith("dev_parent");

    view.rerender(<TooltipProvider><DevelopmentTranscript messages={messages} events={[]} runs={[{ ...completed, resultMessageId: undefined }]} sessionId="dev_a"
      canFork onFork={onFork} onForkError={vi.fn()} forkSource={{ ...source, sourceMessageId: "not-loaded" }} /></TooltipProvider>);
    expect(view.getByTestId("v4-fork-final")).toBeInTheDocument();
    expect(view.queryByTestId("v4-fork-earlier")).toBeNull();
    expect(screen.queryByRole("button", { name: "从对话中派生" })).toBeNull();
  });
  it.each([["grep", "检索代码内容"], ["find_files", "定位项目文件"], ["load_coding_tools", "加载开发能力"]])("labels the Code capability %s in the user's language", (name, label) => {
    const tool = { id: "new_tool", function: { name, arguments: "{}" } };
    render(<DevelopmentTranscript messages={[message("assistant", { toolCalls: [tool] })]} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(screen.getByTitle(label)).toBeInTheDocument();
    expect(screen.queryByText(name, { exact: true })).not.toBeInTheDocument();
  });
  it("joins a tool result only by run and call identity, leaving orphan history visible", () => {
    const messages = [message("assistant", { toolCalls: [call] }),
      message("other-run", { role: "tool", runId: "run_b", toolCallId: call.id, content: "other" }),
      message("legacy", { role: "tool", name: "read_file", content: "legacy" }),
      message("result", { role: "tool", toolCallId: call.id, content: "actual result" })];
    const paired = pairTranscriptTools(messages);
    expect(paired.messages.map((item) => item.id)).toEqual(["assistant", "other-run", "legacy"]);
    expect([...paired.results.values()].map((item) => item.id)).toEqual(["result"]);
    render(<DevelopmentTranscript messages={messages} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(paired.results.get(JSON.stringify(["run_a", call.id]))?.content).toBe("actual result");
    expect(screen.getByText("other")).toBeInTheDocument();
    expect(screen.getByText("legacy")).toBeInTheDocument();
    expect(screen.getByText("main.ts")).toBeInTheDocument();
  });
  it("does not turn returned tool text into a success or claim unknown calls are running", () => {
    const messages = [message("assistant", { toolCalls: [call] }), message("result", { role: "tool", toolCallId: call.id, content: "Error: file missing" })];
    const view = render(<DevelopmentTranscript messages={messages} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(view.container.querySelector(".animated-gradient-text")).toBeNull();
    expect(screen.queryByText("成功", { exact: true })).not.toBeInTheDocument();
    view.rerender(<DevelopmentTranscript messages={messages.slice(0, 1)} events={[]} runs={[{ ...run, status: "unknown" }]} sessionId="dev_a" />);
    expect(screen.queryByText("执行中", { exact: true })).not.toBeInTheDocument();
  });
  it("keeps the upstream active tool presentation and stops it once the run is interrupted", () => {
    const messages = [message("assistant", { toolCalls: [call] })];
    const view = render(<DevelopmentTranscript messages={messages} events={[]} runs={[run]} sessionId="dev_a" />);
    expect(view.container.querySelector(".animated-gradient-text")).not.toBeNull();
    view.rerender(<DevelopmentTranscript messages={messages} events={[event("e1", "tools.started", { tools: [{ id: call.id, name: "read_file" }] })]} runs={[run]} sessionId="dev_a" />);
    expect(view.container.querySelector(".animated-gradient-text")).not.toBeNull();
    view.rerender(<DevelopmentTranscript messages={messages} events={[]} runs={[{ ...run, status: "interrupted" }]} sessionId="dev_a" />);
    expect(view.container.querySelector(".animated-gradient-text")).toBeNull();
  });
});

describe("native timeline", () => {
  it("does not append empty historical runs after the live turn or remount expanded history when older messages load", () => {
    const native = { ...run, executor: "codex" as const, status: "succeeded" as const, finishedAt: "2026-09-25T00:00:38Z" };
    const events = [event("e1", "command.completed", { id: "cmd", command: "npm test", exitCode: 0 }), event("e2", "agent.message.completed", { messageId: "answer" })];
    const messages = [message("answer", { content: "最终回复" })];
    const historical = { ...native, id: "older", createdAt: "2026-09-24T00:00:00Z" };
    const view = render(<DevelopmentTranscript messages={messages} events={events} runs={[native, historical]} sessionId="dev_a" showRunHeaders />);
    fireEvent.click(screen.getByRole("button", { name: "工作过程" }));
    const header = screen.getByRole("button", { name: "工作过程" });
    view.rerender(<DevelopmentTranscript messages={[message("old", { runId: "older", content: "较早回复" }), ...messages]} events={events} runs={[native, historical]} sessionId="dev_a" showRunHeaders />);
    expect(header).toBeInTheDocument();
    expect(header).toHaveAttribute("aria-expanded", "true");
    view.rerender(<DevelopmentTranscript messages={messages} events={events} runs={[{ ...native, status: "running" }, historical]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getAllByRole("status", { name: "加载中..." })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "工作过程" })).toHaveLength(1);
  });
  it("shows the work header and a single loading mark before the first response", () => {
    const view = render(<DevelopmentTranscript messages={[]} events={[]} runs={[{ ...run, executor: "codex" }]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText(/^工作中/)).toBeVisible();
    expect(screen.getAllByRole("status", { name: "加载中..." })).toHaveLength(1);
    view.rerender(<DevelopmentTranscript messages={[]} events={[]} runs={[{ ...run, status: "waiting_user" }]} sessionId="dev_a" showRunHeaders />);
    expect(screen.queryByRole("status", { name: "加载中..." })).not.toBeInTheDocument();
  });
  it("does not show model-loading activity while the leader is waiting for required children", () => {
    const waiting: DevRun = { ...run, executor: "codex", status: "waiting_children" };
    const view = render(<DevelopmentTranscript messages={[]} events={[]} runs={[waiting]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText(/^等待子任务/)).toBeVisible();
    expect(screen.queryByRole("status", { name: "加载中..." })).not.toBeInTheDocument();
    view.rerender(<DevelopmentTranscript messages={[message("waiting_answer", { content: "已派发审查，等待结果。" })]}
      events={[]} runs={[waiting]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText("已派发审查，等待结果。")).toBeVisible();
    expect(screen.queryByRole("status", { name: "加载中..." })).not.toBeInTheDocument();
  });
  it("uses the parent run's waiting status for folded history with an answer and tool call", () => {
    const waiting: DevRun = { ...run, executor: "codex", status: "waiting_children" };
    const answer = message("waiting_answer", {
      content: "审查已完成，仍在等待子任务结果。",
      toolCalls: [call],
    });
    const view = render(<DevelopmentTranscript messages={[answer]} events={[]} runs={[waiting]} sessionId="dev_a" showRunHeaders />);

    const header = screen.getByRole("button", { name: "工作过程" });
    expect(header).toHaveTextContent(/^等待子任务/);
    expect(header).not.toHaveTextContent(/工作中/);
    expect(screen.getByText(answer.content)).toBeVisible();
    fireEvent.click(header);
    expect(screen.getByText("main.ts")).toBeVisible();
  });
  it.each(["mona", "codex", "claude", "codebuddy"])("keeps %s reasoning, tools and text in source order, then folds history above the final response", (executor) => {
    const native = { ...run, executor: executor as DevRun["executor"] };
    const events = [event("e1", "reasoning.started", { itemId: "thought" }), event("e2", "reasoning.completed", { itemId: "thought", text: "检查项目结构", durationMs: 1500 }),
      event("e3", "command.started", { id: "cmd", command: "npm test" }), event("e4", "command.completed", { id: "cmd", exitCode: 0 }),
      event("e5", "agent.message.delta", { messageId: "answer" })];
    const messages = [message("answer", { content: "最终回复" })];
    const view = render(<DevelopmentTranscript messages={messages} events={events} runs={[native]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText("持续了 2 秒")).toBeVisible();
    const text = view.container.textContent!;
    expect(text.indexOf("持续了")).toBeLessThan(text.indexOf("npm test"));
    expect(text.indexOf("npm test")).toBeLessThan(text.indexOf("最终回复"));
    view.rerender(<DevelopmentTranscript messages={messages} events={[...events, event("e6", "agent.message.completed", { messageId: "answer" })]} runs={[{ ...native, status: "succeeded", finishedAt: "2026-09-25T00:00:38Z" }]} sessionId="dev_a" showRunHeaders />);
    expect(screen.getByText("已工作 38 秒")).toBeVisible();
    expect(screen.queryByText("持续了 2 秒")).not.toBeInTheDocument();
    expect(screen.getByText("最终回复")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "工作过程" }));
    expect(screen.getByText("持续了 2 秒")).toBeVisible();
  });
  it("preserves an expanded read group when streaming appends more calls and never drops early operations", () => {
    const reads = Array.from({ length: 35 }, (_, i) => event(`e${i + 1}`, "tool.started", { itemId: `read-${i}`, name: "Read", arguments: { file_path: `file-${i}.ts` } }));
    const native = { ...run, executor: "claude" as const };
    const view = render(<DevelopmentTranscript messages={[]} events={reads.slice(0, 2)} runs={[native]} sessionId="dev_a" showRunHeaders />);
    const group = view.container.querySelector<HTMLElement>("[data-activity-group]")!;
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    view.rerender(<DevelopmentTranscript messages={[]} events={reads} runs={[native]} sessionId="dev_a" showRunHeaders />);
    expect(view.container.querySelector("[data-activity-group]")).toBe(group);
    expect(screen.getByRole("button", { name: "收起工具详情" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("35 文件")).toBeVisible();
    expect(screen.getByText("file-0.ts")).toBeVisible();
    expect(group.querySelectorAll("[data-testid^=tool-summary-trigger]")).toHaveLength(36);
  });
  it("places commands between exact message events and only streams incomplete native text", () => {
    const messages = [message("first", { content: "先检查文件", authorId: "codex" }), message("last", { content: "修改完成", authorId: "codex" })];
    const events = [event("e1", "agent.message.completed", { messageId: "first" }), event("e2", "command.started", { id: "cmd", command: "pytest" }), event("e3", "command.completed", { id: "cmd", aggregatedOutput: "test output", exitCode: 0 }), event("e4", "agent.message.delta", { messageId: "last" })];
    const runs = [{ ...run, executor: "codex" as const }];
    const timeline = nativeTimeline(messages, events, runs);
    expect(timeline.before.get("last")?.[0].description).toBe("pytest");
    expect([...timeline.streaming]).toEqual(["last"]);
    const view = render(<DevelopmentTranscript messages={messages} events={events} runs={runs} sessionId="dev_a" />);
    const text = view.container.textContent!;
    expect(text.indexOf("先检查文件")).toBeLessThan(text.indexOf("pytest"));
    expect(text.indexOf("pytest")).toBeLessThan(text.indexOf("修改完成"));
    expect(view.container.querySelectorAll('[data-native-operation="command:cmd"]')).toHaveLength(1);
    expect(nativeTimeline(messages, [...events, event("e5", "agent.message.completed", { messageId: "last" })], runs).streaming.size).toBe(0);
  });

  it("keeps a returned failed subagent on its original tool row in event order", () => {
    const parent: DevRun = { ...run, id: "parent_run", sessionId: "parent_session", executor: "codex", status: "succeeded",
      createdAt: "2026-10-10T00:00:00Z", startedAt: "2026-10-10T00:00:00Z", finishedAt: "2026-10-10T00:00:38Z", resultMessageId: "final" };
    const childRun: DevRun = { ...run, id: "child_run", sessionId: "child_session", executor: "codebuddy", status: "failed",
      createdAt: "2026-10-10T00:00:03Z", finishedAt: "2026-10-10T00:00:08Z" };
    const task: Partial<DevCollaboration> = { id: "collaboration", parentSessionId: parent.sessionId,
      childSessionId: childRun.sessionId, requestId: "child_request", title: "分析沙箱实现技术", goal: "分析沙箱实现技术",
      expectedOutput: "", readonly: true, state: "submitted", executor: "codebuddy", latestRun: childRun };
    const messages = [
      message("prelude", { runId: parent.id, content: "先检查项目上下文" }),
      message("returned_child", { runId: undefined, role: "user", sourceKind: "collaboration",
        childSessionId: childRun.sessionId, content: "协作者结果正文不作为独立消息展示" }),
      message("final", { runId: parent.id, content: "最终解释", authorId: "codex" }),
    ];
    const events = [
      event("e1", "agent.message.completed", { messageId: "prelude" }, parent.id),
      event("e2", "tool.started", { itemId: "child_call", name: "development_collaboration",
        arguments: { action: "start", goal: task.goal } }, parent.id),
      event("e3", "tool.completed", { itemId: "child_call", name: "development_collaboration",
        content: JSON.stringify({ ...task, latestRun: { ...childRun, status: "running" } }), isError: false }, parent.id),
      event("e4", "agent.message.completed", { messageId: "final" }, parent.id),
    ];
    const openSubagent = vi.fn();
    const view = render(<DevelopmentStreamContext.Provider value={{ openCodeViewer: vi.fn(), openSubagent, subagents: [task] }}>
      <DevelopmentTranscript messages={messages} events={events} runs={[parent]} sessionId={parent.sessionId} showRunHeaders visible={false} />
    </DevelopmentStreamContext.Provider>);

    expect(screen.queryByRole("button", { name: "查看子智能体任务：分析沙箱实现技术" })).toBeNull();
    expect(screen.getByRole("button", { name: "工作过程" })).toHaveTextContent("已工作 38 秒");
    fireEvent.click(screen.getByRole("button", { name: "工作过程" }));
    const childRow = screen.getByRole("button", { name: "查看子智能体任务：分析沙箱实现技术" });
    expect(childRow).toHaveTextContent("未完成");
    expect(screen.getAllByRole("button", { name: "查看子智能体任务：分析沙箱实现技术" })).toHaveLength(1);
    expect(screen.getAllByText("已工作 38 秒")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("协作者结果正文不作为独立消息展示");
    const text = view.container.textContent!;
    expect(text.indexOf("先检查项目上下文")).toBeLessThan(text.indexOf("分析沙箱实现技术"));
    expect(text.indexOf("分析沙箱实现技术")).toBeLessThan(text.indexOf("最终解释"));
    fireEvent.click(childRow);
    expect(openSubagent).toHaveBeenCalledWith(childRun.sessionId);
  });
});

describe("native activity projection", () => {
  it("filters historical userMessage tool events while keeping real tools visible", () => {
    const rows = developmentActivity([
      event("e1", "tool.started", { itemId: "user-message", kind: "userMessage" }),
      event("e2", "tool.completed", { itemId: "user-message", kind: "userMessage", content: "" }),
      event("e3", "tool.started", { itemId: "tool_a", name: "Read", arguments: { file_path: "src/app.ts" } }),
      event("e4", "tool.completed", { itemId: "tool_a", name: "Read", content: "file contents" }),
    ], run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "tool:tool_a", description: "src/app.ts", output: "file contents", state: "returned" });
  });
  it("updates streamed SDK input on the original tool row and measures reasoning from persisted timestamps", () => {
    const rows = developmentActivity([
      { ...event("e1", "reasoning.started", { itemId: "thought" }), timestamp: "2026-09-29T00:00:00Z" },
      { ...event("e2", "reasoning.completed", { itemId: "thought" }), timestamp: "2026-09-29T00:00:02Z" },
      event("e3", "tool.started", { itemId: "shell", name: "Bash", arguments: {} }),
      event("e4", "tool.started", { itemId: "shell", name: "Bash", arguments: { command: "npm test" } }),
      event("e5", "tool.completed", { itemId: "shell", content: "passed", isError: false }),
    ], run.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "reasoning", durationMs: 2000, state: "returned" });
    expect(rows[1]).toMatchObject({ id: "tool:shell", sequence: 3, description: "npm test", input: { command: "npm test" }, state: "returned" });
  });
  it("coalesces an explicit native operation and replaces deltas with the complete output", () => {
    const start = event("e1", "command.started", { id: "command_a", command: "python -m unittest" });
    const delta = event("e2", "command.output", { itemId: "command_a", delta: "first" });
    const end = event("e3", "command.completed", { id: "command_a", exitCode: 1, aggregatedOutput: "complete failure" });
    const rows = developmentActivity([start, delta, delta, end, event("e4", "command.started", { id: "foreign" }, "run_b")], run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: "python -m unittest", output: "complete failure", state: "failed", exitCode: 1 });
    expect(developmentActivity([start, delta, delta], run.id)[0].output).toBe("first");
  });
  it("does not combine operations just because command text is equal", () => {
    const rows = developmentActivity([event("e1", "command.started", { command: "test" }), event("e2", "command.completed", { command: "test", exitCode: 0 })], run.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state)).toEqual(["pending", "returned"]);
  });
  it("does not claim a still-pending tool succeeded when the run has ended", () => {
    const view = render(<DevelopmentActivity events={[event("e1", "tool.started", { itemId: "tool_a", name: "Read" })]} runId={run.id} runStatus="succeeded" />);
    expect(view.container.querySelector(".animated-gradient-text")).toBeNull();
    expect(screen.queryByText("已返回")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
