import {
  Heading1, Heading2, Heading3, Heading4, Heading5, Heading6,
  List, ListOrdered, CheckSquare, Quote, Code, Table, Minus,
  Sigma, GitBranch, GitCommit, Calendar, Layers, Activity, PieChart, Database, Map,
} from "lucide-react";
import type { SuggestionProps } from "@tiptap/suggestion";
import { type Editor, type Range } from "@tiptap/core";

export interface SlashCommandItem {
  title: string;
  description?: string;
  icon: React.ReactNode;
  group: string;
  searchTerms?: string[];
  command: (props: { editor: Editor; range: Range }) => void;
}

// 默认 mermaid 代码模板
const MERMAID_TEMPLATES: Record<string, string> = {
  flowchart: "graph TD\n  A --> B",
  sequence: "sequenceDiagram\n  A->>B: 请求\n  B-->>A: 响应",
  gantt: "gantt\n  title 项目计划\n  dateFormat  YYYY-MM-DD\n  section 阶段一\n  任务1 :a1, 2024-01-01, 30d",
  classDiagram: "classDiagram\n  class Animal {\n    +String name\n    +int age\n  }",
  stateDiagram: "stateDiagram-v2\n  [*] --> 待处理\n  待处理 --> 进行中\n  进行中 --> 已完成",
  pie: "pie title 数据分布\n  \"A\" : 40\n  \"B\" : 30\n  \"C\" : 30",
  er: "erDiagram\n  USER ||--o{ POST : owns",
  journey: "journey\n  title 用户体验旅程\n  section 访问\n    打开页面: 5: 用户",
};

function createMermaidCommand(type: string) {
  return {
    command: ({ editor, range }: { editor: Editor; range: Range }) => {
      const code = MERMAID_TEMPLATES[type] || MERMAID_TEMPLATES.flowchart;
      editor.chain().focus().deleteRange(range).insertContent({
        type: "mermaidDiagram",
        attrs: { code, type },
      }).run();
    },
  };
}

function createMathCommand(kind: "inline" | "block") {
  return {
    command: ({ editor, range }: { editor: Editor; range: Range }) => {
      const latex = kind === "inline" ? "E=mc^2" : "\\int_a^b f(x)\\,dx";
      editor.chain().focus().deleteRange(range).insertContent({
        type: kind === "inline" ? "inlineMath" : "blockMath",
        attrs: { latex },
      }).run();
    },
  };
}

export const suggestionItems: SlashCommandItem[] = [
  // 标题
  { title: "一级标题", description: "大标题", icon: <Heading1 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h1", "header", "标题"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run() },
  { title: "二级标题", description: "中标题", icon: <Heading2 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h2", "header"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run() },
  { title: "三级标题", description: "小标题", icon: <Heading3 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h3", "header"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run() },
  { title: "四级标题", description: "四级标题", icon: <Heading4 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h4"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 4 }).run() },
  { title: "五级标题", description: "五级标题", icon: <Heading5 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h5"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 5 }).run() },
  { title: "六级标题", description: "六级标题", icon: <Heading6 className="h-4 w-4" />, group: "标题", searchTerms: ["heading", "h6"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 6 }).run() },

  // 列表
  { title: "无序列表", description: "创建项目列表", icon: <List className="h-4 w-4" />, group: "列表", searchTerms: ["bullet", "ul", "list", "列表"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { title: "有序列表", description: "带编号列表", icon: <ListOrdered className="h-4 w-4" />, group: "列表", searchTerms: ["ordered", "ol", "numbered"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { title: "任务列表", description: "带复选框", icon: <CheckSquare className="h-4 w-4" />, group: "列表", searchTerms: ["task", "todo", "checkbox"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },

  // 块级
  { title: "表格", description: "插入表格", icon: <Table className="h-4 w-4" />, group: "块级", searchTerms: ["table", "grid", "表格"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { title: "引用", description: "引用内容", icon: <Quote className="h-4 w-4" />, group: "块级", searchTerms: ["blockquote", "quote", "引用"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { title: "代码块", description: "代码片段", icon: <Code className="h-4 w-4" />, group: "块级", searchTerms: ["code", "pre", "代码"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { title: "分割线", description: "分隔线", icon: <Minus className="h-4 w-4" />, group: "块级", searchTerms: ["hr", "horizontal", "divider", "分割"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },

  // 数学公式
  { title: "行内公式", description: "行内 LaTeX 公式", icon: <Sigma className="h-4 w-4" />, group: "数学", searchTerms: ["math", "inline", "latex", "公式"], ...createMathCommand("inline") },
  { title: "块级公式", description: "块级 LaTeX 公式", icon: <Sigma className="h-4 w-4" />, group: "数学", searchTerms: ["math", "block", "latex", "公式"], ...createMathCommand("block") },

  // Mermaid 图表
  { title: "流程图", description: "插入流程图", icon: <GitBranch className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "flowchart", "流程图"], ...createMermaidCommand("flowchart") },
  { title: "时序图", description: "插入时序图", icon: <GitCommit className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "sequence", "时序"], ...createMermaidCommand("sequence") },
  { title: "甘特图", description: "插入甘特图", icon: <Calendar className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "gantt", "甘特"], ...createMermaidCommand("gantt") },
  { title: "类图", description: "插入类图", icon: <Layers className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "class", "类图"], ...createMermaidCommand("classDiagram") },
  { title: "状态图", description: "插入状态图", icon: <Activity className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "state", "状态"], ...createMermaidCommand("stateDiagram") },
  { title: "饼图", description: "插入饼图", icon: <PieChart className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "pie", "饼图"], ...createMermaidCommand("pie") },
  { title: "ER 图", description: "实体关系图", icon: <Database className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "er", "erDiagram"], ...createMermaidCommand("er") },
  { title: "旅程图", description: "用户旅程图", icon: <Map className="h-4 w-4" />, group: "图表", searchTerms: ["mermaid", "journey", "旅程"], ...createMermaidCommand("journey") },
];

export function filterItems(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  if (!query || query.length === 0) return items;
  const search = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(search) ||
      item.searchTerms?.some((term) => term.toLowerCase().includes(search)) ||
      item.description?.toLowerCase().includes(search),
  );
}

function findSlashMatch(config: {
  char: string;
  allowSpaces: boolean;
  allowedPrefixes: string[] | null;
  startOfLine: boolean;
  $position: any;
}) {
  const { $position } = config;
  const $pos = $position;
  const parent = $pos.parent;
  if (!parent?.isTextblock) return null;

  const text = parent.textBetween(0, $pos.parentOffset, undefined, "\uFFFC");
  if (!text) return null;

  // Markdown 链接中不触发
  if (/\[[^\]\n]+\]\([^)\n]*$/.test(text)) return null;

  const match = /(?:^|[\s([{'"`<>]|[.,!?;:，。！？；：（）【】《》、])\/([^\s/]*)$/.exec(text);
  if (!match) return null;

  const fullMatch = match[0];
  const slashOffset = text.length - fullMatch.length + fullMatch.lastIndexOf("/");
  const from = $pos.start() + slashOffset;
  const to = $pos.pos;

  return {
    range: { from, to },
    query: match[1] || "",
    text: text.slice(slashOffset),
  };
}

export { findSlashMatch };

// 全局键盘处理器
let menuKeyDownHandler: ((props: { event: KeyboardEvent }) => boolean) | null = null;

export function setMenuKeyDownHandler(handler: ((props: { event: KeyboardEvent }) => boolean) | null) {
  menuKeyDownHandler = handler;
}

export const suggestionOptions = {
  items: ({ query }: { query: string }) => filterItems(suggestionItems, query),

  render: () => {
    return {
      onStart: (props: SuggestionProps) => {
        const rect = props.clientRect;
        const clientRect = typeof rect === "function" ? rect() : rect;
        if (!clientRect) return;
        const editor = props.editor;
        if (!editor) return;
        document.dispatchEvent(new CustomEvent("slash-command-show", {
          detail: { editor, clientRect, query: props.query || "" },
        }));
      },
      onUpdate: (props: SuggestionProps) => {
        const rect = props.clientRect;
        const clientRect = typeof rect === "function" ? rect() : rect;
        if (!clientRect) return;
        document.dispatchEvent(new CustomEvent("slash-command-update", {
          detail: { clientRect, query: props.query || "" },
        }));
      },
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (menuKeyDownHandler) {
          if (menuKeyDownHandler(props)) return true;
        }
        if (props.event.key === "Escape") {
          document.dispatchEvent(new CustomEvent("slash-command-hide"));
          return true;
        }
        return false;
      },
      onExit: () => {
        document.dispatchEvent(new CustomEvent("slash-command-hide"));
      },
    };
  },
};
