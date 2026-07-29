/**
 * 流程图文档编辑器：工具栏、历史、文档同步、错误视图和单写者租约。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §8.1, §8.2, §8.5
 *
 * 主要职责：
 * 1. 解析 note.contentMarkdown 为 FlowchartDocument，失败时显示错误视图；
 * 2. 提供工具栏：撤销/重做、添加节点、删除、切换方向、适应画布、重新布局；
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
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowUpFromLine,
  Download,
  FileImage,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Redo2,
  Trash2,
  Undo2,
  Workflow,
} from "lucide-react";
import type { Edge, Node, NodeChange, EdgeChange } from "@xyflow/react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { OperationNote } from "../notes-data";
import {
  buildFlowchartPlainText,
  cloneFlowchartDocument,
  collectFlowchartSemanticWarnings,
  computeFlowchartSemanticHash,
  generateFlowchartEdgeId,
  generateFlowchartNodeId,
  parseFlowchartMarkdown,
  serializeFlowchartMarkdown,
  validateFlowchartDocument,
  type FlowchartDirection,
  type FlowchartDocument,
  type FlowchartEdge,
  type FlowchartEdgeStyle,
  type FlowchartNode,
  type FlowchartNodeKind,
  type FlowchartNodeStyle,
  type FlowchartSemanticWarning,
  type FlowchartViewport,
} from "./flowchart-document";
import { layoutEntireGraph } from "./flowchart-patch";
import {
  flowchartCanvasHelpers,
  FlowchartCanvas,
  type FlowchartCanvasHandle,
  type FlowchartExportOptions,
} from "./FlowchartCanvas";
import { FlowchartShapePanel } from "./FlowchartShapePanel";
import { FlowchartIssuesPanel } from "./FlowchartIssuesPanel";
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
  /** 用户点击"让 AI 修复"时触发，把当前本地 warnings 交给父组件（设计文档 §7.9） */
  onFixWithAI?: (warnings: FlowchartSemanticWarning[]) => void;
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
  onFixWithAI,
}: FlowchartDocumentEditorProps) {
  const editorInstanceId = useMemo(generateEditorInstanceId, []);
  const { setSelection, updateBaseHash } = useFlowchartSelection();
  const canvasRef = useRef<FlowchartCanvasHandle | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

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
  const [rfNodes, setRfNodes] = useState<Node[]>(() =>
    parsed.ok ? parsed.document.nodes.map((n) => flowchartCanvasHelpers.toFlowNode(n, parsed.document.direction, readOnly)) : [],
  );
  const [rfEdges, setRfEdges] = useState<Edge[]>(() =>
    parsed.ok ? parsed.document.edges.map(flowchartCanvasHelpers.toFlowEdge) : [],
  );

  // 同步 history → React Flow
  useEffect(() => {
    const doc = history.present.document;
    setRfNodes(doc.nodes.map((n) => flowchartCanvasHelpers.toFlowNode(n, doc.direction, readOnly)));
    setRfEdges(doc.edges.map(flowchartCanvasHelpers.toFlowEdge));
  }, [history, readOnly]);

  // 6. 计算当前 baseHash 并同步到 Context
  const currentHash = useMemo(
    () => computeFlowchartSemanticHash(history.present.document),
    [history.present.document],
  );
  useEffect(() => {
    updateBaseHash(note.id, currentHash);
  }, [note.id, currentHash, updateBaseHash]);

  // 6a. 本地流程检查（设计文档 §7.9）
  const semanticWarnings: FlowchartSemanticWarning[] = useMemo(
    () => collectFlowchartSemanticWarnings(history.present.document),
    [history.present.document],
  );

  // 7. 同步选区到 Context
  useEffect(() => {
    setSelection(note.id, { nodeIds: selectedNodeIds, edgeIds: selectedEdgeIds }, currentHash);
  }, [note.id, selectedNodeIds, selectedEdgeIds, currentHash, setSelection]);

  // 9. 提交变更到中心（onContentChange + 历史 push）
  // 单写者模型：非写者 readOnly，不能提交；写者提交后由中心广播给所有实例。
  // 提交携带 baseRevision，NotesView 用于多标签页 revision 校验（设计文档 §8.5-3）。
  const commitChange = useCallback(
    (next: FlowchartDocument, changeKind: "layout" | "semantic") => {
      if (!isWriter) return;
      // 校验文档
      const v = validateFlowchartDocument(next);
      if (!v.ok) {
        // 不应用，提示用户
        return;
      }
      const newHistory = pushHistory(history, next, changeKind);
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

  // 10. 工具栏操作
  const handleAddNode = useCallback(
    (kind: FlowchartNodeKind) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const id = generateFlowchartNodeId();
      // 新增节点默认 label 为"新节点"，由用户双击编辑
      const label = "新节点";
      // 放置在所有节点包围盒右下方
      const xs = doc.nodes.map((n) => n.position.x);
      const ys = doc.nodes.map((n) => n.position.y);
      const cx = xs.length > 0 ? Math.max(...xs) + 200 : 0;
      const cy = ys.length > 0 ? Math.max(...ys) + 100 : 0;
      const node: FlowchartNode = {
        id,
        kind,
        label,
        position: { x: cx, y: cy },
      };
      doc.nodes.push(node);
      setSelectedNodeIds([id]);
      commitChange(doc, "semantic");
    },
    [history.present.document, readOnly, commitChange],
  );

  // 拖拽形状到画布指定位置
  const handleDropShape = useCallback(
    (kind: FlowchartNodeKind, x: number, y: number) => {
      if (readOnly) return;
      const doc = cloneFlowchartDocument(history.present.document);
      const id = generateFlowchartNodeId();
      const node: FlowchartNode = {
        id,
        kind,
        label: "新节点",
        position: { x, y },
      };
      doc.nodes.push(node);
      setSelectedNodeIds([id]);
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

  const handleDeleteSelected = useCallback(() => {
    if (readOnly) return;
    if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
    const doc = cloneFlowchartDocument(history.present.document);
    const idSet = new Set(selectedNodeIds);
    doc.nodes = doc.nodes.filter((n) => !idSet.has(n.id));
    // 同时删除关联边
    doc.edges = doc.edges.filter((e) => {
      if (idSet.has(e.source) || idSet.has(e.target)) return false;
      return !selectedEdgeIds.includes(e.id);
    });
    setSelectedNodeIds([]);
    setSelectedEdgeIds([]);
    commitChange(doc, "semantic");
  }, [history.present.document, readOnly, selectedNodeIds, selectedEdgeIds, commitChange]);

  const handleToggleDirection = useCallback(() => {
    if (readOnly) return;
    const doc = cloneFlowchartDocument(history.present.document);
    doc.direction = doc.direction === "TB" ? "LR" : "TB";
    layoutEntireGraph(doc);
    commitChange(doc, "semantic");
  }, [history.present.document, readOnly, commitChange]);

  const handleRelayout = useCallback(() => {
    if (readOnly) return;
    const doc = cloneFlowchartDocument(history.present.document);
    layoutEntireGraph(doc);
    commitChange(doc, "layout");
  }, [history.present.document, readOnly, commitChange]);

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
        const id = n.id;
        idToPos[id] = startCoord + step * i;
        void id;
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
      setRfNodes((nodes) => flowchartCanvasHelpers.applyNodeChanges(changes, nodes));
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
          commitChange(doc, "layout");
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

  // 13c. 本地问题定位（设计文档 §7.9）：点击 warning 选中关联节点
  const handleLocateWarningNode = useCallback(
    (nodeId: string | null) => {
      if (!nodeId) return;
      // 校验节点存在
      const exists = history.present.document.nodes.some((n) => n.id === nodeId);
      if (!exists) return;
      setSelectedNodeIds([nodeId]);
      setSelectedEdgeIds([]);
    },
    [history.present.document],
  );

  // 13d. 让 AI 修复本地问题（设计文档 §7.9）
  // 把 warnings 拼成可读描述，通过 onFixWithAI 回调交给父组件触发 audit
  const handleFixWithAI = useCallback(
    (warnings: FlowchartSemanticWarning[]) => {
      onFixWithAI?.(warnings);
    },
    [onFixWithAI],
  );

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

  // 删除选中节点和边（删除按钮和 Delete 键共用）
  // Delete/Backspace 已由 React Flow 内置处理（handleEdgesChange 和 handleNodesChange 中的 remove）

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
          // 删除选中节点（含关联边）
          handleDeleteSelected();
          e.preventDefault();
        }
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly, handleUndo, handleRedo, getSelectedSubgraph, handleDeleteSelected, pasteSubgraph]);

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
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleUndo}
          disabled={readOnly || history.past.length === 0}
          title="撤销 (Ctrl+Z)"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleRedo}
          disabled={readOnly || history.future.length === 0}
          title="重做 (Ctrl+Shift+Z)"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 删除 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleDeleteSelected}
          disabled={readOnly || (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0)}
          title="删除选中"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          删除
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 方向 + 布局 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleToggleDirection}
          disabled={readOnly}
          title="切换方向"
        >
          <ArrowUpFromLine className="mr-1 h-3.5 w-3.5" />
          {history.present.document.direction === "TB" ? "竖向" : "横向"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleRelayout}
          disabled={readOnly}
          title="重新布局"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>

        {/* 对齐与分布（设计文档 §7.7）：选中 ≥2 节点时启用对齐，≥3 节点时启用分布 */}
        {selectedNodeIds.length >= 2 && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("left")}
              disabled={readOnly}
              title="左对齐"
            >
              <AlignStartVertical className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("center-h")}
              disabled={readOnly}
              title="水平居中"
            >
              <AlignCenterVertical className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("right")}
              disabled={readOnly}
              title="右对齐"
            >
              <AlignEndVertical className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("top")}
              disabled={readOnly}
              title="顶对齐"
            >
              <AlignStartHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("center-v")}
              disabled={readOnly}
              title="垂直居中"
            >
              <AlignCenterHorizontal className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => applyAlignment("bottom")}
              disabled={readOnly}
              title="底对齐"
            >
              <AlignEndHorizontal className="h-3.5 w-3.5" />
            </Button>
            {selectedNodeIds.length >= 3 && (
              <>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => applyDistribution("horizontal")}
                  disabled={readOnly}
                  title="水平分布"
                >
                  <AlignCenterHorizontal className="h-3 w-3 rotate-90" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => applyDistribution("vertical")}
                  disabled={readOnly}
                  title="垂直分布"
                >
                  <AlignCenterVertical className="h-3 w-3 rotate-90" />
                </Button>
              </>
            )}
          </>
        )}

        {/* 格式化控件：仅选中节点时启用 */}
        {hasNodeSelection && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <NodeFormatToolbar
              style={firstSelectedNode?.style}
              onChange={applyNodeStyle}
              disabled={readOnly}
            />
          </>
        )}

        {/* 格式化控件：仅选中边时启用 */}
        {hasEdgeSelection && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <EdgeFormatToolbar
              style={firstSelectedEdge?.style}
              onChange={applyEdgeStyle}
              disabled={readOnly}
            />
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          {toolbarExtra}
          {/* 导出菜单（设计文档 §7.12, §7.13） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={exporting || history.present.document.nodes.length === 0}
                title="导出流程图"
              >
                {exporting ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="mr-1 h-3.5 w-3.5" />
                )}
                导出
              </Button>
            </DropdownMenuTrigger>
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
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={handleRequestWriteLease}
              title="另一个标签页正在编辑此流程图"
            >
              在此编辑
            </Button>
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

      {/* 主体：左侧图形库 + 右侧画布 */}
      <div className="flex min-h-0 flex-1">
        <FlowchartShapePanel
          onAddShape={handleAddNode}
          onDropShape={handleDropShape}
          readOnly={readOnly}
        />
        <div className="relative min-h-0 flex-1">
          <FlowchartCanvas
            ref={canvasRef}
            nodes={history.present.document.nodes}
            edges={history.present.document.edges}
            direction={history.present.document.direction}
            readOnly={readOnly}
            initialViewport={history.present.document.viewport ?? null}
            internalNodes={rfNodes}
            internalEdges={rfEdges}
            onInternalNodesChange={handleNodesChange}
            onInternalEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onReconnect={handleEdgeReconnect}
            onEdgeLabelEdit={handleEdgeLabelEdit}
            onViewportChange={handleViewportChange}
            onSelectionChange={handleSelectionChange}
            onNodeLabelEdit={handleNodeLabelEdit}
            onDropShape={handleDropShape}
          />
          {/* 本地流程检查面板（设计文档 §7.9） */}
          <FlowchartIssuesPanel
            warnings={semanticWarnings}
            onLocateNode={handleLocateWarningNode}
            onFixWithAI={handleFixWithAI}
          />
        </div>
      </div>
    </div>
  );
}

function emptyDoc(): FlowchartDocument {
  return {
    version: 1,
    direction: "TB",
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// ---------------------------------------------------------------------------
// 格式化工具栏：节点样式（字体、字号、字色、填充色、边框色、边框宽度、边框样式、加粗、斜体）
// ---------------------------------------------------------------------------

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
      <select
        value={s?.fontFamily ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ fontFamily: e.target.value || undefined })}
        title="字体"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        {FONT_FAMILY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* 字号 */}
      <select
        value={s?.fontSize ?? 13}
        disabled={disabled}
        onChange={(e) => onChange({ fontSize: Number(e.target.value) || undefined })}
        title="字号"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        {FONT_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>

      {/* 字色 */}
      <ColorPicker
        value={s?.color}
        title="字色"
        onChange={(color) => onChange({ color })}
      />

      {/* 填充色 */}
      <ColorPicker
        value={s?.fill}
        title="填充色"
        onChange={(color) => onChange({ fill: color })}
      />

      {/* 边框色 */}
      <ColorPicker
        value={s?.borderColor}
        title="边框色"
        onChange={(color) => onChange({ borderColor: color })}
      />

      {/* 边框宽度 */}
      <select
        value={s?.borderWidth ?? 1.5}
        disabled={disabled}
        onChange={(e) => onChange({ borderWidth: Number(e.target.value) || undefined })}
        title="边框宽度"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        {STROKE_WIDTH_OPTIONS.map((w) => (
          <option key={w} value={w}>
            {w}px
          </option>
        ))}
      </select>

      {/* 边框样式 */}
      <select
        value={s?.borderStyle ?? "solid"}
        disabled={disabled}
        onChange={(e) =>
          onChange({ borderStyle: (e.target.value || undefined) as FlowchartNodeStyle["borderStyle"] })
        }
        title="边框样式"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        <option value="solid">实线</option>
        <option value="dashed">虚线</option>
        <option value="dotted">点线</option>
      </select>

      {/* 加粗 / 斜体 / 下划线 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ bold: !s?.bold })}
        title="加粗"
        className={`grid h-7 w-7 place-items-center rounded-md text-[11px] font-bold hover:bg-accent disabled:opacity-50 ${
          s?.bold ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
      >
        B
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ italic: !s?.italic })}
        title="斜体"
        className={`grid h-7 w-7 place-items-center rounded-md text-[11px] italic hover:bg-accent disabled:opacity-50 ${
          s?.italic ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
      >
        I
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ underline: !s?.underline })}
        title="下划线"
        className={`grid h-7 w-7 place-items-center rounded-md text-[11px] underline hover:bg-accent disabled:opacity-50 ${
          s?.underline ? "bg-accent text-foreground" : "text-muted-foreground"
        }`}
      >
        U
      </button>

      {/* 文字对齐 */}
      <div className="ml-1 flex items-center gap-0.5 border-l border-border/50 pl-1">
        {(["left", "center", "right"] as const).map((align) => (
          <button
            key={align}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ textAlign: align })}
            title={`文字${align === "left" ? "左对齐" : align === "center" ? "居中" : "右对齐"}`}
            className={`grid h-7 w-7 place-items-center rounded-md text-[11px] hover:bg-accent disabled:opacity-50 ${
              (s?.textAlign ?? "center") === align
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {align === "left" ? "⬅" : align === "center" ? "↔" : "➡"}
          </button>
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
        onChange={(color) => onChange({ stroke: color })}
      />

      {/* 线条宽度 */}
      <select
        value={s?.strokeWidth ?? 1.5}
        disabled={disabled}
        onChange={(e) => onChange({ strokeWidth: Number(e.target.value) || undefined })}
        title="线条宽度"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        {STROKE_WIDTH_OPTIONS.map((w) => (
          <option key={w} value={w}>
            {w}px
          </option>
        ))}
      </select>

      {/* 线条样式 */}
      <select
        value={s?.strokeDasharray ?? "solid"}
        disabled={disabled}
        onChange={(e) =>
          onChange({ strokeDasharray: (e.target.value || undefined) as FlowchartEdgeStyle["strokeDasharray"] })
        }
        title="线条样式"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        <option value="solid">实线</option>
        <option value="dashed">虚线</option>
        <option value="dotted">点线</option>
      </select>

      <div className="mx-0.5 h-4 w-px bg-border" />

      {/* 连接类型 */}
      <select
        value={s?.route ?? "smoothstep"}
        disabled={disabled}
        onChange={(e) =>
          onChange({ route: (e.target.value || undefined) as FlowchartEdgeStyle["route"] })
        }
        title="连接类型"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        <option value="smoothstep">曲线</option>
        <option value="step">折线</option>
        <option value="straight">直线</option>
      </select>

      {/* 起点箭头 */}
      <select
        value={s?.markerStart ?? "none"}
        disabled={disabled}
        onChange={(e) =>
          onChange({ markerStart: (e.target.value || undefined) as FlowchartEdgeStyle["markerStart"] })
        }
        title="起点样式"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        <option value="none">起点无</option>
        <option value="arrow">起点箭头</option>
        <option value="arrowclosed">起点实心</option>
      </select>

      {/* 终点箭头 */}
      <select
        value={s?.markerEnd ?? "arrowclosed"}
        disabled={disabled}
        onChange={(e) =>
          onChange({ markerEnd: (e.target.value || undefined) as FlowchartEdgeStyle["markerEnd"] })
        }
        title="终点样式"
        className="h-7 rounded-md border border-border/70 bg-background px-1 text-[11px] outline-none hover:bg-accent disabled:opacity-50"
      >
        <option value="none">终点无</option>
        <option value="arrow">终点箭头</option>
        <option value="arrowclosed">终点实心</option>
      </select>
    </div>
  );
}

/** 颜色选择器：预设色板 + 自定义 input[type=color] */
function ColorPicker({
  value,
  title,
  onChange,
}: {
  value: string | undefined;
  title: string;
  onChange: (color: string | undefined) => void;
}) {
  const current = value ?? "";
  return (
    <div className="relative inline-flex items-center" title={title}>
      <div
        className="h-7 w-7 cursor-pointer rounded-md border border-border/70"
        style={{
          background: current || "transparent",
          backgroundImage: current
            ? undefined
            : "linear-gradient(45deg, hsl(var(--muted-foreground) / 0.4) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted-foreground) / 0.4) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted-foreground) / 0.4) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted-foreground) / 0.4) 75%)",
          backgroundSize: "8px 8px",
          backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
        }}
        onClick={(e) => {
          const input = e.currentTarget.nextElementSibling as HTMLInputElement | null;
          input?.click();
        }}
      />
      <input
        type="color"
        value={current || "#000000"}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
      {/* 清除颜色 */}
      {current && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(undefined);
          }}
          title="清除颜色"
          className="absolute -right-1 -top-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-destructive text-[8px] text-destructive-foreground"
        >
          ×
        </button>
      )}
    </div>
  );
}

// 暴露给外部（NotesView / NoteAgentPanel）的工具
export { generateEditorInstanceId };
export type { FlowchartDirection };
