/**
 * 流程图文档编辑器：工具栏、历史、文档同步、错误视图和单写者租约。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §8.1, §8.2, §8.5
 *
 * 主要职责：
 * 1. 解析 note.contentMarkdown 为 FlowchartDocument，失败时显示错误视图；
 * 2. 提供工具栏：撤销/重做、添加节点、删除；
 * 3. 维护内部撤销栈：一次用户动作（拖动、删除、AI patch）只记录一次；
 * 4. 通过 onContentChange 上抛序列化后的 Markdown；
 * 5. 通过 FlowchartSelectionContext 上抛选区和 baseHash；
 * 6. 单写者租约：editorInstanceId 标识当前实例，非写者进入只读模式并提示。
 *
 * 多标签页写者租约的中心协调由 NotesView 维护（writerInstanceId），
 * 本组件只负责把 editorInstanceId 提交给中心，并接收中心返回的 writerInstanceId。
 * 采用单写者模型：非写者进入只读，不能提交；写者租约转移通过"在此编辑"按钮。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowUpFromLine,
  Ban,
  Copy,
  Download,
  FileImage,
  FileText,
  Group,
  Image as ImageIcon,
  Layers,
  Loader2,
  Palette,
  PanelRight,
  Pencil,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Ungroup,
  Workflow,
} from "lucide-react";
import type { Edge, Node, NodeChange, EdgeChange } from "@xyflow/react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { OperationNote } from "../notes-data";
import { layoutFlowchartWithContainers } from "./flowchart-patch";
import {
  buildFlowchartPlainText,
  cloneFlowchartDocument,
  computeFlowchartSemanticHash,
  DEFAULT_FLOWCHART_CANVAS,
  DEFAULT_FLOWCHART_THEME,
  FLOWCHART_DOCUMENT_VERSION,
  generateFlowchartEdgeId,
  generateFlowchartNodeId,
  isFlowchartContainerKind,
  parseFlowchartMarkdown,
  serializeFlowchartMarkdown,
  validateFlowchartDocument,
  type FlowchartDirection,
  type FlowchartDocument,
  type FlowchartCanvasSettings,
  type FlowchartEdge,
  type FlowchartEdgeStyle,
  type FlowchartNode,
  type FlowchartNodeKind,
  type FlowchartNodeStyle,
  type FlowchartThemeSettings,
  type FlowchartViewport,
} from "./flowchart-document";
import {
  getFlowchartShapeById,
  getFlowchartShapeDefaultSize,
  type FlowchartShapeDefinition,
} from "./flowchart-shapes";
import {
  addLaneToPool,
  createPoolNodes,
  FLOWCHART_LANE_HEADER_SIZE,
  flowchartNodeAbsolutePosition,
  flowchartPoolDefaultSize,
  groupNodes,
  matchNodesHeight,
  matchNodesSize,
  matchNodesWidth,
  nudgeNodes,
  removeLane,
  removePool,
  reorderNodes,
  reparentNodes,
  resizeLaneNodes,
  resizePoolNodes,
  ungroupNodes,
  type FlowchartLayerAction,
  type RemoveLaneStrategy,
} from "./flowchart-operations";
import {
  countNodesWithManualThemeStyles,
  resolveFlowchartThemeDefaults,
  stripThemeProvidedStyles,
} from "./flowchart-themes";
import { getNotesVaultPath, isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  flowchartCanvasHelpers,
  FlowchartCanvas,
  FlowchartFooter,
  type FlowchartCanvasHandle,
  type FlowchartContextMenuContext,
  type FlowchartExportOptions,
  type FreehandCompletePayload,
} from "./FlowchartCanvas";
import { FlowchartShapePanel, type CanvasTool } from "./FlowchartShapePanel";
import {
  FlowchartSafeDeleteDialog,
  type SafeDeleteConfirmOptions,
  type SafeDeleteLaneInfo,
  type SafeDeletePoolInfo,
} from "./FlowchartSafeDeleteDialog";
import {
  FlowchartInspector,
  type FlowchartNodeGeometryPatch,
} from "./FlowchartInspector";
import { useFlowchartSelection } from "./FlowchartSelectionContext";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 100;

/** 清理文件名：移除非法字符，限制长度，空则用 "流程图" */
function sanitizeFilename(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 60) || "流程图";
}

/**
 * 以中心点创建形状节点：尺寸取 catalog defaultSize（FC-LIB-02），position 为左上角。
 * 容器 kind（group/pool/lane）由 Batch 4 专门入口创建，此处返回 null 拒绝半成品。
 */
function createShapeNodeAtCenter(
  kind: FlowchartNodeKind,
  center: { x: number; y: number },
): FlowchartNode | null {
  if (isFlowchartContainerKind(kind)) return null;
  const size = getFlowchartShapeDefaultSize(kind);
  return {
    id: generateFlowchartNodeId(),
    kind,
    label: "新节点",
    position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
    size,
  };
}

/**
 * 查找选区中可追加泳道的泳池（FC-SWIM-01）：选中 pool 本身，或选中 lane 的父泳池；
 * 要求方向匹配。返回第一个匹配的泳池。
 */
function findSelectedPoolForLane(
  nodes: readonly FlowchartNode[],
  selectedIds: readonly string[],
  orientation: "horizontal" | "vertical",
): FlowchartNode | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of selectedIds) {
    const n = byId.get(id);
    if (!n) continue;
    const pool =
      n.kind === "swimlane-pool"
        ? n
        : n.kind === "swimlane-lane" && n.parentId !== undefined
          ? byId.get(n.parentId)
          : undefined;
    if (
      pool &&
      pool.kind === "swimlane-pool" &&
      pool.container?.type === "pool" &&
      pool.container.orientation === orientation
    ) {
      return pool;
    }
  }
  return null;
}

/** 查找包含指定画布点的同方向泳池（pool 恒为根级节点，坐标即绝对坐标；后创建者优先）。 */
function findPoolAtPoint(
  nodes: readonly FlowchartNode[],
  point: { x: number; y: number },
  orientation: "horizontal" | "vertical",
): FlowchartNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind !== "swimlane-pool" || n.container?.type !== "pool") continue;
    if (n.container.orientation !== orientation) continue;
    const w = n.size?.width ?? 0;
    const h = n.size?.height ?? 0;
    if (
      point.x >= n.position.x &&
      point.x <= n.position.x + w &&
      point.y >= n.position.y &&
      point.y <= n.position.y + h
    ) {
      return n;
    }
  }
  return null;
}

/** 查找绝对坐标点所在的泳道（FC-SWIM-03：后创建者优先，lane 绝对位置沿父链累加）。 */
function findLaneAtPoint(
  nodes: readonly FlowchartNode[],
  point: { x: number; y: number },
): FlowchartNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind !== "swimlane-lane") continue;
    const abs = flowchartNodeAbsolutePosition(nodes, n.id);
    if (!abs) continue;
    const w = n.size?.width ?? 0;
    const h = n.size?.height ?? 0;
    if (point.x >= abs.x && point.x <= abs.x + w && point.y >= abs.y && point.y <= abs.y + h) {
      return n;
    }
  }
  return null;
}

/** 把 lane 相对坐标 clamp 到内容区（FC-SWIM-03：避开标题区，不超出内容边界）。 */
function clampPositionToLaneContent(
  lane: FlowchartNode,
  nodeSize: { width: number; height: number },
  pos: { x: number; y: number },
): { x: number; y: number } {
  const laneW = lane.size?.width ?? 0;
  const laneH = lane.size?.height ?? 0;
  const horizontal =
    lane.container?.type === "lane" ? lane.container.orientation === "horizontal" : true;
  const header = FLOWCHART_LANE_HEADER_SIZE;
  const minX = horizontal ? header : 0;
  const minY = horizontal ? 0 : header;
  // 节点大于内容区时下限优先（允许超出右/下界，不产生反向区间）
  const maxX = Math.max(minX, laneW - nodeSize.width);
  const maxY = Math.max(minY, laneH - nodeSize.height);
  return {
    x: Math.min(Math.max(pos.x, minX), maxX),
    y: Math.min(Math.max(pos.y, minY), maxY),
  };
}

/** 查找同泳池的相邻泳道（FC-SWIM-04：优先 order 下一条，否则上一条；无其他泳道返回 null）。 */
function findAdjacentLaneId(nodes: readonly FlowchartNode[], laneId: string): string | null {
  const lane = nodes.find((n) => n.id === laneId);
  if (!lane || lane.kind !== "swimlane-lane" || lane.parentId === undefined) return null;
  const order = lane.container?.type === "lane" ? lane.container.order : 0;
  const siblings = nodes
    .filter(
      (n) => n.kind === "swimlane-lane" && n.parentId === lane.parentId && n.id !== laneId,
    )
    .map((n) => ({ id: n.id, order: n.container?.type === "lane" ? n.container.order : 0 }))
    .sort((a, b) => a.order - b.order);
  if (siblings.length === 0) return null;
  const after = siblings.find((s) => s.order > order);
  return (after ?? siblings[siblings.length - 1]).id;
}

/** 将 dataURL 转为 Blob 并触发下载 */
function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement("a");
  link.download = filename;
  link.href = dataUrl;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** 将 SVG 字符串转为 Blob 并触发下载 */
function downloadSvgString(svg: string, filename: string): void {
  // html-to-image toSvg 返回的是 data URL（data:image/svg+xml;charset=utf-8,...）
  // 直接用 a 标签下载
  const link = document.createElement("a");
  link.download = filename;
  link.href = svg;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * 通过浏览器打印窗口生成 PDF（设计文档 §7.13）。
 * 以全图 SVG 作为打印内容，适配横向/纵向页面，不打印围栏 JSON。
 * 用户在打印对话框中选择"保存为 PDF"。
 */
function printFlowchartPdf(svgDataUrl: string, title: string): void {
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    throw new Error("无法打开打印窗口，请检查浏览器弹窗拦截设置");
  }
  printWindow.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
  @page { margin: 12mm; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
  }
  .flowchart-print-container {
    max-width: 100%;
    max-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .flowchart-print-container img {
    max-width: 100%;
    max-height: 100vh;
    object-fit: contain;
  }
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
  <div class="flowchart-print-container">
    <img src="${svgDataUrl}" alt="${title}" />
  </div>
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.focus();
        window.print();
      }, 300);
    };
  </script>
</body>
</html>`);
  printWindow.document.close();
}

/** 字体选项 */
const FONT_FAMILY_OPTIONS = [
  { label: "默认", value: "" },
  { label: "宋体", value: "SimSun, serif" },
  { label: "微软雅黑", value: "Microsoft YaHei, sans-serif" },
  { label: "黑体", value: "SimHei, sans-serif" },
  { label: "楷体", value: "KaiTi, serif" },
  { label: "Inter", value: "Inter, sans-serif" },
];

/** 字号选项 */
const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28];

/** 线宽选项 */
const STROKE_WIDTH_OPTIONS = [1, 1.5, 2, 2.5, 3, 4];

/** 形状转换选项：用于右键菜单的"转换为"子菜单 */
const NODE_KIND_CONVERT_OPTIONS: Array<{ value: FlowchartNodeKind; label: string }> = [
  { value: "process", label: "处理" },
  { value: "start", label: "开始" },
  { value: "end", label: "结束" },
  { value: "terminator", label: "起止" },
  { value: "decision", label: "判断" },
  { value: "document", label: "文档" },
  { value: "multi-document", label: "多文档" },
  { value: "database", label: "数据" },
  { value: "subprocess", label: "子流程" },
  { value: "predefined-process", label: "预定义" },
  { value: "input-output", label: "输入输出" },
  { value: "manual-input", label: "手动输入" },
  { value: "preparation", label: "准备" },
  { value: "delay", label: "延迟" },
  { value: "display", label: "显示" },
  { value: "connector", label: "连接圆" },
  { value: "off-page-connector", label: "跨页连接" },
  { value: "internal-storage", label: "内部存储" },
  { value: "stored-data", label: "存储数据" },
  { value: "text", label: "文本" },
  { value: "annotation", label: "注释" },
];

// ---------------------------------------------------------------------------
// 历史栈
// ---------------------------------------------------------------------------

interface HistoryEntry {
  document: FlowchartDocument;
  /** 标记本次变更类型，layout 不影响 AI baseHash，semantic 影响 */
  changeKind: "layout" | "semantic" | "init";
}

interface HistoryState {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
}

function makeInitialHistory(doc: FlowchartDocument): HistoryState {
  return { past: [], present: { document: doc, changeKind: "init" }, future: [] };
}

function pushHistory(state: HistoryState, doc: FlowchartDocument, changeKind: "layout" | "semantic"): HistoryState {
  const past = [...state.past, state.present].slice(-HISTORY_LIMIT);
  return { past, present: { document: doc, changeKind }, future: [] };
}

function undoHistory(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  const past = state.past.slice(0, -1);
  const future = [state.present, ...state.future];
  return { past, present: previous, future };
}

function redoHistory(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  const past = [...state.past, state.present];
  const future = state.future.slice(1);
  return { past, present: next, future };
}

// ---------------------------------------------------------------------------
// Editor 实例 ID
// ---------------------------------------------------------------------------

let editorInstanceCounter = 0;
function generateEditorInstanceId(): string {
  editorInstanceCounter += 1;
  return `flowchart-editor-${Date.now().toString(36)}-${editorInstanceCounter}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FlowchartDocumentEditorProps {
  note: OperationNote;
  onContentChange: (next: {
    contentMarkdown: string;
    plainText: string;
    /** 流程图专用：提交时的 baseRevision，NotesView 用于多标签页 revision 校验 */
    baseRevision?: number;
  }) => void;
  /** 注入到工具栏最左侧的节点 */
  toolbarLeading?: ReactNode;
  /** 注入到工具栏右侧（saveLabel 之前）的额外节点 */
  toolbarExtra?: ReactNode;
  /** 中心 writerInstanceId（来自 NotesView）；当前实例不是写者时进入只读模式 */
  writerInstanceId?: string | null;
  /** 申请成为写者（用户点击"在此编辑"） */
  onRequestWriteLease?: (editorInstanceId: string) => void;
  /** 流程图当前 revision（来自 NotesView）；提交时作为 baseRevision 上抛 */
  revision?: number;
  /** NotesView 拒绝提交时触发的强制同步计数器（递增触发 re-sync） */
  forceSync?: number;
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function FlowchartDocumentEditor({
  note,
  onContentChange,
  toolbarLeading,
  toolbarExtra,
  writerInstanceId,
  onRequestWriteLease,
  revision = 0,
  forceSync = 0,
}: FlowchartDocumentEditorProps) {
  const editorInstanceId = useMemo(generateEditorInstanceId, []);
  const { setSelection, updateBaseHash } = useFlowchartSelection();
  const canvasRef = useRef<FlowchartCanvasHandle | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<CanvasTool>("select");
  // 右侧属性面板（FC-UI-02）：默认展开，可关闭
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // 右键菜单上下文：null 表示关闭
  const [menuCtx, setMenuCtx] = useState<FlowchartContextMenuContext | null>(null);
  // footer 缩放显示（受控）；网格显示/吸附统一取文档 canvas.grid（FC-UI-02 单一数据源）
  const [zoom, setZoom] = useState(1);
  // 方向键微移合并：连续微移（同选区、800ms 内）合并为一个历史单元
  const nudgeCoalesceRef = useRef<{ key: string; at: number } | null>(null);
  // 缓存最新的 commitChange 和 doc，让边控制点回调不依赖 history（避免连锁重建导致边重渲染）
  const commitChangeRef = useRef<(next: FlowchartDocument, changeKind: "layout" | "semantic", coalesceKey?: string) => void>(() => {});
  const latestDocRef = useRef<FlowchartDocument | null>(null);
  // 操作提示（FC-SWIM-01 等）：画布底部浮动展示，3s 自动消失
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);
  // 安全删除确认（FC-SWIM-04）：非空泳池/泳道删除前弹出策略选择
  const [safeDeleteTargets, setSafeDeleteTargets] = useState<{
    pools: SafeDeletePoolInfo[];
    lanes: SafeDeleteLaneInfo[];
  } | null>(null);

  // 1. 解析 note.contentMarkdown
  const parsed = useMemo(() => parseFlowchartMarkdown(note.contentMarkdown), [note.contentMarkdown]);
  const [parseError, setParseError] = useState<string | null>(null);

  // 8. 写者校验（提前到 state 初始化之前，因为 toFlowNode 需要 readOnly 决定是否可缩放）
  const isWriter = !writerInstanceId || writerInstanceId === editorInstanceId;
  const readOnly = !isWriter;

  // 2. 内部历史状态
  const [history, setHistory] = useState<HistoryState>(() =>
    parsed.ok ? makeInitialHistory(parsed.document) : makeInitialHistory(emptyDoc()),
  );
  // 初始化 latestDocRef（在 history 声明后立即同步）
  if (latestDocRef.current === null) {
    latestDocRef.current = history.present.document;
  }

  // 3. 同步外部 contentMarkdown 变化（多标签页广播）
  const lastSyncedMdRef = useRef(note.contentMarkdown);
  // 跟踪本地提交：onContentChange 调用前置 true，sync effect 据此跳过外部同步
  const isLocalCommitRef = useRef(false);
  // 跟踪上次同步的 forceSync 计数器，用于 NotesView 拒绝提交后强制 re-sync
  const lastForceSyncRef = useRef(forceSync);

  useEffect(() => {
    // 本地提交引起的内容变化不需要重新解析（history 已更新）
    if (isLocalCommitRef.current) {
      isLocalCommitRef.current = false;
      lastSyncedMdRef.current = note.contentMarkdown;
      return;
    }
    // forceSync 计数器变化时强制 re-sync（NotesView 拒绝了提交）
    const forceSyncChanged = forceSync !== lastForceSyncRef.current;
    if (note.contentMarkdown === lastSyncedMdRef.current && !forceSyncChanged) return;
    lastForceSyncRef.current = forceSync;
    lastSyncedMdRef.current = note.contentMarkdown;
    const result = parseFlowchartMarkdown(note.contentMarkdown);
    if (!result.ok) {
      setParseError(result.message);
      return;
    }
    setParseError(null);
    setHistory(makeInitialHistory(result.document));
  }, [note.contentMarkdown, forceSync]);

  // 4. 选区状态
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  // 5. React Flow 受控节点/边
  // v2：文档主题解析为节点默认色（优先级：节点手动覆盖 > 文档主题 > CSS token）
  const themeDefaults = useMemo(
    () => resolveFlowchartThemeDefaults(history.present.document.theme),
    [history.present.document.theme],
  );

  const [rfNodes, setRfNodes] = useState<Node[]>(() =>
    parsed.ok ? parsed.document.nodes.map((n) => flowchartCanvasHelpers.toFlowNode(n, parsed.document.direction, readOnly, undefined, themeDefaults)) : [],
  );
  const [rfEdges, setRfEdges] = useState<Edge[]>(() =>
    parsed.ok ? parsed.document.edges.map((e) => flowchartCanvasHelpers.toFlowEdge(e)) : [],
  );

  // 9. 提交变更到中心（onContentChange + 历史 push）
  // 单写者模型：非写者 readOnly，不能提交；写者提交后由中心广播给所有实例。
  // 提交携带 baseRevision，NotesView 用于多标签页 revision 校验（设计文档 §8.5-3）。
  // 注：commitChange 必须在 handleEdgeControlPointsCommit 之前定义（被其依赖）。
  const commitChange = useCallback(
    (next: FlowchartDocument, changeKind: "layout" | "semantic", coalesceKey?: string) => {
      if (!isWriter) return;
      // 校验文档
      const v = validateFlowchartDocument(next);
      if (!v.ok) {
        // 不应用，提示用户
        return;
      }
      let newHistory: HistoryState;
      if (coalesceKey) {
        // 合并连续同类变更（如方向键长按微移）：替换 present 而非 push，future 清空
        const now = Date.now();
        const last = nudgeCoalesceRef.current;
        const canCoalesce = last !== null && last.key === coalesceKey && now - last.at < 800;
        nudgeCoalesceRef.current = { key: coalesceKey, at: now };
        newHistory = canCoalesce
          ? { past: history.past, present: { document: next, changeKind }, future: [] }
          : pushHistory(history, next, changeKind);
      } else {
        // 任何非合并提交都会打断微移合并链
        nudgeCoalesceRef.current = null;
        newHistory = pushHistory(history, next, changeKind);
      }
      setHistory(newHistory);
      const md = serializeFlowchartMarkdown(note.title || "未命名流程图", next);
      lastSyncedMdRef.current = md;
      isLocalCommitRef.current = true;
      onContentChange({
        contentMarkdown: md,
        plainText: buildFlowchartPlainText(note.title || "未命名流程图", next),
        baseRevision: revision,
      });
    },
    [history, note.title, onContentChange, isWriter, revision],
  );
  // 同步 ref：让边控制点回调通过 ref 间接调用，避免回调依赖 history 导致的连锁重建
  commitChangeRef.current = commitChange;
  latestDocRef.current = history.present.document;

  // 边控制点实时变更（WPS 风格连接线调整）：拖动期间高频触发，
  // 只更新 React Flow 内部状态（rfEdges），不提交历史栈，避免历史淹没。
  // 与节点拖动一致：拖动期间实时更新 rfNodes，拖动结束才 commitChange。
  // 注：必须定义在下方「同步 history → React Flow」的 useEffect 之前，避免 TDZ。
  const handleEdgeControlPointsChange = useCallback(
    (edgeId: string, controlPoints: { x: number; y: number }[] | undefined) => {
      if (readOnly) return;
      setRfEdges((edges) =>
        edges.map((e) => {
          if (e.id !== edgeId) return e;
          const data = (e.data ?? {}) as Record<string, unknown>;
          return {
            ...e,
            data: {
              ...data,
              controlPoints: controlPoints
                ? controlPoints.map((p) => ({ x: p.x, y: p.y }))
                : undefined,
            },
          };
        }),
      );
    },
    [readOnly],
  );

  // 边控制点提交（拖动结束或双击删除时触发一次）：写入文档历史栈。
  // 使用 layout 变更类型（不影响 AI baseHash，但仍写入文档与序列化）。
  // 通过 ref 间接调用 commitChange 和读取 doc，使回调只依赖 [readOnly]，
  // 避免 history 变化时回调重建 → useEffect 重执行 → 所有 edges 重建 → 边重渲染。
  const handleEdgeControlPointsCommit = useCallback(
    (edgeId: string, controlPoints: { x: number; y: number }[] | undefined) => {
      if (readOnly) return;
      // latestDocRef 在每次渲染时同步 history.present.document，不会为 null
      const doc = cloneFlowchartDocument(latestDocRef.current!);
      const idx = doc.edges.findIndex((e) => e.id === edgeId);
      if (idx < 0) return;
      const next: FlowchartEdge = { ...doc.edges[idx] };
      if (controlPoints && controlPoints.length > 0) {
        next.controlPoints = controlPoints.map((p) => ({ x: p.x, y: p.y }));
      } else {
        delete next.controlPoints;
      }
      doc.edges[idx] = next;
      commitChangeRef.current(doc, "layout");
    },
    [readOnly],
  );

  // 同步 history → React Flow
  useEffect(() => {
    const doc = history.present.document;
    setRfNodes(doc.nodes.map((n) => flowchartCanvasHelpers.toFlowNode(n, doc.direction, readOnly, undefined, themeDefaults)));
    setRfEdges(
      doc.edges.map((e) =>
        flowchartCanvasHelpers.toFlowEdge(e, {
          readOnly,
          onControlPointsChange: handleEdgeControlPointsChange,
          onControlPointsCommit: handleEdgeControlPointsCommit,
        }),
      ),
    );
  }, [history, readOnly, themeDefaults, handleEdgeControlPointsChange, handleEdgeControlPointsCommit]);

  // 6. 计算当前 baseHash 并同步到 Context
  const currentHash = useMemo(
    () => computeFlowchartSemanticHash(history.present.document),
    [history.present.document],
  );
  useEffect(() => {
    updateBaseHash(note.id, currentHash);
  }, [note.id, currentHash, updateBaseHash]);

  // 7. 同步选区到 Context
  useEffect(() => {
    setSelection(note.id, { nodeIds: selectedNodeIds, edgeIds: selectedEdgeIds }, currentHash);
  }, [note.id, selectedNodeIds, selectedEdgeIds, currentHash, setSelection]);

  // 注：commitChange 已上移至「边控制点」相关回调之前定义（被 handleEdgeControlPointsCommit 依赖）。

  // 10. 工具栏操作
  const handleAddNode = useCallback(
    (shape: FlowchartShapeDefinition) => {
      if (readOnly) return;
      // 点击在视口中心创建（考虑 zoom/pan）；canvas 未就绪时回退到包围盒右下方
      let center = canvasRef.current?.getViewportCenter();
      if (!center) {
        const xs = history.present.document.nodes.map((n) => n.position.x);
        const ys = history.present.document.nodes.map((n) => n.position.y);
        center = {
          x: xs.length > 0 ? Math.max(...xs) + 200 : 0,
          y: ys.length > 0 ? Math.max(...ys) + 100 : 0,
        };
      }

      const creation = shape.creation;
      // 泳池（FC-SWIM-01）：1 pool + 2 lane，一次提交一次撤销
      if (creation?.action === "pool") {
        const size = flowchartPoolDefaultSize(creation.orientation);
        const poolId = generateFlowchartNodeId();
        const created = createPoolNodes({
          poolId,
          laneIds: [generateFlowchartNodeId(), generateFlowchartNodeId()],
          orientation: creation.orientation,
          position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
        });
        const doc = cloneFlowchartDocument(history.present.document);
        doc.nodes.push(...created);
        setSelectedNodeIds([poolId]);
        setSelectedEdgeIds([]);
        commitChange(doc, "semantic");
        return;
      }
      // 泳道 / 分隔（FC-SWIM-01）：追加到当前选中的同方向泳池；未选中时提示先插入泳池
      if (creation?.action === "lane" || creation?.action === "divider") {
        const pool = findSelectedPoolForLane(
          history.present.document.nodes,
          selectedNodeIds,
          creation.orientation,
        );
        if (!pool) {
          setActionNotice(
            `请先选中一个${creation.orientation === "horizontal" ? "横向" : "纵向"}泳池（或先插入泳池）`,
          );
          return;
        }
        const laneId = generateFlowchartNodeId();
        const next = addLaneToPool(history.present.document.nodes, pool.id, laneId);
        if (!next) return;
        const doc = cloneFlowchartDocument(history.present.document);
        doc.nodes = next;
        setSelectedNodeIds([laneId]);
        setSelectedEdgeIds([]);
        commitChange(doc, "semantic");
        return;
      }

      const node = createShapeNodeAtCenter(shape.kind, center);
      if (!node) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.nodes.push(node);
      setSelectedNodeIds([node.id]);
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 拖拽形状到画布指定位置（落点为节点中心）
  const handleDropShape = useCallback(
    (shapeId: string, x: number, y: number) => {
      if (readOnly) return;
      const shape = getFlowchartShapeById(shapeId);
      if (!shape) return;
      const creation = shape.creation;
      // 泳池（FC-SWIM-01）：落点为泳池中心
      if (creation?.action === "pool") {
        const size = flowchartPoolDefaultSize(creation.orientation);
        const poolId = generateFlowchartNodeId();
        const created = createPoolNodes({
          poolId,
          laneIds: [generateFlowchartNodeId(), generateFlowchartNodeId()],
          orientation: creation.orientation,
          position: { x: x - size.width / 2, y: y - size.height / 2 },
        });
        const doc = cloneFlowchartDocument(history.present.document);
        doc.nodes.push(...created);
        setSelectedNodeIds([poolId]);
        setSelectedEdgeIds([]);
        commitChange(doc, "semantic");
        return;
      }
      // 泳道 / 分隔（FC-SWIM-01）：落点所在的同方向泳池优先，其次当前选中的泳池
      if (creation?.action === "lane" || creation?.action === "divider") {
        const pool =
          findPoolAtPoint(history.present.document.nodes, { x, y }, creation.orientation) ??
          findSelectedPoolForLane(history.present.document.nodes, selectedNodeIds, creation.orientation);
        if (!pool) {
          setActionNotice(
            `请将泳道拖入${creation.orientation === "horizontal" ? "横向" : "纵向"}泳池（或先插入泳池）`,
          );
          return;
        }
        const laneId = generateFlowchartNodeId();
        const next = addLaneToPool(history.present.document.nodes, pool.id, laneId);
        if (!next) return;
        const doc = cloneFlowchartDocument(history.present.document);
        doc.nodes = next;
        setSelectedNodeIds([laneId]);
        setSelectedEdgeIds([]);
        commitChange(doc, "semantic");
        return;
      }
      const node = createShapeNodeAtCenter(shape.kind, { x, y });
      if (!node) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.nodes.push(node);
      setSelectedNodeIds([node.id]);
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 插入图片节点：复制图片到 vault/assets/ 目录，创建 image 节点
  const handleAddImage = useCallback(async () => {
    if (readOnly) return;
    try {
      let fileName: string;
      let fileBytes: Uint8Array;

      if (!isTauri()) {
        // Browser fallback：通过 <input> 选择文件
        const file = await selectImageFile();
        if (!file) return;
        fileName = file.name;
        fileBytes = new Uint8Array(await file.arrayBuffer());
      } else {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const sourcePath = await open({
          multiple: false,
          filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
        });
        if (!sourcePath || Array.isArray(sourcePath)) return;
        fileName = sourcePath.split(/[\\/]/).pop() || "image.png";
        const { readFile } = await import("@tauri-apps/plugin-fs");
        fileBytes = await readFile(sourcePath);
      }

      const ext = (fileName.split(".").pop()?.toLowerCase() || "png").replace("jpeg", "jpg");
      const assetName = `image-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      const relativePath = `assets/${assetName}`;

      if (isTauri()) {
        const vaultPath = await getNotesVaultPath();
        if (!vaultPath) throw new Error("无法获取笔记仓库路径");
        const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
        const assetsDir = `${vaultPath}/assets`;
        await mkdir(assetsDir, { recursive: true });
        await writeFile(`${assetsDir}/${assetName}`, fileBytes);
      }

      const doc = cloneFlowchartDocument(history.present.document);
      const id = generateFlowchartNodeId();
      const xs = doc.nodes.map((n) => n.position.x);
      const ys = doc.nodes.map((n) => n.position.y);
      const node: FlowchartNode = {
        id,
        kind: "image",
        label: fileName,
        position: { x: xs.length > 0 ? Math.max(...xs) + 200 : 0, y: ys.length > 0 ? Math.max(...ys) + 100 : 0 },
        size: { width: 200, height: 200 },
        imagePath: relativePath,
      };
      doc.nodes.push(node);
      setSelectedNodeIds([id]);
      commitChange(doc, "semantic");
    } catch (err) {
      console.error("[flowchart] insert image failed", err);
    }
  }, [history.present.document, readOnly, commitChange]);

  // 拖出连线到空白处：创建新节点并自动连线
  const handleCreateNodeWithConnection = useCallback(
    (
      kind: FlowchartNodeKind,
      position: { x: number; y: number },
      connection: { source: string; sourceHandle?: string },
    ) => {
      if (readOnly) return;
      const node = createShapeNodeAtCenter(kind, position);
      if (!node) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.nodes.push(node);
      const edge: FlowchartEdge = {
        id: generateFlowchartEdgeId(),
        source: connection.source,
        target: node.id,
        sourceHandle: connection.sourceHandle,
      };
      doc.edges.push(edge);
      setSelectedNodeIds([node.id]);
      setSelectedEdgeIds([]);
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, commitChange],
  );

  // freehand 绘制完成：创建 freehand 节点（pen/highlighter 笔触）
  // 参考 NoteGen canvas-editor.tsx 的 onFreehandComplete：将笔触点+几何信息存入节点
  const handleFreehandComplete = useCallback(
    (payload: FreehandCompletePayload) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const id = generateFlowchartNodeId();
      const node: FlowchartNode = {
        id,
        kind: "freehand",
        label: "",
        position: payload.position,
        size: payload.size,
        points: payload.points,
        path: payload.path,
        drawingTool: payload.tool,
        color: payload.color,
        opacity: payload.opacity,
        strokeWidth: payload.strokeWidth,
      };
      doc.nodes.push(node);
      // 选中新创建的笔触节点，便于后续移动/删除
      setSelectedNodeIds([id]);
      setSelectedEdgeIds([]);
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 橡皮擦除：删除被命中的 freehand 节点
  // 设计：擦除是语义变更（产生新历史记录），但单次拖拽内合并为一次提交
  const handleEraseFreehand = useCallback(
    (nodeIds: string[]) => {
      if (readOnly || nodeIds.length === 0) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const removeSet = new Set(nodeIds);
      doc.nodes = doc.nodes.filter((n) => !removeSet.has(n.id));
      // freehand 节点不可连接，无关联边需要清理
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 双击节点编辑 label
  const handleNodeLabelEdit = useCallback(
    (nodeId: string, label: string) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idx = doc.nodes.findIndex((n) => n.id === nodeId);
      if (idx < 0) return;
      doc.nodes[idx] = { ...doc.nodes[idx], label };
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 应用样式到选中节点
  const applyNodeStyle = useCallback(
    (patch: Partial<FlowchartNodeStyle>) => {
      if (readOnly || selectedNodeIds.length === 0) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(selectedNodeIds);
      doc.nodes = doc.nodes.map((n) => {
        if (!idSet.has(n.id)) return n;
        const current = n.style ?? {};
        const next: FlowchartNodeStyle = { ...current };
        for (const [k, v] of Object.entries(patch)) {
          const key = k as keyof FlowchartNodeStyle;
          if (v === undefined || v === "") {
            delete next[key];
          } else {
            (next[key] as unknown) = v;
          }
        }
        return { ...n, style: Object.keys(next).length > 0 ? next : undefined };
      });
      commitChange(doc, "layout");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 应用样式到选中边
  const applyEdgeStyle = useCallback(
    (patch: Partial<FlowchartEdgeStyle>) => {
      if (readOnly || selectedEdgeIds.length === 0) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(selectedEdgeIds);
      doc.edges = doc.edges.map((e) => {
        if (!idSet.has(e.id)) return e;
        const current = e.style ?? {};
        const next: FlowchartEdgeStyle = { ...current };
        for (const [k, v] of Object.entries(patch)) {
          const key = k as keyof FlowchartEdgeStyle;
          if (v === undefined || v === "") {
            delete next[key];
          } else {
            (next[key] as unknown) = v;
          }
        }
        return { ...e, style: Object.keys(next).length > 0 ? next : undefined };
      });
      commitChange(doc, "layout");
    },
    [history.present.document, readOnly, selectedEdgeIds, commitChange],
  );

  // 应用文档主题（FC-THEME-02）：主题属于视觉设置，commit 为 layout，不改变 semantic hash
  // stripManualStyles=true 时（“不保留手动样式”经用户确认后）清理节点手动颜色字段
  const handleApplyTheme = useCallback(
    (theme: FlowchartThemeSettings, options: { stripManualStyles: boolean }) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.theme = { ...theme };
      if (options.stripManualStyles) {
        doc.nodes = stripThemeProvidedStyles(doc.nodes);
      }
      commitChange(doc, "layout");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 有手动颜色样式的节点数（样式面板“清理确认”提示用）
  const manualStyleNodeCount = useMemo(
    () => countNodesWithManualThemeStyles(history.present.document.nodes),
    [history.present.document.nodes],
  );

  // Inspector 页面样式修改（FC-UI-02）：canvas 属于视觉设置，commit 为 layout
  const handleCanvasSettingsChange = useCallback(
    (patch: Partial<FlowchartCanvasSettings>) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.canvas = { ...doc.canvas, ...patch };
      commitChange(doc, "layout");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 网格显示/吸附：文档 canvas.grid 为唯一数据源（FC-UI-02），footer 与 Inspector 共用
  const showGrid = history.present.document.canvas.grid.visible;
  const snapToGrid = history.present.document.canvas.grid.snap;
  const handleShowGridChange = useCallback(
    (visible: boolean) => {
      handleCanvasSettingsChange({
        grid: { ...history.present.document.canvas.grid, visible },
      });
    },
    [handleCanvasSettingsChange, history.present.document.canvas.grid],
  );
  const handleSnapToGridChange = useCallback(
    (snap: boolean) => {
      handleCanvasSettingsChange({
        grid: { ...history.present.document.canvas.grid, snap },
      });
    },
    [handleCanvasSettingsChange, history.present.document.canvas.grid],
  );

  // Inspector 几何修改（FC-UI-02/03）：位置/尺寸/旋转/翻转/不透明度/锁定
  // 锁定节点禁止几何修改（locked 字段本身除外）；批量修改形成一个撤销单元
  const handleNodeGeometryChange = useCallback(
    (patch: FlowchartNodeGeometryPatch) => {
      if (readOnly || selectedNodeIds.length === 0) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(selectedNodeIds);
      const touchesGeometry =
        patch.x !== undefined ||
        patch.y !== undefined ||
        patch.width !== undefined ||
        patch.height !== undefined ||
        patch.rotation !== undefined ||
        patch.flipX !== undefined ||
        patch.flipY !== undefined;
      let changed = false;
      doc.nodes = doc.nodes.map((n) => {
        if (!idSet.has(n.id)) return n;
        if (n.locked && touchesGeometry) return n;
        const next = { ...n };
        if (patch.x !== undefined) next.position = { x: patch.x, y: next.position.y };
        if (patch.y !== undefined) next.position = { x: next.position.x, y: patch.y };
        if (patch.width !== undefined || patch.height !== undefined) {
          const cur = next.size ?? { width: 200, height: 100 };
          next.size = { width: patch.width ?? cur.width, height: patch.height ?? cur.height };
        }
        if (patch.rotation !== undefined) next.rotation = patch.rotation > 0 ? patch.rotation : undefined;
        if (patch.flipX !== undefined) next.flipX = patch.flipX || undefined;
        if (patch.flipY !== undefined) next.flipY = patch.flipY || undefined;
        if (patch.opacity !== undefined) next.opacity = patch.opacity >= 1 ? undefined : patch.opacity;
        if (patch.locked !== undefined) next.locked = patch.locked || undefined;
        changed = true;
        return next;
      });
      if (changed) commitChange(doc, "layout");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 匹配大小（FC-ARRANGE-01）：以首个选中节点为基准，锁定节点跳过；单次撤销
  const handleMatchSize = useCallback(
    (mode: "width" | "height" | "both") => {
      if (readOnly || selectedNodeIds.length < 2) return;
      const doc = history.present.document;
      const fn =
        mode === "width" ? matchNodesWidth : mode === "height" ? matchNodesHeight : matchNodesSize;
      const nextNodes = fn(doc.nodes, selectedNodeIds);
      if (!nextNodes) return;
      const next = cloneFlowchartDocument(doc);
      next.nodes = nextNodes;
      commitChange(next, "layout");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 组合（FC-GROUP-01）：≥2 个根级普通节点装入新建 group，单次撤销
  const handleGroup = useCallback(() => {
    if (readOnly) return;
    const result = groupNodes(
      history.present.document.nodes,
      selectedNodeIds,
      generateFlowchartNodeId(),
    );
    if (!result) return;
    const doc = cloneFlowchartDocument(history.present.document);
    doc.nodes = result.nodes;
    setSelectedNodeIds([result.groupId]);
    setSelectedEdgeIds([]);
    commitChange(doc, "semantic");
  }, [history.present.document, readOnly, selectedNodeIds, commitChange]);

  // 取消组合（FC-GROUP-01）：解散选中的 group，子节点恢复根级并选中
  const handleUngroup = useCallback(() => {
    if (readOnly) return;
    const doc0 = history.present.document;
    const groupIds = selectedNodeIds.filter(
      (id) => doc0.nodes.find((n) => n.id === id)?.kind === "group",
    );
    if (groupIds.length === 0) return;
    const childIds = doc0.nodes
      .filter((n) => n.parentId !== undefined && groupIds.includes(n.parentId))
      .map((n) => n.id);
    const result = ungroupNodes(doc0.nodes, doc0.edges, groupIds);
    if (!result) return;
    const doc = cloneFlowchartDocument(doc0);
    doc.nodes = result.nodes;
    doc.edges = result.edges;
    setSelectedNodeIds(childIds);
    setSelectedEdgeIds([]);
    commitChange(doc, "semantic");
  }, [history.present.document, readOnly, selectedNodeIds, commitChange]);

  // 层级调整（FC-LAYER-01）：置顶/置底/上移一层/下移一层，单次撤销
  const handleReorder = useCallback(
    (action: FlowchartLayerAction) => {
      if (readOnly || selectedNodeIds.length === 0) return;
      const nextNodes = reorderNodes(history.present.document.nodes, selectedNodeIds, action);
      if (!nextNodes) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.nodes = nextNodes;
      commitChange(doc, "layout");
    },
    [history.present.document, readOnly, selectedNodeIds, commitChange],
  );

  // 组合/取消组合可用性（右键菜单与 Inspector 共用判断）
  const selectedNodesList = history.present.document.nodes.filter((n) =>
    selectedNodeIds.includes(n.id),
  );
  const canGroup =
    selectedNodesList.length >= 2 &&
    selectedNodesList.every(
      (n) => !n.locked && !isFlowchartContainerKind(n.kind) && n.parentId === undefined,
    );
  const canUngroup = selectedNodesList.some((n) => n.kind === "group");

  // 直接删除（无确认）：普通节点/边/空泳道/无泳道的空泳池。
  // 空泳道走 removeLane（泳池收缩、剩余泳道紧凑重排）；容器级联删除子树避免悬空 parentId。
  const handleDeleteSelected = useCallback(() => {
    if (readOnly) return;
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
    const doc = cloneFlowchartDocument(history.present.document);
    const idSet = new Set(selectedNodeIds);
    // 空泳道走 removeLane（内容为空，move-to-root 无实际移动）
    for (const n of doc.nodes) {
      if (n.kind === "swimlane-lane" && idSet.has(n.id)) {
        const res = removeLane(doc.nodes, doc.edges, n.id, { type: "move-to-root" });
        if (res) {
          doc.nodes = res.nodes;
          doc.edges = res.edges;
        }
        idSet.delete(n.id);
      }
    }
    // 容器节点级联删除其子树（group 子节点、pool 的 lane 及 lane 内容），避免悬空 parentId
    const cascadeIds = new Set(idSet);
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of doc.nodes) {
        if (n.parentId !== undefined && cascadeIds.has(n.parentId) && !cascadeIds.has(n.id)) {
          cascadeIds.add(n.id);
          grew = true;
        }
      }
    }
    doc.nodes = doc.nodes.filter((n) => !cascadeIds.has(n.id));
    // 同时删除关联边
    doc.edges = doc.edges.filter((e) => {
      if (cascadeIds.has(e.source) || cascadeIds.has(e.target)) return false;
      return !selectedEdgeIds.includes(e.id);
    });
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    commitChange(doc, "semantic");
  }, [history.present.document, readOnly, selectedNodeIds, selectedEdgeIds, commitChange]);

  // 安全删除入口（FC-SWIM-04）：删除前检查非空泳池/泳道，需要时弹确认对话框。
  // 键盘 Delete、右键菜单、剪切、工具栏删除统一走此入口。
  const requestDeleteSelected = useCallback(() => {
    if (readOnly) return;
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
    const doc = history.present.document;
    const idSet = new Set(selectedNodeIds);
    const selectedPools = doc.nodes.filter((n) => idSet.has(n.id) && n.kind === "swimlane-pool");
    const selectedPoolIds = new Set(selectedPools.map((p) => p.id));
    const pools: SafeDeletePoolInfo[] = [];
    for (const pool of selectedPools) {
      const laneIds = doc.nodes
        .filter((n) => n.kind === "swimlane-lane" && n.parentId === pool.id)
        .map((l) => l.id);
      if (laneIds.length === 0) continue; // 无泳道的空泳池直接删
      const laneIdSet = new Set(laneIds);
      const contentIds = new Set(
        doc.nodes
          .filter((n) => n.parentId !== undefined && laneIdSet.has(n.parentId))
          .map((n) => n.id),
      );
      const subtree = new Set([...laneIds, ...contentIds]);
      pools.push({
        id: pool.id,
        label: pool.label || "泳池",
        laneCount: laneIds.length,
        contentCount: contentIds.size,
        edgeCount: doc.edges.filter((e) => subtree.has(e.source) || subtree.has(e.target)).length,
      });
    }
    const lanes: SafeDeleteLaneInfo[] = [];
    for (const lane of doc.nodes) {
      if (!idSet.has(lane.id) || lane.kind !== "swimlane-lane") continue;
      // 父泳池同被选中时由泳池策略覆盖
      if (lane.parentId !== undefined && selectedPoolIds.has(lane.parentId)) continue;
      const children = doc.nodes.filter((n) => n.parentId === lane.id);
      if (children.length === 0) continue; // 空泳道直接删
      const childIds = new Set(children.map((c) => c.id));
      const pool = doc.nodes.find((n) => n.id === lane.parentId);
      const siblingCount = doc.nodes.filter(
        (n) => n.kind === "swimlane-lane" && n.parentId === lane.parentId && n.id !== lane.id,
      ).length;
      lanes.push({
        id: lane.id,
        label: lane.label || "泳道",
        poolLabel: pool?.label || "泳池",
        contentCount: children.length,
        edgeCount: doc.edges.filter((e) => childIds.has(e.source) || childIds.has(e.target)).length,
        hasAdjacentLane: siblingCount > 0,
      });
    }
    if (pools.length > 0 || lanes.length > 0) {
      setSafeDeleteTargets({ pools, lanes });
      return;
    }
    handleDeleteSelected();
  }, [readOnly, selectedNodeIds, selectedEdgeIds, history.present.document, handleDeleteSelected]);

  // 确认安全删除（FC-SWIM-04）：按策略处理泳池/泳道，再删除其余选中项，一次提交一次撤销
  const handleConfirmSafeDelete = useCallback(
    (opts: SafeDeleteConfirmOptions) => {
      if (readOnly || !safeDeleteTargets) return;
      const doc = cloneFlowchartDocument(history.present.document);
      let nodes = doc.nodes;
      let edges = doc.edges;
      // 1. 非空泳道（其父泳池未被选中删除）：按策略迁移/删除内容，泳池收缩重排
      for (const info of safeDeleteTargets.lanes) {
        let strategy: RemoveLaneStrategy;
        if (opts.laneStrategy === "move-to-lane") {
          const targetLaneId = findAdjacentLaneId(nodes, info.id);
          strategy = targetLaneId
            ? { type: "move-to-lane", targetLaneId }
            : { type: "move-to-root" };
        } else if (opts.laneStrategy === "move-to-root") {
          strategy = { type: "move-to-root" };
        } else {
          strategy = { type: "delete-content" };
        }
        const res = removeLane(nodes, edges, info.id, strategy);
        if (res) {
          nodes = res.nodes;
          edges = res.edges;
        }
      }
      // 2. 非空泳池：按策略迁移/删除全部泳道内容
      for (const info of safeDeleteTargets.pools) {
        const res = removePool(nodes, edges, info.id, { type: opts.poolStrategy });
        if (res) {
          nodes = res.nodes;
          edges = res.edges;
        }
      }
      // 3. 其余选中项（普通节点、空泳道、未确认容器、边）按直接删除逻辑处理
      const idSet = new Set(selectedNodeIds);
      for (const p of safeDeleteTargets.pools) idSet.delete(p.id);
      for (const l of safeDeleteTargets.lanes) idSet.delete(l.id);
      for (const n of nodes) {
        if (n.kind === "swimlane-lane" && idSet.has(n.id)) {
          const res = removeLane(nodes, edges, n.id, { type: "move-to-root" });
          if (res) {
            nodes = res.nodes;
            edges = res.edges;
          }
          idSet.delete(n.id);
        }
      }
      const cascadeIds = new Set(idSet);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId !== undefined && cascadeIds.has(n.parentId) && !cascadeIds.has(n.id)) {
            cascadeIds.add(n.id);
            grew = true;
          }
        }
      }
      nodes = nodes.filter((n) => !cascadeIds.has(n.id));
      edges = edges.filter((e) => {
        if (cascadeIds.has(e.source) || cascadeIds.has(e.target)) return false;
        return !selectedEdgeIds.includes(e.id);
      });
      doc.nodes = nodes;
      doc.edges = edges;
      setSafeDeleteTargets(null);
      setSelectedNodeIds([]);
      setSelectedEdgeIds([]);
      commitChange(doc, "semantic");
    },
    [
      readOnly,
      safeDeleteTargets,
      history.present.document,
      selectedNodeIds,
      selectedEdgeIds,
      commitChange,
    ],
  );

  // 全选：通过 canvasRef 调用 FlowchartCanvas.selectAll
  const handleSelectAll = useCallback(() => {
    if (readOnly) return;
    canvasRef.current?.selectAll();
  }, [readOnly]);

  // 自动布局：容器感知布局（FC-SWIM-05），无容器时退化为全量 Dagre
  // 作为 layout 变更进入撤销栈（节点位置改变影响 layout，但 baseHash 不变）
  const handleAutoLayout = useCallback(() => {
    if (readOnly) return;
    const doc = cloneFlowchartDocument(history.present.document);
    if (doc.nodes.length === 0) return;
    layoutFlowchartWithContainers(doc);
    setHistory((state) => pushHistory(state, doc, "layout"));
    const md = serializeFlowchartMarkdown(note.title || "未命名流程图", doc);
    lastSyncedMdRef.current = md;
    isLocalCommitRef.current = true;
    onContentChange({
      contentMarkdown: md,
      plainText: buildFlowchartPlainText(note.title || "未命名流程图", doc),
      baseRevision: revision,
    });
    // 布局后自动适应视图
    requestAnimationFrame(() => canvasRef.current?.fitView());
  }, [readOnly, history.present.document, note.title, onContentChange, revision]);

  // 适应视图：footer 按钮调用
  const handleFitView = useCallback(() => {
    canvasRef.current?.fitView(0.2);
  }, []);

  // footer 缩放滑块：调用 canvas.setZoom，触发 onMoveEnd → handleViewportChange 持久化
  const handleZoomChange = useCallback((z: number) => {
    canvasRef.current?.setZoom(z);
  }, []);

  // 形状转换：将选中节点 kind 改为新类型（保留 label/style/position/size）
  const handleConvertNodeKind = useCallback(
    (kind: FlowchartNodeKind) => {
      if (readOnly) return;
      const ids = menuCtx?.kind === "node" ? [menuCtx.nodeId] : selectedNodeIds;
      if (ids.length === 0) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(ids);
      let changed = false;
      doc.nodes = doc.nodes.map((n) => {
        if (!idSet.has(n.id)) return n;
        if (n.kind === kind) return n;
        changed = true;
        return { ...n, kind };
      });
      if (changed) commitChange(doc, "semantic");
      setMenuCtx(null);
    },
    [readOnly, menuCtx, selectedNodeIds, history.present.document, commitChange],
  );

  // 边反转：交换 source/target 和 handle
  const handleReverseEdge = useCallback(
    (edgeId: string) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idx = doc.edges.findIndex((e) => e.id === edgeId);
      if (idx < 0) return;
      const e = doc.edges[idx];
      doc.edges[idx] = {
        ...e,
        source: e.target,
        target: e.source,
        sourceHandle: e.targetHandle,
        targetHandle: e.sourceHandle,
      };
      commitChange(doc, "semantic");
      setMenuCtx(null);
    },
    [readOnly, history.present.document, commitChange],
  );

  // 在画布指定位置新建节点（右键画布菜单用）
  const handleMenuAddNodeAt = useCallback(
    (kind: FlowchartNodeKind) => {
      if (readOnly) return;
      const xs = history.present.document.nodes.map((n) => n.position.x);
      const ys = history.present.document.nodes.map((n) => n.position.y);
      const cx = xs.length > 0 ? Math.max(...xs) + 200 : 0;
      const cy = ys.length > 0 ? Math.max(...ys) + 100 : 0;
      const node = createShapeNodeAtCenter(kind, { x: cx, y: cy });
      if (!node) return;
      const doc = cloneFlowchartDocument(history.present.document);
      doc.nodes.push(node);
      setSelectedNodeIds([node.id]);
      commitChange(doc, "semantic");
      setMenuCtx(null);
    },
    [readOnly, history.present.document, commitChange],
  );

  // 右键菜单触发：右键节点时自动选中该节点
  const handleContextMenu = useCallback(
    (ctx: FlowchartContextMenuContext) => {
      if (readOnly) return;
      if (ctx.kind === "node") {
        if (!selectedNodeIds.includes(ctx.nodeId)) {
          setSelectedNodeIds([ctx.nodeId]);
          setSelectedEdgeIds([]);
        }
      } else if (ctx.kind === "edge") {
        if (!selectedEdgeIds.includes(ctx.edgeId)) {
          setSelectedEdgeIds([ctx.edgeId]);
          setSelectedNodeIds([]);
        }
      }
      setMenuCtx(ctx);
    },
    [readOnly, selectedNodeIds, selectedEdgeIds],
  );

  // 11a. 对齐与分布（设计文档 §7.7）
  // 仅修改 position，进入 layout history（不导致 AI patch stale）
  const applyAlignment = useCallback(
    (mode: "left" | "center-h" | "right" | "top" | "center-v" | "bottom") => {
      if (readOnly || selectedNodeIds.length < 2) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(selectedNodeIds);
      const targets = doc.nodes.filter((n) => idSet.has(n.id));
      if (targets.length < 2) return;
      const xs = targets.map((n) => n.position.x);
      const ys = targets.map((n) => n.position.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      doc.nodes = doc.nodes.map((n) => {
        if (!idSet.has(n.id)) return n;
        let { x, y } = n.position;
        if (mode === "left") x = minX;
        else if (mode === "center-h") x = cx;
        else if (mode === "right") x = maxX;
        else if (mode === "top") y = minY;
        else if (mode === "center-v") y = cy;
        else if (mode === "bottom") y = maxY;
        return { ...n, position: { x, y } };
      });
      commitChange(doc, "layout");
    },
    [readOnly, selectedNodeIds, history.present.document, commitChange],
  );

  const applyDistribution = useCallback(
    (mode: "horizontal" | "vertical") => {
      if (readOnly || selectedNodeIds.length < 3) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idSet = new Set(selectedNodeIds);
      const targets = doc.nodes.filter((n) => idSet.has(n.id));
      if (targets.length < 3) return;
      // 排序并均匀分布
      const sorted = [...targets].sort((a, b) =>
        mode === "horizontal" ? a.position.x - b.position.x : a.position.y - b.position.y,
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const startCoord = mode === "horizontal" ? first.position.x : first.position.y;
      const endCoord = mode === "horizontal" ? last.position.x : last.position.y;
      const step = (endCoord - startCoord) / (sorted.length - 1);
      const idToPos: Record<string, number> = {};
      sorted.forEach((n, i) => {
        idToPos[n.id] = startCoord + step * i;
      });
      doc.nodes = doc.nodes.map((n) => {
        if (!idSet.has(n.id)) return n;
        const newCoord = idToPos[n.id];
        if (newCoord === undefined) return n;
        const pos =
          mode === "horizontal"
            ? { x: newCoord, y: n.position.y }
            : { x: n.position.x, y: newCoord };
        return { ...n, position: pos };
      });
      commitChange(doc, "layout");
    },
    [readOnly, selectedNodeIds, history.present.document, commitChange],
  );

  // 11b. viewport 持久化（设计文档 §7.7）
  // viewport 不进入撤销栈和 semantic hash；直接保存到 history.present.document.viewport
  const handleViewportChange = useCallback(
    (vp: FlowchartViewport) => {
      // footer 缩放显示始终同步（不论是否写者）
      setZoom(vp.zoom);
      if (!isWriter) return;
      setHistory((state) => {
        const doc = state.present.document;
        // 仅当变化超过阈值时才提交，避免频繁触发
        const cur = doc.viewport;
        if (
          cur &&
          Math.abs(cur.x - vp.x) < 0.5 &&
          Math.abs(cur.y - vp.y) < 0.5 &&
          Math.abs(cur.zoom - vp.zoom) < 0.001
        ) {
          return state;
        }
        const nextDoc = { ...doc, viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } };
        const md = serializeFlowchartMarkdown(note.title || "未命名流程图", nextDoc);
        lastSyncedMdRef.current = md;
        isLocalCommitRef.current = true;
        onContentChange({
          contentMarkdown: md,
          plainText: buildFlowchartPlainText(note.title || "未命名流程图", nextDoc),
          baseRevision: revision,
        });
        return {
          ...state,
          present: { ...state.present, document: nextDoc },
        };
      });
    },
    [isWriter, note.title, onContentChange, revision],
  );

  // 11. 撤销 / 重做
  const handleUndo = useCallback(() => {
    if (readOnly) return;
    setHistory((state) => {
      const next = undoHistory(state);
      const md = serializeFlowchartMarkdown(note.title || "未命名流程图", next.present.document);
      lastSyncedMdRef.current = md;
      isLocalCommitRef.current = true;
      onContentChange({
        contentMarkdown: md,
        plainText: buildFlowchartPlainText(note.title || "未命名流程图", next.present.document),
        baseRevision: revision,
      });
      return next;
    });
  }, [readOnly, note.title, onContentChange, revision]);

  const handleRedo = useCallback(() => {
    if (readOnly) return;
    setHistory((state) => {
      const next = redoHistory(state);
      const md = serializeFlowchartMarkdown(note.title || "未命名流程图", next.present.document);
      lastSyncedMdRef.current = md;
      isLocalCommitRef.current = true;
      onContentChange({
        contentMarkdown: md,
        plainText: buildFlowchartPlainText(note.title || "未命名流程图", next.present.document),
        baseRevision: revision,
      });
      return next;
    });
  }, [readOnly, note.title, onContentChange, revision]);

  // 12. React Flow 受控节点/边变更
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (readOnly) return;
      // 拖动结束后，更新 history 中的节点位置（一次拖动只记录一次）
      const hasPositionEnd = changes.some(
        (c) => c.type === "position" && c.dragging === false,
      );
      const hasRemove = changes.some((c) => c.type === "remove");
      // NodeResizer 产生的尺寸变化：resizing === false 表示缩放结束
      const hasDimensionsEnd = changes.some(
        (c) => c.type === "dimensions" && c.resizing === false,
      );
      // 实时更新 React Flow 内部状态
      // 拦截 group 子节点的 position 变化：拖动子节点时改为移动父容器，
      // 子节点相对位置不变 → 所有同组节点一起移动（FC-GROUP-01）
      setRfNodes((nodes) => {
        const modified: NodeChange[] = [];
        for (const c of changes) {
          if (c.type === "position" && c.position) {
            const rfNode = nodes.find((n) => n.id === c.id);
            if (rfNode?.parentId) {
              const parent = nodes.find((n) => n.id === rfNode.parentId);
              if (parent && (parent.data as { kind?: string }).kind === "group") {
                const dx = c.position.x - rfNode.position.x;
                const dy = c.position.y - rfNode.position.y;
                // 移动父容器（绝对坐标），子节点相对位置不变自动跟随
                modified.push({
                  type: "position",
                  id: parent.id,
                  position: { x: parent.position.x + dx, y: parent.position.y + dy },
                  dragging: c.dragging,
                });
                // 保持子节点相对位置不变
                modified.push({
                  type: "position",
                  id: c.id,
                  position: { x: rfNode.position.x, y: rfNode.position.y },
                  dragging: c.dragging,
                });
                continue;
              }
            }
          }
          modified.push(c);
        }
        return flowchartCanvasHelpers.applyNodeChanges(modified, nodes);
      });
      if (hasRemove) {
        // 删除节点：同步到文档（同时删除关联边）
        setRfNodes((current) => {
          const currentIds = new Set(current.map((n) => n.id));
          const removeIds = new Set(
            changes.filter((c) => c.type === "remove").map((c) => c.id),
          );
          const doc = cloneFlowchartDocument(history.present.document);
          doc.nodes = doc.nodes.filter((n) => !removeIds.has(n.id));
          doc.edges = doc.edges.filter(
            (e) => currentIds.has(e.source) && currentIds.has(e.target) && !removeIds.has(e.source) && !removeIds.has(e.target),
          );
          setSelectedNodeIds((ids) => ids.filter((id) => !removeIds.has(id)));
          commitChange(doc, "semantic");
          return current;
        });
      } else if (hasPositionEnd || hasDimensionsEnd) {
        // 同步位置和尺寸到文档并提交（layout 类型，不使 AI patch 过期）
        setRfNodes((current) => {
          const doc = cloneFlowchartDocument(history.present.document);
          const nodeInfo = new Map(
            current.map((n) => [n.id, { pos: n.position, w: n.width, h: n.height }]),
          );
          doc.nodes = doc.nodes.map((n) => {
            const info = nodeInfo.get(n.id);
            if (!info) return n;
            const next = { ...n, position: info.pos };
            if (typeof info.w === "number" && typeof info.h === "number" && info.w > 0 && info.h > 0) {
              next.size = { width: info.w, height: info.h };
            }
            return next;
          });
          // FC-SWIM-02：pool/lane 尺寸变更按策略重分配
          // （lane 跟随 pool 内容区、沿向按比例+最小尺寸保护、位置紧凑重排）
          if (hasDimensionsEnd) {
            const resizedIds: string[] = [];
            for (const c of changes) {
              if (c.type === "dimensions" && c.resizing === false) resizedIds.push(c.id);
            }
            for (const id of resizedIds) {
              const target = doc.nodes.find((x) => x.id === id);
              if (!target?.size) continue;
              const next =
                target.kind === "swimlane-pool"
                  ? resizePoolNodes(doc.nodes, id, target.size)
                  : target.kind === "swimlane-lane"
                    ? resizeLaneNodes(doc.nodes, id, target.size)
                    : null;
              if (next) doc.nodes = next;
            }
          }
          // FC-SWIM-03：拖动结束的节点做泳道归属判定
          // （拖入 lane 转为相对坐标 / 拖出 lane 解除归属保持屏幕位置 / 位置 clamp 到内容区）
          let membershipChanged = false;
          if (hasPositionEnd) {
            const draggedIds: string[] = [];
            for (const c of changes) {
              if (c.type === "position" && c.dragging === false) draggedIds.push(c.id);
            }
            for (const id of draggedIds) {
              const target = doc.nodes.find((x) => x.id === id);
              if (!target || target.locked || isFlowchartContainerKind(target.kind)) continue;
              const abs = flowchartNodeAbsolutePosition(doc.nodes, id);
              if (!abs) continue;
              const size = target.size ?? { width: 200, height: 100 };
              const center = { x: abs.x + size.width / 2, y: abs.y + size.height / 2 };
              const lane = findLaneAtPoint(doc.nodes, center);
              const parent = target.parentId
                ? doc.nodes.find((x) => x.id === target.parentId)
                : undefined;
              // group 归属显式管理（不隐式解除）；lane 归属跟随拖放
              let nextParent: string | undefined | null = null;
              if (lane && target.parentId !== lane.id) nextParent = lane.id;
              else if (!lane && parent?.kind === "swimlane-lane") nextParent = undefined;
              if (nextParent !== null) {
                const next = reparentNodes(doc.nodes, [id], nextParent);
                if (next) {
                  doc.nodes = next;
                  membershipChanged = true;
                }
              }
              // 位置 clamp 到 lane 内容区（不压标题区、不超出内容边界）
              const after = doc.nodes.find((x) => x.id === id);
              const afterParent = after?.parentId
                ? doc.nodes.find((x) => x.id === after.parentId)
                : undefined;
              if (after && afterParent?.kind === "swimlane-lane") {
                const clamped = clampPositionToLaneContent(
                  afterParent,
                  after.size ?? size,
                  after.position,
                );
                if (clamped.x !== after.position.x || clamped.y !== after.position.y) {
                  doc.nodes = doc.nodes.map((x) =>
                    x.id === id ? { ...x, position: clamped } : x,
                  );
                }
              }
            }
          }
          commitChange(doc, membershipChanged ? "semantic" : "layout");
          return current;
        });
      }
    },
    [readOnly, history.present.document, commitChange],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      setRfEdges((edges) => flowchartCanvasHelpers.applyEdgeChanges(changes, edges));
      // 删除边时同步到文档
      const removed = changes.filter((c) => c.type === "remove");
      if (removed.length > 0) {
        const doc = cloneFlowchartDocument(history.present.document);
        const removeIds = new Set(removed.map((c) => c.id));
        doc.edges = doc.edges.filter((e) => !removeIds.has(e.id));
        setSelectedEdgeIds((ids) => ids.filter((id) => !removeIds.has(id)));
        commitChange(doc, "semantic");
      }
    },
    [readOnly, history.present.document, commitChange],
  );

  const handleConnect = useCallback(
    (connection: {
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) => {
      if (readOnly) return;
      // 禁止自环
      if (connection.source === connection.target) return;
      const doc = cloneFlowchartDocument(history.present.document);
      // 禁止重复 source/target/Handle 组合（设计文档 §7.6）
      const dup = doc.edges.some(
        (e) =>
          e.source === connection.source &&
          e.target === connection.target &&
          (e.sourceHandle ?? null) === (connection.sourceHandle ?? null) &&
          (e.targetHandle ?? null) === (connection.targetHandle ?? null),
      );
      if (dup) return;
      const edge = {
        id: generateFlowchartEdgeId(),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      };
      doc.edges.push(edge);
      commitChange(doc, "semantic");
    },
    [readOnly, history.present.document, commitChange],
  );

  // 边重连：拖动边端点到新 Handle（设计文档 §7.6）
  const handleEdgeReconnect = useCallback(
    (edgeId: string, next: {
      source: string;
      target: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) => {
      if (readOnly) return;
      if (next.source === next.target) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idx = doc.edges.findIndex((e) => e.id === edgeId);
      if (idx < 0) return;
      // 禁止重复（与其它边相同 source/target/Handle）
      const dup = doc.edges.some(
        (e, i) =>
          i !== idx &&
          e.source === next.source &&
          e.target === next.target &&
          (e.sourceHandle ?? null) === (next.sourceHandle ?? null) &&
          (e.targetHandle ?? null) === (next.targetHandle ?? null),
      );
      if (dup) return;
      doc.edges[idx] = {
        ...doc.edges[idx],
        source: next.source,
        target: next.target,
        sourceHandle: next.sourceHandle,
        targetHandle: next.targetHandle,
      };
      commitChange(doc, "semantic");
    },
    [readOnly, history.present.document, commitChange],
  );

  // 边 label 编辑（设计文档 §7.6）
  const handleEdgeLabelEdit = useCallback(
    (edgeId: string, label: string) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const idx = doc.edges.findIndex((e) => e.id === edgeId);
      if (idx < 0) return;
      doc.edges[idx] = { ...doc.edges[idx], label };
      commitChange(doc, "semantic");
    },
    [readOnly, history.present.document, commitChange],
  );

  // 注：handleEdgeControlPointsChange / handleEdgeControlPointsCommit
  // 已上移至「同步 history → React Flow」useEffect 之前定义（避免 TDZ）。

  // Inspector 连线 label 修改（FC-UI-02）：作用于当前唯一选中边
  const handleInspectorEdgeLabelChange = useCallback(
    (label: string) => {
      if (selectedEdgeIds.length !== 1) return;
      handleEdgeLabelEdit(selectedEdgeIds[0], label);
    },
    [selectedEdgeIds, handleEdgeLabelEdit],
  );

  const handleSelectionChange = useCallback(
    (selection: { nodeIds: string[]; edgeIds: string[] }) => {
      setSelectedNodeIds(selection.nodeIds);
      setSelectedEdgeIds(selection.edgeIds);
    },
    [],
  );

  // 13. 申请写者租约
  const handleRequestWriteLease = useCallback(() => {
    onRequestWriteLease?.(editorInstanceId);
  }, [editorInstanceId, onRequestWriteLease]);

  // 14. 导出图片（设计文档 §7.12, §7.13）
  // PNG/SVG/PDF 统一通过 FlowchartCanvas 的 exportToPng/exportToSvg 方法生成。
  // 大图导出失败时显示明确错误，不下载空白文件。
  const handleExport = useCallback(
    async (format: "png-1x" | "png-2x" | "svg" | "pdf") => {
      if (exporting) return;
      if (!canvasRef.current) {
        setExportError("画布未就绪");
        return;
      }
      setExporting(true);
      setExportError(null);
      try {
        const baseName = sanitizeFilename(note.title || "未命名流程图");
        if (format === "png-1x") {
          const opts: FlowchartExportOptions = { scale: 1, background: "theme" };
          const dataUrl = await canvasRef.current.exportToPng(opts);
          downloadDataUrl(dataUrl, `${baseName}.png`);
        } else if (format === "png-2x") {
          const opts: FlowchartExportOptions = { scale: 2, background: "theme" };
          const dataUrl = await canvasRef.current.exportToPng(opts);
          downloadDataUrl(dataUrl, `${baseName}@2x.png`);
        } else if (format === "svg") {
          const opts: FlowchartExportOptions = { background: "theme" };
          const dataUrl = await canvasRef.current.exportToSvg(opts);
          downloadSvgString(dataUrl, `${baseName}.svg`);
        } else if (format === "pdf") {
          // PDF 导出（设计文档 §7.13）：以 SVG 为内容，通过打印窗口生成 PDF
          const opts: FlowchartExportOptions = { background: "theme" };
          const dataUrl = await canvasRef.current.exportToSvg(opts);
          printFlowchartPdf(dataUrl, baseName);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "导出失败";
        setExportError(msg);
      } finally {
        setExporting(false);
      }
    },
    [exporting, note.title],
  );

  // 导出错误自动清除
  useEffect(() => {
    if (!exportError) return;
    const timer = window.setTimeout(() => setExportError(null), 3000);
    return () => window.clearTimeout(timer);
  }, [exportError]);

  // 监听画布列表右键菜单的导出事件（仅响应当前 noteId，format 区分格式）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ noteId: string; format: string }>).detail;
      if (detail?.noteId !== note.id) return;
      const fmt = detail.format || "png-1x";
      // 仅允许流程图支持的格式
      if (fmt === "png-1x" || fmt === "png-2x" || fmt === "svg" || fmt === "pdf") {
        void handleExport(fmt);
      }
    };
    window.addEventListener("mona:canvas-export", handler);
    return () => window.removeEventListener("mona:canvas-export", handler);
  }, [note.id, handleExport]);

  // 13a. 剪贴板（内存，不写入系统剪贴板）和键盘快捷键（设计文档 §7.8）
  // 仅在画布容器聚焦时生效，不拦截应用全局快捷键。
  // 复制/剪切/粘贴/重复形成单次历史记录，粘贴时重新生成节点和边 ID 并统一偏移。
  interface FlowchartClipboard {
    nodes: FlowchartNode[];
    edges: FlowchartEdge[];
  }
  const clipboardRef = useRef<FlowchartClipboard | null>(null);

  const getSelectedSubgraph = useCallback((): FlowchartClipboard | null => {
    if (selectedNodeIds.length === 0) return null;
    const doc = history.present.document;
    const idSet = new Set(selectedNodeIds);
    const nodes = doc.nodes.filter((n) => idSet.has(n.id));
    // 同时复制选中节点之间的边（两端都在选区内）
    const edges = doc.edges.filter(
      (e) => idSet.has(e.source) && idSet.has(e.target),
    );
    if (nodes.length === 0) return null;
    return { nodes, edges };
  }, [history.present.document, selectedNodeIds]);

  const pasteSubgraph = useCallback(
    (clip: FlowchartClipboard, offset = { x: 30, y: 30 }) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      // 重新生成 ID 并应用偏移
      const idMap = new Map<string, string>();
      const newNodes: FlowchartNode[] = clip.nodes.map((n) => {
        const newId = generateFlowchartNodeId();
        idMap.set(n.id, newId);
        return {
          ...n,
          id: newId,
          position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
        };
      });
      const newEdges: FlowchartEdge[] = clip.edges
        .map((e) => {
          const source = idMap.get(e.source);
          const target = idMap.get(e.target);
          if (!source || !target) return null;
          return {
            ...e,
            id: generateFlowchartEdgeId(),
            source,
            target,
          };
        })
        .filter((e): e is FlowchartEdge => e !== null);
      doc.nodes.push(...newNodes);
      doc.edges.push(...newEdges);
      setSelectedNodeIds(newNodes.map((n) => n.id));
      setSelectedEdgeIds(newEdges.map((e) => e.id));
      commitChange(doc, "semantic");
    },
    [readOnly, history.present.document, commitChange],
  );

  // 删除统一走 requestDeleteSelected（FC-SWIM-04 安全删除确认）；
  // React Flow 内置 deleteKeyCode 已禁用，Delete/Backspace 由上方键盘监听处理。

  // 右键菜单：复制/剪切/粘贴/删除（依赖 clipboard，需在 getSelectedSubgraph/pasteSubgraph 之后定义）
  const handleMenuCopy = useCallback(() => {
    const clip = getSelectedSubgraph();
    if (clip) clipboardRef.current = clip;
    setMenuCtx(null);
  }, [getSelectedSubgraph]);

  const handleMenuCut = useCallback(() => {
    const clip = getSelectedSubgraph();
    if (clip) {
      clipboardRef.current = clip;
      requestDeleteSelected();
    }
    setMenuCtx(null);
  }, [getSelectedSubgraph, requestDeleteSelected]);

  const handleMenuPaste = useCallback(() => {
    if (clipboardRef.current) {
      pasteSubgraph(clipboardRef.current);
    }
    setMenuCtx(null);
  }, [pasteSubgraph]);

  const handleMenuDelete = useCallback(() => {
    requestDeleteSelected();
    setMenuCtx(null);
  }, [requestDeleteSelected]);

  // 右键菜单：组合/取消组合/层级（FC-GROUP-01 / FC-LAYER-01）
  const handleMenuGroup = useCallback(() => {
    handleGroup();
    setMenuCtx(null);
  }, [handleGroup]);

  const handleMenuUngroup = useCallback(() => {
    handleUngroup();
    setMenuCtx(null);
  }, [handleUngroup]);

  const handleMenuReorder = useCallback(
    (action: FlowchartLayerAction) => {
      handleReorder(action);
      setMenuCtx(null);
    },
    [handleReorder],
  );

  // 13b. 键盘事件监听
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // 在输入框、textarea 中不拦截
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      const meta = e.ctrlKey || e.metaKey;
      // 撤销
      if (meta && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleUndo();
        return;
      }
      // 重做
      if (meta && e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        handleRedo();
        return;
      }
      // 复制
      if (meta && (e.key === "c" || e.key === "C") && !e.shiftKey) {
        const clip = getSelectedSubgraph();
        if (clip) {
          clipboardRef.current = clip;
          e.preventDefault();
        }
        return;
      }
      // 剪切
      if (meta && (e.key === "x" || e.key === "X") && !e.shiftKey) {
        const clip = getSelectedSubgraph();
        if (clip) {
          clipboardRef.current = clip;
          // 删除选中节点（含关联边；非空泳池/泳道走安全删除确认）
          requestDeleteSelected();
          e.preventDefault();
        }
        return;
      }
      // 删除（FC-SWIM-04）：统一走安全删除入口（React Flow 内置 deleteKeyCode 已禁用）
      if (!meta && (e.key === "Delete" || e.key === "Backspace")) {
        requestDeleteSelected();
        e.preventDefault();
        return;
      }
      // 粘贴
      if (meta && (e.key === "v" || e.key === "V") && !e.shiftKey) {
        if (clipboardRef.current) {
          pasteSubgraph(clipboardRef.current);
          e.preventDefault();
        }
        return;
      }
      // 重复（Ctrl+D）
      if (meta && (e.key === "d" || e.key === "D") && !e.shiftKey) {
        const clip = getSelectedSubgraph();
        if (clip) {
          pasteSubgraph(clip, { x: 20, y: 20 });
          e.preventDefault();
        }
        return;
      }
      // 全选（Ctrl+A）
      if (meta && (e.key === "a" || e.key === "A") && !e.shiftKey) {
        canvasRef.current?.selectAll();
        e.preventDefault();
        return;
      }
      // 组合（Ctrl+G）/ 取消组合（Ctrl+Shift+G）（FC-GROUP-01）
      if (meta && (e.key === "g" || e.key === "G")) {
        if (e.shiftKey) {
          if (canUngroup) {
            handleUngroup();
            e.preventDefault();
          }
        } else if (canGroup) {
          handleGroup();
          e.preventDefault();
        }
        return;
      }
      // 层级（FC-LAYER-01）：Ctrl+] 上移一层，Ctrl+[ 下移一层；加 Shift 置顶/置底
      if (meta && (e.key === "]" || e.key === "}")) {
        if (selectedNodeIds.length > 0) {
          handleReorder(e.shiftKey ? "front" : "forward");
          e.preventDefault();
        }
        return;
      }
      if (meta && (e.key === "[" || e.key === "{")) {
        if (selectedNodeIds.length > 0) {
          handleReorder(e.shiftKey ? "back" : "backward");
          e.preventDefault();
        }
        return;
      }
      // Tab 循环选择（FC-LAYER-01）：在重叠对象中按文档顺序循环选中
      // 仅当焦点在画布（.react-flow）或 body 上时拦截，避免劫持工具栏/面板的 Tab 导航
      if (!meta && e.key === "Tab") {
        const nodes = history.present.document.nodes;
        if (nodes.length === 0) return;
        const inCanvas =
          !target || target === document.body || !!target.closest?.(".react-flow");
        if (!inCanvas) return;
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        const curIdx = nodes.findIndex((n) => n.id === selectedNodeIds[0]);
        const nextIdx =
          curIdx < 0
            ? dir > 0
              ? 0
              : nodes.length - 1
            : (curIdx + dir + nodes.length) % nodes.length;
        setSelectedNodeIds([nodes[nextIdx].id]);
        setSelectedEdgeIds([]);
        return;
      }
      // 方向键微移（FC-ARRANGE-01）：吸附开启时步长跟随网格大小，Shift 大步；
      // 吸附关闭时 1px 精调、Shift 10px。连续微移合并为一个撤销单元。
      if (
        !meta &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        if (selectedNodeIds.length === 0) return;
        const gridSize = history.present.document.canvas.grid.size;
        const baseStep = snapToGrid ? gridSize : 1;
        const step = e.shiftKey ? (snapToGrid ? gridSize * 5 : 10) : baseStep;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const nextNodes = nudgeNodes(history.present.document.nodes, selectedNodeIds, dx, dy);
        if (nextNodes) {
          e.preventDefault();
          const doc = cloneFlowchartDocument(history.present.document);
          doc.nodes = nextNodes;
          commitChange(doc, "layout", `nudge:${selectedNodeIds.join(",")}`);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly, handleUndo, handleRedo, getSelectedSubgraph, requestDeleteSelected, pasteSubgraph, selectedNodeIds, snapToGrid, history.present.document, commitChange, canGroup, canUngroup, handleGroup, handleUngroup, handleReorder]);

  // 14. 错误视图
  if (!parsed.ok) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Workflow className="h-10 w-10 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">流程图文件解析失败</div>
        <div className="max-w-md text-xs text-muted-foreground">{parsed.message}</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const blank = emptyDoc();
            setHistory(makeInitialHistory(blank));
            setParseError(null);
            const md = serializeFlowchartMarkdown(note.title || "未命名流程图", blank);
            lastSyncedMdRef.current = md;
            onContentChange({
              contentMarkdown: md,
              plainText: buildFlowchartPlainText(note.title || "未命名流程图", blank),
            });
          }}
        >
          重置为空白流程图
        </Button>
      </div>
    );
  }
  if (parseError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Workflow className="h-10 w-10 text-muted-foreground" />
        <div className="text-sm font-medium text-foreground">流程图文件解析失败</div>
        <div className="max-w-md text-xs text-muted-foreground">{parseError}</div>
      </div>
    );
  }

  // 15. 主视图
  const hasNodeSelection = selectedNodeIds.length > 0;
  const hasEdgeSelection = selectedEdgeIds.length > 0;
  // 当前选中节点中第一个的样式（用于工具栏回显）
  const firstSelectedNode = hasNodeSelection
    ? history.present.document.nodes.find((n) => n.id === selectedNodeIds[0])
    : null;
  const firstSelectedEdge = hasEdgeSelection
    ? history.present.document.edges.find((e) => e.id === selectedEdgeIds[0])
    : null;

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
        {toolbarLeading ? (
          <>
            {toolbarLeading}
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        ) : null}

        {/* 撤销/重做 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleUndo}
              disabled={readOnly || history.past.length === 0}
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">撤销 (Ctrl+Z)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRedo}
              disabled={readOnly || history.future.length === 0}
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">重做 (Ctrl+Shift+Z)</TooltipContent>
        </Tooltip>

        {/* 选中节点/边时的操作区（替代原浮动选择工具栏） */}
        {(hasNodeSelection || hasEdgeSelection) && !readOnly && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />

            {/* 对齐（选中 ≥2 节点时） */}
            {selectedNodeIds.length >= 2 && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("left")}>
                      <AlignStartVertical className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">左对齐</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("center-h")}>
                      <AlignCenterVertical className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">水平居中</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("right")}>
                      <AlignEndVertical className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">右对齐</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("top")}>
                      <AlignStartHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">顶对齐</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("center-v")}>
                      <AlignCenterHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">垂直居中</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyAlignment("bottom")}>
                      <AlignEndHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">底对齐</TooltipContent>
                </Tooltip>
                {selectedNodeIds.length >= 3 && (
                  <>
                    <div className="mx-0.5 h-4 w-px bg-border" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyDistribution("horizontal")}>
                          <AlignCenterHorizontal className="h-3 w-3 rotate-90" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">水平分布</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => applyDistribution("vertical")}>
                          <AlignCenterVertical className="h-3 w-3 rotate-90" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">垂直分布</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </>
            )}

            {/* 节点格式化 */}
            {hasNodeSelection && (
              <>
                {selectedNodeIds.length >= 2 && <div className="mx-0.5 h-4 w-px bg-border" />}
                <NodeFormatToolbar
                  style={firstSelectedNode?.style}
                  onChange={applyNodeStyle}
                  disabled={readOnly}
                />
              </>
            )}

            {/* 边格式化 */}
            {hasEdgeSelection && (
              <>
                {(selectedNodeIds.length >= 2 || hasNodeSelection) && (
                  <div className="mx-0.5 h-4 w-px bg-border" />
                )}
                <EdgeFormatToolbar
                  style={firstSelectedEdge?.style}
                  onChange={applyEdgeStyle}
                  disabled={readOnly}
                />
              </>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {toolbarExtra}
          {/* 属性面板开关（FC-UI-01） */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-7 w-7", inspectorOpen && "bg-accent")}
                aria-label="属性面板"
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen((v) => !v)}
              >
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">属性面板</TooltipContent>
          </Tooltip>
          {/* 导出菜单（设计文档 §7.12, §7.13） */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    disabled={exporting || history.present.document.nodes.length === 0}
                  >
                    {exporting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">导出流程图</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => handleExport("png-1x")}>
                <ImageIcon className="mr-2 h-3.5 w-3.5" />
                PNG（标准）
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport("png-2x")}>
                <ImageIcon className="mr-2 h-3.5 w-3.5" />
                PNG（高清 2x）
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport("svg")}>
                <FileImage className="mr-2 h-3.5 w-3.5" />
                SVG（矢量）
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleExport("pdf")}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                PDF（打印）
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {exportError && (
            <span className="text-xs text-destructive">{exportError}</span>
          )}
          {!isWriter && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleRequestWriteLease}
                >
                  在此编辑
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">另一个标签页正在编辑此流程图</TooltipContent>
            </Tooltip>
          )}
          {!isWriter && (
            <span className="text-xs text-muted-foreground">
              此流程图正在另一个标签页编辑
            </span>
          )}
        </div>
      </div>

      {/* 非写者提示条 */}
      {!isWriter && (
        <div className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          当前为只读模式，点击"在此编辑"接管编辑权
        </div>
      )}

      {/* 主体：画布（浮动工具栏覆盖在画布上方）+ 右侧属性面板（FC-UI-01） */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
        <FlowchartCanvas
          ref={canvasRef}
          noteId={note.id}
          nodes={history.present.document.nodes}
          edges={history.present.document.edges}
          direction={history.present.document.direction}
          readOnly={readOnly}
          themeDefaults={themeDefaults}
          canvasSettings={history.present.document.canvas}
          initialViewport={
            history.present.document.viewport &&
            (history.present.document.viewport.x !== 0 ||
              history.present.document.viewport.y !== 0 ||
              history.present.document.viewport.zoom !== 1)
              ? history.present.document.viewport
              : null
          }
          internalNodes={rfNodes}
          internalEdges={rfEdges}
          onInternalNodesChange={handleNodesChange}
          onInternalEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onReconnect={handleEdgeReconnect}
          onEdgeControlPointsChange={handleEdgeControlPointsChange}
          onEdgeControlPointsCommit={handleEdgeControlPointsCommit}
          onEdgeLabelEdit={handleEdgeLabelEdit}
          onViewportChange={handleViewportChange}
          onSelectionChange={handleSelectionChange}
          onNodeLabelEdit={handleNodeLabelEdit}
          onDropShape={handleDropShape}
          onContextMenu={handleContextMenu}
          onCreateNodeWithConnection={handleCreateNodeWithConnection}
          activeTool={activeTool}
          onFreehandComplete={handleFreehandComplete}
          onEraseFreehand={handleEraseFreehand}
          showGrid={showGrid}
          onShowGridChange={handleShowGridChange}
          snapToGrid={snapToGrid}
          onSnapToGridChange={handleSnapToGridChange}
          onAutoLayout={handleAutoLayout}
        />
        {/* 浮动工具栏：覆盖在画布左侧（参考 NoteGen canvas-tools-sidebar） */}
        <FlowchartShapePanel
          onAddShape={handleAddNode}
          onAddImage={handleAddImage}
          readOnly={readOnly}
          activeTool={activeTool}
          onToolChange={setActiveTool}
          theme={history.present.document.theme}
          manualStyleNodeCount={manualStyleNodeCount}
          onApplyTheme={handleApplyTheme}
        />
        {/* 操作提示（FC-SWIM-01 等）：画布底部居中浮动，3s 自动消失 */}
        {actionNotice && (
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 shadow-sm dark:text-amber-400"
          >
            {actionNotice}
          </div>
        )}
        {/* 安全删除确认（FC-SWIM-04）：非空泳池/泳道删除前选择内容处理方式 */}
        <FlowchartSafeDeleteDialog
          open={safeDeleteTargets !== null}
          pools={safeDeleteTargets?.pools ?? []}
          lanes={safeDeleteTargets?.lanes ?? []}
          onConfirm={handleConfirmSafeDelete}
          onCancel={() => setSafeDeleteTargets(null)}
        />
          {/* 右键菜单：根据上下文（节点/边/画布）渲染不同选项 */}
          {menuCtx && (
            <FlowchartContextMenu
              ctx={menuCtx}
              hasClipboard={clipboardRef.current !== null}
              canPaste={!readOnly}
              canGroup={canGroup}
              canUngroup={canUngroup}
              onClose={() => setMenuCtx(null)}
              onCopy={handleMenuCopy}
              onCut={handleMenuCut}
              onPaste={handleMenuPaste}
              onDelete={handleMenuDelete}
              onConvertNodeKind={handleConvertNodeKind}
              onReverseEdge={handleReverseEdge}
              onAddNodeAt={handleMenuAddNodeAt}
              onSelectAll={handleSelectAll}
              onGroup={handleMenuGroup}
              onUngroup={handleMenuUngroup}
              onReorder={handleMenuReorder}
            />
          )}
        </div>
        {/* 右侧属性面板（FC-UI-02）：与工具栏修改同一中心文档 */}
        {inspectorOpen && (
          <FlowchartInspector
            document={history.present.document}
            selectedNodeIds={selectedNodeIds}
            selectedEdgeIds={selectedEdgeIds}
            readOnly={readOnly}
            onClose={() => setInspectorOpen(false)}
            onCanvasSettingsChange={handleCanvasSettingsChange}
            onNodeGeometryChange={handleNodeGeometryChange}
            onNodeStyleChange={applyNodeStyle}
            onEdgeLabelChange={handleInspectorEdgeLabelChange}
            onEdgeStyleChange={applyEdgeStyle}
            onAlign={applyAlignment}
            onDistribute={applyDistribution}
            onMatchSize={handleMatchSize}
            onGroup={handleGroup}
            onUngroup={handleUngroup}
            onReorder={handleReorder}
            canGroup={canGroup}
            canUngroup={canUngroup}
          />
        )}
      </div>

      {/* 底部 footer：网格 / 吸附 / 自动布局 / 缩放 / 适应视图
          参考 NoteGen canvas-footer.tsx，替代原 ReactFlow <Controls> 浮动按钮 */}
      <FlowchartFooter
        zoom={zoom}
        onZoomChange={handleZoomChange}
        onFitView={handleFitView}
        showGrid={showGrid}
        onShowGridChange={handleShowGridChange}
        snapToGrid={snapToGrid}
        onSnapToGridChange={handleSnapToGridChange}
        onAutoLayout={handleAutoLayout}
        readOnly={readOnly}
      />
    </div>
    </TooltipProvider>
  );
}

function emptyDoc(): FlowchartDocument {
  return {
    version: FLOWCHART_DOCUMENT_VERSION,
    direction: "TB",
    canvas: {
      ...DEFAULT_FLOWCHART_CANVAS,
      grid: { ...DEFAULT_FLOWCHART_CANVAS.grid },
    },
    theme: { ...DEFAULT_FLOWCHART_THEME },
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// ---------------------------------------------------------------------------
// 格式化工具栏：节点样式（字体、字号、字色、填充色、边框色、边框宽度、边框样式、加粗、斜体）
// ---------------------------------------------------------------------------

/**
 * 工具栏下拉菜单：DropdownMenu + Tooltip 组合。
 * Tooltip 通过嵌套 asChild 挂到 trigger Button 上，hover 显示，click 打开菜单。
 * 避免 title 原生 tooltip 与项目 Tooltip 规范冲突（ui-spec.md 浮层组件规范）。
 */
function ToolbarDropdown({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: React.ReactElement;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {trigger}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      {children}
    </DropdownMenu>
  );
}

interface NodeFormatToolbarProps {
  style: FlowchartNodeStyle | undefined;
  onChange: (patch: Partial<FlowchartNodeStyle>) => void;
  disabled?: boolean;
}

function NodeFormatToolbar({ style, onChange, disabled }: NodeFormatToolbarProps) {
  const s = style;
  return (
    <div className="flex items-center gap-1">
      {/* 字体 */}
      <ToolbarDropdown
        label="字体"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {FONT_FAMILY_OPTIONS.find((o) => o.value === (s?.fontFamily ?? ""))?.label ?? "默认"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-32">
          <DropdownMenuRadioGroup
            value={s?.fontFamily ?? ""}
            onValueChange={(v) => onChange({ fontFamily: v || undefined })}
          >
            {FONT_FAMILY_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 字号 */}
      <ToolbarDropdown
        label="字号"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.fontSize ?? 13}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-20">
          <DropdownMenuRadioGroup
            value={String(s?.fontSize ?? 13)}
            onValueChange={(v) => onChange({ fontSize: Number(v) || undefined })}
          >
            {FONT_SIZE_OPTIONS.map((size) => (
              <DropdownMenuRadioItem key={size} value={String(size)}>
                {size}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 字色 */}
      <ColorPicker
        value={s?.color}
        title="字色"
        mode="text"
        onChange={(color) => onChange({ color })}
      />

      {/* 填充色 */}
      <ColorPicker
        value={s?.fill}
        title="填充色"
        mode="fill"
        onChange={(color) => onChange({ fill: color })}
      />

      {/* 边框色 */}
      <ColorPicker
        value={s?.borderColor}
        title="边框色"
        mode="stroke"
        onChange={(color) => onChange({ borderColor: color })}
      />

      {/* 边框宽度 */}
      <ToolbarDropdown
        label="边框宽度"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.borderWidth ?? 1.5}px
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-20">
          <DropdownMenuRadioGroup
            value={String(s?.borderWidth ?? 1.5)}
            onValueChange={(v) => onChange({ borderWidth: Number(v) || undefined })}
          >
            {STROKE_WIDTH_OPTIONS.map((w) => (
              <DropdownMenuRadioItem key={w} value={String(w)}>
                {w}px
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 边框样式 */}
      <ToolbarDropdown
        label="边框样式"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.borderStyle === "dashed" ? "虚线" : s?.borderStyle === "dotted" ? "点线" : "实线"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-24">
          <DropdownMenuRadioGroup
            value={s?.borderStyle ?? "solid"}
            onValueChange={(v) =>
              onChange({ borderStyle: v as FlowchartNodeStyle["borderStyle"] })
            }
          >
            <DropdownMenuRadioItem value="solid">实线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dashed">虚线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dotted">点线</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 加粗 / 斜体 / 下划线 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 text-[11px] font-bold ${s?.bold ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            disabled={disabled}
            onClick={() => onChange({ bold: !s?.bold })}
          >
            B
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">加粗</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 text-[11px] italic ${s?.italic ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            disabled={disabled}
            onClick={() => onChange({ italic: !s?.italic })}
          >
            I
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">斜体</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 text-[11px] underline ${s?.underline ? "bg-accent text-foreground" : "text-muted-foreground"}`}
            disabled={disabled}
            onClick={() => onChange({ underline: !s?.underline })}
          >
            U
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">下划线</TooltipContent>
      </Tooltip>

      {/* 文字对齐 */}
      <div className="ml-1 flex items-center gap-0.5 border-l border-border/50 pl-1">
        {([
          { align: "left", icon: AlignLeft, label: "左对齐" },
          { align: "center", icon: AlignCenter, label: "居中" },
          { align: "right", icon: AlignRight, label: "右对齐" },
        ] as const).map(({ align, icon: Icon, label }) => (
          <Tooltip key={align}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-7 w-7 ${(s?.textAlign ?? "center") === align ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                disabled={disabled}
                onClick={() => onChange({ textAlign: align })}
              >
                <Icon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{`文字${label}`}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 格式化工具栏：边样式（线条颜色、线条宽度、线条样式）
// ---------------------------------------------------------------------------

interface EdgeFormatToolbarProps {
  style: FlowchartEdgeStyle | undefined;
  onChange: (patch: Partial<FlowchartEdgeStyle>) => void;
  disabled?: boolean;
}

function EdgeFormatToolbar({ style, onChange, disabled }: EdgeFormatToolbarProps) {
  const s = style;
  return (
    <div className="flex items-center gap-1">
      {/* 线条颜色 */}
      <ColorPicker
        value={s?.stroke}
        title="线条颜色"
        mode="line"
        onChange={(color) => onChange({ stroke: color })}
      />

      {/* 线条宽度 */}
      <ToolbarDropdown
        label="线条宽度"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.strokeWidth ?? 1.5}px
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-20">
          <DropdownMenuRadioGroup
            value={String(s?.strokeWidth ?? 1.5)}
            onValueChange={(v) => onChange({ strokeWidth: Number(v) || undefined })}
          >
            {STROKE_WIDTH_OPTIONS.map((w) => (
              <DropdownMenuRadioItem key={w} value={String(w)}>
                {w}px
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 线条样式 */}
      <ToolbarDropdown
        label="线条样式"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.strokeDasharray === "dashed" ? "虚线" : s?.strokeDasharray === "dotted" ? "点线" : "实线"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-24">
          <DropdownMenuRadioGroup
            value={s?.strokeDasharray ?? "solid"}
            onValueChange={(v) =>
              onChange({ strokeDasharray: v as FlowchartEdgeStyle["strokeDasharray"] })
            }
          >
            <DropdownMenuRadioItem value="solid">实线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dashed">虚线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dotted">点线</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* 连接类型 */}
      <ToolbarDropdown
        label="连接类型"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.route === "bezier" ? "曲线" : s?.route === "straight" ? "直线" : "折线"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-24">
          <DropdownMenuRadioGroup
            value={s?.route ?? "smoothstep"}
            onValueChange={(v) =>
              onChange({ route: v as FlowchartEdgeStyle["route"] })
            }
          >
            <DropdownMenuRadioItem value="smoothstep">折线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="straight">直线</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="bezier">曲线</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 起点箭头 */}
      <ToolbarDropdown
        label="起点样式"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.markerStart === "arrow" ? "起点箭头" : s?.markerStart === "arrowclosed" ? "起点实心" : "起点无"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-28">
          <DropdownMenuRadioGroup
            value={s?.markerStart ?? "none"}
            onValueChange={(v) =>
              onChange({ markerStart: v as FlowchartEdgeStyle["markerStart"] })
            }
          >
            <DropdownMenuRadioItem value="none">起点无</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="arrow">起点箭头</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="arrowclosed">起点实心</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>

      {/* 终点箭头 */}
      <ToolbarDropdown
        label="终点样式"
        trigger={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={disabled}>
            {s?.markerEnd === "none" ? "终点无" : s?.markerEnd === "arrow" ? "终点箭头" : "终点实心"}
          </Button>
        }
      >
        <DropdownMenuContent align="start" className="w-28">
          <DropdownMenuRadioGroup
            value={s?.markerEnd ?? "arrowclosed"}
            onValueChange={(v) =>
              onChange({ markerEnd: v as FlowchartEdgeStyle["markerEnd"] })
            }
          >
            <DropdownMenuRadioItem value="none">终点无</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="arrow">终点箭头</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="arrowclosed">终点实心</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </ToolbarDropdown>
    </div>
  );
}

/** 预设颜色（字色/描边使用深色，填充使用浅色） */
const FILL_PRESETS = ["#ffffff", "#f1f5f9", "#dbeafe", "#ede9fe", "#dcfce7", "#ffedd5"];
const STROKE_PRESETS = ["#64748b", "#3b82f6", "#8b5cf6", "#22c55e", "#f59e0b", "#ef4444"];

/**
 * 颜色选择器：触发器用语义化图标表达配置对象，无需 hover tooltip 即可识别。
 * - text   模式：字母 "A"，字母颜色 = 当前字色
 * - fill   模式：实心方框，方框背景 = 当前填充色
 * - stroke 模式：空心方框，方框描边 = 当前边框色
 * - line   模式：斜线段，线条颜色 = 当前线条色（用于 edge）
 * 透明时统一显示中性灰，仍保留图标轮廓语义。
 */
function ColorPicker({
  value,
  title,
  onChange,
  mode = "fill",
}: {
  value: string | undefined;
  title: string;
  onChange: (color: string | undefined) => void;
  mode?: "fill" | "stroke" | "text" | "line";
}) {
  // 字色/边框色/线条色用深色预设，填充色用浅色预设
  const presets = mode === "fill" ? FILL_PRESETS : STROKE_PRESETS;
  const [customColor, setCustomColor] = useState(value ?? presets[1] ?? "#3b82f6");
  const isTransparent = !value || value === "transparent";
  const dimColor = "hsl(var(--muted-foreground) / 0.5)";

  // 触发器内部图标：根据 mode 渲染不同形状，图标本身颜色 = 当前选中色
  const renderTriggerIcon = () => {
    if (mode === "text") {
      return (
        <span
          className="text-[14px] font-bold leading-none"
          style={{ color: isTransparent ? dimColor : value }}
        >
          A
        </span>
      );
    }
    if (mode === "fill") {
      return (
        <div
          className="h-4 w-4 rounded-md border border-black/10"
          style={{
            backgroundColor: isTransparent ? undefined : value,
            backgroundImage: isTransparent
              ? "linear-gradient(45deg, hsl(var(--muted-foreground) / 0.35) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted-foreground) / 0.35) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted-foreground) / 0.35) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted-foreground) / 0.35) 75%)"
              : undefined,
            backgroundSize: isTransparent ? "6px 6px" : undefined,
            backgroundPosition: isTransparent ? "0 0, 0 3px, 3px -3px, -3px 0" : undefined,
          }}
        />
      );
    }
    if (mode === "line") {
      // 斜线段：SVG 渲染，stroke 颜色 = value
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3 13L13 3"
            stroke={isTransparent ? dimColor : value}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      );
    }
    // stroke 模式：空心方框，描边颜色 = value
    return (
      <div
        className="h-4 w-4 rounded-md"
        style={{
          backgroundColor: "transparent",
          border: `2px solid ${isTransparent ? dimColor : value}`,
        }}
      />
    );
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={title}
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-accent"
            >
              {renderTriggerIcon()}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{title}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-auto p-2">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
        <div className="grid grid-cols-4 gap-1.5">
          {/* 透明 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(undefined)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm",
                  isTransparent && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                )}
              >
                <Ban className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">透明</TooltipContent>
          </Tooltip>
          {presets.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              onClick={() => onChange(color)}
              className={cn(
                "h-7 w-7 rounded-full border border-border/60 shadow-sm",
                value === color && "ring-2 ring-ring ring-offset-1 ring-offset-background",
              )}
              style={{ backgroundColor: color }}
            />
          ))}
          {/* 彩虹取色器 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <label
                className={cn(
                  "relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border/60 shadow-sm",
                  "bg-[conic-gradient(#ef4444,#f59e0b,#22c55e,#3b82f6,#8b5cf6,#ef4444)]",
                  value && value !== "transparent" && !presets.includes(value) && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                )}
              >
                <Palette className="relative h-3.5 w-3.5 text-white drop-shadow-sm" />
                <input
                  type="color"
                  value={customColor}
                  aria-label="自定义颜色"
                  onChange={(e) => {
                    setCustomColor(e.target.value);
                    onChange(e.target.value);
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                />
              </label>
            </TooltipTrigger>
            <TooltipContent side="bottom">自定义颜色</TooltipContent>
          </Tooltip>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 暴露给外部（NotesView / NoteAgentPanel）的工具
export { generateEditorInstanceId };
export type { FlowchartDirection };

/** 通过隐藏的 <input type="file"> 在浏览器环境选择图片文件 */
function selectImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      resolve(file);
      input.remove();
    };
    input.oncancel = () => {
      resolve(null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// 右键菜单组件：根据上下文（节点/边/画布）渲染不同选项
// ---------------------------------------------------------------------------

interface FlowchartContextMenuProps {
  ctx: FlowchartContextMenuContext;
  hasClipboard: boolean;
  canPaste: boolean;
  canGroup: boolean;
  canUngroup: boolean;
  onClose: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onConvertNodeKind: (kind: FlowchartNodeKind) => void;
  onReverseEdge: (edgeId: string) => void;
  onAddNodeAt: (kind: FlowchartNodeKind) => void;
  onSelectAll: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onReorder: (action: FlowchartLayerAction) => void;
}

const LAYER_MENU_OPTIONS: Array<{ action: FlowchartLayerAction; label: string; shortcut: string }> = [
  { action: "front", label: "置顶", shortcut: "Ctrl+Shift+]" },
  { action: "forward", label: "上移一层", shortcut: "Ctrl+]" },
  { action: "backward", label: "下移一层", shortcut: "Ctrl+[" },
  { action: "back", label: "置底", shortcut: "Ctrl+Shift+[" },
];

function FlowchartContextMenu({
  ctx,
  hasClipboard,
  canPaste,
  canGroup,
  canUngroup,
  onClose,
  onCopy,
  onCut,
  onPaste,
  onDelete,
  onConvertNodeKind,
  onReverseEdge,
  onAddNodeAt,
  onSelectAll,
  onGroup,
  onUngroup,
  onReorder,
}: FlowchartContextMenuProps) {
  const [subOpen, setSubOpen] = useState<"convert" | "add" | "layer" | null>(null);
  // 点击遮罩关闭菜单
  useEffect(() => {
    const onDocClick = () => onClose();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (subOpen) setSubOpen(null);
        else onClose();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose, subOpen]);

  // 计算菜单位置：避免溢出窗口
  const menuWidth = 200;
  const menuHeight = 360;
  const left = Math.min(ctx.x, window.innerWidth - menuWidth - 8);
  const top = Math.min(ctx.y, window.innerHeight - menuHeight - 8);

  return (
    <div
      className="fixed z-50 min-w-[180px] rounded-md border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-80"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ctx.kind === "node" && (
        <>
          <MenuIconItem icon={Copy} label="复制" shortcut="Ctrl+C" onClick={onCopy} />
          <MenuIconItem icon={Scissors} label="剪切" shortcut="Ctrl+X" onClick={onCut} />
          <MenuSeparator />
          <MenuIconItem
            icon={Group}
            label="组合"
            shortcut="Ctrl+G"
            onClick={onGroup}
            disabled={!canGroup}
          />
          <MenuIconItem
            icon={Ungroup}
            label="取消组合"
            shortcut="Ctrl+Shift+G"
            onClick={onUngroup}
            disabled={!canUngroup}
          />
          <MenuIconItem
            icon={Layers}
            label="层级"
            expanded={subOpen === "layer"}
            onToggle={() => setSubOpen(subOpen === "layer" ? null : "layer")}
          />
          {subOpen === "layer" && (
            <div className="rounded-sm">
              {LAYER_MENU_OPTIONS.map((opt) => (
                <button
                  key={opt.action}
                  type="button"
                  onClick={() => onReorder(opt.action)}
                  className="flex w-full cursor-pointer items-center rounded-sm px-3 py-1 text-left text-[12px] outline-none hover:bg-accent"
                >
                  <span className="flex-1">{opt.label}</span>
                  <span className="text-[10px] text-muted-foreground">{opt.shortcut}</span>
                </button>
              ))}
            </div>
          )}
          <MenuSeparator />
          <MenuIconItem
            icon={Pencil}
            label="转换为"
            expanded={subOpen === "convert"}
            onToggle={() => setSubOpen(subOpen === "convert" ? null : "convert")}
          />
          {subOpen === "convert" && (
            <div className="max-h-56 overflow-y-auto rounded-sm scrollbar-thin">
              {NODE_KIND_CONVERT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onConvertNodeKind(opt.value)}
                  className="block w-full cursor-pointer rounded-sm px-3 py-1 text-left text-[12px] outline-none hover:bg-accent"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <MenuSeparator />
          <MenuIconItem icon={Trash2} label="删除" shortcut="Delete" onClick={onDelete} destructive />
        </>
      )}

      {ctx.kind === "edge" && (
        <>
          <MenuIconItem
            icon={ArrowUpFromLine}
            label="反转方向"
            onClick={() => onReverseEdge(ctx.edgeId)}
          />
          <MenuSeparator />
          <MenuIconItem icon={Trash2} label="删除" shortcut="Delete" onClick={onDelete} destructive />
        </>
      )}

      {ctx.kind === "pane" && (
        <>
          <MenuIconItem
            icon={Copy}
            label="粘贴"
            shortcut="Ctrl+V"
            onClick={onPaste}
            disabled={!canPaste || !hasClipboard}
          />
          <MenuSeparator />
          <MenuIconItem
            icon={Pencil}
            label="新建节点"
            expanded={subOpen === "add"}
            onToggle={() => setSubOpen(subOpen === "add" ? null : "add")}
          />
          {subOpen === "add" && (
            <div className="max-h-56 overflow-y-auto rounded-sm scrollbar-thin">
              {NODE_KIND_CONVERT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onAddNodeAt(opt.value)}
                  className="block w-full cursor-pointer rounded-sm px-3 py-1 text-left text-[12px] outline-none hover:bg-accent"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <MenuSeparator />
          <MenuIconItem icon={Workflow} label="全选" shortcut="Ctrl+A" onClick={onSelectAll} />
        </>
      )}
    </div>
  );
}

function MenuIconItem({
  icon: Icon,
  label,
  shortcut,
  onClick,
  destructive,
  disabled,
  expanded,
  onToggle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (onToggle) onToggle();
        else onClick?.();
      }}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${
        destructive ? "text-destructive hover:bg-destructive/10" : ""
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">{label}</span>
      {expanded !== undefined && (
        <span className="text-[10px] text-muted-foreground">{expanded ? "▼" : "▶"}</span>
      )}
      {shortcut && expanded === undefined && (
        <span className="text-[10px] text-muted-foreground">{shortcut}</span>
      )}
    </button>
  );
}

function MenuSeparator() {
  return <div className="my-1 h-px bg-border/60" />;
}
