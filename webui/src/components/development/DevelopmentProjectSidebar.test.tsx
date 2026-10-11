import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { DevProject, DevSession } from "@/lib/development-api";
import { DevelopmentProjectSidebar } from "./DevelopmentProjectSidebar";

const api = vi.hoisted(() => ({ sessions: vi.fn() }));
const projectApi = vi.hoisted(() => ({ info: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/development-api", () => ({
  developmentApi: { sessions: api.sessions }, executorLabels: { mona: "Mona" }, isRunActive: () => false,
}));
vi.mock("./workspace-api", () => ({ projectApi }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));

const project: DevProject = { id: "project_mona", rootPath: "D:/项目/Mona", displayName: "Mona", lastOpenedAt: "", revision: 1, pinned: false };
const session = (id: string, extra: Partial<DevSession> = {}): DevSession => ({ id, projectId: project.id, title: id,
  executor: "mona", model: null, readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "", ...extra });
type SidebarProps = ComponentProps<typeof DevelopmentProjectSidebar>;
const sidebarProps = (overrides: Partial<SidebarProps> = {}): SidebarProps => ({
  projects: [project], activeSessionId: null, visible: true, refreshKey: 0,
  onOpenProject: vi.fn(), onSelectSession: vi.fn(), onCreate: vi.fn(), onRename: vi.fn(), onUpdate: vi.fn(),
  onDelete: vi.fn(async () => undefined), onOpenTerminal: vi.fn(), onSessions: vi.fn(),
  onProjectChanged: vi.fn(), onReload: vi.fn(), ...overrides,
});
const renderSidebar = (overrides: Partial<SidebarProps> = {}) => {
  const props = sidebarProps(overrides);
  return { ...render(<DevelopmentProjectSidebar {...props} />), props };
};
async function openProjectMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Mona 项目操作" }), { button: 0, ctrlKey: false });
  return await screen.findByRole("menu");
}
beforeEach(() => {
  vi.resetAllMocks();
  api.sessions.mockRejectedValue(new Error("读取会话失败：服务当前不可用，请稍后重试。"));
  projectApi.info.mockResolvedValue({ repository: null, repositoryState: "local", reason: "" });
  projectApi.update.mockResolvedValue(project);
});
afterEach(cleanup);

describe("development project sidebar errors", () => {
  it("shows a restored archived task and preserves an explicit return to active tasks during refresh", async () => {
    const restored = session("restored", { archived: true });
    const current = session("current");
    api.sessions.mockResolvedValue([restored, current]);
    const view = renderSidebar({ activeSessionId: restored.id });
    expect(await screen.findByRole("button", { name: "打开开发任务：restored" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("归档任务")).toBeVisible();
    expect(screen.queryByRole("button", { name: "打开开发任务：current" })).toBeNull();
    expect(view.props.onUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
    expect(screen.getByRole("button", { name: "打开开发任务：current" })).toBeVisible();
    view.rerender(<DevelopmentProjectSidebar {...view.props} refreshKey={1} />);
    await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("归档任务")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开开发任务：restored" })).toBeNull();
    expect(view.props.onUpdate).not.toHaveBeenCalled();
  });

  it("keeps session-list errors compact and exposes details without expanding navigation", async () => {
    renderSidebar();

    const retry = await screen.findByRole("button", { name: "会话列表读取失败，点击重试" });
    expect(retry).toHaveTextContent("会话读取失败 · 重试");
    expect(retry).not.toHaveTextContent("服务当前不可用");
    expect(retry).toHaveAttribute("title", "读取会话失败：服务当前不可用，请稍后重试。");
    expect(retry).toHaveClass("truncate", "whitespace-nowrap");

    fireEvent.click(retry);
    await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  });

  it("shows only the latest project or task hover card before the previous close grace expires", async () => {
    const secondProject: DevProject = { ...project, id: "project_other", rootPath: "D:/project/other", displayName: "Other", pinned: false };
    const firstTask = session("task_first", { projectId: project.id, title: "First task" });
    const secondTask = session("task_second", { projectId: project.id, title: "Second task" });
    const otherTask = session("task_other", { projectId: secondProject.id, title: "Other task" });
    api.sessions.mockImplementation(async (projectId: string) => projectId === project.id ? [firstTask, secondTask] : [otherTask]);
    const { props } = renderSidebar({ projects: [project, secondProject], onToggleProjects: vi.fn() });

    await screen.findByRole("button", { name: "打开开发任务：First task" });
    await screen.findByRole("button", { name: "打开开发任务：Second task" });
    await screen.findByRole("button", { name: "打开开发任务：Other task" });

    const expectOnlyCard = (name: string) => {
      const cards = screen.getAllByRole("dialog");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAccessibleName(name);
    };
    const firstProjectRow = screen.getByTestId(`project-header-${project.id}`);
    const firstTaskRow = screen.getByTestId(`development-session-${firstTask.id}`);
    const secondTaskRow = screen.getByTestId(`development-session-${secondTask.id}`);
    const otherProjectRow = screen.getByTestId(`project-header-${secondProject.id}`);

    fireEvent.pointerEnter(firstProjectRow, { pointerType: "mouse" });
    expectOnlyCard("Mona 项目信息");
    fireEvent.pointerLeave(firstProjectRow);
    fireEvent.pointerEnter(firstTaskRow, { pointerType: "mouse" });
    expectOnlyCard("First task 任务详情");
    expect(screen.queryByRole("dialog", { name: "Mona 项目信息" })).toBeNull();

    fireEvent.pointerLeave(firstTaskRow);
    fireEvent.pointerEnter(secondTaskRow, { pointerType: "mouse" });
    expectOnlyCard("Second task 任务详情");
    expect(screen.queryByRole("dialog", { name: "First task 任务详情" })).toBeNull();

    fireEvent.pointerLeave(secondTaskRow);
    fireEvent.pointerEnter(otherProjectRow, { pointerType: "mouse" });
    expectOnlyCard("Other 项目信息");
    expect(screen.queryByRole("dialog", { name: "Second task 任务详情" })).toBeNull();
    await act(async () => {});

    expect(screen.getByRole("button", { name: "打开开发任务：First task" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开开发任务：Other task" })).toBeVisible();
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(props.onToggleProjects).not.toHaveBeenCalled();
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(projectApi.update).not.toHaveBeenCalled();
  });

  it("opens only archived main tasks from the project menu and returns to the current task", async () => {
    const current = session("current");
    const archived = session("archived", { archived: true });
    const child = session("child", { archived: true, parentSessionId: current.id });
    api.sessions.mockResolvedValue([current, archived, child]);
    const { props } = renderSidebar({ activeSessionId: current.id });

    const currentRow = await screen.findByRole("button", { name: "打开开发任务：current" });
    expect(currentRow).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "打开开发任务：archived" })).not.toBeInTheDocument();

    fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name: "查看归档任务" }));
    expect(await screen.findByText("归档任务")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "打开开发任务：archived" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开开发任务：current" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开开发任务：child" })).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "archived 更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "恢复" }));
    expect(props.onUpdate).toHaveBeenCalledWith(archived, { archived: false });

    fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
    const restoredCurrent = await screen.findByRole("button", { name: "打开开发任务：current" });
    expect(restoredCurrent).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "打开开发任务：archived" })).not.toBeInTheDocument();
  });

  it("enters and leaves an empty archive view from a collapsed project", async () => {
    api.sessions.mockResolvedValue([]);
    renderSidebar();
    await screen.findByText("暂无会话");
    fireEvent.click(screen.getByRole("button", { name: "Mona" }));
    expect(screen.queryByText("暂无会话")).not.toBeInTheDocument();

    fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name: "查看归档任务" }));
    expect(await screen.findByText("归档任务")).toBeInTheDocument();
    expect(await screen.findByText("暂无归档任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
    expect(await screen.findByText("暂无会话")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回任务列表" })).not.toBeInTheDocument();
  });
});
