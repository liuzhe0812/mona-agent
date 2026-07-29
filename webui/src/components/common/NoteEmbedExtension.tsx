/**
 * NoteEmbed 扩展：解析 `![[...]]` 嵌入语法，渲染只读流程图预览。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §10.4
 *
 * 必须在 WikiLink 之前注册，因为 `![[...]]` 的 `[[` 部分会被 WikiLink 的
 * tokenizer（start: src.indexOf("[[")）捕获。本扩展的 start 检测 `![[`，
 * 先于 WikiLink 的 `[[` 匹配。
 *
 * 首版只支持流程图目标；非流程图目标回退为链接卡片（避免扩展成通用 transclusion）。
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ExternalLink, FileText } from "lucide-react";

import { FlowchartEmbedView } from "../notes/flowchart/FlowchartEmbedView";

export interface NoteEmbedOptions {
  /** 根据标题查找目标笔记的 contentMarkdown；返回 null 表示找不到 */
  resolveContent?: (title: string) => string | null;
  /** 判断标题对应的笔记类型是否为 flowchart */
  isFlowchart?: (title: string) => boolean;
  /** 点击"打开"按钮时触发 */
  onOpen?: (title: string) => void;
  HTMLAttributes: Record<string, string>;
}

const NODE_NAME = "noteEmbed";

function NoteEmbedNodeView({ node, extension }: NodeViewProps) {
  const title = (node.attrs.title as string) || "";
  const opts = (extension.options as NoteEmbedOptions) ?? {};

  // 非流程图目标：回退为链接卡片
  if (opts.isFlowchart && !opts.isFlowchart(title)) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-xs"
        contentEditable={false}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground">{title}</span>
        {opts.onOpen && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => opts.onOpen?.(title)}
            contentEditable={false}
          >
            <ExternalLink className="h-3 w-3" />
            打开
          </button>
        )}
      </div>
    );
  }

  return (
    <FlowchartEmbedView
      title={title}
      resolveContent={opts.resolveContent ?? (() => null)}
      onOpen={opts.onOpen}
    />
  );
}

export const NoteEmbed = Node.create<NoteEmbedOptions>({
  name: NODE_NAME,

  inline: false,
  group: "block",
  content: "",
  selectable: true,
  atom: true,

  addOptions() {
    return {
      resolveContent: undefined,
      isFlowchart: undefined,
      onOpen: undefined,
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      title: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-title") ?? "",
        renderHTML: (attributes) => {
          if (!attributes.title) return {};
          return { "data-title": attributes.title };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-note-embed]",
        getAttrs: (el: HTMLElement) => ({
          title: el.getAttribute("data-title") ?? el.textContent ?? "",
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = (node.attrs.title as string) || "";
    return [
      "div",
      mergeAttributes(
        {
          "data-note-embed": "",
          "data-title": title,
        },
        HTMLAttributes,
      ),
      title,
    ];
  },

  renderText({ node }) {
    const title = node.attrs.title || "";
    return `![[${title}]]`;
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode(NODE_NAME, {
      title: token.content || "",
    });
  },

  renderMarkdown(node: any) {
    const title = (node.attrs && node.attrs.title) || "";
    return `![[${title}]]`;
  },

  markdownTokenizer: {
    name: "noteEmbed",
    level: "block",
    start(src) {
      return src.indexOf("![[");
    },
    tokenize(src) {
      const match = /^!\[\[([^\]\n]+)\]\]/.exec(src);
      if (!match) return undefined;
      return {
        type: "noteEmbed",
        raw: match[0],
        content: match[1],
        attributes: { title: match[1] },
      };
    },
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteEmbedNodeView);
  },
});
