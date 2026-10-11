import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DevProject, DevSession } from "@/lib/development-api";

vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));

import { DevelopmentSessionRow } from "./DevelopmentSessionRow";

const project: DevProject = { id: "project_a", rootPath: "D:/project", displayName: "Mona", lastOpenedAt: "" };
const session: DevSession = {
  id: "dev_a", projectId: project.id, title: "MCP", executor: "mona", model: "gpt-test",
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0,
  updatedAt: new Date(Date.now() - 26 * 60_000).toISOString(),
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(overrides: Partial<DevSession> = {}) {
  const onSelect = vi.fn(), onRename = vi.fn(), onUpdate = vi.fn(), onDelete = vi.fn().mockResolvedValue(undefined), onOpenTerminal = vi.fn();
  render(<DevelopmentSessionRow project={project} session={{ ...session, ...overrides }} active visible
    onSelect={onSelect} onRename={onRename} onUpdate={onUpdate} onDelete={onDelete} onOpenTerminal={onOpenTerminal} />);
  return { onSelect, onRename, onUpdate, onDelete, onOpenTerminal };
}

async function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "MCP 更多操作" }), { button: 0, ctrlKey: false });
  return await screen.findByRole("menu");
}

async function openContextMenu() {
  fireEvent.contextMenu(screen.getByTestId("development-session-dev_a"), { button: 2 });
  return await screen.findByRole("menu");
}

describe("development task row", () => {
  it("keeps the title across the row while actions overlay the right edge", () => {
    setup();
    const row = screen.getByTestId("development-session-dev_a");
    const actions = row.querySelector("[data-session-actions]");
    expect(row).toHaveClass("development-list-row", "relative");
    expect(row.querySelector(".development-list-title")).toHaveTextContent("MCP");
    expect(actions).toHaveClass("absolute");
  });

  it("is compact, hides list age and shows details immediately on hover", () => {
    const { onUpdate } = setup();
    const row = screen.getByTestId("development-session-dev_a");
    expect(row).toHaveClass("h-8");
    expect(row.querySelector("time")).toBeNull();
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    const card = screen.getByRole("dialog", { name: "MCP 任务详情" });
    expect(card).toHaveTextContent("MCP");
    expect(card).toHaveTextContent("Mona Coding · gpt-test");
    expect(card).toHaveTextContent("Mona");
    expect(card).toHaveTextContent("26 分");
    fireEvent.click(screen.getByRole("button", { name: "置顶任务" }));
    expect(onUpdate).toHaveBeenCalledWith({ pinned: true });
  });

  it("shows only pin and more as row hover actions and exposes the requested more menu", async () => {
    const { onRename, onOpenTerminal } = setup();
    expect(screen.getByRole("button", { name: "置顶任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "MCP 更多操作" })).toBeInTheDocument();
    const menu = await openMenu();
    expect(menu).toHaveTextContent("重命名");
    expect(menu).toHaveTextContent("归档");
    expect(menu).toHaveTextContent("打开方式");
    expect(menu).toHaveTextContent("永久删除");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["重命名", "归档", "打开方式", "永久删除"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalledTimes(1);

    await openMenu();
    const openWith = screen.getByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "资源管理器" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: "终端" }));
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it("opens the full context menu without selecting the task and closes hover details", async () => {
    const { onSelect } = setup();
    const row = screen.getByTestId("development-session-dev_a");
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    expect(screen.getByRole("dialog", { name: "MCP 任务详情" })).toBeInTheDocument();

    const menu = await openContextMenu();

    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "置顶", "重命名", "归档", "打开方式", "永久删除",
    ]);
    expect(screen.queryByRole("dialog", { name: "MCP 任务详情" })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("routes context-menu pin, rename, and archive actions to the existing callbacks", async () => {
    const { onSelect, onRename, onUpdate } = setup();

    await openContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ pinned: true });

    await openContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(onRename).toHaveBeenCalledTimes(1);

    await openContextMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ archived: true });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the existing external terminal action from the context-menu submenu", async () => {
    const { onSelect, onOpenTerminal } = setup();
    await openContextMenu();
    const openWith = screen.getByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "终端" }));
    await waitFor(() => expect(onOpenTerminal).toHaveBeenCalledTimes(1));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["running", "unknown"] as const)("allows archive and confirmed delete while run status is %s", async (status) => {
    const { onUpdate, onDelete } = setup({ latestRun: {
      id: "run_a", sessionId: "dev_a", executor: "mona", status, revision: 1, createdAt: new Date().toISOString(),
    } });
    await openMenu();
    const archive = screen.getByRole("menuitem", { name: "归档" });
    const deleteItem = screen.getByRole("menuitem", { name: "永久删除" });
    expect(archive).not.toHaveAttribute("data-disabled");
    expect(deleteItem).not.toHaveAttribute("data-disabled");
    fireEvent.click(archive);
    expect(onUpdate).toHaveBeenCalledWith({ archived: true });

    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "永久删除" }));
    const dialog = await screen.findByRole("dialog", { name: "永久删除任务" });
    expect(dialog).toHaveTextContent("项目文件保留");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("keeps a failed delete in its confirmation dialog", async () => {
    const { onDelete } = setup();
    onDelete.mockRejectedValueOnce(new Error("会话删除失败"));
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "永久删除" }));
    const dialog = await screen.findByRole("dialog", { name: "永久删除任务" });
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("会话删除失败");
    expect(dialog).toBeVisible();
    expect(screen.getByTestId("development-session-dev_a").parentElement?.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows file-opening failures in an action dialog instead of the project list", async () => {
    setup();
    await openMenu();
    const openWith = screen.getByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "资源管理器" }));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(dialog).toHaveTextContent("请在 Mona 桌面端打开资源管理器");
    expect(screen.getByTestId("development-session-dev_a").parentElement?.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "操作未完成" })).not.toBeInTheDocument());
  });

  it("shows terminal-opening failures in the existing action dialog", async () => {
    const { onOpenTerminal } = setup();
    onOpenTerminal.mockRejectedValueOnce(new Error("无法打开终端，请检查项目目录后重试。"));
    await openMenu();
    const openWith = screen.getByRole("menuitem", { name: /打开方式/ });
    fireEvent.pointerMove(openWith, { pointerType: "mouse" });
    fireEvent.keyDown(openWith, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "终端" }));
    const dialog = await screen.findByRole("dialog", { name: "操作未完成" });
    expect(dialog).toHaveTextContent("无法打开终端，请检查项目目录后重试。");
    expect(screen.getByTestId("development-session-dev_a").querySelector('[role="alert"]')).toBeNull();
  });
});
