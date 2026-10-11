import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DevelopmentMarkdown } from "./DevelopmentMarkdown";
import { SubagentToolRow } from "./SubagentTranscriptRow";
import { useDevelopmentStore } from "./store";

afterEach(cleanup);

it("does not turn a failed wait query into a failed subagent task", () => {
  const task = { childSessionId: "child", parentSessionId: "parent", title: "分析项目", state: "submitted", latestRun: { status: "running" } };
  const { container } = render(<DevelopmentMarkdown project={{ id: "project", rootPath: "D:/project", displayName: "项目", lastOpenedAt: "" }} sessionId="parent">
    <SubagentToolRow toolCall={{ toolId: "start", toolName: "development_collaboration", kind: "development_collaboration", status: "completed",
      input: { action: "start" }, output: JSON.stringify(task) }} />
    <SubagentToolRow toolCall={{ toolId: "wait", toolName: "development_collaboration", kind: "development_collaboration", status: "failed",
      input: { action: "wait", task_id: "task", seconds: 50 }, output: JSON.stringify({ error: "invalid_host_tool_arguments" }) }} />
  </DevelopmentMarkdown>);
  expect(screen.getByRole("button", { name: "查看子智能体任务：分析项目" })).toHaveTextContent("开始工作");
  expect(screen.getByText("等待子任务未成功")).toBeInTheDocument();
  expect(container).not.toHaveTextContent("子智能体协作未完成");
  expect(container).not.toHaveTextContent("分析项目未完成");
  expect(container.querySelectorAll("[data-subagent-id]")).toHaveLength(1);
});

it.each(["mona", "native"])("renders %s delegation as one clickable row without claiming completion", (engine) => {
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setSide("parent", { tab: "workspace", expanded: true });
  const task = { childSessionId: "child", parentSessionId: "parent", title: "授权历史核对", state: "submitted", latestRun: { status: "running" } };
  const payload = engine === "native" ? { content: [{ type: "text", text: JSON.stringify(task) }], isError: false } : task;
  const { container } = render(<DevelopmentMarkdown project={{ id: "project", rootPath: "D:/project", displayName: "项目", lastOpenedAt: "" }} sessionId="parent">
    <SubagentToolRow toolCall={{ toolId: "start", toolName: "development_collaboration", kind: "development_collaboration", status: "completed",
      input: { action: "start", title: task.title, goal: "完整的任务描述仍然交给子智能体执行" }, output: JSON.stringify(payload) }} />
  </DevelopmentMarkdown>);
  const link = screen.getByRole("button", { name: "查看子智能体任务：授权历史核对" });
  expect(link).toHaveTextContent("授权历史核对开始工作");
  expect(container).not.toHaveTextContent("已完成");
  expect(container).not.toHaveTextContent("完整的任务描述");
  expect(container.querySelector("details, pre")).toBeNull();
  fireEvent.click(link);
  expect(useDevelopmentStore.getState().sides.parent).toMatchObject({ tab: "agent", expanded: true, agentSessionId: "child", openTabs: ["workspace", "agent"] });
});
