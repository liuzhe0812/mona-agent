/**
 * 流程图内嵌预览：在文本笔记中通过 `![[流程图标题]]` 渲染只读流程图。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §10.3, §10.4
 *
 * 规则：
 * - 只读，禁用拖动、连线和删除；
 * - 固定最小高度，自动 fitView；
 * - 默认不拦截普通滚轮（panOnScroll=false），避免破坏正文滚动；
 * - 提供"打开"按钮跳转到流程图笔记；
 * - 使用 IntersectionObserver 延迟挂载，离开视口卸载；
 * - 找不到目标时显示未解析链接；
 * - 目标文件损坏时显示错误卡片，不展示空图。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node, NodeChange, EdgeChange } from "@xyflow/react";
import { ExternalLink, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  FlowchartCanvas,
  flowchartCanvasHelpers,
} from "./FlowchartCanvas";
import {
  parseFlowchartMarkdown,
  type FlowchartDocument,
} from "./flowchart-document";

export interface FlowchartEmbedViewProps {
  /** 内嵌语法中的标题 */
  title: string;
  /** 根据标题查找目标笔记的 contentMarkdown；返回 null 表示找不到 */
  resolveContent: (title: string) => string | null;
  /** 点击"打开"按钮时触发 */
  onOpen?: (title: string) => void;
}

type ResolveState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; document: FlowchartDocument };

export function FlowchartEmbedView({
  title,
  resolveContent,
  onOpen,
}: FlowchartEmbedViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [state, setState] = useState<ResolveState>({ status: "loading" });

  // IntersectionObserver 延迟挂载（设计文档 §10.3, §14）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 进入视口后才解析目标内容
  useEffect(() => {
    if (!inView) return;
    const content = resolveContent(title);
    if (content === null) {
      setState({ status: "not-found" });
      return;
    }
    const parsed = parseFlowchartMarkdown(content);
    if (!parsed.ok) {
      setState({ status: "error", message: parsed.message });
      return;
    }
    setState({ status: "ready", document: parsed.document });
  }, [inView, title, resolveContent]);

  const handleOpen = useCallback(() => {
    onOpen?.(title);
  }, [onOpen, title]);

  return (
    <div
      ref={containerRef}
      className="my-2 overflow-hidden rounded-lg border border-border/60 bg-background"
      contentEditable={false}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{title}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={handleOpen}
          title="在独立标签页打开"
        >
          <ExternalLink className="mr-1 h-3 w-3" />
          打开
        </Button>
      </div>

      {/* 画布区域 */}
      <div className="flowchart-surface h-[280px] min-h-[280px] w-full">
        {state.status === "loading" && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {inView ? "加载中..." : "等待进入视口"}
          </div>
        )}
        {state.status === "not-found" && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            未找到流程图：{title}
          </div>
        )}
        {state.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground">
            <span className="font-medium text-foreground">流程图解析失败</span>
            <span className="max-w-md">{state.message}</span>
          </div>
        )}
        {state.status === "ready" && (
          <FlowchartEmbedCanvas document={state.document} />
        )}
      </div>
    </div>
  );
}

/**
 * 只读画布：使用 FlowchartCanvas 的受控模式 + readOnly。
 * 不传 onConnect/onSelectionChange，禁用交互回调。
 */
function FlowchartEmbedCanvas({ document }: { document: FlowchartDocument }) {
  const [internalNodes, setInternalNodes] = useState<Node[]>(() =>
    document.nodes.map((n) =>
      flowchartCanvasHelpers.toFlowNode(n, document.direction),
    ),
  );
  const [internalEdges, setInternalEdges] = useState<Edge[]>(() =>
    document.edges.map((e) => flowchartCanvasHelpers.toFlowEdge(e, { readOnly: true })),
  );

  // 文档变化时重置
  useEffect(() => {
    setInternalNodes(
      document.nodes.map((n) =>
        flowchartCanvasHelpers.toFlowNode(n, document.direction),
      ),
    );
    setInternalEdges(document.edges.map((e) => flowchartCanvasHelpers.toFlowEdge(e, { readOnly: true })));
  }, [document]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setInternalNodes((nodes) => flowchartCanvasHelpers.applyNodeChanges(changes, nodes));
  }, []);
  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    setInternalEdges((edges) => flowchartCanvasHelpers.applyEdgeChanges(changes, edges));
  }, []);

  return (
    <FlowchartCanvas
      nodes={document.nodes}
      edges={document.edges}
      direction={document.direction}
      readOnly
      internalNodes={internalNodes}
      internalEdges={internalEdges}
      onInternalNodesChange={handleNodesChange}
      onInternalEdgesChange={handleEdgesChange}
    />
  );
}
