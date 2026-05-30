import type { KnowledgeCategory, NoteAiActionId, OperationNote } from "./notes-data";

export interface ExtractedKnowledgeDraft {
  categoryName: string;
  title: string;
  summary: string;
  content: string;
  sourceDescription: string;
  tags: string[];
}

export interface ExtractedKnowledgeCandidateDraft {
  categoryName: string;
  title: string;
  summary: string;
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
  {
    id: "polish",
    label: "润色优化",
    description: "优化表达、修正语法、理顺逻辑",
  },
  {
    id: "translate",
    label: "翻译",
    description: "中文译英文，其他语言译中文",
  },
  {
    id: "continue",
    label: "续写扩展",
    description: "延续末尾内容和风格继续写",
  },
  {
    id: "autoTag",
    label: "自动标签",
    description: "分析全文生成1-3个核心标签",
  },
];

export function buildAgentActionPrompt(
  actionId: Exclude<NoteAiActionId, "freeform">,
  note: OperationNote,
  filePath?: string,
  knowledgeCategories: KnowledgeCategory[] = [],
  existingTags: string[] = [],
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
    const categoryContext = formatKnowledgeCategoryContext(knowledgeCategories);
    const tagContext = formatExistingTagContext(existingTags);
    const instruction = [
      "请从这篇笔记中提取 1-5 个最有复用价值的候选知识点，供用户确认后保存到个人知识库。",
      "",
      categoryContext,
      "",
      tagContext,
      "",
      "只输出一个 JSON 对象，不要输出 Markdown 代码块，不要解释，不要追问。",
      "JSON 字段必须是：",
      "{",
      '  "items": [',
      "    {",
      '      "categoryName": "知识分类路径。必须按内容所属领域分类，使用 / 表示多级分类，例如 技术/人工智能/模型量化；只有和已有分类语义高度匹配时才复用已有分类",',
      '      "title": "知识点标题",',
      '      "summary": "精简内容总结，2-5 句话，只保留笔记里最值得沉淀的内容，不按固定格式拆分",',
      '      "sourceDescription": "来源链接或来源说明；没有链接时写来自当前笔记",',
      '      "tags": ["标签1"]',
      "    }",
      "  ]",
      "}",
      "",
      "提取要求：",
      "- 只提取能脱离原文复用的知识点；临时想法、待确认内容、流水账不要保存。",
      "- 不要整篇复制原文，不要大段搬运笔记，只输出压缩后的知识点。",
      "- 不要编造笔记里没有的信息。",
      "- 每个 summary 只写精简内容总结，不要输出“为什么值得保存/关键概念/适用场景/注意事项”等固定分区。",
      "- 如果笔记只有一个稳定知识点，就只返回 1 个 item；不要为了凑数拆分。",
      "",
      "标签要求：",
      "- tags 必须是 1-4 个。",
      "- 优先复用上面已有标签；只有没有合适标签时才新增。",
      "- 如果已有标签里有能准确覆盖当前知识点的标签，必须使用已有标签，不要换个近义词新建。",
      "- 标签使用领域级或主题级词，不要把参数、型号、缩写、版本号当标签。",
      "- 例如 BF16、FP16、INT8 这类具体参数不要作为标签，除非整篇笔记主题就是某一个参数。",
      "",
      "分类要求：",
      "- 分类先判断内容所属领域，再看已有分类是否匹配；不要因为已有分类存在就强行复用。",
      "- 只有已有分类与当前知识点的主题、学科或技术域高度一致时，才复用已有分类路径，并原样返回完整路径。",
      "- 如果已有分类只是宽泛相关或明显不属于同一领域，必须创建新的多级分类路径。",
      "- categoryName 默认至少二级分类，用简短名词短语，不要全部归到通用分类或未分类。",
      "- 技术内容必须从技术角度归类，例如 AI 模型精度格式、FP16、BF16、INT8、量化等内容应归到类似 技术/人工智能/模型量化 或 技术/人工智能/模型压缩，不应归到教育技术。",
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

  if (actionId === "polish") {
    if (filePath) {
      return [
        "请对这篇笔记进行润色优化。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后输出润色后的全文。`,
        "要求：",
        "- 保留原文所有信息和结构，不增删内容",
        "- 优化语言表达，使文字更通顺、简洁、准确",
        "- 修正语法错误和标点问题",
        "- 理顺逻辑衔接，但不改变原有逻辑顺序",
        "- 只输出润色后的内容，不要追问，不要解释修改了什么",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请对这篇笔记进行润色优化。",
      "",
      context,
      "",
      "要求：",
      "- 保留原文所有信息和结构，不增删内容",
      "- 优化语言表达，使文字更通顺、简洁、准确",
      "- 修正语法错误和标点问题",
      "- 理顺逻辑衔接，但不改变原有逻辑顺序",
      "- 只输出润色后的内容，不要追问，不要解释修改了什么",
    ].join("\n");
  }

  if (actionId === "translate") {
    if (filePath) {
      return [
        "请翻译这篇笔记。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后输出翻译。`,
        "翻译规则：",
        "- 如果原文是中文，翻译为英文",
        "- 如果原文是其他语言，翻译为中文",
        "- 保持原文的格式和结构",
        "- 专业术语保留原文并在括号中附上翻译",
        "- 只输出译文，不要追问，不要解释",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请翻译这篇笔记。",
      "",
      context,
      "",
      "翻译规则：",
      "- 如果原文是中文，翻译为英文",
      "- 如果原文是其他语言，翻译为中文",
      "- 保持原文的格式和结构",
      "- 专业术语保留原文并在括号中附上翻译",
      "- 只输出译文，不要追问，不要解释",
    ].join("\n");
  }

  if (actionId === "continue") {
    if (filePath) {
      return [
        "请续写这篇笔记。",
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后从笔记末尾自然续写。`,
        "要求：",
        "- 延续笔记末尾的主题和写作风格",
        "- 内容自然衔接，不重复已有内容",
        "- 续写长度适中，与原文风格一致",
        "- 只输出续写部分，不要追问，不要解释",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请续写这篇笔记。",
      "",
      context,
      "",
      "要求：",
      "- 延续笔记末尾的主题和写作风格",
      "- 内容自然衔接，不重复已有内容",
      "- 续写长度适中，与原文风格一致",
      "- 只输出续写部分，不要追问，不要解释",
    ].join("\n");
  }

  if (actionId === "autoTag") {
    const existingTagsLine = note.tags.length > 0 ? `已有标签：${note.tags.join("、")}` : "已有标签：无";
    if (filePath) {
      return [
        "请为这篇笔记生成1-3个最核心的标签。",
        "",
        existingTagsLine,
        "",
        `使用 read_file 工具读取文件 ${filePath}，阅读后输出标签。`,
        "要求：",
        "- 分析全文核心主题，输出1-3个领域级或主题级标签",
        "- 如果已有标签能准确概括核心主题，优先复用",
        "- 标签用逗号分隔，只输出标签本身，不要输出编号、解释或其他内容",
        "- 不要追问",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请为这篇笔记生成1-3个最核心的标签。",
      "",
      existingTagsLine,
      "",
      context,
      "",
      "要求：",
      "- 分析全文核心主题，输出1-3个领域级或主题级标签",
      "- 如果已有标签能准确概括核心主题，优先复用",
      "- 标签用逗号分隔，只输出标签本身，不要输出编号、解释或其他内容",
      "- 不要追问",
    ].join("\n");
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

export function parseExtractedKnowledgeCandidates(
  content: string,
): ExtractedKnowledgeCandidateDraft[] {
  const raw = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AI 回复不是有效的知识点 JSON");
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error("AI 回复缺少 items 候选知识点列表");
  }

  if (parsed.items.length < 1 || parsed.items.length > 5) {
    throw new Error("候选知识点数量必须是 1-5 个");
  }

  return parsed.items.map((item, index) => readKnowledgeCandidate(item, index));
}

export function createKnowledgeDraftFromCandidate(
  candidate: ExtractedKnowledgeCandidateDraft,
): ExtractedKnowledgeDraft {
  return {
    categoryName: candidate.categoryName,
    title: candidate.title,
    summary: candidate.summary,
    content: candidate.summary,
    sourceDescription: candidate.sourceDescription,
    tags: candidate.tags,
  };
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

function readKnowledgeCandidate(
  value: unknown,
  index: number,
): ExtractedKnowledgeCandidateDraft {
  if (!isRecord(value)) {
    throw new Error(`第 ${index + 1} 个候选知识点不是有效对象`);
  }

  const candidate: ExtractedKnowledgeCandidateDraft = {
    categoryName: readRequiredString(value, "categoryName", index),
    title: readRequiredString(value, "title", index),
    summary: readRequiredString(value, "summary", index),
    sourceDescription: readRequiredString(value, "sourceDescription", index),
    tags: readStringArray(value, "tags", index).slice(0, 4),
  };

  if (candidate.tags.length === 0) {
    throw new Error(`第 ${index + 1} 个候选知识点缺少标签`);
  }

  return candidate;
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

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  itemIndex: number,
): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`第 ${itemIndex + 1} 个候选知识点缺少字段：${key}`);
  }
  return field.trim();
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
  itemIndex: number,
): string[] {
  const field = value[key];
  if (!Array.isArray(field)) {
    throw new Error(`第 ${itemIndex + 1} 个候选知识点字段不是数组：${key}`);
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

function formatKnowledgeCategoryContext(categories: KnowledgeCategory[]): string {
  const paths = formatKnowledgeCategoryPaths(categories);
  if (paths.length === 0) {
    return [
      "当前已有知识分类路径：",
      "- 未分类",
      "",
      "分类规则：当前没有可复用分类时，按内容所属领域创建新的多级分类路径。",
    ].join("\n");
  }

  return [
    "当前已有知识分类路径：",
    ...paths.map((path) => `- ${path}`),
    "",
    "分类规则：只有主题、学科或技术域高度一致时才复用已有路径；不匹配时创建新的多级分类路径。",
  ].join("\n");
}

function formatExistingTagContext(tags: string[]): string {
  const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  if (uniqueTags.length === 0) {
    return [
      "当前已有标签：",
      "- 暂无",
      "",
      "标签规则：当前没有可复用标签时，创建 1-4 个领域级或主题级标签。",
    ].join("\n");
  }

  return [
    "当前已有标签：",
    ...uniqueTags.map((tag) => `- ${tag}`),
    "",
    "标签规则：优先复用已有标签；已有标签能覆盖当前知识点时必须使用已有标签；确实没有合适标签时才新增，避免标签越积越细。",
  ].join("\n");
}

function formatKnowledgeCategoryPaths(categories: KnowledgeCategory[]): string[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const pathCache = new Map<string, string>();

  const getPath = (category: KnowledgeCategory, seen = new Set<string>()): string => {
    const cached = pathCache.get(category.id);
    if (cached) return cached;
    if (seen.has(category.id)) return category.name;
    seen.add(category.id);

    const parent = category.parentId ? byId.get(category.parentId) : null;
    const path = parent ? `${getPath(parent, seen)}/${category.name}` : category.name;
    pathCache.set(category.id, path);
    return path;
  };

  return categories
    .map((category) => getPath(category))
    .filter(Boolean);
}
