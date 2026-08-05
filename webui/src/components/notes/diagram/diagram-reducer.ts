/**
 * 图表统一命令执行器（DiagramReducer）、状态与历史。
 *
 * 规范（见计划 §8）：
 * 1. 人工 UI 与 Agent patch 共用同一执行路径；Agent 不得绕过 reducer；
 * 2. 命令在文档副本上完整校验后原子提交；任一失败不产生部分修改；
 * 3. 每条成功命令 revision+1、更新完整文档哈希、形成一个撤销历史单元；
 * 4. patch 只能写能力注册表声明的字段；id/type/parentId 不可通过 update 修改；
 * 5. 状态对象不可变：失败返回原引用，成功返回新对象。
 */

import {
  generateDiagramId,
  type DiagramDocument,
  type DiagramElement,
  type DiagramGroupElement,
} from "./diagram-document";
import {
  declaredConnectorFields,
  declaredElementFields,
} from "./diagram-capabilities";
import {
  emptyDiagramCommandSummary,
  type DiagramCommand,
  type DiagramCommandSummary,
  type DiagramReorderAction,
} from "./diagram-commands";
import { computeDiagramDocumentHash } from "./diagram-hash";
import {
  cloneDiagramDocument,
  validateDiagramDocument,
  type DiagramValidationError,
} from "./diagram-validator";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

export interface DiagramState {
  document: DiagramDocument;
  revision: number;
  documentHash: string;
}

export type DiagramCommandResult =
  | { ok: true; state: DiagramState; summary: DiagramCommandSummary }
  | { ok: false; message: string };

/** 深拷贝文档并建立初始状态（revision 0）。 */
export function createDiagramState(doc: DiagramDocument): DiagramState {
  const document = cloneDiagramDocument(doc);
  return { document, revision: 0, documentHash: computeDiagramDocumentHash(document) };
}

function commitState(
  document: DiagramDocument,
  baseRevision: number,
  summary: DiagramCommandSummary,
): DiagramCommandResult {
  return {
    ok: true,
    state: {
      document,
      revision: baseRevision + 1,
      documentHash: computeDiagramDocumentHash(document),
    },
    summary,
  };
}

function formatValidationErrors(errors: DiagramValidationError[]): string {
  return errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
}

/**
 * 在 state 的文档副本上执行命令。
 * 成功返回新 state（revision+1、新哈希、机器可读摘要）；失败返回错误消息，原 state 不变。
 */
export function applyDiagramCommand(
  state: DiagramState,
  command: DiagramCommand,
): DiagramCommandResult {
  // replaceDocument 直接校验输入文档，不经副本合并
  if (command.type === "replaceDocument") {
    const validation = validateDiagramDocument(command.document);
    if (!validation.ok) {
      return {
        ok: false,
        message: `replaceDocument 文档校验失败：${formatValidationErrors(validation.errors)}`,
      };
    }
    const summary = emptyDiagramCommandSummary();
    summary.replacedDocument = true;
    return commitState(cloneDiagramDocument(command.document), state.revision, summary);
  }

  const work = cloneDiagramDocument(state.document);
  const summary = emptyDiagramCommandSummary();
  const error = executeCommand(work, command, summary);
  if (error) return { ok: false, message: error };

  const validation = validateDiagramDocument(work);
  if (!validation.ok) {
    return {
      ok: false,
      message: `命令会产生无效文档：${formatValidationErrors(validation.errors)}`,
    };
  }
  return commitState(work, state.revision, summary);
}

// ---------------------------------------------------------------------------
// 命令执行（就地修改 work 副本；返回错误消息或 null）
// ---------------------------------------------------------------------------

function executeCommand(
  doc: DiagramDocument,
  command: DiagramCommand,
  summary: DiagramCommandSummary,
): string | null {
  switch (command.type) {
    case "addElements":
      return execAddElements(doc, command.elements, summary);
    case "updateElements":
      return execUpdateElements(doc, command.updates, summary);
    case "removeElements":
      return execRemoveElements(doc, command.ids, summary);
    case "addConnectors":
      return execAddConnectors(doc, command, summary);
    case "updateConnectors":
      return execUpdateConnectors(doc, command.updates, summary);
    case "removeConnectors":
      return execRemoveConnectors(doc, command.ids, summary);
    case "groupElements":
      return execGroupElements(doc, command, summary);
    case "ungroupElements":
      return execUngroupElements(doc, command.groupIds, summary);
    case "reparentElements":
      return execReparentElements(doc, command, summary);
    case "reorderElements":
      return execReorderElements(doc, command.ids, command.action, summary);
    case "setCanvas":
      return execSetCanvas(doc, command.patch, summary);
    case "applyLayout":
      return execApplyLayout(doc, command.positions, summary);
    case "attachAssets":
      return execAttachAssets(doc, command.assets, summary);
    case "replaceDocument":
      return "replaceDocument 由 applyDiagramCommand 直接处理";
  }
}

function byIdMap(doc: DiagramDocument): Map<string, DiagramElement> {
  return new Map(doc.elements.map((e) => [e.id, e]));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// 元素命令
// ---------------------------------------------------------------------------

function execAddElements(
  doc: DiagramDocument,
  elements: DiagramElement[],
  summary: DiagramCommandSummary,
): string | null {
  if (elements.length === 0) return "addElements 需要至少一个元素";
  const existing = new Set(doc.elements.map((e) => e.id));
  for (const el of elements) {
    if (existing.has(el.id)) return `元素 id 已存在：${el.id}`;
  }
  doc.elements.push(...elements.map((el) => cloneElement(el)));
  summary.addedElementIds.push(...elements.map((e) => e.id));
  return null;
}

function cloneElement(el: DiagramElement): DiagramElement {
  return JSON.parse(JSON.stringify(el)) as DiagramElement;
}

const ELEMENT_IDENTITY_FIELDS = ["id", "type", "parentId"];

function execUpdateElements(
  doc: DiagramDocument,
  updates: Array<{ id: string; expected?: Record<string, unknown>; patch: Record<string, unknown> }>,
  summary: DiagramCommandSummary,
): string | null {
  if (updates.length === 0) return "updateElements 需要至少一条更新";
  const byId = byIdMap(doc);
  // 第一遍：全部校验，保证原子性
  for (const u of updates) {
    const el = byId.get(u.id);
    if (!el) return `元素不存在：${u.id}`;
    const keys = Object.keys(u.patch);
    if (keys.length === 0) return `元素 ${u.id} 的 patch 为空`;
    const declared = declaredElementFields(el.type);
    for (const key of keys) {
      if (ELEMENT_IDENTITY_FIELDS.includes(key)) {
        return `元素 ${u.id} 不允许通过 updateElements 修改 ${key}（parentId 请用 group/reparent 命令）`;
      }
      if (!declared.includes(key)) {
        return `元素 ${u.id}（${el.type}）patch 含未声明字段：${key}`;
      }
    }
    if (u.expected) {
      for (const [key, value] of Object.entries(u.expected)) {
        if (!deepEqual((el as unknown as Record<string, unknown>)[key], value)) {
          return `元素 ${u.id} 的 ${key} 与 expected 不匹配，内容可能已被修改`;
        }
      }
    }
  }
  // 第二遍：应用
  for (const u of updates) {
    const el = byId.get(u.id)!;
    Object.assign(el, JSON.parse(JSON.stringify(u.patch)));
    summary.updatedElementIds.push(u.id);
  }
  return null;
}

function execRemoveElements(
  doc: DiagramDocument,
  ids: string[],
  summary: DiagramCommandSummary,
): string | null {
  if (ids.length === 0) return "removeElements 需要至少一个 id";
  const existing = new Set(doc.elements.map((e) => e.id));
  for (const id of ids) {
    if (!existing.has(id)) return `元素不存在：${id}`;
  }
  const cascade = computeDiagramRemovalCascade(doc, ids);
  doc.elements = doc.elements.filter((e) => !cascade.elementIds.has(e.id));
  doc.connectors = doc.connectors.filter((c) => !cascade.connectorIds.has(c.id));
  summary.removedElementIds.push(...cascade.elementIds);
  summary.removedConnectorIds.push(...cascade.connectorIds);
  return null;
}

/** 计算删除 id 集合的级联：全部后代元素 + 端点引用这些元素的连接器。 */
export function computeDiagramRemovalCascade(
  doc: DiagramDocument,
  ids: readonly string[],
): { elementIds: Set<string>; connectorIds: Set<string> } {
  const elementIds = new Set<string>(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of doc.elements) {
      if (el.parentId && elementIds.has(el.parentId) && !elementIds.has(el.id)) {
        elementIds.add(el.id);
        changed = true;
      }
    }
  }
  const connectorIds = new Set<string>();
  for (const c of doc.connectors) {
    const s = c.source.elementId;
    const t = c.target.elementId;
    if ((s && elementIds.has(s)) || (t && elementIds.has(t))) {
      connectorIds.add(c.id);
    }
  }
  return { elementIds, connectorIds };
}

// ---------------------------------------------------------------------------
// 连接器命令
// ---------------------------------------------------------------------------

function execAddConnectors(
  doc: DiagramDocument,
  command: { connectors: DiagramDocument["connectors"] },
  summary: DiagramCommandSummary,
): string | null {
  if (command.connectors.length === 0) return "addConnectors 需要至少一个连接器";
  const existing = new Set(doc.connectors.map((c) => c.id));
  for (const c of command.connectors) {
    if (existing.has(c.id)) return `连接器 id 已存在：${c.id}`;
  }
  doc.connectors.push(...command.connectors.map((c) => JSON.parse(JSON.stringify(c)) as DiagramDocument["connectors"][number]));
  summary.addedConnectorIds.push(...command.connectors.map((c) => c.id));
  return null;
}

function execUpdateConnectors(
  doc: DiagramDocument,
  updates: Array<{ id: string; expected?: Record<string, unknown>; patch: Record<string, unknown> }>,
  summary: DiagramCommandSummary,
): string | null {
  if (updates.length === 0) return "updateConnectors 需要至少一条更新";
  const byId = new Map(doc.connectors.map((c) => [c.id, c]));
  const declared = declaredConnectorFields();
  for (const u of updates) {
    const conn = byId.get(u.id);
    if (!conn) return `连接器不存在：${u.id}`;
    const keys = Object.keys(u.patch);
    if (keys.length === 0) return `连接器 ${u.id} 的 patch 为空`;
    for (const key of keys) {
      if (key === "id") return `连接器 ${u.id} 不允许通过 updateConnectors 修改 id`;
      if (!declared.includes(key)) {
        return `连接器 ${u.id} patch 含未声明字段：${key}`;
      }
    }
    if (u.expected) {
      for (const [key, value] of Object.entries(u.expected)) {
        if (!deepEqual((conn as unknown as Record<string, unknown>)[key], value)) {
          return `连接器 ${u.id} 的 ${key} 与 expected 不匹配，内容可能已被修改`;
        }
      }
    }
  }
  for (const u of updates) {
    Object.assign(byId.get(u.id)!, JSON.parse(JSON.stringify(u.patch)));
    summary.updatedConnectorIds.push(u.id);
  }
  return null;
}

function execRemoveConnectors(
  doc: DiagramDocument,
  ids: string[],
  summary: DiagramCommandSummary,
): string | null {
  if (ids.length === 0) return "removeConnectors 需要至少一个 id";
  const existing = new Set(doc.connectors.map((c) => c.id));
  for (const id of ids) {
    if (!existing.has(id)) return `连接器不存在：${id}`;
  }
  const drop = new Set(ids);
  doc.connectors = doc.connectors.filter((c) => !drop.has(c.id));
  summary.removedConnectorIds.push(...ids);
  return null;
}

// ---------------------------------------------------------------------------
// 分组命令
// ---------------------------------------------------------------------------

const GROUP_PADDING = 16;

function execGroupElements(
  doc: DiagramDocument,
  command: { elementIds: string[]; groupId?: string; title?: string },
  summary: DiagramCommandSummary,
): string | null {
  const { elementIds } = command;
  if (elementIds.length === 0) return "groupElements 需要至少一个元素";
  const byId = byIdMap(doc);
  for (const id of elementIds) {
    if (!byId.has(id)) return `元素不存在：${id}`;
  }
  // 禁止同时选中父子元素
  const selected = new Set(elementIds);
  for (const id of elementIds) {
    let cursor = byId.get(id)!.parentId;
    while (cursor !== undefined) {
      if (selected.has(cursor)) return "不能同时选中父子元素进行组合";
      cursor = byId.get(cursor)?.parentId;
    }
  }
  // groupId
  let groupId = command.groupId;
  if (groupId !== undefined) {
    if (byId.has(groupId)) return `元素 id 已存在：${groupId}`;
  } else {
    do {
      groupId = generateDiagramId("group");
    } while (byId.has(groupId));
  }
  // 包围盒
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of elementIds) {
    const el = byId.get(id)!;
    minX = Math.min(minX, el.position.x);
    minY = Math.min(minY, el.position.y);
    maxX = Math.max(maxX, el.position.x + el.size.width);
    maxY = Math.max(maxY, el.position.y + el.size.height);
  }
  const group: DiagramGroupElement = {
    id: groupId,
    type: "group",
    position: { x: minX - GROUP_PADDING, y: minY - GROUP_PADDING },
    size: {
      width: maxX - minX + GROUP_PADDING * 2,
      height: maxY - minY + GROUP_PADDING * 2,
    },
    rotation: 0,
    zIndex: Math.min(...elementIds.map((id) => byId.get(id)!.zIndex)),
  };
  if (command.title !== undefined) group.title = command.title;
  // 父元素必须排在子元素之前：插入到最早选中元素的位置
  const firstIndex = Math.min(...elementIds.map((id) => doc.elements.findIndex((e) => e.id === id)));
  doc.elements.splice(firstIndex, 0, group);
  for (const id of elementIds) {
    byId.get(id)!.parentId = groupId;
  }
  summary.addedElementIds.push(groupId);
  summary.updatedElementIds.push(...elementIds);
  return null;
}

function execUngroupElements(
  doc: DiagramDocument,
  groupIds: string[],
  summary: DiagramCommandSummary,
): string | null {
  if (groupIds.length === 0) return "ungroupElements 需要至少一个 group id";
  const byId = byIdMap(doc);
  for (const id of groupIds) {
    const el = byId.get(id);
    if (!el) return `元素不存在：${id}`;
    if (el.type !== "group") return `ungroupElements 只能解散 group：${id} 是 ${el.type}`;
  }
  const dropped = new Set(groupIds);
  for (const id of groupIds) {
    const group = byId.get(id)!;
    for (const child of doc.elements) {
      if (child.parentId === id) {
        if (group.parentId) child.parentId = group.parentId;
        else delete child.parentId;
        summary.updatedElementIds.push(child.id);
      }
    }
  }
  doc.elements = doc.elements.filter((e) => !dropped.has(e.id));
  // group 本身被删除：级联删除引用它的连接器（子元素保留）
  doc.connectors = doc.connectors.filter((c) => {
    const s = c.source.elementId;
    const t = c.target.elementId;
    const drop = (s !== undefined && dropped.has(s)) || (t !== undefined && dropped.has(t));
    if (drop) summary.removedConnectorIds.push(c.id);
    return !drop;
  });
  summary.removedElementIds.push(...groupIds);
  return null;
}

function execReparentElements(
  doc: DiagramDocument,
  command: { elementIds: string[]; parentId?: string },
  summary: DiagramCommandSummary,
): string | null {
  const { elementIds, parentId } = command;
  if (elementIds.length === 0) return "reparentElements 需要至少一个元素";
  const byId = byIdMap(doc);
  for (const id of elementIds) {
    if (!byId.has(id)) return `元素不存在：${id}`;
  }
  if (parentId !== undefined) {
    const parent = byId.get(parentId);
    if (!parent) return `父元素不存在：${parentId}`;
    if (parent.type !== "group" && parent.type !== "container") {
      return `reparentElements 目标必须是 group/container：${parentId} 是 ${parent.type}`;
    }
    if (elementIds.includes(parentId)) return "不能把元素移动到自身内部";
    for (const id of elementIds) {
      if (isAncestorOf(doc, id, parentId)) {
        return `不能把 ${id} 移动到其子元素内部`;
      }
    }
  }
  for (const id of elementIds) {
    const el = byId.get(id)!;
    if (parentId) el.parentId = parentId;
    else delete el.parentId;
    summary.updatedElementIds.push(id);
  }
  // 父先子后：把被移动元素插入到父元素子树末尾
  if (parentId) {
    const moving = new Set(elementIds);
    const remaining = doc.elements.filter((e) => !moving.has(e.id));
    const subtree = new Set<string>([parentId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of remaining) {
        if (e.parentId && subtree.has(e.parentId) && !subtree.has(e.id)) {
          subtree.add(e.id);
          changed = true;
        }
      }
    }
    let insertAt = 0;
    remaining.forEach((e, i) => {
      if (subtree.has(e.id)) insertAt = i + 1;
    });
    remaining.splice(insertAt, 0, ...elementIds.map((id) => byId.get(id)!));
    doc.elements = remaining;
  }
  return null;
}

/** ancestor 是否是 id 的祖先（沿 parentId 链向上）。 */
function isAncestorOf(doc: DiagramDocument, ancestor: string, id: string): boolean {
  const byId = byIdMap(doc);
  let cursor = byId.get(id)?.parentId;
  while (cursor !== undefined) {
    if (cursor === ancestor) return true;
    cursor = byId.get(cursor)?.parentId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 图层命令
// ---------------------------------------------------------------------------

function execReorderElements(
  doc: DiagramDocument,
  ids: string[],
  action: DiagramReorderAction,
  summary: DiagramCommandSummary,
): string | null {
  if (ids.length === 0) return "reorderElements 需要至少一个元素";
  const byId = byIdMap(doc);
  for (const id of ids) {
    if (!byId.has(id)) return `元素不存在：${id}`;
  }
  const parentKeyOf = (el: DiagramElement) => el.parentId ?? "";
  const parentKey = parentKeyOf(byId.get(ids[0])!);
  for (const id of ids) {
    if (parentKeyOf(byId.get(id)!) !== parentKey) {
      return "reorderElements 只能调整同一父级内的元素";
    }
  }
  const siblings = doc.elements
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => parentKeyOf(el) === parentKey)
    .sort((a, b) => a.el.zIndex - b.el.zIndex || a.index - b.index)
    .map(({ el }) => el);
  const selected = new Set(ids);
  let order: DiagramElement[];
  switch (action) {
    case "front":
      order = [...siblings.filter((e) => !selected.has(e.id)), ...siblings.filter((e) => selected.has(e.id))];
      break;
    case "back":
      order = [...siblings.filter((e) => selected.has(e.id)), ...siblings.filter((e) => !selected.has(e.id))];
      break;
    case "forward": {
      order = [...siblings];
      for (let i = order.length - 2; i >= 0; i--) {
        if (selected.has(order[i].id) && !selected.has(order[i + 1].id)) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
        }
      }
      break;
    }
    case "backward": {
      order = [...siblings];
      for (let i = 1; i < order.length; i++) {
        if (selected.has(order[i].id) && !selected.has(order[i - 1].id)) {
          [order[i], order[i - 1]] = [order[i - 1], order[i]];
        }
      }
      break;
    }
  }
  order.forEach((el, i) => {
    el.zIndex = i;
  });
  summary.updatedElementIds.push(...ids);
  return null;
}

// ---------------------------------------------------------------------------
// 画布 / 布局 / 资产命令
// ---------------------------------------------------------------------------

const CANVAS_PATCH_FIELDS = ["mode", "width", "height", "orientation", "background", "padding", "grid"];

function execSetCanvas(
  doc: DiagramDocument,
  patch: Record<string, unknown>,
  summary: DiagramCommandSummary,
): string | null {
  const keys = Object.keys(patch);
  if (keys.length === 0) return "setCanvas 的 patch 为空";
  for (const key of keys) {
    if (!CANVAS_PATCH_FIELDS.includes(key)) return `setCanvas 含未声明字段：${key}`;
  }
  doc.canvas = { ...doc.canvas, ...(JSON.parse(JSON.stringify(patch)) as object) } as DiagramDocument["canvas"];
  summary.canvasUpdated = true;
  return null;
}

function execApplyLayout(
  doc: DiagramDocument,
  positions: Array<{ id: string; position: { x: number; y: number }; size?: { width: number; height: number } }>,
  summary: DiagramCommandSummary,
): string | null {
  if (positions.length === 0) return "applyLayout 需要至少一个条目";
  const byId = byIdMap(doc);
  for (const entry of positions) {
    if (!byId.has(entry.id)) return `元素不存在：${entry.id}`;
  }
  for (const entry of positions) {
    const el = byId.get(entry.id)!;
    el.position = { x: entry.position.x, y: entry.position.y };
    if (entry.size) el.size = { width: entry.size.width, height: entry.size.height };
    summary.updatedElementIds.push(entry.id);
  }
  summary.layoutApplied = true;
  return null;
}

function execAttachAssets(
  doc: DiagramDocument,
  assets: DiagramDocument["assets"] extends (infer T)[] | undefined ? T[] : never,
  summary: DiagramCommandSummary,
): string | null {
  if (assets.length === 0) return "attachAssets 需要至少一个资产";
  const existing = new Set((doc.assets ?? []).map((a) => a.id));
  for (const asset of assets) {
    if (existing.has(asset.id)) return `资产 id 已存在：${asset.id}`;
  }
  doc.assets = [...(doc.assets ?? []), ...assets.map((a) => ({ ...a }))];
  summary.attachedAssetIds.push(...assets.map((a) => a.id));
  return null;
}

// ---------------------------------------------------------------------------
// 历史（撤销 / 重做）
// ---------------------------------------------------------------------------

export interface DiagramHistory {
  past: DiagramState[];
  present: DiagramState;
  future: DiagramState[];
}

export function createDiagramHistory(doc: DiagramDocument): DiagramHistory {
  return { past: [], present: createDiagramState(doc), future: [] };
}

export type DiagramPushResult =
  | { ok: true; history: DiagramHistory; summary: DiagramCommandSummary }
  | { ok: false; message: string };

/** 执行命令并压入历史：成功形成一个撤销单元并清空 future；失败历史不变。 */
export function pushDiagramCommand(
  history: DiagramHistory,
  command: DiagramCommand,
): DiagramPushResult {
  const r = applyDiagramCommand(history.present, command);
  if (!r.ok) return r;
  return {
    ok: true,
    history: { past: [...history.past, history.present], present: r.state, future: [] },
    summary: r.summary,
  };
}

export function canUndo(history: DiagramHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: DiagramHistory): boolean {
  return history.future.length > 0;
}

export function undoDiagram(history: DiagramHistory): DiagramHistory | null {
  if (history.past.length === 0) return null;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
  };
}

export function redoDiagram(history: DiagramHistory): DiagramHistory | null {
  if (history.future.length === 0) return null;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}
