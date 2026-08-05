import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useMemo, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { Textarea } from "@/components/ui/textarea";

// 处理 \begin{array}{*{N}{c}} 形式的列规格展开，katex 不支持 * 重复语法
const ARRAY_COLUMN_SPEC_PATTERN = /\\begin\{array\}\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const REPEATED_COLUMN_PATTERN = /\*\{(\d+)\}\{([^{}]+)\}/g;
const MAX_REPEATED_COLUMNS = 80;

function expandRepeatedArrayColumns(columnSpec: string) {
  return columnSpec.replace(REPEATED_COLUMN_PATTERN, (_match, countValue: string, columnValue: string) => {
    const count = Number.parseInt(countValue, 10);
    if (!Number.isFinite(count) || count <= 0) return "";
    return columnValue.repeat(Math.min(count, MAX_REPEATED_COLUMNS));
  });
}

export function normalizeLatexForKatex(latex: string) {
  return latex.replace(ARRAY_COLUMN_SPEC_PATTERN, (_match, columnSpec: string) => {
    return `\\begin{array}{${expandRepeatedArrayColumns(columnSpec)}}`;
  });
}

// 行内公式视图
function InlineMathView({ node, updateAttributes }: ReactNodeViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [latex, setLatex] = useState(node.attrs.latex || "");
  const [error, setError] = useState<string | null>(null);

  const renderedHtml = useMemo(() => {
    try {
      setError(null);
      return katex.renderToString(normalizeLatexForKatex(node.attrs.latex || ""), {
        throwOnError: false,
        displayMode: false,
      });
    } catch (e) {
      setError((e as Error).message);
      return `<span class="text-red-500">Invalid LaTeX</span>`;
    }
  }, [node.attrs.latex]);

  const handleUpdate = () => {
    updateAttributes({ latex });
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleUpdate();
    }
    if (e.key === "Escape") {
      setLatex(node.attrs.latex || "");
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <NodeViewWrapper className="inline-math-wrapper inline">
        <input
          type="text"
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          onBlur={handleUpdate}
          onKeyDown={handleKeyDown}
          className="inline-math-input min-w-25 rounded border bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          autoFocus
        />
        {error && <span className="ml-2 text-xs text-red-500">{error}</span>}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      className="inline-math-wrapper inline mx-1 cursor-pointer rounded bg-muted/50 px-1 py-0.5 transition-colors hover:bg-muted"
      onClick={() => setIsEditing(true)}
    >
      <span
        className="tiptap-mathematics-render tiptap-mathematics-render--editable"
        data-type="inline-math"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    </NodeViewWrapper>
  );
}

// 块级公式视图
function BlockMathView({ node, updateAttributes }: ReactNodeViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [latex, setLatex] = useState(node.attrs.latex || "");
  const [error, setError] = useState<string | null>(null);

  const renderedHtml = useMemo(() => {
    try {
      setError(null);
      return katex.renderToString(normalizeLatexForKatex(node.attrs.latex || ""), {
        throwOnError: false,
        displayMode: true,
      });
    } catch (e) {
      setError((e as Error).message);
      return `<span class="text-red-500">Invalid LaTeX</span>`;
    }
  }, [node.attrs.latex]);

  const handleUpdate = () => {
    updateAttributes({ latex });
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleUpdate();
    }
    if (e.key === "Escape") {
      setLatex(node.attrs.latex || "");
      setIsEditing(false);
    }
  };

  if (isEditing) {
    return (
      <NodeViewWrapper className="block-math-wrapper my-4">
        <Textarea
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          onBlur={handleUpdate}
          onKeyDown={handleKeyDown}
          rows={3}
          className="block-math-input min-h-15 font-mono"
          autoFocus
        />
        {error && <span className="mt-1 text-xs text-red-500">{error}</span>}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      className="block-math-wrapper my-4 cursor-pointer rounded-lg bg-muted/30 p-4 transition-colors hover:bg-muted/50"
      onClick={() => setIsEditing(true)}
    >
      <div
        className="tiptap-mathematics-render tiptap-mathematics-render--editable overflow-x-auto"
        data-type="block-math"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
    </NodeViewWrapper>
  );
}

// 行内公式扩展
export const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      latex: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inline-math"]',
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          return { latex: node.getAttribute("data-latex") || "" };
        },
      },
      {
        tag: "span[data-latex]",
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          return { latex: node.getAttribute("data-latex") || "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-type": "inline-math" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /(?<!\$)\$[^\$\n]+\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[0].slice(1, -1) }),
      }),
      nodeInputRule({
        find: /\\\([^\n]+?\\\)$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[0].slice(2, -2) }),
      }),
    ];
  },

  markdownTokenName: "inline_math",

  markdownTokenizer: {
    name: "inline_math",
    level: "inline" as const,
    start: (src: string) => {
      const dollarIndex = src.indexOf("$");
      const bracketIndex = src.indexOf("\\(");
      if (dollarIndex === -1) return bracketIndex;
      if (bracketIndex === -1) return dollarIndex;
      return Math.min(dollarIndex, bracketIndex);
    },
    tokenize: (src: string, _tokens: any, lexer: any) => {
      const match = /^(?:\$([^\$\n]+?)\$|\\\(([^\n]+?)\\\))/.exec(src);
      if (!match) return undefined;
      const content = match[1] ?? match[2] ?? "";
      return {
        type: "inline_math",
        raw: match[0],
        content,
        tokens: lexer.inlineTokens(content),
      };
    },
  },

  renderMarkdown(node: any) {
    return `$${node.attrs?.latex ?? ""}$`;
  },

  parseMarkdown(token: any) {
    return {
      type: "inlineMath",
      attrs: { latex: token.content ?? (token.raw?.slice(1, -1) ?? "") },
    };
  },
});

// 块级公式扩展
export const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      latex: { default: "" },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="block-math"]',
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          return { latex: node.getAttribute("data-latex") || "" };
        },
      },
      {
        tag: "div[data-latex]",
        getAttrs: (node: HTMLElement | string) => {
          if (typeof node === "string") return false;
          return { latex: node.getAttribute("data-latex") || "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "block-math" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockMathView);
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /^\$\$[\s\S]+?\$\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[0].slice(2, -2).trim() }),
      }),
      nodeInputRule({
        find: /^\\\[[\s\S]+?\\\]$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[0].slice(2, -2).trim() }),
      }),
    ];
  },

  markdownTokenName: "block_math",

  markdownTokenizer: {
    name: "block_math",
    level: "block" as const,
    start: (src: string) => {
      const dollarIndex = src.indexOf("$$");
      const bracketIndex = src.indexOf("\\[");
      if (dollarIndex === -1) return bracketIndex;
      if (bracketIndex === -1) return dollarIndex;
      return Math.min(dollarIndex, bracketIndex);
    },
    tokenize: (src: string, _tokens: any, lexer: any) => {
      const match = /^(?:\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\])/.exec(src);
      if (!match) return undefined;
      const content = (match[1] ?? match[2] ?? "").trim();
      return {
        type: "block_math",
        raw: match[0],
        content,
        tokens: lexer.blockTokens(content),
      };
    },
  },

  renderMarkdown(node: any) {
    return `\n$$${node.attrs?.latex ?? ""}$$\n`;
  },

  parseMarkdown(token: any) {
    return {
      type: "blockMath",
      attrs: { latex: token.content ?? (token.raw?.slice(2, -2) ?? "") },
    };
  },
});
