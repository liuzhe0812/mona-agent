/**
 * 图表画布选中元素/连接器上下文与文档状态（revision + hashes）订阅。
 *
 * DiagramDocumentEditor 通过 setSelection 上抛当前选中元素/连接器与文档状态，
 * DiagramAgentPanel 通过 useDiagramSelection 消费，用于 AI patch 上下文构造与
 * stale 检测（baseRevision + baseDocumentHash，见计划 §9.2）。
 *
 * Provider 必须放在 NotesView 顶层，包裹 Workspace 和 AgentPanel。
 */

import { createContext, useContext } from "react";

export interface DiagramSelectionContextValue {
  /** 当前选中元素 ID 列表（空数组表示无选中） */
  elementIds: string[];
  /** 当前选中连接器 ID 列表（空数组表示无选中） */
  connectorIds: string[];
}

export interface DiagramDocumentStateSnapshot {
  revision: number;
  documentHash: string;
  semanticHash: string;
}

interface DiagramSelectionState {
  /** 当前选中上下文，null 表示未选中 */
  selection: DiagramSelectionContextValue | null;
  /** 当前激活的 diagram 笔记 ID，用于在切换笔记时清除过期 selection */
  noteId: string | null;
  /** 当前文档状态快照，用于 patch stale 校验 */
  docState: DiagramDocumentStateSnapshot | null;
  /** DiagramDocumentEditor 调用以更新选中状态与文档状态 */
  setSelection: (
    noteId: string,
    selection: DiagramSelectionContextValue | null,
    docState: DiagramDocumentStateSnapshot | null,
  ) => void;
  /** 仅更新文档状态，保留当前 selection（内容变化但选中未变） */
  updateDocState: (noteId: string, docState: DiagramDocumentStateSnapshot) => void;
}

const DiagramSelectionContextInstance = createContext<DiagramSelectionState>({
  selection: null,
  noteId: null,
  docState: null,
  setSelection: () => {
    // 默认空实现，Provider 未挂载时不报错
  },
  updateDocState: () => {
    // 默认空实现
  },
});

export const DiagramSelectionProvider = DiagramSelectionContextInstance.Provider;

export function useDiagramSelection(): DiagramSelectionState {
  return useContext(DiagramSelectionContextInstance);
}
