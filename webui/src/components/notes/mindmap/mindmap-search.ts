/**
 * 思维导图查找与替换的纯函数匹配逻辑。
 *
 * 设计目标：
 *   - 不依赖 DOM 或 Mind Elixir 实例，可在导图视图和大纲视图复用；
 *   - 支持大小写敏感/不敏感、字面量匹配；
 *   - 返回结构化匹配结果，由调用方负责高亮和滚动定位。
 *
 * 见 docs/plans/mindmap-dev-plan.md §6.4。
 */

import type { MindMapNode } from "./mindmap-outline";

/** 单次匹配结果 */
export interface SearchMatch {
  /** 匹配到的节点 ID */
  nodeId: string;
  /** 节点完整 topic */
  topic: string;
  /** 匹配起始位置（字符偏移） */
  start: number;
  /** 匹配结束位置（不含） */
  end: number;
}

export interface SearchOptions {
  /** 是否区分大小写，默认 false */
  caseSensitive?: boolean;
}

/** 遍历树收集所有节点（深度优先，按 children 顺序） */
export function collectAllNodes(root: MindMapNode): MindMapNode[] {
  const result: MindMapNode[] = [];
  const walk = (node: MindMapNode) => {
    result.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return result;
}

/**
 * 在单条 topic 中查找所有匹配位置。
 */
function findInTopic(topic: string, query: string, caseSensitive: boolean): Array<{ start: number; end: number }> {
  if (query.length === 0) return [];
  const haystack = caseSensitive ? topic : topic.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const positions: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push({ start: idx, end: idx + needle.length });
    from = idx + needle.length;
  }
  return positions;
}

/**
 * 在整棵树中查找匹配节点。
 * 返回按深度优先顺序排列的匹配列表。
 */
export function searchInTree(root: MindMapNode, query: string, options: SearchOptions = {}): SearchMatch[] {
  const caseSensitive = options.caseSensitive ?? false;
  if (query.length === 0) return [];
  const matches: SearchMatch[] = [];
  for (const node of collectAllNodes(root)) {
    const positions = findInTopic(node.topic, query, caseSensitive);
    for (const pos of positions) {
      matches.push({
        nodeId: node.id,
        topic: node.topic,
        start: pos.start,
        end: pos.end,
      });
    }
  }
  return matches;
}

/**
 * 替换单个节点的 topic（返回新 topic 字符串，不修改原节点）。
 *
 * 只替换该节点中第一个匹配（配合查找面板的"替换"按钮，逐个替换）。
 * 如果该节点没有匹配则原样返回。
 */
export function replaceFirstInTopic(topic: string, query: string, replacement: string, options: SearchOptions = {}): string {
  const caseSensitive = options.caseSensitive ?? false;
  if (query.length === 0) return topic;
  const positions = findInTopic(topic, query, caseSensitive);
  if (positions.length === 0) return topic;
  const pos = positions[0];
  return topic.slice(0, pos.start) + replacement + topic.slice(pos.end);
}

/**
 * 替换节点中所有匹配（用于"全部替换"）。
 */
export function replaceAllInTopic(topic: string, query: string, replacement: string, options: SearchOptions = {}): string {
  const caseSensitive = options.caseSensitive ?? false;
  if (query.length === 0) return topic;
  const positions = findInTopic(topic, query, caseSensitive);
  if (positions.length === 0) return topic;
  // 从后往前替换，避免偏移变化
  let result = topic;
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    result = result.slice(0, pos.start) + replacement + result.slice(pos.end);
  }
  return result;
}

/**
 * 计算整棵树的"全部替换"变更集。
 * 返回需要修改的节点列表（nodeId → 新 topic），不修改原树。
 */
export interface ReplaceAllChange {
  nodeId: string;
  oldTopic: string;
  newTopic: string;
  matchCount: number;
}

export function computeReplaceAllChanges(root: MindMapNode, query: string, replacement: string, options: SearchOptions = {}): ReplaceAllChange[] {
  const caseSensitive = options.caseSensitive ?? false;
  if (query.length === 0) return [];
  const changes: ReplaceAllChange[] = [];
  for (const node of collectAllNodes(root)) {
    const positions = findInTopic(node.topic, query, caseSensitive);
    if (positions.length === 0) continue;
    const newTopic = replaceAllInTopic(node.topic, query, replacement, options);
    changes.push({
      nodeId: node.id,
      oldTopic: node.topic,
      newTopic,
      matchCount: positions.length,
    });
  }
  return changes;
}
