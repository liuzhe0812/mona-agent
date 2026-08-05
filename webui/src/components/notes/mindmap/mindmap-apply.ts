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
 *
 * 与 FlowchartApply 对齐的 dry-run 流程：
 *   - prepareMindMapPatch：解析 + 在副本上 dry-run，返回 PendingMindMapPatch 供 UI 预览（不修改文档）；
 *   - applyPendingPatch：对中心状态再次校验 baseHash 后原子应用，序列化为新 markdown。
 */

import {
  extractFencedBlock,
  parseMindMap,
  stripMarkdownFence,
  computeBaseHash,
  serializeMindMap,
  type MindMapNode,
} from "./mindmap-outline";
import {
  applyPatch,
  parsePatch,
  type ApplyPatchResult,
  type MindMapPatch,
  type MindMapPatchSummary,
} from "./mindmap-patch";

/** patch 应用模式 */
export type MindMapApplyMode = "replace" | "patch";

/** 待确认的思维导图 patch（预览态，未应用） */
export interface PendingMindMapPatch {
  /** AI 回答所在的 message ID */
  messageId: string;
  /** 发起请求时的 baseHash，用于检测生成期间是否语义变化 */
  requestBaseHash: string;
  /** 应用模式：patch 局部修改 / replace 全量替换 */
  mode: MindMapApplyMode;
  /** 解析得到的 patch（mode === "patch" 时存在） */
  patch?: MindMapPatch;
  /** dry-run 产生的目标 markdown，供应用时直接使用 */
  proposedMarkdown: string;
  /** dry-run 产生的变更摘要 */
  summary: MindMapPatchSummary | { replaced: true };
  /** 状态机：ready 可应用，stale 生成期间语义变化，applied 已应用，ignored 已忽略，invalid dry-run 失败 */
  status: "ready" | "stale" | "applied" | "ignored" | "invalid";
  /** invalid/stale 时的错误信息 */
  error?: string;
}

export type PrepareResult =
  | { ok: true; pending: PendingMindMapPatch }
  | { ok: false; message: string };

export type MindMapApplyResult =
  | { ok: true; mode: "replace"; markdown: string; notice: string }
  | { ok: true; mode: "patch"; markdown: string; appliedCount: number; notice: string }
  | { ok: false; mode: "none"; message: string; notice: string };

/**
 * 从 AI 回答中提取并应用思维导图修改（直接应用，无 dry-run 预览）。
 *
 * 优先级：
 *   1. 若同时存在 mindmap-patch 和 mindmap 两种 block，以 patch 为准（局部操作更精确）；
 *   2. 若只有 mindmap-patch，应用 patch；
 *   3. 若只有 mindmap，做全量替换；
 *   4. 若都没有，返回 ok:false，让调用方按普通文本处理。
 *
 * 注意：此函数会直接应用变更，不提供 dry-run 预览。
 * 推荐新代码使用 prepareMindMapPatch + applyPendingPatch 走 dry-run 流程。
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
      notice: formatPatchSummary(result.summary),
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

/**
 * 解析 AI 回答并 dry-run，不修改原文档。
 * 返回 PendingMindMapPatch 供 UI 展示变更卡片。
 *
 * 与 prepareFlowchartPatch 对齐：
 *   - 在副本上试应用，失败时返回 invalid 状态的 pending；
 *   - 成功时返回 ready 状态，UI 根据当前 baseHash 决定自动应用还是进入卡片。
 */
export function prepareMindMapPatch(
  aiContent: string,
  currentMarkdown: string,
  messageId: string,
  requestBaseHash: string,
): PrepareResult {
  // 1. 优先尝试局部 patch
  const patchBlock = extractFencedBlock(aiContent, "mindmap-patch");
  if (patchBlock) {
    const parsed = parsePatch(patchBlock);
    if (!parsed.ok) {
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "patch",
          proposedMarkdown: currentMarkdown,
          summary: emptyPatchSummary(),
          status: "invalid",
          error: `patch 解析失败：${parsed.message}`,
        },
      };
    }

    // 在副本上 dry-run
    const result = applyPatch(currentMarkdown, parsed.patch);
    if (!result.ok) {
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "patch",
          patch: parsed.patch,
          proposedMarkdown: currentMarkdown,
          summary: emptyPatchSummary(),
          status: "invalid",
          error: result.message,
        },
      };
    }

    return {
      ok: true,
      pending: {
        messageId,
        requestBaseHash,
        mode: "patch",
        patch: parsed.patch,
        proposedMarkdown: result.markdown,
        summary: result.summary,
        status: "ready",
      },
    };
  }

  // 2. 尝试全量替换
  const replaceBlock = extractFencedBlock(aiContent, "mindmap");
  if (replaceBlock) {
    const cleaned = stripMarkdownFence(replaceBlock);
    const parsed = parseMindMap(cleaned);
    if (!parsed.ok) {
      return {
        ok: true,
        pending: {
          messageId,
          requestBaseHash,
          mode: "replace",
          proposedMarkdown: currentMarkdown,
          summary: { replaced: true },
          status: "invalid",
          error: `大纲解析失败：第 ${parsed.line} 行 ${parsed.message}`,
        },
      };
    }
    return {
      ok: true,
      pending: {
        messageId,
        requestBaseHash,
        mode: "replace",
        proposedMarkdown: serializeMindMap(parsed.root),
        summary: { replaced: true },
        status: "ready",
      },
    };
  }

  // 3. 没有结构化 block：返回 ok:false 让调用方跳过
  return { ok: false, message: "AI 回答中未找到 ```mindmap 或 ```mindmap-patch fenced block" };
}

export type ApplyPendingResult =
  | {
      ok: true;
      markdown: string;
      summary: MindMapPatchSummary | { replaced: true };
      notice: string;
    }
  | { ok: false; message: string; notice: string };

/**
 * 应用 pending patch：对中心状态再次校验，通过后返回新 markdown。
 * 失败时调用方应把 pending 标记为 stale。
 *
 * 对于 patch 模式：再次校验 baseHash，防止应用过期的 patch；
 * 对于 replace 模式：直接返回 proposedMarkdown（全量替换无需校验 hash）。
 */
export function applyPendingPatch(
  pending: PendingMindMapPatch,
  currentMarkdown: string,
): ApplyPendingResult {
  if (pending.status === "applied") {
    return { ok: false, message: "已应用过", notice: "该修改已应用" };
  }
  if (pending.status === "ignored") {
    return { ok: false, message: "已忽略", notice: "该修改已忽略" };
  }
  if (pending.status === "invalid") {
    return { ok: false, message: pending.error ?? "patch 无效", notice: "修改无效" };
  }

  // patch 模式：再次校验 baseHash 后重新应用
  if (pending.mode === "patch" && pending.patch) {
    const result = applyPatch(currentMarkdown, pending.patch);
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        notice: "应用失败（导图已修改），请重新生成",
      };
    }
    return {
      ok: true,
      markdown: result.markdown,
      summary: result.summary,
      notice: formatPatchSummary(result.summary),
    };
  }

  // replace 模式：直接返回预计算的 markdown
  return {
    ok: true,
    markdown: pending.proposedMarkdown,
    summary: pending.summary,
    notice: "已替换完整导图",
  };
}

function emptyPatchSummary(): MindMapPatchSummary {
  return { added: 0, updated: 0, removed: 0, moved: 0 };
}

function formatPatchSummary(summary: MindMapPatchSummary): string {
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`新增 ${summary.added} 个节点`);
  if (summary.updated > 0) parts.push(`修改 ${summary.updated} 个节点`);
  if (summary.removed > 0) parts.push(`删除 ${summary.removed} 个节点`);
  if (summary.moved > 0) parts.push(`移动 ${summary.moved} 个节点`);
  return parts.length === 0 ? "已应用 patch" : `已应用：${parts.join(" · ")}`;
}

/** 仅计算 baseHash，供调用方在发送 AI 请求前快照基线 */
export function snapshotBaseHash(currentMarkdown: string): string {
  return computeBaseHash(currentMarkdown);
}

/** 仅用于类型重导出，方便调用方引用 */
export type { MindMapNode };
