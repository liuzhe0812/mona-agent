import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Download, FolderOpen, Loader2, Trash2 } from "lucide-react";

import { deletePptProject, fetchPptProjects } from "@/lib/api";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PptProject } from "@/lib/types";

interface PptHistoryProps {
  /** 当前打开的项目名：用于列表高亮 */
  currentProjectName?: string | null;
  onSelect: (project: PptProject) => void;
  onDownload: (name: string) => void;
  onDelete?: (name: string) => void;
}

function formatRelativeTime(epoch: number): string {
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

const STATUS_LABELS: Record<string, string> = {
  init: "初始化",
  planning: "规划中",
  generating: "生成中",
  done: "已完成",
};

export function PptHistory({ currentProjectName, onSelect, onDownload, onDelete }: PptHistoryProps) {
  const { token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [projects, setProjects] = useState<PptProject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  // 待确认删除的项目名（AlertDialog），null 表示无待确认删除
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // 删除失败：保留列表项并在该项附近展示错误与重试
  const [deleteError, setDeleteError] = useState<{ name: string; message: string } | null>(null);
  // 打开目录失败等操作错误
  const [actionError, setActionError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchPptProjects(token);
      setProjects(res.projects);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载历史项目失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleDelete = async (name: string) => {
    if (deleting) return;
    setDeleting(name);
    setDeleteError(null);
    try {
      await deletePptProject(token, name);
      setProjects((prev) => prev.filter((p) => p.name !== name));
      onDelete?.(name);
    } catch (e) {
      // 删除失败：保留列表项，展示错误与重试入口
      setDeleteError({
        name,
        message: e instanceof Error ? e.message : "删除失败",
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleOpenDir = async (name: string) => {
    setActionError(null);
    if (!isTauri() || !workspacePath) {
      setActionError("当前环境不支持打开项目目录");
      return;
    }
    const dirPath = `${workspacePath}/ppt_projects/${name}`;
    try {
      await openPathWithSystemApp(dirPath);
    } catch (e) {
      setActionError(
        `无法打开项目目录：${e instanceof Error ? e.message : "目录不存在或已被移动"}`,
      );
    }
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-[11px]">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <span className="text-destructive">加载历史项目失败：{loadError}</span>
        <button
          type="button"
          className="rounded px-2 py-1 text-primary hover:bg-primary/10"
          onClick={() => void loadProjects()}
        >
          重试
        </button>
      </div>
    );
  }

  if (!loading && projects.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        暂无历史项目
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
        历史项目
      </div>
      {actionError && (
        <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">{actionError}</span>
          <button
            type="button"
            className="shrink-0 rounded px-1 hover:bg-destructive/10"
            aria-label="关闭错误提示"
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      )}
      {projects.map((p) => (
        <div key={p.name}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left",
                  "hover:bg-accent",
                  p.name === currentProjectName && "bg-accent",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onSelect(p)}
                  aria-current={p.name === currentProjectName ? "true" : undefined}
                  aria-label={`打开项目 ${p.name}，${STATUS_LABELS[p.status] || p.status}，${p.slideCount} 页`}
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px]">{p.name}</div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{STATUS_LABELS[p.status] || p.status}</span>
                      <span>·</span>
                      <span>{p.slideCount}页</span>
                      <span>·</span>
                      <span>{formatRelativeTime(p.createdAt)}</span>
                    </div>
                  </div>
                </button>
                {p.hasExport && (
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-accent"
                    aria-label={`下载 ${p.name} 的 PPTX`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(p.name);
                    }}
                  >
                    <Download className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-40">
              {p.hasExport && (
                <ContextMenuItem
                  onClick={() => onDownload(p.name)}
                  className="text-[12px]"
                >
                  <Download className="mr-2 h-3.5 w-3.5" />
                  下载 PPTX
                </ContextMenuItem>
              )}
              <ContextMenuItem
                onClick={() => handleOpenDir(p.name)}
                className="text-[12px]"
              >
                <FolderOpen className="mr-2 h-3.5 w-3.5" />
                打开任务目录
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setPendingDelete(p.name)}
                disabled={deleting === p.name}
                className="text-[12px] text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {deleting === p.name ? "删除中..." : "删除项目"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {deleteError?.name === p.name && (
            <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">删除失败：{deleteError.message}</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                onClick={() => void handleDelete(p.name)}
              >
                重试
              </button>
            </div>
          )}
        </div>
      ))}
      {loading && (
        <div className="flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载中…
        </div>
      )}

      {/* 删除项目二次确认 */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个项目？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除项目「{pendingDelete}」及其全部页面、素材和导出文件，删除后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) void handleDelete(pendingDelete);
                setPendingDelete(null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
