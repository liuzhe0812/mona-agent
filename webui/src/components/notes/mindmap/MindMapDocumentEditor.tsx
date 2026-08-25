import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, type ReactNode } from "react";
import MindElixir, { SIDE } from "mind-elixir";
import type { MindElixirInstance, NodeObj, Topic } from "mind-elixir";
import "mind-elixir/style.css";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Undo2,
  Redo2,
  Plus,
  CornerDownRight,
  Trash2,
  Copy,
  Download,
  Loader2,
  Palette,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  Scissors,
  ClipboardPaste,
  GitBranch,
  Brackets,
  Square,
  Crosshair,
  ArrowUp,
  ArrowDown,
  Tag,
} from "lucide-react";

import type { OperationNote } from "../notes-data";
import {
  parseMindMap,
  serializeMindMap,
  findPathToNode,
  computeBaseHash,
  type MindMapNode,
  type MindMapNodeStyle,
} from "./mindmap-outline";
import {
  exportToFreemind,
  downloadTextFile,
  safeFileName,
} from "./mindmap-export";
import {
  searchInTree,
  computeReplaceAllChanges,
  type SearchMatch,
} from "./mindmap-search";
import { FindReplacePanel } from "./FindReplacePanel";
import { NodePropertyDialog, type NodePropertyData } from "./NodePropertyDialog";
import { useMindMapSelection } from "./MindMapSelectionContext";
import { useMindMapBridge } from "./MindMapBridge";
import { downloadMediaUrl } from "@/lib/tauri";
import {
  readDecorations,
  writeDecorations,
  cleanupDanglingDecorations,
  storedArrowToNative,
  nativeArrowToStored,
  summaryToNativeRange,
  groupSelectionByBranch,
  validateSelection,
  generateDecorationId,
  findNodeById,
  EMPTY_DECORATIONS,
  type MonaMapDecorations,
  type StoredArrow,
  type StoredSummary,
  type StoredBoundary,
  type StoredBoundaryLink,
  type BoundaryLinkEndpoint,
} from "./mindmap-decorations";

export interface MindMapSelection {
  nodeId: string;
  path: number[];
  pathLabels: string[];
  subtreeMarkdown: string;
}

interface MindMapDocumentEditorProps {
  note: OperationNote;
  onContentChange: (next: {
    contentMarkdown: string;
    plainText: string;
  }) => void;
  onSelectionChange?: (selection: MindMapSelection | null) => void;
  /** 注入到工具栏最左侧（视图切换按钮之前）的节点 */
  toolbarLeading?: ReactNode;
  /** 注入到工具栏右侧（saveLabel 之前）的额外节点 */
  toolbarExtra?: ReactNode;
}

const MIND_ELIXIR_DARK_VARS = {
  "--main-color": "#e2e8f0",
  "--main-bgcolor": "#1e293b",
  "--color": "#94a3b8",
  "--bgcolor": "#0f172a",
  "--panel-color": "255, 255, 255",
  "--panel-bgcolor": "30, 41, 59",
};

const MIND_ELIXIR_LIGHT_VARS = {
  "--main-color": "#1e293b",
  "--main-bgcolor": "#f8fafc",
  "--color": "#64748b",
  "--bgcolor": "#ffffff",
  "--panel-color": "0, 0, 0",
  "--panel-bgcolor": "248, 250, 252",
};

type MindMapThemeKey = "auto" | "emerald" | "amber" | "coral" | "cyan" | "morandi" | "dark";

interface MindMapTheme {
  name: string;
  type: "light" | "dark";
  palette: string[];
  cssVar: Record<string, string>;
}

interface MindMapThemePreset {
  key: Exclude<MindMapThemeKey, "auto">;
  label: string;
  swatch: string;
  theme: MindMapTheme;
}

// 跟随系统：浅色
const MINDMAP_LIGHT_THEME: MindMapTheme = {
  name: "Light",
  type: "light",
  palette: ["#10b981", "#f59e0b", "#fb7185", "#06b6d4", "#8b5cf6", "#84cc16", "#ec4899", "#14b8a6", "#f97316", "#3b82f6"],
  cssVar: MIND_ELIXIR_LIGHT_VARS,
};

// 跟随系统：深色
const MINDMAP_DARK_THEME: MindMapTheme = {
  name: "Dark",
  type: "dark",
  palette: ["#848FA0", "#748BE9", "#D2F9FE", "#4145A5", "#789AFA", "#706CF4", "#EF987F", "#775DD5", "#FCEECF", "#DA7FBC"],
  cssVar: MIND_ELIXIR_DARK_VARS,
};

// 预置配色方案（遵循项目偏好：翡翠绿 / 琥珀金 / 珊瑚橙 / 青蓝）
const MINDMAP_THEME_PRESETS: MindMapThemePreset[] = [
  {
    key: "emerald",
    label: "翡翠绿",
    swatch: "#10b981",
    theme: {
      name: "Emerald",
      type: "light",
      palette: ["#10b981", "#059669", "#34d399", "#6ee7b7", "#047857", "#0d9488", "#14b8a6", "#5eead4", "#0891b2", "#06b6d4"],
      cssVar: {
        "--main-color": "#ffffff",
        "--main-bgcolor": "#10b981",
        "--color": "#334155",
        "--bgcolor": "#f0fdf4",
        "--panel-color": "0, 0, 0",
        "--panel-bgcolor": "240, 253, 244",
      },
    },
  },
  {
    key: "amber",
    label: "琥珀金",
    swatch: "#f59e0b",
    theme: {
      name: "Amber",
      type: "light",
      palette: ["#f59e0b", "#d97706", "#fbbf24", "#fcd34d", "#b45309", "#92400e", "#78350f", "#451a03", "#fb923c", "#f97316"],
      cssVar: {
        "--main-color": "#ffffff",
        "--main-bgcolor": "#f59e0b",
        "--color": "#422006",
        "--bgcolor": "#fffbeb",
        "--panel-color": "0, 0, 0",
        "--panel-bgcolor": "255, 251, 235",
      },
    },
  },
  {
    key: "coral",
    label: "珊瑚橙",
    swatch: "#f97316",
    theme: {
      name: "Coral",
      type: "light",
      palette: ["#f97316", "#ea580c", "#fb923c", "#fdba74", "#c2410c", "#9a3412", "#7c2d12", "#fb7185", "#f43f5e", "#e11d48"],
      cssVar: {
        "--main-color": "#ffffff",
        "--main-bgcolor": "#f97316",
        "--color": "#431407",
        "--bgcolor": "#fff7ed",
        "--panel-color": "0, 0, 0",
        "--panel-bgcolor": "255, 247, 237",
      },
    },
  },
  {
    key: "cyan",
    label: "青蓝",
    swatch: "#06b6d4",
    theme: {
      name: "Cyan",
      type: "light",
      palette: ["#06b6d4", "#0891b2", "#0e7490", "#155e75", "#164e63", "#22d3ee", "#67e8f9", "#0369a1", "#0284c7", "#7dd3fc"],
      cssVar: {
        "--main-color": "#ffffff",
        "--main-bgcolor": "#06b6d4",
        "--color": "#0c4a6e",
        "--bgcolor": "#ecfeff",
        "--panel-color": "0, 0, 0",
        "--panel-bgcolor": "236, 254, 255",
      },
    },
  },
  {
    key: "morandi",
    label: "莫兰迪",
    swatch: "#a8b5b0",
    theme: {
      name: "Morandi",
      type: "light",
      palette: ["#a8b5b0", "#b5a899", "#a3a8b5", "#b5a3a8", "#9da8a3", "#b0a8a0", "#a8a0b0", "#a09a8e", "#8e9aa0", "#9a8e96"],
      cssVar: {
        "--main-color": "#3f3f3f",
        "--main-bgcolor": "#a8b5b0",
        "--color": "#5c5c5c",
        "--bgcolor": "#f5f1ec",
        "--panel-color": "0, 0, 0",
        "--panel-bgcolor": "245, 241, 236",
      },
    },
  },
  {
    key: "dark",
    label: "深空",
    swatch: "#0f172a",
    theme: MINDMAP_DARK_THEME,
  },
];

const THEME_STORAGE_KEY = "mindmap.theme";

function loadThemeKey(): MindMapThemeKey {
  if (typeof localStorage === "undefined") return "auto";
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  if (raw === "auto" || MINDMAP_THEME_PRESETS.some(p => p.key === raw)) {
    return raw as MindMapThemeKey;
  }
  return "auto";
}

function resolveTheme(key: MindMapThemeKey, dark: boolean): MindMapTheme {
  if (key === "auto") return dark ? MINDMAP_DARK_THEME : MINDMAP_LIGHT_THEME;
  return MINDMAP_THEME_PRESETS.find(p => p.key === key)?.theme ?? MINDMAP_LIGHT_THEME;
}

export interface MindMapDocumentEditorHandle {
  /** 选中并居中到指定节点（供右侧大纲面板调用） */
  selectNode: (nodeId: string) => void;
}

export const MindMapDocumentEditor = forwardRef<MindMapDocumentEditorHandle, MindMapDocumentEditorProps>(function MindMapDocumentEditor({
  note,
  onContentChange,
  onSelectionChange,
  toolbarLeading,
  toolbarExtra,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const isRefreshingRef = useRef(false);
  const lastContentRef = useRef(note.contentMarkdown);
  const contextMenuCleanupRef = useRef<(() => void) | null>(null);
  // 当前装饰数据（arrows / summaries / boundaries），与 Mind Elixir 内部状态同步
  const decorationsRef = useRef<MonaMapDecorations>({ ...EMPTY_DECORATIONS });
  // 右键点击目标类型：节点 / 空白区域
  const [contextMenuTarget, setContextMenuTarget] = useState<"node" | "empty">("node");
  // 右键打开菜单时的选区快照（节点 ID 列表），避免菜单打开后选区被清空
  const selectionSnapshotRef = useRef<string[]>([]);
  // 联系模式：根据已有选区，从起始主题或目标主题继续选择
  const [linkingState, setLinkingState] = useState<{
    active: boolean;
    phase: "first" | "second";
    first: BoundaryLinkEndpoint | null;
  }>({ active: false, phase: "first", first: null });
  // 无现有选区时，外框 / 概要进入补充框选模式
  const [marqueeState, setMarqueeState] = useState<{
    active: boolean;
    mode: "boundary" | "summary" | null;
  }>({ active: false, mode: null });
  // 当前选中外框 ID（用于 Delete 删除）
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string | null>(null);
  const [selectedBoundaryLinkId, setSelectedBoundaryLinkId] = useState<string | null>(null);
  // 外框 SVG 层元素
  const boundaryLayerRef = useRef<SVGSVGElement | null>(null);
  // 框选矩形元素（覆盖层）
  const marqueeRectRef = useRef<HTMLDivElement | null>(null);
  // 保存最新的 redrawBoundaries 函数，供 init useEffect 中的 listener 调用
  const redrawBoundariesRef = useRef<() => void>(() => {});
  const boundaryResizeCleanupRef = useRef<(() => void) | null>(null);
  // 保存事件监听所需的最新回调
  const cancelLinkingRef = useRef<() => void>(() => {});
  const createRelationshipRef = useRef<
    (from: BoundaryLinkEndpoint, to: BoundaryLinkEndpoint) => void
  >(() => {});
  const handleDeleteBoundaryRef = useRef<() => void>(() => {});
  const handleDeleteBoundaryLinkRef = useRef<() => void>(() => {});
  const finishMarqueeRef = useRef<(rect: DOMRect) => void>(() => {});
  const { setSelection, updateBaseHash } = useMindMapSelection();

  const [parseError, setParseError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  const [themeKey, setThemeKey] = useState<MindMapThemeKey>(loadThemeKey);
  // 画布缩放百分比（用于工具栏显示）
  const [zoomPercent, setZoomPercent] = useState(100);
  // 节点属性编辑对话框
  const [nodePropertyOpen, setNodePropertyOpen] = useState(false);
  const [nodePropertyData, setNodePropertyData] = useState<NodePropertyData | null>(null);
  // 查找替换面板状态
  const [showFindPanel, setShowFindPanel] = useState(false);
  const [findMatches, setFindMatches] = useState<SearchMatch[]>([]);
  const [findIndex, setFindIndex] = useState(-1);
  // 用 ref 保存最新的 matches，避免闭包过期
  const findMatchesRef = useRef<SearchMatch[]>([]);
  findMatchesRef.current = findMatches;
  const findIndexRef = useRef(-1);
  findIndexRef.current = findIndex;
  // 用 ref 保存最新 themeKey，供 init 闭包读取（init 仅运行一次）
  const themeKeyRef = useRef(themeKey);
  themeKeyRef.current = themeKey;

  // 监听主题变化
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // 同步外部 contentMarkdown 变化
  useEffect(() => {
    if (note.contentMarkdown === lastContentRef.current) return;
    if (isRefreshingRef.current) return;

    const result = parseMindMap(note.contentMarkdown);
    if (!result.ok) {
      setParseError(`第 ${result.line} 行：${result.message}`);
      return;
    }
    setParseError(null);
    lastContentRef.current = note.contentMarkdown;

    // 外部内容更新（如 AI Patch）会触发 refresh 重建 DOM，需重置查找状态
    setFindMatches([]);
    setFindIndex(-1);

    if (mindRef.current) {
      const cloned = cloneNode(result.root);
      // 读取新的装饰数据（外部内容变化时，如 AI Patch）
      const newDecorations = readDecorations(result.root);
      decorationsRef.current = newDecorations;
      const arrows = newDecorations.arrows.map((a) => storedArrowToNative(a));
      const summaries = newDecorations.summaries
        .map((s) => {
          const range = summaryToNativeRange(s, result.root);
          if (!range) return null;
          return { id: s.id, label: s.label, ...range, style: s.style };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      isRefreshingRef.current = true;
      try {
        mindRef.current.refresh({ nodeData: cloned, arrows, summaries });
      } finally {
        isRefreshingRef.current = false;
      }
      requestAnimationFrame(() => redrawBoundariesRef.current());
    }
  }, [note.contentMarkdown]);

  // 初始化 Mind Elixir
  useEffect(() => {
    if (!containerRef.current) return;
    if (mindRef.current) return;

    const result = parseMindMap(note.contentMarkdown);
    if (!result.ok) {
      setParseError(`第 ${result.line} 行：${result.message}`);
      return;
    }

    // 读取地图级装饰数据（arrows / summaries / boundaries）
    decorationsRef.current = readDecorations(result.root);

    const mind = new MindElixir({
      el: containerRef.current,
      direction: SIDE,
      toolBar: false,
      keypress: true,
      contextMenu: false,
      overflowHidden: false,
      allowUndo: true,
      // 外部文本粘贴：按 Markdown 大纲层级解析（2 空格缩进 = 子节点）
      pasteHandler: (e: ClipboardEvent) => {
        const mind = mindRef.current;
        if (!mind) return;
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!text.trim()) return;
        const parsed = parseMindMapFromText(text);
        if (!parsed) return;
        const current = mind.currentNode;
        if (!current) return;
        // 将解析出的节点转换为 NodeObj 并追加为子节点
        if (parsed.children.length > 0) {
          for (const child of parsed.children) {
            void mind.addChild(current, cloneNode(child));
          }
        } else if (parsed.topic) {
          // 单行纯文本：追加为同级
          void mind.insertSibling("after", current, cloneNode(parsed));
        }
        e.preventDefault();
      },
    });

    mind.init({
      nodeData: cloneNode(result.root),
      arrows: decorationsRef.current.arrows.map((a) => storedArrowToNative(a)),
      summaries: decorationsRef.current.summaries
        .map((s) => {
          const range = summaryToNativeRange(s, result.root);
          if (!range) return null;
          return { id: s.id, label: s.label, ...range, style: s.style };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    });
    // 应用保存的配色方案（非 auto 时立即覆盖默认 Latte 主题）
    const savedKey = themeKeyRef.current;
    if (savedKey !== "auto") {
      const theme = resolveTheme(savedKey, document.documentElement.classList.contains("dark"));
      isRefreshingRef.current = true;
      try {
        mind.changeTheme(theme, false);
        mind.refresh();
      } finally {
        isRefreshingRef.current = false;
      }
    }
    // 初始化后按根节点居中（toCenter），避免 scaleFit 按 nodes 居中时
    // 因左右子节点不对称把根节点推到容器边缘而被截断
    const centerWhenReady = (attempts = 0) => {
      const el = containerRef.current;
      if (!el || attempts > 30) return; // 最多重试 30 帧（约 500ms）
      if (el.offsetWidth === 0 || el.offsetHeight === 0) {
        requestAnimationFrame(() => centerWhenReady(attempts + 1));
        return;
      }
      mind.toCenter();
      setZoomPercent(Math.round(mind.scaleVal * 100));
    };
    requestAnimationFrame(() => centerWhenReady());

    // 创建外框 SVG 层：插入到 mind.map 内部，作为第一个子元素
    // mind.map 的 transform 会自动应用到子元素，外框跟随平移和缩放
    const boundaryLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    boundaryLayer.style.position = "absolute";
    boundaryLayer.style.top = "0";
    boundaryLayer.style.left = "0";
    boundaryLayer.style.width = "100%";
    boundaryLayer.style.height = "100%";
    boundaryLayer.style.pointerEvents = "none";
    boundaryLayer.style.overflow = "visible";
    boundaryLayer.style.zIndex = "0";
    boundaryLayerRef.current = boundaryLayer;
    if (mind.map) {
      mind.map.insertBefore(boundaryLayer, mind.map.firstChild);
    }

    mind.bus.addListener("operation", () => {
      if (isRefreshingRef.current) return;
      persistCurrentMap();
      requestAnimationFrame(() => redrawBoundariesRef.current());
    });

    // linkDiv 事件后也要重绘外框（节点位置变化）
    mind.bus.addListener("linkDiv", () => {
      requestAnimationFrame(() => redrawBoundariesRef.current());
    });

    mind.bus.addListener("selectNewNode", (nodeObj: NodeObj) => {
      const root = mind.getData().nodeData;
      const path = findPathToNode(root, nodeObj.id);
      if (!path) {
        onSelectionChange?.(null);
        setSelection(note.id, null, null);
        return;
      }
      const labels = pathToLabels(root, path);
      const subtreeMd = serializeMindMap(stripParent(nodeObj));
      const sel = {
        nodeId: nodeObj.id,
        path,
        pathLabels: labels,
        subtreeMarkdown: subtreeMd,
      };
      onSelectionChange?.(sel);
      // 同步到 Context，供 NoteAgentPanel 消费
      const baseHash = computeBaseHash(lastContentRef.current);
      setSelection(note.id, sel, baseHash);
      selectionSnapshotRef.current = [nodeObj.id];
      setSelectedBoundaryId(null);
      setSelectedBoundaryLinkId(null);
    });

    // 多选事件：追踪当前选中节点
    mind.bus.addListener("selectNodes", () => {
      const ids = mind.currentNodes.map((node) => node.nodeObj.id);
      selectionSnapshotRef.current = ids;
    });
    mind.bus.addListener("unselectNodes", () => {
      const ids = mind.currentNodes.map((node) => node.nodeObj.id);
      selectionSnapshotRef.current = ids;
    });

    // Mind Elixir 的 contextmenu 处理器调用了 preventDefault() 阻止原生菜单，
    // 同时导致 event.defaultPrevented = true。
    // Radix 的 composeEventHandlers 检查 defaultPrevented，为 true 时跳过菜单打开。
    //
    // 修复：在捕获阶段用 Object.defineProperty 覆盖 defaultPrevented 的 getter，
    // 让它始终返回 false。preventDefault 本身保持原始行为不变：
    //   - Mind Elixir 调用 preventDefault → 浏览器原生菜单被阻止（符合预期）
    //   - defaultPrevented getter 返回 false → Radix 检查通过，打开自定义菜单
    const container = containerRef.current;
    if (container) {
      const captureHandler = (e: MouseEvent) => {
        if (e.button !== 2) return; // 仅处理右键
        // 只有实际主题算节点；me-map / me-wrapper 等仍属于空白区域
        const target = e.target as Element | null;
        const topic = target?.closest?.("me-tpc") as Topic | null;
        const boundary = target?.closest?.("[data-boundary-id]") as SVGElement | null;
        const isNode = topic !== null;
        setContextMenuTarget(isNode ? "node" : "empty");
        // 快照当前选区（菜单打开后 Mind Elixir 可能清空选区）
        const mind = mindRef.current;
        if (mind) {
          if (boundary?.dataset.boundaryId) {
            mind.clearSelection();
            selectionSnapshotRef.current = [];
            setSelectedBoundaryId(boundary.dataset.boundaryId);
            setSelectedBoundaryLinkId(null);
          } else {
            if (topic && !mind.currentNodes.some((node) => node.nodeObj.id === topic.nodeObj.id)) {
              mind.selectNode(topic, false);
            }
            selectionSnapshotRef.current = mind.currentNodes.map((n) => n.nodeObj.id);
            if (topic) {
              setSelectedBoundaryId(null);
              setSelectedBoundaryLinkId(null);
            }
          }
        }
        try {
          Object.defineProperty(e, "defaultPrevented", {
            get: () => false,
            configurable: true,
          });
        } catch {
          e.preventDefault = () => {};
        }
      };
      const clearDecorationSelection = (e: MouseEvent) => {
        if (
          e.button !== 0 ||
          (e.target as Element | null)?.closest?.(
            "[data-boundary-id], [data-boundary-handle], [data-boundary-link-id]",
          )
        ) {
          return;
        }
        setSelectedBoundaryId(null);
        setSelectedBoundaryLinkId(null);
      };
      container.addEventListener("contextmenu", captureHandler, true);
      container.addEventListener("mousedown", clearDecorationSelection, true);
      contextMenuCleanupRef.current = () => {
        container.removeEventListener("contextmenu", captureHandler, true);
        container.removeEventListener("mousedown", clearDecorationSelection, true);
      };
    }

    mindRef.current = mind;

    return () => {
      contextMenuCleanupRef.current?.();
      contextMenuCleanupRef.current = null;
      boundaryResizeCleanupRef.current?.();
      boundaryResizeCleanupRef.current = null;
      if (boundaryLayerRef.current) {
        boundaryLayerRef.current.remove();
        boundaryLayerRef.current = null;
      }
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
      mindRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 联系模式对齐 XMind：
  // 0 个选区时依次点击起始/目标主题，1 个选区时只补选目标主题。
  // 因产品已移除自由主题，点击空白只取消，不在空白处创建主题。
  useEffect(() => {
    if (!linkingState.active) return;
    const container = containerRef.current;
    if (!container) return;

    const handleTargetClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const topic = target?.closest?.("me-tpc") as Topic | null;
      const boundary = target?.closest?.("[data-boundary-id]") as SVGElement | null;
      const endpoint: BoundaryLinkEndpoint | null = topic?.nodeObj?.id
        ? { kind: "node", id: topic.nodeObj.id }
        : boundary?.dataset.boundaryId
          ? { kind: "boundary", id: boundary.dataset.boundaryId }
          : null;
      if (!endpoint) {
        cancelLinkingRef.current();
        return;
      }
      const mind = mindRef.current;
      if (!mind) return;
      e.preventDefault();
      e.stopPropagation();

      if (linkingState.phase === "first") {
        if (endpoint.kind === "node" && topic) {
          mind.selectNode(topic, false);
          selectionSnapshotRef.current = [endpoint.id];
          setSelectedBoundaryId(null);
        } else {
          mind.clearSelection();
          selectionSnapshotRef.current = [];
          setSelectedBoundaryId(endpoint.id);
        }
        setSelectedBoundaryLinkId(null);
        setLinkingState({ active: true, phase: "second", first: endpoint });
      } else if (linkingState.phase === "second") {
        const first = linkingState.first;
        if (!first) {
          cancelLinkingRef.current();
          return;
        }
        // 不允许连接自身
        if (endpoint.kind === first.kind && endpoint.id === first.id) {
          return;
        }
        createRelationshipRef.current(first, endpoint);
        cancelLinkingRef.current();
      }
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelLinkingRef.current();
      }
    };

    // 右键空白也取消
    const handleContextmenu = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const target = e.target as Element | null;
      const isTarget = !!target?.closest?.("me-tpc, [data-boundary-id]");
      if (!isTarget) {
        cancelLinkingRef.current();
      }
    };

    container.addEventListener("click", handleTargetClick, true);
    window.addEventListener("keydown", handleKeydown);
    container.addEventListener("contextmenu", handleContextmenu, true);
    return () => {
      container.removeEventListener("click", handleTargetClick, true);
      window.removeEventListener("keydown", handleKeydown);
      container.removeEventListener("contextmenu", handleContextmenu, true);
    };
  }, [linkingState]);

  // 框选模式：鼠标拖动框选节点。Esc / 右键取消。
  useEffect(() => {
    if (!marqueeState.active || !marqueeState.mode) return;
    const container = containerRef.current;
    if (!container) return;

    // 创建框选矩形元素
    const marqueeRect = document.createElement("div");
    marqueeRect.style.position = "absolute";
    marqueeRect.style.border = "1px solid hsl(var(--primary))";
    marqueeRect.style.backgroundColor = "hsl(var(--primary) / 0.1)";
    marqueeRect.style.pointerEvents = "none";
    marqueeRect.style.zIndex = "20";
    marqueeRect.style.display = "none";
    container.appendChild(marqueeRect);
    marqueeRectRef.current = marqueeRect;

    let isDragging = false;
    let startX = 0;
    let startY = 0;

    const handleMousedown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // 在主题或已有外框上按下时不启动框选；其他 me-* 容器仍属于画布空白。
      const target = e.target as Element | null;
      if (target?.closest?.("me-tpc, [data-boundary-id]")) return;
      isDragging = true;
      const rect = container.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      marqueeRect.style.left = `${startX}px`;
      marqueeRect.style.top = `${startY}px`;
      marqueeRect.style.width = "0px";
      marqueeRect.style.height = "0px";
      marqueeRect.style.display = "block";
      e.preventDefault();
    };

    const handleMousemove = (e: MouseEvent) => {
      if (!isDragging) return;
      const rect = container.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curY = e.clientY - rect.top;
      const left = Math.min(startX, curX);
      const top = Math.min(startY, curY);
      const width = Math.abs(curX - startX);
      const height = Math.abs(curY - startY);
      marqueeRect.style.left = `${left}px`;
      marqueeRect.style.top = `${top}px`;
      marqueeRect.style.width = `${width}px`;
      marqueeRect.style.height = `${height}px`;
    };

    const handleMouseup = (e: MouseEvent) => {
      if (!isDragging) return;
      isDragging = false;
      marqueeRect.style.display = "none";
      // 计算框选矩形的屏幕坐标
      const containerRect = container.getBoundingClientRect();
      const left = Math.min(startX, e.clientX - containerRect.left);
      const top = Math.min(startY, e.clientY - containerRect.top);
      const right = Math.max(startX, e.clientX - containerRect.left);
      const bottom = Math.max(startY, e.clientY - containerRect.top);
      // 转为屏幕坐标
      const screenRect = new DOMRect(
        containerRect.left + left,
        containerRect.top + top,
        right - left,
        bottom - top,
      );
      finishMarqueeRef.current(screenRect);
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMarqueeState({ active: false, mode: null });
      }
    };

    const handleContextmenu = (e: MouseEvent) => {
      if (e.button !== 2) return;
      e.preventDefault();
      setMarqueeState({ active: false, mode: null });
    };

    container.addEventListener("mousedown", handleMousedown, true);
    window.addEventListener("mousemove", handleMousemove);
    window.addEventListener("mouseup", handleMouseup);
    window.addEventListener("keydown", handleKeydown);
    container.addEventListener("contextmenu", handleContextmenu, true);
    return () => {
      container.removeEventListener("mousedown", handleMousedown, true);
      window.removeEventListener("mousemove", handleMousemove);
      window.removeEventListener("mouseup", handleMouseup);
      window.removeEventListener("keydown", handleKeydown);
      container.removeEventListener("contextmenu", handleContextmenu, true);
      if (marqueeRectRef.current) {
        marqueeRectRef.current.remove();
        marqueeRectRef.current = null;
      }
    };
  }, [marqueeState]);

  // 统一保存：把 Mind Elixir 当前数据（nodeData + arrows + summaries）
  // 写回根节点 metadata.monaMap，再序列化为 Markdown 通知外部。
  // boundaries 是 Mona 自定义数据，不在 Mind Elixir 内部状态中，直接从 decorationsRef 读取。
  const persistCurrentMap = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const data = mind.getData();
    const rootMd = stripParent(data.nodeData);

    // 同步 arrows 和 summaries 到 decorationsRef
    const arrows: StoredArrow[] = (data.arrows ?? []).map(nativeArrowToStored);
    const summaries: StoredSummary[] = (data.summaries ?? []).map((s) => {
      // 原生 summary 用 parent + start + end，需转回稳定 nodeIds
      const parentNode = findNodeById(data.nodeData, s.parent);
      if (!parentNode || !parentNode.children) {
        // 无法还原 nodeIds，保留原 nodeIds（若已存在）
        const existing = decorationsRef.current.summaries.find((x) => x.id === s.id);
        return (
          existing ?? {
            id: s.id,
            label: s.label,
            nodeIds: [],
          }
        );
      }
      const nodeIds: string[] = [];
      for (let i = s.start; i <= s.end; i++) {
        const child = parentNode.children[i];
        if (child) nodeIds.push(child.id);
      }
      return {
        id: s.id,
        label: s.label,
        nodeIds,
        style: s.style,
      } satisfies StoredSummary;
    });

    // 保留 boundaries（Mind Elixir 不管理）
    const boundaries = decorationsRef.current.boundaries;
    const boundaryLinks = decorationsRef.current.boundaryLinks;

    // 清理引用失效的装饰
    const cleaned = cleanupDanglingDecorations(
      { version: 1, arrows, summaries, boundaries, boundaryLinks },
      rootMd,
    );
    decorationsRef.current = cleaned;

    // 写回根节点 metadata.monaMap
    const rootWithDecorations = writeDecorations(rootMd, cleaned);
    const md = serializeMindMap(rootWithDecorations);
    lastContentRef.current = md;
    const parsed = parseMindMap(md);
    onContentChange({
      contentMarkdown: md,
      plainText: parsed.ok ? parsed.plainText : md,
    });
    const newBaseHash = computeBaseHash(md);
    updateBaseHash(note.id, newBaseHash);
  }, [note.id, onContentChange, updateBaseHash]);

  // 主题切换：通过 changeTheme 应用 palette + cssVar，refresh 重绘连线
  // auto 模式跟随系统明暗；其他模式使用预置配色（深空固定深色，其余固定浅色）
  const applyTheme = useCallback((key: MindMapThemeKey, dark: boolean) => {
    const mind = mindRef.current;
    if (!mind) return;
    const theme = resolveTheme(key, dark);
    isRefreshingRef.current = true;
    try {
      mind.changeTheme(theme, false);
      mind.refresh();
    } finally {
      isRefreshingRef.current = false;
    }
    // 主题切换后重新适应画布，避免连线偏移
    requestAnimationFrame(() => {
      mind.scaleFit();
      redrawBoundariesRef.current();
    });
  }, []);

  useEffect(() => {
    applyTheme(themeKey, isDark);
  }, [themeKey, isDark, applyTheme]);

  // 外框或其联系选中状态变化时重绘
  useEffect(() => {
    redrawBoundariesRef.current();
  }, [selectedBoundaryId, selectedBoundaryLinkId]);

  // 外框层 ResizeObserver + Delete 键删除 + 初始重绘
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 初始重绘（等节点布局完成）
    requestAnimationFrame(() => redrawBoundariesRef.current());
    // 容器尺寸变化时重绘
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => redrawBoundariesRef.current());
    });
    ro.observe(container);
    // Delete/Backspace 删除选中的外框或外框联系
    const handleKeydown = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        (selectedBoundaryId || selectedBoundaryLinkId)
      ) {
        // 避免在编辑文本时触发
        const active = document.activeElement;
        if (active && ((active as HTMLElement).isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
          return;
        }
        e.preventDefault();
        if (selectedBoundaryLinkId) handleDeleteBoundaryLinkRef.current();
        else handleDeleteBoundaryRef.current();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      ro.disconnect();
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [selectedBoundaryId, selectedBoundaryLinkId]);

  const handleThemeChange = useCallback((key: MindMapThemeKey) => {
    setThemeKey(key);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, key);
    } catch {
      // localStorage 不可用时静默忽略
    }
    applyTheme(key, isDark);
  }, [applyTheme, isDark]);

  // 滚轮/中键交互：对齐主流导图软件
  // - 普通滚轮：垂直/水平平移画布（由 deltaX/Y 决定方向）
  // - Ctrl/Cmd+滚轮：缩放（放行给 Mind Elixir 内部处理）
  // - 中键按下拖动：平移画布（按下时显示抓手光标）
  // 使用 Mind Elixir 的 move() API，保持内部 transform 状态同步，scaleFit 才能正确工作
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Ctrl/Cmd+滚轮：缩放，放行给 Mind Elixir
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const mind = mindRef.current;
      if (!mind) return;
      mind.move(-e.deltaX, -e.deltaY);
    };

    // 中键拖动平移：在 window 上监听 move/up，避免移出容器后丢失事件
    let panning = false;
    let panLastX = 0;
    let panLastY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      // button === 1：中键
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      panning = true;
      panLastX = e.clientX;
      panLastY = e.clientY;
      container.style.cursor = "grabbing";
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!panning) return;
      e.preventDefault();
      const dx = e.clientX - panLastX;
      const dy = e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      mindRef.current?.move(dx, dy);
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!panning) return;
      if (e.button === 1) e.preventDefault();
      panning = false;
      container.style.cursor = "";
    };

    container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    container.addEventListener("mousedown", handleMouseDown, { capture: true });
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    // 中键默认触发浏览器自动滚动，需要屏蔽
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    container.addEventListener("auxclick", handleAuxClick);

    return () => {
      container.removeEventListener("wheel", handleWheel, { capture: true });
      container.removeEventListener("mousedown", handleMouseDown, { capture: true });
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      container.removeEventListener("auxclick", handleAuxClick);
    };
  }, []);

  // 容器可见性恢复时重新适应画布
  // 解决：从其他页面切回时容器处于 hidden（display:none）状态，Mind Elixir 的 SVG 连线坐标计算为 0
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let prevWidth = container.offsetWidth;
    const ro = new ResizeObserver(() => {
      const w = container.offsetWidth;
      // 从 0 宽度恢复到非 0，说明从 hidden 变为可见
      if (prevWidth === 0 && w > 0) {
        const mind = mindRef.current;
        if (mind) {
          requestAnimationFrame(() => {
            mind.scaleFit();
          });
        }
      }
      prevWidth = w;
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // 工具栏操作
  const handleAddChild = useCallback(() => {
    void mindRef.current?.addChild();
  }, []);

  const handleAddSibling = useCallback(() => {
    void mindRef.current?.insertSibling("after");
  }, []);

  const handleDelete = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    void mind.removeNodes([current]);
  }, []);

  // 上移 / 下移当前节点（Mind Elixir 内置 Alt+↑/↓、PageUp/PageDown 快捷键）
  // 注：工具栏不提供按钮，用户可通过拖拽节点或快捷键移动

  // 展开当前节点
  const handleExpandNode = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    mind.expandNode(current, true);
  }, []);
  // 折叠当前节点
  const handleCollapseNode = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    mind.expandNode(current, false);
  }, []);

  // ========== 空白区域右键菜单功能 ==========

  // 全部展开：递归设置所有节点 expanded=true，然后 refresh 重新渲染
  const handleExpandAll = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const data = mind.getData().nodeData;
    const setExpanded = (node: NodeObj) => {
      if (node.children && node.children.length > 0) {
        node.expanded = true;
        node.children.forEach(setExpanded);
      }
    };
    setExpanded(data);
    mind.refresh();
    requestAnimationFrame(() => redrawBoundariesRef.current());
  }, []);

  // 全部折叠：保留根节点展开，递归设置所有非根节点 expanded=false
  const handleCollapseAll = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const data = mind.getData().nodeData;
    const setCollapsed = (node: NodeObj) => {
      if (node.children && node.children.length > 0) {
        node.children.forEach(setCollapsed);
        // 根节点保持展开，其他全部折叠
        if (node !== data) {
          node.expanded = false;
        }
      }
    };
    setCollapsed(data);
    mind.refresh();
    requestAnimationFrame(() => redrawBoundariesRef.current());
  }, []);

  // ========== 装饰功能（联系 / 外框 / 概要） ==========
  const getCommandSelectionIds = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return [];
    const current = mind.currentNodes.map((node) => node.nodeObj.id);
    const source = selectionSnapshotRef.current.length > 0
      ? selectionSnapshotRef.current
      : current;
    return [...new Set(source)];
  }, []);

  const createRelationship = useCallback(
    (from: BoundaryLinkEndpoint, to: BoundaryLinkEndpoint) => {
      const mind = mindRef.current;
      if (!mind || (from.kind === to.kind && from.id === to.id)) return;
      if (from.kind === "node" && to.kind === "node") {
        try {
          mind.createArrowFrom({ label: "联系", from: from.id, to: to.id });
          requestAnimationFrame(() => {
            const arrow = mind.currentArrow;
            if (arrow) mind.editArrowLabel(arrow);
          });
        } catch {
          // 节点可能已被并发删除，保持导图可继续编辑
        }
        return;
      }
      if (from.kind === to.kind) return;

      const link: StoredBoundaryLink = {
        id: generateDecorationId("boundary-link"),
        label: "联系",
        from,
        to,
      };
      decorationsRef.current = {
        ...decorationsRef.current,
        boundaryLinks: [...decorationsRef.current.boundaryLinks, link],
      };
      setSelectedBoundaryId(null);
      setSelectedBoundaryLinkId(link.id);
      persistCurrentMap();
      requestAnimationFrame(() => redrawBoundariesRef.current());
    },
    [persistCurrentMap],
  );
  createRelationshipRef.current = createRelationship;

  // 取消联系模式
  const cancelLinking = useCallback(() => {
    setLinkingState({ active: false, phase: "first", first: null });
  }, []);
  cancelLinkingRef.current = cancelLinking;

  // XMind：选中两个主题时直接创建；选中一个时补选目标；无选区时依次选择两个主题。
  const handleCreateLink = useCallback(() => {
    setMarqueeState({ active: false, mode: null });
    cancelLinking();
    const mind = mindRef.current;
    if (!mind) return;
    if (selectedBoundaryId) {
      mind.clearSelection();
      selectionSnapshotRef.current = [];
      setLinkingState({
        active: true,
        phase: "second",
        first: { kind: "boundary", id: selectedBoundaryId },
      });
      return;
    }
    const ids = getCommandSelectionIds();
    if (ids.length === 2) {
      createRelationship(
        { kind: "node", id: ids[0] },
        { kind: "node", id: ids[1] },
      );
      return;
    }
    if (ids.length === 1) {
      const source = mind.findEle(ids[0]);
      if (source) mind.selectNode(source, false);
      setLinkingState({
        active: true,
        phase: "second",
        first: { kind: "node", id: ids[0] },
      });
      return;
    }
    mind.clearSelection();
    selectionSnapshotRef.current = [];
    setLinkingState({ active: true, phase: "first", first: null });
  }, [
    cancelLinking,
    createRelationship,
    getCommandSelectionIds,
    selectedBoundaryId,
  ]);

  const createBoundariesForSelection = useCallback(
    (nodeIds: string[]) => {
      const mind = mindRef.current;
      if (!mind) return false;
      const root = stripParent(mind.getData().nodeData);
      const groups = groupSelectionByBranch(nodeIds, root);
      if (groups.length === 0) return false;

      const additions = groups.map((group) => ({
        id: generateDecorationId("boundary"),
        nodeIds: group.nodeIds,
      } satisfies StoredBoundary));

      decorationsRef.current = {
        ...decorationsRef.current,
        boundaries: [...decorationsRef.current.boundaries, ...additions],
      };
      persistCurrentMap();
      mind.clearSelection();
      selectionSnapshotRef.current = [];
      setSelectedBoundaryLinkId(null);
      setSelectedBoundaryId(additions[additions.length - 1].id);
      return true;
    },
    [persistCurrentMap],
  );

  const createSummariesForSelection = useCallback((nodeIds: string[]) => {
    const mind = mindRef.current;
    if (!mind) return false;
    const root = stripParent(mind.getData().nodeData);
    const groups = groupSelectionByBranch(nodeIds, root);
    if (groups.length === 0) return false;

    for (const group of groups) {
      const topics = group.nodeIds
        .map((id) => mind.findEle(id))
        .filter((topic): topic is Topic => topic !== null);
      if (topics.length === 0) continue;
      mind.clearSelection();
      mind.selectNodes(topics);
      selectionSnapshotRef.current = group.nodeIds;
      try {
        mind.createSummary();
      } catch {
        // 该分组可能在创建前已被并发修改，继续处理其他分组
      }
    }
    return true;
  }, []);

  // 已有选区时立即创建；无有效选区时再进入黑色十字框选模式。
  const handleCreateBoundary = useCallback(() => {
    cancelLinking();
    const ids = getCommandSelectionIds();
    if (createBoundariesForSelection(ids)) return;
    setMarqueeState({ active: true, mode: "boundary" });
  }, [cancelLinking, createBoundariesForSelection, getCommandSelectionIds]);

  const handleCreateSummary = useCallback(() => {
    cancelLinking();
    const ids = getCommandSelectionIds();
    if (createSummariesForSelection(ids)) return;
    setMarqueeState({ active: true, mode: "summary" });
  }, [cancelLinking, createSummariesForSelection, getCommandSelectionIds]);

  // 删除当前选中的外框
  const handleDeleteBoundary = useCallback(() => {
    if (!selectedBoundaryId) return;
    decorationsRef.current = {
      ...decorationsRef.current,
      boundaries: decorationsRef.current.boundaries.filter(
        (b) => b.id !== selectedBoundaryId,
      ),
    };
    setSelectedBoundaryId(null);
    setSelectedBoundaryLinkId(null);
    persistCurrentMap();
  }, [selectedBoundaryId, persistCurrentMap]);
  // 保持 ref 最新，供 boundary useEffect 中的 keydown listener 调用
  handleDeleteBoundaryRef.current = handleDeleteBoundary;

  const handleDeleteBoundaryLink = useCallback(() => {
    if (!selectedBoundaryLinkId) return;
    decorationsRef.current = {
      ...decorationsRef.current,
      boundaryLinks: decorationsRef.current.boundaryLinks.filter(
        (link) => link.id !== selectedBoundaryLinkId,
      ),
    };
    setSelectedBoundaryLinkId(null);
    persistCurrentMap();
  }, [selectedBoundaryLinkId, persistCurrentMap]);
  handleDeleteBoundaryLinkRef.current = handleDeleteBoundaryLink;

  // 根据框选矩形收集主题；不能使用 wrapper，否则父主题的子树区域会被误选。
  const collectNodesInRect = useCallback((rect: DOMRect): string[] => {
    const container = containerRef.current;
    if (!container) return [];
    const topics = container.querySelectorAll("me-tpc");
    const ids: string[] = [];
    topics.forEach((topic) => {
      const topicRect = topic.getBoundingClientRect();
      const intersects =
        topicRect.left < rect.right &&
        topicRect.right > rect.left &&
        topicRect.top < rect.bottom &&
        topicRect.bottom > rect.top;
      if (!intersects) return;
      const id = (topic as unknown as { nodeObj?: { id: string } }).nodeObj?.id;
      if (id) ids.push(id);
    });
    return ids;
  }, []);

  // 框选完成后，根据模式创建外框或概要
  const finishMarquee = useCallback(
    (rect: DOMRect) => {
      const mind = mindRef.current;
      if (!mind) return;
      const mode = marqueeState.mode;
      const ids = collectNodesInRect(rect);
      setMarqueeState({ active: false, mode: null });
      if (ids.length === 0) return;
      if (mode === "boundary") {
        createBoundariesForSelection(ids);
      } else if (mode === "summary") {
        createSummariesForSelection(ids);
      }
    },
    [
      marqueeState.mode,
      collectNodesInRect,
      createBoundariesForSelection,
      createSummariesForSelection,
    ],
  );
  // 保持 ref 最新，供 marquee useEffect 中的事件 listener 调用
  finishMarqueeRef.current = finishMarquee;

  // XMind 快捷键：联系 Ctrl/Cmd+Shift+R；外框 Windows Ctrl+B、macOS Cmd+Shift+B。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleKeydown = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.("input, textarea, [contenteditable='true']")) return;
      const key = e.key.toLowerCase();
      const isMac = navigator.userAgent.includes("Mac");
      const relationshipShortcut =
        key === "r" && e.shiftKey && (isMac ? e.metaKey : e.ctrlKey);
      const boundaryShortcut =
        key === "b" &&
        (isMac ? e.metaKey && e.shiftKey : e.ctrlKey && !e.shiftKey);
      if (!relationshipShortcut && !boundaryShortcut) return;
      e.preventDefault();
      e.stopPropagation();
      if (relationshipShortcut) handleCreateLink();
      else handleCreateBoundary();
    };
    container.addEventListener("keydown", handleKeydown, true);
    return () => container.removeEventListener("keydown", handleKeydown, true);
  }, [handleCreateBoundary, handleCreateLink]);

  const startBoundaryResize = useCallback(
    (boundaryId: string, edge: "top" | "bottom", event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      boundaryResizeCleanupRef.current?.();

      const mind = mindRef.current;
      const boundary = decorationsRef.current.boundaries.find((b) => b.id === boundaryId);
      if (!mind || !boundary) return;
      const root = stripParent(mind.getData().nodeData);
      const range = validateSelection(boundary.nodeIds, root);
      if (!range.valid || !range.parentId || range.indices.length === 0) return;
      const parent = findNodeById(root, range.parentId);
      if (!parent) return;

      const candidates = parent.children
        .map((node, index) => {
          const topic = mind.findEle(node.id);
          if (!topic) return null;
          const rect = topic.getBoundingClientRect();
          return { index, centerY: rect.top + rect.height / 2 };
        })
        .filter((item): item is { index: number; centerY: number } => item !== null);
      if (candidates.length === 0) return;

      let start = range.indices[0];
      let end = range.indices[range.indices.length - 1];
      let changed = false;
      const pointerId = event.pointerId;
      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const nearest = candidates.reduce((best, candidate) =>
          Math.abs(candidate.centerY - moveEvent.clientY) <
          Math.abs(best.centerY - moveEvent.clientY)
            ? candidate
            : best,
        );
        const nextStart = edge === "top" ? Math.min(nearest.index, end) : start;
        const nextEnd = edge === "bottom" ? Math.max(nearest.index, start) : end;
        if (nextStart === start && nextEnd === end) return;
        start = nextStart;
        end = nextEnd;
        changed = true;
        decorationsRef.current = {
          ...decorationsRef.current,
          boundaries: decorationsRef.current.boundaries.map((item) =>
            item.id === boundaryId
              ? {
                  ...item,
                  nodeIds: parent.children.slice(start, end + 1).map((node) => node.id),
                }
              : item,
          ),
        };
        redrawBoundariesRef.current();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        boundaryResizeCleanupRef.current = null;
      };
      const handleUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        if (changed) persistCurrentMap();
      };
      window.addEventListener("pointermove", handleMove, { passive: false });
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      boundaryResizeCleanupRef.current = cleanup;
    },
    [persistCurrentMap],
  );

  const startBoundaryLinkReshape = useCallback(
    (
      linkId: string,
      field: "delta1" | "delta2",
      endpointCenter: { x: number; y: number },
      event: PointerEvent,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      boundaryResizeCleanupRef.current?.();
      const pointerId = event.pointerId;
      let changed = false;
      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const layer = boundaryLayerRef.current;
        const mind = mindRef.current;
        if (!layer || !mind) return;
        const layerRect = layer.getBoundingClientRect();
        const scale = mind.scaleVal || 1;
        const point = {
          x: (moveEvent.clientX - layerRect.left) / scale,
          y: (moveEvent.clientY - layerRect.top) / scale,
        };
        changed = true;
        decorationsRef.current = {
          ...decorationsRef.current,
          boundaryLinks: decorationsRef.current.boundaryLinks.map((link) =>
            link.id === linkId
              ? {
                  ...link,
                  [field]: {
                    x: point.x - endpointCenter.x,
                    y: point.y - endpointCenter.y,
                  },
                }
              : link,
          ),
        };
        redrawBoundariesRef.current();
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        boundaryResizeCleanupRef.current = null;
      };
      const handleUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        if (changed) persistCurrentMap();
      };
      window.addEventListener("pointermove", handleMove, { passive: false });
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
      boundaryResizeCleanupRef.current = cleanup;
    },
    [persistCurrentMap],
  );

  // 外框重绘：绘制外框、上下范围手柄，以及外框—节点联系
  const redrawBoundaries = useCallback(() => {
    const mind = mindRef.current;
    const layer = boundaryLayerRef.current;
    if (!mind || !layer) return;
    const boundaries = decorationsRef.current.boundaries;
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    const layerRect = layer.getBoundingClientRect();
    const scale = mind.scaleVal || 1;
    const padding = 8;
    const boundaryRects = new Map<string, DOMRect>();

    for (const b of boundaries) {
      const rects: DOMRect[] = [];
      for (const id of b.nodeIds) {
        try {
          const tpc = mind.findEle(id);
          const wrapper = tpc.parentElement?.parentElement;
          if (!wrapper) continue;
          rects.push(wrapper.getBoundingClientRect());
        } catch {
          // 节点可能刚被删除，下一次保存会清理引用
        }
      }
      if (rects.length === 0) continue;

      const minX = Math.min(...rects.map((r) => r.left));
      const minY = Math.min(...rects.map((r) => r.top));
      const maxX = Math.max(...rects.map((r) => r.right));
      const maxY = Math.max(...rects.map((r) => r.bottom));
      boundaryRects.set(
        b.id,
        new DOMRect(
          minX - padding * scale,
          minY - padding * scale,
          maxX - minX + padding * 2 * scale,
          maxY - minY + padding * 2 * scale,
        ),
      );
    }

    const edgePoint = (rect: DOMRect, toward: { x: number; y: number }) => {
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const dx = toward.x - center.x;
      const dy = toward.y - center.y;
      const factor =
        1 /
        Math.max(
          Math.abs(dx) / Math.max(rect.width / 2, 1),
          Math.abs(dy) / Math.max(rect.height / 2, 1),
          1e-6,
        );
      return { x: center.x + dx * factor, y: center.y + dy * factor };
    };
    const toLayer = (point: { x: number; y: number }) => ({
      x: (point.x - layerRect.left) / scale,
      y: (point.y - layerRect.top) / scale,
    });

    for (const link of decorationsRef.current.boundaryLinks) {
      const endpointRect = (endpoint: BoundaryLinkEndpoint): DOMRect | null => {
        if (endpoint.kind === "boundary") return boundaryRects.get(endpoint.id) ?? null;
        return mind.findEle(endpoint.id)?.getBoundingClientRect() ?? null;
      };
      const fromRect = endpointRect(link.from);
      const toRect = endpointRect(link.to);
      if (!fromRect || !toRect) continue;
      const fromCenter = {
        x: fromRect.left + fromRect.width / 2,
        y: fromRect.top + fromRect.height / 2,
      };
      const toCenter = {
        x: toRect.left + toRect.width / 2,
        y: toRect.top + toRect.height / 2,
      };
      const fromCenterInLayer = toLayer(fromCenter);
      const toCenterInLayer = toLayer(toCenter);
      const dx = toCenterInLayer.x - fromCenterInLayer.x;
      const dy = toCenterInLayer.y - fromCenterInLayer.y;
      const distance = Math.hypot(dx, dy);
      const bend = Math.max(45, Math.min(100, distance * 0.2));
      const normal =
        Math.abs(dx) >= Math.abs(dy) ? { x: 0, y: -1 } : { x: 1, y: 0 };
      const defaultControl1 = {
        x: fromCenterInLayer.x + dx * 0.25 + normal.x * bend,
        y: fromCenterInLayer.y + dy * 0.25 + normal.y * bend,
      };
      const defaultControl2 = {
        x: toCenterInLayer.x - dx * 0.25 + normal.x * bend,
        y: toCenterInLayer.y - dy * 0.25 + normal.y * bend,
      };
      const control1 = link.delta1
        ? {
            x: fromCenterInLayer.x + link.delta1.x,
            y: fromCenterInLayer.y + link.delta1.y,
          }
        : defaultControl1;
      const control2 = link.delta2
        ? {
            x: toCenterInLayer.x + link.delta2.x,
            y: toCenterInLayer.y + link.delta2.y,
          }
        : defaultControl2;
      const toScreen = (point: { x: number; y: number }) => ({
        x: layerRect.left + point.x * scale,
        y: layerRect.top + point.y * scale,
      });
      const from = toLayer(edgePoint(fromRect, toScreen(control1)));
      const to = toLayer(edgePoint(toRect, toScreen(control2)));
      const pathData =
        `M ${from.x} ${from.y} ` +
        `C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${to.x} ${to.y}`;
      const angle = Math.atan2(to.y - control2.y, to.x - control2.x);
      const arrowLength = 10;
      const arrowSpread = Math.PI / 6;
      const arrowStart = {
        x: to.x - arrowLength * Math.cos(angle - arrowSpread),
        y: to.y - arrowLength * Math.sin(angle - arrowSpread),
      };
      const arrowEnd = {
        x: to.x - arrowLength * Math.cos(angle + arrowSpread),
        y: to.y - arrowLength * Math.sin(angle + arrowSpread),
      };
      const arrowData =
        `M ${arrowStart.x} ${arrowStart.y} ` +
        `L ${to.x} ${to.y} L ${arrowEnd.x} ${arrowEnd.y}`;
      const selected = selectedBoundaryLinkId === link.id;
      const selectLink = (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        mind.clearSelection();
        selectionSnapshotRef.current = [];
        setSelectedBoundaryId(null);
        setSelectedBoundaryLinkId(link.id);
      };
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.dataset.boundaryLinkId = link.id;
      group.style.cursor = "pointer";
      group.style.pointerEvents = "stroke";
      group.addEventListener("pointerdown", selectLink);

      const addPath = (
        d: string,
        stroke: string,
        strokeWidth: string,
        dash?: string,
        opacity?: string,
      ) => {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", stroke);
        path.setAttribute("stroke-width", strokeWidth);
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        if (dash) path.setAttribute("stroke-dasharray", dash);
        if (opacity) path.setAttribute("opacity", opacity);
        group.appendChild(path);
      };
      if (selected) {
        addPath(pathData, "#4dc4ff", "6", undefined, "0.45");
        addPath(arrowData, "#4dc4ff", "6", undefined, "0.45");
        addPath(
          `M ${from.x} ${from.y} L ${control1.x} ${control1.y}`,
          "#4dc4ff",
          "2",
          undefined,
          "0.45",
        );
        addPath(
          `M ${control2.x} ${control2.y} L ${to.x} ${to.y}`,
          "#4dc4ff",
          "2",
          undefined,
          "0.45",
        );
      }
      addPath(pathData, "transparent", "15");
      addPath(arrowData, "transparent", "15");
      addPath(pathData, "rgb(227, 125, 116)", "2", "8,2");
      addPath(arrowData, "rgb(227, 125, 116)", "2");
      layer.appendChild(group);

      if (link.label) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        const labelX =
          from.x / 8 + control1.x * 3 / 8 + control2.x * 3 / 8 + to.x / 8;
        const labelY =
          from.y / 8 + control1.y * 3 / 8 + control2.y * 3 / 8 + to.y / 8;
        label.setAttribute("x", String(labelX));
        label.setAttribute("y", String(labelY - 5));
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("font-size", "14");
        label.setAttribute("fill", "rgb(235, 95, 82)");
        label.setAttribute("stroke", "var(--main-bgcolor-transparent)");
        label.setAttribute("stroke-width", "5");
        label.setAttribute("paint-order", "stroke");
        label.textContent = link.label;
        label.dataset.boundaryLinkId = link.id;
        label.style.cursor = "pointer";
        label.style.pointerEvents = "all";
        label.addEventListener("pointerdown", selectLink);
        group.appendChild(label);
      }
      if (selected) {
        for (const [field, point, center] of [
          ["delta1", control1, fromCenterInLayer],
          ["delta2", control2, toCenterInLayer],
        ] as const) {
          const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          handle.setAttribute("cx", String(point.x));
          handle.setAttribute("cy", String(point.y));
          handle.setAttribute("r", "5");
          handle.setAttribute("fill", "#757575");
          handle.setAttribute("stroke", "#fff");
          handle.setAttribute("stroke-width", "2");
          handle.dataset.boundaryLinkHandle = field;
          handle.style.cursor = "move";
          handle.style.pointerEvents = "all";
          handle.style.touchAction = "none";
          handle.addEventListener("pointerdown", (event) =>
            startBoundaryLinkReshape(link.id, field, center, event),
          );
          group.appendChild(handle);
        }
      }
    }

    for (const b of boundaries) {
      const screenRect = boundaryRects.get(b.id);
      if (!screenRect) continue;
      const x = (screenRect.left - layerRect.left) / scale;
      const y = (screenRect.top - layerRect.top) / scale;
      const width = screenRect.width / scale;
      const height = screenRect.height / scale;
      const selected = selectedBoundaryId === b.id;

      // 透明填充层：让整个外框矩形区域都能响应点击，不受虚线间隙影响
      const hitRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      hitRect.setAttribute("x", String(x));
      hitRect.setAttribute("y", String(y));
      hitRect.setAttribute("width", String(width));
      hitRect.setAttribute("height", String(height));
      hitRect.setAttribute("rx", "6");
      hitRect.setAttribute("ry", "6");
      hitRect.setAttribute("fill", "transparent");
      hitRect.style.cursor = "pointer";
      hitRect.style.pointerEvents = "all";
      hitRect.dataset.boundaryId = b.id;
      hitRect.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      hitRect.addEventListener("click", (e) => {
        e.stopPropagation();
        mind.clearSelection();
        selectionSnapshotRef.current = [];
        setSelectedBoundaryLinkId(null);
        setSelectedBoundaryId(b.id);
      });
      layer.appendChild(hitRect);

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(width));
      rect.setAttribute("height", String(height));
      rect.setAttribute("rx", "6");
      rect.setAttribute("ry", "6");
      rect.setAttribute("fill", selected ? "hsl(var(--primary) / 0.06)" : "none");
      rect.setAttribute(
        "stroke",
        selected ? "hsl(var(--primary))" : "hsl(var(--muted-foreground) / 0.5)",
      );
      rect.setAttribute("stroke-width", selected ? "2" : "1.5");
      rect.setAttribute("stroke-dasharray", "4 3");
      rect.style.pointerEvents = "none";
      layer.appendChild(rect);

      const range = validateSelection(b.nodeIds, stripParent(mind.getData().nodeData));
      if (!selected || !range.valid) continue;
      for (const edge of ["top", "bottom"] as const) {
        const edgeY = edge === "top" ? y : y + height;
        const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "line");
        hitArea.setAttribute("x1", String(x + 6));
        hitArea.setAttribute("x2", String(x + width - 6));
        hitArea.setAttribute("y1", String(edgeY));
        hitArea.setAttribute("y2", String(edgeY));
        hitArea.setAttribute("stroke", "transparent");
        hitArea.setAttribute("stroke-width", "14");
        hitArea.dataset.boundaryId = b.id;
        hitArea.dataset.boundaryHandle = edge;
        hitArea.style.cursor = "ns-resize";
        hitArea.style.pointerEvents = "stroke";
        hitArea.style.touchAction = "none";
        hitArea.addEventListener("pointerdown", (event) =>
          startBoundaryResize(b.id, edge, event),
        );
        layer.appendChild(hitArea);

        const handle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        handle.setAttribute("x", String(x + width / 2 - 12));
        handle.setAttribute("y", String(edge === "top" ? y - 3 : y + height - 2));
        handle.setAttribute("width", "24");
        handle.setAttribute("height", "5");
        handle.setAttribute("rx", "2.5");
        handle.setAttribute("fill", "hsl(var(--primary))");
        handle.dataset.boundaryId = b.id;
        handle.dataset.boundaryHandle = edge;
        handle.style.cursor = "ns-resize";
        handle.style.pointerEvents = "none";
        layer.appendChild(handle);
      }
    }
  }, [
    selectedBoundaryId,
    selectedBoundaryLinkId,
    startBoundaryLinkReshape,
    startBoundaryResize,
  ]);
  // 保持 ref 最新，供 init useEffect 中的事件 listener 调用
  redrawBoundariesRef.current = redrawBoundaries;

  // ========== 剪贴板操作（复制 / 剪切 / 粘贴） ==========
  // 内部剪贴板：保存最近一次复制/剪切的子树（Markdown 文本）
  // 同时写入系统剪贴板，支持跨应用粘贴
  const internalClipboardRef = useRef<string>("");

  // 复制当前选中节点（支持多选）
  const handleCopy = useCallback(async () => {
    const mind = mindRef.current;
    if (!mind) return;
    const nodes = mind.currentNodes;
    if (nodes.length === 0) return;
    // 将选中节点序列化为 Markdown
    // 如果只选一个，序列化该节点（含子树）
    // 如果选多个，构造一个临时根，把所有选中节点作为子节点
    let md: string;
    if (nodes.length === 1) {
      md = serializeMindMap(stripParent(nodes[0].nodeObj));
    } else {
      const tempRoot: MindMapNode = {
        id: "clipboard-root",
        topic: "剪贴板",
        children: nodes.map(t => stripParent(t.nodeObj)),
      };
      md = serializeMindMap(tempRoot);
    }
    internalClipboardRef.current = md;
    try {
      await navigator.clipboard?.writeText(md);
    } catch {
      // 系统剪贴板不可用时静默降级到内部剪贴板
    }
  }, []);

  // 剪切：复制 + 删除原节点
  const handleCut = useCallback(async () => {
    const mind = mindRef.current;
    if (!mind) return;
    const nodes = mind.currentNodes;
    if (nodes.length === 0) return;
    // 过滤根节点（不允许剪切根）
    const rootId = mind.nodeData.id;
    const candidates = nodes.filter(t => t.nodeObj.id !== rootId);
    if (candidates.length === 0) return;

    // 先复制
    let md: string;
    if (candidates.length === 1) {
      md = serializeMindMap(stripParent(candidates[0].nodeObj));
    } else {
      const tempRoot: MindMapNode = {
        id: "clipboard-root",
        topic: "剪贴板",
        children: candidates.map(t => stripParent(t.nodeObj)),
      };
      md = serializeMindMap(tempRoot);
    }
    internalClipboardRef.current = md;
    try {
      await navigator.clipboard?.writeText(md);
    } catch {
      // 静默降级
    }

    // 再删除（去重祖先-子孙关系，避免删除祖先时子孙已被移除）
    const ids = new Set(candidates.map(t => t.nodeObj.id));
    const deduped: Topic[] = [];
    for (const tpc of candidates) {
      let isDescendantOfAnother = false;
      let parent = tpc.nodeObj.parent;
      while (parent) {
        if (ids.has(parent.id)) {
          isDescendantOfAnother = true;
          break;
        }
        parent = parent.parent;
      }
      if (!isDescendantOfAnother) deduped.push(tpc);
    }
    if (deduped.length > 0) {
      void mind.removeNodes(deduped);
    }
  }, []);

  // 粘贴：从内部剪贴板读取，追加为当前选中节点的子节点
  const handlePaste = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    const md = internalClipboardRef.current;
    if (!md) return;
    const parsed = parseMindMap(md);
    if (!parsed.ok) return;
    // 将解析出的子节点追加为当前节点的子节点
    for (const child of parsed.root.children) {
      void mind.addChild(current, cloneNode(child));
    }
  }, []);

  // 撤销 / 重做
  const handleUndo = useCallback(() => {
    mindRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    mindRef.current?.redo();
  }, []);

  const handleFit = useCallback(() => {
    mindRef.current?.scaleFit();
    // 适应画布后同步缩放显示
    requestAnimationFrame(() => {
      const mind = mindRef.current;
      if (mind) setZoomPercent(Math.round(mind.scaleVal * 100));
    });
  }, []);

  // 缩放控制：放大 / 缩小 / 重置
  const handleZoomIn = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const next = Math.min(mind.scaleVal * 1.2, mind.scaleMax ?? 4);
    mind.scale(next);
    setZoomPercent(Math.round(next * 100));
  }, []);

  const handleZoomOut = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const next = Math.max(mind.scaleVal / 1.2, mind.scaleMin ?? 0.2);
    mind.scale(next);
    setZoomPercent(Math.round(next * 100));
  }, []);

  const handleZoomReset = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    mind.scale(1);
    setZoomPercent(100);
  }, []);

  // 上移 / 下移当前节点（同级排序）
  const handleMoveUp = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    void mind.moveUpNode(current);
  }, []);

  const handleMoveDown = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    void mind.moveDownNode(current);
  }, []);

  // 编辑节点属性（标签/备注/超链接）
  const handleEditProperty = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    const obj = current.nodeObj;
    setNodePropertyData({
      nodeId: obj.id,
      topic: obj.topic,
      tags: Array.isArray(obj.tags) ? obj.tags.map((t) => (typeof t === "string" ? t : t.text)) : [],
      note: obj.note ?? "",
      hyperLink: obj.hyperLink ?? "",
    });
    setNodePropertyOpen(true);
  }, []);

  // 应用节点属性变更
  const handleApplyProperty = useCallback((nodeId: string, patch: Partial<NodePropertyData>) => {
    const mind = mindRef.current;
    if (!mind) return;
    const el = mind.findEle(nodeId);
    if (!el) return;
    const reshape: Partial<NodeObj> = {};
    if (patch.tags !== undefined) reshape.tags = patch.tags;
    if (patch.note !== undefined) reshape.note = patch.note;
    if (patch.hyperLink !== undefined) reshape.hyperLink = patch.hyperLink || undefined;
    void mind.reshapeNode(el, reshape);
  }, []);

  // 导出 PNG：Mind Elixir 5.14.0 的 exportPng() 返回 Blob | null
  // 浏览器模式回退到 <a download>，桌面端走 Tauri save 对话框
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const handleExportPng = useCallback(async () => {
    const mind = mindRef.current;
    if (!mind || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const blob = await mind.exportPng();
      if (!blob) {
        setExportError("导出失败：编辑器未返回图像数据");
        return;
      }
      const blobUrl = URL.createObjectURL(blob);
      const safeTitle = (note.title || "mindmap").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
      try {
        await downloadMediaUrl(blobUrl, `${safeTitle}.png`);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (err) {
      setExportError(err instanceof Error ? `导出失败：${err.message}` : "导出失败");
    } finally {
      setExporting(false);
    }
  }, [exporting, note.title]);

  // 导出 FreeMind (.mm)（FreeMind/Freeplane/XMind 可打开）
  const handleExportFreemind = useCallback(async () => {
    const result = parseMindMap(note.contentMarkdown);
    if (!result.ok) {
      setExportError("导出失败：导图内容解析错误");
      return;
    }
    const xml = exportToFreemind(result.root);
    try {
      await downloadTextFile(xml, `${safeFileName(note.title)}.mm`, "application/x-freemind");
    } catch (err) {
      setExportError(err instanceof Error ? `导出失败：${err.message}` : "导出失败");
    }
  }, [note.contentMarkdown, note.title]);

  // 监听画布列表右键菜单的导出事件（仅响应当前 noteId，format 区分格式）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ noteId: string; format: string }>).detail;
      if (detail?.noteId !== note.id) return;
      if (detail.format === "freemind") {
        void handleExportFreemind();
      } else {
        // 默认 PNG
        void handleExportPng();
      }
    };
    window.addEventListener("mona:canvas-export", handler);
    return () => window.removeEventListener("mona:canvas-export", handler);
  }, [note.id, handleExportPng, handleExportFreemind]);

  // ========== 查找与替换 ==========
  // 清除所有查找高亮（恢复 textContent，避免残留 span）
  const clearFindHighlight = useCallback(() => {
    const highlights = document.querySelectorAll(".mindmap-find-highlight");
    highlights.forEach((span) => {
      const parent = span.parentElement;
      if (!parent) return;
      // 把高亮 span 的文本合并回父元素
      const text = span.textContent || "";
      span.replaceWith(document.createTextNode(text));
      // normalize 合并相邻文本节点
      parent.normalize();
    });
  }, []);

  // 在指定节点文本上应用高亮
  const applyHighlight = useCallback((el: Topic, match: SearchMatch) => {
    const textEl = el.text;
    if (!textEl) return;
    const text = textEl.textContent || "";
    // 校验偏移仍然有效（节点可能在替换后变化）
    if (match.start < 0 || match.end > text.length || match.start >= match.end) return;
    const before = text.slice(0, match.start);
    const highlighted = document.createElement("span");
    highlighted.className = "mindmap-find-highlight";
    highlighted.textContent = text.slice(match.start, match.end);
    const after = text.slice(match.end);
    textEl.textContent = "";
    textEl.appendChild(document.createTextNode(before));
    textEl.appendChild(highlighted);
    textEl.appendChild(document.createTextNode(after));
  }, []);

  // 定位到指定匹配节点：展开祖先、选中、滚动、高亮
  const navigateToMatch = useCallback((match: SearchMatch) => {
    const mind = mindRef.current;
    if (!mind) return;

    // 先清除所有现有高亮
    clearFindHighlight();

    // 通过路径展开所有祖先节点（折叠分支也能定位）
    // 直接使用 NodeObj（保留 expanded 字段），无需 stripParent
    const root = mind.getData().nodeData;
    const path = findPathToNode(root, match.nodeId);
    if (path && path.length > 0) {
      let current: NodeObj = root;
      for (let i = 0; i < path.length - 1; i++) {
        const childIdx = path[i];
        const child = current.children?.[childIdx];
        if (child && !child.expanded) {
          const childEl = mind.findEle(child.id);
          if (childEl) mind.expandNode(childEl, true);
        }
        if (child) current = child;
      }
    }

    // 等下一帧再选中、滚动、高亮，确保展开后的布局已生效
    requestAnimationFrame(() => {
      const el = mind.findEle(match.nodeId);
      if (!el) return;
      mind.selectNode(el);
      mind.scrollIntoView(el, true);
      // 再等一帧应用高亮，避免被 selectNode 的渲染覆盖
      requestAnimationFrame(() => applyHighlight(el, match));
    });
  }, [applyHighlight, clearFindHighlight]);

  // 执行搜索：从当前导图数据中查找匹配节点
  const runSearch = useCallback((query: string, caseSensitive: boolean) => {
    if (!query) {
      clearFindHighlight();
      setFindMatches([]);
      setFindIndex(-1);
      return;
    }
    const mind = mindRef.current;
    if (!mind) return;
    const root = stripParent(mind.getData().nodeData);
    const matches = searchInTree(root, query, { caseSensitive });
    setFindMatches(matches);
    setFindIndex(matches.length > 0 ? 0 : -1);
    // 定位到第一个匹配
    if (matches.length > 0) {
      navigateToMatch(matches[0]);
    } else {
      clearFindHighlight();
    }
  }, [clearFindHighlight, navigateToMatch]);

  // 上一个 / 下一个
  const handleNavigate = useCallback((direction: "prev" | "next") => {
    const matches = findMatchesRef.current;
    if (matches.length === 0) return;
    const cur = findIndexRef.current;
    let next: number;
    if (direction === "next") {
      next = cur + 1 >= matches.length ? 0 : cur + 1;
    } else {
      next = cur - 1 < 0 ? matches.length - 1 : cur - 1;
    }
    setFindIndex(next);
    navigateToMatch(matches[next]);
  }, [navigateToMatch]);

  // 替换当前匹配：使用 setNodeTopic 修改当前匹配的节点
  const handleReplace = useCallback((replacement: string) => {
    const mind = mindRef.current;
    if (!mind) return;
    const matches = findMatchesRef.current;
    const cur = findIndexRef.current;
    if (cur < 0 || cur >= matches.length) return;
    const match = matches[cur];
    const el = mind.findEle(match.nodeId);
    if (!el) return;
    // 替换当前节点中第一个匹配
    const newTopic = match.topic.slice(0, match.start) + replacement + match.topic.slice(match.end);
    void mind.setNodeTopic(el, newTopic);
    // 重新搜索（operation 事件会触发内容保存）
    // 延迟一帧等 Mind Elixir 内部状态更新后再重新搜索
    requestAnimationFrame(() => {
      const query = matches.length > 0 ? match.topic.slice(match.start, match.end) : "";
      if (query) {
        const root = stripParent(mind.getData().nodeData);
        const newMatches = searchInTree(root, query, { caseSensitive: false });
        setFindMatches(newMatches);
        const newIdx = newMatches.length > 0 ? Math.min(cur, newMatches.length - 1) : -1;
        setFindIndex(newIdx);
        if (newIdx >= 0) navigateToMatch(newMatches[newIdx]);
      }
    });
  }, [navigateToMatch]);

  // 全部替换：生成变更集，一次性应用
  const handleReplaceAll = useCallback((replacement: string) => {
    const mind = mindRef.current;
    if (!mind) return;
    const matches = findMatchesRef.current;
    if (matches.length === 0) return;
    const root = stripParent(mind.getData().nodeData);
    // 取当前查询文本（从第一个匹配中提取）
    const query = matches[0].topic.slice(matches[0].start, matches[0].end);
    const changes = computeReplaceAllChanges(root, query, replacement, { caseSensitive: false });
    // 逐个应用变更
    for (const change of changes) {
      const el = mind.findEle(change.nodeId);
      if (el) {
        void mind.setNodeTopic(el, change.newTopic);
      }
    }
    // 清除高亮并清空匹配状态
    clearFindHighlight();
    setFindMatches([]);
    setFindIndex(-1);
  }, [clearFindHighlight]);

  // Ctrl+F 打开查找面板；Ctrl+/-/0 缩放控制
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        setShowFindPanel(true);
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomIn();
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        handleZoomReset();
      }
    };
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [handleZoomIn, handleZoomOut, handleZoomReset]);

  // 监听滚轮缩放同步 zoomPercent（Mind Elixir 内部处理滚轮缩放，这里只读结果）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const syncZoom = () => {
      const mind = mindRef.current;
      if (mind) setZoomPercent(Math.round(mind.scaleVal * 100));
    };
    const onWheel = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncZoom();
      });
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const mindMapBridge = useMindMapBridge();

  // 选中并居中到指定节点（供右侧大纲面板调用）
  const handleSelectNode = useCallback((nodeId: string) => {
    const mind = mindRef.current;
    const container = containerRef.current;
    if (!mind || !container) return;
    // Mind Elixir 在 me-tpc 元素上存储 data-nodeid="me<id>"
    const tpc = container.querySelector<HTMLElement>(`[data-nodeid="me${nodeId}"]`);
    if (!tpc) return;
    // selectNode 期望 Topic 类型，但通过 data-nodeid 查询得到的是 HTMLElement；
    // Mind Elixir 运行时接受 HTMLElement，这里做类型断言绕过 TS 检查
    mind.selectNode(tpc as unknown as Topic);
  }, []);

  // 暴露给父组件
  useImperativeHandle(ref, () => ({ selectNode: handleSelectNode }), [handleSelectNode]);

  // 注册到 bridge，供 RightSidebar 大纲面板调用
  useEffect(() => {
    if (!mindMapBridge) return;
    mindMapBridge.current = handleSelectNode;
    return () => {
      if (mindMapBridge.current === handleSelectNode) {
        mindMapBridge.current = null;
      }
    };
  }, [mindMapBridge, handleSelectNode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-editor-surface">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1.5">
        {toolbarLeading ? (
          <>
            {toolbarLeading}
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        ) : null}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleUndo} title="撤销">
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRedo} title="重做">
          <Redo2 className="h-3.5 w-3.5" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button variant="ghost" size="sm" className="h-7 px-2 text-caption" onClick={handleAddChild}>
          <CornerDownRight className="mr-1 h-3.5 w-3.5" />
          子节点
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-caption" onClick={handleAddSibling}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          同级
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 查找 */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setShowFindPanel(true)}
          title="查找与替换 (Ctrl+F)"
          aria-label="查找与替换"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>

        <div className="flex-1" />

        {/* 缩放控制：百分比点击重置，配合滚轮缩放与 Ctrl+0 快捷键 */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 min-w-[48px] px-1 text-caption tabular-nums"
            onClick={handleZoomReset}
            title="重置缩放 (Ctrl+0)"
          >
            {zoomPercent}%
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleFit}
            title="适应画布"
            aria-label="适应画布"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="mx-1 h-4 w-px bg-border" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="配色方案"
            >
              <Palette className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuRadioGroup
              value={themeKey}
              onValueChange={(v) => handleThemeChange(v as MindMapThemeKey)}
            >
              <DropdownMenuRadioItem value="auto" className="text-xs">
                默认
              </DropdownMenuRadioItem>
              {MINDMAP_THEME_PRESETS.map(preset => (
                <DropdownMenuRadioItem key={preset.key} value={preset.key} className="text-xs">
                  <span
                    className="mr-2 inline-block h-3 w-3 rounded-full border border-border/60"
                    style={{ backgroundColor: preset.swatch }}
                    aria-hidden
                  />
                  {preset.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={exporting}
              title="导出"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem className="text-xs" onClick={handleExportPng}>
              导出 PNG 图片
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={handleExportFreemind}>
              导出 FreeMind (.mm)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {toolbarExtra}
      </div>

      {/* 错误提示 */}
      {parseError && (
        <div className="bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {parseError}
        </div>
      )}
      {exportError && (
        <div className="bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {exportError}
        </div>
      )}

      {/* 编辑区域 */}
      <div className="relative min-h-0 flex-1">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={containerRef}
              className={`mindmap-container absolute inset-0 overflow-auto bg-editor-surface scrollbar-hover ${marqueeState.active ? "mindmap-marquee-active" : ""}`}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            {contextMenuTarget === "node" ? (
              <>
                <ContextMenuItem onClick={handleAddChild}>
                  <CornerDownRight className="mr-2 h-4 w-4" />
                  插入子节点
                </ContextMenuItem>
                <ContextMenuItem onClick={handleAddSibling}>
                  <Plus className="mr-2 h-4 w-4" />
                  插入同级节点
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleCopy}>
                  <Copy className="mr-2 h-4 w-4" />
                  复制
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCut}>
                  <Scissors className="mr-2 h-4 w-4" />
                  剪切
                </ContextMenuItem>
                <ContextMenuItem onClick={handlePaste}>
                  <ClipboardPaste className="mr-2 h-4 w-4" />
                  粘贴
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleExpandNode}>
                  <ChevronsUpDown className="mr-2 h-4 w-4" />
                  展开此节点
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCollapseNode}>
                  <ChevronsDownUp className="mr-2 h-4 w-4" />
                  折叠此节点
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleMoveUp}>
                  <ArrowUp className="mr-2 h-4 w-4" />
                  上移
                </ContextMenuItem>
                <ContextMenuItem onClick={handleMoveDown}>
                  <ArrowDown className="mr-2 h-4 w-4" />
                  下移
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleEditProperty}>
                  <Tag className="mr-2 h-4 w-4" />
                  属性（标签/备注/链接）
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除节点
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem onClick={handleCreateLink}>
                  <GitBranch className="mr-2 h-4 w-4" />
                  联系
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCreateBoundary}>
                  <Square className="mr-2 h-4 w-4" />
                  外框
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCreateSummary}>
                  <Brackets className="mr-2 h-4 w-4" />
                  概要
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handlePaste}>
                  <ClipboardPaste className="mr-2 h-4 w-4" />
                  粘贴
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleExpandAll}>
                  <ChevronsUpDown className="mr-2 h-4 w-4" />
                  全部展开
                </ContextMenuItem>
                <ContextMenuItem onClick={handleCollapseAll}>
                  <ChevronsDownUp className="mr-2 h-4 w-4" />
                  全部收起
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>
        {/* 联系模式提示 */}
        {linkingState.active && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-primary px-4 py-1.5 text-xs text-primary-foreground shadow-md">
            {linkingState.phase === "first"
              ? "请选择起始主题或外框，Esc 取消"
              : linkingState.first?.kind === "boundary"
                ? "请选择目标主题，Esc 取消"
                : "请选择目标主题或外框，Esc 取消"}
          </div>
        )}
        {/* 框选模式提示 */}
        {marqueeState.active && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full bg-primary px-4 py-1.5 text-xs text-primary-foreground shadow-md">
            {marqueeState.mode === "boundary" ? "拖拽框选要包围的主题，Esc 取消" : "拖拽框选要概要的主题，Esc 取消"}
          </div>
        )}
        {/* 查找替换浮动面板 */}
        {showFindPanel ? (
          <FindReplacePanel
            matchCount={findMatches.length}
            currentIndex={findIndex}
            onSearch={runSearch}
            onNavigate={handleNavigate}
            onReplace={handleReplace}
            onReplaceAll={handleReplaceAll}
            onClose={() => {
              setShowFindPanel(false);
              setFindMatches([]);
              setFindIndex(-1);
              clearFindHighlight();
            }}
          />
        ) : null}
      </div>
      {/* 节点属性编辑对话框 */}
      <NodePropertyDialog
        open={nodePropertyOpen}
        data={nodePropertyData}
        onApply={handleApplyProperty}
        onClose={() => setNodePropertyOpen(false)}
      />
    </div>
  );
});

/** 深拷贝节点（剥离 parent 引用，避免循环序列化），保留所有扩展字段 */
function cloneNode(node: MindMapNode): NodeObj {
  const clone: NodeObj = {
    id: node.id,
    topic: node.topic,
    children: node.children.map(cloneNode),
  };
  if (node.note !== undefined) clone.note = node.note;
  if (node.icons !== undefined) clone.icons = node.icons;
  if (node.hyperLink !== undefined) clone.hyperLink = node.hyperLink;
  if (node.image !== undefined) clone.image = node.image;
  if (node.style !== undefined) clone.style = node.style;
  if (node.metadata !== undefined) clone.metadata = node.metadata;
  return clone;
}

/** 移除 NodeObj 中的 parent 引用，并转换为 MindMapNode 用于序列化，保留所有扩展字段 */
function stripParent(node: NodeObj): MindMapNode {
  const children = node.children ?? [];
  const result: MindMapNode = {
    id: node.id,
    topic: node.topic,
    children: children.map(stripParent),
  };
  if (node.note !== undefined) result.note = node.note;
  if (node.icons !== undefined) result.icons = node.icons;
  if (node.hyperLink !== undefined) result.hyperLink = node.hyperLink;
  if (node.image !== undefined) result.image = node.image;
  if (node.style !== undefined) result.style = node.style as MindMapNodeStyle | undefined;
  if (node.metadata !== undefined) result.metadata = node.metadata as Record<string, unknown> | undefined;
  return result;
}

/** 根据路径获取节点标签列表 */
function pathToLabels(root: NodeObj, path: number[]): string[] {
  const labels: string[] = [root.topic];
  let current: NodeObj = root;
  for (const idx of path) {
    const children = current.children ?? [];
    if (idx >= children.length) break;
    current = children[idx];
    labels.push(current.topic);
  }
  return labels;
}

/**
 * 将外部粘贴文本解析为 MindMapNode 子树。
 *
 * 解析规则（见 docs/plans/mindmap-dev-plan.md §6.2）：
 *   - 多行文本默认按同级节点解析（每行一个子节点）；
 *   - 带两个空格缩进的文本按现有 Markdown 大纲层级解析；
 *   - 如果文本以 # 开头，按完整 Markdown 大纲解析（根 + 子节点）；
 *   - 如果是纯文本（单行），返回单个节点。
 *
 * 返回 null 表示无法解析。
 */
function parseMindMapFromText(text: string): MindMapNode | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 如果以 # 开头，按完整 Markdown 大纲解析
  if (trimmed.startsWith("#")) {
    const result = parseMindMap(text);
    if (result.ok) return result.root;
    return null;
  }

  // 按列表项解析（支持 - /*/+ 开头，或纯文本行）
  const lines = trimmed.split("\n");
  const root: MindMapNode = {
    id: "",
    topic: "",
    children: [],
  };
  // 使用栈维护层级关系：栈顶是当前可追加子节点的父节点
  const stack: { node: MindMapNode; indent: number }[] = [{ node: root, indent: -1 }];

  for (const line of lines) {
    // 匹配缩进 + 列表标记 + 内容
    const match = line.match(/^(\s*)[-*+]?\s*(.+)$/);
    if (!match) continue;
    const indent = match[1].length;
    const topic = match[2].trim();
    if (!topic) continue;

    // 弹出栈中缩进 >= 当前的节点
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    const child: MindMapNode = {
      id: "",
      topic,
      children: [],
    };
    parent.children.push(child);
    stack.push({ node: child, indent });
  }

  // 如果只有一行（根无 topic，children 有一个），返回该单节点
  if (root.children.length === 1 && root.children[0].children.length === 0) {
    return root.children[0];
  }

  // 如果根没有 topic 但有子节点，用第一个子节点作为根
  if (!root.topic && root.children.length > 0) {
    return root;
  }

  return root.children.length > 0 ? root : null;
}
