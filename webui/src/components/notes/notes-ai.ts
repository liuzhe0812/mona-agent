import type { NoteAiActionId, OperationNote } from "./notes-data";

export interface ExtractedKnowledgeDraft {
  categoryName: string;
  title: string;
  summary: string;
  content: string;
  sourceDescription: string;
  tags: string[];
}

export const NOTE_AI_ACTIONS: Array<{
  id: Exclude<NoteAiActionId, "freeform">;
  label: string;
  description: string;
}> = [
  {
    id: "summary",
    label: "总结当前笔记",
    description: "提炼重点、结论和下一步",
  },
  {
    id: "extractKnowledge",
    label: "提取知识点",
    description: "整理为结构化个人知识库条目",
  },
];

export function buildAgentActionPrompt(
  actionId: Exclude<NoteAiActionId, "freeform">,
  note: OperationNote,
  filePath?: string,
): string {
  if (actionId === "summary") {
    if (filePath) {
      return [
        "请总结这篇笔记的内容。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后直接输出总结。`,
        "要求：只输出总结内容，不要追问，不要询问更多信息。",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return `请总结这篇笔记的内容。\n\n${context}\n\n要求：只输出总结内容，不要追问，不要询问更多信息。`;
  }

  if (actionId === "extractKnowledge") {
    const instruction = [
      "请从这篇笔记中提取一个最有复用价值的知识点，整理成个人知识库条目。",
      "",
      "只输出一个 JSON 对象，不要输出 Markdown 代码块，不要解释，不要追问。",
      "JSON 字段必须是：",
      "{",
      '  "categoryName": "知识分类名称。请根据笔记内容自动归类；没有合适分类时，创建一个简短自然的新分类名，不要固定套用运维或技术分类",',
      '  "title": "知识点标题",',
      '  "summary": "概述，1-3 句话",',
      '  "content": "正文内容，保留关键观点、定义、步骤、示例、链接或结论，可使用 Markdown",',
      '  "sourceDescription": "来源链接或来源说明；没有链接时写来自当前笔记",',
      '  "tags": ["标签1", "标签2"]',
      "}",
      "",
      "要求：",
      "- 不要整篇复制原文，只提炼可复用知识点。",
      "- 不要编造笔记里没有的信息。",
      "- categoryName 必须由内容决定，用简短名词短语，不要全部归到通用分类。",
      "- 如果笔记里有多个知识点，只选最稳定、最适合沉淀的一个。",
    ].join("\n");

    if (filePath) {
      return [
        instruction,
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后按上面的 JSON 格式输出。`,
      ].join("\n");
    }

    return `${instruction}\n\n${formatNoteContext(note)}`;
  }

  return "";
}

export function buildFreeformAgentPrompt(note: OperationNote, question: string): string {
  return `用户正在笔记页面里处理当前笔记，请只围绕这篇笔记回答。

用户问题：
${question}

${formatNoteContext(note)}`;
}

export function buildAgentResultMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? `${trimmed}\n` : `## Agent 处理结果\n\n${trimmed}\n`;
}

export function deriveNotePreview(markdown: string): string {
  const text = stripMarkdown(markdown).replace(/\s+/g, " ").trim();
  return text.slice(0, 46) || "空白笔记";
}

export function parseExtractedKnowledge(content: string): ExtractedKnowledgeDraft {
  const raw = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI 回复不是有效的知识点 JSON");
  }

  if (!isRecord(parsed)) {
    throw new Error("AI 回复不是有效的知识点对象");
  }

  const draft: ExtractedKnowledgeDraft = {
    categoryName: readRequiredString(parsed, "categoryName"),
    title: readRequiredString(parsed, "title"),
    summary: readRequiredString(parsed, "summary"),
    content: readRequiredString(parsed, "content"),
    sourceDescription: readRequiredString(parsed, "sourceDescription"),
    tags: readStringArray(parsed, "tags"),
  };

  if (draft.tags.length === 0) {
    throw new Error("知识点缺少标签");
  }

  return draft;
}

export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\(([^)]*)\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~|]/g, " ");
}

function extractJsonObject(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() || content.trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("AI 回复里没有知识点 JSON");
  }
  return source.slice(start, end + 1);
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`知识点缺少字段：${key}`);
  }
  return field.trim();
}

function readStringArray(value: Record<string, unknown>, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Error(`知识点字段不是数组：${key}`);
  }
  return Array.from(
    new Set(
      field
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatNoteContext(note: OperationNote): string {
  const content = note.contentMarkdown.slice(0, 12000);
  const truncated = note.contentMarkdown.length > content.length;

  return `当前笔记：
- 标题：${note.title}
- 来源：${note.source.label}
- 标签：${note.tags.join("、") || "无"}

Markdown 内容：
\`\`\`markdown
${content}${truncated ? "\n\n...内容过长，已截断" : ""}
\`\`\``;
}
