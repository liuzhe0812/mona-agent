import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FLOWCHART_ICON_NAMES } from "./flowchart-document";
import { FlowchartNodeIcon } from "./flowchart-icons";
import { flowchartCanvasHelpers } from "./FlowchartCanvas";

describe("FlowchartNodeIcon", () => {
  it("所有协议图标都能渲染为本地 SVG", () => {
    for (const name of FLOWCHART_ICON_NAMES) {
      const { container, unmount } = render(<FlowchartNodeIcon name={name} />);
      expect(container.querySelector("svg"), name).not.toBeNull();
      unmount();
    }
  });

  it("转换 React Flow 节点时父容器始终排在子节点之前", () => {
    const nodes = flowchartCanvasHelpers.toFlowNodes([
      { id: "child", kind: "process", label: "处理", position: { x: 20, y: 20 }, parentId: "lane" },
      { id: "lane", kind: "swimlane-lane", label: "系统", position: { x: 40, y: 0 }, parentId: "pool", container: { type: "lane", orientation: "horizontal", order: 0 } },
      { id: "pool", kind: "swimlane-pool", label: "流程", position: { x: 0, y: 0 }, container: { type: "pool", orientation: "horizontal", headerSize: 40 } },
    ], "LR", true);
    expect(nodes.map((node) => node.id)).toEqual(["pool", "lane", "child"]);
  });
});
