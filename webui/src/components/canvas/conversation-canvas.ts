import {
  buildMindMapFreeformPrompt,
} from "@/components/notes/notes-ai";
import type { OperationNote } from "@/components/notes/notes-data";
import { nowTimestamp } from "@/components/notes/notes-data";
import {
  applyPendingPatch as applyFlowchartPendingPatch,
  prepareFlowchartPatch,
} from "@/components/notes/flowchart/flowchart-apply";
import {
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  parseFlowchartMarkdown,
  serializeFlowchartMarkdown,
} from "@/components/notes/flowchart/flowchart-document";
import {
  applyPendingPatch as applyMindMapPendingPatch,
  prepareMindMapPatch,
} from "@/components/notes/mindmap/mindmap-apply";
import { computeBaseHash } from "@/components/notes/mindmap/mindmap-outline";

export type ConversationCanvasKind = "flowchart" | "mindmap";

export interface ConversationCanvasIntent {
  kind: ConversationCanvasKind;
  title: string;
}

export interface ConversationCanvasRequest {
  noteId: string;
  requestBaseHash: string;
  creating: boolean;
  requestedAt: number;
}

export type ConversationCanvasApplyResult =
  | { status: "applied"; note: OperationNote; notice: string; qualityWarnings?: string[] }
  | { status: "no-change" }
  | { status: "stale" | "invalid"; message: string };

const FLOWCHART_KIND_RE = /(?:流程图|架构图|系统图|拓扑图|泳道图|关系图|示意图|一张图|画成图|整理成图|可视化|flow\s*chart|architecture\s*diagram|system\s*diagram|\bdiagram\b)/i;
const MINDMAP_KIND_RE = /(?:思维导图|思维图|脑图|mind\s*map)/i;
const CREATE_RE = /^(?:(?:你好[,，]?\s*)?(?:请|麻烦)?(?:帮我|给我)?\s*(?:画|绘制|创建|生成|制作|做|新建|整理|转换|draw|create|generate|make|visualize)|(?:把|将)[\s\S]{0,200}?(?:整理|转换|画)成)/i;
const GENERIC_DIAGRAM_CREATE_RE = /(?:画|绘制|创建|生成|制作|做|新建)\s*(?:一个|一张|一份)?\s*([^,，。.!！?？:：\n]{2,60}图)(?=[\s,，。.!！?？:：]|$)/iu;
const OFFICE_DELIVERABLE_RE = /(?:\bpptx?\b|power\s*point|幻灯片|演示文稿|\bdocx?\b|\bword\b|\bxlsx?\b|\bexcel\b)/i;
const NON_DIAGRAM_RE = /(?:图片|图像|截图|地图|图标|封面图|配图|插图|图表)$/u;

export function detectConversationCanvasIntent(content: string): ConversationCanvasIntent | null {
  const text = content.trim();
  if (!text || !CREATE_RE.test(text) || OFFICE_DELIVERABLE_RE.test(text)) return null;
  const genericDiagram = GENERIC_DIAGRAM_CREATE_RE.exec(text)?.[1]?.trim();
  const explicitFlowchart = FLOWCHART_KIND_RE.test(text);
  const explicitMindmap = MINDMAP_KIND_RE.test(text);
  const kind = explicitMindmap && !explicitFlowchart
    ? "mindmap"
    : explicitFlowchart || (genericDiagram && !NON_DIAGRAM_RE.test(genericDiagram))
      ? "flowchart"
      : null;
  if (!kind) return null;
  return { kind, title: deriveConversationCanvasTitle(text, kind) };
}

export function deriveConversationCanvasTitle(
  content: string,
  kind: ConversationCanvasKind,
): string {
  const fallback = kind === "flowchart" ? "未命名流程图" : "未命名思维导图";
  const kindLabel = kind === "flowchart" ? "流程图" : "思维导图";
  let title = content
    .replace(/[。！？!?]+$/g, "")
    .replace(/^(?:你好[,，]?\s*)?(?:请|麻烦)?(?:帮我|给我)?\s*/i, "")
    .replace(/^(?:画|绘制|创建|生成|制作|做|新建)\s*(?:一个|一张|一份)?\s*/i, "")
    .replace(/^(?:draw|create|generate|make)\s+(?:a|an)?\s*/i, "")
    .trim();
  const marker = kind === "flowchart" ? FLOWCHART_KIND_RE : MINDMAP_KIND_RE;
  const match = marker.exec(title);
  if (match) {
    title = title.slice(0, match.index + match[0].length);
  } else if (kind === "flowchart") {
    const genericTitle = /^([^,，。.!！?？:：\n]{2,60}图)(?=[\s,，。.!！?？:：]|$)/u.exec(title);
    if (genericTitle && !NON_DIAGRAM_RE.test(genericTitle[1])) title = genericTitle[1].trim();
  }
  title = title.replace(/^关于\s*/, "").replace(/的流程图$/, "流程图").trim();
  if (!title) return fallback;
  if (!marker.test(title) && !/图$/u.test(title)) title = `${title}${kindLabel}`;
  return title.slice(0, 40) || fallback;
}

export function createConversationCanvasNote(
  kind: ConversationCanvasKind,
  title: string,
  chatId: string,
): OperationNote {
  const now = nowTimestamp();
  return {
    id: `canvas-${crypto.randomUUID()}`,
    notebookId: "",
    title,
    preview: kind === "flowchart" ? "流程图" : "思维导图",
    createdAt: now,
    updatedAt: now,
    source: { kind: "agent", label: "工作区画布" },
    contentMarkdown: kind === "flowchart"
      ? serializeFlowchartMarkdown(title, createBlankFlowchartDocument())
      : `# ${singleLineTitle(title)}`,
    appliedAgentMessageIds: [],
    contextLevel: "full",
    type: kind,
    originChatId: chatId,
  };
}

export function conversationCanvasBaseHash(note: OperationNote): string {
  if (note.type === "flowchart") {
    const parsed = parseFlowchartMarkdown(note.contentMarkdown);
    return parsed.ok ? computeFlowchartSemanticHash(parsed.document) : "";
  }
  return computeBaseHash(note.contentMarkdown);
}

export function buildConversationCanvasPrompt(note: OperationNote, question: string): string {
  const baseHash = conversationCanvasBaseHash(note);
  if (note.type === "flowchart") {
    return `用户正在 Mona 主会话右侧的可编辑画布中工作。

用户要求：
${question}

当前画布 ID：${note.id}

请按 mona-canvas skill 处理；修改通过 canvas 工具在当前编辑器中完成。只讨论内容时直接回答。`;
  }
  const prompt = buildMindMapFreeformPrompt(note, question, null, baseHash);
  return `${prompt}

这是 Mona 主会话右侧正在打开的可编辑画布。请在自然语言说明之后严格输出上述结构化块；不要向用户解释内部协议、baseHash 或 JSON 字段。`;
}

export function applyConversationCanvasResponse(
  note: OperationNote,
  aiContent: string,
  messageId: string,
  requestBaseHash: string,
): ConversationCanvasApplyResult {
  const currentHash = conversationCanvasBaseHash(note);
  if (!currentHash || currentHash !== requestBaseHash) {
    return { status: "stale", message: "生成期间画布已被修改，请重新发送修改要求" };
  }

  if (note.type === "flowchart") {
    const prepared = prepareFlowchartPatch(
      aiContent,
      note.contentMarkdown,
      note.title,
      messageId,
      requestBaseHash,
    );
    if (!prepared.ok) return { status: "no-change" };
    if (prepared.pending.status === "invalid") {
      return { status: "invalid", message: prepared.pending.error ?? "流程图修改无效" };
    }
    const applied = applyFlowchartPendingPatch(prepared.pending, note.contentMarkdown, note.title);
    if (!applied.ok) return { status: "invalid", message: applied.message };
    return {
      status: "applied",
      notice: applied.notice,
      qualityWarnings: applied.summary.qualityIssues?.map((issue) => issue.message),
      note: updatedNote(note, applied.markdown, messageId),
    };
  }

  const prepared = prepareMindMapPatch(
    aiContent,
    note.contentMarkdown,
    messageId,
    requestBaseHash,
  );
  if (!prepared.ok) return { status: "no-change" };
  if (prepared.pending.status === "invalid") {
    return { status: "invalid", message: prepared.pending.error ?? "思维导图修改无效" };
  }
  const applied = applyMindMapPendingPatch(prepared.pending, note.contentMarkdown);
  if (!applied.ok) return { status: "invalid", message: applied.message };
  return {
    status: "applied",
    notice: applied.notice,
    note: updatedNote(note, applied.markdown, messageId),
  };
}

export function stripConversationCanvasBlocks(content: string): string {
  const stripped = content
    .replace(/```(?:mona-flowchart-patch|mindmap-patch|mindmap)\s*[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped || (content.trim() ? "画布已更新。" : "");
}

function updatedNote(note: OperationNote, contentMarkdown: string, messageId: string): OperationNote {
  const appliedIds = new Set(note.appliedAgentMessageIds ?? []);
  appliedIds.add(messageId);
  return {
    ...note,
    contentMarkdown,
    updatedAt: nowTimestamp(),
    appliedAgentMessageIds: [...appliedIds],
  };
}

function singleLineTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim() || "未命名思维导图";
}
