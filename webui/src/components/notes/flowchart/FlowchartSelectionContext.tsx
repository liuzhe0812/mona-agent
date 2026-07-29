/**
 * 流程图选中节点/边上下文与 semantic hash 订阅。
 *
 * FlowchartDocumentEditor 通过 setSelection 上抛当前选中节点/边，
 * NoteAgentPanel 通过 useFlowchartSelection 消费，用于 AI patch 上下文构造。
 *
 * Provider 必须放在 NotesView 顶层，包裹 Workspace 和 NoteAgentPanel。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §9.4
 */

import { createContext, useContext } from "react";

export interface FlowchartSelectionContextValue {
  /** 当前选中节点 ID 列表（空数组表示无选中） */
  nodeIds: string[];
  /** 当前选中边 ID 列表（空数组表示无选中） */
  edgeIds: string[];
}

interface FlowchartSelectionState {
  /** 当前选中上下文，null 表示未选中 */
  selection: FlowchartSelectionContextValue | null;
  /** 当前激活的 flowchart 笔记 ID，用于在切换笔记时清除过期 selection */
  noteId: string | null;
  /** 当前笔记的 semantic hash，用于 patch 校验 */
  baseHash: string | null;
  /** FlowchartDocumentEditor 调用以更新选中状态（同时更新 baseHash） */
  setSelection: (
    noteId: string,
    selection: FlowchartSelectionContextValue | null,
    baseHash: string | null,
  ) => void;
  /** 仅更新 baseHash，保留当前 selection（节点操作后内容变化但选中未变） */
  updateBaseHash: (noteId: string, baseHash: string) => void;
}

const FlowchartSelectionContextInstance = createContext<FlowchartSelectionState>({
  selection: null,
  noteId: null,
  baseHash: null,
  setSelection: () => {
    // 默认空实现，Provider 未挂载时不报错
  },
  updateBaseHash: () => {
    // 默认空实现
  },
});

export const FlowchartSelectionProvider = FlowchartSelectionContextInstance.Provider;

export function useFlowchartSelection(): FlowchartSelectionState {
  return useContext(FlowchartSelectionContextInstance);
}
