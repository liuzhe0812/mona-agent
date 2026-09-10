import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";

import { PanelCard } from "../SystemUi";
import type { DirectorySize } from "../useSystemData";
import { formatStorage } from "../useSystemData";

interface Props {
  /** 完整目录树（从扫描根目录开始） */
  directories: DirectorySize[];
  /** 当前所在路径（根目录为 null） */
  currentPath: string | null;
  /** 当前选择的目录，用于与 Treemap 和 AI 上下文同步 */
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** 双击 / Enter / 右键打开时下钻 */
  onDrillDown: (path: string) => void;
}

const MAX_CHILDREN_PER_NODE = 200;
const MENU_WIDTH = 180;
const MENU_ITEM_HEIGHT = 32;
const MENU_ITEMS = 3;

function shortName(path: string): string {
  return path.split("\\").filter(Boolean).pop() ?? path;
}

/** 在嵌套树中递归查找节点 */
function findNodeByPath(nodes: DirectorySize[], target: string): DirectorySize | null {
  for (const node of nodes) {
    if (node.path === target) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, target);
      if (found) return found;
    }
  }
  return null;
}

function findPathChain(nodes: DirectorySize[], target: string, parents: string[] = []): string[] | null {
  for (const node of nodes) {
    const chain = [...parents, node.path];
    if (node.path === target) return chain;
    if (node.children) {
      const found = findPathChain(node.children, target, chain);
      if (found) return found;
    }
  }
  return null;
}

/** 在 Windows 资源管理器中打开目录 */
async function openInExplorer(path: string): Promise<void> {
  try {
    await invoke("system_open_in_explorer", { path });
  } catch (e) {
    console.error("[DirectoryTreeView] openInExplorer failed:", e);
  }
}

interface NodeRowProps {
  node: DirectorySize;
  depth: number;
  total: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggleExpand: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (path: string, x: number, y: number) => void;
}

function NodeRow({
  node,
  depth,
  total,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggleExpand,
  onOpen,
  onContextMenu,
}: NodeRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const name = shortName(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;
  const expanded = hasChildren && expandedPaths.has(node.path);
  const sortedChildren = hasChildren
    ? [...node.children!].sort((a, b) => b.sizeGb - a.sizeGb).slice(0, MAX_CHILDREN_PER_NODE)
    : [];

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onSelect(node.path);
    onContextMenu(node.path, e.clientX, e.clientY);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && hasChildren) {
      e.preventDefault();
      onOpen(node.path);
    }
  };

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isSelected]);

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        ref={rowRef}
        aria-selected={isSelected}
        tabIndex={0}
        onClick={() => onSelect(node.path)}
        onDoubleClick={() => hasChildren && onOpen(node.path)}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        className={cn(
          "flex cursor-default select-none items-center gap-1 px-2 py-0.5 text-caption outline-none",
          isSelected
            ? "bg-accent text-foreground"
            : "hover:bg-accent",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        title={`${node.path} · ${formatStorage(node.sizeGb)} · ${total > 0 ? ((node.sizeGb / total) * 100).toFixed(1) : "0.0"}%`}
      >
        {/* 展开/折叠按钮 */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleExpand(node.path);
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )
          ) : null}
        </span>
        {/* 文件夹图标 */}
        {expanded && hasChildren ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-warning" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-warning" />
        )}
        {/* 名称 */}
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {/* 大小 */}
        <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
          {formatStorage(node.sizeGb)}
        </span>
      </div>

      {expanded && hasChildren && (
        <div role="group">
          {sortedChildren.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              total={total}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleExpand={onToggleExpand}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
            />
          ))}
          {node.children!.length > MAX_CHILDREN_PER_NODE && (
            <div
              className="px-2 py-0.5 text-micro text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              还有 {node.children!.length - MAX_CHILDREN_PER_NODE} 个子目录未显示
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 仿 Windows 资源管理器左侧导航树的目录树 */
export function DirectoryTreeView({
  directories,
  currentPath,
  selectedPath,
  onSelect,
  onDrillDown,
}: Props) {
  const total = useMemo(
    () => directories.reduce((s, d) => s + d.sizeGb, 0),
    [directories],
  );
  const sorted = useMemo(
    () => [...directories].sort((a, b) => b.sizeGb - a.sizeGb),
    [directories],
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());

  // 右键菜单状态
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = currentPath ?? selectedPath;
    if (!target) return;
    const chain = findPathChain(directories, target);
    if (!chain) return;
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (const path of chain.slice(0, -1)) next.add(path);
      return next;
    });
  }, [currentPath, directories, selectedPath]);

  const handleToggleExpand = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleOpen = (path: string) => {
    onSelect(path);
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    onDrillDown(path);
  };

  const handleContextMenu = (path: string, x: number, y: number) => {
    // 边界检测：确保菜单不超出视口
    const maxX = window.innerWidth - MENU_WIDTH - 8;
    const maxY = window.innerHeight - MENU_ITEM_HEIGHT * MENU_ITEMS - 8;
    onSelect(path);
    setMenu({
      path,
      x: Math.min(x, maxX),
      y: Math.min(y, maxY),
    });
  };

  const closeMenu = () => setMenu(null);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeMenu();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [menu]);

  const menuNode = menu ? findNodeByPath(directories, menu.path) : null;
  const menuHasChildren = menuNode?.children && menuNode.children.length > 0;

  return (
    <PanelCard
      title="目录占用"
      className="h-full overflow-hidden [&>div:first-child]:min-h-9 [&>div:first-child]:px-3 [&>div:first-child]:py-1.5"
      bodyClassName="h-full p-2"
    >
      {sorted.length === 0 ? (
        <div className="py-6 text-center text-caption text-muted-foreground select-none">
          扫描后展示目录占用
        </div>
      ) : (
        // 树形列表：内部滚动；不包含面包屑导航
        <div className="h-full overflow-y-auto scrollbar-hover" role="tree">
          {sorted.map((node) => (
            <NodeRow
              key={node.path}
              node={node}
              depth={0}
              total={total}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggleExpand={handleToggleExpand}
              onOpen={handleOpen}
              onContextMenu={handleContextMenu}
            />
          ))}
        </div>
      )}

      {/* 自定义右键菜单（不依赖 Radix 包裹，避免事件干扰） */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            disabled={!menuHasChildren}
            className={cn(
              "flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-caption outline-none",
              menuHasChildren
                ? "hover:bg-accent hover:text-accent-foreground"
                : "opacity-50 pointer-events-none",
            )}
            onClick={() => { handleOpen(menu.path); closeMenu(); }}
          >
            打开
          </button>
          <button
            type="button"
            className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-caption outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { void openInExplorer(menu.path); closeMenu(); }}
          >
            在资源管理器中打开
          </button>
          <button
            type="button"
            className="flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-caption outline-none hover:bg-accent hover:text-accent-foreground"
            onClick={() => { navigator.clipboard?.writeText(menu.path).catch(() => {}); closeMenu(); }}
          >
            复制路径
          </button>
        </div>
      )}
    </PanelCard>
  );
}
