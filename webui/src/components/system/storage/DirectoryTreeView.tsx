import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  onAnalyze?: (path: string) => void;
}

const MAX_CHILDREN_PER_NODE = 200;
const MENU_WIDTH = 180;
const MENU_ITEM_HEIGHT = 32;
const MENU_ITEMS = 4;

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

export function findPathChain(nodes: DirectorySize[], target: string, parents: string[] = []): string[] | null {
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
export async function openDirectoryInExplorer(path: string): Promise<void> {
  await invoke("system_open_in_explorer", { path });
}

export function StorageOpenErrorDialog({ error, onOpenChange }: {
  error: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={error !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>无法打开目录位置</AlertDialogTitle>
          <AlertDialogDescription>Windows 未能打开所选目录，请确认位置仍存在后重试。</AlertDialogDescription>
        </AlertDialogHeader>
        <details className="text-caption">
          <summary>查看详情</summary>
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">{error}</pre>
        </details>
        <AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
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
  const rowRef = useRef<HTMLTableRowElement>(null);
  const name = shortName(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = Boolean(node.children?.length);
  const expanded = hasChildren && expandedPaths.has(node.path);
  const sortedChildren = hasChildren
    ? [...node.children!].sort((a, b) => b.sizeGb - a.sizeGb).slice(0, MAX_CHILDREN_PER_NODE)
    : [];

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onSelect(node.path);
    onContextMenu(node.path, event.clientX, event.clientY);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" && hasChildren) {
      event.preventDefault();
      onOpen(node.path);
    } else if (event.key === " ") {
      event.preventDefault();
      onSelect(node.path);
    } else if (hasChildren && ((event.key === "ArrowRight" && !expanded) || (event.key === "ArrowLeft" && expanded))) {
      event.preventDefault();
      onToggleExpand(node.path);
    }
  };

  useEffect(() => {
    if (isSelected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [isSelected]);

  return (
    <>
      <tr
        ref={rowRef}
        aria-level={depth + 1}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-selected={isSelected}
        tabIndex={0}
        onClick={() => onSelect(node.path)}
        onDoubleClick={() => hasChildren && onOpen(node.path)}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        className={cn(
          "h-8 cursor-default select-none border-b border-border/30 text-caption outline-none last:border-b-0 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isSelected ? "bg-accent text-foreground" : "hover:bg-accent/60",
        )}
        title={`${node.path} · ${formatStorage(node.sizeGb)} · ${total > 0 ? ((node.sizeGb / total) * 100).toFixed(1) : "0.0"}%`}
      >
        <td className="px-3 py-1">
          <div className="flex min-w-0 items-center gap-1" style={{ paddingLeft: `${depth * 16}px` }}>
            {hasChildren ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${expanded ? "折叠" : "展开"} ${name}`}
                aria-expanded={expanded}
                className="h-6 w-6 shrink-0 text-muted-foreground"
                onClick={(event) => { event.stopPropagation(); onToggleExpand(node.path); }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </Button>
            ) : <span className="h-6 w-6 shrink-0" aria-hidden="true" />}
            <FileSystemIcon name={node.path} isDirectory expanded={expanded} />
            <span className="min-w-0 truncate font-medium">{name}</span>
          </div>
        </td>
        <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">
          {formatStorage(node.sizeGb)}
        </td>
      </tr>
      {expanded && sortedChildren.map((child) => (
        <NodeRow key={child.path} node={child} depth={depth + 1} total={total} selectedPath={selectedPath} expandedPaths={expandedPaths} onSelect={onSelect} onToggleExpand={onToggleExpand} onOpen={onOpen} onContextMenu={onContextMenu} />
      ))}
      {expanded && node.children!.length > MAX_CHILDREN_PER_NODE && (
        <tr><td colSpan={2} className="px-3 py-1 text-micro text-muted-foreground">
          <span style={{ paddingLeft: `${(depth + 1) * 16}px` }}>还有 {node.children!.length - MAX_CHILDREN_PER_NODE} 个子目录未显示</span>
        </td></tr>
      )}
    </>
  );
}

/** 两列表格中的目录树，保留展开、选中和下钻。 */
export function DirectoryTreeView({
  directories,
  currentPath,
  selectedPath,
  onSelect,
  onDrillDown,
  onAnalyze,
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
  const [openError, setOpenError] = useState<string | null>(null);

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

  const openInExplorer = (path: string) => {
    closeMenu();
    void openDirectoryInExplorer(path).catch((error: unknown) => setOpenError(String(error)));
  };

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-hover">
        <table role="treegrid" aria-label="目录占用" className="w-full table-fixed border-collapse text-left text-caption">
          <colgroup><col /><col className="w-24" /></colgroup>
          <thead className="sticky top-0 z-10 bg-background text-muted-foreground">
            <tr className="h-8 bg-muted/60">
              <th scope="col" className="border-r border-border/60 px-3 py-1 text-left font-normal"><span className="block pl-12">目录</span></th>
              <th scope="col" className="px-3 py-1 text-right font-normal">大小</th>
            </tr>
          </thead>
          <tbody>
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
          {sorted.length === 0 && <tr><td colSpan={2} className="py-6 text-center text-caption text-muted-foreground">扫描后显示目录</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 自定义右键菜单（不依赖 Radix 包裹，避免事件干扰） */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-overlay"
          style={{ left: menu.x, top: menu.y }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!menuHasChildren}
            className={cn(
              "h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal",
              menuHasChildren
                ? "hover:bg-accent hover:text-accent-foreground"
                : "pointer-events-none opacity-50",
            )}
            onClick={() => { handleOpen(menu.path); closeMenu(); }}
          >
            打开
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal hover:bg-accent hover:text-accent-foreground"
            onClick={() => openInExplorer(menu.path)}
          >
            在资源管理器中打开
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal hover:bg-accent hover:text-accent-foreground"
            onClick={() => { navigator.clipboard?.writeText(menu.path).catch(() => {}); closeMenu(); }}
          >
            复制路径
          </Button>
          {onAnalyze && menuNode && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal hover:bg-accent hover:text-accent-foreground"
              onClick={() => { onAnalyze(menu.path); closeMenu(); }}
            >
              占用分析
            </Button>
          )}
        </div>
      )}
      <StorageOpenErrorDialog error={openError} onOpenChange={(open) => { if (!open) setOpenError(null); }} />
    </div>
  );
}
