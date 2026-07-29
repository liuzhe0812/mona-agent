/**
 * 思维导图 AI 结果应用器。
 *
 * 集中处理两种契约（见方案 §8）：
 *   1. 全量替换：从 AI 回答中提取 ```mindmap fenced block，校验为合法大纲后返回新 markdown；
 *   2. 局部 patch：从 AI 回答中提取 ```mindmap-patch fenced block，调用 applyPatch 应用到当前大纲。
 *
 * 调用方根据 `note.type === "mindmap"` 决定是否走本应用器；普通笔记继续走 NoteAgentPanel 原有路径。
 *
 * 优先级：patch 优先于 replace（局部操作更精确，避免整树回写）。
 */

import {
  extractFencedBlock,
  parseMindMap,
  stripMarkdownFence,
  computeBaseHash,
  serializeMindMap,
} from "./mindmap-outline";
import {
  applyPatch,
  parsePatch,
  type ApplyPatchResult,
} from "./mindmap-patch";

export type MindMapApplyResult =
  | { ok: true; mode: "replace"; markdown: string; notice: string }
  | { ok: true; mode: "patch"; markdown: string; appliedCount: number; notice: string }
  | { ok: false; mode: "none"; message: string; notice: string };

/**
 * 从 AI 回答中提取并应用思维导图修改。
 *
 * 优先级：
 *   1. 若同时存在 mindmap-patch 和 mindmap 两种 block，以 patch 为准（局部操作更精确）；
 *   2. 若只有 mindmap-patch，应用 patch；
 *   3. 若只有 mindmap，做全量替换；
 *   4. 若都没有，返回 ok:false，让调用方按普通文本处理。
 */
export function applyMindMapAiResult(
  aiContent: string,
  currentMarkdown: string,
): MindMapApplyResult {
  // 1. 优先尝试局部 patch
  const patchBlock = extractFencedBlock(aiContent, "mindmap-patch");
  if (patchBlock) {
    const parsed = parsePatch(patchBlock);
    if (!parsed.ok) {
      return {
        ok: false,
        mode: "none",
        message: `patch 解析失败：${parsed.message}`,
        notice: "AI 返回的 patch 格式错误",
      };
    }
    const result: ApplyPatchResult = applyPatch(currentMarkdown, parsed.patch);
    if (!result.ok) {
      return {
        ok: false,
        mode: "none",
        message: result.message,
        notice: "应用 patch 失败（可能导图已修改）",
      };
    }
    return {
      ok: true,
      mode: "patch",
      markdown: result.markdown,
      appliedCount: result.appliedCount,
      notice: `已应用 ${result.appliedCount} 个操作`,
    };
  }

  // 2. 尝试全量替换
  const replaceBlock = extractFencedBlock(aiContent, "mindmap");
  if (replaceBlock) {
    const cleaned = stripMarkdownFence(replaceBlock);
    const parsed = parseMindMap(cleaned);
    if (!parsed.ok) {
      return {
        ok: false,
        mode: "none",
        message: `大纲解析失败：第 ${parsed.line} 行 ${parsed.message}`,
        notice: "AI 返回的大纲格式错误",
      };
    }
    return {
      ok: true,
      mode: "replace",
      markdown: serializeMindMap(parsed.root),
      notice: "已替换完整导图",
    };
  }

  // 3. 没有结构化 block
  return {
    ok: false,
    mode: "none",
    message: "AI 回答中未找到 ```mindmap 或 ```mindmap-patch fenced block",
    notice: "AI 未返回结构化导图修改",
  };
}

/** 仅计算 baseHash，供调用方在发送 AI 请求前快照基线 */
export function snapshotBaseHash(currentMarkdown: string): string {
  return computeBaseHash(currentMarkdown);
}
