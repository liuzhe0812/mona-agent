/** 跨模块的"打开资料"请求 store。
 *
 * 聊天消息中的资料引用链接（mona:material?...）被点击后，需要跨越
 * ThreadShell → App → NotesView → MaterialsPreview 的组件层级打开
 * 对应资料并滚动到引用位置。通过该 store 传递一次性请求：
 * App 负责切到笔记模块，NotesView 负责切到资料 tab 并选中文件，
 * MaterialsPreview 内的预览组件消费 location 并清除请求。
 */

import { create } from "zustand";

export interface MaterialOpenRequest {
  /** raw 选择路径（raw/<rel>）或 wiki 页面相对路径（<rel>.md） */
  path: string;
  kind: "raw" | "wiki";
  /** 位置标签（如 "Page 12"），预览内滚动定位用；可空 */
  location?: string;
  /** 保证同一目标重复点击也能触发订阅 */
  nonce: number;
}

interface MaterialsOpenState {
  pending: MaterialOpenRequest | null;
  request: (req: Omit<MaterialOpenRequest, "nonce">) => void;
  clear: () => void;
}

export const useMaterialsOpenStore = create<MaterialsOpenState>((set) => ({
  pending: null,
  request: (req) => set({ pending: { ...req, nonce: Date.now() } }),
  clear: () => set({ pending: null }),
}));
