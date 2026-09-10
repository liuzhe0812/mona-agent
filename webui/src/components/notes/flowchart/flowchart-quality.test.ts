import { describe, expect, it } from "vitest";

import { createBlankFlowchartDocument, type FlowchartDocument } from "./flowchart-document";
import { inspectFlowchartQuality, recommendedFlowchartNodeSize } from "./flowchart-quality";
import { sharedRouteLength } from "./flowchart-edge-geometry";

describe("inspectFlowchartQuality", () => {
  it("treats identical routes as an error without confusing different route types", () => {
    const doc = createBlankFlowchartDocument();
    doc.edges = [
      { id: "a", source: "n-start", target: "n-end", style: { route: "straight" } },
      { id: "b", source: "n-start", target: "n-end", style: { route: "straight" } },
    ];
    const issues = inspectFlowchartQuality(doc);
    expect(issues.filter((issue) => issue.code === "duplicate-route")).toEqual([
      expect.objectContaining({ severity: "error", edgeIds: ["a", "b"] }),
    ]);
    expect(issues.some((issue) => issue.code === "edge-overlap")).toBe(false);
    doc.edges[1].style = { route: "bezier" };
    expect(inspectFlowchartQuality(doc).some((issue) => issue.code === "duplicate-route")).toBe(false);
  });

  it("返回重叠与文字溢出的节点 ID", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = [
      { id: "a", kind: "process", label: "非常长而且无法放进小节点的流程说明文字", position: { x: 10, y: 10 }, size: { width: 80, height: 30 } },
      { id: "b", kind: "process", label: "B", position: { x: 40, y: 20 }, size: { width: 120, height: 60 } },
    ];
    const issues = inspectFlowchartQuality(doc);
    expect(issues.some((issue) => issue.code === "node-overlap" && issue.nodeIds?.includes("a") && issue.nodeIds?.includes("b"))).toBe(true);
    expect(issues.some((issue) => issue.code === "text-overflow" && issue.nodeIds?.[0] === "a")).toBe(true);
  });

  it("返回页面越界和边穿节点的精确 ID", () => {
    const doc: FlowchartDocument = {
      ...createBlankFlowchartDocument(),
      canvas: { mode: "page", width: 500, height: 300, grid: { visible: true, snap: true, size: 16 } },
      nodes: [
        { id: "a", kind: "process", label: "A", position: { x: 0, y: 80 }, size: { width: 100, height: 60 } },
        { id: "middle", kind: "process", label: "M", position: { x: 190, y: 80 }, size: { width: 100, height: 60 } },
        { id: "b", kind: "process", label: "B", position: { x: 380, y: 80 }, size: { width: 140, height: 60 } },
      ],
      edges: [{ id: "e", source: "a", target: "b", sourceHandle: "right-source", targetHandle: "left-target", style: { route: "straight" } }],
    };
    const issues = inspectFlowchartQuality(doc);
    expect(issues.some((issue) => issue.code === "page-overflow" && issue.nodeIds?.[0] === "b")).toBe(true);
    expect(issues.some((issue) => issue.code === "edge-through-node" && issue.edgeIds?.[0] === "e" && issue.nodeIds?.[0] === "middle")).toBe(true);
  });

  it("返回控制点导致的连线页面越界", () => {
    const doc: FlowchartDocument = {
      ...createBlankFlowchartDocument(),
      canvas: { mode: "page", width: 500, height: 300, grid: { visible: true, snap: true, size: 16 } },
      nodes: [
        { id: "a", kind: "process", label: "A", position: { x: 100, y: 40 }, size: { width: 100, height: 60 } },
        { id: "b", kind: "process", label: "B", position: { x: 100, y: 200 }, size: { width: 100, height: 60 } },
      ],
      edges: [{
        id: "e",
        source: "a",
        target: "b",
        sourceHandle: "left-source",
        targetHandle: "left-target",
        controlPoints: [{ x: -30, y: 70 }, { x: -30, y: 230 }],
      }],
    };

    expect(inspectFlowchartQuality(doc)).toContainEqual(expect.objectContaining({
      code: "edge-page-overflow",
      edgeIds: ["e"],
    }));
  });

  it("容器与子节点不被当成重叠，尺寸计算可重复", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = [
      { id: "g", kind: "group", label: "分区", position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, container: { type: "group" } },
      { id: "a", kind: "process", label: "处理", position: { x: 20, y: 50 }, parentId: "g", size: { width: 120, height: 60 } },
    ];
    expect(inspectFlowchartQuality(doc).some((issue) => issue.code === "node-overlap")).toBe(false);
    const input = { kind: "process" as const, label: "验证并保存用户提交的数据", icon: "database" as const };
    expect(recommendedFlowchartNodeSize(input)).toEqual(recommendedFlowchartNodeSize(input));
    expect(recommendedFlowchartNodeSize(input).width).toBeGreaterThan(140);
  });

  it("整图需要缩得过小时返回可读性提醒", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index}`,
      kind: "process" as const,
      label: `步骤 ${index + 1}`,
      position: { x: index * 420, y: 0 },
      size: { width: 160, height: 64 },
    }));
    const issue = inspectFlowchartQuality(doc).find((item) => item.code === "overview-too-small");
    expect(issue?.message).toContain("建议压缩布局或拆分阶段");
  });

  it("提醒合并表达同一结果的重复终点", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = [
      { id: "end-a", kind: "end", label: "结束", position: { x: 0, y: 0 } },
      { id: "end-b", kind: "end", label: "结束", position: { x: 240, y: 0 } },
    ];

    expect(inspectFlowchartQuality(doc)).toContainEqual(expect.objectContaining({
      code: "duplicate-terminal",
      nodeIds: ["end-a", "end-b"],
    }));
  });

  it("按实际共线长度发现不同端点的重复通道，并忽略短出线与单点相交", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = [
      { id: "a", kind: "process", label: "A", position: { x: 0, y: 0 }, size: { width: 40, height: 40 } },
      { id: "b", kind: "process", label: "B", position: { x: 160, y: 160 }, size: { width: 40, height: 40 } },
      { id: "c", kind: "process", label: "C", position: { x: 0, y: 80 }, size: { width: 40, height: 40 } },
      { id: "d", kind: "process", label: "D", position: { x: 160, y: 240 }, size: { width: 40, height: 40 } },
    ];
    doc.edges = [
      {
        id: "long-a-b",
        source: "a",
        target: "b",
        sourceHandle: "right-source",
        targetHandle: "left-target",
        controlPoints: [{ x: 100, y: 20 }, { x: 100, y: 180 }],
      },
      {
        id: "long-c-d",
        source: "c",
        target: "d",
        sourceHandle: "right-source",
        targetHandle: "left-target",
        controlPoints: [{ x: 100, y: 100 }, { x: 100, y: 260 }],
      },
    ];

    expect(inspectFlowchartQuality(doc)).toContainEqual(expect.objectContaining({
      code: "edge-overlap",
      severity: "error",
      edgeIds: ["long-a-b", "long-c-d"],
    }));
    expect(sharedRouteLength(
      [{ from: { x: 0, y: 0 }, to: { x: 40, y: 0 } }],
      [{ from: { x: 40, y: 0 }, to: { x: 10, y: 0 } }],
    )).toBe(30);
    expect(sharedRouteLength(
      [{ from: { x: 0, y: 0 }, to: { x: 16, y: 0 } }],
      [{ from: { x: 16, y: 0 }, to: { x: 32, y: 0 } }],
    )).toBe(0);
  });

  it("提醒线标签互遮并返回具体边 ID", () => {
    const doc = createBlankFlowchartDocument();
    doc.nodes = [
      { id: "top-left", kind: "process", label: "A", position: { x: 0, y: 0 }, size: { width: 40, height: 40 } },
      { id: "top-right", kind: "process", label: "B", position: { x: 200, y: 0 }, size: { width: 40, height: 40 } },
      { id: "bottom-left", kind: "process", label: "C", position: { x: 0, y: 200 }, size: { width: 40, height: 40 } },
      { id: "bottom-right", kind: "process", label: "D", position: { x: 200, y: 200 }, size: { width: 40, height: 40 } },
    ];
    doc.edges = [
      {
        id: "diagonal-a",
        source: "top-left",
        target: "bottom-right",
        sourceHandle: "right-source",
        targetHandle: "left-target",
        label: "通过",
        style: { route: "straight" },
      },
      {
        id: "diagonal-b",
        source: "bottom-left",
        target: "top-right",
        sourceHandle: "right-source",
        targetHandle: "left-target",
        label: "拒绝",
        style: { route: "straight" },
      },
    ];

    expect(inspectFlowchartQuality(doc)).toContainEqual(expect.objectContaining({
      code: "label-overlap",
      severity: "warning",
      edgeIds: ["diagonal-a", "diagonal-b"],
    }));
  });
});
