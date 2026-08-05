/**
 * 图表文档 v2 序列化、解析与文本投影。
 *
 * 规范（见计划 §11）：
 * 1. 每张图保存为单个 .md 文件，含且仅含一个 ```mona-diagram fenced block；
 * 2. 围栏之前是自动生成的只读文本投影；JSON 是权威数据源；
 * 3. 解析失败返回错误消息，不抛异常、不创建空文档覆盖原内容；
 * 4. JSON 使用 2 空格格式化，便于 diff；
 * 5. 双格式读取：同时支持 mona-diagram v2 与 mona-flowchart v1（迁移为 v2 内存模型）。
 */

import {
  countFlowchartFences,
  parseFlowchartMarkdown,
} from "../flowchart/flowchart-document";
import {
  DIAGRAM_FENCE_LANG,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramElement,
  type DiagramKind,
} from "./diagram-document";
import { migrateFlowchartV1ToDiagramV2 } from "./diagram-migrate";
import {
  normalizeDiagramDocument,
  validateDiagramDocument,
} from "./diagram-validator";

// ---------------------------------------------------------------------------
// 围栏提取
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /```mona-diagram\s*\n/g;
const FENCE_CLOSE_RE = /```/g;

export interface ExtractedDiagramFence {
  content: string;
  startOffset: number;
  endOffset: number;
}

/** 提取第一个 mona-diagram fenced block 内容；找不到返回 null。 */
export function extractDiagramFence(markdown: string): ExtractedDiagramFence | null {
  const openMatch = FENCE_OPEN_RE.exec(markdown);
  if (!openMatch) return null;
  const contentStart = openMatch.index + openMatch[0].length;
  FENCE_CLOSE_RE.lastIndex = contentStart;
  const closeMatch = FENCE_CLOSE_RE.exec(markdown);
  if (!closeMatch) return null;
  return {
    content: markdown.slice(contentStart, closeMatch.index),
    startOffset: openMatch.index,
    endOffset: closeMatch.index + closeMatch[0].length,
  };
}

/** 统计 mona-diagram 围栏数量。 */
export function countDiagramFences(markdown: string): number {
  let count = 0;
  FENCE_OPEN_RE.lastIndex = 0;
  while (FENCE_OPEN_RE.exec(markdown) !== null) count++;
  FENCE_OPEN_RE.lastIndex = 0;
  return count;
}

// ---------------------------------------------------------------------------
// 解析（v2）
// ---------------------------------------------------------------------------

export type ParseDiagramResult =
  | { ok: true; document: DiagramDocument; title: string }
  | { ok: false; message: string };

/**
 * 解析 v2 mona-diagram Markdown 文件。
 * 要求：恰好一个 mona-diagram 围栏；JSON 通过 validateDiagramDocument。
 */
export function parseDiagramMarkdown(markdown: string): ParseDiagramResult {
  const fenceCount = countDiagramFences(markdown);
  if (fenceCount === 0) {
    return { ok: false, message: "缺少 mona-diagram fenced block" };
  }
  if (fenceCount > 1) {
    return { ok: false, message: `存在 ${fenceCount} 个 mona-diagram fenced block，只能有一个` };
  }
  const extracted = extractDiagramFence(markdown);
  if (!extracted) {
    return { ok: false, message: "无法解析 mona-diagram fenced block" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.content);
  } catch (e) {
    return { ok: false, message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const validation = validateDiagramDocument(parsed);
  if (!validation.ok) {
    const detail = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    return { ok: false, message: `文档校验失败：${detail}` };
  }
  const document = normalizeDiagramDocument(parsed);
  const title = extractTitleFromMarkdown(markdown);
  return { ok: true, document, title };
}

// ---------------------------------------------------------------------------
// 双格式读取（v2 优先，v1 迁移）
// ---------------------------------------------------------------------------

export interface DualReadDiagramResult {
  ok: true;
  document: DiagramDocument;
  title: string;
  /** "v2" 直接解析；"v1-migrated" 由旧流程图迁移而来（尚未写回 v2） */
  format: "v2" | "v1-migrated";
  /** 迁移产生的非阻塞性提示 */
  warnings: string[];
}

export type DualReadDiagramOutcome =
  | DualReadDiagramResult
  | { ok: false; message: string };

/**
 * 双格式读取：优先解析 mona-diagram v2；否则尝试 mona-flowchart v1 并迁移。
 * 同时存在两种围栏视为硬错误（防止双写不一致）。
 */
export function parseDiagramOrFlowchartMarkdown(markdown: string): DualReadDiagramOutcome {
  const v2Count = countDiagramFences(markdown);
  const v1Count = countFlowchartFences(markdown);
  if (v2Count === 0 && v1Count === 0) {
    return { ok: false, message: "缺少 mona-diagram 或 mona-flowchart fenced block" };
  }
  if (v2Count > 0 && v1Count > 0) {
    return { ok: false, message: "同时存在 mona-diagram 与 mona-flowchart 围栏，无法确定权威数据源" };
  }
  if (v2Count > 0) {
    const result = parseDiagramMarkdown(markdown);
    if (!result.ok) return result;
    return { ok: true, document: result.document, title: result.title, format: "v2", warnings: [] };
  }
  const v1 = parseFlowchartMarkdown(markdown);
  if (!v1.ok) return v1;
  try {
    const migrated = migrateFlowchartV1ToDiagramV2(v1.document);
    const validation = validateDiagramDocument(migrated.document);
    if (!validation.ok) {
      const detail = validation.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
      return { ok: false, message: `v1 迁移结果校验失败：${detail}` };
    }
    return {
      ok: true,
      document: migrated.document,
      title: v1.title,
      format: "v1-migrated",
      warnings: migrated.warnings,
    };
  } catch (e) {
    return { ok: false, message: `v1 迁移失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 判断 markdown 是否为图表文档（v1 或 v2）。 */
export function isDiagramMarkdown(markdown: string): boolean {
  return countDiagramFences(markdown) > 0 || countFlowchartFences(markdown) > 0;
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

/**
 * 序列化图表文档为 Markdown：标题 + 文本投影 + mona-diagram 围栏。
 * 调用方不能手写文本投影，必须使用本函数。
 */
export function serializeDiagramMarkdown(title: string, doc: DiagramDocument): string {
  const projection = buildDiagramIndexMarkdown(title, doc);
  const json = JSON.stringify(doc, null, 2);
  return `${projection}\n\n\`\`\`${DIAGRAM_FENCE_LANG}\n${json}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// 文本投影
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<DiagramKind, string> = {
  freeform: "自由图",
  flowchart: "流程图",
  swimlane: "泳道流程图",
  framework: "框架图",
  architecture: "软件架构图",
  deployment: "部署/云架构图",
  sequence: "时序图",
  erd: "ER 图",
  class: "类图",
  state: "状态图",
  usecase: "用例图",
  orgchart: "组织架构图",
  timeline: "时间线",
  matrix: "矩阵图",
};

function elementLabel(el: DiagramElement): string {
  switch (el.type) {
    case "shape":
    case "text":
      return el.textBlocks.map((b) => b.text).join(" ").trim();
    case "icon":
      return el.iconRef.name;
    case "image":
      return el.alt ?? el.assetId;
    case "group":
      return el.title ?? "";
    case "container":
      return el.title;
    case "brace":
      return "";
    case "table":
      return el.sections
        .flatMap((s) => s.rows)
        .flatMap((r) => r.cells)
        .map((c) => c.text)
        .filter(Boolean)
        .join(" ");
    case "lifeline":
      return el.title;
    case "activation":
    case "freehand":
      return "";
  }
}

function connectorLabel(c: DiagramConnector, labelOf: (id: string) => string): string {
  const src = c.source.elementId ? labelOf(c.source.elementId) : "";
  const tgt = c.target.elementId ? labelOf(c.target.elementId) : "";
  const text = c.label?.map((b) => b.text).join(" ").trim() ?? "";
  const arrow = `${src} → ${tgt}`.trim();
  return text ? `${arrow}：${text}` : arrow;
}

/**
 * 生成 Markdown 文本投影（只读派生产物）。
 * 用途：文件可读内容、后端 preview/plainText/search、关系图扫描。
 */
export function buildDiagramIndexMarkdown(title: string, doc: DiagramDocument): string {
  const labels = new Map<string, string>();
  for (const el of doc.elements) labels.set(el.id, elementLabel(el));

  const lines: string[] = [];
  lines.push(`# ${title || "未命名图表"}`);
  lines.push("");
  lines.push(`> 类型：${KIND_LABELS[doc.diagramKind]}`);
  lines.push("");
  lines.push("## 元素");
  lines.push("");
  const labeled = doc.elements.filter((el) => elementLabel(el).length > 0);
  if (labeled.length === 0) {
    lines.push("- （无元素）");
  } else {
    for (const el of labeled) {
      const role = el.semantic?.role ? `[${el.semantic.role}] ` : "";
      lines.push(`- ${role}${elementLabel(el)}`);
    }
  }
  lines.push("");
  lines.push("## 连接");
  lines.push("");
  const labeledConnectors = doc.connectors.filter((c) => connectorLabel(c, (id) => labels.get(id) ?? id).length > 0);
  if (labeledConnectors.length === 0) {
    lines.push("- （无连接）");
  } else {
    for (const c of labeledConnectors) {
      lines.push(`- ${connectorLabel(c, (id) => labels.get(id) ?? id)}`);
    }
  }
  return lines.join("\n");
}

/** 生成 plainText：用于前端 preview 显示。 */
export function buildDiagramPlainText(title: string, doc: DiagramDocument): string {
  const parts: string[] = [];
  if (title) parts.push(title);
  for (const el of doc.elements) {
    const label = elementLabel(el);
    if (label) parts.push(label);
  }
  for (const c of doc.connectors) {
    const text = c.label?.map((b) => b.text).join(" ").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function extractTitleFromMarkdown(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
    if (trimmed.startsWith("```")) return "";
    return "";
  }
  return "";
}
