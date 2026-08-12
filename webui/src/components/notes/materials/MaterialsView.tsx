/**
 * MaterialsView — 资料库视图（拆分为 sidebar + preview）。
 *
 * 由 NotesView 组装布局：
 * - MaterialsSidebar：顶部 toolbar + 双分组列表（原始资料 / AI 整理）
 * - MaterialsPreview：根据选中项渲染文本预览或 Wiki markdown
 *
 * 所有路径限制在 `<vault>/.mona/materials/` 内，由后端做 canonical 校验。
 *
 * 实现已拆分到同目录下的 types.ts / materials-tree.tsx /
 * MaterialsSidebar.tsx / MaterialsPreview.tsx，本文件仅做 barrel re-export。
 */

export { MaterialsSidebar } from "./MaterialsSidebar";
export { MaterialsPreview } from "./MaterialsPreview";
export type {
  MaterialsSelection,
  MaterialsSidebarHandle,
  MaterialsSidebarProps,
  MaterialsPreviewProps,
  TreeNode,
} from "./types";
