import { createContext, useContext, type MutableRefObject } from "react";

/**
 * 思维导图节点定位桥接器。
 *
 * 用于解耦 RightSidebar（大纲面板）与 MindMapDocumentEditor（导图编辑器）。
 * NotesView 在顶层通过 MindMapBridgeContext.Provider 提供一个 mutable ref，
 * MindMapDocumentEditor 在挂载时把 selectNode 实现写入 ref.current，
 * RightSidebar 点击大纲节点时调用 ref.current?.(nodeId) 定位导图节点。
 */
export type MindMapSelectNodeFn = (nodeId: string) => void;

export type MindMapBridge = MutableRefObject<MindMapSelectNodeFn | null>;

export const MindMapBridgeContext = createContext<MindMapBridge | null>(null);

export function useMindMapBridge(): MindMapBridge | null {
  return useContext(MindMapBridgeContext);
}
