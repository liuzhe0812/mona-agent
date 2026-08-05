import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useState, useEffect, useRef, useCallback } from "react";
import mermaid from "mermaid";
import { Code, Check, GitBranch, GitCommit, Layers, Activity, Database, Calendar, PieChart, Map } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// 初始化 mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "loose",
  fontFamily: "inherit",
});

// 图表类型配置
const DIAGRAM_TYPES = [
  { type: "flowchart", label: "流程图", icon: GitBranch, alias: ["flowchart", "flowchart-v2", "graph", "td", "graph td", "graph bt", "graph lr", "graph rl"] },
  { type: "sequence", label: "时序图", icon: GitCommit, alias: ["sequence", "sequencediagram"] },
  { type: "classDiagram", label: "类图", icon: Layers, alias: ["class", "classdiagram"] },
  { type: "stateDiagram", label: "状态图", icon: Activity, alias: ["state", "statediagram", "statediagram-v2"] },
  { type: "er", label: "ER 图", icon: Database, alias: ["er", "erdiagram"] },
  { type: "gantt", label: "甘特图", icon: Calendar, alias: ["gantt"] },
  { type: "pie", label: "饼图", icon: PieChart, alias: ["pie"] },
  { type: "journey", label: "旅程图", icon: Map, alias: ["journey", "gitgraph"] },
] as const;

// 从代码检测图表类型
function detectDiagramType(code: string): string {
  const trimmed = code.trim();
  const firstLine = trimmed.split("\n")[0]?.toLowerCase() || "";
  for (const config of DIAGRAM_TYPES) {
    if (config.alias.some((alias) => firstLine.startsWith(alias) || firstLine === alias)) {
      return config.type;
    }
  }
  return "flowchart";
}

function getDiagramMeta(type: string) {
  return DIAGRAM_TYPES.find((d) => d.type === type) ?? DIAGRAM_TYPES[0];
}

function MermaidDiagramView({ node, updateAttributes }: ReactNodeViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [code, setCode] = useState(node.attrs.code || "");
  const [diagramType, setDiagramType] = useState(node.attrs.type || "flowchart");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const renderDiagram = useCallback(async () => {
    if (!code.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    setError(null);
    try {
      mermaid.parse(code);
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const { svg: renderedSvg } = await mermaid.render(id, code);
      setSvg(renderedSvg);
    } catch (err) {
      const message = err instanceof Error ? err.message : "渲染失败";
      setError(message);
      setSvg("");
    }
  }, [code]);

  useEffect(() => {
    void renderDiagram();
  }, []);

  useEffect(() => {
    const detected = detectDiagramType(code);
    if (detected !== diagramType) setDiagramType(detected);
  }, [code, diagramType]);

  useEffect(() => {
    if (!isEditing) void renderDiagram();
  }, [isEditing, renderDiagram]);

  const handleUpdate = () => {
    updateAttributes({ code, type: diagramType });
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleUpdate();
    }
    if (e.key === "Escape") {
      setCode(node.attrs.code || "");
      setIsEditing(false);
    }
  };

  const meta = getDiagramMeta(diagramType);
  const Icon = meta.icon;

  return (
    <NodeViewWrapper className="mermaid-diagram-wrapper my-4">
      {/* 预览模式 */}
      {!isEditing && (
        <div
          className="mermaid-preview relative cursor-pointer overflow-x-auto rounded-lg border border-border bg-card"
          onClick={() => setIsEditing(true)}
        >
          {error ? (
            <div className="p-4 text-sm text-red-500">
              <p className="font-medium">渲染失败</p>
              <p className="mt-1">{error}</p>
              <p className="mt-2 text-muted-foreground">点击编辑</p>
            </div>
          ) : svg ? (
            <div
              ref={containerRef}
              className="mermaid-svg flex justify-center p-4"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="p-8 text-center text-muted-foreground">
              <span>点击编辑 Mermaid 代码</span>
            </div>
          )}

          <div className="absolute right-2 top-2 opacity-0 transition-opacity hover:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
            >
              <Code className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* 编辑模式 */}
      {isEditing && (
        <div className="mermaid-editor rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted/50 p-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              <span>{meta.label}</span>
            </div>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleUpdate}
              title="完成"
            >
              <Check className="h-4 w-4" />
            </Button>
          </div>

          <Textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={8}
            className="min-h-48 rounded-none border-0 font-mono shadow-none focus-visible:ring-0"
            placeholder={"输入 Mermaid 代码，例如：\ngraph TD\n  A --> B"}
            spellCheck={false}
          />

          {error && (
            <div className="border-t bg-red-50 px-3 py-2 text-xs text-red-500">
              {error}
            </div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

// Mermaid 代码块扩展
export const MermaidDiagram = Node.create({
  name: "mermaidDiagram",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      code: { default: "" },
      type: { default: "flowchart" },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="mermaid-diagram"]' },
      { tag: "pre[data-mermaid]" },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "mermaid-diagram" })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidDiagramView);
  },

  markdownTokenName: "mermaid",

  markdownTokenizer: {
    name: "mermaid",
    level: "block" as const,
    start: (src: string) => {
      const match = src.match(/^```mermaid\r?\n/);
      return match ? (match.index ?? -1) : -1;
    },
    tokenize: (src: string, _tokens: any, lexer: any) => {
      const match = /^```mermaid\r?\n([\s\S]*?)\r?\n```/.exec(src);
      if (!match) return undefined;
      const code = match[1];
      const type = detectDiagramType(code);
      return {
        type: "mermaid",
        raw: match[0],
        content: code,
        attrs: { type },
        tokens: lexer.blockTokens(match[1]),
      };
    },
  },

  renderMarkdown(node: any) {
    return `\n\`\`\`mermaid\n${node.attrs?.code ?? ""}\n\`\`\`\n`;
  },

  parseMarkdown(token: any) {
    const code = token.content || "";
    const type = detectDiagramType(code);
    return {
      type: "mermaidDiagram",
      attrs: { code, type },
    };
  },
});

export default MermaidDiagram;
