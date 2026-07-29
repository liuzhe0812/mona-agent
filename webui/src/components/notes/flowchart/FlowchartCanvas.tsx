/**
 * React Flow 画布组件：渲染流程图节点/边，处理拖动、连线和选区。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §8.4
 *
 * 主题：根容器加 .flowchart-surface 类，节点/边样式只消费 --flowchart-* token。
 * 不在此组件硬编码浅色/深色值。
 *
 * 只读模式：禁用节点拖动、连线、删除和编辑，保留平移缩放。
 *
 * 节点类型：start/end（椭圆）、process（矩形）、decision（菱形）、
 * document（文档波形）、database（圆柱）、annotation（虚线框）、subprocess（双边框）。
 * 每种类型通过 SVG 形状 + 主题 token 实现 WPS 风格。
 *
 * 样式覆盖：节点/边的 style 字段通过 CSS 变量注入到 .flowchart-node-wps 容器，
 * 由 globals.css 中的 var(--node-*) 消费。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";

import type {
  FlowchartDirection,
  FlowchartEdge,
  FlowchartEdgeStyle,
  FlowchartNode,
  FlowchartNodeKind,
  FlowchartNodeStyle,
} from "./flowchart-document";

// ---------------------------------------------------------------------------
// 节点组件（WPS 风格）
// ---------------------------------------------------------------------------

interface FlowchartNodeData {
  kind: FlowchartNodeKind;
  label: string;
  style?: FlowchartNodeStyle;
  /** 是否允许缩放（仅非只读模式） */
  resizable?: boolean;
  [key: string]: unknown;
}

/** 把 FlowchartNodeStyle 转为 CSS 变量对象，注入到节点容器。 */
function styleToCssVars(style: FlowchartNodeStyle | undefined): Record<string, string> {
  if (!style) return {};
  const vars: Record<string, string> = {};
  if (style.fill) vars["--node-fill"] = style.fill;
  if (style.color) vars["--node-text"] = style.color;
  if (style.borderColor) vars["--node-border"] = style.borderColor;
  if (typeof style.borderWidth === "number") vars["--node-border-width"] = `${style.borderWidth}px`;
  if (style.borderStyle) vars["--node-border-style"] = style.borderStyle;
  if (typeof style.fontSize === "number") vars["--node-font-size"] = `${style.fontSize}px`;
  if (style.fontFamily) vars["--node-font-family"] = style.fontFamily;
  if (typeof style.bold === "boolean") vars["--node-font-weight"] = style.bold ? "700" : "400";
  if (typeof style.italic === "boolean") vars["--node-font-style"] = style.italic ? "italic" : "normal";
  if (typeof style.underline === "boolean") vars["--node-text-decoration"] = style.underline ? "underline" : "none";
  if (style.textAlign) vars["--node-text-align"] = style.textAlign;
  return vars;
}

/** 把 FlowchartEdgeStyle 转为 React Flow edge 的 style 属性。 */
function edgeStyleToCss(style: FlowchartEdgeStyle | undefined): React.CSSProperties | undefined {
  if (!style) return undefined;
  const css: React.CSSProperties = {};
  if (style.stroke) css.stroke = style.stroke;
  if (typeof style.strokeWidth === "number") css.strokeWidth = style.strokeWidth;
  if (style.strokeDasharray === "dashed") css.strokeDasharray = "6 3";
  else if (style.strokeDasharray === "dotted") css.strokeDasharray = "2 3";
  else css.strokeDasharray = "none";
  return css;
}

/** 四方向 Handle 组件：top/right/bottom/left，每个方向同时放置 source 和 target 两个 Handle（重叠），
 *  使任一连接点既能作为连线起点也能作为终点。
 *  WPS 风格连接点：圆形 8px，品牌色填充，白色描边。 */
function FourHandles() {
  const handleStyle = { background: "var(--flowchart-handle)" };
  return (
    <>
      {/* Top */}
      <Handle type="target" position={Position.Top} id="top-target" style={{ ...handleStyle, top: 2 }} isConnectable />
      <Handle type="source" position={Position.Top} id="top-source" style={{ ...handleStyle, top: 2, opacity: 0 }} isConnectable />
      {/* Bottom */}
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={{ ...handleStyle, bottom: 2, opacity: 0 }} isConnectable />
      <Handle type="source" position={Position.Bottom} id="bottom-source" style={{ ...handleStyle, bottom: 2 }} isConnectable />
      {/* Left */}
      <Handle type="target" position={Position.Left} id="left-target" style={{ ...handleStyle, left: 2 }} isConnectable />
      <Handle type="source" position={Position.Left} id="left-source" style={{ ...handleStyle, left: 2, opacity: 0 }} isConnectable />
      {/* Right */}
      <Handle type="target" position={Position.Right} id="right-target" style={{ ...handleStyle, right: 2, opacity: 0 }} isConnectable />
      <Handle type="source" position={Position.Right} id="right-source" style={{ ...handleStyle, right: 2 }} isConnectable />
    </>
  );
}

function FlowchartNodeView({ data, selected }: NodeProps<Node>) {
  const d = data as unknown as FlowchartNodeData;
  const cssVars = useMemo(() => styleToCssVars(d.style), [d.style]);
  const className = `flowchart-node-wps ${d.kind}${selected ? " selected" : ""}`;

  // 多行 label 渲染：保留换行，按 textAlign 对齐
  const labelEl = (
    <div
      className="flowchart-node-label"
      style={{
        whiteSpace: "pre-wrap",
        textAlign: (cssVars["--node-text-align"] as "left" | "center" | "right" | undefined) ?? "center",
        textDecoration: cssVars["--node-text-decoration"] ?? "none",
      }}
    >
      {d.label}
    </div>
  );

  const handles = <FourHandles />;

  let body: React.ReactNode;
  if (d.kind === "decision") {
    body = (
      <>
        <svg className="decision-shape" viewBox="0 0 160 80" preserveAspectRatio="none">
          <polygon
            points="80,2 158,40 80,78 2,40"
            fill="var(--node-fill, var(--flowchart-decision-fill))"
            stroke={selected ? "var(--flowchart-edge-selected)" : "var(--node-border, var(--flowchart-decision-border))"}
            strokeWidth={parseFloat(cssVars["--node-border-width"] ?? "1.5")}
          />
        </svg>
        <div className="decision-label">{labelEl}</div>
        {handles}
      </>
    );
  } else if (d.kind === "document") {
    body = (
      <>
        <svg className="document-shape" viewBox="0 0 140 60" preserveAspectRatio="none">
          <path
            d="M 2 2 L 138 2 L 138 50 Q 105 62 70 50 T 2 50 Z"
            fill="var(--node-fill, var(--flowchart-document-fill))"
            stroke={selected ? "var(--flowchart-edge-selected)" : "var(--node-border, var(--flowchart-document-border))"}
            strokeWidth={parseFloat(cssVars["--node-border-width"] ?? "1.5")}
          />
        </svg>
        <div className="document-label">{labelEl}</div>
        {handles}
      </>
    );
  } else if (d.kind === "database") {
    body = (
      <>
        <svg className="database-shape" viewBox="0 0 140 70" preserveAspectRatio="none">
          <path
            d="M 2 12 L 2 58 Q 2 68 70 68 Q 138 68 138 58 L 138 12"
            fill="var(--node-fill, var(--flowchart-database-fill))"
            stroke={selected ? "var(--flowchart-edge-selected)" : "var(--node-border, var(--flowchart-database-border))"}
            strokeWidth={parseFloat(cssVars["--node-border-width"] ?? "1.5")}
          />
          <ellipse
            cx="70"
            cy="12"
            rx="68"
            ry="10"
            fill="var(--node-fill, var(--flowchart-database-fill))"
            stroke={selected ? "var(--flowchart-edge-selected)" : "var(--node-border, var(--flowchart-database-border))"}
            strokeWidth={parseFloat(cssVars["--node-border-width"] ?? "1.5")}
          />
        </svg>
        <div className="database-label">{labelEl}</div>
        {handles}
      </>
    );
  } else if (d.kind === "annotation") {
    body = (
      <>
        <div className="annotation-bracket" />
        <div className="annotation-label">{labelEl}</div>
        {handles}
      </>
    );
  } else if (d.kind === "subprocess") {
    body = (
      <>
        <div className="subprocess-inner-border" />
        {labelEl}
        {handles}
      </>
    );
  } else if (d.kind === "input-output") {
    // 输入输出：平行四边形
    body = (
      <>
        <svg className="input-output-shape" viewBox="0 0 140 60" preserveAspectRatio="none">
          <polygon
            points="20,2 138,2 120,58 2,58"
            fill="var(--node-fill, var(--flowchart-process-fill))"
            stroke={selected ? "var(--flowchart-edge-selected)" : "var(--node-border, var(--flowchart-process-border))"}
            strokeWidth={parseFloat(cssVars["--node-border-width"] ?? "1.5")}
          />
        </svg>
        <div className="input-output-label">{labelEl}</div>
        {handles}
      </>
    );
  } else {
    // start / end / process 通用
    body = (
      <>
        {labelEl}
        {handles}
      </>
    );
  }

  return (
    <div className={className} style={cssVars}>
      {/* NodeResizer：选中且可缩放时显示；onChange 由父级 onNodesChange 处理 */}
      {selected && d.resizable && (
        <NodeResizer
          minWidth={60}
          minHeight={32}
          isVisible={true}
          lineClassName="!border-[hsl(var(--flowchart-handle))]"
          handleClassName="!bg-[hsl(var(--flowchart-handle))] !border-[hsl(var(--flowchart-handle))]"
        />
      )}
      {body}
    </div>
  );
}

const nodeTypes = { flowchart: FlowchartNodeView };

// ---------------------------------------------------------------------------
// 工具：节点/边转换
// ---------------------------------------------------------------------------

function toFlowNode(n: FlowchartNode, direction: FlowchartDirection, readOnly: boolean = true): Node {
  const node: Node = {
    id: n.id,
    type: "flowchart",
    position: n.position,
    data: { kind: n.kind, label: n.label, style: n.style, resizable: !readOnly },
    sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
    targetPosition: direction === "LR" ? Position.Left : Position.Top,
  };
  if (n.size) {
    node.width = n.size.width;
    node.height = n.size.height;
  }
  return node;
}

function toFlowEdge(e: FlowchartEdge): Edge {
  const style = edgeStyleToCss(e.style);
  const route = e.style?.route ?? "smoothstep";
  // 兼容旧 handle id：旧格式为 top/bottom/left/right（单类型），
  // 新格式为 {dir}-source / {dir}-target。旧数据自动补全后缀。
  const normalizeSourceHandle = (h?: string | null): string | undefined => {
    if (!h) return undefined;
    if (h.endsWith("-source") || h.endsWith("-target")) return h;
    return `${h}-source`;
  };
  const normalizeTargetHandle = (h?: string | null): string | undefined => {
    if (!h) return undefined;
    if (h.endsWith("-source") || h.endsWith("-target")) return h;
    return `${h}-target`;
  };
  const edgeObj: Edge = {
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: normalizeSourceHandle(e.sourceHandle),
    targetHandle: normalizeTargetHandle(e.targetHandle),
    label: e.label,
    type: route,
    style,
  };
  // 箭头：默认终点闭合箭头
  const markerEnd = e.style?.markerEnd ?? "arrowclosed";
  const markerStart = e.style?.markerStart ?? "none";
  if (markerEnd !== "none") {
    edgeObj.markerEnd = {
      type: markerEnd === "arrow" ? "arrow" as const : "arrowclosed" as const,
      color: e.style?.stroke ?? "var(--flowchart-edge)",
    };
  }
  if (markerStart !== "none") {
    edgeObj.markerStart = {
      type: markerStart === "arrow" ? "arrow" as const : "arrowclosed" as const,
      color: e.style?.stroke ?? "var(--flowchart-edge)",
    };
  }
  return edgeObj;
}

// ---------------------------------------------------------------------------
// 画布组件
// ---------------------------------------------------------------------------

/** 导出图片选项（设计文档 §7.12） */
export interface FlowchartExportOptions {
  /** PNG 缩放倍数：1x 用于普通场景，2x 用于高清 */
  scale?: 1 | 2;
  /** 背景：transparent 透明 / theme 当前主题画布色 */
  background?: "transparent" | "theme";
}

/** FlowchartCanvas 暴露给父组件的命令接口 */
export interface FlowchartCanvasHandle {
  /** 导出为 PNG dataURL */
  exportToPng: (options?: FlowchartExportOptions) => Promise<string>;
  /** 导出为 SVG 字符串 */
  exportToSvg: (options?: FlowchartExportOptions) => Promise<string>;
}

export interface FlowchartCanvasProps {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  direction: FlowchartDirection;
  /** 只读模式：禁用拖动、连线和删除 */
  readOnly?: boolean;
  /** 初始 viewport（用于恢复保存的视图） */
  initialViewport?: { x: number; y: number; zoom: number } | null;
  /** 节点位置变化回调（拖动结束） */
  onNodesChange?: (changes: NodeChange[]) => void;
  /** 边变化回调（删除、选中） */
  onEdgesChange?: (changes: EdgeChange[]) => void;
  /** 新建连线回调 */
  onConnect?: (connection: {
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
  }) => void;
  /** 边重连回调（拖动边端点到新 Handle） */
  onReconnect?: (
    edgeId: string,
    next: {
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    },
  ) => void;
  /** viewport 变化回调（onMoveEnd 触发，用于持久化） */
  onViewportChange?: (vp: { x: number; y: number; zoom: number }) => void;
  /** 选区变化回调 */
  onSelectionChange?: (selection: { nodeIds: string[]; edgeIds: string[] }) => void;
  /** 节点双击编辑 label 回调 */
  onNodeLabelEdit?: (nodeId: string, label: string) => void;
  /** 边双击编辑 label 回调 */
  onEdgeLabelEdit?: (edgeId: string, label: string) => void;
  /** 从图形库拖拽放置形状回调 */
  onDropShape?: (kind: FlowchartNodeKind, x: number, y: number) => void;
  /** 内部受控节点（若提供则使用受控模式） */
  internalNodes?: Node[];
  internalEdges?: Edge[];
  onInternalNodesChange?: OnNodesChange;
  onInternalEdgesChange?: OnEdgesChange;
}

const FlowchartCanvasInner = forwardRef<FlowchartCanvasHandle, FlowchartCanvasProps>(function FlowchartCanvasInner({
  nodes,
  edges,
  direction,
  readOnly = false,
  initialViewport,
  onSelectionChange,
  onNodeLabelEdit,
  onEdgeLabelEdit,
  onDropShape,
  internalNodes,
  internalEdges,
  onInternalNodesChange,
  onInternalEdgesChange,
  onConnect,
  onReconnect,
  onViewportChange,
}, ref) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [edgeEditValue, setEdgeEditValue] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  const edgeEditInputRef = useRef<HTMLTextAreaElement | null>(null);
  const reactFlowWrapper = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition, setViewport, getViewport, getNodes, getNodesBounds } = useReactFlow();

  const flowNodes = useMemo(
    () => (internalNodes ?? nodes.map((n) => toFlowNode(n, direction, readOnly))),
    [internalNodes, nodes, direction, readOnly],
  );
  const flowEdges = useMemo(
    () => (internalEdges ?? edges.map(toFlowEdge)),
    [internalEdges, edges],
  );

  // 恢复保存的 viewport（设计文档 §7.7）
  // 仅在 initialViewport 提供且非默认值时调用一次
  const viewportRestoredRef = useRef(false);
  useEffect(() => {
    if (viewportRestoredRef.current) return;
    if (!initialViewport) return;
    if (initialViewport.x === 0 && initialViewport.y === 0 && initialViewport.zoom === 1) {
      viewportRestoredRef.current = true;
      return;
    }
    setViewport(initialViewport, { duration: 0 });
    viewportRestoredRef.current = true;
  }, [initialViewport, setViewport]);

  // 双击节点进入编辑模式
  const handleNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (readOnly) return;
      event.stopPropagation();
      setEditingNodeId(node.id);
      setEditValue(String(node.data?.label ?? ""));
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    },
    [readOnly],
  );

  const commitEdit = useCallback(() => {
    if (!editingNodeId) return;
    const trimmed = editValue.trim();
    onNodeLabelEdit?.(editingNodeId, trimmed || "新节点");
    setEditingNodeId(null);
    setEditValue("");
  }, [editingNodeId, editValue, onNodeLabelEdit]);

  const cancelEdit = useCallback(() => {
    setEditingNodeId(null);
    setEditValue("");
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [commitEdit, cancelEdit],
  );

  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type === "position");
        if (safe.length > 0) onInternalNodesChange?.(safe);
        return;
      }
      onInternalNodesChange?.(changes);
    },
    [readOnly, onInternalNodesChange],
  );

  const handleEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      if (readOnly) {
        const safe = changes.filter((c) => c.type !== "remove");
        if (safe.length > 0) onInternalEdgesChange?.(safe);
        return;
      }
      onInternalEdgesChange?.(changes);
    },
    [readOnly, onInternalEdgesChange],
  );

  const handleConnect = useCallback<OnConnect>(
    (connection) => {
      if (readOnly) return;
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      onConnect?.({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? undefined,
        targetHandle: connection.targetHandle ?? undefined,
      });
    },
    [readOnly, onConnect],
  );

  // 边重连：拖动边端点到新 Handle，触发 onReconnect 回调
  // 设计文档 §7.6：重连到新节点属于语义变化（产生新的 source/target，进入 hash）。
  // React Flow 不会自动修改 edge，需要由父级更新文档。
  const handleReconnect = useCallback(
    (edge: Edge, newConnection: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      if (readOnly) return;
      if (newConnection.source === newConnection.target) return;
      onReconnect?.(edge.id, {
        source: newConnection.source,
        target: newConnection.target,
        sourceHandle: newConnection.sourceHandle ?? undefined,
        targetHandle: newConnection.targetHandle ?? undefined,
      });
    },
    [readOnly, onReconnect],
  );

  // 双击边进入 label 编辑模式
  const handleEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      if (readOnly || !onEdgeLabelEdit) return;
      event.stopPropagation();
      setEditingEdgeId(edge.id);
      setEdgeEditValue(String(edge.label ?? ""));
      requestAnimationFrame(() => {
        edgeEditInputRef.current?.focus();
        edgeEditInputRef.current?.select();
      });
    },
    [readOnly, onEdgeLabelEdit],
  );

  const commitEdgeEdit = useCallback(() => {
    if (!editingEdgeId) return;
    const trimmed = edgeEditValue.trim();
    onEdgeLabelEdit?.(editingEdgeId, trimmed);
    setEditingEdgeId(null);
    setEdgeEditValue("");
  }, [editingEdgeId, edgeEditValue, onEdgeLabelEdit]);

  const cancelEdgeEdit = useCallback(() => {
    setEditingEdgeId(null);
    setEdgeEditValue("");
  }, []);

  const handleEdgeEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commitEdgeEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdgeEdit();
      }
    },
    [commitEdgeEdit, cancelEdgeEdit],
  );

  // 从图形库拖拽放置形状
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (readOnly || !onDropShape) return;
      const kind = e.dataTransfer.getData("application/x-flowchart-kind") as FlowchartNodeKind | "";
      if (!kind) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropShape(kind, position.x, position.y);
    },
    [readOnly, onDropShape, screenToFlowPosition],
  );

  // ── 导出图片（设计文档 §7.12）─────────────────────────────────────
  // 1. 添加 .flowchart-exporting class 隐藏 Controls/MiniMap/Handle/选择框/信息条
  // 2. 保存当前 viewport，计算全图 bounds，设置 viewport 使全图可见
  // 3. 等待渲染，调用 html-to-image 生成图片
  // 4. 恢复 viewport 和 class
  // 5. 大图导出失败时抛出明确错误，不返回空白 dataURL
  const exportImage = useCallback(
    async (
      format: "png" | "svg",
      options: FlowchartExportOptions = {},
    ): Promise<string> => {
      const scale = options.scale ?? 1;
      const background = options.background ?? "theme";

      const surfaceEl = reactFlowWrapper.current;
      if (!surfaceEl) throw new Error("画布未就绪，无法导出");
      const rfEl = surfaceEl.querySelector<HTMLElement>(".react-flow");
      if (!rfEl) throw new Error("React Flow 容器未就绪，无法导出");

      const allNodes = getNodes();
      if (allNodes.length === 0) {
        throw new Error("画布上没有节点，无法导出");
      }

      // 1. 取消任何正在进行的编辑状态，避免编辑浮层被截取
      setEditingNodeId(null);
      setEditValue("");
      setEditingEdgeId(null);
      setEdgeEditValue("");

      // 2. 隐藏编辑 UI
      surfaceEl.classList.add("flowchart-exporting");

      // 3. 保存并设置 viewport 以包含全图
      const prevViewport = getViewport();
      const bounds = getNodesBounds(allNodes);
      const containerRect = rfEl.getBoundingClientRect();
      const padding = 40;
      const availableWidth = Math.max(containerRect.width - padding * 2, 100);
      const availableHeight = Math.max(containerRect.height - padding * 2, 100);
      const zoom = Math.min(
        availableWidth / Math.max(bounds.width, 1),
        availableHeight / Math.max(bounds.height, 1),
        1.5,
      );
      const x = -bounds.x * zoom + (containerRect.width - bounds.width * zoom) / 2;
      const y = -bounds.y * zoom + (containerRect.height - bounds.height * zoom) / 2;
      setViewport({ x, y, zoom }, { duration: 0 });

      // 4. 等待 DOM 更新（两帧确保 React Flow 完成渲染）
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      try {
        // 5. 计算背景色
        const backgroundColor =
          background === "transparent"
            ? undefined
            : getComputedStyle(surfaceEl)
                .getPropertyValue("--flowchart-canvas")
                .trim() || "#ffffff";

        // 6. 生成图片
        const htmlToImageOptions = {
          pixelRatio: scale,
          backgroundColor,
          // 过滤掉可能残留的编辑 UI（CSS 已隐藏，这里双重保险）
          filter: (node: HTMLElement) => {
            if (!node.classList) return true;
            return (
              !node.classList.contains("react-flow__controls") &&
              !node.classList.contains("react-flow__minimap") &&
              !node.classList.contains("flowchart-info-bar") &&
              !node.classList.contains("flowchart-issues-panel")
            );
          },
        };

        if (format === "png") {
          return await toPng(rfEl, htmlToImageOptions);
        }
        return await toSvg(rfEl, htmlToImageOptions);
      } finally {
        // 7. 恢复 viewport 和 class
        setViewport(prevViewport, { duration: 0 });
        surfaceEl.classList.remove("flowchart-exporting");
      }
    },
    [getNodes, getNodesBounds, getViewport, setViewport],
  );

  const exportToPng = useCallback(
    (options?: FlowchartExportOptions) => exportImage("png", options),
    [exportImage],
  );
  const exportToSvg = useCallback(
    (options?: FlowchartExportOptions) => exportImage("svg", options),
    [exportImage],
  );

  useImperativeHandle(
    ref,
    () => ({
      exportToPng,
      exportToSvg,
    }),
    [exportToPng, exportToSvg],
  );

  return (
    <div
      ref={reactFlowWrapper}
      className={`flowchart-surface h-full w-full${readOnly ? " flowchart-readonly" : ""}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeDoubleClick={handleNodeDoubleClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onReconnect={handleReconnect}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          onSelectionChange?.({
            nodeIds: ns.map((n) => n.id),
            edgeIds: es.map((e) => e.id),
          });
        }}
        onMoveEnd={(_, vp: Viewport) => {
          if (onViewportChange) {
            onViewportChange({ x: vp.x, y: vp.y, zoom: vp.zoom });
          }
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        edgesFocusable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        fitView={!initialViewport}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        panOnDrag={[1]}
        selectionOnDrag
        snapToGrid={!readOnly}
        snapGrid={[8, 8]}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={16}
          color="var(--flowchart-grid)"
        />
        <Controls
          showInteractive={false}
          className="!bg-[var(--flowchart-node-bg)] !border-[var(--flowchart-node-border)]"
        />
        <MiniMap
          pannable
          zoomable
          className="!bg-[var(--flowchart-node-bg)] !border-[var(--flowchart-node-border)]"
          maskColor="hsl(var(--muted-foreground) / 0.08)"
          nodeColor={(n) => {
            const kind = (n.data as { kind?: string } | undefined)?.kind;
            if (kind === "start" || kind === "end") return "hsl(var(--flowchart-start-border))";
            if (kind === "decision") return "hsl(var(--flowchart-decision-border))";
            if (kind === "document") return "hsl(var(--flowchart-document-border))";
            if (kind === "database") return "hsl(var(--flowchart-database-border))";
            return "hsl(var(--flowchart-process-border))";
          }}
        />
      </ReactFlow>

      {/* 节点数 / 边数 / zoom 信息条已移除 */}

      {/* 节点 label 编辑浮层 */}
      {editingNodeId && (
        <div
          className="fixed inset-0 z-50"
          onMouseDown={commitEdit}
        >
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <textarea
              ref={editInputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={commitEdit}
              className="min-w-[200px] rounded-md border-2 border-primary bg-background px-2 py-1 text-sm shadow-lg outline-none"
              rows={2}
              placeholder="输入节点文字（回车确认，Esc 取消）"
            />
          </div>
        </div>
      )}

      {/* 边 label 编辑浮层（设计文档 §7.6） */}
      {editingEdgeId && (
        <div
          className="fixed inset-0 z-50"
          onMouseDown={commitEdgeEdit}
        >
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <textarea
              ref={edgeEditInputRef}
              value={edgeEditValue}
              onChange={(e) => setEdgeEditValue(e.target.value)}
              onKeyDown={handleEdgeEditKeyDown}
              onBlur={commitEdgeEdit}
              className="min-w-[180px] rounded-md border-2 border-primary bg-background px-2 py-1 text-sm shadow-lg outline-none"
              rows={2}
              placeholder="输入边标签（回车确认，Esc 取消）"
            />
          </div>
        </div>
      )}
    </div>
  );
});

// 受控模式辅助：把外部 nodes/edges 转换为 React Flow 内部状态的工具
export const flowchartCanvasHelpers = {
  toFlowNode,
  toFlowEdge,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
};

export const FlowchartCanvas = forwardRef<FlowchartCanvasHandle, FlowchartCanvasProps>(
  function FlowchartCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <FlowchartCanvasInner {...props} ref={ref} />
      </ReactFlowProvider>
    );
  },
);
