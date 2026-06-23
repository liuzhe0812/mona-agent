import type { KnowledgeCategory, NoteAiActionId, NoteTransformation, OperationNote } from "./notes-data";

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
    id: "generateHtml",
    label: "生成HTML文档",
    description: "生成精美排版的HTML文档",
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
      '      "summary": "100字以内的总结性描述，让读者快速了解这个知识点在讲什么，不要涉及具体内容细节",',
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
      "- 每个 summary 只写总结性描述，100字以内，让读者知道这个知识点在讲什么即可，不要涉及具体内容细节，不要输出“为什么值得保存/关键概念/适用场景/注意事项”等固定分区。",
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

  if (actionId === "generateHtml") {
    if (filePath) {
      return [
        `请基于当前笔记内容，生成一份精美的HTML文档。使用 read_file 工具读取文件 ${filePath}，阅读后生成HTML文档。要求输出一个完整的、自包含的HTML文件（所有CSS写在<style>标签内），不要输出Markdown代码块包裹，不要解释。`,
        "",
        "文档风格规范（必须严格遵循）：",
        "【配色方案】",
        "- 主色：#1a3a5c（深蓝），辅助色：#2c5f8a（中蓝）",
        "- 强调色：#c9a84c（金色），浅强调色：#e8d59a",
        "- 背景：#ffffff，柔背景：#f8f7f4，区域背景：#faf9f6",
        "- 文字：#2c2c2c，次要文字：#5a5a5a，弱化文字：#8a8a8a",
        "- 边框：#e0ddd5，浅边框：#eeece6",
        "",
        "【封面页】",
        "- 全屏高度，深蓝渐变背景：linear-gradient(160deg, #0d1b2a 0%, #1b2d45 40%, #1a3a5c 70%, #2c5f8a 100%)",
        "- 居中白色文字，标题用笔记标题",
        "- 标题上方有金色边框徽章（letter-spacing: 4px）",
        "- 标题下方有副标题行和80px宽金色分割线",
        "- 底部有元信息行",
        "",
        "【左侧导航栏】",
        "- 240px宽，sticky定位，柔背景色，紧贴左侧无间距",
        '- 标题"目录"，各节链接',
        "- 链接无左边距和左边框，文字紧贴左侧，active状态用背景色和加粗区分",
        "",
        "【正文排版】",
        '- 节编号：金色，如"01"、"02"，letter-spacing: 3px',
        "- h2：Noto Serif SC，32px，深蓝色，letter-spacing: 2px",
        "- h3：Noto Serif SC，20px，深蓝色，左侧3px金色竖线",
        "- 段落：15px，行高1.8，次要文字色",
        "- 节之间用1px分割线隔开，间距80px",
        "",
        "【特色组件】",
        "- 高亮框：柔背景+浅边框+圆角8px",
        "- 特性卡片：2列网格，hover时金色边框+阴影",
        "- 流程步骤：横向排列，圆形编号，箭头连接",
        "- 对比行：左红右绿双栏对比",
        "- 表格：深蓝表头白字，偶数行柔背景",
        "",
        "【页脚】",
        "- 与封面同色深蓝渐变背景",
        "- 居中文字，内容为：Made by Mona",
        "",
        "【响应式】",
        "- 768px以下：封面标题缩小，单列布局，侧边栏隐藏",
        "",
        "【字体】",
        "- 引入 Google Fonts：Noto Serif SC 和 Noto Sans SC",
        "- 标题用 Noto Serif SC，正文用 Noto Sans SC",
        "",
        "根据笔记内容自动划分章节、生成目录、设计封面。",
        "生成完成后，使用 write_file 工具将 HTML 内容保存到 .mona/output/ 目录，文件名使用笔记标题（去除特殊字符）加 .html 后缀。",
        "不要在回复中输出 HTML 代码，只通过 write_file 工具保存文件即可。",
      ].join("\n");
    }
    const context = formatNoteContext(note);
    return [
      "请基于当前笔记内容，生成一份精美的HTML文档。要求输出一个完整的、自包含的HTML文件（所有CSS写在<style>标签内）。",
      "",
      "文档风格规范（必须严格遵循）：",
      "【配色方案】",
      "- 主色：#1a3a5c（深蓝），辅助色：#2c5f8a（中蓝）",
      "- 强调色：#c9a84c（金色），浅强调色：#e8d59a",
      "- 背景：#ffffff，柔背景：#f8f7f4，区域背景：#faf9f6",
      "- 文字：#2c2c2c，次要文字：#5a5a5a，弱化文字：#8a8a8a",
      "- 边框：#e0ddd5，浅边框：#eeece6",
      "",
      "【封面页】",
      "- 全屏高度，深蓝渐变背景：linear-gradient(160deg, #0d1b2a 0%, #1b2d45 40%, #1a3a5c 70%, #2c5f8a 100%)",
      "- 居中白色文字，标题用笔记标题",
      "- 标题上方有金色边框徽章（letter-spacing: 4px）",
      "- 标题下方有副标题行和80px宽金色分割线",
      "- 底部有元信息行",
      "",
      "【左侧导航栏】",
      "- 240px宽，sticky定位，柔背景色，紧贴左侧无间距",
      '- 标题"目录"，各节链接',
      "- 链接无左边距和左边框，文字紧贴左侧，active状态用背景色和加粗区分",
      "",
      "【正文排版】",
      '- 节编号：金色，如"01"、"02"，letter-spacing: 3px',
      "- h2：Noto Serif SC，32px，深蓝色，letter-spacing: 2px",
      "- h3：Noto Serif SC，20px，深蓝色，左侧3px金色竖线",
      "- 段落：15px，行高1.8，次要文字色",
      "- 节之间用1px分割线隔开，间距80px",
      "",
      "【特色组件】",
      "- 高亮框：柔背景+浅边框+圆角8px",
      "- 特性卡片：2列网格，hover时金色边框+阴影",
      "- 流程步骤：横向排列，圆形编号，箭头连接",
      "- 对比行：左红右绿双栏对比",
      "- 表格：深蓝表头白字，偶数行柔背景",
      "",
      "【页脚】",
      "- 与封面同色深蓝渐变背景",
      "- 居中文字，内容为：Made by Mona",
      "",
      "【响应式】",
      "- 768px以下：封面标题缩小，单列布局，侧边栏隐藏",
      "",
      "【字体】",
      "- 引入 Google Fonts：Noto Serif SC 和 Noto Sans SC",
      "- 标题用 Noto Serif SC，正文用 Noto Sans SC",
      "",
      context,
      "",
      "根据笔记内容自动划分章节、生成目录、设计封面。",
      "生成完成后，使用 write_file 工具将 HTML 内容保存到 .mona/output/ 目录，文件名使用笔记标题（去除特殊字符）加 .html 后缀。",
      "不要在回复中输出 HTML 代码，只通过 write_file 工具保存文件即可。",
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

/**
 * Build a prompt for a user-defined transformation template.
 * Replaces variables {{note_title}}, {{note_content}}, {{note_tags}}, {{note_source}}
 * with the note's actual values. If the template contains no variables, the note
 * context is appended automatically so the agent still has access to the note.
 */
export function buildTransformationPrompt(
  transformation: NoteTransformation,
  note: OperationNote,
): string {
  const content = note.contentMarkdown.slice(0, 12000);
  const truncated = note.contentMarkdown.length > content.length;
  const noteContent = truncated ? `${content}\n\n...内容过长，已截断` : content;
  const tags = note.tags.join("、") || "无";

  let prompt = transformation.promptTemplate;
  let hasVariable = false;

  const replacements: Array<[RegExp, string]> = [
    [/\{\{\s*note_title\s*\}\}/g, note.title],
    [/\{\{\s*note_content\s*\}\}/g, noteContent],
    [/\{\{\s*note_tags\s*\}\}/g, tags],
    [/\{\{\s*note_source\s*\}\}/g, note.source.label],
  ];

  for (const [pattern, value] of replacements) {
    if (pattern.test(prompt)) {
      hasVariable = true;
      prompt = prompt.replace(pattern, value);
    }
  }

  // If the template has no variables, append the note context so the agent
  // still has access to the note content.
  if (!hasVariable) {
    prompt = `${prompt}\n\n${formatNoteContext(note)}`;
  }

  return prompt;
}

/** Pattern-to-label pairs for inferring displayContent from persisted user messages. */
const ACTION_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^请总结这篇笔记的内容/, label: "总结当前笔记" },
  { pattern: /^请从这篇笔记中提取/, label: "提取知识点" },
  { pattern: /^请对这篇笔记进行润色优化/, label: "润色优化" },
  { pattern: /^请翻译这篇笔记/, label: "翻译" },
  { pattern: /^请续写这篇笔记/, label: "续写扩展" },
  { pattern: /^请基于当前笔记内容，生成一份精美的HTML文档/, label: "生成HTML文档" },
];

/**
 * Infer a short display label from a persisted user message that was sent by a
 * note AI quick-action.  Returns `undefined` when the content doesn't match any
 * known action pattern (i.e. a freeform question).
 */
export function inferNoteActionDisplayLabel(content: string): string | undefined {
  if (!content) return undefined;

  // Check quick-action patterns first
  for (const { pattern, label } of ACTION_PROMPT_PATTERNS) {
    if (pattern.test(content)) return label;
  }

  // Extract user question from freeform prompt
  const freeformMatch = content.match(/^用户正在笔记页面里处理当前笔记[\s\S]*?用户问题：\n(.+?)(?:\n\n当前笔记：|$)/);
  if (freeformMatch) {
    const question = freeformMatch[1].trim();
    if (question) return question;
  }

  return undefined;
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

export interface NoteSearchResult {
  noteId: string;
  title: string;
  snippet: string;
  rank: number;
}

export function formatKnowledgeBaseContext(results: NoteSearchResult[]): string {
  if (results.length === 0) return "";

  const sections = results
    .map((r, i) => `### ${i + 1}. ${r.title}\n${r.snippet.replace(/⟨/g, "**").replace(/⟩/g, "**")}`)
    .join("\n\n");

  return [
    "当前笔记本已设为知识库，以下是从笔记本中检索到的相关笔记片段，请结合这些内容回答：",
    "",
    sections,
    "",
    "如果检索内容不足以回答，请如实说明。",
  ].join("\n");
}
