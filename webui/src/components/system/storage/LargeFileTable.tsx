import { FileText, Sparkles, Trash2 } from "lucide-react";
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

import { PanelCard } from "../SystemUi";
import type { StorageTrashResult, TopFileInfo } from "../useSystemData";
import { formatStorage } from "../useSystemData";

interface Props {
  files: TopFileInfo[];
  /** 点击"交给 Mona 评估"按钮触发 AI 分析 */
  onAnalyze?: () => void;
  /** 移至系统回收站（可恢复）；不传则不显示删除入口 */
  onTrash?: (paths: string[]) => Promise<StorageTrashResult>;
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

/** 在 Windows 资源管理器中打开并选中文件 */
async function revealInExplorer(path: string): Promise<void> {
  try {
    await invoke("system_reveal_in_explorer", { path });
  } catch (e) {
    console.error("[LargeFileTable] revealInExplorer failed:", e);
  }
}

/** 大文件列表：展示全局 Top 20 大文件（脱敏：仅扩展名 + 目录名 + 大小 + 修改时间桶） */
export function LargeFileTable({ files, onAnalyze, onTrash }: Props) {
  const displayFiles = files.slice(0, DISPLAY_LIMIT);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [trashTarget, setTrashTarget] = useState<TopFileInfo | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleAnalyze = () => {
    if (!onAnalyze || displayFiles.length === 0) return;
    onAnalyze();
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
    <PanelCard
      title={`大文件 Top ${displayFiles.length}`}
      className="h-full"
      action={
        displayFiles.length > 0 && onAnalyze ? (
          <Button type="button" variant="outline" size="sm" onClick={handleAnalyze}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            交给 Mona 评估
          </Button>
        ) : undefined
      }
    >
      {displayFiles.length === 0 ? (
        <div className="py-8 text-center text-caption text-muted-foreground">
          扫描后展示占用最大的文件
        </div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto scrollbar-hover">
          <table className="w-full table-fixed text-left text-micro">
            <colgroup>
              <col className="w-8" />
              <col />
              <col className="w-20" />
              <col className="w-16" />
              <col className="w-16" />
            </colgroup>
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th></th>
                <th className="pb-2 font-medium">所在目录</th>
                <th className="font-medium">类型</th>
                <th className="font-medium">修改时间</th>
                <th className="text-right font-medium">大小</th>
              </tr>
            </thead>
            <tbody>
              {displayFiles.map((file, index) => (
                <tr
                  key={`${file.parentDirName}-${file.extension}-${index}`}
                  className="cursor-default hover:bg-accent/40"
                  onContextMenu={(e) => handleContextMenu(e, file.path)}
                  title={file.path}
                >
                  <td className="py-2 pr-1 text-muted-foreground">{index + 1}</td>
                  <td className="truncate py-2 pr-2 font-medium" title={file.parentDirName}>
                    <span className="flex items-center gap-1.5">
                      <FileText className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      {file.parentDirName}
                    </span>
                  </td>
                  <td className="truncate py-2 pr-2 text-muted-foreground">
                    {file.extension === "(none)" ? "—" : `.${file.extension}`}
                  </td>
                  <td className="py-2 pr-2 text-muted-foreground">
                    {BUCKET_LABEL[file.modifiedBucket] ?? file.modifiedBucket}
                  </td>
                  <td className="py-2 text-right font-medium text-foreground">
                    {formatStorage(file.sizeGb)}
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
            onClick={() => { void revealInExplorer(menu.path); closeMenu(); }}
          >
            在资源管理器中显示
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
                ? `「${trashTarget.parentDirName}」下的 ${trashTarget.extension === "(none)" ? "文件" : `.${trashTarget.extension} 文件`}（${formatStorage(trashTarget.sizeGb)}）将被移至系统回收站，需要时可以从回收站恢复。`
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
    </PanelCard>
  );
}
