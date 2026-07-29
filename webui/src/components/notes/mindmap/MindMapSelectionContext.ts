/**
 * 思维导图选中节点上下文。
 *
 * MindMapDocumentEditor 通过 setSelection 上抛当前选中节点，
 * NoteAgentPanel 通过 useMindMapSelection 消费，用于 AI 局部 patch 的上下文构造。
 *
 * 设计动机：MindMapDocumentEditor 嵌在 NoteEditor → Workspace → NotesView 多层之下，
 * 通过 props 透传需要改动多个组件接口；Context 更轻量，且只有 mindmap 类型笔记激活时才有意义。
 *
 * Provider 必须放在 NotesView 顶层，包裹 Workspace 和 NoteAgentPanel。
 */

import { createContext, useContext } from "react";
import type { MindMapSelectionContext } from "../notes-ai";

interface MindMapSelectionState {
  /** 当前选中节点上下文，null 表示未选中 */
  selection: MindMapSelectionContext | null;
  /** 当前激活的 mindmap 笔记 ID，用于在切换笔记时清除过期 selection */
  noteId: string | null;
  /** 当前笔记 contentMarkdown 的 baseHash，用于 patch 校验 */
  baseHash: string | null;
  /** MindMapDocumentEditor 调用以更新选中状态（同时更新 baseHash） */
  setSelection: (noteId: string, selection: MindMapSelectionContext | null, baseHash: string | null) => void;
  /** 仅更新 baseHash，保留当前 selection（节点操作后内容变化但选中未变） */
  updateBaseHash: (noteId: string, baseHash: string) => void;
}

const MindMapSelectionContextValue = createContext<MindMapSelectionState>({
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

export const MindMapSelectionProvider = MindMapSelectionContextValue.Provider;

export function useMindMapSelection(): MindMapSelectionState {
  return useContext(MindMapSelectionContextValue);
}
