import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspacePanel } from "@/components/deliver/WorkspacePanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { openPathWithSystemApp } from "@/lib/tauri";
import type { DeliveredFile } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  openPathWithSystemApp: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@/components/terminal/FileManager/iconCache", () => ({
  getCachedIcon: () => null,
  getIcon: async () => null,
  extractExtension: (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
  },
}));

const mockedOpen = vi.mocked(openPathWithSystemApp);

function artifact(name: string): DeliveredFile {
  return {
    path: name,
    absolute_path: `/ws/output/${name}`,
    name,
    size: 10,
    size_human: "10 B",
    mime: "text/plain",
  };
}

function nestedArtifact(): DeliveredFile {
  return {
    path: "docs/report.md",
    absolute_path: "/ws/output/docs/report.md",
    name: "report.md",
    size: 10,
    size_human: "10 B",
    mime: "text/markdown",
  };
}

function expandWorkspace(): void {
  const toggle = screen.getByRole("button", { name: "工作区文件" });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
}

function fileRow(name: string): HTMLButtonElement {
  return screen.getByText(name).closest("button")!;
}

describe("WorkspacePanel", () => {
  beforeEach(() => {
    mockedOpen.mockReset();
    // The preview store is a module singleton: reset the new-file baseline
    // and viewed set so tests do not leak marker state into each other.
    useFilePreviewStore.setState({
      file: null,
      artifactBaseline: null,
      viewedArtifactPaths: new Set(),
    });
  });

  it("opens the output directory itself from the empty state", () => {
    render(<WorkspacePanel files={[]} scope="shared" outputDir="/ws/output" />);
    expandWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "打开目录" }));

    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedOpen).toHaveBeenCalledWith("/ws/output");
  });

  it("opens the output directory, not the first file, from the truncated footer", () => {
    render(
      <WorkspacePanel
        files={[artifact("a.png"), artifact("b.png")]}
        scope="shared"
        truncated
        outputDir="/ws/output"
      />,
    );
    expandWorkspace();

    fireEvent.click(
      screen.getByRole("button", { name: /打开 output 目录查看全部/ }),
    );

    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedOpen).toHaveBeenCalledWith("/ws/output");
  });

  it("renders session files in a dedicated section above the artifact tree", () => {
    const treeFile: DeliveredFile = {
      path: "docs/report.md",
      absolute_path: "/ws/output/docs/report.md",
      name: "report.md",
      size: 10,
      size_human: "10 B",
      mime: "text/markdown",
    };
    const sessionFile = artifact("img_session.png");
    render(
      <WorkspacePanel
        files={[treeFile]}
        sessionFiles={[sessionFile]}
        scope="shared"
      />,
    );

    expect(screen.getByText("本次会话产物")).toBeInTheDocument();
    const sessionRow = screen.getByText("img_session.png");
    expandWorkspace();
    fireEvent.click(screen.getByText("docs"));
    const treeRow = screen.getByText("report.md");
    expect(
      sessionRow.compareDocumentPosition(treeRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders current task files between session deliveries and workspace files", () => {
    render(
      <WorkspacePanel
        files={[artifact("workspace.md")]}
        sessionFiles={[artifact("session.png")]}
        taskFiles={[artifact("task.py")]}
        scope="shared"
      />,
    );

    const sessionSection = screen.getByRole("button", { name: "本次会话产物" });
    const taskSection = screen.getByRole("button", { name: "当前任务文件" });
    const workspaceSection = screen.getByRole("button", { name: "工作区文件" });
    expect(
      sessionSection.compareDocumentPosition(taskSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      taskSection.compareDocumentPosition(workspaceSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("task.py")).toBeInTheDocument();
    expect(screen.queryByText("workspace.md")).not.toBeInTheDocument();
    expect(taskSection).toHaveAttribute("aria-expanded", "true");
    expect(workspaceSection).toHaveAttribute("aria-expanded", "false");
  });

  it("renders overview inventories flat without nested workspace sections", () => {
    const { rerender } = render(
      <WorkspacePanel
        files={[]}
        sessionFiles={[artifact("delivery.png")]}
        scope="shared"
        embedded
        listOnly="session"
      />,
    );
    expect(screen.getByText("delivery.png")).toBeInTheDocument();
    expect(screen.queryByText("本次会话产物")).not.toBeInTheDocument();
    expect(screen.queryByText("工作区文件")).not.toBeInTheDocument();

    rerender(
      <WorkspacePanel
        files={[]}
        taskFiles={[artifact("process.py")]}
        scope="shared"
        embedded
        listOnly="task"
      />,
    );
    expect(screen.getByText("process.py")).toBeInTheDocument();
    expect(screen.queryByText("当前任务文件")).not.toBeInTheDocument();
  });

  it("does not repeat a session file in the current task section", () => {
    const delivered = artifact("shared.png");
    render(
      <WorkspacePanel
        files={[]}
        sessionFiles={[delivered]}
        taskFiles={[delivered, artifact("task.py")]}
        scope="shared"
      />,
    );

    expect(screen.getAllByText("shared.png")).toHaveLength(1);
    expect(screen.getByText("task.py")).toBeInTheDocument();
  });

  it("shows an empty current task prompt and supports collapsing that section", () => {
    const { rerender } = render(
      <WorkspacePanel files={[]} taskFiles={[]} scope="shared" />,
    );

    const taskSection = screen.getByRole("button", { name: "当前任务文件" });
    expect(taskSection).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("当前任务还没有新增或修改的文件"),
    ).toBeInTheDocument();

    rerender(
      <WorkspacePanel
        files={[]}
        taskFiles={[artifact("task.py")]}
        scope="shared"
      />,
    );
    fireEvent.click(taskSection);
    expect(screen.queryByText("task.py")).not.toBeInTheDocument();
    fireEvent.click(taskSection);
    expect(screen.getByText("task.py")).toBeInTheDocument();
  });

  it("collapses the session and workspace sections independently", () => {
    render(
      <WorkspacePanel
        files={[artifact("tree.md")]}
        sessionFiles={[artifact("session.md")]}
        scope="shared"
      />,
    );

    expect(screen.queryByText("tree.md")).not.toBeInTheDocument();
    expandWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "本次会话产物" }));
    expect(screen.queryByText("session.md")).not.toBeInTheDocument();
    expect(screen.getByText("tree.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "工作区文件" }));
    expect(screen.queryByText("tree.md")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "本次会话产物" }));
    expect(screen.getByText("session.md")).toBeInTheDocument();
  });

  it("hides the technical generated wrapper while keeping date folders", () => {
    render(
      <WorkspacePanel
        files={[{ ...artifact("generated/2026-08-21/report.md"), name: "report.md" }]}
        scope="shared"
      />,
    );

    expandWorkspace();
    expect(screen.queryByText("generated")).not.toBeInTheDocument();
    expect(screen.getByText("2026-08-21")).toBeInTheDocument();
    fireEvent.click(screen.getByText("2026-08-21"));
    expect(screen.getByText("report.md")).toBeInTheDocument();
  });

  it("dedupes session files by absolute path and skips the empty state", () => {
    const f = artifact("dup.png");
    render(
      <WorkspacePanel files={[]} sessionFiles={[f, { ...f }]} scope="shared" />,
    );

    expect(screen.getAllByText("dup.png")).toHaveLength(1);
    expect(screen.queryByText(/还没有产物/)).not.toBeInTheDocument();
  });

  it("keeps the session section visible when there are no session files", () => {
    render(<WorkspacePanel files={[artifact("a.png")]} scope="shared" />);

    expect(screen.getByText("本次会话产物")).toBeInTheDocument();
  });

  it("aligns root file and directory icons to the same column", () => {
    render(
      <WorkspacePanel
        files={[artifact("root.md"), nestedArtifact()]}
        scope="shared"
      />,
    );
    expandWorkspace();

    expect(fileRow("root.md")).toHaveStyle({ paddingLeft: "8px" });
    expect(screen.getByText("docs").closest("button")).toHaveStyle({ paddingLeft: "8px" });
  });

  it("selects files on click and opens an in-pane preview on double click", () => {
    render(<WorkspacePanel files={[artifact("a.png")]} scope="shared" />);
    expandWorkspace();

    fireEvent.click(fileRow("a.png"));
    expect(fileRow("a.png")).toHaveAttribute("aria-pressed", "true");
    expect(useFilePreviewStore.getState().file).toBeNull();

    fireEvent.doubleClick(fileRow("a.png"));

    expect(mockedOpen).not.toHaveBeenCalled();
    expect(useFilePreviewStore.getState().file).toEqual(
      expect.objectContaining({ absolute_path: "/ws/output/a.png" }),
    );
  });

  it("keeps a multi-selection for batch actions in the context menu", async () => {
    const onDelete = vi.fn();
    render(
      <WorkspacePanel
        files={[artifact("a.png"), artifact("b.png")]}
        scope="shared"
        onDelete={onDelete}
      />,
    );
    expandWorkspace();

    fireEvent.click(fileRow("a.png"));
    fireEvent.click(fileRow("b.png"), { ctrlKey: true });
    expect(fileRow("a.png")).toHaveAttribute("aria-pressed", "true");
    expect(fileRow("b.png")).toHaveAttribute("aria-pressed", "true");

    fireEvent.contextMenu(fileRow("b.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除 2 个文件" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("2 个文件");

    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledTimes(2);
    });
    expect(onDelete).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ absolute_path: "/ws/output/a.png" }),
    );
    expect(onDelete).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ absolute_path: "/ws/output/b.png" }),
    );
  });

  it("marks files that arrive after the initial load as new until previewed", () => {
    const a = artifact("a.png");
    const { rerender } = render(<WorkspacePanel files={[a]} scope="shared" />);
    expandWorkspace();
    // Initial load is the baseline: nothing is flagged as new.
    expect(screen.queryByLabelText("新文件")).not.toBeInTheDocument();

    rerender(<WorkspacePanel files={[a, artifact("b.png")]} scope="shared" />);
    expect(screen.getByLabelText("新文件")).toBeInTheDocument();

    fireEvent.doubleClick(fileRow("b.png"));
    expect(screen.queryByLabelText("新文件")).not.toBeInTheDocument();
  });

  it("confirms deletion with recycle-bin wording and forwards the file", async () => {
    const onDelete = vi.fn();
    render(
      <WorkspacePanel files={[artifact("a.png")]} scope="shared" onDelete={onDelete} />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    // Recycle-bin semantics: recoverable, not "permanent, cannot undo".
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("回收站");
    expect(dialog).not.toHaveTextContent("永久删除");

    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ absolute_path: "/ws/output/a.png" }),
    );
  });

  it("keeps the dialog open and surfaces the error when trashing fails", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("trash unavailable"));
    render(
      <WorkspacePanel files={[artifact("a.png")]} scope="shared" onDelete={onDelete} />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));

    // Failure must NOT close the dialog silently nor fall back to permanent
    // delete: the user sees the reason and can retry or cancel.
    expect(await screen.findByText(/trash unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("removes missing deliveries from the visible session list", () => {
    render(
      <WorkspacePanel
        files={[]}
        sessionFiles={[{ ...artifact("removed.py"), missing: true }]}
        scope="shared"
      />,
    );

    expect(screen.queryByText("removed.py")).not.toBeInTheDocument();
    expect(screen.queryByText("文件已移除")).not.toBeInTheDocument();
  });

  it("renames a file from its context menu", async () => {
    const onRename = vi.fn();
    render(
      <WorkspacePanel
        files={[artifact("a.png")]}
        scope="shared"
        onRename={onRename}
      />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新名称" }), {
      target: { value: "renamed.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith(
        expect.objectContaining({ absolute_path: "/ws/output/a.png" }),
        "renamed.png",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the rename dialog open and surfaces a rename error", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error("name already exists"));
    render(
      <WorkspacePanel
        files={[artifact("a.png")]}
        scope="shared"
        onRename={onRename}
      />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("a.png"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新名称" }), {
      target: { value: "taken.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/name already exists/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("labels the full tree section as 工作区文件 for shared scope", () => {
    render(<WorkspacePanel files={[artifact("a.png")]} scope="shared" />);

    expect(screen.getByText("工作区文件")).toBeInTheDocument();
    expect(screen.queryByText("工作区产物")).not.toBeInTheDocument();
  });

  it("uses the header action slot to collapse the overview instead of refreshing", () => {
    const onCollapse = vi.fn();
    render(<WorkspacePanel files={[artifact("a.png")]} scope="shared" onCollapse={onCollapse} onRefresh={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
    expect(screen.getByText("概览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起概览" }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("labels the panel as project files for project scope, never 产物", () => {
    render(<WorkspacePanel files={[artifact("a.py")]} scope="project" />);

    expect(screen.getByText("项目文件")).toBeInTheDocument();
    expect(screen.getByText("全部文件")).toBeInTheDocument();
    expect(screen.queryByText("产物")).not.toBeInTheDocument();
  });

  it("clears new-file markers once the panel has been displayed and closed", () => {
    const a = artifact("a.png");
    const first = render(<WorkspacePanel files={[a]} scope="shared" />);
    expandWorkspace();
    first.rerender(<WorkspacePanel files={[a, artifact("b.png")]} scope="shared" />);
    // The arrival is flagged new while the panel is on screen.
    expect(screen.getByLabelText("新文件")).toBeInTheDocument();

    // Closing the panel means the user has seen the list: remounting the
    // same inventory must not flag anything as new again.
    first.unmount();
    render(<WorkspacePanel files={[a, artifact("b.png")]} scope="shared" />);
    expandWorkspace();
    expect(screen.queryByLabelText("新文件")).not.toBeInTheDocument();
  });

  it("opens a directory in the system explorer from its context menu", async () => {
    render(
      <WorkspacePanel
        files={[nestedArtifact()]}
        scope="shared"
        outputDir="/ws/output"
      />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("docs"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "在系统资源管理器中打开" }),
    );

    expect(mockedOpen).toHaveBeenCalledWith("/ws/output/docs");
  });

  it("moves a directory to the recycle bin with folder wording", async () => {
    const onDelete = vi.fn();
    render(
      <WorkspacePanel
        files={[nestedArtifact()]}
        scope="shared"
        onDelete={onDelete}
        outputDir="/ws/output"
      />,
    );
    expandWorkspace();

    fireEvent.contextMenu(screen.getByText("docs"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("文件夹");
    expect(dialog).toHaveTextContent("回收站");

    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ absolute_path: "/ws/output/docs" }),
    );
  });

  it("allows deleting files in project scope when onDelete is provided", async () => {
    const onDelete = vi.fn();
    render(
      <WorkspacePanel files={[artifact("a.py")]} scope="project" onDelete={onDelete} />,
    );

    fireEvent.contextMenu(screen.getByText("a.py"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "移至回收站" }));

    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ absolute_path: "/ws/output/a.py" }),
    );
  });
});
