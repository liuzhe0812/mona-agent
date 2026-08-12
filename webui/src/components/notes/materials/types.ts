/**
 * 资料库共享类型定义。
 *
 * 所有路径限制在 `<vault>/.mona/materials/` 内，由后端做 canonical 校验。
 */

import type { MaterialsFileEntry } from "@/lib/materials-api";

export type MaterialsSelection =
  | { kind: "raw"; path: string }
  | { kind: "wiki"; path: string }
  | null;

/** 递归文件树节点 */
export interface TreeNode {
  entry: MaterialsFileEntry;
  children: TreeNode[];
  loaded: boolean;
  expanded: boolean;
}

/** Imperative handle exposed by MaterialsSidebar to the parent (tab bar buttons). */
export interface MaterialsSidebarHandle {
  upload: () => void;
  createFolder: () => void;
  compile: () => void;
}

export interface MaterialsSidebarProps {
  selection: MaterialsSelection;
  onSelect: (sel: MaterialsSelection) => void;
  /** Reports busy/compiling state so the parent can disable tab bar buttons. */
  onStateChange?: (state: { busy: boolean; compiling: boolean }) => void;
}

export interface MaterialsPreviewProps {
  selection: MaterialsSelection;
}
