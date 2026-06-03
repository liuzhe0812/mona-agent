import { useEffect, useState } from "react";
import { Download, FolderOpen, Play, Trash2 } from "lucide-react";

import { deletePptProject, fetchPptProjects } from "@/lib/api";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { PptProject } from "@/lib/types";

interface PptHistoryProps {
  onSelect: (project: PptProject) => void;
  onDownload: (name: string) => void;
  onResume: (name: string, chatId?: string | null, hasSpecLock?: boolean) => void;
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

export function PptHistory({ onSelect, onDownload, onResume, onDelete }: PptHistoryProps) {
  const { token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [projects, setProjects] = useState<PptProject[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPptProjects(token).then((res) => {
      if (!cancelled) setProjects(res.projects);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleDelete = async (name: string) => {
    if (deleting) return;
    setDeleting(name);
    try {
      await deletePptProject(token, name);
      setProjects((prev) => prev.filter((p) => p.name !== name));
      onDelete?.(name);
    } catch (e) {
      console.error("Failed to delete PPT project", e);
    } finally {
      setDeleting(null);
    }
  };

  const handleOpenDir = async (name: string) => {
    if (!isTauri() || !workspacePath) return;
    const dirPath = `${workspacePath}/ppt-projects/${name}`;
    try {
      await openPathWithSystemApp(dirPath);
    } catch (e) {
      console.error("Failed to open project directory", e);
    }
  };

  if (projects.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        暂无历史项目
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
        历史项目
      </div>
      {projects.map((p) => {
        const canResume = p.status === "generating" || p.status === "planning";
        return (
          <ContextMenu key={p.name}>
            <ContextMenuTrigger asChild>
              <button
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1.5 text-left",
                  "hover:bg-accent",
                )}
                onClick={() => onSelect(p)}
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
                {canResume && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="shrink-0 rounded p-0.5 hover:bg-accent text-emerald-600 dark:text-emerald-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      onResume(p.name, p.chatId, p.hasSpecLock);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        onResume(p.name, p.chatId, p.hasSpecLock);
                      }
                    }}
                    title="继续生成"
                  >
                    <Play className="h-3 w-3" />
                  </span>
                )}
                {p.hasExport && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="shrink-0 rounded p-0.5 hover:bg-accent"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(p.name);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        onDownload(p.name);
                      }
                    }}
                  >
                    <Download className="h-3 w-3 text-muted-foreground" />
                  </span>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-40">
              {canResume && (
                <ContextMenuItem
                  onClick={() => onResume(p.name, p.chatId, p.hasSpecLock)}
                  className="text-[12px]"
                >
                  <Play className="mr-2 h-3.5 w-3.5" />
                  继续生成
                </ContextMenuItem>
              )}
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
                onClick={() => handleDelete(p.name)}
                disabled={deleting === p.name}
                className="text-[12px] text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {deleting === p.name ? "删除中..." : "删除项目"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
