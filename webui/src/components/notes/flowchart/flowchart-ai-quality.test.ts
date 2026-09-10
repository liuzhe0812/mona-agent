import { describe, expect, it } from "vitest";

import {
  computeFlowchartDocumentHash,
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  type FlowchartDocument,
} from "./flowchart-document";
import {
  applyFlowchartPatch,
  parseFlowchartPatch,
  routeFlowchartEdges,
  type FlowchartPatch,
} from "./flowchart-patch";
import { inspectFlowchartQuality } from "./flowchart-quality";
import { flowchartNodeAbsolutePosition } from "./flowchart-operations";
import { flowchartCanvasHelpers } from "./FlowchartCanvas";
import { flowchartEdgeSegments } from "./flowchart-edge-geometry";
import { getFlowchartShapeDefaultSize } from "./flowchart-shapes";

function patchText(value: unknown): string {
  return `\`\`\`mona-flowchart-patch\n${JSON.stringify(value)}\n\`\`\``;
}

describe("AI 高质量画布协议", () => {
  it("边标签默认使用可读的白底与线条颜色", () => {
    const edge = flowchartCanvasHelpers.toFlowEdge({
      id: "edge",
      source: "a",
      target: "b",
      label: "通过",
      style: { stroke: "#16A34A" },
    });

    expect(edge.labelShowBg).toBe(true);
    expect(edge.labelBgStyle).toMatchObject({ fill: "#FFFFFF" });
    expect(edge.labelStyle).toMatchObject({ fill: "#16A34A", fontSize: 12 });
  });

  it("兼容上游常见的数值虚线写法并规范化", () => {
    const source = createBlankFlowchartDocument();
    const parsed = parseFlowchartPatch(patchText({
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "TB",
          nodes: [
            { id: "a", kind: "start", label: "开始" },
            { id: "b", kind: "end", label: "结束" },
          ],
          edges: [{ id: "e", source: "a", target: "b", style: { strokeDasharray: "8 6" } }],
        },
      }],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const applied = applyFlowchartPatch(source, parsed.patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.document.edges[0].style?.strokeDasharray).toBe("dashed");
  });


  it("完整 blueprint 保留主题、样式、图标、分组和边样式", () => {
    const source = createBlankFlowchartDocument();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "LR",
          layout: "auto",
          theme: { stylePreset: "soft", paletteId: "deep-blue", preserveManualStyles: true },
          background: "#FFFFFF",
          nodes: [
            { id: "n1", kind: "start", label: "用户请求", icon: "user", style: { bold: true } },
            { id: "n2", kind: "process", label: "应用服务", icon: "server", style: { fill: "#DBEAFE" } },
            { id: "n3", kind: "database", label: "数据存储", icon: "database" },
          ],
          edges: [
            { id: "e1", source: "n1", target: "n2", style: { route: "smoothstep", markerEnd: "arrowclosed" } },
            { id: "e2", source: "n2", target: "n3", style: { route: "smoothstep", stroke: "#2563EB", markerEnd: "arrowclosed" } },
          ],
          groups: [{ id: "g1", label: "服务区", memberIds: ["n2", "n3"], style: { fill: "#F8FAFC", borderColor: "#CBD5E1" } }],
        },
      }],
    };

    const result = applyFlowchartPatch(source, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.theme).toMatchObject({ stylePreset: "soft", paletteId: "deep-blue" });
    expect(result.document.canvas.background).toBe("#FFFFFF");
    expect(result.document.nodes.find((node) => node.id === "n2")).toMatchObject({ icon: "server" });
    expect(result.document.nodes.find((node) => node.id === "n2")?.parentId).toBe("g1");
    expect(result.document.nodes.find((node) => node.id === "g1")).toMatchObject({ kind: "group", label: "服务区" });
    expect(result.document.edges[1].style).toMatchObject({ route: "smoothstep", stroke: "#2563EB" });
  });

  it("完整文档哈希识别视觉变化但忽略 viewport", () => {
    const a = createBlankFlowchartDocument();
    const moved: FlowchartDocument = {
      ...a,
      nodes: a.nodes.map((node, index) => index === 0 ? { ...node, position: { x: 80, y: 40 } } : node),
    };
    const viewed: FlowchartDocument = { ...a, viewport: { x: 100, y: 50, zoom: 2 } };
    expect(computeFlowchartSemanticHash(a)).toBe(computeFlowchartSemanticHash(moved));
    expect(computeFlowchartDocumentHash(a)).not.toBe(computeFlowchartDocumentHash(moved));
    expect(computeFlowchartDocumentHash(a)).toBe(computeFlowchartDocumentHash(viewed));
  });

  it("用户修改视觉后拒绝旧 patch", () => {
    const source = createBlankFlowchartDocument();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{ name: "setTheme", theme: { stylePreset: "soft", paletteId: "green", preserveManualStyles: true } }],
    };
    source.nodes[0].position.x += 10;
    const result = applyFlowchartPatch(source, patch);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("布局或样式");
  });

  it("局部视觉操作只改变目标节点和边", () => {
    const source = createBlankFlowchartDocument();
    source.edges = [{ id: "e1", source: "n-start", target: "n-end" }];
    const untouched = structuredClone(source.nodes[1]);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [
        { name: "updateNode", id: "n-start", expectedLabel: "开始", patch: { icon: "user", style: { fill: "#DBEAFE", bold: true } } },
        { name: "updateEdge", id: "e1", expected: { source: "n-start", target: "n-end" }, patch: { style: { stroke: "#2563EB", route: "smoothstep" } } },
      ],
    };
    const result = applyFlowchartPatch(source, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0]).toMatchObject({ icon: "user", style: { fill: "#DBEAFE", bold: true } });
    expect(result.document.nodes[1]).toEqual(untouched);
    expect(result.document.edges[0].style).toMatchObject({ stroke: "#2563EB", route: "smoothstep" });
  });

  it("完整 blueprint 能创建多泳道并布局所属节点", () => {
    const source = createBlankFlowchartDocument();
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "LR",
          layout: "auto",
          nodes: [
            { id: "request", kind: "start", label: "提交申请", laneId: "lane-user", icon: "user" },
            { id: "review", kind: "process", label: "主管审批", laneId: "lane-manager", icon: "check" },
            { id: "archive", kind: "database", label: "系统归档", laneId: "lane-system", icon: "database" },
          ],
          edges: [
            { id: "e1", source: "request", target: "review" },
            { id: "e2", source: "review", target: "archive", label: "通过" },
          ],
          pools: [{
            id: "pool",
            label: "申请流程",
            orientation: "horizontal",
            lanes: [
              { id: "lane-user", label: "员工" },
              { id: "lane-manager", label: "主管" },
              { id: "lane-system", label: "系统" },
            ],
          }],
        },
      }],
    };
    const result = applyFlowchartPatch(source, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.filter((node) => node.kind === "swimlane-lane")).toHaveLength(3);
    expect(result.document.nodes.find((node) => node.id === "review")?.parentId).toBe("lane-manager");
    expect(result.document.nodes.find((node) => node.id === "pool")?.size?.height).toBeGreaterThan(0);
    const lanePositions = result.document.nodes
      .filter((node) => node.kind === "swimlane-lane")
      .map((node) => node.position.y);
    expect(new Set(lanePositions).size).toBe(3);
    expect(flowchartNodeAbsolutePosition(result.document.nodes, "request")!.x)
      .toBeLessThan(flowchartNodeAbsolutePosition(result.document.nodes, "archive")!.x);
  });

  it("拒绝未知图标、非法颜色和缺少坐标的 manual blueprint", () => {
    const invalidIcon = parseFlowchartPatch(patchText({
      baseHash: "h1",
      ops: [{ name: "addNode", node: { id: "n1", kind: "process", label: "x", icon: "brand-logo" } }],
    }));
    expect(invalidIcon.ok).toBe(false);

    const invalidColor = parseFlowchartPatch(patchText({
      baseHash: "h1",
      ops: [{ name: "updateNode", id: "n1", expectedLabel: "x", patch: { style: { fill: "url(http://x)" } } }],
    }));
    expect(invalidColor.ok).toBe(false);

    const missingPosition = parseFlowchartPatch(patchText({
      baseHash: "h1",
      ops: [{ name: "replaceGraph", graph: { direction: "TB", layout: "manual", nodes: [{ id: "n1", kind: "start", label: "x" }], edges: [] } }],
    }));
    expect(missingPosition.ok).toBe(false);

    const missingDocumentHash = parseFlowchartPatch(patchText({
      baseHash: "h1",
      ops: [{ name: "setTheme", theme: { stylePreset: "soft", paletteId: "green", preserveManualStyles: true } }],
    }));
    expect(missingDocumentHash.ok).toBe(false);
    if (!missingDocumentHash.ok) expect(missingDocumentHash.message).toContain("baseDocumentHash");
  });

  it("反馈边走外侧且重复执行保持控制点不变", () => {
    const doc = createBlankFlowchartDocument();
    doc.edges = [{ id: "feedback", source: "n-end", target: "n-start" }];
    routeFlowchartEdges(doc);
    const first = structuredClone(doc.edges[0]);
    const source = { ...doc.nodes[1].position, ...getFlowchartShapeDefaultSize(doc.nodes[1].kind) };
    const target = { ...doc.nodes[0].position, ...getFlowchartShapeDefaultSize(doc.nodes[0].kind) };
    const segments = flowchartEdgeSegments(first, source, target);
    expect(segments.some(({ from, to }) => Math.max(from.x, to.x) > Math.max(source.width, target.width))).toBe(true);
    routeFlowchartEdges(doc);
    expect(doc.edges[0]).toEqual(first);
  });

  it("正交边遇到中间节点时自动绕开", () => {
    const doc = createBlankFlowchartDocument();
    doc.direction = "LR";
    doc.nodes = [
      { id: "a", kind: "process", label: "A", position: { x: 0, y: 100 }, size: { width: 120, height: 60 } },
      { id: "middle", kind: "process", label: "M", position: { x: 200, y: 100 }, size: { width: 120, height: 60 } },
      { id: "b", kind: "process", label: "B", position: { x: 400, y: 100 }, size: { width: 120, height: 60 } },
    ];
    doc.edges = [{ id: "e", source: "a", target: "b", sourceHandle: "right-source", targetHandle: "left-target" }];
    routeFlowchartEdges(doc);
    expect(doc.edges[0]).toMatchObject({ sourceHandle: "right-source", targetHandle: "left-target" });
    expect(doc.edges[0].controlPoints?.length).toBeGreaterThan(0);
    expect(inspectFlowchartQuality(doc).some((issue) => issue.code === "edge-through-node")).toBe(false);
    doc.nodes.find((node) => node.id === "middle")!.position.y = 260;
    routeFlowchartEdges(doc);
    expect(doc.edges[0].controlPoints).toBeUndefined();
    expect(doc.edges[0].autoRouted).toBeUndefined();
  });

  it("分区可局部新增、改成员和删除，并始终保留成员节点", () => {
    let doc = createBlankFlowchartDocument();
    doc.nodes.push({ id: "n-extra", kind: "process", label: "补充", position: { x: 320, y: 160 } });
    const add = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      baseDocumentHash: computeFlowchartDocumentHash(doc),
      ops: [{
        name: "addGroup",
        group: { id: "g", label: "主模块", memberIds: ["n-start", "n-end"], style: { fill: "#EEF2FF" } },
      }],
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    doc = add.document;
    expect(doc.nodes.filter((node) => node.parentId === "g").map((node) => node.id).sort()).toEqual(["n-end", "n-start"]);

    const update = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      baseDocumentHash: computeFlowchartDocumentHash(doc),
      ops: [{
        name: "updateGroup",
        id: "g",
        expectedLabel: "主模块",
        patch: { label: "核心模块", memberIds: ["n-start", "n-extra"] },
      }],
    });
    expect(update.ok).toBe(true);
    if (!update.ok) return;
    doc = update.document;
    expect(doc.nodes.find((node) => node.id === "n-end")?.parentId).toBeUndefined();
    expect(doc.nodes.filter((node) => node.parentId === "g").map((node) => node.id).sort()).toEqual(["n-extra", "n-start"]);

    const remove = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc),
      baseDocumentHash: computeFlowchartDocumentHash(doc),
      ops: [{ name: "removeGroup", id: "g", expectedLabel: "核心模块" }],
    });
    expect(remove.ok).toBe(true);
    if (!remove.ok) return;
    expect(remove.document.nodes.some((node) => node.id === "g")).toBe(false);
    expect(remove.document.nodes.filter((node) => ["n-start", "n-end", "n-extra"].includes(node.id))).toHaveLength(3);
    expect(remove.document.nodes.filter((node) => node.parentId !== undefined)).toHaveLength(0);
  });
});
