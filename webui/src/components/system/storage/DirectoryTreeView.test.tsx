import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DirectoryTreeView } from "./DirectoryTreeView";
import type { DirectorySize } from "../useSystemData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../SystemUi", () => ({
  PanelCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section><h2>{title}</h2>{children}</section>
  ),
}));

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
  it("uses single click for selection and double click for drilldown", () => {
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

    fireEvent.click(screen.getByText("Projects"));
    expect(onSelect).toHaveBeenCalledWith(root.path);
    expect(onDrillDown).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText("Projects"));
    expect(onDrillDown).toHaveBeenCalledWith(root.path);
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

    const label = await screen.findByText("app");
    expect(label.closest('[aria-selected="true"]')).toBeTruthy();
  });
});
