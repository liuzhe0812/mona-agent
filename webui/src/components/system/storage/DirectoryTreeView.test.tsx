import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DirectoryTreeView } from "./DirectoryTreeView";
import type { DirectorySize } from "../useSystemData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const child: DirectorySize = {
  id: "dir-child",
  path: "C:\\Projects\\app",
  sizeGb: 8,
  fileCount: 12,
  directSizeGb: 8,
};
const root: DirectorySize = {
  id: "dir-root",
  path: "C:\\Projects",
  sizeGb: 10,
  fileCount: 20,
  directSizeGb: 2,
  children: [child],
};

describe("DirectoryTreeView", () => {
  it("renders two columns and uses single click for selection and double click for drilldown", () => {
    const onSelect = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <DirectoryTreeView
        directories={[root]}
        currentPath={null}
        selectedPath={null}
        onSelect={onSelect}
        onDrillDown={onDrillDown}
      />,
    );

    const treeGrid = screen.getByRole("treegrid", { name: "目录占用" });
    const columns = within(treeGrid).getAllByRole("columnheader");
    expect(columns).toHaveLength(2);
    expect(columns[0]).toHaveTextContent("目录");
    expect(columns[1]).toHaveTextContent("大小");

    const row = within(treeGrid).getByRole("row", { name: /Projects/ });
    expect(row).toHaveAttribute("aria-level", "1");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(root.path);
    expect(onDrillDown).not.toHaveBeenCalled();

    fireEvent.doubleClick(row);
    expect(onDrillDown).toHaveBeenCalledWith(root.path);
  });

  it("keeps the expand arrow separate from selection and enters with Enter", () => {
    const onSelect = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <DirectoryTreeView
        directories={[root]}
        currentPath={null}
        selectedPath={null}
        onSelect={onSelect}
        onDrillDown={onDrillDown}
      />,
    );

    const treeGrid = screen.getByRole("treegrid", { name: "目录占用" });
    const row = within(treeGrid).getByRole("row", { name: /Projects/ });
    const expandButton = within(row).getByRole("button", { name: "展开 Projects" });
    expect(row).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expandButton);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const childRow = within(treeGrid).getByRole("row", { name: /app/ });
    expect(childRow).toHaveAttribute("aria-level", "2");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDrillDown).not.toHaveBeenCalled();

    fireEvent.keyDown(expandButton, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDrillDown).not.toHaveBeenCalled();

    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(treeGrid).queryByRole("row", { name: /app/ })).toBeNull();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(row).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(root.path);
    expect(onDrillDown).toHaveBeenCalledWith(root.path);
  });

  it("keeps the context menu and opens its selected path in Explorer", () => {
    vi.mocked(invoke).mockClear();
    render(
      <DirectoryTreeView
        directories={[root]}
        currentPath={null}
        selectedPath={null}
        onSelect={vi.fn()}
        onDrillDown={vi.fn()}
      />,
    );

    const row = within(screen.getByRole("treegrid", { name: "目录占用" })).getByRole("row", { name: /Projects/ });
    fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
    expect(screen.getByRole("button", { name: "打开" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));
    expect(invoke).toHaveBeenCalledWith("system_open_in_explorer", { path: root.path });
  });

  it("analyzes the right-clicked leaf directory without opening it", () => {
    vi.mocked(invoke).mockClear();
    const onAnalyze = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <DirectoryTreeView
        directories={[child]}
        currentPath={null}
        selectedPath={null}
        onSelect={vi.fn()}
        onDrillDown={onDrillDown}
        onAnalyze={onAnalyze}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("row", { name: /app/ }), { clientX: 80, clientY: 80 });
    expect(onAnalyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "占用分析" }));

    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(onAnalyze).toHaveBeenCalledWith(child.path);
    expect(onDrillDown).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "占用分析" })).toBeNull();
  });

  it("shows an actionable dialog when Explorer fails to open the context path", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("access denied"));
    render(
      <DirectoryTreeView
        directories={[root]}
        currentPath={null}
        selectedPath={null}
        onSelect={vi.fn()}
        onDrillDown={vi.fn()}
      />,
    );

    const row = within(screen.getByRole("treegrid", { name: "目录占用" })).getByRole("row", { name: /Projects/ });
    fireEvent.contextMenu(row, { clientX: 80, clientY: 80 });
    fireEvent.click(screen.getByRole("button", { name: "在资源管理器中打开" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "无法打开目录位置" })).toBeTruthy();
    expect(within(dialog).getByText(/Windows 未能打开所选目录/)).toBeTruthy();
    const details = dialog.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Error: access denied")).toBeTruthy();
  });

  it("expands ancestors when Treemap navigation changes the current path", async () => {
    render(
      <DirectoryTreeView
        directories={[root]}
        currentPath={child.path}
        selectedPath={child.path}
        onSelect={vi.fn()}
        onDrillDown={vi.fn()}
      />,
    );

    const childRow = await screen.findByRole("row", { name: /app/ });
    expect(childRow).toHaveAttribute("aria-level", "2");
    expect(childRow).toHaveAttribute("aria-selected", "true");
  });
});
