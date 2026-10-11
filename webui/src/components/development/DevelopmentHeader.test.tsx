import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevExecutor, DevProject, DevSession } from "@/lib/development-api";
import { DevelopmentHeader } from "./DevelopmentHeader";
import { useDevelopmentStore } from "./store";

vi.mock("./DevelopmentOverview", () => ({
  DevelopmentOverview: ({ onOpenTool }: { onOpenTool: (tab: "workspace") => void }) => (
    <button type="button" onClick={() => onOpenTool("workspace")}>打开工作工具</button>
  ),
}));

const project: DevProject = { id: "header_project", rootPath: "D:/project", displayName: "Header 项目", lastOpenedAt: "" };
const session: DevSession = { id: "header_session", projectId: project.id, title: "Header 标题", executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const executors: DevExecutor[] = [];
const portals: HTMLElement[] = [];

function HeaderHarness({ portal, docked, hasStatus = false, onOpenStatus }: {
  portal: HTMLElement; docked: boolean; hasStatus?: boolean; onOpenStatus?: () => void;
}) {
  const [overviewOpen, setOverviewOpen] = useState(false);
  return <>
    <DevelopmentHeader project={project} session={session} executors={executors} visible onNew={vi.fn()}
      hasStatus={hasStatus} needsAttention={hasStatus} onOpenStatus={onOpenStatus}
      overviewOpen={overviewOpen} onOverviewOpenChange={setOverviewOpen} overviewContainer={portal} overviewDocked={docked} />
    <div data-testid="conversation-area">对话内容</div>
  </>;
}

function mountHeader(docked: boolean, options?: { hasStatus?: boolean; onOpenStatus?: () => void }) {
  const portal = document.createElement("div");
  document.body.appendChild(portal);
  portals.push(portal);
  return { portal, view: render(<HeaderHarness portal={portal} docked={docked} {...options} />) };
}

beforeEach(() => { useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true); });
afterEach(() => { cleanup(); portals.splice(0).forEach((portal) => portal.remove()); vi.restoreAllMocks(); });

it("uses shared tooltips without native title attributes", async () => {
  const { portal, view } = mountHeader(false);
  const toggle = screen.getByRole("button", { name: "任务概览" });
  expect(view.container.querySelectorAll("[title]")).toHaveLength(0);
  expect(portal.querySelectorAll("[title]")).toHaveLength(0);

  const user = userEvent.setup();
  await user.hover(toggle);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("切换摘要");
  await user.click(toggle);
  const close = await screen.findByRole("button", { name: "关闭任务概览" });
  expect(toggle).toHaveFocus();
  expect(close).not.toHaveFocus();
  expect(screen.queryByText("关闭摘要")).toBeNull();
  expect(close).not.toHaveAttribute("title");
  await user.hover(close);
  expect(await screen.findByText("关闭摘要")).toBeInTheDocument();
});

it("keeps a docked overview open on outside clicks, but closes a floating one and restores focus on Escape and tool switches", async () => {
  const { portal, view } = mountHeader(true);
  const toggle = screen.getByRole("button", { name: "任务概览" });
  const conversation = screen.getByTestId("conversation-area");

  fireEvent.click(toggle);
  await screen.findByRole("region", { name: "任务概览浮卡" });
  act(() => screen.getByRole("button", { name: "关闭任务概览" }).focus());
  await screen.findByRole("tooltip");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeNull());
  fireEvent.click(toggle);
  await screen.findByRole("region", { name: "任务概览浮卡" });
  fireEvent.pointerDown(conversation);
  expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeNull());
  expect(toggle).toHaveFocus();

  view.rerender(<HeaderHarness portal={portal} docked={false} />);
  fireEvent.click(toggle);
  await screen.findByRole("region", { name: "任务概览浮卡" });
  fireEvent.pointerDown(conversation);
  await waitFor(() => expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeNull());

  fireEvent.click(toggle);
  await screen.findByRole("button", { name: "打开工作工具" });
  fireEvent.click(screen.getByRole("button", { name: "打开工作工具" }));
  await waitFor(() => expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeNull());
  expect(toggle).toHaveFocus();
});

it("keeps pending actions out of the task summary and opens them from the more menu", async () => {
  const onOpenStatus = vi.fn();
  const { portal, view } = mountHeader(false, { hasStatus: true, onOpenStatus });
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  const summary = await screen.findByRole("region", { name: "任务概览浮卡" });
  expect(await within(summary).findByRole("button", { name: "打开工作工具" })).toBeInTheDocument();
  expect(within(summary).queryByText("任务状态与操作")).toBeNull();

  fireEvent.click(within(summary).getByRole("button", { name: "关闭任务概览" }));
  await waitFor(() => expect(portal.querySelector('[role="region"][aria-label="任务概览浮卡"]')).toBeNull());
  fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "待处理事项" }));
  expect(onOpenStatus).toHaveBeenCalledOnce();

  view.unmount();
  const withoutStatus = mountHeader(false);
  fireEvent.pointerDown(screen.getByRole("button", { name: "会话更多操作" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("menu")).not.toHaveTextContent("待处理事项");
  withoutStatus.view.unmount();
});
