/**
 * 流程图文档 v1 → v2 纯迁移（FC-DOC-03）。
 *
 * 规则：
 * - v1 顶层字段原样保留；
 * - 补 canvas / theme 默认值；
 * - 节点补默认 zIndex（按数组顺序保持原有层叠）；
 * - 样式、图片路径、freehand 数据、边、Handle、viewport 原样保留；
 * - 纯函数：相同输入产生相同输出，多次迁移结果一致（幂等）；
 * - 不删除任何未知字段（除 version 升级外浅拷贝原样传递）。
 */

import {
  normalizeFlowchartCanvas,
  normalizeFlowchartTheme,
} from "./flowchart-document";

/** 迁移入口：输入 v1 原始 JSON 对象，输出带默认值的 v2 原始 JSON 对象。 */
export function migrateFlowchartV1ToV2(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const nodes = Array.isArray(raw.nodes)
    ? raw.nodes.map((n, index) => {
        if (typeof n !== "object" || n === null || Array.isArray(n)) return n;
        const node = { ...(n as Record<string, unknown>) };
        if (node.zIndex === undefined) node.zIndex = index;
        return node;
      })
    : raw.nodes;

  return {
    ...raw,
    version: 2,
    canvas: normalizeFlowchartCanvas(raw.canvas),
    theme: normalizeFlowchartTheme(raw.theme),
    nodes,
  };
}
