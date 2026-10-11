import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevProject, DevSession } from "@/lib/development-api";
import { DevelopmentProjectHeader } from "./DevelopmentProjectHeader";

const api = vi.hoisted(() => ({ info: vi.fn(), update: vi.fn() }));
const desktop = vi.hoisted(() => ({ isTauri: vi.fn(), openPath: vi.fn() }));
vi.mock("./workspace-api", () => ({ projectApi: api }));
vi.mock("@/lib/tauri", () => ({ isTauri: desktop.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: desktop.openPath }));
const project: DevProject = { id: "project_mona", rootPath: "D:/项目/Mona", displayName: "Mona", lastOpenedAt: "", revision: 4, pinned: false };
const session = (id: string, extra: Partial<DevSession> = {}): DevSession => ({ id, projectId: project.id, title: id, executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 1, updatedAt: "", ...extra });
const first = session("dev_one"), second = session("dev_two");
const props = { project, sessions: [first, second], expanded: true, visible: true, creating: false,
  onToggle: vi.fn(), onCreate: vi.fn(), onInspect: vi.fn(), onChanged: vi.fn(), onViewArchived: vi.fn(), onReload: vi.fn() };
const show = (changes: Partial<typeof props> = {}) => render(<DevelopmentProjectHeader {...props} {...changes} />);
async function menu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Mona 项目操作" }), { button: 0, ctrlKey: false });
  return await screen.findByRole("menu");
}
async function hover() {
  fireEvent.pointerEnter(screen.getByTestId("project-header-project_mona"), { pointerType: "mouse" });
  const card = screen.getByRole("dialog", { name: "Mona 项目信息" });
  await act(async () => {});
  return card;
}
beforeEach(() => {
  vi.resetAllMocks();
  api.info.mockResolvedValue({ repository: "liuzhe0812/mona-agent", repositoryState: "ready", reason: "" });
  api.update.mockImplementation(async (_project, changes) => ({ ...project, ...changes, revision: 5 }));
  desktop.isTauri.mockReturnValue(true); desktop.openPath.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("development project hover card and menu", () => {
  it("exposes every hover action on right-click without expanding or creating a task", async () => {
    show(); await hover();
    fireEvent.contextMenu(screen.getByTestId("project-header-project_mona"), { clientX: 40, clientY: 30 });
    const popup = await screen.findByRole("menu");
    expect(within(popup).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["新建任务", "置顶", "编辑", "在资源管理器中打开", "查看归档任务", "移除项目"]);
    expect(screen.queryByRole("dialog", { name: "Mona 项目信息" })).not.toBeInTheDocument();
    expect(props.onToggle).not.toHaveBeenCalled();
    expect(props.onCreate).not.toHaveBeenCalled();
    fireEvent.click(within(popup).getByRole("menuitem", { name: "新建任务" }));
    expect(props.onCreate).toHaveBeenCalledOnce();
    expect(props.onToggle).not.toHaveBeenCalled();
  });
  it.each([["编辑", "编辑项目"], ["移除项目", "移除项目"]])("opens the existing %s dialog from right-click before changing data", async (item, title) => {
    show();
    fireEvent.contextMenu(screen.getByTestId("project-header-project_mona"), { clientX: 40, clientY: 30 });
    const popup = await screen.findByRole("menu");
    fireEvent.click(within(popup).getByRole("menuitem", { name: item, exact: true }));
    expect(await screen.findByRole("dialog", { name: title })).toBeInTheDocument();
    expect(api.update).not.toHaveBeenCalled();
    expect(props.onToggle).not.toHaveBeenCalled();
  });
  it("does not call a failed conversation count still loading", async () => {
    render(<DevelopmentProjectHeader {...props} sessions={null} sessionsError="会话列表读取失败" />);
    const card = await hover();
    expect(card).toHaveTextContent("聊天数量暂不可用");
    expect(card).not.toHaveTextContent("正在读取聊天数量");
  });
  it("shows the two ordered hover actions without starting tasks or reading repository eagerly", () => {
    const { container } = show();
    const row = container.querySelector(".development-list-row");
    const actions = container.querySelector("[data-project-actions]")!;
    expect(row).toHaveClass("relative");
    expect(row?.querySelector(".development-list-title")).toHaveTextContent("Mona");
    expect(actions).toHaveClass("absolute");
    expect(within(actions as HTMLElement).getAllByRole("button").map((item) => item.getAttribute("aria-label")))
      .toEqual(["Mona 项目操作", "在 Mona 新建会话"]);
    expect(actions).toHaveClass("opacity-0", "group-hover/project:opacity-100");
    expect(api.info).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "在 Mona 新建会话" }));
    expect(props.onCreate).toHaveBeenCalledOnce(); expect(props.onToggle).not.toHaveBeenCalled();
  });
  it("shows the card immediately on hover, loads real details and counts only main conversations", async () => {
    show({ sessions: [first, second, session("dev_child", { parentSessionId: first.id })] });
    const card = await hover();
    expect(await within(card).findByText("liuzhe0812/mona-agent")).toBeInTheDocument();
    expect(within(card).getByText("2 个任务")).toBeInTheDocument();
    expect(within(card).getByText(project.rootPath)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "编辑项目" })).toBeInTheDocument();
    expect(api.info).toHaveBeenCalledWith(project.id);
    expect(api.update).not.toHaveBeenCalled(); expect(props.onCreate).not.toHaveBeenCalled();
  });
  it("lets the pointer enter the card and hides it when the module is hidden", async () => {
    const view = show(); const card = await hover();
    fireEvent.pointerLeave(screen.getByTestId("project-header-project_mona")); fireEvent.pointerEnter(card);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
    expect(card).toBeInTheDocument();
    view.rerender(<DevelopmentProjectHeader {...props} visible={false} />);
    expect(screen.queryByRole("dialog", { name: "Mona 项目信息" })).not.toBeInTheDocument();
  });
  it("supports keyboard entry and Escape returns focus without reopening", async () => {
    show(); const title = screen.getByRole("button", { name: "Mona" });
    fireEvent.keyDown(title, { key: "ArrowRight" });
    const card = await screen.findByRole("dialog", { name: "Mona 项目信息" });
    expect(within(card).getByRole("button", { name: "置顶项目" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(title).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Mona 项目信息" })).not.toBeInTheDocument();
  });
  it("uses exactly the reference menu actions and never overlaps the information card", async () => {
    show(); await hover(); const popup = await menu();
    expect(within(popup).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["置顶", "编辑", "在资源管理器中打开", "查看归档任务", "移除项目"]);
    expect(screen.queryByText("分区")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Mona 项目信息" })).not.toBeInTheDocument();
  });
  it("opens the archived task view for empty, unloaded, and failed session lists", async () => {
    const view = show();
    for (const state of [
      { sessions: [] },
      { sessions: null },
      { sessions: null, sessionsError: "会话列表读取失败" },
    ]) {
      view.rerender(<DevelopmentProjectHeader {...props} {...state} />);
      fireEvent.click(within(await menu()).getByRole("menuitem", { name: "查看归档任务" }));
      expect(props.onViewArchived).toHaveBeenCalledOnce();
      props.onViewArchived.mockClear();
    }
  });
  it("pins the project via its current revision, not each conversation", async () => {
    show(); fireEvent.click(within(await menu()).getByRole("menuitem", { name: "置顶" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(project, { pinned: true }));
    expect(props.onChanged).toHaveBeenCalledWith(expect.objectContaining({ pinned: true, revision: 5 }));
  });
  it("keeps project pin failures in an operation dialog", async () => {
    const detail = "项目版本冲突：请刷新后重试。";
    api.update.mockRejectedValueOnce(new Error(detail)); const view = show();
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "置顶" }));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(detail);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(within(dialog).getByRole("button", { name: "知道了" })).toBeInTheDocument();
  });
  it("edits only the display name and retains the draft if the revision conflicts", async () => {
    api.update.mockRejectedValueOnce(new Error("记录已变化")); const view = show();
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "编辑" }));
    const dialog = screen.getByRole("dialog", { name: "编辑项目" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "项目名称" }), { target: { value: "新显示名称" } });
    fireEvent.submit(within(dialog).getByRole("textbox", { name: "项目名称" }).closest("form")!);
    await within(dialog).findByRole("alert");
    expect(api.update).toHaveBeenCalledWith(project, { displayName: "新显示名称" });
    expect(within(dialog).getByRole("textbox", { name: "项目名称" })).toHaveValue("新显示名称");
    expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onReload).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "编辑项目" })).not.toBeInTheDocument();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  it("requires explicit confirmation before removing a project", async () => {
    show(); fireEvent.click(within(await menu()).getByRole("menuitem", { name: "移除项目" }));
    expect(api.update).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "移除项目" })).toHaveTextContent("不删除本地文件和聊天历史");
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(project, { removed: true }));
  });
  it("keeps project removal failures in the confirmation dialog", async () => {
    api.update.mockRejectedValueOnce(new Error("移除失败，项目仍保留")); const view = show();
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "移除项目" }));
    const dialog = screen.getByRole("dialog", { name: "移除项目" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移除" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("移除失败，项目仍保留");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
  it("opens the exact project directory through the desktop opener", async () => {
    show(); fireEvent.click(within(await menu()).getByRole("menuitem", { name: "在资源管理器中打开" }));
    await waitFor(() => expect(desktop.openPath).toHaveBeenCalledWith(project.rootPath));
    expect(api.update).not.toHaveBeenCalled();
  });
  it("reports native folder failures instead of pretending the directory opened", async () => {
    desktop.openPath.mockRejectedValueOnce(new Error("missing")); const view = show();
    fireEvent.click(within(await menu()).getByRole("menuitem", { name: "在资源管理器中打开" }));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("无法打开项目目录");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});
