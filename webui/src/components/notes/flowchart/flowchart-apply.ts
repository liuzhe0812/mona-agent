/**
 * 流程图 AI 结果应用器。
 *
 * 集中处理 mona-flowchart-patch fenced block：
 *   1. 从 AI 回答中提取最后一个 patch block；
 *   2. 调用 parseFlowchartPatch 解析；
 *   3. 把当前 markdown 解析为 FlowchartDocument；
 *   4. prepare：仅 dry-run，返回 PendingFlowchartPatch 供 UI 预览（不修改文档）；
 *   5. apply：对中心状态再次校验 baseHash 后原子应用，序列化为新 markdown。
 *
 * 调用方根据 `note.type === "flowchart"` 决定是否走本应用器。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §9.6, §9.10
 *           docs/design/2026-07-29-wps-flowchart-gap-development-plan.md §7.1, §7.2
 */

import {
  parseFlowchartMarkdown,
  serializeFlowchartMarkdown,
  type FlowchartDocument,
} from "./flowchart-document";
import {
  applyFlowchartPatch,
  parseFlowchartPatch,
  type FlowchartPatch,
  type FlowchartPatchSummary,
} from "./flowchart-patch";

/** 待确认的流程图 patch（预览态，未应用） */
export interface PendingFlowchartPatch {
  /** AI 回答所在的 message ID */
  messageId: string;
  /** 发起请求时的 baseHash，用于检测生成期间是否语义变化 */
  requestBaseHash: string;
  /** 解析得到的 patch（dry-run 通过后保留） */
  patch: FlowchartPatch;
  /** 在副本上 dry-run 产生的目标文档，供应用时直接序列化 */
  proposedDocument: FlowchartDocument;
  /** dry-run 产生的变更摘要 */
  summary: FlowchartPatchSummary;
  /** 状态机：ready 可应用，stale 生成期间语义变化，applied 已应用，ignored 已忽略，invalid dry-run 失败 */
  status: "ready" | "stale" | "applied" | "ignored" | "invalid";
  /** invalid/stale 时的错误信息 */
  error?: string;
}

export type PrepareResult =
  | { ok: true; pending: PendingFlowchartPatch }
  | { ok: false; message: string };

/**
 * 解析 AI 回答并 dry-run patch，不修改原文档。
 * 返回 PendingFlowchartPatch 供 UI 展示变更卡片。
 */
export function prepareFlowchartPatch(
  aiContent: string,
  currentMarkdown: string,
  _noteTitle: string,
  messageId: string,
  requestBaseHash: string,
): PrepareResult {
  // 1. 解析 AI 回答中的 patch block
  const parsed = parseFlowchartPatch(aiContent);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  // 2. 解析当前 markdown 为 FlowchartDocument
  const docParse = parseFlowchartMarkdown(currentMarkdown);
  if (!docParse.ok) {
    return { ok: false, message: `当前文档解析失败：${docParse.message}` };
  }

  // 3. 在副本上 dry-run（applyFlowchartPatch 内部会校验 baseHash）
  const result = applyFlowchartPatch(docParse.document, parsed.patch);
  if (!result.ok) {
    // dry-run 失败：返回 invalid 状态的 pending，UI 可展示错误
    return {
      ok: true,
      pending: {
        messageId,
        requestBaseHash,
        patch: parsed.patch,
        proposedDocument: docParse.document,
        summary: emptySummary(),
        status: "invalid",
        error: result.message,
      },
    };
  }

  // 4. dry-run 成功，保留 proposedDocument 供应用时使用
  return {
    ok: true,
    pending: {
      messageId,
      requestBaseHash,
      patch: parsed.patch,
      proposedDocument: result.document,
      summary: result.summary,
      status: "ready",
    },
  };
}

export type ApplyResult =
  | {
      ok: true;
      markdown: string;
      summary: FlowchartPatchSummary;
      notice: string;
    }
  | { ok: false; message: string; notice: string };

/**
 * 应用 pending patch：对中心状态再次校验 baseHash，通过后序列化返回。
 * 失败时调用方应把 pending 标记为 stale。
 */
export function applyPendingPatch(
  pending: PendingFlowchartPatch,
  currentMarkdown: string,
  noteTitle: string,
): ApplyResult {
  if (pending.status === "applied") {
    return { ok: false, message: "已应用过", notice: "该修改已应用" };
  }
  if (pending.status === "ignored") {
    return { ok: false, message: "已忽略", notice: "该修改已忽略" };
  }
  if (pending.status === "invalid") {
    return { ok: false, message: pending.error ?? "patch 无效", notice: "修改无效" };
  }

  // 再次校验中心文档的 baseHash
  const docParse = parseFlowchartMarkdown(currentMarkdown);
  if (!docParse.ok) {
    return { ok: false, message: docParse.message, notice: "当前流程图文档无效" };
  }
  const result = applyFlowchartPatch(docParse.document, pending.patch);
  if (!result.ok) {
    return { ok: false, message: result.message, notice: "应用失败（流程图已修改），请重新生成" };
  }

  const title = noteTitle || docParse.title || "未命名流程图";
  const markdown = serializeFlowchartMarkdown(title, result.document);
  return {
    ok: true,
    markdown,
    summary: result.summary,
    notice: formatPatchSummary(result.summary),
  };
}

function emptySummary(): FlowchartPatchSummary {
  return {
    addedNodes: 0,
    updatedNodes: 0,
    removedNodes: 0,
    addedEdges: 0,
    updatedEdges: 0,
    removedEdges: 0,
    addedPools: 0,
    addedLanes: 0,
    movedToLane: 0,
    replacedGraph: false,
  };
}

function formatPatchSummary(summary: FlowchartPatchSummary): string {
  if (summary.replacedGraph) {
    return (summary.qualityIssues?.length ?? 0) > 0
      ? `已替换完整流程图，仍有 ${summary.qualityIssues!.length} 项布局提醒`
      : "已替换完整流程图";
  }
  const parts: string[] = [];
  if (summary.addedPools > 0) parts.push(`新增 ${summary.addedPools} 个泳池`);
  if (summary.addedLanes > 0) parts.push(`新增 ${summary.addedLanes} 条泳道`);
  if (summary.movedToLane > 0) parts.push(`移动 ${summary.movedToLane} 个节点归属`);
  if (summary.updatedTheme) parts.push("更新主题");
  if (summary.reflowed) parts.push("重新布局");
  if (summary.addedNodes > 0) parts.push(`新增 ${summary.addedNodes} 个节点`);
  if (summary.updatedNodes > 0) parts.push(`修改 ${summary.updatedNodes} 个节点`);
  if (summary.removedNodes > 0) parts.push(`删除 ${summary.removedNodes} 个节点`);
  if (summary.addedEdges > 0) parts.push(`新增 ${summary.addedEdges} 条连线`);
  if (summary.updatedEdges > 0) parts.push(`修改 ${summary.updatedEdges} 条连线`);
  if (summary.removedEdges > 0) parts.push(`删除 ${summary.removedEdges} 条连线`);
  if ((summary.qualityIssues?.length ?? 0) > 0) parts.push(`${summary.qualityIssues!.length} 项布局提醒`);
  return parts.length === 0 ? "已应用 patch" : `已应用：${parts.join(" · ")}`;
}

/** 仅用于类型重导出，方便调用方引用 */
export type { FlowchartDocument };
