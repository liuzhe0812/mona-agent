/**
 * AI 局部 patch 应用器。
 *
 * 数据契约见 docs/design/2026-07-28-ai-mind-map-feature-design.md §6.5。
 *
 * 应用规则：
 *   1. 应用前重新解析当前 contentMarkdown，校验 baseHash 仍匹配；
 *   2. 应用前校验每个 path 仍存在，且节点文本等于 expectedTopic；
 *   3. 单个 op 失败则整个 patch 不应用（原子性）；
 *   4. 应用顺序按 ops 数组顺序，前一个 op 改变树结构后，后续 op 的路径在前一个 op 的新树上计算；
 *   5. 应用后生成新的 Markdown 大纲。
 */

import {
  parseMindMap,
  serializeMindMap,
  findNodeByPath,
  findNodeById,
  generateNodeId,
  computeBaseHash,
  cloneMindMapNode,
  type MindMapNode,
  type ParseMindMapResult,
} from "./mindmap-outline";

/** v1 patch 操作：基于节点路径定位（path 为子节点索引数组，根节点为 []） */
export type PatchOpV1 =
  | { name: "addChild"; path: number[]; topic: string; expectedTopic?: string }
  | { name: "insertSibling"; path: number[]; topic: string; expectedTopic?: string }
  | { name: "updateTopic"; path: number[]; topic: string; expectedTopic?: string }
  | { name: "removeNode"; path: number[]; expectedTopic?: string }
  | { name: "moveNode"; from: number[]; to: number[]; expectedTopic?: string };

/** v2 patch 操作：基于稳定节点 ID 定位（见 docs/plans/mindmap-dev-plan.md §7.4） */
export type PatchOpV2 =
  | { name: "addChild"; parentId: string; topic: string }
  | { name: "insertSibling"; nodeId: string; topic: string }
  | { name: "updateTopic"; nodeId: string; topic: string }
  | { name: "removeNode"; nodeId: string }
  | { name: "moveNode"; fromId: string; toParentId: string };

/** 单个 patch 操作（v1 path 或 v2 ID 定位） */
export type PatchOp = PatchOpV1 | PatchOpV2;

/** 完整 patch 载荷 */
export interface MindMapPatch {
  /** 版本号：1=基于 path，2=基于 ID。省略时按 ops 字段推断 */
  version?: 1 | 2;
  baseHash: string;
  ops: PatchOp[];
}

export type ApplyPatchResult =
  | { ok: true; markdown: string; appliedCount: number }
  | { ok: false; message: string; failedOpIndex?: number };

/**
 * 解析 AI 返回的 mindmap-patch fenced block 内容。
 * 失败时返回错误信息，不抛异常。
 */
export function parsePatch(jsonText: string): { ok: true; patch: MindMapPatch } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, message: "patch JSON 解析失败" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "patch 必须是对象" };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.baseHash !== "string") {
    return { ok: false, message: "patch 缺少 baseHash 字段" };
  }
  if (!Array.isArray(obj.ops)) {
    return { ok: false, message: "patch 缺少 ops 数组" };
  }

  // 版本号：显式声明优先，否则按 ops 字段推断（有 path/from/to 为 v1，有 nodeId/parentId 为 v2）
  let version: 1 | 2 | undefined;
  if (obj.version === 1 || obj.version === 2) version = obj.version;

  const ops: PatchOp[] = [];
  for (let i = 0; i < obj.ops.length; i++) {
    const raw = obj.ops[i] as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: `ops[${i}] 不是对象` };
    }
    const name = raw.name;
    if (typeof name !== "string") {
      return { ok: false, message: `ops[${i}] 缺少 name` };
    }

    const path = raw.path;
    const from = raw.from;
    const to = raw.to;
    const topic = raw.topic;
    const expectedTopic = raw.expectedTopic;
    const nodeId = raw.nodeId;
    const parentId = raw.parentId;
    const fromId = raw.fromId;
    const toParentId = raw.toParentId;

    // 推断版本：v2 优先（有 nodeId/parentId/fromId/toParentId），其次 v1（有 path/from/to）
    const hasV2Field =
      typeof nodeId === "string" ||
      typeof parentId === "string" ||
      typeof fromId === "string" ||
      typeof toParentId === "string";
    const hasV1Field = Array.isArray(path) || Array.isArray(from) || Array.isArray(to);
    let opVersion = version;
    if (opVersion === undefined) {
      if (hasV2Field && !hasV1Field) opVersion = 2;
      else if (hasV1Field && !hasV2Field) opVersion = 1;
      else if (hasV2Field && hasV1Field) {
        return { ok: false, message: `ops[${i}](${name}) 混用 v1 path 和 v2 ID 字段` };
      } else {
        return { ok: false, message: `ops[${i}](${name}) 缺少定位字段（path 或 nodeId/parentId）` };
      }
    }

    // 版本一致性检查：同 patch 内 op 版本必须一致
    if (version === undefined) version = opVersion;
    else if (version !== opVersion) {
      return { ok: false, message: `ops[${i}] 版本与前面 op 不一致` };
    }

    if (opVersion === 2) {
      // v2：基于 ID 定位，不校验 expectedTopic（计划文档 §7.4：不根据 topic 猜测）
      if (name === "addChild") {
        if (typeof parentId !== "string") return { ok: false, message: `ops[${i}](addChild) 缺少 parentId` };
        if (typeof topic !== "string") return { ok: false, message: `ops[${i}](addChild) 缺少 topic` };
        ops.push({ name: "addChild", parentId, topic });
      } else if (name === "insertSibling") {
        if (typeof nodeId !== "string") return { ok: false, message: `ops[${i}](insertSibling) 缺少 nodeId` };
        if (typeof topic !== "string") return { ok: false, message: `ops[${i}](insertSibling) 缺少 topic` };
        ops.push({ name: "insertSibling", nodeId, topic });
      } else if (name === "updateTopic") {
        if (typeof nodeId !== "string") return { ok: false, message: `ops[${i}](updateTopic) 缺少 nodeId` };
        if (typeof topic !== "string") return { ok: false, message: `ops[${i}](updateTopic) 缺少 topic` };
        ops.push({ name: "updateTopic", nodeId, topic });
      } else if (name === "removeNode") {
        if (typeof nodeId !== "string") return { ok: false, message: `ops[${i}](removeNode) 缺少 nodeId` };
        ops.push({ name: "removeNode", nodeId });
      } else if (name === "moveNode") {
        if (typeof fromId !== "string") return { ok: false, message: `ops[${i}](moveNode) 缺少 fromId` };
        if (typeof toParentId !== "string") return { ok: false, message: `ops[${i}](moveNode) 缺少 toParentId` };
        ops.push({ name: "moveNode", fromId, toParentId });
      } else {
        return { ok: false, message: `ops[${i}] 未知操作名: ${name}` };
      }
    } else {
      // v1：基于 path 定位，保留 expectedTopic 校验
      const numArray = (a: unknown): a is number[] =>
        Array.isArray(a) && a.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);

      if (!Array.isArray(path) && name !== "moveNode") {
        return { ok: false, message: `ops[${i}](${name}) 缺少 path 数组` };
      }
      if (name === "moveNode") {
        if (!Array.isArray(from)) {
          return { ok: false, message: `ops[${i}](moveNode) 缺少 from 数组` };
        }
        if (!Array.isArray(to)) {
          return { ok: false, message: `ops[${i}](moveNode) 缺少 to 数组` };
        }
      }
      if ((name === "addChild" || name === "insertSibling" || name === "updateTopic") && typeof topic !== "string") {
        return { ok: false, message: `ops[${i}](${name}) 缺少 topic 字符串` };
      }

      if (name === "addChild") {
        if (!numArray(path)) return { ok: false, message: `ops[${i}](addChild) path 非法` };
        ops.push({
          name: "addChild",
          path,
          topic: topic as string,
          expectedTopic: typeof expectedTopic === "string" ? expectedTopic : undefined,
        });
      } else if (name === "insertSibling") {
        if (!numArray(path)) return { ok: false, message: `ops[${i}](insertSibling) path 非法` };
        ops.push({
          name: "insertSibling",
          path,
          topic: topic as string,
          expectedTopic: typeof expectedTopic === "string" ? expectedTopic : undefined,
        });
      } else if (name === "updateTopic") {
        if (!numArray(path)) return { ok: false, message: `ops[${i}](updateTopic) path 非法` };
        ops.push({
          name: "updateTopic",
          path,
          topic: topic as string,
          expectedTopic: typeof expectedTopic === "string" ? expectedTopic : undefined,
        });
      } else if (name === "removeNode") {
        if (!numArray(path)) return { ok: false, message: `ops[${i}](removeNode) path 非法` };
        ops.push({
          name: "removeNode",
          path,
          expectedTopic: typeof expectedTopic === "string" ? expectedTopic : undefined,
        });
      } else if (name === "moveNode") {
        if (!numArray(from)) return { ok: false, message: `ops[${i}](moveNode) from 非法` };
        if (!numArray(to)) return { ok: false, message: `ops[${i}](moveNode) to 非法` };
        ops.push({
          name: "moveNode",
          from,
          to,
          expectedTopic: typeof expectedTopic === "string" ? expectedTopic : undefined,
        });
      } else {
        return { ok: false, message: `ops[${i}] 未知操作名: ${name}` };
      }
    }
  }

  return { ok: true, patch: { version, baseHash: obj.baseHash, ops } };
}

/**
 * 应用 patch 到当前 contentMarkdown。
 *
 * 应用流程：
 *   1. 重新解析当前 markdown；
 *   2. 校验 baseHash；
 *   3. 逐个应用 ops，每个 op 应用前校验 path 和 expectedTopic；
 *   4. 任一 op 失败则整个 patch 不应用（返回失败，原 markdown 不变）；
 *   5. 全部成功后序列化为新 markdown。
 */
export function applyPatch(
  currentMarkdown: string,
  patch: MindMapPatch,
): ApplyPatchResult {
  // 1. baseHash 校验
  const currentHash = computeBaseHash(currentMarkdown);
  if (patch.baseHash !== currentHash) {
    return {
      ok: false,
      message: `baseHash 不匹配（期望 ${patch.baseHash}，实际 ${currentHash}），导图在 AI 处理期间已被修改`,
    };
  }

  // 2. 解析当前 markdown
  const parsed: ParseMindMapResult = parseMindMap(currentMarkdown);
  if (!parsed.ok) {
    return { ok: false, message: `当前大纲解析失败：第 ${parsed.line} 行 ${parsed.message}` };
  }

  // 3. 深拷贝树，避免修改原对象
  const root: MindMapNode = deepClone(parsed.root);

  // 4. 逐个应用 ops
  for (let i = 0; i < patch.ops.length; i++) {
    const op = patch.ops[i];
    const result = applyOp(root, op);
    if (!result.ok) {
      return {
        ok: false,
        message: `ops[${i}](${op.name}) 失败：${result.message}`,
        failedOpIndex: i,
      };
    }
  }

  // 5. 序列化
  const newMarkdown = serializeMindMap(root);
  return { ok: true, markdown: newMarkdown, appliedCount: patch.ops.length };
}

type ApplyOpResult = { ok: true } | { ok: false; message: string };

function applyOp(root: MindMapNode, op: PatchOp): ApplyOpResult {
  // v2：基于 ID 定位
  if ("parentId" in op || "nodeId" in op || "fromId" in op) {
    return applyOpV2(root, op);
  }
  // v1：基于 path 定位
  return applyOpV1(root, op);
}

/** v2 op 应用：基于稳定节点 ID 定位，不根据 topic 猜测，保留所有未修改元数据 */
function applyOpV2(root: MindMapNode, op: PatchOp): ApplyOpResult {
  if (op.name === "addChild") {
    if (!("parentId" in op)) return { ok: false, message: "addChild 缺少 parentId" };
    const parent = findNodeById(root, op.parentId);
    if (!parent) return { ok: false, message: `parentId ${op.parentId} 不存在` };
    parent.children.push({
      id: generateNodeId(),
      topic: op.topic,
      children: [],
    });
    return { ok: true };
  }

  if (op.name === "insertSibling") {
    if (!("nodeId" in op)) return { ok: false, message: "insertSibling 缺少 nodeId" };
    if (root.id === op.nodeId) return { ok: false, message: "不能在根节点插入同级" };
    const { parent, index } = findNodeParentById(root, op.nodeId);
    if (!parent || index < 0) return { ok: false, message: `nodeId ${op.nodeId} 不存在或为根` };
    parent.children.splice(index + 1, 0, {
      id: generateNodeId(),
      topic: op.topic,
      children: [],
    });
    return { ok: true };
  }

  if (op.name === "updateTopic") {
    if (!("nodeId" in op)) return { ok: false, message: "updateTopic 缺少 nodeId" };
    const node = findNodeById(root, op.nodeId);
    if (!node) return { ok: false, message: `nodeId ${op.nodeId} 不存在` };
    node.topic = op.topic;
    return { ok: true };
  }

  if (op.name === "removeNode") {
    if (!("nodeId" in op)) return { ok: false, message: "removeNode 缺少 nodeId" };
    if (root.id === op.nodeId) return { ok: false, message: "不能删除根节点" };
    const { parent, index } = findNodeParentById(root, op.nodeId);
    if (!parent || index < 0) return { ok: false, message: `nodeId ${op.nodeId} 不存在或为根` };
    parent.children.splice(index, 1);
    return { ok: true };
  }

  if (op.name === "moveNode") {
    if (!("fromId" in op) || !("toParentId" in op)) return { ok: false, message: "moveNode 缺少 fromId/toParentId" };
    if (root.id === op.fromId) return { ok: false, message: "不能移动根节点" };
    const { parent: fromParent, index: fromIndex } = findNodeParentById(root, op.fromId);
    if (!fromParent || fromIndex < 0) return { ok: false, message: `fromId ${op.fromId} 不存在或为根` };
    const sourceNode = fromParent.children[fromIndex];

    const toParent = findNodeById(root, op.toParentId);
    if (!toParent) return { ok: false, message: `toParentId ${op.toParentId} 不存在` };

    // 防止将节点移动到自己的子孙下（会形成环）
    if (isNodeIdAncestorOrSelf(sourceNode, op.toParentId)) {
      return { ok: false, message: "不能将节点移动到自身或其子孙下" };
    }

    fromParent.children.splice(fromIndex, 1);
    toParent.children.push(sourceNode);
    return { ok: true };
  }

  return { ok: false, message: `未知操作: ${(op as { name: string }).name}` };
}

/** v1 op 应用：基于 path 定位，保留 expectedTopic 校验 */
function applyOpV1(root: MindMapNode, op: PatchOp): ApplyOpResult {
  if (op.name === "addChild") {
    if (!("path" in op)) return { ok: false, message: "addChild 缺少 path" };
    const parent = findNodeByPath(root, op.path);
    if (!parent) {
      return { ok: false, message: `path ${JSON.stringify(op.path)} 不存在` };
    }
    if (op.expectedTopic !== undefined && parent.topic !== op.expectedTopic) {
      return {
        ok: false,
        message: `expectedTopic 不匹配（期望 "${op.expectedTopic}"，实际 "${parent.topic}"）`,
      };
    }
    parent.children.push({
      id: generateNodeId(),
      topic: op.topic,
      children: [],
    });
    return { ok: true };
  }

  if (op.name === "insertSibling") {
    if (!("path" in op)) return { ok: false, message: "insertSibling 缺少 path" };
    if (op.path.length === 0) {
      return { ok: false, message: "不能在根节点插入同级" };
    }
    const parentPath = op.path.slice(0, -1);
    const index = op.path[op.path.length - 1];
    const parent = findNodeByPath(root, parentPath);
    if (!parent) {
      return { ok: false, message: `父路径 ${JSON.stringify(parentPath)} 不存在` };
    }
    if (index < 0 || index > parent.children.length) {
      return { ok: false, message: `同级索引 ${index} 越界（父节点有 ${parent.children.length} 个子节点）` };
    }
    if (index < parent.children.length) {
      const existing = parent.children[index];
      if (op.expectedTopic !== undefined && existing.topic !== op.expectedTopic) {
        return {
          ok: false,
          message: `expectedTopic 不匹配（期望 "${op.expectedTopic}"，实际 "${existing.topic}"）`,
        };
      }
    }
    parent.children.splice(index, 0, {
      id: generateNodeId(),
      topic: op.topic,
      children: [],
    });
    return { ok: true };
  }

  if (op.name === "updateTopic") {
    if (!("path" in op)) return { ok: false, message: "updateTopic 缺少 path" };
    const node = findNodeByPath(root, op.path);
    if (!node) {
      return { ok: false, message: `path ${JSON.stringify(op.path)} 不存在` };
    }
    if (op.expectedTopic !== undefined && node.topic !== op.expectedTopic) {
      return {
        ok: false,
        message: `expectedTopic 不匹配（期望 "${op.expectedTopic}"，实际 "${node.topic}"）`,
      };
    }
    node.topic = op.topic;
    return { ok: true };
  }

  if (op.name === "removeNode") {
    if (!("path" in op)) return { ok: false, message: "removeNode 缺少 path" };
    if (op.path.length === 0) {
      return { ok: false, message: "不能删除根节点" };
    }
    const parentPath = op.path.slice(0, -1);
    const index = op.path[op.path.length - 1];
    const parent = findNodeByPath(root, parentPath);
    if (!parent) {
      return { ok: false, message: `父路径 ${JSON.stringify(parentPath)} 不存在` };
    }
    if (index < 0 || index >= parent.children.length) {
      return { ok: false, message: `删除索引 ${index} 越界（父节点有 ${parent.children.length} 个子节点）` };
    }
    const existing = parent.children[index];
    if (op.expectedTopic !== undefined && existing.topic !== op.expectedTopic) {
      return {
        ok: false,
        message: `expectedTopic 不匹配（期望 "${op.expectedTopic}"，实际 "${existing.topic}"）`,
      };
    }
    parent.children.splice(index, 1);
    return { ok: true };
  }

  if (op.name === "moveNode") {
    if (!("from" in op) || !("to" in op)) return { ok: false, message: "moveNode 缺少 from/to" };
    if (op.from.length === 0) {
      return { ok: false, message: "不能移动根节点" };
    }
    const fromParentPath = op.from.slice(0, -1);
    const fromIndex = op.from[op.from.length - 1];
    const fromParent = findNodeByPath(root, fromParentPath);
    if (!fromParent) {
      return { ok: false, message: `源父路径 ${JSON.stringify(fromParentPath)} 不存在` };
    }
    if (fromIndex < 0 || fromIndex >= fromParent.children.length) {
      return { ok: false, message: `源索引 ${fromIndex} 越界` };
    }
    const sourceNode = fromParent.children[fromIndex];
    if (op.expectedTopic !== undefined && sourceNode.topic !== op.expectedTopic) {
      return {
        ok: false,
        message: `expectedTopic 不匹配（期望 "${op.expectedTopic}"，实际 "${sourceNode.topic}"）`,
      };
    }

    const toParent = findNodeByPath(root, op.to);
    if (!toParent) {
      return { ok: false, message: `目标路径 ${JSON.stringify(op.to)} 不存在` };
    }

    if (isAncestorOrSelf(op.from, op.to)) {
      return { ok: false, message: "不能将节点移动到自身或其子孙下" };
    }

    fromParent.children.splice(fromIndex, 1);
    toParent.children.push(sourceNode);
    return { ok: true };
  }

  return { ok: false, message: `未知操作: ${(op as { name: string }).name}` };
}

/**
 * 根据 nodeId 查找其父节点和在父节点 children 中的索引。
 * 找不到或为目标为根节点时返回 { parent: null, index: -1 }。
 */
function findNodeParentById(root: MindMapNode, nodeId: string): { parent: MindMapNode | null; index: number } {
  for (const child of root.children) {
    if (child.id === nodeId) return { parent: root, index: root.children.indexOf(child) };
    const found = findNodeParentById(child, nodeId);
    if (found.parent !== null) return found;
  }
  return { parent: null, index: -1 };
}

/** 判断 targetId 是否是 sourceNode 自身或其子孙（用于 moveNode 防环） */
function isNodeIdAncestorOrSelf(sourceNode: MindMapNode, targetId: string): boolean {
  if (sourceNode.id === targetId) return true;
  for (const child of sourceNode.children) {
    if (isNodeIdAncestorOrSelf(child, targetId)) return true;
  }
  return false;
}

/** 判断 pathA 是否是 pathB 的祖先或自身 */
function isAncestorOrSelf(pathA: number[], pathB: number[]): boolean {
  if (pathA.length > pathB.length) return false;
  for (let i = 0; i < pathA.length; i++) {
    if (pathA[i] !== pathB[i]) return false;
  }
  return true;
}

function deepClone(node: MindMapNode): MindMapNode {
  return cloneMindMapNode(node);
}
