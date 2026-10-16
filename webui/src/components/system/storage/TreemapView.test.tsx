import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { TreemapView, estimateTextWidth, truncateToWidth } from "./TreemapView";
import type { DirectorySize } from "../useSystemData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const directories: DirectorySize[] = [
  { id: "dir-documents", path: "C:\\Users\\Mona\\Documents", sizeGb: 12, fileCount: 100, directSizeGb: 7, children: [{ id: "dir-sub", path: "C:\\Users\\Mona\\Documents\\sub", sizeGb: 5, fileCount: 10, directSizeGb: 5 }] },
  { id: "dir-pictures", path: "C:\\Users\\Mona\\Pictures", sizeGb: 6, fileCount: 50, directSizeGb: 6 },
];

function renderTreemap(currentTotalGb?: number, onDrillDown = vi.fn()) {
  render(
    <TreemapView
      directories={directories}
      currentTotalGb={currentTotalGb}
      breadcrumb={[{ path: "C:\\Users\\Mona", name: "Mona" }]}
      loading={false}
      error={null}
      onDrillDown={onDrillDown}
      onNavigate={() => {}}
    />,
  );
  return onDrillDown;
}

describe("TreemapView", () => {
  it("estimates CJK characters wider than latin ones", () => {
    // 中文按 1.0em、拉丁按 0.55em 估算
    expect(estimateTextWidth("文档", 12)).toBeCloseTo(24);
    expect(estimateTextWidth("ab", 12)).toBeCloseTo(13.2);
  });

  it("truncates by measured width instead of character count", () => {
    // 8 个拉丁字符(52.8px) 应完整保留；3 个中文(36px) 超过 30px 才截断
    expect(truncateToWidth("abcdefgh", 60, 12)).toBe("abcdefgh");
    expect(truncateToWidth("用户文档夹", 30, 12)).toBe("用…");
  });

  it("appends a non-clickable other tile so the tiles sum matches the parent total", () => {
    const onDrillDown = renderTreemap(30);

    const otherLabel = screen.getByText("其他（未展开）");
    // 30 - (12 + 6) = 12 GB 未展开空间（与 Documents 的 12 GB 并列，共两处）
    expect(screen.getAllByText("12.0 GB").length).toBe(2);

    fireEvent.click(otherLabel);
    expect(onDrillDown).not.toHaveBeenCalled();
  });

  it("omits the other tile when the children already cover the parent total", () => {
    renderTreemap(18);

    expect(screen.queryByText("其他（未展开）")).toBeNull();
  });

  it("selects a directory on click and enters it on double click", () => {
    const onSelect = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onSelect={onSelect}
        onDrillDown={onDrillDown}
        onNavigate={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Documents"));
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");
    expect(onDrillDown).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText("Documents"));
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");
    expect(onDrillDown).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");
  });

  it("enters with Enter and restores directory operations in the context menu", () => {
    vi.mocked(invoke).mockClear();
    const onSelect = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onSelect={onSelect}
        onDrillDown={onDrillDown}
        onNavigate={() => {}}
        selectedPath={"C:\\Users\\Mona\\Documents"}
      />,
    );

    const tile = screen.getByRole("button", { name: "Documents，12.0 GB" });
    fireEvent.keyDown(tile, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");
    expect(onDrillDown).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");

    expect(screen.queryByRole("button", { name: "在资源管理器中打开所选目录" })).toBeNull();
    fireEvent.contextMenu(tile);
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Documents");
    expect(screen.getByRole("menuitem", { name: "打开" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "复制路径" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中打开" }));
    expect(invoke).toHaveBeenCalledWith("system_open_in_explorer", { path: "C:\\Users\\Mona\\Documents" });
  });

  it("shows an actionable dialog when Explorer fails to open the selected path", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("access denied"));
    render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onDrillDown={() => {}}
        onNavigate={() => {}}
        selectedPath="C:\\Users\\Mona\\Documents"
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Documents，12.0 GB" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中打开" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "无法打开目录位置" })).toBeTruthy();
    expect(within(dialog).getByText(/Windows 未能打开所选目录/)).toBeTruthy();
    const details = dialog.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Error: access denied")).toBeTruthy();
  });

  it("uses the right-clicked leaf directory instead of the previous selection", () => {
    vi.mocked(invoke).mockClear();
    const onSelect = vi.fn();
    render(<TreemapView directories={directories} currentTotalGb={18} breadcrumb={[]} loading={false} error={null} onSelect={onSelect} onDrillDown={vi.fn()} onNavigate={vi.fn()} selectedPath="C:\\Users\\Mona\\Documents" />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Pictures，6.0 GB" }));
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Pictures");
    expect(screen.getByRole("menuitem", { name: "打开" })).toHaveAttribute("data-disabled");
    fireEvent.click(screen.getByRole("menuitem", { name: "在资源管理器中打开" }));
    expect(invoke).toHaveBeenCalledWith("system_open_in_explorer", { path: "C:\\Users\\Mona\\Pictures" });
  });

  it("analyzes only the right-clicked directory without drilling down or opening Explorer", () => {
    vi.mocked(invoke).mockClear();
    const onAnalyze = vi.fn();
    const onSelect = vi.fn();
    const onDrillDown = vi.fn();
    render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onSelect={onSelect}
        onDrillDown={onDrillDown}
        onNavigate={vi.fn()}
        onAnalyze={onAnalyze}
        selectedPath="C:\\Users\\Mona\\Documents"
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Pictures，6.0 GB" }));
    expect(onAnalyze).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("C:\\Users\\Mona\\Pictures");
    fireEvent.click(screen.getByRole("menuitem", { name: "占用分析" }));

    expect(onAnalyze).toHaveBeenCalledTimes(1);
    expect(onAnalyze).toHaveBeenCalledWith("C:\\Users\\Mona\\Pictures");
    expect(onDrillDown).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: "占用分析" })).toBeNull();
  });

  it("omits the path row at the root and keeps the map compact", () => {
    const { container } = render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onDrillDown={() => {}}
        onNavigate={() => {}}
      />,
    );

    expect(screen.queryByText("此电脑")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("288");
    expect(screen.queryByText("单击选择，双击或按 Enter 进入目录")).toBeNull();
    expect(screen.queryByText("在资源管理器中打开")).toBeNull();
  });

  it("uses the theme background token for tile strokes", () => {
    const { container } = render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onDrillDown={() => {}}
        onNavigate={() => {}}
      />,
    );

    const strokes = Array.from(container.querySelectorAll("rect")).map((rect) => rect.getAttribute("stroke"));
    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(new Set(["hsl(var(--background))"]));
  });
});
