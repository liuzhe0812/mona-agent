/**
 * ELK 自动布局：把 v2 图表文档映射为 ELK 层次图，回读坐标生成 applyLayout 载荷。
 *
 * 规范（见 AI_EDITABLE_DIAGRAM_CANVAS_PRODUCTION_PLAN.md §8.4、§17.2）：
 * 1. 结构化图（flowchart/architecture/erd 等）使用 ELK Layered；
 * 2. group/container 作为 ELK 复合节点，子元素坐标为相对父节点坐标；
 * 3. freehand（手绘笔迹）不参与自动布局，保持原位；
 * 4. 布局结果只产出 DiagramLayoutEntry[]，由调用方通过 applyLayout 命令提交，
 *    保证一次布局形成一个撤销单元；
 * 5. ELK 参数不暴露给 Agent；direction 只接受 TB/LR。
 *
 * 说明：当前在主线程运行 elkjs（JS 编译版，异步 API）。若 M/L 档性能测试
 * 显示阻塞，再迁移到 Web Worker，布局输入输出契约不变。
 */

import ELK from "elkjs/lib/elk.bundled.js";

import type { DiagramDocument, DiagramElement } from "../diagram-document";
import type { DiagramLayoutEntry } from "../diagram-commands";

// elkjs 类型定义（elk.bundled.js 无 .d.ts，按使用面收窄声明）
interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
}

const elk = new ELK();

/** 不参与自动布局的元素类型（手绘笔迹保持原位）。 */
const LAYOUT_EXCLUDED_TYPES: ReadonlySet<DiagramElement["type"]> = new Set([
  "freehand",
  "lifeline",
  "activation",
]);

/** 判断元素是否参与自动布局。 */
export function isLayoutParticipating(el: DiagramElement): boolean {
  return !LAYOUT_EXCLUDED_TYPES.has(el.type) && !el.hidden;
}

export interface DiagramLayoutOptions {
  /** 布局方向，默认取 doc.layout?.direction ?? "TB"。 */
  direction?: "TB" | "LR";
  /** 只布局这些元素及其相关子树；缺省布局全部参与元素。 */
  onlyIds?: readonly string[];
}

/**
 * 计算整图布局，返回绝对坐标的 DiagramLayoutEntry[]。
 * 调用方负责把结果提交为 applyLayout 命令。
 */
export async function computeDiagramLayout(
  doc: DiagramDocument,
  options: DiagramLayoutOptions = {},
): Promise<DiagramLayoutEntry[]> {
  const direction = options.direction ?? doc.layout?.direction ?? "TB";
  const participating = doc.elements.filter(isLayoutParticipating);
  if (participating.length === 0) return [];

  const only = options.onlyIds ? new Set(options.onlyIds) : null;
  const byId = new Map(participating.map((el) => [el.id, el]));
  const isGroupLike = (el: DiagramElement) => el.type === "group" || el.type === "container";

  // 构建 ELK 层次图：group/container 为复合节点，子元素挂为其 children
  const elkNodeById = new Map<string, ElkNode>();
  for (const el of participating) {
    if (only && !only.has(el.id) && !isGroupLike(el)) continue;
    elkNodeById.set(el.id, {
      id: el.id,
      width: el.size.width,
      height: el.size.height,
      ...(isGroupLike(el) ? { children: [] } : {}),
    });
  }

  const roots: ElkNode[] = [];
  for (const el of participating) {
    const node = elkNodeById.get(el.id);
    if (!node) continue;
    const parentEl = el.parentId ? byId.get(el.parentId) : undefined;
    const parentNode = el.parentId ? elkNodeById.get(el.parentId) : undefined;
    if (parentEl && parentNode && isGroupLike(parentEl)) {
      parentNode.children!.push(node);
    } else {
      roots.push(node);
    }
  }

  // 边：两端元素都参与布局才纳入
  const edges = doc.connectors
    .filter(
      (c) =>
        c.source.elementId &&
        c.target.elementId &&
        elkNodeById.has(c.source.elementId) &&
        elkNodeById.has(c.target.elementId),
    )
    .map((c) => ({
      id: c.id,
      sources: [c.source.elementId!],
      targets: [c.target.elementId!],
    }));

  const graph = {
    id: "__root__",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "LR" ? "RIGHT" : "DOWN",
      // 间距对齐现有 dagre 配置（NODE_SEP 90 / RANK_SEP 110 / EDGE_SEP 30）
      "elk.spacing.nodeNode": "90",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.edgeNode": "30",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      // 复合节点内部留白
      "elk.spacing.componentComponent": "40",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    },
    children: roots,
    edges,
  };

  const result = (await elk.layout(graph)) as ElkNode;

  // 回读坐标：ELK 返回相对父节点的坐标，换算为绝对坐标
  const entries: DiagramLayoutEntry[] = [];
  const walk = (node: ElkNode, originX: number, originY: number) => {
    if (node.id === "__root__") {
      for (const child of node.children ?? []) walk(child, 0, 0);
      return;
    }
    const absX = originX + (node.x ?? 0);
    const absY = originY + (node.y ?? 0);
    const el = byId.get(node.id);
    if (!el) return;
    if (!only || only.has(node.id)) {
      const entry: DiagramLayoutEntry = { id: node.id, position: { x: absX, y: absY } };
      // group/container 尺寸可能被 ELK 调整以容纳子节点，回写尺寸
      if (isGroupLike(el) && node.width && node.height) {
        entry.size = { width: node.width, height: node.height };
      }
      entries.push(entry);
    }
    for (const child of node.children ?? []) walk(child, absX, absY);
  };
  walk(result, 0, 0);
  return entries;
}
