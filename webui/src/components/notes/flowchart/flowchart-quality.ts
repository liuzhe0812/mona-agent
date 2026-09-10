import {
  isFlowchartContainerKind,
  type FlowchartDocument,
  type FlowchartNode,
} from "./flowchart-document";
import { flowchartNodeAbsolutePosition } from "./flowchart-operations";
import { getFlowchartShapeDefaultSize } from "./flowchart-shapes";
import {
  flowchartEdgeLabelBox,
  flowchartEdgeSegments,
  sharedRouteLength,
  type FlowchartRouteSegment,
} from "./flowchart-edge-geometry";

export type FlowchartQualityIssueCode =
  | "node-overlap"
  | "text-overflow"
  | "edge-through-node"
  | "page-overflow"
  | "edge-page-overflow"
  | "duplicate-route"
  | "edge-overlap"
  | "label-overlap"
  | "overview-too-small"
  | "group-member-outside"
  | "group-title-overlap"
  | "render-missing-node"
  | "render-missing-edge"
  | "duplicate-terminal";

export interface FlowchartQualityIssue {
  code: FlowchartQualityIssueCode;
  severity: "warning" | "error";
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
}

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

const NODE_PADDING_X = 24;
const NODE_PADDING_Y = 18;
const ICON_WIDTH = 30;

function textUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    if (char === "\n") continue;
    units += /[\u2e80-\uffff]/u.test(char) ? 1 : 0.56;
  }
  return units;
}

/** 给自动布局节点提供与文字、字号和图标匹配的最小尺寸。 */
export function recommendedFlowchartNodeSize(
  node: Pick<FlowchartNode, "kind" | "label" | "style" | "icon" | "size" | "decorative">,
  maxWidth = 320,
): { width: number; height: number } {
  const catalogSize = getFlowchartShapeDefaultSize(node.kind);
  const compactSize = (() => {
    if (["start", "end", "terminator", "process", "alternate-process", "predefined-process", "subprocess"].includes(node.kind)) {
      return { width: 160, height: 64 };
    }
    if (node.kind === "decision" || node.kind === "diamond-basic") return { width: 160, height: 88 };
    if (["database", "document", "multi-document", "stored-data"].includes(node.kind)) return { width: 170, height: 76 };
    return { width: Math.min(catalogSize.width, 180), height: Math.min(catalogSize.height, 80) };
  })();
  const base = node.size ?? compactSize;
  if (isFlowchartContainerKind(node.kind) || node.kind === "freehand" || node.kind === "image" || node.decorative) {
    return base;
  }
  const fontSize = node.style?.fontSize ?? 14;
  const explicitLines = Math.max(1, node.label.split("\n").length);
  const longest = Math.max(0, ...node.label.split("\n").map(textUnits));
  const iconWidth = node.icon ? ICON_WIDTH : 0;
  const paddingX = node.kind === "text" ? 2 : NODE_PADDING_X;
  const paddingY = node.kind === "text" ? 2 : NODE_PADDING_Y;
  const widthLimit = node.size ? Math.max(maxWidth, node.size.width) : maxWidth;
  const desiredWidth = Math.min(widthLimit, Math.max(base.width, longest * fontSize + paddingX + iconWidth));
  const usableWidth = Math.max(36, desiredWidth - paddingX - iconWidth);
  const wrappedLines = Math.max(explicitLines, Math.ceil((textUnits(node.label) * fontSize) / usableWidth));
  const lineHeight = fontSize * (node.style?.lineHeight ?? 1.35);
  const desiredHeight = Math.max(base.height, wrappedLines * lineHeight + paddingY);
  return {
    width: Math.ceil(desiredWidth),
    height: Math.ceil(desiredHeight),
  };
}

function nodeBox(doc: FlowchartDocument, node: FlowchartNode): Box {
  const position = flowchartNodeAbsolutePosition(doc.nodes, node.id) ?? node.position;
  const size = node.size ?? getFlowchartShapeDefaultSize(node.kind);
  return { id: node.id, x: position.x, y: position.y, width: size.width, height: size.height };
}

function overlaps(a: Pick<Box, "x" | "y" | "width" | "height">, b: Pick<Box, "x" | "y" | "width" | "height">, gap = 2): boolean {
  return a.x + gap < b.x + b.width
    && a.x + a.width > b.x + gap
    && a.y + gap < b.y + b.height
    && a.y + a.height > b.y + gap;
}

function segmentIntersectsBox(a: Point, b: Point, box: Box, padding = 4): boolean {
  const left = box.x - padding;
  const right = box.x + box.width + padding;
  const top = box.y - padding;
  const bottom = box.y + box.height + padding;
  if (a.x === b.x) {
    return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  }
  if (a.y === b.y) {
    return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  }
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0 && q < 0) return false;
    if (p === 0) continue;
    const ratio = q / p;
    if (p < 0) t0 = Math.max(t0, ratio);
    else t1 = Math.min(t1, ratio);
    if (t0 > t1) return false;
  }
  return true;
}

function labelOverflows(node: FlowchartNode): boolean {
  if (!node.label.trim() || isFlowchartContainerKind(node.kind) || node.kind === "image" || node.kind === "freehand") {
    return false;
  }
  const size = node.size ?? getFlowchartShapeDefaultSize(node.kind);
  const fontSize = node.style?.fontSize ?? 14;
  const lineHeight = fontSize * (node.style?.lineHeight ?? 1.35);
  const iconWidth = node.icon ? ICON_WIDTH : 0;
  const paddingX = node.kind === "text" ? 2 : NODE_PADDING_X;
  const paddingY = node.kind === "text" ? 2 : NODE_PADDING_Y;
  const usableWidth = Math.max(24, size.width - paddingX - iconWidth);
  const capacity = usableWidth / fontSize;
  const lines = node.label.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil(textUnits(line) / Math.max(1, capacity))),
    0,
  );
  return lines * lineHeight + paddingY > size.height + 1;
}

export function inspectFlowchartQuality(doc: FlowchartDocument): FlowchartQualityIssue[] {
  const issues: FlowchartQualityIssue[] = [];
  const boxes = new Map(doc.nodes.map((node) => [node.id, nodeBox(doc, node)]));
  const drawable = doc.nodes.filter((node) => !isFlowchartContainerKind(node.kind));
  const ordinary = drawable.filter((node) => !node.decorative);

  for (const group of doc.nodes.filter((node) => node.kind === "group")) {
    const groupBox = boxes.get(group.id)!;
    const members = ordinary.filter((node) => node.parentId === group.id);
    for (const member of members) {
      const box = boxes.get(member.id)!;
      if (box.x < groupBox.x - 1
          || box.y < groupBox.y - 1
          || box.x + box.width > groupBox.x + groupBox.width + 1
          || box.y + box.height > groupBox.y + groupBox.height + 1) {
        issues.push({
          code: "group-member-outside",
          severity: "error",
          message: `分区 ${group.id} 未完整包住成员 ${member.id}`,
          nodeIds: [group.id, member.id],
        });
      }
      if (group.label.trim() && member.position.y < 30) {
        issues.push({
          code: "group-title-overlap",
          severity: "error",
          message: `分区 ${group.id} 的标题区与成员 ${member.id} 重叠`,
          nodeIds: [group.id, member.id],
        });
      }
    }
  }

  const terminalsByLabel = new Map<string, FlowchartNode[]>();
  for (const node of ordinary.filter((candidate) => candidate.kind === "end")) {
    const label = node.label.trim().replace(/\s+/g, " ");
    if (!label) continue;
    const terminals = terminalsByLabel.get(label) ?? [];
    terminals.push(node);
    terminalsByLabel.set(label, terminals);
  }
  for (const [label, terminals] of terminalsByLabel) {
    if (terminals.length < 2) continue;
    issues.push({
      code: "duplicate-terminal",
      severity: "warning",
      message: `存在 ${terminals.length} 个同名终点“${label}”，若表示同一结果应合并`,
      nodeIds: terminals.map((node) => node.id).sort(),
    });
  }

  if (doc.canvas.mode === "infinite" && ordinary.length > 0) {
    const ordinaryBoxes = ordinary.map((node) => boxes.get(node.id)!);
    const minX = Math.min(...ordinaryBoxes.map((box) => box.x));
    const minY = Math.min(...ordinaryBoxes.map((box) => box.y));
    const maxX = Math.max(...ordinaryBoxes.map((box) => box.x + box.width));
    const maxY = Math.max(...ordinaryBoxes.map((box) => box.y + box.height));
    const requiredFit = Math.min(1000 / Math.max(1, maxX - minX + 96), 650 / Math.max(1, maxY - minY + 96), 1);
    if (requiredFit < 0.5) {
      issues.push({
        code: "overview-too-small",
        severity: "warning",
        message: `整图适应常用视口时约为 ${Math.round(requiredFit * 100)}%，建议压缩布局或拆分阶段`,
        nodeIds: ordinary.map((node) => node.id).sort(),
      });
    }
  }

  for (let i = 0; i < ordinary.length; i++) {
    for (let j = i + 1; j < ordinary.length; j++) {
      const a = ordinary[i];
      const b = ordinary[j];
      if ((a.parentId ?? null) !== (b.parentId ?? null)) continue;
      if (overlaps(boxes.get(a.id)!, boxes.get(b.id)!)) {
        issues.push({
          code: "node-overlap",
          severity: "error",
          message: `节点 ${a.id} 与 ${b.id} 重叠`,
          nodeIds: [a.id, b.id],
        });
      }
    }
  }

  for (const node of ordinary) {
    if (labelOverflows(node)) {
      issues.push({
        code: "text-overflow",
        severity: "error",
        message: `节点 ${node.id} 的文字可能超出可用区域`,
        nodeIds: [node.id],
      });
    }
  }

  for (const node of drawable) {
    if (doc.canvas.mode === "page" && doc.canvas.width && doc.canvas.height) {
      const box = boxes.get(node.id)!;
      if (box.x < 0 || box.y < 0 || box.x + box.width > doc.canvas.width || box.y + box.height > doc.canvas.height) {
        issues.push({
          code: "page-overflow",
          severity: "error",
          message: `节点 ${node.id} 超出页面范围`,
          nodeIds: [node.id],
        });
      }
    }
  }

  const edgeSegments = new Map<string, FlowchartRouteSegment[]>();
  for (const edge of doc.edges) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;
    const segments = flowchartEdgeSegments(edge, source, target);
    edgeSegments.set(edge.id, segments);
    const routePoints = segments.flatMap((segment) => [segment.from, segment.to]);
    if (doc.canvas.mode === "page" && doc.canvas.width && doc.canvas.height && routePoints.some(
      (point) => point.x < 0 || point.y < 0 || point.x > doc.canvas.width! || point.y > doc.canvas.height!,
    )) {
      issues.push({
        code: "edge-page-overflow",
        severity: "error",
        message: `连线 ${edge.id} 超出页面范围`,
        edgeIds: [edge.id],
      });
    }
    const crossed: string[] = [];
    for (const node of ordinary) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const box = boxes.get(node.id)!;
      if (segments.some((segment) => segmentIntersectsBox(segment.from, segment.to, box))) {
        crossed.push(node.id);
      }
    }
    if (crossed.length > 0) {
      issues.push({
        code: "edge-through-node",
        severity: "error",
        message: `连线 ${edge.id} 穿过节点 ${crossed.join("、")}`,
        nodeIds: crossed,
        edgeIds: [edge.id],
      });
    }
  }

  const routeOwners = new Map<string, string>();
  const routeMembers = new Map<string, string[]>();
  const duplicatePairs = new Set<string>();
  for (const edge of doc.edges) {
    const routeKey = JSON.stringify([
      edge.source,
      edge.target,
      edge.sourceHandle ?? "",
      edge.targetHandle ?? "",
      edge.style?.route ?? "smoothstep",
      edge.controlPoints ?? [],
      edge.sourcePort ?? 0.5,
      edge.targetPort ?? 0.5,
    ]);
    const previous = routeOwners.get(routeKey);
    if (previous) {
      for (const member of routeMembers.get(routeKey) ?? [previous]) {
        duplicatePairs.add(`${member}\u0000${edge.id}`);
      }
      issues.push({
        code: "duplicate-route",
        severity: "error",
        message: `连线 ${previous} 与 ${edge.id} 使用相同路径`,
        edgeIds: [previous, edge.id],
      });
    } else {
      routeOwners.set(routeKey, edge.id);
    }
    const members = routeMembers.get(routeKey) ?? [];
    members.push(edge.id);
    routeMembers.set(routeKey, members);
  }

  for (let i = 0; i < doc.edges.length; i++) {
    const edgeA = doc.edges[i];
    const segmentsA = edgeSegments.get(edgeA.id);
    if (!segmentsA?.length) continue;
    for (let j = i + 1; j < doc.edges.length; j++) {
      const edgeB = doc.edges[j];
      if (duplicatePairs.has(`${edgeA.id}\u0000${edgeB.id}`)) continue;
      const segmentsB = edgeSegments.get(edgeB.id);
      if (!segmentsB?.length) continue;
      const sharedLength = sharedRouteLength(segmentsA, segmentsB);
      if (sharedLength <= 16) continue;
      issues.push({
        code: "edge-overlap",
        severity: "error",
        message: `连线 ${edgeA.id} 与 ${edgeB.id} 共线重合约 ${Math.round(sharedLength)}px`,
        edgeIds: [edgeA.id, edgeB.id],
      });
    }
  }

  const labelBoxes = doc.edges.flatMap((edge) => {
    const segments = edgeSegments.get(edge.id);
    const box = segments ? flowchartEdgeLabelBox(edge, segments) : null;
    return box ? [{ edge, box }] : [];
  });
  for (let i = 0; i < labelBoxes.length; i++) {
    const { edge, box } = labelBoxes[i];
    for (const node of ordinary) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const nodeBoxValue = boxes.get(node.id)!;
      if (overlaps(box, nodeBoxValue, 0)) {
        issues.push({
          code: "label-overlap",
          severity: "warning",
          message: `连线 ${edge.id} 的标签遮挡节点 ${node.id}`,
          nodeIds: [node.id],
          edgeIds: [edge.id],
        });
      }
    }
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const other = labelBoxes[j];
      if (!overlaps(box, other.box, 0)) continue;
      issues.push({
        code: "label-overlap",
        severity: "warning",
        message: `连线 ${edge.id} 与 ${other.edge.id} 的标签互相遮挡`,
        edgeIds: [edge.id, other.edge.id],
      });
    }
  }
  return issues.sort((a, b) => {
    const ak = `${a.code}|${(a.nodeIds ?? []).join(",")}|${(a.edgeIds ?? []).join(",")}`;
    const bk = `${b.code}|${(b.nodeIds ?? []).join(",")}|${(b.edgeIds ?? []).join(",")}`;
    return ak.localeCompare(bk);
  });
}
