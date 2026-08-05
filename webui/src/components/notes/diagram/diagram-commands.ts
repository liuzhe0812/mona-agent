/**
 * 图表统一命令定义（DiagramCommand）。
 *
 * 规范（见 AI_EDITABLE_DIAGRAM_CANVAS_PRODUCTION_PLAN.md §8.2、§6.5）：
 * 1. 人工 UI 操作与 Agent patch 共用同一命令集合，禁止 Agent 旁路；
 * 2. 命令是数据（可序列化），执行器在 diagram-reducer.ts；
 * 3. updateElements/updateConnectors 的 patch 只能写能力注册表声明的字段；
 * 4. id/type/parentId 不允许通过 update 修改（parentId 走 group/reparent 命令）；
 * 5. expected 提供乐观并发保护：当前值与 expected 不一致时整条命令失败。
 */

import type {
  DiagramAssetRef,
  DiagramCanvasSettings,
  DiagramConnector,
  DiagramDocument,
  DiagramElement,
  DiagramPoint,
  DiagramSize,
} from "./diagram-document";

// ---------------------------------------------------------------------------
// 命令载荷
// ---------------------------------------------------------------------------

export interface DiagramElementUpdate {
  id: string;
  /** 乐观并发保护：字段名 → 期望当前值（深比较）。 */
  expected?: Record<string, unknown>;
  patch: Record<string, unknown>;
}

export interface DiagramConnectorUpdate {
  id: string;
  expected?: Record<string, unknown>;
  patch: Record<string, unknown>;
}

export interface DiagramLayoutEntry {
  id: string;
  position: DiagramPoint;
  size?: DiagramSize;
}

export type DiagramReorderAction = "front" | "back" | "forward" | "backward";

export const DIAGRAM_REORDER_ACTIONS: readonly DiagramReorderAction[] = [
  "front",
  "back",
  "forward",
  "backward",
];

// ---------------------------------------------------------------------------
// 命令联合
// ---------------------------------------------------------------------------

export type DiagramCommand =
  | { type: "addElements"; elements: DiagramElement[] }
  | { type: "updateElements"; updates: DiagramElementUpdate[] }
  | { type: "removeElements"; ids: string[] }
  | { type: "addConnectors"; connectors: DiagramConnector[] }
  | { type: "updateConnectors"; updates: DiagramConnectorUpdate[] }
  | { type: "removeConnectors"; ids: string[] }
  | { type: "groupElements"; elementIds: string[]; groupId?: string; title?: string }
  | { type: "ungroupElements"; groupIds: string[] }
  | { type: "reparentElements"; elementIds: string[]; parentId?: string }
  | { type: "reorderElements"; ids: string[]; action: DiagramReorderAction }
  | { type: "setCanvas"; patch: Partial<DiagramCanvasSettings> }
  | { type: "applyLayout"; positions: DiagramLayoutEntry[] }
  | { type: "attachAssets"; assets: DiagramAssetRef[] }
  | { type: "replaceDocument"; document: DiagramDocument };

export type DiagramCommandType = DiagramCommand["type"];

export const DIAGRAM_COMMAND_TYPES: readonly DiagramCommandType[] = [
  "addElements",
  "updateElements",
  "removeElements",
  "addConnectors",
  "updateConnectors",
  "removeConnectors",
  "groupElements",
  "ungroupElements",
  "reparentElements",
  "reorderElements",
  "setCanvas",
  "applyLayout",
  "attachAssets",
  "replaceDocument",
];

// ---------------------------------------------------------------------------
// 变更摘要（机器可读）
// ---------------------------------------------------------------------------

export interface DiagramCommandSummary {
  addedElementIds: string[];
  updatedElementIds: string[];
  removedElementIds: string[];
  addedConnectorIds: string[];
  updatedConnectorIds: string[];
  removedConnectorIds: string[];
  attachedAssetIds: string[];
  replacedDocument: boolean;
  canvasUpdated: boolean;
  layoutApplied: boolean;
}

export function emptyDiagramCommandSummary(): DiagramCommandSummary {
  return {
    addedElementIds: [],
    updatedElementIds: [],
    removedElementIds: [],
    addedConnectorIds: [],
    updatedConnectorIds: [],
    removedConnectorIds: [],
    attachedAssetIds: [],
    replacedDocument: false,
    canvasUpdated: false,
    layoutApplied: false,
  };
}

/** 把若干摘要合并为一个（Agent patch 多 op 聚合用）。 */
export function mergeDiagramCommandSummaries(
  target: DiagramCommandSummary,
  source: DiagramCommandSummary,
): void {
  target.addedElementIds.push(...source.addedElementIds);
  target.updatedElementIds.push(...source.updatedElementIds);
  target.removedElementIds.push(...source.removedElementIds);
  target.addedConnectorIds.push(...source.addedConnectorIds);
  target.updatedConnectorIds.push(...source.updatedConnectorIds);
  target.removedConnectorIds.push(...source.removedConnectorIds);
  target.attachedAssetIds.push(...source.attachedAssetIds);
  target.replacedDocument = target.replacedDocument || source.replacedDocument;
  target.canvasUpdated = target.canvasUpdated || source.canvasUpdated;
  target.layoutApplied = target.layoutApplied || source.layoutApplied;
}
