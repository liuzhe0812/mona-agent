import { createRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  FlowchartCanvas,
  flowchartCanvasHelpers,
  type FlowchartCanvasHandle,
} from "./FlowchartCanvas";

describe("FlowchartCanvas rendered quality", () => {
  it("renders only referenced fractional handles and uses the same endpoint geometry", async () => {
    const nodes = [
      { id: "a", kind: "process" as const, label: "A", position: { x: 0, y: 0 }, size: { width: 160, height: 100 } },
      { id: "b", kind: "process" as const, label: "B", position: { x: 300, y: 0 }, size: { width: 160, height: 100 } },
    ];
    const edge = { id: "edge", source: "a", target: "b", sourceHandle: "right-source", targetHandle: "left-target", sourcePort: 0.3, targetPort: 0.7 };
    const { container } = render(<FlowchartCanvas nodes={nodes} edges={[edge]} direction="LR" readOnly />);
    await waitFor(() => expect(container.querySelector('[data-handleid="right-source:0.3"]')).not.toBeNull());
    expect(container.querySelector<HTMLElement>('[data-handleid="right-source:0.3"]')!.style.top).toBe("30%");
    expect(container.querySelector<HTMLElement>('[data-handleid="left-target:0.7"]')!.style.top).toBe("70%");
    expect(container.querySelectorAll('.react-flow__node[data-id="a"] .react-flow__handle')).toHaveLength(9);
    const rendered = flowchartCanvasHelpers.withReliableEdgeEndpoints(
      [flowchartCanvasHelpers.toFlowEdge(edge)], flowchartCanvasHelpers.toFlowNodes(nodes, "LR", true), nodes, "LR", [edge],
    );
    expect(rendered[0].data).toMatchObject({ sourcePoint: { x: 160, y: 30 }, targetPoint: { x: 300, y: 70 } });
  });

  function makeSurfaceVisible(container: HTMLElement) {
    const surface = container.querySelector<HTMLElement>(".flowchart-surface");
    expect(surface).not.toBeNull();
    surface!.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    });
  }

  it("renders the page below visual group regions", () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowchartCanvas
          nodes={[{
            id: "group",
            kind: "group",
            label: "ENCODER",
            position: { x: 20, y: 20 },
            size: { width: 300, height: 200 },
            style: { fill: "#E9D5FF" },
            zIndex: -1,
            container: { type: "group" },
          }]}
          edges={[]}
          direction="TB"
          canvasSettings={{
            mode: "page",
            width: 768,
            height: 690,
            grid: { visible: false, snap: true, size: 8 },
          }}
          readOnly
        />
      </div>,
    );

    expect(container.querySelector<HTMLElement>(".flowchart-page-frame")?.style.zIndex).toBe("-2");
    expect(container.querySelector<HTMLElement>("[data-id='group']")?.style.zIndex).toBe("-1");
  });

  it("uses current document node geometry for edge endpoints", () => {
    const nodes = [
      { id: "source", kind: "process" as const, label: "来源", position: { x: 100, y: 100 }, size: { width: 160, height: 64 } },
      { id: "target", kind: "process" as const, label: "目标", position: { x: 100, y: 300 }, size: { width: 160, height: 64 } },
    ];
    const flowNodes = flowchartCanvasHelpers.toFlowNodes(nodes, "TB", true);
    const edge = flowchartCanvasHelpers.toFlowEdge({ id: "edge", source: "source", target: "target" });
    const [reliable] = flowchartCanvasHelpers.withReliableEdgeEndpoints([edge], flowNodes, nodes, "TB");

    expect(reliable.data).toMatchObject({
      sourcePoint: { x: 180, y: 164 },
      targetPoint: { x: 180, y: 300 },
    });
  });

  it("reports overflow from the actual rendered label dimensions", async () => {
    const ref = createRef<FlowchartCanvasHandle>();
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowchartCanvas
          ref={ref}
          nodes={[{
            id: "node",
            kind: "process",
            label: "实际渲染文字检查",
            position: { x: 100, y: 100 },
            size: { width: 240, height: 80 },
          }]}
          edges={[]}
          direction="TB"
          readOnly
        />
      </div>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    makeSurfaceVisible(container);
    const label = container.querySelector<HTMLElement>(".flowchart-node-label");
    expect(label).not.toBeNull();
    Object.defineProperty(label!, "scrollWidth", { configurable: true, value: 120 });
    Object.defineProperty(label!, "clientWidth", { configurable: true, value: 20 });

    const issues = await ref.current!.inspectQuality();
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "text-overflow",
        nodeIds: ["node"],
        message: "节点 node 的实际渲染文字超出可用区域",
      }),
    ]));
  });

  it("does not treat decorative geometry as semantic text content", async () => {
    const ref = createRef<FlowchartCanvasHandle>();
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowchartCanvas
          ref={ref}
          nodes={[{
            id: "background-ring",
            kind: "ellipse",
            label: "",
            position: { x: 40, y: 40 },
            size: { width: 600, height: 480 },
            decorative: true,
            zIndex: -2,
          }]}
          edges={[]}
          direction="TB"
          readOnly
        />
      </div>,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());
    makeSurfaceVisible(container);
    const label = container.querySelector<HTMLElement>(".flowchart-node-label");
    expect(label).not.toBeNull();
    Object.defineProperty(label!, "scrollWidth", { configurable: true, value: 120 });
    Object.defineProperty(label!, "clientWidth", { configurable: true, value: 20 });

    expect(await ref.current!.inspectQuality()).toEqual([]);
  });

  it("refuses to report rendered quality while the editor has zero size", async () => {
    const ref = createRef<FlowchartCanvasHandle>();
    render(
      <FlowchartCanvas
        ref={ref}
        nodes={[]}
        edges={[]}
        direction="TB"
        readOnly
      />,
    );
    await waitFor(() => expect(ref.current).not.toBeNull());

    await expect(ref.current!.inspectQuality()).rejects.toThrow("画布当前不可见");
  });

});
