/**
 * 图表 AI patch 应用器（mona-diagram-patch v2）。
 *
 * 集中处理 AI 回答中的 patch fenced block：
 *   1. parseDiagramPatch 提取并做浅层形状校验；
 *   2. prepare：在当前 markdown 的副本上 dry-run，返回 PendingDiagramPatch 供 UI 预览；
 *      dry-run 不校验 baseRevision/baseDocumentHash（stale 由应用期判定）；
 *   3. apply：基于中心最新状态（revision + documentHash）再次校验后原子应用，
 *      序列化为新 markdown 交给 NotesView 广播。
 *
 * stale 判定：patch.baseRevision ≠ 当前 revision 或 patch.baseDocumentHash ≠ 当前
 * 文档完整哈希 → 拒绝应用（见计划 §9.2：视觉修改也会使旧提案过期）。
 */

import {
  applyDiagramPatch,
  parseDiagramPatch,
  type DiagramPatch,
} from "./diagram-patch";
import type { DiagramCommandSummary } from "./diagram-commands";
import type { DiagramState } from "./diagram-reducer";
import { computeDiagramDocumentHash } from "./diagram-hash";
import {
  parseDiagramMarkdown,
  serializeDiagramMarkdown,
} from "./diagram-serializer";
import type { DiagramDocumentStateSnapshot } from "./DiagramSelectionContext";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 待确认的图表 patch（预览态，未应用）。 */
export interface PendingDiagramPatch {
  /** AI 回答所在的 message ID */
  messageId: string;
  /** 发起请求时的文档状态快照，用于生成期间的 stale 检测 */
  requestDocState: DiagramDocumentStateSnapshot;
  /** 解析得到的 patch（浅层校验已通过） */
  patch: DiagramPatch;
  /** dry-run 产生的目标状态（含文档 + revision + hash），供摘要展示 */
  proposedState: DiagramState;
  /** dry-run 聚合的变更摘要 */
  summary: DiagramCommandSummary;
  /** ready 可应用；stale 生成期间文档变化；applied 已应用；ignored 已忽略；invalid dry-run 失败 */
  status: "ready" | "stale" | "applied" | "ignored" | "invalid";
  /** invalid 时的错误信息 */
  error?: string;
}

export type PrepareDiagramResult =
  | { ok: true; pending: PendingDiagramPatch }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// prepare（dry-run，不修改中心文档）
// ---------------------------------------------------------------------------

/**
 * 解析 AI 回答并 dry-run patch。
 * dry-run 强制 revision/hash 与 patch 对齐，仅验证 op 可执行性；
 * stale 检测由 applyPendingDiagramPatch 在应用时基于中心状态完成。
 */
export function prepareDiagramPatch(
  aiContent: string,
  currentMarkdown: string,
  messageId: string,
  requestDocState: DiagramDocumentStateSnapshot,
): PrepareDiagramResult {
  // 1. 提取 patch block
  const parsed = parseDiagramPatch(aiContent);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  // 2. 解析当前文档
  const docParse = parseDiagramMarkdown(currentMarkdown);
  if (!docParse.ok) {
    return { ok: false, message: `当前图表文档解析失败：${docParse.message}` };
  }

  // 3. dry-run：把 state 的 revision/hash 对齐到 patch 的 base，仅测试 op 有效性
  const dryState: DiagramState = {
    document: docParse.document,
    revision: parsed.patch.baseRevision,
    documentHash: parsed.patch.baseDocumentHash,
  };
  const result = applyDiagramPatch(dryState, parsed.patch);
  if (!result.ok) {
    return {
      ok: true,
      pending: {
        messageId,
        requestDocState,
        patch: parsed.patch,
        proposedState: dryState,
        summary: emptySummary(),
        status: "invalid",
        error: result.message,
      },
    };
  }

  return {
    ok: true,
    pending: {
      messageId,
      requestDocState,
      patch: parsed.patch,
      proposedState: result.state,
      summary: result.summary,
      status: "ready",
    },
  };
}

// ---------------------------------------------------------------------------
// apply（基于中心最新状态校验 + 原子应用）
// ---------------------------------------------------------------------------

export type ApplyDiagramResult =
  | { ok: true; markdown: string; summary: DiagramCommandSummary; notice: string }
  | { ok: false; message: string; notice: string };

/**
 * 应用 pending patch：基于当前 markdown + 当前文档状态快照重新校验
 * baseRevision/baseDocumentHash，通过后序列化返回。
 * 失败时调用方应把 pending 标记为 stale。
 */
export function applyPendingDiagramPatch(
  pending: PendingDiagramPatch,
  currentMarkdown: string,
  noteTitle: string,
  currentDocState: DiagramDocumentStateSnapshot,
): ApplyDiagramResult {
  if (pending.status === "applied") {
    return { ok: false, message: "已应用过", notice: "该修改已应用" };
  }
  if (pending.status === "ignored") {
    return { ok: false, message: "已忽略", notice: "该修改已忽略" };
  }
  if (pending.status === "invalid") {
    return { ok: false, message: pending.error ?? "patch 无效", notice: "修改无效" };
  }

  const docParse = parseDiagramMarkdown(currentMarkdown);
  if (!docParse.ok) {
    return { ok: false, message: docParse.message, notice: "当前图表文档无效" };
  }
  const currentState: DiagramState = {
    document: docParse.document,
    revision: currentDocState.revision,
    documentHash: computeDiagramDocumentHash(docParse.document),
  };
  const result = applyDiagramPatch(currentState, pending.patch);
  if (!result.ok) {
    return { ok: false, message: result.message, notice: "应用失败（图表已修改），请重新生成" };
  }

  const title = noteTitle || "未命名图表";
  const markdown = serializeDiagramMarkdown(title, result.state.document);
  return {
    ok: true,
    markdown,
    summary: result.summary,
    notice: formatDiagramSummary(result.summary),
  };
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

function emptySummary(): DiagramCommandSummary {
  return {
    addedElementIds: [],
    updatedElementIds: [],
    removedElementIds: [],
    addedConnectorIds: [],
    updatedConnectorIds: [],
    removedConnectorIds: [],
    attachedAssetIds: [],
    replacedDocument: false,
    canvasUpdated: false,
    layoutApplied: false,
  };
}

/** 机器可读摘要 → 人类可读一句话。 */
export function formatDiagramSummary(summary: DiagramCommandSummary): string {
  if (summary.replacedDocument) {
    return "已替换完整图表";
  }
  const parts: string[] = [];
  if (summary.addedElementIds.length > 0) parts.push(`新增 ${summary.addedElementIds.length} 元素`);
  if (summary.updatedElementIds.length > 0) parts.push(`修改 ${summary.updatedElementIds.length} 元素`);
  if (summary.removedElementIds.length > 0) parts.push(`删除 ${summary.removedElementIds.length} 元素`);
  if (summary.addedConnectorIds.length > 0) parts.push(`新增 ${summary.addedConnectorIds.length} 连线`);
  if (summary.updatedConnectorIds.length > 0) parts.push(`修改 ${summary.updatedConnectorIds.length} 连线`);
  if (summary.removedConnectorIds.length > 0) parts.push(`删除 ${summary.removedConnectorIds.length} 连线`);
  if (summary.attachedAssetIds.length > 0) parts.push(`登记 ${summary.attachedAssetIds.length} 资产`);
  if (summary.canvasUpdated) parts.push("更新画布设置");
  if (summary.layoutApplied) parts.push("应用自动布局");
  return parts.length === 0 ? "已应用 patch" : `已应用：${parts.join(" · ")}`;
}
