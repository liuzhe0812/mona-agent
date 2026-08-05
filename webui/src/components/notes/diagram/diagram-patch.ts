/**
 * mona-diagram-patch v2 协议：解析、stale 校验与原子应用。
 *
 * 规范（见计划 §9.2）：
 * 1. AI 只输出一种 ```mona-diagram-patch fenced block；
 * 2. 协议头：protocolVersion(=2)、capabilityVersion(<=客户端)、baseRevision、baseDocumentHash、ops；
 * 3. 视觉 patch 使用完整文档哈希：任何中心文档变化（含纯视觉修改）都会使 patch 过期；
 * 4. replaceDocument 必须是唯一 op；局部 op 可提供 expected 做乐观并发保护；
 * 5. 未知字段、未知 op、未知枚举一律拒绝，不做静默降级；
 * 6. patch 有 ops 数量与 payload 字节上限；
 * 7. ops 按声明顺序转换为 DiagramCommand 逐一执行，任一失败整个 patch 不应用（原子性）。
 */

import {
  DIAGRAM_CAPABILITY_VERSION,
  DIAGRAM_PATCH_FENCE_LANG,
  DIAGRAM_PATCH_MAX_OPS,
  DIAGRAM_PATCH_MAX_PAYLOAD_BYTES,
  DIAGRAM_PATCH_PROTOCOL_VERSION,
} from "./diagram-document";
import {
  DIAGRAM_COMMAND_TYPES,
  DIAGRAM_REORDER_ACTIONS,
  emptyDiagramCommandSummary,
  mergeDiagramCommandSummaries,
  type DiagramCommand,
  type DiagramCommandSummary,
} from "./diagram-commands";
import {
  applyDiagramCommand,
  type DiagramHistory,
  type DiagramState,
} from "./diagram-reducer";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface DiagramPatch {
  protocolVersion: number;
  capabilityVersion: number;
  baseRevision: number;
  baseDocumentHash: string;
  ops: DiagramPatchOp[];
}

/** op 载荷在解析期保持 unknown，深度校验由 reducer + validator 在应用期完成。 */
export interface DiagramPatchOp {
  op: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type ParseDiagramPatchResult =
  | { ok: true; patch: DiagramPatch }
  | { ok: false; message: string };

/** 从 AI 回答文本中提取并解析最后一个 mona-diagram-patch fenced block。 */
export function parseDiagramPatch(text: string): ParseDiagramPatchResult {
  const re = new RegExp("```" + DIAGRAM_PATCH_FENCE_LANG + "\\s*\\n([\\s\\S]*?)```", "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].trim();
  }
  if (last === null) {
    return { ok: false, message: `AI 未返回 ${DIAGRAM_PATCH_FENCE_LANG} fenced block` };
  }
  if (last.length > DIAGRAM_PATCH_MAX_PAYLOAD_BYTES) {
    return { ok: false, message: `AI 返回的修改过大（${last.length} 字节），未应用` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (e) {
    return { ok: false, message: `AI 返回格式错误：${e instanceof Error ? e.message : String(e)}` };
  }
  return validatePatchShape(parsed);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PATCH_HEADER_FIELDS = ["protocolVersion", "capabilityVersion", "baseRevision", "baseDocumentHash", "ops"];

function validatePatchShape(input: unknown): ParseDiagramPatchResult {
  if (!isRecord(input)) {
    return { ok: false, message: "patch 不是对象" };
  }
  for (const key of Object.keys(input)) {
    if (!PATCH_HEADER_FIELDS.includes(key)) {
      return { ok: false, message: `patch 顶层含未知字段：${key}` };
    }
  }
  if (input.protocolVersion !== DIAGRAM_PATCH_PROTOCOL_VERSION) {
    return {
      ok: false,
      message: `protocolVersion 必须是 ${DIAGRAM_PATCH_PROTOCOL_VERSION}，收到 ${String(input.protocolVersion)}`,
    };
  }
  if (
    !Number.isInteger(input.capabilityVersion) ||
    (input.capabilityVersion as number) < 1
  ) {
    return { ok: false, message: "capabilityVersion 必须是 >= 1 的整数" };
  }
  if ((input.capabilityVersion as number) > DIAGRAM_CAPABILITY_VERSION) {
    return {
      ok: false,
      message: `capabilityVersion ${String(input.capabilityVersion)} 超出客户端支持的 ${DIAGRAM_CAPABILITY_VERSION}`,
    };
  }
  if (!Number.isInteger(input.baseRevision) || (input.baseRevision as number) < 0) {
    return { ok: false, message: "baseRevision 必须是 >= 0 的整数" };
  }
  if (
    typeof input.baseDocumentHash !== "string" ||
    !/^d[0-9a-f]+$/.test(input.baseDocumentHash)
  ) {
    return { ok: false, message: "baseDocumentHash 缺失或格式不合法" };
  }
  if (!Array.isArray(input.ops)) {
    return { ok: false, message: "ops 不是数组" };
  }
  if (input.ops.length > DIAGRAM_PATCH_MAX_OPS) {
    return {
      ok: false,
      message: `AI 返回的修改过大：ops 数量 ${input.ops.length} 超过上限 ${DIAGRAM_PATCH_MAX_OPS}`,
    };
  }
  for (let i = 0; i < input.ops.length; i++) {
    const error = validateOpShape(input.ops[i], i);
    if (error) return { ok: false, message: error };
  }
  const hasReplaceDocument = (input.ops as unknown[]).some(
    (op) => isRecord(op) && op.op === "replaceDocument",
  );
  if (hasReplaceDocument && input.ops.length > 1) {
    return { ok: false, message: "replaceDocument 必须是唯一 op，不能与其他 op 混用" };
  }
  return { ok: true, patch: input as unknown as DiagramPatch };
}

/** 每种 op 允许的字段（除 op 外）。 */
const OP_FIELDS: Record<string, readonly string[]> = {
  replaceDocument: ["document"],
  addElements: ["elements"],
  updateElements: ["updates"],
  removeElements: ["ids"],
  addConnectors: ["connectors"],
  updateConnectors: ["updates"],
  removeConnectors: ["ids"],
  groupElements: ["elementIds", "groupId", "title"],
  ungroupElements: ["groupIds"],
  reparentElements: ["elementIds", "parentId"],
  reorderElements: ["ids", "action"],
  setCanvas: ["patch"],
  applyLayout: ["positions"],
  attachAssets: ["assets"],
};

function validateOpShape(raw: unknown, index: number): string | null {
  const ctx = `ops[${index}]`;
  if (!isRecord(raw)) return `${ctx} 不是对象`;
  const name = raw.op;
  if (typeof name !== "string" || !DIAGRAM_COMMAND_TYPES.includes(name as DiagramCommand["type"])) {
    return `${ctx} 未知 op：${String(name)}`;
  }
  const allowed = OP_FIELDS[name];
  for (const key of Object.keys(raw)) {
    if (key !== "op" && !allowed.includes(key)) {
      return `${ctx}（${name}）含未知字段：${key}`;
    }
  }
  switch (name) {
    case "replaceDocument":
      if (!isRecord(raw.document)) return `${ctx}.document 缺失或不是对象`;
      return null;
    case "addElements":
      return requireArray(raw, "elements", ctx);
    case "updateElements":
      return requireUpdates(raw, ctx);
    case "removeElements":
      return requireStringArray(raw, "ids", ctx);
    case "addConnectors":
      return requireArray(raw, "connectors", ctx);
    case "updateConnectors":
      return requireUpdates(raw, ctx);
    case "removeConnectors":
      return requireStringArray(raw, "ids", ctx);
    case "groupElements": {
      const e = requireStringArray(raw, "elementIds", ctx);
      if (e) return e;
      if (raw.groupId !== undefined && typeof raw.groupId !== "string") return `${ctx}.groupId 必须是字符串`;
      if (raw.title !== undefined && typeof raw.title !== "string") return `${ctx}.title 必须是字符串`;
      return null;
    }
    case "ungroupElements":
      return requireStringArray(raw, "groupIds", ctx);
    case "reparentElements": {
      const e = requireStringArray(raw, "elementIds", ctx);
      if (e) return e;
      if (raw.parentId !== undefined && typeof raw.parentId !== "string") return `${ctx}.parentId 必须是字符串`;
      return null;
    }
    case "reorderElements": {
      const e = requireStringArray(raw, "ids", ctx);
      if (e) return e;
      if (!DIAGRAM_REORDER_ACTIONS.includes(raw.action as (typeof DIAGRAM_REORDER_ACTIONS)[number])) {
        return `${ctx}.action 必须是 ${DIAGRAM_REORDER_ACTIONS.join(" | ")}`;
      }
      return null;
    }
    case "setCanvas":
      if (!isRecord(raw.patch)) return `${ctx}.patch 缺失或不是对象`;
      return null;
    case "applyLayout":
      return requireArray(raw, "positions", ctx);
    case "attachAssets":
      return requireArray(raw, "assets", ctx);
    default:
      return `${ctx} 未知 op：${name}`;
  }
}

function requireArray(raw: Record<string, unknown>, key: string, ctx: string): string | null {
  if (!Array.isArray(raw[key])) return `${ctx}.${key} 缺失或不是数组`;
  return null;
}

function requireStringArray(raw: Record<string, unknown>, key: string, ctx: string): string | null {
  if (!Array.isArray(raw[key])) return `${ctx}.${key} 缺失或不是数组`;
  for (const item of raw[key] as unknown[]) {
    if (typeof item !== "string") return `${ctx}.${key} 必须是字符串数组`;
  }
  return null;
}

function requireUpdates(raw: Record<string, unknown>, ctx: string): string | null {
  if (!Array.isArray(raw.updates)) return `${ctx}.updates 缺失或不是数组`;
  for (let i = 0; i < (raw.updates as unknown[]).length; i++) {
    const u = (raw.updates as unknown[])[i];
    const uctx = `${ctx}.updates[${i}]`;
    if (!isRecord(u)) return `${uctx} 不是对象`;
    if (typeof u.id !== "string") return `${uctx}.id 缺失或不是字符串`;
    if (!isRecord(u.patch)) return `${uctx}.patch 缺失或不是对象`;
    if (u.expected !== undefined && !isRecord(u.expected)) return `${uctx}.expected 必须是对象`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

export type ApplyDiagramPatchResult =
  | { ok: true; state: DiagramState; summary: DiagramCommandSummary }
  | { ok: false; message: string };

/**
 * 校验 stale 并在 state 上原子应用 patch。
 *
 * 调用方应在用户点击"应用"时基于中心状态重新执行本函数，避免应用过期 patch。
 * 空 ops 不推进 revision，直接返回原 state。
 */
export function applyDiagramPatch(
  state: DiagramState,
  patch: DiagramPatch,
): ApplyDiagramPatchResult {
  if (patch.baseRevision !== state.revision || patch.baseDocumentHash !== state.documentHash) {
    return { ok: false, message: "AI 处理期间图表已被修改，请重新生成" };
  }
  const summary = emptyDiagramCommandSummary();
  if (patch.ops.length === 0) {
    return { ok: true, state, summary };
  }
  let current = state;
  for (let i = 0; i < patch.ops.length; i++) {
    const command = opToCommand(patch.ops[i]);
    const r = applyDiagramCommand(current, command);
    if (!r.ok) {
      return { ok: false, message: `ops[${i}]（${patch.ops[i].op}）失败：${r.message}` };
    }
    current = r.state;
    mergeDiagramCommandSummaries(summary, r.summary);
  }
  return { ok: true, state: current, summary };
}

function opToCommand(op: DiagramPatchOp): DiagramCommand {
  const { op: name, ...payload } = op;
  return { type: name, ...payload } as unknown as DiagramCommand;
}

// ---------------------------------------------------------------------------
// 历史集成：整个 patch 形成一个撤销单元
// ---------------------------------------------------------------------------

export type PushDiagramPatchResult =
  | { ok: true; history: DiagramHistory; summary: DiagramCommandSummary }
  | { ok: false; message: string };

export function pushDiagramPatch(
  history: DiagramHistory,
  patch: DiagramPatch,
): PushDiagramPatchResult {
  const r = applyDiagramPatch(history.present, patch);
  if (!r.ok) return r;
  if (r.state === history.present) {
    // 空 patch：不产生历史单元
    return { ok: true, history, summary: r.summary };
  }
  return {
    ok: true,
    history: { past: [...history.past, history.present], present: r.state, future: [] },
    summary: r.summary,
  };
}
