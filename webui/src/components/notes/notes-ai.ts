import type { NoteAiActionId, NoteTransformation, OperationNote } from "./notes-data";

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
    id: "translate",
    label: "翻译",
    description: "中文译英文，其他语言译中文",
  },
  {
    id: "generateTags",
    label: "生成标签",
    description: "AI 自动生成 3-5 个标签",
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

  if (actionId === "generateTags") {
    const context = formatNoteContext(note);
    return [
      "请为这篇笔记生成 3-5 个标签。",
      "",
      context,
      "",
      "要求：",
      "- 标签应概括笔记的核心主题、技术领域或关键概念",
      "- 每个标签 2-6 个字，简洁准确",
      "- 优先使用通用的技术或领域术语",
      "- 不要输出 Markdown 格式，不要使用 # 号",
      "- 只输出标签，每行一个，不要追问，不要解释",
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
  { pattern: /^请翻译这篇笔记/, label: "翻译" },
  { pattern: /^请为这篇笔记生成 3-5 个标签/, label: "生成标签" },
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

/**
 * 从 AI 生成的标签输出中解析标签数组。
 * 支持每行一个标签、逗号分隔、# 前缀等格式。
 */
export function parseGeneratedTags(content: string): string[] {
  const lines = content
    .split(/[\n,，;；]/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[·•\-*\[\]]+\s*/, "").trim())
    .filter((line) => line.length > 0 && line.length <= 20);
  // 去重，保持顺序
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      tags.push(line);
    }
    if (tags.length >= 5) break;
  }
  return tags;
}

export function deriveNotePreview(markdown: string): string {
  const text = stripMarkdown(markdown).replace(/\s+/g, " ").trim();
  return text.slice(0, 46) || "空白笔记";
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
