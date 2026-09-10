import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Archive,
  Clapperboard,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import {
  archiveVideoProject,
  copyVideoProject,
  deleteVideoProject,
  fetchVideoProjects,
  fetchVideoProjectsIncludingArchived,
  buildVideoDownloadUrl,
  getApiBase,
  renameVideoProject,
  upgradeVideoProjectStyle,
  upgradeVideoSeriesProjects,
  type VideoProject,
  type VideoProjectPhase,
} from "@/lib/api";
import { downloadMediaUrl, isTauri, openPathWithSystemApp } from "@/lib/tauri";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const VIDEO_PHASE_LABELS: Record<VideoProjectPhase, string> = {
  storyboard: "分镜中",
  producing: "制作中",
  exportable: "待导出",
  rendering: "导出中",
  done: "已完成",
};

/** Safely format resolution as a string, handling legacy object/array values. */
export function formatResolution(res: unknown): string {
  if (typeof res === "string") return res;
  if (Array.isArray(res) && res.length === 2) return `${res[0]}x${res[1]}`;
  if (res && typeof res === "object" && "width" in res && "height" in res) {
    return `${(res as { width: number }).width}x${(res as { height: number }).height}`;
  }
  return "1920x1080";
}

interface VideoHistoryProps {
  /** 当前打开的项目名：用于列表高亮 */
  currentProjectName?: string | null;
  /** 折叠态：以图标 rail 形式展示，类似主侧边栏的会话列表 */
  collapsed?: boolean;
  /** 递增该值触发列表重新加载（新建/渲染完成等） */
  refreshKey?: number;
  onSelect: (project: VideoProject) => void;
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

export function VideoHistory({
  currentProjectName,
  collapsed = false,
  refreshKey = 0,
  onSelect,
  onDelete,
}: VideoHistoryProps) {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [batchUpgrading, setBatchUpgrading] = useState<string | null>(null);
  const [pendingBatchUpgrade, setPendingBatchUpgrade] = useState<{
    seriesId: string;
    seriesName: string;
    styleVersion: number;
    projectNames: string[];
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{
    name: string;
    message: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [projectAction, setProjectAction] = useState<{
    mode: "rename" | "copy";
    project: VideoProject;
  } | null>(null);
  const [projectActionName, setProjectActionName] = useState("");
  const [projectActionLoading, setProjectActionLoading] = useState(false);

  // silent=true: background refresh (WS push) — skip the loading spinner.
  const loadProjects = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = showArchived
          ? await fetchVideoProjectsIncludingArchived(token)
          : await fetchVideoProjects(token);
        setProjects(res.projects ?? []);
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "加载历史项目失败");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showArchived, token],
  );

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, refreshKey]);

  // WS subscription: phase migrations and render completion update the phase
  // labels / hasVideo badges in place — no manual refresh needed.
  useEffect(() => {
    return client.onVideoProjectChanged(({ hint }) => {
      if (hint === "phase" || hint === "status" || hint === "style")
        void loadProjects(true);
    });
  }, [client, loadProjects]);

  const handleStyleUpgrade = useCallback(
    async (project: VideoProject) => {
      const version = project.latestSeriesStyleVersion;
      if (!version || upgrading) return;
      setUpgrading(project.name);
      setActionError(null);
      try {
        const result = await upgradeVideoProjectStyle(
          token,
          project.name,
          version,
        );
        if (!result.ok) throw new Error(result.error || "升级风格失败");
        await loadProjects(true);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setUpgrading(null);
      }
    },
    [loadProjects, token, upgrading],
  );

  const handleBatchStyleUpgrade = useCallback(async () => {
    if (!pendingBatchUpgrade || batchUpgrading) return;
    setBatchUpgrading(pendingBatchUpgrade.seriesId);
    setActionError(null);
    try {
      const result = await upgradeVideoSeriesProjects(
        token,
        pendingBatchUpgrade.seriesId,
        pendingBatchUpgrade.styleVersion,
        pendingBatchUpgrade.projectNames,
      );
      if (!result.ok) throw new Error(result.error || "批量升级风格失败");
      if (result.skipped?.length) {
        setActionError(
          `${result.updatedProjectNames?.length ?? 0} 个视频已升级，${result.skipped.length} 个未升级`,
        );
      }
      setPendingBatchUpgrade(null);
      await loadProjects(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchUpgrading(null);
    }
  }, [batchUpgrading, loadProjects, pendingBatchUpgrade, token]);

  const handleDelete = async (name: string) => {
    if (deleting) return;
    setDeleting(name);
    setDeleteError(null);
    try {
      await deleteVideoProject(token, name);
      setProjects((prev) => prev.filter((p) => p.name !== name));
      onDelete?.(name);
    } catch (e) {
      setDeleteError({
        name,
        message: e instanceof Error ? e.message : "删除失败",
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleArchive = useCallback(
    async (project: VideoProject, archived: boolean) => {
      setActionError(null);
      try {
        const result = await archiveVideoProject(token, project.name, archived);
        if (!result.ok) throw new Error(result.error || "归档操作失败");
        await loadProjects(true);
      } catch (archiveError) {
        setActionError(
          archiveError instanceof Error
            ? archiveError.message
            : String(archiveError),
        );
      }
    },
    [loadProjects, token],
  );

  const handleProjectAction = useCallback(async () => {
    if (!projectAction || !projectActionName.trim() || projectActionLoading)
      return;
    setProjectActionLoading(true);
    setActionError(null);
    try {
      const result =
        projectAction.mode === "rename"
          ? await renameVideoProject(
              token,
              projectAction.project.name,
              projectActionName.trim(),
            )
          : await copyVideoProject(
              token,
              projectAction.project.name,
              projectActionName.trim(),
            );
      if (!result.ok) throw new Error(result.error || "项目操作失败");
      if (projectAction.mode === "rename") {
        onDelete?.(projectAction.project.name);
      }
      setProjectAction(null);
      await loadProjects(true);
    } catch (projectError) {
      setActionError(
        projectError instanceof Error
          ? projectError.message
          : String(projectError),
      );
    } finally {
      setProjectActionLoading(false);
    }
  }, [
    loadProjects,
    onDelete,
    projectAction,
    projectActionLoading,
    projectActionName,
    token,
  ]);

  const handleDownload = async (name: string) => {
    setActionError(null);
    try {
      const base = await getApiBase();
      const url = buildVideoDownloadUrl(base, token, name);
      await downloadMediaUrl(url, `${name}.mp4`);
    } catch (e) {
      setActionError(`下载失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleOpenDir = async (name: string) => {
    setActionError(null);
    if (!isTauri() || !workspacePath) {
      setActionError("当前环境不支持打开项目目录");
      return;
    }
    const dirPath = `${workspacePath}/video_projects/${name}`;
    try {
      await openPathWithSystemApp(dirPath);
    } catch (e) {
      setActionError(
        `无法打开项目目录：${e instanceof Error ? e.message : "目录不存在或已被移动"}`,
      );
    }
  };

  const metaLine = (p: VideoProject) =>
    `${VIDEO_PHASE_LABELS[p.phase] ?? p.phase} · ${formatResolution(p.resolution)}${p.language && p.language !== "zh-CN" ? ` · ${p.language}` : ""}${p.outputStale ? " · 内容已变化" : ""}`;

  if (collapsed) {
    if (loadError) {
      return (
        <TooltipProvider delayDuration={100}>
          <div className="flex flex-1 flex-col items-center justify-center py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
                  onClick={() => void loadProjects()}
                  aria-label="加载历史项目失败，点击重试"
                >
                  <AlertCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                加载失败：{loadError}，点击重试
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      );
    }

    return (
      <TooltipProvider delayDuration={100}>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          {projects.length === 0 && !loading && (
            <div className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground">
              <Clapperboard className="h-4 w-4 opacity-40" />
            </div>
          )}
          {projects.map((p) => {
            const isCurrent = p.name === currentProjectName;
            return (
              <ContextMenu key={p.name}>
                <ContextMenuTrigger asChild>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect(p)}
                        aria-label={`打开项目 ${p.name}，${VIDEO_PHASE_LABELS[p.phase] ?? p.phase}`}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                          isCurrent
                            ? "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-sidebar-foreground"
                            : "text-sidebar-foreground/70 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                        )}
                      >
                        <Clapperboard className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      <div className="max-w-[180px]">
                        <div className="truncate font-medium">{p.name}</div>
                        <div className="text-micro text-muted-foreground">
                          {metaLine(p)}
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-40">
                  {p.hasVideo && !p.archived && (
                    <ContextMenuItem
                      onClick={() => void handleDownload(p.name)}
                      className="text-caption"
                    >
                      <Download className="mr-2 h-3.5 w-3.5" />
                      下载 MP4
                    </ContextMenuItem>
                  )}
                  <ContextMenuItem
                    onClick={() => void handleOpenDir(p.name)}
                    className="text-caption"
                  >
                    <FolderOpen className="mr-2 h-3.5 w-3.5" />
                    打开任务目录
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => void handleArchive(p, true)}>
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    归档项目
                  </ContextMenuItem>
                  {!p.archived &&
                  p.styleUpdateAvailable &&
                  p.latestSeriesStyleVersion ? (
                    <ContextMenuItem
                      onClick={() => void handleStyleUpgrade(p)}
                      disabled={upgrading === p.name}
                      className="text-caption"
                    >
                      {upgrading === p.name ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                      )}
                      升级到风格 v{p.latestSeriesStyleVersion}
                    </ContextMenuItem>
                  ) : null}
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onClick={() => setPendingDelete(p.name)}
                    disabled={deleting === p.name}
                    className="text-caption text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {deleting === p.name ? "删除中..." : "删除项目"}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {loading && (
            <div className="flex h-8 w-8 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

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
                将删除项目「{pendingDelete}
                」及其全部分镜、预览和导出文件，删除后无法恢复。
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
      </TooltipProvider>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-micro">
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
      <div className="px-2 py-3 text-center text-micro text-muted-foreground">
        暂无历史项目
      </div>
    );
  }

  const visibleProjects = projects.filter((project) =>
    project.name
      .toLocaleLowerCase()
      .includes(searchQuery.trim().toLocaleLowerCase()),
  );
  const orderedProjects = [...visibleProjects].sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    const leftKey = left.seriesId
      ? `0:${left.seriesName ?? left.seriesId}`
      : "1:";
    const rightKey = right.seriesId
      ? `0:${right.seriesName ?? right.seriesId}`
      : "1:";
    return leftKey.localeCompare(rightKey) || right.createdAt - left.createdAt;
  });

  return (
    <div className="flex h-full flex-col overflow-y-auto scrollbar-hover">
      <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 p-2 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索视频"
            aria-label="搜索视频项目"
            className="h-8 pl-7 text-caption"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-7 w-full justify-start px-2 text-micro"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((current) => !current)}
        >
          <Archive className="mr-1.5 h-3.5 w-3.5" />
          {showArchived ? "隐藏已归档项目" : "查看已归档项目"}
        </Button>
      </div>
      {actionError && (
        <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-micro text-destructive">
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
      {orderedProjects.map((p, index) => {
        const groupKey = p.archived
          ? "archived"
          : p.seriesId
            ? `series:${p.seriesId}`
            : "single";
        const previous = orderedProjects[index - 1];
        const previousKey = previous?.archived
          ? "archived"
          : previous?.seriesId
            ? `series:${previous.seriesId}`
            : "single";
        const upgradeCandidates = p.seriesId
          ? orderedProjects.filter(
              (item) =>
                item.seriesId === p.seriesId && item.styleUpdateAvailable,
            )
          : [];
        return (
          <div key={p.name}>
            {index === 0 || groupKey !== previousKey ? (
              <div className="flex items-center justify-between px-2 pb-1 pt-2 text-micro font-medium text-muted-foreground">
                <span>
                  {p.archived
                    ? "已归档"
                    : p.seriesId
                      ? (p.seriesName ?? p.seriesId)
                      : "单条视频"}
                </span>
                <span className="flex items-center gap-1.5">
                  {p.seriesId && p.styleVersion ? (
                    <span>v{p.styleVersion}</span>
                  ) : null}
                  {p.seriesId &&
                  p.latestSeriesStyleVersion &&
                  upgradeCandidates.length ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-micro"
                      disabled={batchUpgrading === p.seriesId}
                      onClick={() =>
                        setPendingBatchUpgrade({
                          seriesId: p.seriesId!,
                          seriesName: p.seriesName ?? p.seriesId!,
                          styleVersion: p.latestSeriesStyleVersion!,
                          projectNames: upgradeCandidates.map(
                            (item) => item.name,
                          ),
                        })
                      }
                    >
                      {batchUpgrading === p.seriesId ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" />
                      )}
                      全部升级
                    </Button>
                  ) : null}
                </span>
              </div>
            ) : null}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sidebar-foreground/82 transition-colors",
                    "hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)] hover:text-sidebar-foreground",
                    p.name === currentProjectName
                      ? "bg-[hsl(var(--sidebar-active-surface)/0.07)] text-sidebar-foreground"
                      : "",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      if (!p.archived) onSelect(p);
                    }}
                    disabled={p.archived}
                    aria-current={
                      p.name === currentProjectName ? "true" : undefined
                    }
                    aria-label={`打开项目 ${p.name}，${VIDEO_PHASE_LABELS[p.phase] ?? p.phase}`}
                  >
                    <Clapperboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-caption">{p.name}</div>
                      <div className="flex items-center gap-1.5 text-micro text-muted-foreground">
                        <span>{VIDEO_PHASE_LABELS[p.phase] ?? p.phase}</span>
                        <span>·</span>
                        <span>{formatResolution(p.resolution)}</span>
                        <span>·</span>
                        <span>{formatRelativeTime(p.createdAt)}</span>
                        {p.outputStale ? (
                          <>
                            <span>·</span>
                            <span>内容已变化</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </button>
                  {p.hasVideo && !p.archived && (
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 hover:bg-[hsl(var(--sidebar-hover-surface)/0.04)]"
                      aria-label={`下载 ${p.name} 的 MP4`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDownload(p.name);
                      }}
                    >
                      <Download className="h-3 w-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-40">
                {p.hasVideo && !p.archived && (
                  <ContextMenuItem
                    onClick={() => void handleDownload(p.name)}
                    className="text-caption"
                  >
                    <Download className="mr-2 h-3.5 w-3.5" />
                    下载 MP4
                  </ContextMenuItem>
                )}
                {!p.archived ? (
                  <ContextMenuItem
                    onClick={() => void handleOpenDir(p.name)}
                    className="text-caption"
                  >
                    <FolderOpen className="mr-2 h-3.5 w-3.5" />
                    打开任务目录
                  </ContextMenuItem>
                ) : null}
                {p.archived ? (
                  <ContextMenuItem onClick={() => void handleArchive(p, false)}>
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    恢复项目
                  </ContextMenuItem>
                ) : (
                  <>
                    <ContextMenuItem
                      onClick={() => {
                        setProjectAction({ mode: "rename", project: p });
                        setProjectActionName(p.name);
                      }}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      重命名
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        setProjectAction({ mode: "copy", project: p });
                        setProjectActionName(`${p.name} 副本`);
                      }}
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      复制项目
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => void handleArchive(p, true)}
                    >
                      <Archive className="mr-2 h-3.5 w-3.5" />
                      归档项目
                    </ContextMenuItem>
                  </>
                )}
                {!p.archived &&
                p.styleUpdateAvailable &&
                p.latestSeriesStyleVersion ? (
                  <ContextMenuItem
                    onClick={() => void handleStyleUpgrade(p)}
                    disabled={upgrading === p.name}
                    className="text-caption"
                  >
                    {upgrading === p.name ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    )}
                    升级到风格 v{p.latestSeriesStyleVersion}
                  </ContextMenuItem>
                ) : null}
                {!p.archived ? (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onClick={() => setPendingDelete(p.name)}
                      disabled={deleting === p.name}
                      className="text-caption text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      {deleting === p.name ? "删除中..." : "删除项目"}
                    </ContextMenuItem>
                  </>
                ) : null}
              </ContextMenuContent>
            </ContextMenu>
            {deleteError?.name === p.name && (
              <div className="mx-2 mb-1 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-micro text-destructive">
                <AlertCircle className="h-3 w-3 shrink-0" />
                <span className="min-w-0 flex-1">
                  删除失败：{deleteError.message}
                </span>
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
        );
      })}
      {!loading && orderedProjects.length === 0 ? (
        <div className="px-3 py-6 text-center text-micro text-muted-foreground">
          没有匹配的视频项目
        </div>
      ) : null}
      {loading && (
        <div className="flex items-center justify-center gap-1.5 px-2 py-2 text-micro text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载中…
        </div>
      )}

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
              将删除项目「{pendingDelete}
              」及其全部分镜、预览和导出文件，删除后无法恢复。
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

      <AlertDialog
        open={pendingBatchUpgrade !== null}
        onOpenChange={(open) => {
          if (!open && !batchUpgrading) setPendingBatchUpgrade(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>升级系列历史视频？</AlertDialogTitle>
            <AlertDialogDescription>
              将把“{pendingBatchUpgrade?.seriesName}”中的
              {pendingBatchUpgrade?.projectNames.length ?? 0} 个旧视频升级到风格
              v{pendingBatchUpgrade?.styleVersion}
              。旧风格快照会保留，但这些视频需要重新制作场景并导出。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(batchUpgrading)}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(batchUpgrading)}
              onClick={(event) => {
                event.preventDefault();
                void handleBatchStyleUpgrade();
              }}
            >
              {batchUpgrading ? "升级中…" : "升级所选视频"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={projectAction !== null}
        onOpenChange={(open) => {
          if (!open && !projectActionLoading) setProjectAction(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {projectAction?.mode === "rename" ? "重命名视频" : "复制视频项目"}
            </DialogTitle>
            <DialogDescription>
              {projectAction?.mode === "rename"
                ? "只修改项目名称，不改变视频内容、系列绑定和历史版本。"
                : "复制脚本、分镜、风格和素材，不复制旧成片与导出缓存。"}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={projectActionName}
            onChange={(event) => setProjectActionName(event.target.value)}
            aria-label="项目名称"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setProjectAction(null)}
              disabled={projectActionLoading}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleProjectAction()}
              disabled={!projectActionName.trim() || projectActionLoading}
            >
              {projectActionLoading
                ? "处理中…"
                : projectAction?.mode === "rename"
                  ? "保存名称"
                  : "创建副本"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
