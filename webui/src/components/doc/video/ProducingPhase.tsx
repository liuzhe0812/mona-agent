import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle,
  Clapperboard,
  Code2,
  Download,
  Eye,
  Film,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Volume2,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  ApiError,
  buildVideoDownloadUrl,
  buildVideoPreviewFullUrl,
  confirmVideoScene,
  downloadVideoRuntime,
  exportVideoProject,
  fetchSceneNarrationBytes,
  fetchScenePreviewHtml,
  fetchVideoExportStatus,
  fetchVideoProject,
  fetchVideoRuntimeCheck,
  fetchVideoStoryboard,
  generateSceneHtml,
  getApiBase,
  getServicesHttpBase,
  regenerateVideoScene,
  rewriteVideoScene,
  type VideoExportStatus,
  type VideoProjectPhase,
  type VideoRuntimeStatus,
  type VideoSceneWithHtml,
} from "@/lib/api";
import { downloadMediaUrl, revealItemInDir } from "@/lib/tauri";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { VideoRuntimeDialog, type RuntimeDepKey } from "./VideoRuntimeDialog";

interface ProducingPhaseProps {
  projectName: string;
  /** 项目阶段变化时通知父组件（驱动外层步骤条与历史列表刷新）。 */
  onPhaseChange?: (phase: VideoProjectPhase) => void;
}

type ExportQuality = "draft" | "standard" | "high";

const EXPORT_QUALITY_OPTIONS: Array<{
  value: ExportQuality;
  label: string;
  hint: string;
}> = [
  { value: "draft", label: "Draft", hint: "24fps · 半分辨率，快速预览" },
  { value: "standard", label: "Standard", hint: "30fps · 原分辨率" },
  { value: "high", label: "High", hint: "60fps · 原分辨率" },
];

const DEFAULT_RUNTIME_STATUS: VideoRuntimeStatus = {
  node: { ok: false },
  ffmpeg: { ok: false },
  chrome: { ok: false },
};

/** Parse a resolution string like "1080x1920" or legacy "1920x1080@30fps". */
function parseResolution(raw: string | undefined): { w: number; h: number } {
  const m = /(\d+)\s*x\s*(\d+)/.exec(raw ?? "");
  if (m) {
    const w = Number.parseInt(m[1], 10);
    const h = Number.parseInt(m[2], 10);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: 1920, h: 1080 };
}

/** Measure a container and compute the largest box with the given aspect
 * ratio that fits inside it (with padding). Recomputes on resize. */
function useFitSize(
  ref: RefObject<HTMLElement | null>,
  ratioW: number,
  ratioH: number,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      const availW = rect.width - 32;
      const availH = rect.height - 32;
      if (availW <= 0 || availH <= 0) return;
      const scale = Math.min(availW / ratioW, availH / ratioH);
      setSize({
        width: Math.max(Math.floor(ratioW * scale), 1),
        height: Math.max(Math.floor(ratioH * scale), 1),
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, ratioW, ratioH]);
  return size;
}

/** Aspect-correct scene preview frame. The server-side preview HTML already
 * self-scales to whatever box the iframe provides; we just size the box. */
function ScenePreviewFrame({
  html,
  ratioW,
  ratioH,
  title,
}: {
  html: string;
  ratioW: number;
  ratioH: number;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useFitSize(containerRef, ratioW, ratioH);
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
    >
      {size ? (
        <iframe
          title={title}
          srcDoc={html}
          className="border-0 shadow-sm"
          sandbox="allow-scripts"
          style={{ width: size.width, height: size.height }}
        />
      ) : null}
    </div>
  );
}

export function ProducingPhase({ projectName, onPhaseChange }: ProducingPhaseProps) {
  const { token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [scenes, setScenes] = useState<VideoSceneWithHtml[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionLabel, setActionLabel] = useState<string | null>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [showHtml, setShowHtml] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteText, setRewriteText] = useState("");
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullFilmOpen, setFullFilmOpen] = useState(false);

  const [fullPreviewUrl, setFullPreviewUrl] = useState<string | null>(null);

  // Project-level metadata: resolution drives preview aspect ratio,
  // outputStale drives the "内容已变化" export state.
  const [ratio, setRatio] = useState<{ w: number; h: number }>({
    w: 1920,
    h: 1080,
  });
  const [outputStale, setOutputStale] = useState(false);

  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState<VideoExportStatus>({
    stage: "idle",
    progress: 0,
  });
  const [exportActionLoading, setExportActionLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(
    null,
  );
  const exportPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Runtime dependency gate (checked lazily right before export)
  const [runtimeStatus, setRuntimeStatus] = useState<VideoRuntimeStatus>(
    DEFAULT_RUNTIME_STATUS,
  );
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [installing, setInstalling] = useState<RuntimeDepKey | null>(null);
  const [installErrors, setInstallErrors] = useState<
    Partial<Record<RuntimeDepKey, string>>
  >({});

  const refreshProjectMeta = useCallback(async () => {
    try {
      const p = await fetchVideoProject(token, projectName);
      setRatio(parseResolution(p.resolution));
      setOutputStale(Boolean(p.outputStale));
      if (p.phase) onPhaseChange?.(p.phase);
    } catch {
      // keep defaults — project detail is best-effort here
    }
  }, [token, projectName, onPhaseChange]);

  useEffect(() => {
    void refreshProjectMeta();
  }, [refreshProjectMeta]);

  const loadScenes = useCallback(async () => {
    try {
      const res = await fetchVideoStoryboard(token, projectName);
      if (res.ok && res.scenes) {
        setScenes(res.scenes as VideoSceneWithHtml[]);
        if (
          res.scenes.length > 0 &&
          !res.scenes.some((s) => s.index === selectedIndex)
        ) {
          setSelectedIndex(res.scenes[0].index);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [token, projectName, selectedIndex]);

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectName]);

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  useEffect(() => {
    setShowHtml(false);
    setError(null);
  }, [selectedIndex]);

  const loadPreview = useCallback(async () => {
    if (!selectedScene) {
      setPreviewHtml(null);
      return;
    }
    const status = selectedScene.htmlStatus ?? "pending";
    if (status === "pending") {
      setPreviewHtml(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const { html, needsGeneration } = await fetchScenePreviewHtml(
        token,
        projectName,
        selectedIndex,
      );
      if (needsGeneration) {
        setPreviewHtml(null);
      } else {
        setPreviewHtml(html);
      }
    } catch (e) {
      console.error("Failed to load preview", e);
      setPreviewHtml(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedScene, token, projectName, selectedIndex]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview, selectedIndex]);

  // Build full-preview URL on mount / project change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await getServicesHttpBase();
      if (cancelled) return;
      setFullPreviewUrl(buildVideoPreviewFullUrl(base, token, projectName));
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  const refreshFullPreview = useCallback(async () => {
    const base = await getServicesHttpBase();
    setFullPreviewUrl(
      buildVideoPreviewFullUrl(base, token, projectName) + `&_t=${Date.now()}`,
    );
  }, [token, projectName]);

  // 打开整片预览弹窗时刷新 URL,确保看到最新场景内容
  const openFullFilm = useCallback(async () => {
    const base = await getServicesHttpBase();
    setFullPreviewUrl(
      buildVideoPreviewFullUrl(base, token, projectName) + `&_t=${Date.now()}`,
    );
    setFullFilmOpen(true);
  }, [token, projectName]);

  // Initial export status + download URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchVideoExportStatus(token, projectName);
        if (cancelled) return;
        setExportStatus(s);
        if (s.hasVideo) {
          const base = await getApiBase();
          if (cancelled) return;
          setExportDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  // Poll while rendering
  useEffect(() => {
    if (exportStatus.stage !== "rendering") {
      if (exportPollRef.current) {
        clearTimeout(exportPollRef.current);
        exportPollRef.current = null;
      }
      return;
    }
    onPhaseChange?.("rendering");
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await fetchVideoExportStatus(token, projectName);
        if (cancelled) return;
        setExportStatus(s);
        if (s.stage === "done" && s.hasVideo) {
          const base = await getApiBase();
          if (cancelled) return;
          setExportDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
          setOutputStale(false);
          void refreshProjectMeta();
          return;
        }
        if (s.stage === "error") {
          setExportError(s.message ?? "渲染失败");
          return;
        }
      } catch {
        // ignore transient errors
      }
      if (!cancelled) {
        exportPollRef.current = setTimeout(poll, 2000);
      }
    };
    exportPollRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (exportPollRef.current) {
        clearTimeout(exportPollRef.current);
        exportPollRef.current = null;
      }
    };
  }, [exportStatus.stage, token, projectName, refreshProjectMeta, onPhaseChange]);

  const updateSceneStatus = useCallback((index: number, status: string) => {
    setScenes((prev) =>
      prev.map((s) =>
        s.index === index ? { ...s, htmlStatus: status as never } : s,
      ),
    );
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setActionLabel("正在生成本场景 HTML...");
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await generateSceneHtml(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
        await refreshFullPreview();
        void refreshProjectMeta();
      } else {
        setError(res.error || "生成失败");
        updateSceneStatus(selectedIndex, "pending");
      }
    } catch (e) {
      setError(String(e));
      updateSceneStatus(selectedIndex, "pending");
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    selectedScene,
    actionLoading,
    token,
    projectName,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleGenerateAll = useCallback(async () => {
    if (actionLoading) return;
    const pending = scenes.filter(
      (s) => (s.htmlStatus ?? "pending") === "pending",
    );
    if (pending.length === 0) return;
    setActionLoading(true);
    setError(null);
    try {
      for (const scene of pending) {
        setActionLabel(`正在生成场景 ${scene.index}/${scenes.length} HTML...`);
        updateSceneStatus(scene.index, "generating");
        const res = await generateSceneHtml(token, projectName, scene.index);
        if (res.ok && res.scene) {
          setScenes((prev) =>
            prev.map((s) => (s.index === scene.index ? res.scene! : s)),
          );
        } else {
          setError(res.error || `场景 ${scene.index} 生成失败`);
          updateSceneStatus(scene.index, "pending");
          break;
        }
      }
      // Refresh current scene preview and full preview
      if (selectedScene) {
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
      }
      await refreshFullPreview();
      void refreshProjectMeta();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    actionLoading,
    scenes,
    token,
    projectName,
    selectedScene,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setActionLabel("正在重新生成场景...");
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await regenerateVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
        await refreshFullPreview();
        // 重生成使旧确认与旧导出结果失效
        void refreshProjectMeta();
      } else {
        setError(res.error || "重新生成失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    selectedScene,
    actionLoading,
    token,
    projectName,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleConfirm = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    if ((selectedScene.htmlStatus ?? "pending") !== "previewing") return;
    setActionLoading(true);
    setActionLabel("正在确认场景...");
    setError(null);
    try {
      const res = await confirmVideoScene(
        token,
        projectName,
        selectedIndex,
        selectedScene.htmlMtime,
      );
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) =>
            s.index === selectedIndex
              ? (res.scene as VideoSceneWithHtml)
              : s,
          ),
        );
      } else {
        setError(res.error || "确认失败");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Version changed or not previewable — refresh so the user confirms
        // against the current HTML version.
        setError("场景内容已变化，已刷新为最新版本，请重新确认。");
        await loadScenes();
      } else {
        setError(String(e));
      }
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    selectedScene,
    actionLoading,
    token,
    projectName,
    selectedIndex,
    loadScenes,
  ]);

  const handlePlayNarration = useCallback(async () => {
    if (!selectedScene || playingIndex !== null) return;
    setPlayingIndex(selectedIndex);
    try {
      const blob = await fetchSceneNarrationBytes(token, projectName, selectedIndex);
      if (blob) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setPlayingIndex(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setPlayingIndex(null);
        };
        await audio.play();
      } else {
        setPlayingIndex(null);
      }
    } catch (e) {
      console.error("Narration playback failed", e);
      setPlayingIndex(null);
    }
  }, [selectedScene, playingIndex, token, projectName, selectedIndex]);

  const handleRewriteSubmit = useCallback(async () => {
    if (!rewriteText.trim() || rewriteLoading) return;
    setRewriteLoading(true);
    setError(null);
    try {
      const res = await rewriteVideoScene(
        token,
        projectName,
        selectedIndex,
        rewriteText.trim(),
      );
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        setRewriteOpen(false);
        setRewriteText("");
        await refreshFullPreview();
        // 重写分镜使旧确认与旧导出结果失效
        void refreshProjectMeta();
      } else {
        setError(res.error || "重写失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRewriteLoading(false);
    }
  }, [
    rewriteText,
    rewriteLoading,
    token,
    projectName,
    selectedIndex,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const doExport = useCallback(async () => {
    const res = await exportVideoProject(token, projectName, {
      quality: exportQuality,
    });
    if (!res.ok) {
      setExportError(res.error ?? "导出失败");
      return;
    }
    setExportDialogOpen(false);
    setExportStatus({ stage: "rendering", progress: 0, message: "准备渲染..." });
  }, [token, projectName, exportQuality]);

  // Export entry from the confirmation dialog: gate on runtime deps first.
  const handleExportSubmit = useCallback(async () => {
    setExportError(null);
    setExportActionLoading(true);
    try {
      let runtimeOk = true;
      try {
        const status = await fetchVideoRuntimeCheck(token);
        setRuntimeStatus(status);
        runtimeOk = status.node.ok && status.ffmpeg.ok && status.chrome.ok;
      } catch {
        // Check failed — let the export attempt proceed; the server reports
        // need_download if the runtime is actually missing.
      }
      if (!runtimeOk) {
        // 保留质量选择,关闭导出弹窗并打开运行时安装;装完自动回到导出确认
        setExportDialogOpen(false);
        setRuntimeDialogOpen(true);
        return;
      }
      await doExport();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setExportError("所有场景确认后才能导出，请检查场景状态。");
      } else {
        setExportError(String(e));
      }
    } finally {
      setExportActionLoading(false);
    }
  }, [token, doExport]);

  const handleInstallRuntime = useCallback(
    async (component?: RuntimeDepKey) => {
      const targets: RuntimeDepKey[] = component
        ? [component]
        : (["node", "ffmpeg", "chrome"] as RuntimeDepKey[]).filter(
            (k) => !runtimeStatus[k].ok,
          );
      if (targets.length === 0) return;
      for (const dep of targets) {
        setInstalling(dep);
        setInstallErrors((prev) => {
          const next = { ...prev };
          delete next[dep];
          return next;
        });
        try {
          const res = await downloadVideoRuntime(token, dep);
          if (!res.ok) {
            setInstallErrors((prev) => ({
              ...prev,
              [dep]: res.error || "安装失败",
            }));
          }
        } catch (e) {
          setInstallErrors((prev) => ({ ...prev, [dep]: String(e) }));
        }
      }
      setInstalling(null);
      try {
        const status = await fetchVideoRuntimeCheck(token);
        setRuntimeStatus(status);
      } catch {
        // ignore
      }
    },
    [runtimeStatus, token],
  );

  // Runtime dialog closed: if everything is now installed, return to the
  // export confirmation dialog with the quality selection preserved.
  const handleRuntimeDialogClose = useCallback(async () => {
    setRuntimeDialogOpen(false);
    try {
      const status = await fetchVideoRuntimeCheck(token);
      setRuntimeStatus(status);
      if (status.node.ok && status.ffmpeg.ok && status.chrome.ok) {
        setExportDialogOpen(true);
      }
    } catch {
      // stay closed — user can reopen the export dialog manually
    }
  }, [token]);

  const [downloadLoading, setDownloadLoading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!exportDownloadUrl) return;
    setDownloadLoading(true);
    try {
      await downloadMediaUrl(exportDownloadUrl, `${projectName}.mp4`);
    } catch (e) {
      setExportError(`下载失败: ${e}`);
    } finally {
      setDownloadLoading(false);
    }
  }, [exportDownloadUrl, projectName]);

  const handleOpenOldOutputDir = useCallback(async () => {
    if (!workspacePath) return;
    try {
      await revealItemInDir(
        `${workspacePath}/video_projects/${projectName}/renders/output.mp4`,
      );
    } catch (e) {
      setExportError(`打开目录失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [workspacePath, projectName]);

  // 场景列表键盘导航:上下方向键切换选中场景
  const handleSceneListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const order = scenes.map((s) => s.index);
      const pos = order.indexOf(selectedIndex);
      const next =
        e.key === "ArrowDown" ? order[pos + 1] : order[pos - 1];
      if (next === undefined) return;
      setSelectedIndex(next);
      requestAnimationFrame(() => {
        document.getElementById(`video-scene-item-${next}`)?.focus();
      });
    },
    [scenes, selectedIndex],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载场景...
      </div>
    );
  }

  // A scene counts as confirmed only when the confirmation is bound to the
  // current HTML version (same rule the server enforces).
  const isSceneConfirmedCurrent = (s: VideoSceneWithHtml) =>
    s.htmlStatus === "confirmed" &&
    s.htmlMtime != null &&
    s.confirmedMtime != null &&
    s.htmlMtime === s.confirmedMtime;
  const confirmedCount = scenes.filter(isSceneConfirmedCurrent).length;
  const allConfirmed = scenes.length > 0 && confirmedCount === scenes.length;
  const isRendering = exportStatus.stage === "rendering";
  const isExportDone = exportStatus.stage === "done" && exportStatus.hasVideo;
  const hasExportError = exportStatus.stage === "error";
  const selectedStatus = selectedScene?.htmlStatus ?? "pending";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* 左:场景状态列表 */}
        <ResizablePanel
          defaultSize={22}
          minSize={18}
          maxSize={32}
          collapsible
          className="flex flex-col"
        >
          <div className="flex h-full min-h-0 flex-col border-r border-border/70">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
              <span className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">
                场景制作 · {confirmedCount}/{scenes.length} 已确认
              </span>
              {scenes.some(
                (s) => (s.htmlStatus ?? "pending") === "pending",
              ) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px] text-primary"
                  onClick={handleGenerateAll}
                  disabled={actionLoading}
                >
                  <Wand2 className="mr-1 h-3 w-3" />
                  一键生成全部
                </Button>
              )}
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2"
              role="listbox"
              aria-label="场景列表"
              aria-activedescendant={`video-scene-item-${selectedIndex}`}
              tabIndex={0}
              onKeyDown={handleSceneListKeyDown}
            >
              {scenes.map((s) => {
                const status = s.htmlStatus ?? "pending";
                const selected = s.index === selectedIndex;
                return (
                  <button
                    key={s.index}
                    id={`video-scene-item-${s.index}`}
                    role="option"
                    aria-selected={selected}
                    aria-label={`场景 ${s.index} ${s.title || ""}，${statusLabel(status)}`}
                    onClick={() => {
                      setSelectedIndex(s.index);
                    }}
                    className={cn(
                      "mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-primary bg-accent"
                        : "border-border/60 hover:bg-accent",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0" aria-hidden="true">
                        {status === "confirmed" ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : status === "generating" ? (
                          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                        ) : status === "previewing" ? (
                          <span className="text-[11px] text-sky-500">●</span>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            ○
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[12px] font-medium">
                        {s.title || `场景 ${s.index}`}
                      </span>
                    </div>
                    <div className="mt-0.5 pl-4 text-[11px] text-muted-foreground">
                      {s.duration}s · {statusLabel(status)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* 中:预览区 */}
        <ResizablePanel defaultSize={50} minSize={30} className="flex flex-col">
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/70 px-4 py-2">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium">
                  {selectedScene && (
                    <>
                      场景 {selectedScene.index}: {selectedScene.title || ""}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {selectedScene.duration}s ·{" "}
                        {statusLabel(selectedScene.htmlStatus ?? "pending")}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <TooltipProvider delayDuration={300}>
                    {previewHtml && !showHtml && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label="全屏预览当前场景"
                            onClick={() => setFullscreen(true)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>全屏预览当前场景</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn("h-7 w-7 p-0", showHtml && "bg-accent")}
                          aria-label={showHtml ? "切换预览" : "查看 HTML"}
                          aria-pressed={showHtml}
                          onClick={() => setShowHtml((v) => !v)}
                        >
                          <Code2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {showHtml ? "切换预览" : "查看 HTML"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          aria-label={
                            isExportDone
                              ? "播放整片视频"
                              : "整片预览(未渲染,播放HTML预览)"
                          }
                          onClick={openFullFilm}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isExportDone
                          ? "播放整片视频"
                          : "整片预览(未渲染,播放HTML预览)"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载预览...
                </div>
              ) : showHtml ? (
                <pre className="h-full overflow-auto scrollbar-hover p-3 text-[11px] font-mono">
                  <code>{previewHtml || "(无 HTML)"}</code>
                </pre>
              ) : previewHtml ? (
                <ScenePreviewFrame
                  html={previewHtml}
                  ratioW={ratio.w}
                  ratioH={ratio.h}
                  title={`scene-${selectedIndex}-preview`}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
                  <div>该场景尚未生成 HTML</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={actionLoading}
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    生成本场景 HTML
                  </Button>
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* 右:操作面板 */}
        <ResizablePanel
          defaultSize={28}
          minSize={22}
          maxSize={38}
          className="flex flex-col"
        >
          <div className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-3">
              {/* 场景操作 */}
              <div className="mb-5">
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                  <Clapperboard className="h-3.5 w-3.5" />
                  场景操作
                </div>
                {error && (
                  <div
                    className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                {actionLoading && actionLabel && (
                  <div
                    className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>{actionLabel}</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Button
                    size="sm"
                    className="w-full text-[12px]"
                    onClick={handleGenerate}
                    disabled={
                      actionLoading ||
                      !selectedScene ||
                      selectedStatus !== "pending"
                    }
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    生成本场景 HTML
                  </Button>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[12px]"
                      onClick={handleRegenerate}
                      disabled={
                        actionLoading ||
                        !selectedScene ||
                        selectedStatus === "pending" ||
                        selectedStatus === "generating"
                      }
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新生成
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[12px]"
                      onClick={() => setRewriteOpen(true)}
                      disabled={!selectedScene}
                    >
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      重写分镜
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[12px]"
                      onClick={handlePlayNarration}
                      disabled={playingIndex !== null || !selectedScene?.narration}
                    >
                      {playingIndex === selectedIndex ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      试听旁白
                    </Button>
                    <Button
                      size="sm"
                      className="text-[12px]"
                      onClick={handleConfirm}
                      disabled={
                        actionLoading ||
                        !selectedScene ||
                        selectedStatus !== "previewing"
                      }
                    >
                      {actionLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      确认通过
                    </Button>
                  </div>
                </div>
              </div>

              {/* 全局导出 */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                  <Film className="h-3.5 w-3.5" />
                  导出 MP4
                </div>

                {/* 渲染中:不确定进度动画 + 阶段文字 */}
                {isRendering && (
                  <div
                    className="mb-3 rounded-md border border-border/70 bg-muted/30 p-3"
                    role="status"
                  >
                    <div className="flex items-center gap-2 text-[12px] font-medium">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      正在导出
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-full animate-pulse rounded-full bg-primary/60" />
                    </div>
                    <div className="mt-1.5 text-[11px] text-muted-foreground">
                      {exportStatus.message ?? "处理中..."}
                    </div>
                  </div>
                )}

                {/* 错误:保留页面状态,可重试 */}
                {hasExportError && (
                  <div
                    className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                    role="alert"
                  >
                    <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
                      <AlertCircle className="h-3.5 w-3.5" />
                      渲染失败
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {exportError ?? exportStatus.message}
                    </div>
                    {exportStatus.needDownload && (
                      <div className="mt-2 text-[11px] text-muted-foreground">
                        运行环境缺失，
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setRuntimeDialogOpen(true)}
                        >
                          点击安装视频运行环境
                        </button>
                        后重试
                      </div>
                    )}
                  </div>
                )}

                {/* 完成:区分输出是否过期 */}
                {isExportDone && outputStale && (
                  <div
                    className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
                    role="alert"
                  >
                    <div className="flex items-center gap-2 text-[12px] font-medium text-amber-700">
                      <AlertCircle className="h-3.5 w-3.5" />
                      内容已变化
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      分镜或场景已修改，之前的 MP4 与当前内容不一致，需要重新导出。
                    </div>
                  </div>
                )}
                {isExportDone && !outputStale && (
                  <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/5 p-3">
                    <div className="flex items-center gap-2 text-[12px] font-medium text-green-700">
                      <CheckCircle className="h-3.5 w-3.5" />
                      渲染完成
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {exportStatus.duration !== undefined && (
                        <>
                          <span>时长</span>
                          <span className="text-foreground">
                            {exportStatus.duration}s
                          </span>
                        </>
                      )}
                      {exportStatus.fps !== undefined && (
                        <>
                          <span>帧率</span>
                          <span className="text-foreground">
                            {exportStatus.fps}fps
                          </span>
                        </>
                      )}
                      {exportStatus.totalFrames !== undefined && (
                        <>
                          <span>总帧数</span>
                          <span className="text-foreground">
                            {exportStatus.totalFrames}
                          </span>
                        </>
                      )}
                      {exportStatus.resolution && (
                        <>
                          <span>分辨率</span>
                          <span className="text-foreground">
                            {exportStatus.resolution[0]}×
                            {exportStatus.resolution[1]}
                          </span>
                        </>
                      )}
                      <span>音轨</span>
                      <span className="text-foreground">
                        {exportStatus.audio ? "已合成旁白" : "无"}
                      </span>
                    </div>
                  </div>
                )}

                {exportError && !hasExportError && (
                  <div
                    className="mb-3 text-[11px] text-destructive"
                    role="alert"
                  >
                    {exportError}
                  </div>
                )}

                {/* 导出操作按钮 */}
                {!isExportDone ? (
                  <>
                    <Button
                      className="w-full text-[12px]"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={
                        isRendering || exportActionLoading || !allConfirmed
                      }
                    >
                      {isRendering || exportActionLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : hasExportError ? (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Film className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {hasExportError
                        ? "重试导出"
                        : isRendering
                          ? "渲染中..."
                          : "导出 MP4"}
                    </Button>
                    {!allConfirmed && !isRendering && (
                      <div className="mt-1.5 text-[11px] text-muted-foreground">
                        确认全部场景后可导出（{confirmedCount}/{scenes.length}）
                      </div>
                    )}
                  </>
                ) : outputStale ? (
                  <div className="space-y-1.5">
                    <Button
                      className="w-full text-[12px]"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={isRendering || exportActionLoading}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新导出
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full text-[12px]"
                      onClick={handleOpenOldOutputDir}
                      disabled={!workspacePath}
                    >
                      <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                      打开旧文件所在目录
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Button
                      className="w-full text-[12px]"
                      onClick={handleDownload}
                      disabled={downloadLoading}
                    >
                      {downloadLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {downloadLoading ? "下载中..." : "下载 MP4"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full text-[12px]"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={isRendering || exportActionLoading}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新导出
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* 底部全局进度提示 */}
            {allConfirmed && !isExportDone && !isRendering && (
              <div className="shrink-0 border-t border-border/70 p-3 text-[11px] text-muted-foreground">
                全部场景已确认，可以导出 MP4
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* 重写分镜对话框 */}
      <Dialog open={rewriteOpen} onOpenChange={setRewriteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重写场景 {selectedIndex} 分镜</DialogTitle>
            <DialogDescription>
              描述你希望这个场景如何调整，AI 会重写该场景的分镜内容（标题/画面/动画/旁白），其他场景不受影响。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rewriteText}
            onChange={(e) => setRewriteText(e.target.value)}
            className="min-h-[100px] resize-none text-[12px]"
            placeholder="例如：把开场改成产品 logo 从中心放大的动效，旁白改成'欢迎体验...'"
            aria-label="重写需求"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRewriteOpen(false)}
              disabled={rewriteLoading}
            >
              取消
            </Button>
            <Button
              onClick={handleRewriteSubmit}
              disabled={!rewriteText.trim() || rewriteLoading}
            >
              {rewriteLoading && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              提交重写
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导出确认对话框:质量选择 + 运行时门禁 */}
      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          if (!exportActionLoading) setExportDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>导出 MP4</DialogTitle>
            <DialogDescription>
              选择导出质量。帧率与分辨率由质量档位决定，导出前会检查运行环境。
            </DialogDescription>
          </DialogHeader>
          <div
            role="radiogroup"
            aria-label="导出质量"
            className="space-y-1.5"
          >
            {EXPORT_QUALITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={exportQuality === opt.value}
                disabled={exportActionLoading}
                onClick={() => setExportQuality(opt.value)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                  exportQuality === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:bg-accent",
                )}
              >
                <span className="text-[13px] font-medium">{opt.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  {opt.hint}
                </span>
              </button>
            ))}
          </div>
          {exportError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive"
              role="alert"
            >
              {exportError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setExportDialogOpen(false)}
              disabled={exportActionLoading}
            >
              取消
            </Button>
            <Button onClick={handleExportSubmit} disabled={exportActionLoading}>
              {exportActionLoading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Film className="mr-1.5 h-3.5 w-3.5" />
              )}
              开始导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 运行时依赖安装弹窗 */}
      <VideoRuntimeDialog
        open={runtimeDialogOpen}
        onClose={() => void handleRuntimeDialogClose()}
        runtimeStatus={runtimeStatus}
        installing={installing}
        installErrors={installErrors}
        onInstall={(component) => void handleInstallRuntime(component)}
      />

      {/* 全屏预览:当前场景 */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="h-[90vh] max-w-[95vw] gap-0 p-0">
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-[13px] font-medium">
                场景 {selectedScene?.index} 全屏预览
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setFullscreen(false)}
              >
                关闭
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-muted/30">
              {previewHtml && (
                <ScenePreviewFrame
                  html={previewHtml}
                  ratioW={ratio.w}
                  ratioH={ratio.h}
                  title="scene-fullscreen-preview"
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 整片预览:弹窗播放全片 */}
      <Dialog open={fullFilmOpen} onOpenChange={setFullFilmOpen}>
        <DialogContent className="h-[90vh] max-w-[95vw] gap-0 p-0">
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-[13px] font-medium">
                {projectName} · 整片预览
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setFullFilmOpen(false)}
              >
                关闭
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-black">
              {isExportDone && !outputStale && exportDownloadUrl ? (
                <video
                  src={exportDownloadUrl}
                  className="h-full w-full"
                  controls
                  autoPlay
                />
              ) : fullPreviewUrl ? (
                <iframe
                  src={fullPreviewUrl}
                  title={`${projectName} 整片预览`}
                  className="h-full w-full border-0 bg-background"
                  sandbox="allow-scripts allow-same-origin"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载整片预览...
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "已确认";
    case "generating":
      return "生成中";
    case "previewing":
      return "已预览";
    default:
      return "待制作";
  }
}
