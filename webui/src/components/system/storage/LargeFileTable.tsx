import { Loader2, MoreHorizontal, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { StorageTrashResult, TopFileInfo } from "../useSystemData";
import { formatStorage } from "../useSystemData";

interface Props {
  files: TopFileInfo[];
  onAnalyze?: (file: TopFileInfo) => void;
  analyzingFileId?: string | null;
  /** 移至系统回收站（可恢复）；不传则不显示删除入口 */
  onTrash?: (paths: string[]) => Promise<StorageTrashResult>;
}

interface ActionError {
  title: string;
  description: string;
  detail: string;
}

const BUCKET_LABEL: Record<string, string> = {
  "30d": "近 30 天",
  "90d": "近 90 天",
  "180d": "近半年",
  "1y": "近一年",
  old: "一年以上",
  unknown: "未知",
};

const DISPLAY_LIMIT = 20;
const MENU_WIDTH = 200;
const MENU_ITEM_HEIGHT = 32;
const MENU_ITEMS = 3;

function getFileName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** 在 Windows 资源管理器中打开并选中文件 */
async function revealInExplorer(path: string): Promise<void> {
  await invoke("system_reveal_in_explorer", { path });
}

/** 大文件列表：展示扫描范围内占用最大的文件 */
export function LargeFileTable({ files, onAnalyze, analyzingFileId, onTrash }: Props) {
  const displayFiles = files.slice(0, DISPLAY_LIMIT);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [trashTarget, setTrashTarget] = useState<TopFileInfo | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const reveal = (path: string) => void revealInExplorer(path).catch((error) => setActionError({
    title: "无法打开文件位置",
    description: "请检查文件是否仍在原位置，然后重试。",
    detail: String(error),
  }));
  const copyPath = async (path: string) => {
    if (typeof navigator.clipboard?.writeText !== "function") {
      setActionError({
        title: "无法复制路径",
        description: "当前无法访问剪贴板，请检查应用权限后重试。",
        detail: "Clipboard API unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
    } catch (error) {
      setActionError({
        title: "无法复制路径",
        description: "写入剪贴板失败，请检查应用权限后重试。",
        detail: String(error),
      });
    }
  };

  const handleContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    const maxX = window.innerWidth - MENU_WIDTH - 8;
    const maxY = window.innerHeight - MENU_ITEM_HEIGHT * MENU_ITEMS - 8;
    setMenu({
      path,
      x: Math.min(e.clientX, maxX),
      y: Math.min(e.clientY, maxY),
    });
  };

  const closeMenu = () => setMenu(null);

  const handleTrashRequest = (path: string) => {
    const target = displayFiles.find((file) => file.path === path) ?? null;
    setTrashError(null);
    setTrashTarget(target);
    closeMenu();
  };

  const handleTrashConfirm = async (event: React.MouseEvent) => {
    // Radix 默认点击 Action 即关闭弹窗；改为成功后自行关闭，
    // 失败时保持弹窗并展示原因，绝不静默失败。
    event.preventDefault();
    if (!trashTarget || !onTrash) return;
    setTrashPending(true);
    setTrashError(null);
    try {
      const result = await onTrash([trashTarget.path]);
      if (result.failures.length > 0) {
        setTrashPending(false);
        setTrashError(result.failures.map((f) => f.error).join("；"));
        return;
      }
    } catch (error) {
      setTrashPending(false);
      setTrashError(error instanceof Error ? error.message : String(error));
      return;
    }
    setTrashPending(false);
    setTrashTarget(null);
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

  return (
    <div className="h-full min-h-0">
      {displayFiles.length === 0 ? (
        <div className="py-8 text-center text-caption text-muted-foreground">
          扫描后展示占用最大的文件
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto scrollbar-hover">
          <table className="w-full table-fixed text-left text-micro">
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-28" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-card text-micro text-muted-foreground">
              <tr>
                <th scope="col" className="py-2.5 pr-3 text-left font-normal">文件</th>
                <th scope="col" className="px-3 py-2.5 text-left font-normal">类型</th>
                <th scope="col" className="px-3 py-2.5 text-left font-normal">修改时间</th>
                <th scope="col" className="px-3 py-2.5 text-right font-normal">大小</th>
                <th scope="col" className="py-2.5 pl-3"></th>
              </tr>
            </thead>
            <tbody>
              {displayFiles.map((file, index) => (
                <tr
                  key={`${file.parentDirName}-${file.extension}-${index}`}
                  className="cursor-default border-t border-border/50 hover:bg-accent/40"
                  onContextMenu={(e) => handleContextMenu(e, file.path)}
                  title={file.path}
                >
                  <td className="truncate py-2.5 pl-0 pr-3" title={getFileName(file.path)}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <FileSystemIcon name={file.path} />
                      <span className="truncate font-medium">{getFileName(file.path)}</span>
                    </span>
                    <span className="block truncate pl-5 text-muted-foreground" title={file.parentDirName}>
                      {file.parentDirName}
                    </span>
                  </td>
                  <td className="truncate px-3 py-2 text-muted-foreground">
                    {file.extension === "(none)" ? "—" : `.${file.extension}`}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {BUCKET_LABEL[file.modifiedBucket] ?? file.modifiedBucket}
                  </td>
                  <td className="px-3 py-2 text-right font-medium text-foreground">
                    {formatStorage(file.sizeGb)}
                  </td>
                  <td className="py-2 pl-2 text-right">
                    <span className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        title={`${analyzingFileId === file.id ? "正在分析" : "分析"} ${getFileName(file.path)}`}
                        aria-label={`${analyzingFileId === file.id ? "正在分析" : "分析"} ${getFileName(file.path)}`}
                        aria-busy={analyzingFileId === file.id}
                        disabled={!onAnalyze || analyzingFileId === file.id}
                        onClick={() => onAnalyze?.(file)}
                      >
                        {analyzingFileId === file.id
                          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          : <Sparkles className="h-4 w-4" aria-hidden="true" />}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            title={`更多操作 ${getFileName(file.path)}`}
                            aria-label={`更多操作 ${getFileName(file.path)}`}
                          >
                            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => reveal(file.path)}>
                            打开位置
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { void copyPath(file.path); }}>
                            复制路径
                          </DropdownMenuItem>
                          {onTrash && (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => handleTrashRequest(file.path)}
                            >
                              移至回收站
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 自定义右键菜单 */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-overlay"
          style={{ left: menu.x, top: menu.y }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal hover:bg-accent hover:text-accent-foreground"
            onClick={() => { reveal(menu.path); closeMenu(); }}
          >
            在资源管理器中显示
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal hover:bg-accent hover:text-accent-foreground"
            onClick={() => { void copyPath(menu.path); closeMenu(); }}
          >
            复制路径
          </Button>
          {onTrash && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start cursor-default select-none px-2 py-1.5 text-caption font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => handleTrashRequest(menu.path)}
            >
              移至回收站
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={actionError !== null} onOpenChange={(open) => { if (!open) setActionError(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{actionError?.title}</AlertDialogTitle>
            <AlertDialogDescription>{actionError?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <details className="text-caption"><summary>查看详情</summary><pre className="mt-2 whitespace-pre-wrap break-words">{actionError?.detail}</pre></details>
          <AlertDialogFooter><AlertDialogCancel>关闭</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 移至回收站确认弹窗（复刻产物区回收站语义：可恢复、失败保持弹窗） */}
      <AlertDialog
        open={!!trashTarget}
        onOpenChange={(open) => {
          if (!open) {
            setTrashTarget(null);
            setTrashError(null);
          }
        }}
      >
        <AlertDialogContent className="w-[min(calc(100vw-2rem),22.75rem)] gap-4 rounded-xl border-border/70 bg-popover p-5 text-center shadow-overlay">
          <AlertDialogHeader className="items-center space-y-0 text-center">
            <div className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <Trash2 className="h-5 w-5" strokeWidth={2.2} aria-hidden />
            </div>
            <AlertDialogTitle className="text-center text-title-sm text-foreground">
              删除这个大文件？
            </AlertDialogTitle>
            <AlertDialogDescription className="max-w-[17rem] text-center text-body text-muted-foreground">
              {trashTarget
                ? `「${getFileName(trashTarget.path)}」位于 ${trashTarget.parentDirName}（${formatStorage(trashTarget.sizeGb)}），将被移至系统回收站，需要时可以从回收站恢复。`
                : ""}
            </AlertDialogDescription>
            {trashError ? (
              <p className="mt-3 max-w-[17rem] text-center text-ui leading-5 text-destructive">
                移至回收站失败：{trashError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-2 flex-row justify-end gap-2 space-x-0">
            <AlertDialogCancel className="mt-0">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTrashConfirm}
              disabled={trashPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {trashPending ? "正在移除…" : "移至回收站"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
