import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import MindElixir from "mind-elixir";
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
  Maximize2,
  List,
  Network,
  Pencil,
  Copy,
  Download,
  Loader2,
  Palette,
  Focus,
  Minimize2,
  ChevronsDownUp,
  ChevronsUpDown,
  Search,
  Scissors,
  ClipboardPaste,
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
  searchInTree,
  computeReplaceAllChanges,
  type SearchMatch,
} from "./mindmap-search";
import { FindReplacePanel } from "./FindReplacePanel";
import { useMindMapSelection } from "./MindMapSelectionContext";
import { downloadMediaUrl } from "@/lib/tauri";

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

type ViewMode = "map" | "outline";

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

export function MindMapDocumentEditor({
  note,
  onContentChange,
  onSelectionChange,
  toolbarLeading,
  toolbarExtra,
}: MindMapDocumentEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const isRefreshingRef = useRef(false);
  const lastContentRef = useRef(note.contentMarkdown);
  const { setSelection, updateBaseHash } = useMindMapSelection();

  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [outlineText, setOutlineText] = useState(note.contentMarkdown);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  const [themeKey, setThemeKey] = useState<MindMapThemeKey>(loadThemeKey);
  // 多选状态：当前选中的节点数（含单选），用于控制批量删除按钮可用性
  const [selectedCount, setSelectedCount] = useState(0);
  // 聚焦模式状态：true 时显示"返回完整导图"按钮
  const [isFocusMode, setIsFocusMode] = useState(false);
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
      setViewMode("outline");
      return;
    }
    setParseError(null);
    setOutlineText(note.contentMarkdown);
    lastContentRef.current = note.contentMarkdown;

    if (mindRef.current) {
      const cloned = cloneNode(result.root);
      // 容器可见时立即 refresh；否则延迟到下一帧（等 viewMode 切换完成）
      if (viewMode === "map") {
        isRefreshingRef.current = true;
        try {
          mindRef.current.refresh({ nodeData: cloned });
        } finally {
          isRefreshingRef.current = false;
        }
      } else {
        requestAnimationFrame(() => {
          const mind = mindRef.current;
          if (!mind) return;
          isRefreshingRef.current = true;
          try {
            mind.refresh({ nodeData: cloned });
          } finally {
            isRefreshingRef.current = false;
          }
        });
      }
    }
  }, [note.contentMarkdown, viewMode]);

  // 初始化 Mind Elixir
  useEffect(() => {
    if (!containerRef.current) return;
    if (mindRef.current) return;

    const result = parseMindMap(note.contentMarkdown);
    if (!result.ok) {
      setParseError(`第 ${result.line} 行：${result.message}`);
      setViewMode("outline");
      return;
    }

    const mind = new MindElixir({
      el: containerRef.current,
      direction: 1,
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

    mind.init({ nodeData: cloneNode(result.root) });
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
    // 初始化后适应画布：scaleFit 内部调用 Se(this, true) 按 nodes 居中
    // 注意：不要额外调用 toCenter()，它会按 root 居中导致画布偏移
    requestAnimationFrame(() => {
      mind.scaleFit();
    });

    mind.bus.addListener("operation", () => {
      if (isRefreshingRef.current) return;
      const data = mind.getData();
      const md = serializeMindMap(stripParent(data.nodeData));
      lastContentRef.current = md;
      setOutlineText(md);
      const parsed = parseMindMap(md);
      onContentChange({
        contentMarkdown: md,
        plainText: parsed.ok ? parsed.plainText : md,
      });
      // 同步最新 baseHash 到 Context，确保下次 AI patch 校验基于最新内容
      const newBaseHash = computeBaseHash(md);
      updateBaseHash(note.id, newBaseHash);
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
      // 单选时更新选中计数
      setSelectedCount(1);
    });

    // 多选事件：追踪当前选中节点数
    mind.bus.addListener("selectNodes", (nodes: NodeObj[]) => {
      setSelectedCount(nodes.length);
    });
    mind.bus.addListener("unselectNodes", (nodes: NodeObj[]) => {
      const mind = mindRef.current;
      if (!mind) return;
      const remaining = mind.currentNodes.length - nodes.length;
      setSelectedCount(Math.max(0, remaining));
    });

    mindRef.current = mind;

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
      mindRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    requestAnimationFrame(() => mind.scaleFit());
  }, []);

  useEffect(() => {
    applyTheme(themeKey, isDark);
  }, [themeKey, isDark, applyTheme]);

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

  // 大纲编辑
  const handleOutlineChange = useCallback((value: string) => {
    setOutlineText(value);
    setParseError(null);
  }, []);

  const handleSwitchToMap = useCallback(() => {
    const result = parseMindMap(outlineText);
    if (!result.ok) {
      setParseError(`第 ${result.line} 行：${result.message}`);
      return;
    }
    setParseError(null);
    lastContentRef.current = outlineText;

    // 先切换视图让容器可见，下一帧再 refresh，避免 hidden 状态下连线坐标计算为 0
    setViewMode("map");
    if (mindRef.current) {
      const cloned = cloneNode(result.root);
      requestAnimationFrame(() => {
        const mind = mindRef.current;
        if (!mind) return;
        isRefreshingRef.current = true;
        try {
          mind.refresh({ nodeData: cloned });
        } finally {
          isRefreshingRef.current = false;
        }
        // 适应画布尺寸
        requestAnimationFrame(() => mind.scaleFit());
      });
    }

    const md = serializeMindMap(result.root);
    onContentChange({
      contentMarkdown: md,
      plainText: result.plainText,
    });
  }, [outlineText, onContentChange]);

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

  // 批量删除多选节点：
  // 1. 过滤根节点（不允许删除根）；
  // 2. 去重：若选中节点中包含祖先与子孙关系，只保留祖先（删除祖先时子孙一并移除）。
  const handleBatchDelete = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const selected = mind.currentNodes;
    if (selected.length <= 1) return;
    const rootId = mind.nodeData.id;
    // 过滤根节点
    const candidates = selected.filter(t => t.nodeObj.id !== rootId);
    if (candidates.length === 0) return;
    // 去重：移除被其他选中节点作为祖先包含的节点
    const ids = new Set(candidates.map(t => t.nodeObj.id));
    const deduped: Topic[] = [];
    for (const tpc of candidates) {
      let isDescendantOfAnother = false;
      // 向上遍历父链，若任一祖先也在选中集合中，则跳过
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
    if (deduped.length === 0) return;
    void mind.removeNodes(deduped);
    setSelectedCount(0);
  }, []);

  // 上移 / 下移当前节点（Mind Elixir 内置 Alt+↑/↓、PageUp/PageDown 快捷键）
  // 注：工具栏不提供按钮，用户可通过拖拽节点或快捷键移动

  // 聚焦当前节点子树 / 返回完整导图
  const handleFocusNode = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    mind.focusNode(current);
    setIsFocusMode(true);
  }, []);
  const handleCancelFocus = useCallback(() => {
    mindRef.current?.cancelFocus();
    setIsFocusMode(false);
  }, []);

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
      setSelectedCount(0);
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

  // 进入节点文本编辑模式（Mind Elixir 内置双击编辑的编程触发方式）
  const handleEdit = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const current = mind.currentNode;
    if (!current) return;
    mind.beginEdit?.(current);
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

  // ========== 查找与替换 ==========
  // 执行搜索：从当前导图数据中查找匹配节点
  const runSearch = useCallback((query: string, caseSensitive: boolean) => {
    if (!query) {
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
    }
  }, []);

  // 定位到指定匹配节点：选中并滚动到视图
  const navigateToMatch = useCallback((match: SearchMatch) => {
    const mind = mindRef.current;
    if (!mind) return;
    const el = mind.findEle(match.nodeId);
    if (!el) return;
    mind.selectNode(el);
    mind.scrollIntoView(el, true);
  }, []);

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
    // 清空匹配状态
    setFindMatches([]);
    setFindIndex(-1);
  }, []);

  // Ctrl+F 打开查找面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        setShowFindPanel(true);
      }
    };
    const container = containerRef.current;
    if (!container) return;
    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* 工具栏 */}
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
        {toolbarLeading ? (
          <>
            {toolbarLeading}
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        ) : null}
        <div className="flex items-center rounded-md bg-muted/50 p-0.5">
          <Button
            variant={viewMode === "map" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => viewMode === "outline" && handleSwitchToMap()}
          >
            <Network className="mr-1 h-3.5 w-3.5" />
            导图
          </Button>
          <Button
            variant={viewMode === "outline" ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setViewMode("outline")}
          >
            <List className="mr-1 h-3.5 w-3.5" />
            大纲
          </Button>
        </div>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleUndo} title="撤销">
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRedo} title="重做">
          <Redo2 className="h-3.5 w-3.5" />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleAddChild}>
          <CornerDownRight className="mr-1 h-3.5 w-3.5" />
          子节点
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleAddSibling}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          同级
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleDelete}>
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          删除
        </Button>
        {/* 批量删除：仅在多选（>1）时可用 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleBatchDelete}
          disabled={selectedCount <= 1 || viewMode !== "map"}
          title="批量删除选中节点"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          批量删除{selectedCount > 1 ? `(${selectedCount})` : ""}
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 聚焦 / 返回完整导图 */}
        {isFocusMode ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleCancelFocus}
            disabled={viewMode !== "map"}
            title="返回完整导图"
            aria-label="返回完整导图"
          >
            <Minimize2 className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleFocusNode}
            disabled={viewMode !== "map"}
            title="聚焦此分支"
            aria-label="聚焦此分支"
          >
            <Focus className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* 查找 */}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setShowFindPanel(true)}
          disabled={viewMode !== "map"}
          title="查找与替换 (Ctrl+F)"
          aria-label="查找与替换"
        >
          <Search className="h-3.5 w-3.5" />
        </Button>

        <div className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={viewMode !== "map"}
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
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleFit} title="适应画布">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleExportPng}
          disabled={exporting || viewMode !== "map"}
          title="导出 PNG"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
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
              className={`mindmap-container absolute inset-0 overflow-auto bg-background scrollbar-hover ${viewMode === "map" ? "" : "hidden"}`}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={handleEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              编辑节点文本
            </ContextMenuItem>
            <ContextMenuSeparator />
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
            <ContextMenuItem onClick={handleFocusNode}>
              <Focus className="mr-2 h-4 w-4" />
              聚焦此分支
            </ContextMenuItem>
            {isFocusMode ? (
              <ContextMenuItem onClick={handleCancelFocus}>
                <Minimize2 className="mr-2 h-4 w-4" />
                返回完整导图
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              删除节点
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {/* 查找替换浮动面板 */}
        {showFindPanel && viewMode === "map" ? (
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
            }}
          />
        ) : null}
        {viewMode === "outline" ? (
          <textarea
            className="absolute inset-0 resize-none bg-background p-4 font-mono text-sm leading-relaxed outline-none scrollbar-hover"
            value={outlineText}
            onChange={(e) => handleOutlineChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                handleSwitchToMap();
              }
            }}
            placeholder="# 根节点&#10;&#10;- 子节点"
            spellCheck={false}
          />
        ) : null}
      </div>
    </div>
  );
}

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
